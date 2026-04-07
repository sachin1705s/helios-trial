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

## Solution

Add a `connectionEpoch` counter that increments **only inside `onConnected`** (i.e., only when the data channel is confirmed ready). Add it to the startStream useEffect's dependency array.

This guarantees that every time the data channel opens, the effect re-runs with a fresh `requestId`. The existing `requestId` guard automatically cancels any premature run.

```tsx
// 1. Add state
const [connectionEpoch, setConnectionEpoch] = useState(0);

// 2. Bump it inside onConnected (data channel confirmed ready)
onConnected: (stream) => {
  setConnectionStatus('connected');
  setConnectionEpoch((e) => e + 1); // ← forces effect re-run after data channel opens
  // ...attach stream to video...
},

// 3. Add to dependency array
}, [connectionStatus, connectionEpoch, showLanding, selectedCharacterId, slide.id, slide.image, slide.prompt, isUploadSlide]);
```

## Why This Works

1. `connectionEpoch` can only change inside `onConnected`. This makes it a reliable signal that the data channel is open and `startStream` is safe to call.
2. When a slide dependency changes (e.g., `slide.id`) while `connectionStatus` is already `'connected'`, the effect fires early. `requestId` increments to, say, 2.
3. `onConnected` fires later → `connectionEpoch` bumps → effect runs again with `requestId = 3`. The new run calls `endStream` (if needed) then `startStream`.
4. The premature run with `requestId = 2` is abandoned: `requestIdRef.current (3) !== requestId (2)` → returns early without calling `startStream`.

## Prevention

- **Never rely solely on `connectionStatus === 'connected'` to gate `startStream`.** `connectionStatus` may carry over from a previous session and be stale by the time the effect runs. Use a purpose-built counter (`connectionEpoch`) that is incremented exclusively inside `onConnected` to represent "data channel is now ready."
- **Log call ordering.** The key diagnostic signal here was that `calling startStream` appeared **before** `onConnected` in the console. Any future regression will have the same signature — watch for it.
- **The `requestId` guard is your safety net, not your primary defense.** It correctly cancels stale runs, but only after the damage (a premature `startStream`) has already been done. The primary defense is ensuring the effect only fires when the data channel is actually ready.

## Related Issues

- `docs/solutions/integration-issues/stream-never-starts-odyssey-switching-20260327.md` — endStream hanging on dead connection; same class (React async timing vs. SDK callbacks), different manifestation
