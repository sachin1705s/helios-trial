---
title: Odyssey startStream feedback loop — connectionEpoch causes double-startStream on reconnect
date: 2026-04-09
category: integration-issues
tags:
  - odyssey-sdk
  - streaming
  - timing
  - react-effects
  - race-condition
components:
  - src/App.tsx
problem_type: integration-issues
symptoms:
  - startStream called twice in quick succession on character switch
  - Stream hangs or never starts after the second call
  - Console shows two "[odyssey] calling startStream" logs for the same slide
  - onConnected fires, then startStream triggers a reconnect, then onConnected fires again → loop
---

# Odyssey `startStream` feedback loop — `connectionEpoch` causes double-`startStream` on reconnect

## Symptom

After switching characters (or on initial load), `startStream` is called, but then the SDK internally
reconnects, `onConnected` fires again, and a *second* `startStream` is triggered. This can deadlock
the stream or cause a hard hang. The console shows:

```
[odyssey] onConnected — stream: ...
[odyssey] calling startStream — slide: characters-luna | prompt: ...
[odyssey] onConnected — stream: ...        ← second fire
[odyssey] calling startStream — slide: characters-luna | prompt: ...   ← second call, races the first
```

## Root Cause

The `connectionEpoch` pattern was introduced to handle a timing edge case: the startStream `useEffect`
could fire while the data channel was not yet open (before `onConnected`). The fix bumped an integer
state on every `onConnected`, so the effect would re-run and retry.

The problem: `startStream` itself causes the SDK to briefly reconnect, which fires `onConnected`
again. `onConnected` bumped `connectionEpoch`, which re-ran the effect, which called `startStream`
again — creating a feedback loop on every single stream start.

```ts
// The problematic pattern (removed):
const [connectionEpoch, setConnectionEpoch] = useState(0);

// In onConnected:
setConnectionEpoch((e) => e + 1);   // ← re-triggers the useEffect

// In useEffect:
}, [connectionStatus, connectionEpoch, ...]);  // ← connectionEpoch in deps = re-runs on every onConnected
```

A second related bug: `retryStreamRef` was set **before** `startStream` resolved. If `onStreamEnded`
fired while the initial `startStream` was still in-flight, `retryStreamRef.current()` would start a
concurrent second call — a race between two in-flight `startStream` promises.

## Solution

### 1. Replace `connectionEpoch` with `pendingStartRef`

Instead of bumping state to re-run the effect, store the `startStream` function in a ref when the data
channel isn't ready yet. `onConnected` calls it directly — no React re-render, no effect re-run, no
feedback loop.

```ts
// In App.tsx — replace connectionEpoch state with pendingStartRef
const pendingStartRef = useRef<(() => Promise<void>) | null>(null);

// In onConnected callback:
dataChannelReadyRef.current = true;
setConnectionStatus('connected');
const pending = pendingStartRef.current;
if (pending) {
  pendingStartRef.current = null;
  pending().catch(() => undefined);
}

// In the startStream useEffect:
if (!dataChannelReadyRef.current) {
  console.log('[odyssey] data channel not ready — queuing startStream for onConnected');
  pendingStartRef.current = async () => {
    if (requestIdRef.current !== requestId) return;
    await service.startStream(streamOptions);
    if (requestIdRef.current === requestId) {
      retryStreamRef.current = () => service.startStream(streamOptions).then(() => undefined);
    }
  };
  return;
}
pendingStartRef.current = null;

// Remove connectionEpoch from the dependency array:
}, [connectionStatus, showLanding, selectedCharacterId, slide.id, slide.image, slide.prompt, isUploadSlide]);
//  ^ connectionEpoch removed
```

### 2. Set `retryStreamRef` AFTER `startStream` resolves

```ts
// Before (race-prone):
retryStreamRef.current = () => service.startStream(streamOptions).then(() => undefined);
await service.startStream(streamOptions);

// After (safe):
await service.startStream(streamOptions);
if (requestIdRef.current === requestId) {
  retryStreamRef.current = () => service.startStream(streamOptions).then(() => undefined);
}
```

This ensures `retryStreamRef` is only armed after the initial call finishes, so `onStreamEnded`
cannot race a concurrent in-flight call.

## Why This Branch Was Superseded

This branch (`hotfix/odyssey-startstream-timing`) implemented the approach above, but it was discovered
during testing that `startStream` was still hanging. Root cause shifted to `connectWithCredentials`
not propagating the `image_to_video` capability (see `odyssey-sdk-session-capabilities-dropped.md`).

The timing fixes in this branch were cleaned up and re-landed in `hotfix/pending-start-retry` (PR #6)
with improved commit messages, after the capability bug was isolated and fixed separately. The code
changes are functionally identical.

## Related

- `docs/solutions/integration-issues/odyssey-sdk-session-capabilities-dropped.md` — The capability bug
  that was the actual root cause of the hang; discovered after the timing fixes were already in place
- `hotfix/pending-start-retry` (PR #6) — The branch where these timing fixes landed cleanly
- `src/App.tsx` — Implementation lives here; search for `pendingStartRef`
