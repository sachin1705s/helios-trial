---
module: Odyssey Streaming
date: 2026-04-06
problem_type: integration_issue
component: frontend_react
symptoms:
  - "Stream connects (MediaStream active) but character never animates"
  - "Console shows 'calling startStream' BEFORE 'onConnected' fires"
  - "onStreamStarted never fires — streamState stays 'starting' indefinitely"
root_cause: async_timing
resolution_type: code_fix
severity: high
tags: [odyssey, react-useeffect, stale-closure, startstream-timing, connectionEpoch, data-channel-ready]
---

# Troubleshooting: Character Does Not Animate Despite Stream Connecting

## Problem

The stream connects (a live `MediaStream` is attached to the video element and `onConnected` fires), but the character never starts animating. `onStreamStarted` is never fired.

## Environment

- Module: Odyssey Streaming (`src/App.tsx`)
- Affected Component: startStream useEffect + `onConnected` callback
- Date: 2026-04-06

## Symptoms

- `[odyssey] onConnected — stream: MediaStream {active: true}` in the console
- Video element receives a stream and appears live, but character is frozen on static image
- `[odyssey] onStreamStarted` never appears
- `streamState` stays at `'starting'`
- Critical log ordering:
  ```
  [odyssey] status: connecting
  [odyssey] status: connected
  [odyssey] calling startStream — slide: <character> | prompt: ...
  [odyssey] onConnected — stream: MediaStream ...
  ```
  Note: `calling startStream` appears **before** `onConnected`.

## Root Cause

The startStream useEffect depends on `connectionStatus` plus slide-related values like `slide.id`, `slide.prompt`, and `slide.image`. When the user navigates to a character slide while `connectionStatus` is already `'connected'` (from a previous session or slide), the effect fires immediately — before `onConnected` fires for the current connection.

The SDK's `onConnected` callback is specifically designed to signal "the data channel is now open and ready to receive `startStream` commands." If `startStream` is sent before `onConnected`, the command arrives before the data channel is ready and is silently lost. The SDK never sends `onStreamStarted` because it never received the command.

### Why the existing `'connected'`-guard doesn't help

```tsx
// onConnected sets 'connected' — this was designed to gate the effect
setConnectionStatus('connected');
```

The design intention was: the effect only runs when `connectionStatus === 'connected'`, which is only set inside `onConnected`. But if `connectionStatus` is **already** `'connected'` from a previous slide/session, a dependency change like `slide.id` re-runs the effect immediately, bypassing the `onConnected` gate entirely.

### Why this is different from the 2026-03-27 endStream-hang bug

The 2026-03-27 incident was about `endStream()` being called on a dead connection (ref stale via useEffect). This bug is about `startStream()` being called before the data channel is open (effect fires due to stale `connectionStatus`). Same class of problem — React async state causing incorrect SDK call timing — different manifestation.

## What Didn't Work

**Attempted approach (considered):** Reset `connectionStatus` to `'disconnected'` or `'connecting'` when `onStatusChange('connecting')` fires.

```tsx
// Wouldn't work — the effect may have already been scheduled before
// onStatusChange fires. React batches state updates; the effect runs after
// the commit phase, not synchronously when setState is called.
onStatusChange: (status) => {
  setConnectionStatus(status); // even removing the 'connected' guard doesn't help
},
```

This doesn't reliably prevent the race because the effect could be scheduled in the same render batch in which `connectionStatus` is still `'connected'`.

## First Fix Attempt (Incomplete)

`connectionEpoch` was added to the dependency array and bumped inside `onConnected`. This ensures a **retry** after the data channel opens, but does not prevent the **premature** `startStream` call from run 1.

### Why it was still broken

When a slide dependency changes while `connectionStatus` is already `'connected'`, run 1 fires immediately. If the slide image is cached, `loadImageFile` returns synchronously — run 1 passes the `requestId` check and calls `startStream` before `onConnected` fires. Then `onConnected` bumps `connectionEpoch`, run 2 starts, increments `requestIdRef.current` to 2, and also calls `startStream`. Two concurrent `startStream` calls → same double-startStream hang from the 2026-03-27 incident.

## Solution (Complete — Two Parts)

### Part 1: `connectionEpoch` — guarantees retry after data channel opens

```tsx
const [connectionEpoch, setConnectionEpoch] = useState(0);

onConnected: (stream) => {
  dataChannelReadyRef.current = true;
  setConnectionStatus('connected');
  setConnectionEpoch((e) => e + 1); // forces effect re-run after data channel opens
},

}, [connectionStatus, connectionEpoch, showLanding, selectedCharacterId, slide.id, slide.image, slide.prompt, isUploadSlide]);
```

### Part 2: `dataChannelReadyRef` — blocks premature `startStream` in run 1

```tsx
const dataChannelReadyRef = useRef(false); // true only after onConnected fires

onStatusChange: (status) => {
  if (status !== 'connected') {
    setConnectionStatus(status);
    dataChannelReadyRef.current = false; // reset when reconnecting
  }
},

onConnected: (stream) => {
  dataChannelReadyRef.current = true; // data channel confirmed open
  setConnectionStatus('connected');
  setConnectionEpoch((e) => e + 1);
},

// In run(), right before startStream:
if (!dataChannelReadyRef.current) {
  debug('[odyssey] data channel not ready — skipping startStream, awaiting onConnected');
  return; // connectionEpoch bump from onConnected will re-run this effect
}
if (requestIdRef.current !== requestId) return;
await service.startStream(streamOptions);
```

## Why the Complete Fix Works

1. Run 1 fires early (slide dependency changed while `connectionStatus` was stale-connected).
2. `dataChannelReadyRef.current` is `false` (set by `onStatusChange('connecting')`) → run 1 returns early without calling `startStream`.
3. `onConnected` fires → `dataChannelReadyRef.current = true` → `connectionEpoch` bumps.
4. Effect re-runs as run 2 → data channel confirmed ready → `startStream` called exactly once.

`dataChannelReadyRef` follows critical-patterns.md #3: written synchronously inside SDK callbacks, never synced via `useEffect`.

## Prevention

- **Two defenses are required, not one.** `connectionEpoch` alone only guarantees a retry — it doesn't block the premature call. `dataChannelReadyRef` alone blocks the premature call — but without `connectionEpoch`, the retry might never fire if `connectionStatus` was already `'connected'`. Both are needed.
- **Log call ordering.** The key diagnostic signal is `calling startStream` appearing **before** `onConnected`. Any future regression will have this same signature.
- **Follow critical-patterns.md #3 for `dataChannelReadyRef`.** Write it directly and synchronously inside the SDK callbacks that own the transition. Never sync it via `useEffect`.

## Related Issues

- `docs/solutions/integration-issues/stream-never-starts-odyssey-switching-20260327.md` — endStream hanging on dead connection; same class (React async timing vs. SDK callbacks), different manifestation
