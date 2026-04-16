---
name: closeActiveCharacter('page_exit') fires on every character switch, corrupting analytics
description: useEffect cleanup with selectedCharacterId dependency calls page_exit on each switch instead of on actual page unload
type: p1
status: pending
issue_id: "003"
tags: [correctness, analytics, code-review]
---

## Problem Statement

The `beforeunload` useEffect has `selectedCharacterId` in its dependency array:

```tsx
useEffect(() => {
  const handleBeforeUnload = () => {
    closeActiveCharacter('page_exit');
    releaseOdysseyLease();
  };
  window.addEventListener('beforeunload', handleBeforeUnload);
  return () => {
    window.removeEventListener('beforeunload', handleBeforeUnload);
    closeActiveCharacter('page_exit');   // ← fires on EVERY character switch
    releaseOdysseyLease();               // ← leaks Odyssey lease after first switch
  };
}, [selectedCharacterId]);
```

React runs the cleanup function every time the dependency changes. Switching from character A to B runs the cleanup with `reason: 'page_exit'`, not `'switch'`. `handleSelectCharacter` already calls `closeActiveCharacter('switch')` correctly — but `characterOpenedAtRef.current` is nulled there, so the cleanup's `closeActiveCharacter` call becomes a no-op (guarded by `characterOpenedAtRef.current === null`). However `releaseOdysseyLease()` in the same cleanup fires every switch, sending a beacon and nulling the leaseId — so the Odyssey lease is silently released on the first character switch and never re-acquired.

## Findings

- `src/App.tsx` — the `beforeunload` useEffect
- `releaseOdysseyLease` is called on every character switch, not just page exit
- After the first switch, the leaseId is null and subsequent characters don't release their leases

## Proposed Solutions

### Option A: Remove selectedCharacterId from dependency array
```tsx
useEffect(() => {
  const handleBeforeUnload = () => {
    closeActiveCharacter('page_exit');
    releaseOdysseyLease();
  };
  window.addEventListener('beforeunload', handleBeforeUnload);
  return () => {
    window.removeEventListener('beforeunload', handleBeforeUnload);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []); // mount/unmount only
```
Move `releaseOdysseyLease` + `closeActiveCharacter('page_exit')` into the `handleBeforeUnload` handler only.  
**Pros:** Matches intent exactly  
**Cons:** The cleanup no longer fires closeActiveCharacter on component unmount — but this is a root component so it only unmounts on page close anyway

### Option B: Use a ref for closeActiveCharacter
Wrap in a ref so the handler always has the latest character without re-registering the effect.

## Recommended Action

Option A — remove `selectedCharacterId` from dependency and put all cleanup logic inside the `beforeunload` handler.

## Acceptance Criteria

- [ ] Switching characters does NOT log a `character_closed` event with `reason: 'page_exit'`
- [ ] `releaseOdysseyLease` is NOT called when switching characters
- [ ] Page close (beforeunload) still logs `character_closed` with `reason: 'page_exit'`
