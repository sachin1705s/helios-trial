---
name: isUploadSlide = false and isCharacterSlide = true are hardcoded dead-code branches
description: Both constants are literal booleans that never change, making all upload-slide code unreachable and all isCharacterSlide guards vacuously true
type: p2
status: pending
issue_id: "010"
tags: [maintainability, dead-code, code-review]
---

## Problem Statement

```tsx
const isUploadSlide = false;    // never changes
const isCharacterSlide = true;  // never changes
```

These appear in ~12 places including useEffect dependency arrays and render branches. Every `isUploadSlide` branch is permanently dead code. Every `isCharacterSlide` guard is unconditionally true. A developer reading the Odyssey connection effect must track these constants to understand why certain branches never execute.

## Proposed Solutions

### Option A: Delete both constants and their branches
- Delete `isUploadSlide` and all code guarded by it (upload slide feature is removed)
- Inline `true` everywhere `isCharacterSlide` is used, then simplify the conditions
- Remove the false branches from `isCharacterSlide` guards

## Recommended Action

Option A. Pair with 009 (strategy cleanup) as a single "App.tsx dead code" cleanup commit.

## Acceptance Criteria

- [ ] `isUploadSlide` and `isCharacterSlide` removed from App.tsx
- [ ] Upload slide code path deleted
- [ ] `isCharacterSlide` conditions simplified to their true-branch
- [ ] No behavior change
