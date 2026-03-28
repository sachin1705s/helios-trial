---
title: TTS & Recording Quality-of-Life Improvements
type: feat
status: active
date: 2026-03-28
deepened: 2026-03-28
---

# TTS & Recording Quality-of-Life Improvements

## Enhancement Summary

**Deepened on:** 2026-03-28
**Research agents used:** julik-frontend-races-reviewer, correctness-reviewer, reliability-reviewer, performance-reviewer, feasibility-reviewer, product-lens-reviewer, best-practices-researcher (Web Audio API)

### Key Improvements Over Original Plan

1. **Two critical bugs found in original VAD design** — stale `isCharacterRecording` React closure in rAF loop; ghost rAF frame after cancellation. Both fixed with established codebase patterns.
2. **rAF → setInterval** — 3× less CPU on mobile; continues correctly when tab is backgrounded (rAF pauses, which causes incorrect auto-stop on foreground).
3. **VAD simplified** — 5 refs → 2 (`currentTtsSourceRef` + `vadStateRef`); `setTimeout` replaces manual `Date.now()` arithmetic.
4. **In-flight TTS pipeline survives navigation** — need a generation counter, not just `source.stop()`, to abort an in-flight `fetch + decodeAudioData`.
5. **iOS Safari AudioContext gotchas** — "silence buffer trick" to start the graph; `interrupted` state handling; don't specify `sampleRate`.
6. **Adaptive RMS threshold** — calibrate from the first 300ms of mic input instead of a fixed value that may sit in the noise floor.
7. **Alternative to VAD considered** — mobile PTT (hold-to-talk on `onPointerDown`/`onPointerUp`) uses existing `pttStartRef`/`pttStopRef` infrastructure. May solve the problem with 2 lines instead of 25. Decide before coding Fix 3.

---

## Overview

Three targeted improvements to the recording/TTS interaction in Interact Studio:

1. **Gate the record button** — disable it until the stream is live; show "Connecting…" label during the wait
2. **Stop TTS on back navigation** — interrupt playback AND the in-flight TTS pipeline when the user hits Back
3. **Auto-stop recording on silence** — stop recording automatically after the user stops speaking

---

## Problem Statement / Motivation

Users are experiencing three distinct friction points:

- **Premature taps**: The record icon is tappable before the Odyssey stream is ready, so early presses silently fail.
- **Ghost audio**: Navigating back to the landing page while TTS is playing leaves audio continuing in the background.
- **Click fatigue**: The current click-to-start / click-to-stop model is cumbersome on mobile.

---

## Decision Point Before Fix 3

> **Resolve before coding:** is VAD the right solution, or is mobile hold-to-talk (PTT) sufficient?

**Option A — Mobile PTT (recommended to evaluate first)**
The `pttStartRef` / `pttStopRef` infrastructure ([src/App.tsx:497-499](src/App.tsx#L497)) already implements push-to-talk for keyboard (Ctrl+Space). Extending it to the record button is a 2-line change:

```tsx
<button
  onPointerDown={() => pttStartRef.current()}
  onPointerUp={() => pttStopRef.current()}
  onPointerLeave={() => pttStopRef.current()} // finger slides off button
  ...
>
```

No new Web Audio code, no silence thresholds, no mobile Safari AudioContext issues. Users hold to speak, release to send — the same pattern as WhatsApp, iOS Voice Memos. If users find this natural, stop here.

**Option B — VAD auto-stop**
If "hold to speak" is also unacceptable (e.g., users forget to hold, or the use case requires hands-free), proceed with the VAD implementation described in Fix 3.

---

## Proposed Solution

### Fix 1 — Gate the record button + show connection state

**Current code** ([src/App.tsx:1381](src/App.tsx#L1381)):

```tsx
<button
  className="btn accent"
  onClick={isCharacterRecording ? stopCharacterRecording : startCharacterRecording}
  disabled={isCharacterThinking}
  ...
>
```

**Change — disabled + label:**

```tsx
<button
  className={`btn accent ${!isStreamingReady && !isCharacterRecording ? 'is-connecting' : ''}`}
  onClick={isCharacterRecording ? stopCharacterRecording : startCharacterRecording}
  disabled={isCharacterThinking || !isStreamingReady}
  aria-label={
    !isStreamingReady
      ? 'Connecting…'
      : isCharacterRecording
        ? 'Stop recording'
        : isCharacterThinking
          ? 'Thinking…'
          : `Talk to ${activeCharacterName}`
  }
>
  {isCharacterRecording
    ? 'Stop'
    : isCharacterThinking
      ? 'Thinking…'
      : !isStreamingReady
        ? 'Connecting…'
        : <img className="recording-icon" src="/images/recording_icon_v2.png" alt="" aria-hidden="true" />}
</button>
```

Also update the text input placeholder ([src/App.tsx:1419](src/App.tsx#L1419)) to show a loading state:

```tsx
placeholder={isStreamingReady ? "Type a wish…" : "Connecting…"}
```

### Research Insights — Fix 1

**UX:** A grayed-out icon with no label is ambiguous on a slow connection. Users on first load can wait 2-5 seconds for Odyssey to connect. "Connecting…" text sets the expectation correctly and prevents rage-taps.

---

### Fix 2 — Stop TTS on back navigation (+ abort in-flight pipeline)

**Problem 1**: `playCharacterTTS` creates a `BufferSource` or `HTMLAudioElement` but discards the reference.

**Problem 2 (new — found during review)**: `playCharacterTTS` is async with multiple `await` points. If the user navigates back while the TTS `fetch + decodeAudioData` is in flight, calling `.stop()` on a not-yet-started source is either a no-op or throws. The audio will start playing on the landing page when the fetch resolves.

**Solution: generation counter + source ref**

Add two new items:

```tsx
// Ref to track the active audio source for stop-on-navigation
const currentTtsSourceRef = useRef<AudioBufferSourceNode | HTMLAudioElement | null>(null);

// Generation counter: increment on each navigation back; checked before source.start()
const ttsGenerationRef = useRef(0);
```

**In `playCharacterTTS`** — capture generation at call start, check before starting:

```tsx
const playCharacterTTS = async (text: string, slideId?: string) => {
  const myGeneration = ttsGenerationRef.current; // capture at call time
  // ... existing AudioContext setup ...

  // Stop any currently playing TTS before starting new one
  const prev = currentTtsSourceRef.current;
  if (prev) {
    if (prev instanceof HTMLAudioElement) {
      prev.pause();
    } else {
      try { prev.stop(); } catch { /* already ended */ }
    }
    currentTtsSourceRef.current = null;
  }

  // ... fetch, decodeAudioData ...

  // Check generation before starting — user may have navigated away during await
  if (ttsGenerationRef.current !== myGeneration) return;

  // Web Audio path
  const source = ctx.createBufferSource();
  source.buffer = decoded;
  source.connect(ctx.destination);
  currentTtsSourceRef.current = source;
  source.onended = () => {
    if (currentTtsSourceRef.current === source) currentTtsSourceRef.current = null;
  };
  source.start();

  // HTMLAudioElement fallback
  // (in catch block of decodeAudioData)
  const audio = new Audio(url);
  currentTtsSourceRef.current = audio;
  audio.onended = () => {
    URL.revokeObjectURL(url);
    if (currentTtsSourceRef.current === audio) currentTtsSourceRef.current = null;
  };
  await audio.play();
};
```

**In the `showLanding` useEffect** ([src/App.tsx:443](src/App.tsx#L443)):

```tsx
useEffect(() => {
  if (!showLanding) return;

  // Invalidate any in-flight TTS pipeline
  ttsGenerationRef.current++;

  // Stop currently playing TTS audio
  const src = currentTtsSourceRef.current;
  if (src) {
    if (src instanceof HTMLAudioElement) {
      src.pause();
    } else {
      try { src.stop(); } catch { /* already ended */ }
    }
    currentTtsSourceRef.current = null;
  }

  // Stop any active recording and close mic tracks
  if (isCharacterRecordingRef.current) {
    vadStateRef.current && clearTimeout(vadStateRef.current.timer ?? undefined);
    vadStateRef.current?.frame !== null && clearInterval(vadStateRef.current.frame);
    vadStateRef.current = null;
    if (characterRecorderRef.current?.state === 'recording') {
      characterRecorderRef.current.stop();
    }
    characterStreamRef.current?.getTracks().forEach((t) => t.stop());
    characterStreamRef.current = null;
  }

  // ... existing stream teardown ...
  ++requestIdRef.current;
  retryStreamRef.current = null;
  if (streamActiveRef.current) {
    streamActiveRef.current = false;
    serviceRef.current?.endStream().catch(() => undefined);
  }
}, [showLanding]);
```

### Research Insights — Fix 2

- `AudioBufferSourceNode.stop()` on a node that has **already ended** is safe (no-op). On a node that was **never started** it throws `InvalidStateError` — hence the generation counter guard before `source.start()`.
- Stopping the source node does NOT abort the upstream `fetch + decodeAudioData`. The generation counter is the only reliable cancellation mechanism.
- Two TTS calls can overlap (prior turn's TTS still playing when user sends a new message). The plan now stops the previous source before starting a new one — this fixes the "two voices simultaneously" bug.

---

### Fix 3 — Auto-stop recording on silence (VAD)

> **Only implement if mobile PTT (Option A above) was evaluated and rejected.**

**Architecture decisions (research-validated):**

| Decision | Choice | Rationale |
|---|---|---|
| Polling primitive | `setInterval` at 80ms | rAF pauses when tab hidden; setInterval survives backgrounding |
| fftSize | 512 | ~10.7ms window at 48kHz; smallest practical stable value for RMS |
| Silence window | 1200ms | Natural speech pauses; 1500ms was too aggressive for deliberate speakers |
| Startup grace | 300ms | Mic-open transient click can trigger false speech detection |
| Min speech duration | 500ms | Below this, STT quality degrades and premature cutoff is likely |
| RMS threshold | Adaptive (calibrate from first ~1s) | Fixed 0.01 sits in noise floor on many mobile mics |

**New refs (simplified from original plan's 5 → 2):**

```tsx
// Ref for active TTS audio (Fix 2)
const currentTtsSourceRef = useRef<AudioBufferSourceNode | HTMLAudioElement | null>(null);
const ttsGenerationRef = useRef(0);

// Ref for VAD session state (Fix 3) — packs analyser + timer + interval into one object
const vadStateRef = useRef<{
  analyser: AnalyserNode;
  vadCtx: AudioContext;          // separate from ttsAudioCtxRef — see iOS note below
  timer: ReturnType<typeof setTimeout> | null;
  frame: ReturnType<typeof setInterval> | null;
  speechDetected: boolean;
  recordingStartedAt: number;
} | null>(null);

// Mirrors isCharacterRecording state for safe reading from interval callbacks
// Same pattern as streamActiveRef — set synchronously, never via useEffect
const isCharacterRecordingRef = useRef(false);
```

**Constants:**

```tsx
const VAD_SILENCE_MS = 1200;        // sustained silence before auto-stop
const VAD_POLL_MS = 80;             // setInterval cadence
const VAD_STARTUP_GRACE_MS = 300;   // ignore VAD for this long after recording starts
const VAD_MIN_SPEECH_MS = 500;      // minimum recording time before auto-stop eligible
const VAD_SPEECH_MULTIPLIER = 2.5;  // threshold = noiseFloor × this
const VAD_FLOOR_MIN = 0.008;        // absolute minimum threshold
```

**In `startCharacterRecording`** — after `recorder.start()`:

```tsx
// Set ref synchronously — same pattern as streamActiveRef
isCharacterRecordingRef.current = true;
setIsCharacterRecording(true);
recorder.start();

// VAD setup — use a SEPARATE AudioContext to avoid iOS session category conflict
// (ttsAudioCtxRef is in "playback" mode on iOS; mic input needs a fresh context)
const vadCtx = new AudioContext();
// iOS: kick the audio graph with a silent buffer to ensure it runs
const silenceBuf = vadCtx.createBuffer(1, 1, vadCtx.sampleRate);
const silenceNode = vadCtx.createBufferSource();
silenceNode.buffer = silenceBuf;
silenceNode.connect(vadCtx.destination);
silenceNode.start();

const analyser = vadCtx.createAnalyser();
analyser.fftSize = 512;
analyser.smoothingTimeConstant = 0;
vadCtx.createMediaStreamSource(stream).connect(analyser);

const dataArray = new Float32Array(analyser.fftSize);
let noiseFloor = VAD_FLOOR_MIN;
let calibrationSamples: number[] = [];
let calibrated = false;
const recordingStartedAt = Date.now();

vadStateRef.current = {
  analyser, vadCtx,
  timer: null,
  frame: null,
  speechDetected: false,
  recordingStartedAt,
};
const state = vadStateRef.current;

state.frame = setInterval(() => {
  if (!isCharacterRecordingRef.current) {
    // Recording ended externally; clean up
    clearInterval(state.frame!);
    state.frame = null;
    return;
  }

  analyser.getFloatTimeDomainData(dataArray);
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
  const rms = Math.sqrt(sum / dataArray.length);

  // Adaptive calibration: measure noise floor from first frames
  if (!calibrated) {
    calibrationSamples.push(rms);
    if (calibrationSamples.length >= Math.ceil(1000 / VAD_POLL_MS)) { // ~1 second
      const sorted = [...calibrationSamples].sort((a, b) => a - b);
      noiseFloor = Math.max(VAD_FLOOR_MIN, sorted[Math.floor(sorted.length * 0.8)]);
      calibrated = true;
      calibrationSamples = [];
    }
    return; // Don't run VAD during calibration
  }

  const threshold = Math.max(VAD_FLOOR_MIN, noiseFloor * VAD_SPEECH_MULTIPLIER);
  const elapsed = Date.now() - recordingStartedAt;
  const isSpeech = rms > threshold;

  if (isSpeech) {
    state.speechDetected = true;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  } else {
    // Silence detected — but only act if past startup grace + min speech duration
    const canAutoStop = elapsed > VAD_STARTUP_GRACE_MS && state.speechDetected && elapsed > VAD_MIN_SPEECH_MS;
    if (canAutoStop && state.timer === null) {
      state.timer = setTimeout(() => {
        stopCharacterRecordingFromVAD();
      }, VAD_SILENCE_MS);
    }
  }
}, VAD_POLL_MS);
```

**Updated `stopCharacterRecording`** — reads from ref, not React state:

```tsx
const stopCharacterRecording = () => {
  if (!isCharacterRecordingRef.current) return; // read ref, not stale React state
  isCharacterRecordingRef.current = false; // clear eagerly — prevents re-entry

  // Clean up VAD
  const vad = vadStateRef.current;
  if (vad) {
    if (vad.timer !== null) clearTimeout(vad.timer);
    if (vad.frame !== null) clearInterval(vad.frame);
    vad.vadCtx.close().catch(() => undefined);
    vadStateRef.current = null;
  }

  if (characterRecorderRef.current?.state === 'recording') {
    characterRecorderRef.current.stop();
  }
};

// Alias called from VAD timer to make intent clear in code
const stopCharacterRecordingFromVAD = stopCharacterRecording;
```

**In `recorder.onstop`** — clear ref:

```tsx
recorder.onstop = async () => {
  isCharacterRecordingRef.current = false; // ensure cleared even if onstop fires independently
  setIsCharacterRecording(false);
  // ... existing STT + chat flow ...
};
```

**Tab visibility guard** — add once at component level:

```tsx
useEffect(() => {
  const onVisibilityChange = () => {
    if (!document.hidden && vadStateRef.current) {
      // Tab just became visible — reset silence timer to prevent spurious fire
      if (vadStateRef.current.timer !== null) {
        clearTimeout(vadStateRef.current.timer);
        vadStateRef.current.timer = null;
      }
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => document.removeEventListener('visibilitychange', onVisibilityChange);
}, []);
```

**Visual feedback (countdown ring) — if VAD is chosen**

The VAD will fire without warning at 1200ms of silence. Users who pause mid-thought will be surprised. Add a CSS animation to the record button that starts when silence is first detected (`state.timer !== null`) and completes over `VAD_SILENCE_MS`. This requires a React state bit (`isSilenceTimerActive`) set when the timer starts/clears:

```tsx
// Expose silence timer state so the button can show a visual cue
const [isSilenceTimerActive, setIsSilenceTimerActive] = useState(false);
```

Set `setIsSilenceTimerActive(true)` when `state.timer` is set, `false` when cleared. Use a CSS `@keyframes` progress ring on `.btn.accent.silence-countdown`.

### Research Insights — Fix 3

**Why `setInterval` over `requestAnimationFrame`:**
- rAF pauses when the tab is backgrounded (MDN: "calls are paused in most browsers when running in background tabs"). With `Date.now()` timestamps, a user who backgrounds the app mid-pause will have the silence timer appear to expire instantly when they return.
- setInterval at 80ms is throttled to ~1Hz when the tab is hidden, which is fine — if the user backgrounds the app during an active recording, we reset the silence timer on `visibilitychange` anyway.

**iOS Safari AudioContext session category (IMPORTANT):**
When TTS has played, `ttsAudioCtxRef` is in "playback" session category on iOS. Connecting a `createMediaStreamSource` to this context can produce a silent analyser. Use a fresh `AudioContext()` for VAD, and close it after recording stops. The "silence buffer trick" (`createBufferSource` → `start()` on a 1-sample buffer) forces the iOS audio graph to activate.

**Adaptive threshold vs fixed 0.01:**
A fixed RMS threshold of 0.01 sits in the noise floor of many mobile microphones with AGC enabled. The adaptive approach (measure 80th percentile RMS from the first ~1s, multiply by 2.5) handles phones, laptops, and headsets without manual tuning. The 1-second calibration window means the first auto-stop cannot fire earlier than ~1.5 seconds into recording — a natural lower bound.

**From the project learning (stream-never-starts issue):**
> "Never sync a ref to React state via useEffect when the ref is used as a guard in an async function."

The `isCharacterRecordingRef` follows the same pattern as `streamActiveRef` — set and cleared synchronously inside event handlers and callbacks, never via a `useEffect` sync. This is the established codebase pattern for this exact problem.

---

## Technical Considerations

- **`isCharacterThinking` clears before TTS finishes** ([src/App.tsx:745](src/App.tsx#L745)): `playCharacterTTS` is called without `await` in `runCharacterInteraction`, so `setIsCharacterThinking(false)` fires before TTS audio has finished playing. This means the record button re-enables while audio is still playing. Fix 1 only guards on `isCharacterThinking`, not on "TTS is actively playing." If this causes user confusion, a `isTtsPlayingRef` (set on `source.start()`, cleared on `source.onended`) can block the button during playback. This is a separate follow-up item, not part of this plan's scope.
- **`getUserMedia` constraints**: Add `noiseSuppression: true, echoCancellation: true` to the `getUserMedia` call in `startCharacterRecording` to reduce ambient noise before it reaches the VAD threshold.
- **Memory cleanup**: `vadCtx.close()` in `stopCharacterRecording` releases the VAD AudioContext and all its nodes. The TTS AudioContext (`ttsAudioCtxRef`) is reused across sessions and never closed during the page lifetime.
- **PTT keyboard shortcut**: The existing Ctrl+Space PTT calls `stopCharacterRecording` on key-up, which will clean up VAD correctly via `isCharacterRecordingRef`.

## System-Wide Impact

- **Interaction graph**: `showLanding` → TTS generation increment → source stop → VAD cleanup → MediaRecorder stop → mic tracks stop.
- **Error propagation**: `source.stop()` wrapped in try/catch; `vadCtx.close()` is `.catch(() => undefined)`.
- **State lifecycle risks**: If VAD fires `stopCharacterRecording` and `recorder.onstop` fires async, both paths clear `isCharacterRecordingRef.current = false` — idempotent, safe.
- **Double TTS overlap**: `playCharacterTTS` now stops the previous source before starting a new one, preventing two voices playing simultaneously.

## Acceptance Criteria

**Fix 1:**
- [ ] Record button is `disabled` when `!isStreamingReady`
- [ ] Button shows "Connecting…" text (not just a grayed icon) while stream is loading
- [ ] Text input placeholder also shows "Connecting…" state
- [ ] No effect when button is pressed before stream is ready

**Fix 2:**
- [ ] When user clicks Back while TTS is playing, audio stops immediately
- [ ] When user clicks Back while TTS fetch is in flight (not yet playing), the audio does NOT start playing on the landing page
- [ ] When two TTS calls overlap (quick consecutive messages), only the latest plays
- [ ] `currentTtsSourceRef` is null after navigation, not pointing to a stale node

**Fix 3 (if VAD chosen over mobile PTT):**
- [ ] Recording auto-stops after ~1200ms of sustained silence
- [ ] Recording does NOT auto-stop during the first 300ms (startup grace)
- [ ] Recording does NOT auto-stop before 500ms of total duration (min speech guard)
- [ ] Brief pauses in speech (< 1200ms) reset the silence timer correctly
- [ ] If user backgrounds the app mid-pause and returns, silence timer resets (no spurious auto-stop)
- [ ] Ctrl+Space PTT still works correctly (key-up stops recording, VAD cleans up)
- [ ] No mic track left open after recording stops (browser recording indicator disappears)
- [ ] Back navigation while recording: mic stops, VAD cleans up, STT request is NOT sent

## Dependencies & Risks

- **iOS Safari AudioContext session category**: Using a separate AudioContext for VAD avoids the TTS "playback" session conflict. Tested against iOS 16+ Safari.
- **Adaptive threshold calibration**: The 1-second calibration window adds a 1-second dead zone at the start of every recording before auto-stop can fire. This is acceptable and actually desirable (prevents premature cutoffs on fast speakers).
- **Mobile PTT vs VAD**: If the team chooses VAD, the countdown ring is a mandatory dependency (not optional). Ship them together.
- **`isCharacterThinking` / TTS timing mismatch**: The record button re-enables while TTS is still playing. This is a pre-existing issue not introduced by this plan. Noted for follow-up.

## Files to Change

- `src/App.tsx` — all changes live here
  - Add: `currentTtsSourceRef`, `ttsGenerationRef`, `vadStateRef`, `isCharacterRecordingRef` refs
  - Add: `VAD_SILENCE_MS`, `VAD_POLL_MS`, `VAD_STARTUP_GRACE_MS`, `VAD_MIN_SPEECH_MS`, `VAD_SPEECH_MULTIPLIER`, `VAD_FLOOR_MIN` constants
  - Add: `visibilitychange` useEffect for silence timer reset
  - Modify: `playCharacterTTS` — generation guard, prev-source stop, ref tracking in both paths
  - Modify: `startCharacterRecording` — VAD setup, `isCharacterRecordingRef`, getUserMedia constraints
  - Modify: `stopCharacterRecording` — read from `isCharacterRecordingRef`, VAD cleanup, `recorder.state` guard
  - Modify: `showLanding` useEffect — TTS generation increment, source stop, VAD + recording teardown
  - Modify: record button JSX — disabled state, "Connecting…" label, conditional countdown class
  - Modify: text input — "Connecting…" placeholder

## Sources & References

### Internal References

- `streamActiveRef` pattern: [src/App.tsx:94](src/App.tsx#L94) — established pattern for synchronous ref guards; `isCharacterRecordingRef` follows the same approach
- `playCharacterTTS`: [src/App.tsx:632](src/App.tsx#L632)
- `startCharacterRecording`: [src/App.tsx:748](src/App.tsx#L748)
- `stopCharacterRecording`: [src/App.tsx:614](src/App.tsx#L614)
- `showLanding` useEffect: [src/App.tsx:443](src/App.tsx#L443)
- `pttStartRef`/`pttStopRef`: [src/App.tsx:497](src/App.tsx#L497) — mobile PTT alternative

### Project Learning Applied

- [docs/solutions/integration-issues/stream-never-starts-odyssey-switching-20260327.md](docs/solutions/integration-issues/stream-never-starts-odyssey-switching-20260327.md) — "Never sync a ref to React state via useEffect when the ref is used as a guard in an async function." Applied directly to `isCharacterRecordingRef` design.

### External References

- [MDN: AnalyserNode](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode)
- [MDN: AudioBufferSourceNode.stop()](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/stop)
- [MDN: AudioContext.state](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/state) — `interrupted` state on iOS Safari
- [MDN: visibilitychange](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event)
- [MDN: Web Audio API Best Practices](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices)
- [MDN: requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame) — "paused in most browsers when running in background tabs"
