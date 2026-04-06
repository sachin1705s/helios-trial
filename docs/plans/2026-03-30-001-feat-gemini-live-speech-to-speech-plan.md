---
title: "feat: Gemini Flash Live Speech-to-Speech Integration"
type: feat
status: in-progress
date: 2026-03-30
deepened: 2026-04-06
origin: docs/brainstorms/2026-03-30-gemini-live-speech-to-speech-requirements.md
---

# feat: Gemini Flash Live Speech-to-Speech Integration

---

## Enhancement Summary

**Deepened on:** 2026-04-06  
**Research agents used:** 12 (architecture, race-conditions, security, performance, reliability, TypeScript, best-practices, feasibility, framework-docs, learnings, testing, scope)

### Implementation Corrections (Plan Was Wrong — Now Fixed)

1. **WebSocket endpoint version:** `v1beta` is correct for `gemini-3.1-flash-live-preview` (not `v1alpha` as tried during debugging). The plan was right; a debugging change introduced `v1alpha` — reverted.
2. **Setup message structure:** `outputAudioTranscription` is a **top-level field of `setup`**, not inside `generationConfig`. `speechConfig` is **inside `generationConfig`**. The plan's code block had `outputAudioTranscription` inside `generationConfig` — corrected in Phase 3.
3. **Voice field name:** `voiceName` (not `voiceId` as one API doc example incorrectly showed).
4. **Ephemeral token endpoint:** `POST /v1beta/ephemeralApiKeys` returns 404 with AI Studio API keys — it requires OAuth2/service account credentials. Current workaround: server returns the raw API key. **This voids the R2 acceptance criterion.** See Phase 1 for the architectural decision record.
5. **PTT semantics:** Ctrl+Space is now a toggle (start on press, release is no-op) — not PTT — because Gemini Live uses server-side VAD.
6. **`realtimeInput` wire format:** Confirmed as `{ realtimeInput: { audio: { data, mimeType } } }` — correct as implemented.

### Critical Bugs Discovered (Not Yet Fixed)

| # | Bug | File | Impact |
|---|-----|------|--------|
| B1 | `geminiLiveGenerationRef` incremented AFTER 2 async awaits — race with Stop during startup | App.tsx:885 | Deaf session (messages silently dropped) |
| B2 | `characterStreamRef` assigned AFTER getUserMedia — mic leaks if permission denied | App.tsx:868 | Live mic with no cleanup path |
| B3 | No cleanup on character switch — active mic/WS survives navigation away from Einstein | App.tsx:1432 | Resource leak, quota drain |
| B4 | Token fetch has no AbortController timeout — UI locks on slow/hanging server | App.tsx:872 | User stuck with isCharacterRecording=true |
| B5 | No setupComplete timeout — silent hang if Gemini never acks setup | App.tsx:892 | Session appears active but mic never starts |
| B6 | `goAway` server message not handled — session expires silently with no user message | App.tsx:907 | User has no indication session ended |
| B7 | Tab backgrounding suspends AudioContext — mic stream stops silently | App.tsx:809 | Session appears live but Gemini hears silence |
| B8 | `/api/gemini-live-token` missing `aiLimiter` — only unprotected AI endpoint | server/index.js:479 | Quota abuse risk |

### Key Performance Issues (Not Yet Fixed)

| # | Issue | Impact |
|---|-------|--------|
| P1 | `arrayBufferToBase64` uses per-char string concat — O(n²) at 125 calls/sec | 70–80% of encoding CPU on mobile |
| P2 | JSON.stringify per 8ms frame — 125 allocs/sec | ~15% per-callback overhead |
| P3 | `geminiLiveSourceNodesRef` is Array with O(n) cleanup — memory grows over long sessions | GC pressure, potential leak |
| P4 | AudioWorklet sends 128-sample quanta (8ms, 125/sec) — should batch to 100ms | 12× message reduction for free |

### New Considerations Discovered

- **`audioStreamEnd` message missing** — should be sent when mic is stopped to flush Gemini's audio buffer
- **TypeScript interfaces missing** — all Gemini wire-format messages use `Record<string, unknown>` with casts; a `GeminiServerMessage` interface hierarchy would eliminate all assertions
- **Module-level constants** — `GEMINI_LIVE_ACTION_MAP`, `GEMINI_LIVE_SLIDES`, `GEMINI_LIVE_SYSTEM_PROMPTS` re-allocate on every render; should be module-level
- **AudioWorklet ring buffer playback** (best practice) — multiple per-chunk `AudioBufferSourceNode`s creates GC pressure; a ring-buffer playback worklet is the production pattern
- **iOS**: Create `AudioContext` BEFORE `getUserMedia` (not after) to prevent iOS from routing all audio to speakerphone

---

## Overview

Replace the current STT → text-chat → TTS pipeline for a single test character (Einstein) with Gemini Flash Live — a native audio-to-audio model that collapses all three steps into one WebSocket stream. Target latency drops from ~1.5–3s to ~200–500ms. All other characters keep the existing Smallest AI pipeline untouched.

**Architecture correction vs. requirements doc (R2):** The requirements doc assumed a Vercel Edge Function could hold a persistent WebSocket proxy to Gemini. Research confirms Vercel cannot act as a WebSocket server at all (Edge or Serverless). The correct pattern — and Google's documented approach for browser apps — is a **direct browser → Gemini WebSocket using a short-lived ephemeral token** issued by a Vercel serverless route. The API key stays server-side; only the short-lived token crosses to the browser.

**Second correction (2026-04-06):** The ephemeral token API (`POST /v1beta/ephemeralApiKeys`) returns 404 with AI Studio API keys. It requires service account/OAuth2 credentials. The current implementation passes the raw API key through the server endpoint as a pragmatic workaround for the test branch. This is explicitly a test-phase compromise — see Phase 1 for full ADR.

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
                   WebSocket (API key)                 │ │
                         │                            │ │
┌────────────────────────▼──────────────────────────────┐ │
│ Vercel /api/gemini-live-token                         │ │
│  Returns API key (test phase) or ephemeral token      │ │
│  (production, once service account auth is available) │ │
└───────────────────────────────────────────────────────┘ │
                                                          │
┌─────────────────────────────────────────────────────────▼─┐
│ Gemini Live API (wss://generativelanguage.googleapis.com/) │
│  Endpoint: v1beta.GenerativeService.BidiGenerateContent    │
│  Model: gemini-3.1-flash-live-preview                      │
│  Input:  PCM 16-bit, 16kHz, mono                          │
│  Output: PCM 16-bit, 24kHz, mono  +  transcript           │
│  VAD: automatic (server-side)                             │
└────────────────────────────────────────────────────────────┘
```

### Session lifecycle

1. User taps record on Einstein slide
2. Browser POSTs to `/api/gemini-live-token` → receives token (API key for now; ephemeral token eventually)
3. Browser opens WebSocket to Gemini Live with token
4. Sends `setup` message with Einstein's system prompt + `outputAudioTranscription`
5. Waits for `setupComplete` from server (8s timeout)
6. Starts mic via `AudioWorkletNode` at 16kHz → streams PCM chunks
7. Server VAD detects speech end → model responds
8. Gemini sends PCM audio chunks → fed into AudioContext scheduling queue
9. Gemini sends transcript chunks → action heuristic → `handleInteractRef.current(action)`
10. On barge-in (`serverContent.interrupted: true`) → flush audio queue + `interact("stand idle")`
11. Session stays open (VAD-driven) until user taps stop or navigates back
12. On stop: send `audioStreamEnd` → close WebSocket → release mic

---

## Technical Approach

### Phase 1 — Token Endpoint

**File:** `server/index.js`

**Architectural Decision Record — Test Phase Key Passthrough**

The original plan called for fetching a short-lived token from `POST /v1beta/ephemeralApiKeys`. During implementation, this endpoint returned 404 — it requires OAuth2/service account credentials, not an AI Studio API key. The test-phase workaround is to return the raw API key from the server endpoint.

**Security implications of the workaround:**
- The permanent API key crosses the network in the POST response body and appears in the WebSocket URL as `?key=`
- It is visible in browser DevTools Network tab (WebSocket URL) and potentially in server access logs
- Any user who opens DevTools can extract the key and use it indefinitely for any Gemini endpoint
- The key grants access to all Gemini API endpoints, not just Live
- **R2 acceptance criterion ("key not exposed in browser network traffic") is NOT met in the current state**

**Accepted tradeoffs for test phase:** The key is not embedded in client-side source/bundle. The server endpoint is the only distribution point. Blast radius is bounded by setting a Google Cloud billing cap and enabling billing alerts.

**Path to fix:** Move the Google Cloud project to use a service account key. The ephemeral token endpoint works with service account credentials.

```js
// server/index.js — current test-phase implementation
// ⚠️ Returns raw API key, not an ephemeral token — accepted for test branch only
app.post('/api/gemini-live-token', aiLimiter, (req, res) => {
  const apiKey = runtimeConfig.geminiApiKey;
  if (!apiKey) return res.status(503).json({ error: 'Gemini API key not configured.' });
  return res.json({ token: apiKey });
  // TODO: Replace with ephemeral token fetch once service account credentials are available:
  // POST /v1beta/ephemeralApiKeys with x-goog-api-key (service account key)
  // return res.json({ token: data.ephemeralKey });
});
```

**⚠️ NOTE:** The current implementation uses `aiLimiter` — this is required. The endpoint was previously missing a rate limiter entirely (the only unprotected AI endpoint in the server).

**Acceptance:** `POST /api/gemini-live-token` returns `{ token: "..." }` within 200ms. Token is usable as a WebSocket `?key=` parameter.

### Research Insights — Phase 1

**Security mitigations while using raw key:**
- Apply `aiLimiter` (40 req/min) — done ✓
- Consider a tighter dedicated limit (5 per IP per 15min) for this endpoint specifically
- Log each issuance with IP for abuse detection
- Set a Google Cloud billing cap + alerts immediately

---

### Phase 2 — AudioWorklet PCM Processor

**File (new):** `public/audio-processor.worklet.js`

Runs off the main thread. Converts 128-sample Float32 buffers to Int16 PCM and transfers zero-copy to the main thread.

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

**Why AudioWorklet and not ScriptProcessorNode:** `ScriptProcessorNode` is deprecated and runs on the main thread. At 16kHz streaming under active UI, it causes glitches. `AudioWorkletNode` runs on the audio rendering thread (off-main-thread), required for reliable streaming at these latencies.

**iOS note:** Do NOT reuse `ttsAudioCtxRef` for mic capture. After TTS has played on iOS, `ttsAudioCtxRef` is in "playback" session category; connecting `createMediaStreamSource` to it produces a silent analyser. Create a separate `AudioContext({ sampleRate: 16000 })` for capture.

### Research Insights — Phase 2

**Optimization: accumulate to 100ms before sending (not yet implemented — high value)**

At 16kHz, 128 samples = 8ms of audio = 256 bytes. Sending every quantum means 125 WebSocket sends/sec. The correct pattern is to accumulate 1600 samples (100ms) in the worklet before posting to main thread — reduces sends from 125/sec to 10/sec with no perceptible latency impact and dramatically lower allocation pressure.

```js
// Enhanced worklet with 100ms accumulation
const TARGET_SAMPLES = 1600; // 100ms @ 16kHz

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(TARGET_SAMPLES);
    this._offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;

      if (this._offset >= TARGET_SAMPLES) {
        this.port.postMessage(this._buffer.buffer, [this._buffer.buffer]);
        this._buffer = new Int16Array(TARGET_SAMPLES); // fresh buffer
        this._offset = 0;
      }
    }
    return true;
  }
}
```

**iOS Safari specifics:**
- Create `AudioContext` BEFORE calling `getUserMedia` — otherwise iOS routes all audio to speakerphone
- iOS 16.2–16.4 had a WebKit bug causing AudioWorklet distortion; 16.5+ fixed it
- Handle `ctx.state === 'interrupted'` (iOS-specific state when backgrounded) via `statechange` event
- ScriptProcessorNode fallback (4096-sample buffer) for browsers where AudioWorklet fails to load

**audioStreamEnd message (not yet implemented):** When stopping the session, send `{ realtimeInput: { audioStreamEnd: true } }` before closing the WebSocket to flush Gemini's audio buffer for the current turn.

**Binary vs JSON frames:** Gemini Live requires JSON-wrapped base64 for `realtimeInput` — binary WebSocket frames are not accepted for input audio. The `ws.binaryType = 'arraybuffer'` setting is correct for receiving binary frames from the server; it doesn't affect what you send.

---

### Phase 3 — Gemini Live Session Manager

**File:** `src/App.tsx`

**New refs:**

```tsx
// Module-level constants (NOT inside component — avoid per-render allocation)
const GEMINI_LIVE_SLIDES = new Set(['einstein']);

const GEMINI_LIVE_ACTION_MAP: ReadonlyArray<[RegExp, string]> = [
  [/\b(yes|correct|exactly|absolutely|indeed)\b/i, 'nod enthusiastically'],
  [/\b(no|wrong|incorrect|not quite)\b/i, 'shake head and gesture correction'],
  [/\b(imagine|picture|think of|consider)\b/i, 'gesture thoughtfully and look upward'],
  [/\b(look at|observe|see|notice)\b/i, 'point and gesture toward viewer'],
  [/\b(discovered|found|realized|eureka)\b/i, 'gesture excitedly and look animated'],
  [/\b(simple|easy|basic)\b/i, 'nod and gesture simply'],
];

const GEMINI_LIVE_SYSTEM_PROMPTS: Readonly<Record<string, string>> = {
  einstein: 'You are Albert Einstein. Respond as Einstein would — curious, imaginative, with dry wit. Keep replies under 30 words. Speak naturally. Explain ideas simply and vividly.',
};

// Inside App():
const geminiLiveWsRef = useRef<WebSocket | null>(null);
const geminiLiveCaptureCtxRef = useRef<AudioContext | null>(null);
const geminiLiveGenerationRef = useRef(0);
const geminiLiveActiveRef = useRef(false);  // synchronous guard — never via useEffect
```

**TypeScript interfaces for Gemini wire protocol (should live in `src/lib/geminiLive.types.ts`):**

```typescript
export interface GeminiInlineData { mimeType: string; data: string; }
export interface GeminiPart { text?: string; inlineData?: GeminiInlineData; }
export interface GeminiModelTurn { parts: GeminiPart[]; }
export interface GeminiServerContent {
  interrupted?: boolean;
  turnComplete?: boolean;
  modelTurn?: GeminiModelTurn;
  outputTranscription?: { text: string };
}
export interface GeminiServerMessage {
  setupComplete?: Record<string, never>;
  serverContent?: GeminiServerContent;
  goAway?: { timeLeft?: string };
}
```

**Corrected setup message format** (v1beta endpoint, `outputAudioTranscription` at top level of `setup`):

```tsx
// Correct WebSocket URL — v1beta for gemini-3.1-flash-live-preview
const ws = new WebSocket(
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${token}`
);

// Correct setup message structure (confirmed from BidiGenerateContentSetup proto):
// - speechConfig is INSIDE generationConfig
// - outputAudioTranscription is at TOP LEVEL of setup (sibling of generationConfig)
ws.send(JSON.stringify({
  setup: {
    model: 'models/gemini-3.1-flash-live-preview',
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
    },
    outputAudioTranscription: {},
    systemInstruction: { parts: [{ text: buildSystemPrompt(slideId) }] },
  }
}));
```

**`startGeminiLiveSession` — corrected ordering (critical bugs B1 and B2):**

```tsx
const startGeminiLiveSession = async () => {
  if (geminiLiveActiveRef.current) return;
  geminiLiveActiveRef.current = true;    // synchronous guard
  // B1 FIX: capture generation BEFORE first await, not after
  const myGeneration = ++geminiLiveGenerationRef.current;
  setIsCharacterRecording(true);

  // Acquire mic early so characterStreamRef is set before token fetch
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
  } catch (err) {
    setCharacterError(err instanceof Error ? err.message : 'Microphone access was blocked.');
    stopGeminiLiveSession();
    return;
  }
  // B2 FIX: assign BEFORE token fetch so stopGeminiLiveSession cleans up on any failure
  characterStreamRef.current = stream;

  // Fetch token with timeout
  let token: string;
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 10_000);
    const tokenRes = await fetch('/api/gemini-live-token', { method: 'POST', signal: ctrl.signal });
    clearTimeout(tid);
    if (!tokenRes.ok) throw new Error(`Token endpoint returned ${tokenRes.status}`);
    const data = await tokenRes.json() as { token?: string };
    if (!data.token) throw new Error('Empty token from server');
    token = data.token;
  } catch (err) {
    console.error('[gemini-live] token fetch error', err);
    setCharacterError('Could not connect to Gemini Live. Try again.');
    stopGeminiLiveSession();
    return;
  }

  // Check if session was stopped while awaiting
  if (geminiLiveGenerationRef.current !== myGeneration) {
    characterStreamRef.current?.getTracks().forEach(t => t.stop());
    characterStreamRef.current = null;
    return;
  }

  const ws = new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${token}`
  );
  geminiLiveWsRef.current = ws;
  ws.binaryType = 'arraybuffer';

  // setupComplete timeout
  let setupTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    console.error('[gemini-live] setupComplete timeout');
    setCharacterError('Connection timed out. Try again.');
    stopGeminiLiveSession();
  }, 8_000);

  ws.onopen = () => {
    console.log('[gemini-live] ws open, sending setup');
    ws.send(JSON.stringify({
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        },
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: buildSystemPrompt(slide.id) }] },
      }
    }));
  };

  ws.onmessage = (event) => {
    let msg: GeminiServerMessage;
    try { msg = JSON.parse(event.data as string) as GeminiServerMessage; }
    catch { return; }

    if (msg.setupComplete !== undefined) {
      if (setupTimer) { clearTimeout(setupTimer); setupTimer = null; }
      console.log('[gemini-live] setup complete, starting mic stream');
      void startGeminiLiveMicStream(ws, myGeneration, stream);
      return;
    }

    // goAway: server is about to close — surface to user
    if (msg.goAway) {
      console.log('[gemini-live] goAway received', msg.goAway);
      setCharacterError('Session ending — tap the button to start a new one.');
      return;
    }

    handleGeminiLiveMessage(msg, myGeneration);
  };

  ws.onerror = (e) => { console.error('[gemini-live] ws error', e); stopGeminiLiveSession(); };
  ws.onclose = (e) => { console.log('[gemini-live] ws closed', e.code, e.reason); stopGeminiLiveSession(); };
};
```

**`stopGeminiLiveSession` — corrected:**

```tsx
const stopGeminiLiveSession = () => {
  if (!geminiLiveActiveRef.current) return; // guard against double-call
  geminiLiveActiveRef.current = false;      // synchronous — same pattern as streamActiveRef
  geminiLiveGenerationRef.current++;        // invalidate all in-flight message handlers

  // Send audioStreamEnd to flush Gemini's current audio buffer
  if (geminiLiveWsRef.current?.readyState === WebSocket.OPEN) {
    try {
      geminiLiveWsRef.current.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    } catch { /* ignore — we're about to close anyway */ }
  }

  // Close only if not already closed/closing
  if (geminiLiveWsRef.current && geminiLiveWsRef.current.readyState < WebSocket.CLOSING) {
    geminiLiveWsRef.current.close();
  }
  geminiLiveWsRef.current = null;

  geminiLiveCaptureCtxRef.current?.close().catch(() => undefined);
  geminiLiveCaptureCtxRef.current = null;

  characterStreamRef.current?.getTracks().forEach(t => t.stop());
  characterStreamRef.current = null;

  setIsCharacterRecording(false);
};
```

**`handleGeminiLiveMessage` — fully typed:**

```tsx
const handleGeminiLiveMessage = (msg: GeminiServerMessage, myGeneration: number) => {
  if (geminiLiveGenerationRef.current !== myGeneration) return;

  const content = msg.serverContent;
  if (!content) return;

  if (content.interrupted) {
    stopGeminiLiveAudio();
    handleInteractRef.current('stand idle');
    return;
  }

  for (const part of content.modelTurn?.parts ?? []) {
    if (part.inlineData?.mimeType.startsWith('audio/pcm')) {
      enqueuePCMChunk(base64ToUint8Array(part.inlineData.data), 24000);
    }
  }

  if (content.outputTranscription?.text) {
    handleInteractRef.current(deriveOdysseyAction(content.outputTranscription.text));
  }

  if (content.turnComplete) setIsCharacterThinking(false);
};
```

**Tab backgrounding — add to component (not yet implemented):**

```tsx
useEffect(() => {
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      geminiLiveCaptureCtxRef.current?.resume().catch(() => undefined);
      ttsAudioCtxRef.current?.resume().catch(() => undefined);
    }
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);
  return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
}, []);
```

**Character switch — add to `handleSelectCharacter` (not yet implemented):**

```tsx
const handleSelectCharacter = (id: string) => {
  // Stop Gemini Live session when switching away from Einstein
  if (geminiLiveActiveRef.current) {
    stopGeminiLiveSession();
  }
  // ... existing character switch logic ...
};
```

### Research Insights — Phase 3

**Generation counter ordering (critical):** The generation counter MUST be incremented synchronously at the top of `startGeminiLiveSession`, before any `await`. If it's incremented after `getUserMedia` and the token fetch (as in the original plan code), a `stopGeminiLiveSession` call during startup will increment the counter, then `startGeminiLiveSession` resumes and increments again — resulting in a generation value that no message handler matches. The WebSocket opens but is permanently deaf.

**Synchronous ref pattern (from `docs/solutions/patterns/critical-patterns.md`):** `geminiLiveActiveRef` must be written synchronously inside WebSocket event handlers. The `stream-never-starts` solution doc explicitly names this ref as an established application of the pattern. Every teardown path must use the atomic read-and-clear pattern.

**Session timeout:** Gemini Live sessions have a maximum duration (~15 minutes). The `goAway` message is sent as advance notice. Without handling it, sessions expire silently. The `ws.onclose` should distinguish server-initiated closes (show reconnect prompt) from user-initiated closes (no action needed).

---

### Phase 4 — PCM Playback Helpers

**`enqueuePCMChunk(data, sampleRate)`** — schedules Gemini audio output on the existing AudioContext:

```tsx
type GeminiPCMSampleRate = 16000 | 24000;

const enqueuePCMChunk = (data: Uint8Array, sampleRate: GeminiPCMSampleRate) => {
  const ctx = ttsAudioCtxRef.current;
  if (!ctx) return;

  const usable = data.length - (data.length % 2);
  if (usable === 0) return;

  const int16 = new Int16Array(data.buffer, data.byteOffset, usable / 2);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 0x7fff;
  }

  const buffer = ctx.createBuffer(1, float32.length, sampleRate);
  buffer.copyToChannel(float32, 0);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);

  // Scheduling: maintain a playback cursor ahead of currentTime
  if (geminiLivePlaybackTimeRef.current < ctx.currentTime + 0.05) {
    geminiLivePlaybackTimeRef.current = ctx.currentTime + 0.05;
  }
  source.start(geminiLivePlaybackTimeRef.current);
  geminiLivePlaybackTimeRef.current += buffer.duration;

  geminiLiveSourceNodesRef.current.add(source); // Use Set, not Array
  source.onended = () => { geminiLiveSourceNodesRef.current.delete(source); };
};
```

**`stopGeminiLiveAudio()`:**

```tsx
const stopGeminiLiveAudio = () => {
  for (const source of geminiLiveSourceNodesRef.current) {
    try { source.stop(); } catch { /* already ended */ }
  }
  geminiLiveSourceNodesRef.current.clear();
  geminiLivePlaybackTimeRef.current = 0;
};
```

### Research Insights — Phase 4

**`geminiLiveSourceNodesRef` must be a `Set`, not an `Array`:**  
With 50 chunks/sec at 24kHz, Array's `indexOf` for cleanup is O(n). A `Set` gives O(1) add/delete. Over a 5-minute session, the Array approach can accumulate thousands of nodes if cleanup lags even slightly — each holding a Float32 audio buffer.

**Performance fix for `arrayBufferToBase64` (not yet applied — critical on mobile):**

```typescript
// Current (O(n²) — 256 string allocations per call at 125 calls/sec):
// for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);

// Fix: single fromCharCode.apply call at 256 bytes is safe and avoids per-char allocation
const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[]);
  }
  return btoa(binary);
};
```

**Pre-built JSON envelope (not yet applied — eliminates JSON.stringify per callback):**

```typescript
const AUDIO_PREFIX = '{"realtimeInput":{"audio":{"data":"';
const AUDIO_SUFFIX = '","mimeType":"audio/pcm;rate=16000"}}}';
// ws.send(AUDIO_PREFIX + base64 + AUDIO_SUFFIX);
// Eliminates object creation and JSON.stringify at 125 calls/sec
```

**Note on DRY claim:** The plan says `enqueuePCMChunk` "extracts logic from `playCharacterTTS`." In reality they are separate implementations with different scheduling approaches. `playCharacterTTS` has its own local `playbackTime` variable and handles streaming odd-byte leftovers. These are intentionally separate — the DRY framing was inaccurate.

**AudioContext sharing risk:** Both `enqueuePCMChunk` (Gemini Live) and `playCharacterTTS` (Smallest AI TTS) schedule onto `ttsAudioCtxRef`. If a text prompt is submitted while a Gemini Live session is active, their scheduling timestamps can collide producing audio overlap. Guard `playCharacterTTS` with `if (geminiLiveActiveRef.current) return` while Einstein is live.

---

### Phase 5 — Action Extraction from Transcript

**`deriveOdysseyAction(transcript: string): string`** — module-level, not inside component:

```tsx
// Module-level (not inside App() — avoids re-allocating RegExp on every render)
function deriveOdysseyAction(transcript: string): string {
  for (const [pattern, action] of GEMINI_LIVE_ACTION_MAP) {
    if (pattern.test(transcript)) return action;
  }
  return 'nod thoughtfully and gesture gently';
}
```

### Research Insights — Phase 5

**Partial chunk false positives:** `outputAudioTranscription` delivers streaming partial text chunks, not complete sentences. A chunk containing "absolutely not" matches the affirmative pattern (`absolutely`) before the negation resolves. This is cosmetic (avatar gestures), so false positives are low-stakes for MVP. The `\b` word boundaries prevent substring matches (e.g., "know" does not match `\bno\b`).

**`outputAudioTranscription` vs `responseModalities TEXT`:** These are different. `outputAudioTranscription` is a transcript of the synthesized audio — what was actually spoken. `responseModalities TEXT` would return a separate text turn containing the model's internal reasoning text. The plan correctly uses `outputAudioTranscription` for deriving avatar actions; the two should not be confused.

**Deferral option for pure latency testing:** For an initial test focused only on latency (does Gemini Live produce audio faster?), replace the full transcript-based action with a single unconditional `handleInteractRef.current('nod thoughtfully and gesture gently')`. This removes the partial-chunk risk entirely while keeping Odyssey animated.

---

### Phase 6 — System Prompt for Einstein (Gemini Live)

**`buildSystemPrompt(slideId: string): string`** — returns the system prompt for the `systemInstruction` field:

```tsx
// Module-level constant
const GEMINI_LIVE_SYSTEM_PROMPTS: Readonly<Record<string, string>> = {
  einstein: 'You are Albert Einstein. Respond as Einstein would — curious, imaginative, with dry wit. Keep replies under 30 words. Speak naturally. Explain ideas simply and vividly.',
};

const buildSystemPrompt = (slideId: string): string =>
  GEMINI_LIVE_SYSTEM_PROMPTS[slideId] ?? 'You are a helpful character. Keep replies brief.';
```

The existing `server/character-prompts/einstein.txt` contains a JSON-format instruction (`"return JSON only"`) that must NOT be used in the Live path. The live prompt is stripped to conversational speech only.

### Research Insights — Phase 6

**Scope:** Embedding a 2-line prompt in the frontend for one test character is appropriate. If this expands to all 8 characters, prompts should move server-side to enable updates without a frontend deploy and to keep them out of source maps (they may guide character tone and could be considered proprietary).

**Null guard:** `buildSystemPrompt(slide.id)` will throw if `slide` is null. Add a null guard at the top of `startGeminiLiveSession` before any async operation: `if (!slide) { stopGeminiLiveSession(); return; }`.

---

### Phase 7 — Back Navigation Teardown

Extend the `showLanding` useEffect to tear down an active Gemini Live session:

```tsx
useEffect(() => {
  if (!showLanding) return;

  if (geminiLiveActiveRef.current) {
    stopGeminiLiveSession(); // closes WS, releases mic, increments generation
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

### Research Insights — Phase 7

**Essential, not optional:** Without this phase, navigating back while Einstein is speaking leaves the mic indicator lit, the WebSocket open, and audio playing over the landing page. It cannot be deferred.

---

### Phase 8 — Record Button UI

The record button uses `GEMINI_LIVE_SLIDES.has(slide?.id)` to dispatch between the two handlers:

```tsx
onClick={
  GEMINI_LIVE_SLIDES.has(slide.id)
    ? (isCharacterRecording ? stopGeminiLiveSession : startGeminiLiveSession)
    : (isCharacterRecording ? stopCharacterRecording : startCharacterRecording)
}
```

Visual states (`isCharacterRecording`, `isCharacterThinking`, `isStreamingReady`) are shared — the UI renders identically for both pipelines.

**PTT (Ctrl+Space) behavior for Gemini Live slides:**

```tsx
pttStartRef.current = () => {
  if (isCharacterSlide) {
    if (isCharacterRecording || isCharacterThinking) return false;
    if (GEMINI_LIVE_SLIDES.has(slide?.id ?? '')) {
      void startGeminiLiveSession();
    } else {
      startCharacterRecording();
    }
    return true;
  }
  // ... non-character slides ...
};

pttStopRef.current = () => {
  if (isCharacterSlide) {
    // Gemini Live: VAD keeps session open — key release is a no-op
    if (!GEMINI_LIVE_SLIDES.has(slide?.id ?? '') && isCharacterRecording) {
      stopCharacterRecording();
    }
    return;
  }
  // ... non-character slides ...
};
```

---

## Alternative Approaches Considered

### 1. Vercel Edge Function WebSocket Proxy (rejected — not feasible)

Vercel cannot act as a WebSocket server at all (Edge or Serverless). Fluid Compute does not add WebSocket capability. The browser-direct + ephemeral token pattern is Google's documented solution.

### 2. Dedicated WebSocket Server (e.g., Railway/Fly.io) (deferred)

A separate persistent Node.js service could proxy WebSocket, keeping the API key fully server-side. Tradeoffs: second infrastructure dependency, complicates local dev, adds latency. Revisit if the ephemeral token approach cannot be enabled (i.e., if a service account key is never available).

### 3. Function Calling for Action Extraction (deferred)

A `set_avatar_action(description)` tool call in the Live session would give structured action data. Tradeoff: setup complexity and marginal latency increase. The keyword heuristic is sufficient for MVP test phase.

### 4. AudioWorklet Ring Buffer Playback (deferred — recommended for production)

Rather than one `AudioBufferSourceNode` per PCM chunk, a playback AudioWorklet with an internal ring buffer eliminates per-chunk node creation and GC pressure. At 50 chunks/sec for a 5-minute session this can accumulate significant GC pressure. Adopt when the pipeline is validated and moving toward production.

---

## System-Wide Impact

### Interaction Graph

- **Record button tap (Einstein) →** `startGeminiLiveSession()` → POST `/api/gemini-live-token` → WebSocket open → `setup` message → `setupComplete` → mic stream starts → 100ms PCM chunks → `realtimeInput` loop
- **Gemini PCM chunk arrives →** `handleGeminiLiveMessage` → `enqueuePCMChunk` → `AudioContext.createBufferSource().start(time)` → audio plays
- **Gemini transcript arrives →** `deriveOdysseyAction` → `handleInteractRef.current(action)` → Odyssey animates
- **Barge-in (`interrupted: true`) →** `stopGeminiLiveAudio` → stop all scheduled nodes → `interact("stand idle")`
- **Back navigation →** `showLanding` useEffect → `stopGeminiLiveSession` (sends `audioStreamEnd`, closes WS, releases mic) → `endStream` → Odyssey teardown
- **Character switch →** `handleSelectCharacter` → `stopGeminiLiveSession` if active → switch character

### Error & Failure Propagation

- **Token endpoint 503/500:** `setCharacterError('Could not connect...')` → `stopGeminiLiveSession` → resets `isCharacterRecording`
- **Token fetch timeout (10s):** AbortController fires → same error path
- **WebSocket 1007 (invalid JSON):** Indicates malformed setup message — check field names and endpoint version
- **WebSocket onerror:** `stopGeminiLiveSession` → graceful reset
- **WebSocket onclose (server-initiated):** Distinguish code 1000/1001 (normal — show reconnect prompt) from other codes (error)
- **setupComplete never arrives (8s timeout):** `stopGeminiLiveSession` + `setCharacterError('Connection timed out')`
- **goAway received:** Surface "Session ending" message to user
- **getUserMedia rejection:** `setCharacterError(err.message)` → `stopGeminiLiveSession`
- **Stale chunks after navigation:** generation counter check in `handleGeminiLiveMessage` makes all in-flight handlers no-ops

### State Lifecycle Risks

- **Double-open guard:** `if (geminiLiveActiveRef.current) return` — synchronous, not via useEffect
- **Generation counter captured before first await** — ensures stopGeminiLiveSession during startup doesn't create deaf session
- **`characterStreamRef` assigned before token fetch** — ensures mic cleanup on any failure path
- **Character switch cleanup:** `handleSelectCharacter` must call `stopGeminiLiveSession` before switching
- **Tab backgrounding:** `visibilitychange` handler resumes both AudioContexts
- **TTS/Gemini Live collision:** Guard `playCharacterTTS` with `if (geminiLiveActiveRef.current) return` when Einstein is active

### Integration Test Scenarios

1. **Happy path:** Tap record on Einstein → speak → hear response within ~500ms → avatar gestures → speak again (barge-in)
2. **Back navigation mid-response:** Tap record → speak → immediately tap Back → no audio on landing page, mic indicator gone
3. **Back navigation during mic open:** Tap record → do NOT speak → tap Back → WebSocket closed, mic released
4. **Non-Einstein character unaffected:** Switch to Cleopatra → full STT+TTS pipeline unchanged
5. **Character switch mid-session:** Navigate from Einstein to Cleopatra → session tears down, Cleopatra uses Smallest AI
6. **Tab backgrounding mid-session:** Background tab → return → AudioContext resumes, session continues
7. **Session timeout (goAway):** Leave session open 14+ minutes → user sees "session ending" prompt
8. **Mic permission denied:** Tap record, deny permission → clean error message, no mic indicator

---

## Acceptance Criteria

### Functional

- [ ] R1: Only Einstein uses Gemini Live; all other characters use the existing pipeline unchanged
- [ ] R2 ⚠️ DEFERRED: `POST /api/gemini-live-token` currently returns the raw Gemini API key (ephemeral token API requires service account credentials not available). Key appears in browser DevTools. Accepted for test branch only — must be resolved before production. See Phase 1 ADR.
- [ ] R3: Browser mic audio is captured as 16-bit PCM at 16kHz via `AudioWorkletNode` and sent over WebSocket
- [ ] R4: Gemini Live audio output plays through the `AudioContext` scheduling queue (gapless)
- [ ] R5: Text transcript arrives alongside audio via `outputAudioTranscription`
- [ ] R6: Odyssey receives an `interact()` action derived from the transcript for each model turn
- [ ] R7: Barge-in (`serverContent.interrupted`) stops audio immediately and sends `interact("stand idle")` to Odyssey
- [ ] R8: All changes on feature branch; nothing merged to `main` until end-to-end verification
- [ ] R9 NEW: Character switch (Einstein → other) tears down the Gemini Live session cleanly
- [ ] R10 NEW: `audioStreamEnd` is sent when the session is stopped to flush Gemini's audio buffer

### Non-Functional

- [ ] First audio byte from Gemini Live arrives within ~500ms of VAD detecting speech end
- [ ] ⚠️ Gemini API key appears in browser DevTools (accepted for test phase — track as known limitation)
- [ ] Mic browser indicator disappears after back navigation or session end
- [ ] No ghost audio on the landing page after back navigation mid-response
- [ ] iOS Safari: audio plays correctly (separate AudioContext for capture, silence buffer trick applied)
- [ ] Session timeout (goAway): user sees a human-readable message, not a silent stop

### Quality Gates

- [ ] ESLint / TypeScript — no new type errors (add `GeminiServerMessage` interface, eliminate `Record<string, unknown>` casts in message handler)
- [ ] Manual smoke test across all 8 characters (only Einstein shows different behavior)
- [ ] Manual smoke test on iOS Safari (AudioContext session category, silence trick, speaker routing)
- [ ] Set Google Cloud billing cap before deploying to production

---

## Dependencies & Risks

| Item | Detail | Mitigation |
|---|---|---|
| Gemini ephemeral token API | `POST /v1beta/ephemeralApiKeys` returns 404 with AI Studio keys — requires service account credentials | Current workaround: pass raw API key from server; set billing cap immediately |
| API key exposure | Raw key visible in browser DevTools, WebSocket URL, potentially server logs | Billing cap; rate limit token endpoint; explicit tradeoff documented; not merged to main until acknowledged |
| `gemini-3.1-flash-live-preview` endpoint | Must use v1beta endpoint (not v1alpha) | Verified working — v1alpha was a debugging mistake, reverted |
| Setup message format | `outputAudioTranscription` at top level; `speechConfig` inside `generationConfig`; `voiceName` (not `voiceId`) | Verified against BidiGenerateContentSetup proto; confirmed in implementation |
| Session duration limit | Gemini Live sessions expire (~15 min); goAway message sent as warning | Handle goAway in `onmessage`; show reconnect prompt |
| iOS AudioContext speaker routing | Creating AudioContext after getUserMedia routes everything to speakerphone on iOS | Create AudioContext BEFORE getUserMedia |
| iOS AudioContext interruption | Tab background → `ctx.state = 'interrupted'` | `visibilitychange` handler calls `ctx.resume()` |
| Smallest.ai API key in test file | `test-tts.js` has a hardcoded live key — should be rotated and moved to .env | Rotate immediately; add to .gitignore |
| `ttsGenerationRef` not yet implemented | TTS QoL plan still active; generation counter pattern is Gemini Live-only for now | Independent; `geminiLiveGenerationRef` covers the Live path |
| AudioWorklet message rate | 128-sample quanta = 125 sends/sec — high allocation pressure | Accumulate to 100ms (1600 samples) in worklet before posting; pre-build JSON envelope |

---

## Files to Change

| File | Change |
|---|---|
| `server/index.js` | `/api/gemini-live-token` endpoint with `aiLimiter` — currently returns raw API key |
| `public/audio-processor.worklet.js` | **NEW** — AudioWorklet PCM processor (128-sample → optionally 1600-sample accumulator) |
| `src/lib/geminiLive.types.ts` | **NEW** — GeminiServerMessage interface hierarchy |
| `src/App.tsx` | Session manager functions, refs, visibilitychange handler, character switch cleanup, corrected setup message, audioStreamEnd on stop |

---

## Success Metrics

- Subjective latency: response feels "immediate" vs. current noticeable pause
- First-byte latency: ≤500ms from VAD detecting speech end to first audio output
- Zero regressions: all other 7 characters work as before
- Billing: no unexpected Gemini API charges from key exposure (confirmed by billing alerts)

---

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-03-30-gemini-live-speech-to-speech-requirements.md](docs/brainstorms/2026-03-30-gemini-live-speech-to-speech-requirements.md)

### Internal References

- `streamActiveRef` atomic pattern: [src/App.tsx:94](src/App.tsx#L94)
- Synchronous ref pattern (named for Gemini Live): [docs/solutions/patterns/critical-patterns.md](docs/solutions/patterns/critical-patterns.md)
- Vercel WebSocket constraint: [docs/solutions/integration-issues/vercel-cannot-proxy-websocket-GeminiLive-20260331.md](docs/solutions/integration-issues/vercel-cannot-proxy-websocket-GeminiLive-20260331.md)
- API key exposure pattern: [docs/solutions/security-issues/raw-api-key-browser-exposure-OdysseyIntegration-20260331.md](docs/solutions/security-issues/raw-api-key-browser-exposure-OdysseyIntegration-20260331.md)
- Stream-hang incident: [docs/solutions/integration-issues/stream-never-starts-odyssey-switching-20260327.md](docs/solutions/integration-issues/stream-never-starts-odyssey-switching-20260327.md)
- TTS QoL plan: [docs/plans/2026-03-28-001-feat-tts-qol-improvements-plan.md](docs/plans/2026-03-28-001-feat-tts-qol-improvements-plan.md)

### External References

- [Gemini Live API WebSocket get-started — Google AI](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket)
- [Gemini Live API reference: BidiGenerateContentSetup — Google AI](https://ai.google.dev/api/live#BidiGenerateContentSetup)
- [Gemini Live API capabilities (VAD, audioStreamEnd, goAway) — Google AI](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
- [Gemini Live API ephemeral tokens — Google AI](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens)
- [Vercel Functions WebSocket KB — Vercel](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections)
- [Audio worklet design pattern — Chrome Developers](https://developer.chrome.com/blog/audio-worklet-design-pattern)
- [AudioContext interrupted state — WebKit bug tracker](https://bugs.webkit.org/show_bug.cgi?id=221334)
- [MDN: AudioWorkletNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode)
- [Gemini Live reference implementation — google-gemini/live-api-web-console](https://github.com/google-gemini/live-api-web-console)
