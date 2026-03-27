---
module: Odyssey Streaming
date: 2026-03-27
problem_type: integration_issue
component: frontend_stimulus
symptoms:
  - "Second character's stream never starts after switching — page shows static image forever"
  - "endStream() promise hangs indefinitely with no rejection or resolution"
  - "Console shows '[run] endStream start' with no matching 'endStream done' log"
root_cause: async_timing
resolution_type: code_fix
severity: high
tags: [odyssey, react-useeffect, stream-switching, async-timing, endstream-hang]
---

# Troubleshooting: Odyssey Stream Never Starts When Switching Characters

## Problem

After a character's stream ends naturally (via `onStreamEnded`), switching to a new character would cause the app to hang permanently — `endStream()` was called on a dead connection and its promise never resolved, so `startStream()` for the new character was never reached.

## Environment

- Module: Odyssey Streaming (`src/App.tsx`)
- Affected Component: React stream management effect + Odyssey SDK (`@odysseyml/odyssey`)
- Date: 2026-03-27

## Symptoms

- Switching characters after a natural stream end results in a static image with no animation
- `[run] endStream start — slide: <character>` appears in the console but `[run] endStream done` never follows
- `onStreamStarted` is never fired for the new character
- The app is stuck in `streamState: 'starting'` indefinitely

## What Didn't Work

**Attempted Solution 1:** `requestId` guard inside the `retryStreamRef` closure

```tsx
retryStreamRef.current = () => {
  if (requestIdRef.current !== myRequestId) return Promise.resolve(); // ← guard added here
  return service.startStream(streamOptions).then(() => undefined);
};
```

- **Why it failed:** The `onStreamEnded` callback calls `retryStreamRef.current()` to auto-restart the stream. With the guard, the retry was silently blocked — but in some cases `startStream()` via the retry is the *only* trigger Odyssey has to proceed after a stream end. This prevented the second character from ever starting.

**Attempted Solution 2:** Load image before `endStream` so `onStreamEnded` retry has correct options

```tsx
// Load image first, update retryStreamRef, THEN call endStream
const file = await loadImageFile(slide.image, ...);
retryStreamRef.current = () => service.startStream({ image: file, ...});
await service.endStream();        // onStreamEnded fires → calls retryStreamRef
await service.startStream(...);   // also called from run() → double startStream
```

- **Why it failed:** Both `onStreamEnded` (via the closure) and `run()` itself called `startStream()` concurrently. Odyssey received two simultaneous `startStream` calls and couldn't reconcile them — stream never started.

**Attempted Solution 3:** `hadActiveStream = isStreamingReadyRef.current` synced via `useEffect`

```tsx
// Sync effect
useEffect(() => {
  isStreamingReadyRef.current = isStreamingReady;
}, [isStreamingReady]);

// In run()
const hadActiveStream = isStreamingReadyRef.current;
if (hadActiveStream) await service.endStream();
```

- **Why it failed:** `useEffect` runs *after* React commits to the DOM — it is asynchronous. When `onStreamEnded` fired and set `setIsStreamingReady(false)`, React queued a re-render. If the user switched characters before that render completed, the stream management effect's `run()` executed while `isStreamingReadyRef.current` still held the old `true` value. The guard fired incorrectly, calling `endStream()` on a connection with no active stream → Odyssey's internal `streamEndResolver` was set but never resolved → infinite hang.

## Solution

Replace the `useEffect`-synced ref with a dedicated `streamActiveRef` that is set **synchronously and directly** inside the Odyssey callbacks — no React cycle involved.

**Code changes:**

```tsx
// 1. Declare the ref
const streamActiveRef = useRef(false); // Set directly in Odyssey callbacks — no React cycle

// 2. Set true when stream actually starts
onStreamStarted: () => {
  streamActiveRef.current = true;   // ← direct, synchronous
  setStreamState('streaming');
  setIsStreamingReady(true);
  // ...
},

// 3. Set false in every path where the stream stops
onStreamEnded: () => {
  streamActiveRef.current = false;  // ← direct, synchronous
  setStreamState('ended');
  setIsStreamingReady(false);
  // ...
},
onStreamError: (reason, message) => {
  streamActiveRef.current = false;
  // ...
},
onError: (err) => {
  streamActiveRef.current = false;
  // ...
},

// 4. In run(): read and immediately clear (atomic read-and-clear)
const run = async () => {
  retryStreamRef.current = null;

  // Read and clear atomically — no useEffect lag, accurate at the moment of the call
  const hadActiveStream = streamActiveRef.current;
  streamActiveRef.current = false;

  if (hadActiveStream) {
    await service.endStream().catch(() => undefined);
  }
  // ... load image, startStream
};

// 5. Landing page effect uses same ref
useEffect(() => {
  if (!showLanding) return;
  ++requestIdRef.current;
  retryStreamRef.current = null;
  if (streamActiveRef.current) {
    streamActiveRef.current = false;
    serviceRef.current?.endStream().catch(() => undefined);
  }
}, [showLanding]);
```

## Why This Works

1. **Root cause:** `useEffect` is asynchronous — it runs after React's commit phase, not immediately when `setIsStreamingReady(false)` is called. Between calling `setIsStreamingReady(false)` (in `onStreamEnded`) and the effect that syncs the ref, there is a window where `isStreamingReadyRef.current` still reads `true`. If `run()` for the next character executes in that window, it sees stale data and calls `endStream()` on a dead connection.

2. **Why `endStream()` hangs:** The Odyssey SDK implements `endStream()` via an internal `streamEndResolver` promise that resolves when the server acknowledges the stream-end message. With no active stream, that acknowledgment never comes → the promise never resolves → `run()` hangs forever before reaching `startStream()`.

3. **Why the fix works:** `streamActiveRef` is written to inside the Odyssey callbacks themselves (synchronous JS, same microtask). By the time any React effect can possibly execute, the Odyssey callbacks have already set the correct value. Reading `streamActiveRef.current` in `run()` always reflects real stream state at that exact moment. The "atomic read-and-clear" (`const had = ref.current; ref.current = false`) prevents any concurrent path from seeing a stale `true`.

## Prevention

- **Never sync a ref to React state via `useEffect` when the ref is used as a guard in an async function.** If the async function can run before the effect flushes, it will read stale data. Instead, set the ref directly wherever the underlying value changes.
- **`endStream()` must only be called when a stream is provably active.** The Odyssey SDK hangs indefinitely if `endStream()` is called with no active stream — there is no timeout or rejection. The guard (`hadActiveStream`) is therefore load-bearing.
- **Add console logs with an explicit "done" counterpart to every async SDK call** (e.g., `endStream start` / `endStream done`). A missing "done" log immediately identifies a hung promise without needing a debugger.

## Related Issues

No related issues documented yet.
