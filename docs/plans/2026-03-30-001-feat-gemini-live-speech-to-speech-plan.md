---
title: "feat: Gemini Flash Live Speech-to-Speech Integration"
type: feat
status: active
date: 2026-03-30
origin: docs/brainstorms/2026-03-30-gemini-live-speech-to-speech-requirements.md
---

# feat: Gemini Flash Live Speech-to-Speech Integration

## Overview

Replace the current STT → text-chat → TTS pipeline for a single test character (Einstein) with Gemini Flash Live — a native audio-to-audio model that collapses all three steps into one WebSocket stream. Target latency drops from ~1.5–3s to ~200–500ms. All other characters keep the existing Smallest AI pipeline untouched.

**Architecture correction vs. requirements doc (R2):** The requirements doc assumed a Vercel Edge Function could hold a persistent WebSocket proxy to Gemini. Research confirms Vercel cannot act as a WebSocket server at all (Edge or Serverless). The correct pattern — and Google's documented approach for browser apps — is a **direct browser → Gemini WebSocket using a short-lived ephemeral token** issued by a Vercel serverless route. The API key stays server-side; only the short-lived token crosses to the browser. This satisfies the spirit of R2 (see origin: [docs/brainstorms/2026-03-30-gemini-live-speech-to-speech-requirements.md](docs/brainstorms/2026-03-30-gemini-live-speech-to-speech-requirements.md)).

---

## Problem Statement / Motivation

Current pipeline dead-air breakdown:

```
Mic stop → POST /api/character/stt   (~400–600ms)
         → POST /api/character/chat  (~400–700ms)
         → fetch /api/character/tts  (~400–600ms, first byte)
         → AudioContext first sound
Total:   ~1.2–1.9s (fast) to ~3s+ (slow network)
```

Gemini 3.1 Flash Live is a single WebSocket session that accepts mic audio in real time and begins streaming audio back with a first-byte latency under 500ms. The model does VAD, transcription, reasoning, and synthesis internally.

Odyssey (avatar video) receives text prompts independently and is unaffected — it continues running in parallel.

---

## Proposed Solution

### Revised Architecture (browser-direct WebSocket)

```
┌─────────────────────────────────────────────────────────┐
│ Browser                                                 │
│                                                         │
│  Mic → AudioWorklet (Float32→Int16 16kHz) ──────────┐   │
│                                                     │   │
│  AudioContext (24kHz) ← PCM chunks ─────────────────┼─┐ │
│                                                     │ │ │
│  Odyssey interact() ← action heuristic ← transcript │ │ │
└─────────────────────────────────────────────────────┼─┼─┘
                   WebSocket (ephemeral token)         │ │
                         │                            │ │
┌────────────────────────▼──────────────────────────────┐ │
│ Vercel /api/gemini-live-token                         │ │
│  POST → Gemini Token API → returns short-lived token  │ │
└───────────────────────────────────────────────────────┘ │
                                                          │
┌─────────────────────────────────────────────────────────▼─┐
│ Gemini Live API (wss://generativelanguage.googleapis.com/) │
│  Model: gemini-3.1-flash-live-preview                      │
│  Input:  PCM 16-bit, 16kHz, mono                          │
│  Output: PCM 16-bit, 24kHz, mono  +  transcript           │
│  VAD: automatic (server-side)                             │
└────────────────────────────────────────────────────────────┘
```

### Session lifecycle

1. User taps record on Einstein slide
2. Browser POSTs to `/api/gemini-live-token` → receives ephemeral token (TTL: ~60s)
3. Browser opens WebSocket to Gemini Live with token
4. Sends `setup` message with Einstein's system prompt + `outputAudioTranscription`
5. Waits for `setupComplete` from server
6. Starts mic via `AudioWorkletNode` at 16kHz → sends PCM chunks over WebSocket
7. Server VAD detects speech end → model responds
8. Gemini sends PCM audio chunks → fed into existing `AudioContext` scheduling queue
9. Gemini sends transcript chunks → action heuristic → `handleInteractRef.current(action)`
10. On barge-in (`serverContent.interrupted: true`) → flush audio queue + `interact("stand idle")`
11. Session closes on: back navigation, `generationComplete` + user action, or error

---

## Technical Approach

### Phase 1 — Ephemeral Token Endpoint

**File:** `server/index.js`

Add a new Express route `/api/gemini-live-token` that calls the Gemini ephemeral token endpoint:

```js
// server/index.js — add after existing routes
app.post('/api/gemini-live-token', generalLimiter, async (req, res) => {
  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/ephemeralApiKeys',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': runtimeConfig.geminiApiKey,
        },
        body: JSON.stringify({ model: 'models/gemini-3.1-flash-live-preview' }),
      }
    );
    if (!response.ok) throw new Error(`Token API ${response.status}`);
    const data = await response.json();
    res.json({ token: data.ephemeralKey });
  } catch (err) {
    console.error('[gemini-live-token] error', err);
    res.status(500).json({ error: 'Failed to issue token' });
  }
});
```

Also add to `vercel.json` `functions` block if needed (inherits from `api/server`; no change needed given current `rewrites` catch-all).

**Acceptance:** `POST /api/gemini-live-token` returns `{ token: "..." }` with a short-lived string.

---

### Phase 2 — AudioWorklet PCM Processor

**File (new):** `public/audio-processor.worklet.js`

Runs off the main thread. Receives 128-sample Float32 buffers from the mic, converts to Int16 PCM, transfers (zero-copy) to the main thread.

```js
// public/audio-processor.worklet.js
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    const int16 = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(int16.buffer, [int16.buffer]);
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
```

**Why AudioWorklet and not ScriptProcessorNode:** `ScriptProcessorNode` is deprecated and runs on the main thread. At 16kHz streaming under active UI, it causes glitches. `AudioWorkletNode` runs on the audio rendering thread (off-main-thread), which is required for reliable streaming at these latencies.

**iOS note:** Do NOT reuse `ttsAudioCtxRef` for mic capture. After TTS has played on iOS, `ttsAudioCtxRef` is in "playback" session category; connecting `createMediaStreamSource` to it produces a silent analyser. Create a separate `AudioContext({ sampleRate: 16000 })` for the worklet. Apply the silence buffer trick on iOS to force the audio graph to activate.

---

### Phase 3 — Gemini Live Session Manager (new refs + functions in `src/App.tsx`)

**New refs to add** (alongside existing refs in the ref block, ~line 77):

```tsx
// Gemini Live session state
const geminiLiveWsRef = useRef<WebSocket | null>(null);
const geminiLiveCaptureCtxRef = useRef<AudioContext | null>(null);   // separate from ttsAudioCtxRef
const geminiLiveGenerationRef = useRef(0);                            // same pattern as ttsGenerationRef
const geminiLiveActiveRef = useRef(false);                            // synchronous guard — never via useEffect
```

**Character gating** — extend the existing `VOICE_AGENT_ID_BY_SLIDE` pattern at App.tsx:165:

```tsx
// Add alongside VOICE_AGENT_ID_BY_SLIDE
const GEMINI_LIVE_SLIDES = new Set(['einstein']);
```

Check in `startCharacterRecording` (before the existing `getUserMedia` call):

```tsx
if (GEMINI_LIVE_SLIDES.has(slide.id)) {
  startGeminiLiveSession(slide);
  return;
}
// ... existing Smallest AI path continues unchanged
```

**`startGeminiLiveSession(slide)`** — new async function:

```tsx
const startGeminiLiveSession = async (slide: Slide) => {
  if (geminiLiveActiveRef.current) return;         // guard: no double-open
  geminiLiveActiveRef.current = true;              // synchronous — same pattern as streamActiveRef
  setIsCharacterRecording(true);

  // 1. Fetch ephemeral token
  const tokenRes = await fetch('/api/gemini-live-token', { method: 'POST' });
  const { token } = await tokenRes.json();

  // 2. Open WebSocket
  const ws = new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${token}`
  );
  geminiLiveWsRef.current = ws;
  const myGeneration = ++geminiLiveGenerationRef.current;

  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    // 3. Send setup
    ws.send(JSON.stringify({
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } }
          }
        },
        systemInstruction: {
          parts: [{ text: buildSystemPrompt(slide.id) }]
        }
      }
    }));
  };

  ws.onmessage = (event) => handleGeminiLiveMessage(event, myGeneration, slide.id);
  ws.onerror = (e) => {
    console.error('[gemini-live] ws error', e);
    stopGeminiLiveSession();
  };
  ws.onclose = () => {
    geminiLiveActiveRef.current = false;
    setIsCharacterRecording(false);
  };

  // 4. Start mic capture via AudioWorklet
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
    const captureCtx = new AudioContext({ sampleRate: 16000 });
    geminiLiveCaptureCtxRef.current = captureCtx;

    // iOS silence trick
    const silenceBuf = captureCtx.createBuffer(1, 1, captureCtx.sampleRate);
    const silenceNode = captureCtx.createBufferSource();
    silenceNode.buffer = silenceBuf;
    silenceNode.connect(captureCtx.destination);
    silenceNode.start();

    await captureCtx.audioWorklet.addModule('/audio-processor.worklet.js');
    const micSource = captureCtx.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(captureCtx, 'pcm-processor');

    workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (geminiLiveGenerationRef.current !== myGeneration) return; // stale session guard
      // Send PCM chunk to Gemini (base64 encoded per SDK protocol)
      const base64 = arrayBufferToBase64(e.data);
      ws.send(JSON.stringify({
        realtimeInput: {
          audio: { data: base64, mimeType: 'audio/pcm;rate=16000' }
        }
      }));
    };

    micSource.connect(workletNode);
    // workletNode NOT connected to captureCtx.destination — prevents echo
    characterStreamRef.current = stream; // reuse existing ref for track cleanup
  } catch (err) {
    console.error('[gemini-live] mic error', err);
    stopGeminiLiveSession();
  }
};
```

**`handleGeminiLiveMessage`** — routes server messages:

```tsx
const handleGeminiLiveMessage = (
  event: MessageEvent,
  myGeneration: number,
  slideId: string
) => {
  if (geminiLiveGenerationRef.current !== myGeneration) return; // stale guard

  let msg: any;
  try { msg = JSON.parse(event.data); } catch { return; }

  // --- Barge-in ---
  if (msg.serverContent?.interrupted) {
    stopGeminiLiveAudio();           // flush queued audio
    handleInteractRef.current('stand idle');
    return;
  }

  // --- Audio chunks ---
  const parts = msg.serverContent?.modelTurn?.parts ?? [];
  for (const part of parts) {
    if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
      const pcmBytes = base64ToUint8Array(part.inlineData.data);
      enqueuePCMChunk(pcmBytes, 24000); // feeds into existing AudioContext queue
    }
  }

  // --- Transcript (for Odyssey action) ---
  const transcript = msg.serverContent?.outputTranscription?.text;
  if (transcript) {
    const action = deriveOdysseyAction(transcript);
    handleInteractRef.current(action);
  }

  // --- Turn complete ---
  if (msg.serverContent?.turnComplete) {
    setIsCharacterThinking(false);
  }
};
```

**`stopGeminiLiveSession`** — clean teardown:

```tsx
const stopGeminiLiveSession = () => {
  if (!geminiLiveActiveRef.current) return;
  geminiLiveActiveRef.current = false; // synchronous — prevents re-entry

  geminiLiveWsRef.current?.close();
  geminiLiveWsRef.current = null;

  geminiLiveCaptureCtxRef.current?.close().catch(() => undefined);
  geminiLiveCaptureCtxRef.current = null;

  characterStreamRef.current?.getTracks().forEach(t => t.stop());
  characterStreamRef.current = null;

  setIsCharacterRecording(false);
};
```

---

### Phase 4 — PCM Playback Helpers

Two helpers to wire Gemini Live output into the existing `AudioContext` queue:

**`enqueuePCMChunk(bytes, sampleRate)`** — extracts the scheduling logic from `playCharacterTTS` (lines 671–711) into a standalone function. Called by both the existing TTS path (refactored) and the new Gemini Live path. This DRYs up the code while keeping the two pipelines independent.

```tsx
const enqueuePCMChunk = (data: Uint8Array, sampleRate: number) => {
  if (geminiLiveGenerationRef.current !== currentLiveGeneration) return; // guard
  const ctx = ttsAudioCtxRef.current;
  if (!ctx) return;
  // Same Int16→Float32 + createBufferSource().start(playbackTime) logic
  // as playCharacterTTS lines 676–707
  // ...
};
```

**`stopGeminiLiveAudio()`** — stops queued audio on barge-in or navigation:

```tsx
const stopGeminiLiveAudio = () => {
  geminiLiveGenerationRef.current++; // invalidates all in-flight chunks
  // All future enqueuePCMChunk calls will see the new generation and return early
};
```

**Note:** The existing `playCharacterTTS` function itself is unchanged. The Gemini Live path calls `enqueuePCMChunk` directly; the Smallest AI path still calls `playCharacterTTS`. These are two independent audio consumers of the same `ttsAudioCtxRef`.

---

### Phase 5 — Action Extraction from Transcript

**`deriveOdysseyAction(transcript: string): string`**

Simple keyword heuristic approach for the initial implementation (no function calling required):

```tsx
const GEMINI_LIVE_ACTION_MAP: Array<[RegExp, string]> = [
  [/\b(yes|correct|exactly|absolutely|indeed)\b/i, 'nod enthusiastically'],
  [/\b(no|wrong|incorrect|not quite)\b/i, 'shake head and gesture correction'],
  [/\b(imagine|picture|think of|consider)\b/i, 'gesture thoughtfully and look upward'],
  [/\b(look at|observe|see|notice)\b/i, 'point and gesture toward viewer'],
  [/\b(discovered|found|realized|eureka)\b/i, 'gesture excitedly and look animated'],
  [/\b(simple|easy|basic)\b/i, 'nod and gesture simply'],
];

function deriveOdysseyAction(transcript: string): string {
  for (const [pattern, action] of GEMINI_LIVE_ACTION_MAP) {
    if (pattern.test(transcript)) return action;
  }
  return 'nod thoughtfully and gesture gently'; // same default as runCharacterInteraction
}
```

This intentionally mirrors the existing default at App.tsx:769. Can be expanded post-testing.

---

### Phase 6 — System Prompt for Einstein (Gemini Live)

**`buildSystemPrompt(slideId: string): string`**

Returns the character's system prompt adapted for Gemini Live. The existing prompts in `server/character-prompts/einstein.txt` are text-chat prompts that tell the model to "return JSON only." That instruction must be removed for the Live path.

```tsx
// Server-side: add a new endpoint or include prompt in token response
// OR: embed stripped prompt inline for the initial test
const GEMINI_LIVE_SYSTEM_PROMPTS: Record<string, string> = {
  einstein: `You are Albert Einstein. Respond as Einstein would — curious, imaginative, with dry wit.
Keep replies under 30 words. Speak naturally (no JSON). Explain ideas simply and vividly.`
};

function buildSystemPrompt(slideId: string): string {
  return GEMINI_LIVE_SYSTEM_PROMPTS[slideId] ?? 'You are a helpful character. Keep replies brief.';
}
```

The prompt is injected into the `setup` message's `systemInstruction.parts[0].text`.

---

### Phase 7 — Back Navigation Teardown

Extend the `showLanding` useEffect (App.tsx:443) to tear down an active Gemini Live session:

```tsx
useEffect(() => {
  if (!showLanding) return;

  // Stop Gemini Live session if active
  if (geminiLiveActiveRef.current) {
    stopGeminiLiveAudio();  // increment generation counter — stops audio chunks
    stopGeminiLiveSession(); // closes WS + mic
  }

  // ... existing Odyssey teardown unchanged ...
  ++requestIdRef.current;
  retryStreamRef.current = null;
  if (streamActiveRef.current) {
    streamActiveRef.current = false;
    serviceRef.current?.endStream().catch(() => undefined);
  }
}, [showLanding]);
```

This satisfies the success criterion: "Back navigation stops Gemini Live audio."

---

### Phase 8 — Record Button UI

The record button JSX (App.tsx:~1381) only needs a branch for `isVoiceAgentSlide` vs. `GEMINI_LIVE_SLIDES.has(slide?.id)`. The button behavior is identical (tap-to-start / tap-to-stop); only the underlying handler differs:

```tsx
const handleRecordClick = () => {
  if (GEMINI_LIVE_SLIDES.has(slide?.id)) {
    isCharacterRecording ? stopGeminiLiveSession() : startGeminiLiveSession(slide);
  } else {
    isCharacterRecording ? stopCharacterRecording() : startCharacterRecording();
  }
};
```

Visual states (`isCharacterRecording`, `isCharacterThinking`, `isStreamingReady`) are shared between both paths — no separate state variables needed.

---

## Alternative Approaches Considered

### 1. Vercel Edge Function WebSocket Proxy (rejected — not feasible)

The requirements doc proposed a Vercel Edge Function holding the WebSocket proxy. Research confirms Vercel cannot act as a WebSocket server at all (Edge or Serverless). Even Fluid Compute (longer-lived invocations) does not add WebSocket server capability. Official Vercel KB: "Vercel Functions do not support acting as a WebSocket server."

The ephemeral token pattern is Google's documented solution for exactly this use case. See: [Gemini Live API get-started-websocket](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket).

### 2. Dedicated WebSocket Server (e.g., Railway/Fly.io) (deferred)

A separate persistent Node.js service on Railway/Fly could proxy WebSocket between browser and Gemini. This keeps keys fully server-side without ephemeral tokens. However, it adds a second infrastructure dependency, complicates local dev, and adds latency. The ephemeral token approach is simpler and officially supported. Can be revisited if ephemeral token TTL becomes a problem in production.

### 3. Function Calling for Action Extraction (deferred)

Adding a function-calling tool to the Gemini Live session (e.g., `set_avatar_action(action_description: string)`) would give structured, reliable action data rather than heuristic keyword matching. The tradeoff: function calling adds setup complexity and may marginally increase latency. The keyword heuristic is sufficient for the test phase; function calling can be added once the pipeline is validated.

### 4. Server-Side @google/genai SDK for Live API (considered, not chosen)

`ai.live.connect()` works in Node.js server environments. The blocker is Vercel's inability to hold a persistent WebSocket server — the issue is infrastructure, not the SDK. The SDK itself would work fine in a persistent Node.js server (Option 2 above).

---

## System-Wide Impact

### Interaction Graph

- **Record button tap (Einstein) →** `startGeminiLiveSession()` → POST `/api/gemini-live-token` → WebSocket open → `setup` message → mic stream starts → `sendRealtimeInput` loop
- **Gemini PCM chunk arrives →** `handleGeminiLiveMessage` → `enqueuePCMChunk` → `AudioContext.createBufferSource().start(time)` → audio plays
- **Gemini transcript arrives →** `deriveOdysseyAction` → `handleInteractRef.current(action)` → `serviceRef.current.interact(streamPrompt)` → Odyssey animates
- **Barge-in (`interrupted: true`) →** `stopGeminiLiveAudio` (generation counter++) → all in-flight `enqueuePCMChunk` calls are no-ops → `interact("stand idle")`
- **Back navigation →** `showLanding` useEffect → `stopGeminiLiveAudio` + `stopGeminiLiveSession` → `endStream` → Odyssey teardown

### Error & Failure Propagation

- **Token endpoint 500:** `startGeminiLiveSession` catches, calls `stopGeminiLiveSession` → resets `isCharacterRecording`, user can retry
- **WebSocket error:** `ws.onerror` calls `stopGeminiLiveSession` → graceful reset
- **WebSocket close (server-side):** `ws.onclose` clears `geminiLiveActiveRef` and `isCharacterRecording`
- **`getUserMedia` rejection:** caught in `startGeminiLiveSession`, calls `stopGeminiLiveSession`
- **Stale chunks after navigation:** `geminiLiveGenerationRef` increment makes all in-flight `enqueuePCMChunk` calls no-ops — same pattern as `ttsGenerationRef` in Fix 2

### State Lifecycle Risks

- **Double-open guard:** `if (geminiLiveActiveRef.current) return` at top of `startGeminiLiveSession` prevents a second session from opening before the first closes
- **`geminiLiveActiveRef` is set synchronously** (not via `useEffect`) — follows the `streamActiveRef` pattern documented as critical in `docs/solutions/integration-issues/stream-never-starts-odyssey-switching-20260327.md`
- **Mic track cleanup:** `characterStreamRef.current?.getTracks().forEach(t => t.stop())` in `stopGeminiLiveSession` ensures the browser mic indicator disappears
- **Ephemeral token TTL:** Tokens expire (~60s). This is fine for a normal conversation turn. If a user opens the mic and stays silent for >60s, the setup message may fail. Out of scope for test phase.

### API Surface Parity

- The Smallest AI pipeline (all non-Einstein characters) is untouched — same code paths, same routes
- `isCharacterRecording` state is shared — the UI renders identically for both pipelines
- `handleInteractRef.current(action)` is the same call for both pipelines — Odyssey integration is unchanged
- Fix 2's `currentTtsSourceRef` / `ttsGenerationRef` (from `docs/plans/2026-03-28-001-feat-tts-qol-improvements-plan.md`) covers the Smallest AI TTS path; `geminiLiveGenerationRef` covers the Gemini Live path independently

### Integration Test Scenarios

1. **Happy path:** Tap record on Einstein → speak → hear response within ~500ms → avatar gestures → tap stop or speak again (barge-in)
2. **Back navigation mid-response:** Tap record → speak → immediately tap Back while Gemini is responding → verify no audio plays on landing page, mic indicator gone
3. **Back navigation during mic open:** Tap record → do NOT speak → tap Back → verify WebSocket closed, mic released, no orphaned stream
4. **Non-Einstein character unaffected:** Switch to Cleopatra → full STT+TTS pipeline unchanged, no Gemini Live code runs
5. **Character switch mid-session:** Navigate from Einstein to Cleopatra → Gemini Live session tears down cleanly, Cleopatra uses Smallest AI pipeline

---

## Acceptance Criteria

### Functional

- [ ] R1: Only Einstein uses Gemini Live; all other characters use the existing pipeline unchanged
- [ ] R2 (revised): `POST /api/gemini-live-token` returns an ephemeral token; Gemini API key is not exposed in browser network traffic
- [ ] R3: Browser mic audio is captured as 16-bit PCM at 16kHz via `AudioWorkletNode` and sent over WebSocket
- [ ] R4: Gemini Live audio output plays through the existing `AudioContext` scheduling queue (gapless)
- [ ] R5: Text transcript arrives alongside audio via `outputAudioTranscription`
- [ ] R6: Odyssey receives an `interact()` action derived from the transcript for each model turn
- [ ] R7: Barge-in (`serverContent.interrupted`) stops audio immediately and sends `interact("stand idle")` to Odyssey
- [ ] R8: All changes on a feature branch; nothing merged to `main` until manually verified end-to-end

### Non-Functional

- [ ] First audio byte from Gemini Live arrives within ~500ms of VAD detecting speech end (measured in DevTools network tab)
- [ ] No API keys appear in browser DevTools (Network tab, Console, or Source maps)
- [ ] Mic browser indicator (🔴) disappears after back navigation or session end
- [ ] No ghost audio on the landing page after back navigation mid-response
- [ ] iOS Safari: audio plays correctly (separate `AudioContext` for capture, silence buffer trick applied)

### Quality Gates

- [ ] ESLint / TypeScript — no new type errors
- [ ] Manual smoke test across all 8 characters (only Einstein shows different behavior)
- [ ] Manual smoke test on iOS Safari (AudioContext session category, silence trick)

---

## Dependencies & Risks

| Item | Detail | Mitigation |
|---|---|---|
| Gemini ephemeral token API | `POST /v1beta/ephemeralApiKeys` must be available and stable | Verified in research; fallback: use API key directly during branch testing only |
| `gemini-3.1-flash-live-preview` availability | Model must be accessible with the project's API key | Verify in Gemini AI Studio before starting |
| Voice quality tradeoff | Einstein currently uses the "magnus" cloned voice; Gemini Live uses preset "Puck" | Known tradeoff (see origin doc); document for post-test decision |
| `@google/genai` v1.42.0 Live API support | `ai.live.connect()` may not be in v1.42.0 | Plan uses raw WebSocket directly (no SDK needed for browser-side); SDK only needed server-side if proxying (which we aren't) |
| iOS AudioContext session category | Connecting mic to `ttsAudioCtxRef` silences it on iOS | Mitigated: use separate `AudioContext({ sampleRate: 16000 })` for capture |
| Ephemeral token TTL | ~60s expiry; if mic open > 60s with no speech, session may fail setup | Acceptable for test phase; document as known limitation |
| Fix 2 not yet implemented | `currentTtsSourceRef` / `ttsGenerationRef` for Smallest AI TTS path don't exist yet | Gemini Live uses its own `geminiLiveGenerationRef` independently; Fix 2 can land separately |

---

## Files to Change

| File | Change |
|---|---|
| `server/index.js` | Add `POST /api/gemini-live-token` route (~20 lines) |
| `public/audio-processor.worklet.js` | **NEW** — AudioWorklet PCM processor |
| `src/App.tsx` | Add `GEMINI_LIVE_SLIDES` set; add 4 new refs; add `startGeminiLiveSession`, `stopGeminiLiveSession`, `stopGeminiLiveAudio`, `handleGeminiLiveMessage`, `deriveOdysseyAction`, `buildSystemPrompt`, `enqueuePCMChunk` functions; update `showLanding` useEffect; update record button click handler |

No changes to: `vercel.json`, `src/lib/odyssey.ts`, `src/data/characters.json`, any existing API routes.

---

## Success Metrics

- Subjective latency: response feels "immediate" vs. the current noticeable pause
- First-byte latency: ≤500ms from mic stop to first audio output (measure with DevTools performance trace)
- Zero regressions: all other 7 characters work as before

---

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-03-30-gemini-live-speech-to-speech-requirements.md](docs/brainstorms/2026-03-30-gemini-live-speech-to-speech-requirements.md)
  - Key decisions carried forward: ephemeral token > client-side key exposure; one test character (Einstein); Odyssey text actions preserved via transcript; branch-first deployment
  - Key decision revised: Edge Function WebSocket proxy → not feasible; replaced with browser-direct WebSocket + ephemeral token (see Architecture Correction section)

### Internal References

- `streamActiveRef` atomic pattern: [src/App.tsx:94](src/App.tsx#L94) — `geminiLiveActiveRef` follows this exact pattern
- `playCharacterTTS` PCM queue: [src/App.tsx:671–711](src/App.tsx#L671) — `enqueuePCMChunk` extracts this logic
- `runCharacterInteraction` action default: [src/App.tsx:769](src/App.tsx#L769) — same default used in `deriveOdysseyAction`
- `VOICE_AGENT_ID_BY_SLIDE` gating pattern: [src/App.tsx:165](src/App.tsx#L165) — `GEMINI_LIVE_SLIDES` follows this
- `showLanding` useEffect: [src/App.tsx:443](src/App.tsx#L443) — Gemini Live teardown added here
- TTS QoL plan (Fix 2 generation counter): [docs/plans/2026-03-28-001-feat-tts-qol-improvements-plan.md](docs/plans/2026-03-28-001-feat-tts-qol-improvements-plan.md)
- Stream-hang incident (synchronous ref pattern): [docs/solutions/integration-issues/stream-never-starts-odyssey-switching-20260327.md](docs/solutions/integration-issues/stream-never-starts-odyssey-switching-20260327.md)

### External References

- [Gemini 3.1 Flash Live model card — Google AI](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview)
- [Gemini Live API WebSocket get-started — Google AI](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket)
- [Gemini Live API SDK get-started — Google AI](https://ai.google.dev/gemini-api/docs/live-api/get-started-sdk)
- [Gemini Live API capabilities guide — Google AI](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
- [Vercel Functions WebSocket KB — Vercel](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections)
- [MDN: AudioWorkletNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode)
- [MDN: AudioWorkletProcessor](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor)
- [python-genai issue #380: response modalities AUDIO+TEXT](https://github.com/googleapis/python-genai/issues/380)
