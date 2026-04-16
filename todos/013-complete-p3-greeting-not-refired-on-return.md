---
name: Greeting never re-fires when returning to a character after going to landing
description: greetedCharactersRef is session-persistent but chat state is cleared on landing, leaving a blank UI with no greeting on return
type: p3
status: pending
issue_id: "013"
tags: [correctness, ux, code-review]
---

## Problem Statement

When a user returns to a character after visiting landing:
1. The `showLanding` effect clears `characterHistory` and `characterReply` (blank chat)
2. `greetedCharactersRef` still contains the character's ID
3. The greeting effect guards with `greetedCharactersRef.current.has(charId)` → returns early
4. User sees a blank chat with no greeting

The comment says "tracks which characters have greeted **this session**" — so session-level dedup is intentional for the first visit. But returning from landing should be treated as a fresh start for that character.

## Proposed Solutions

### Option A: Remove charId from greetedCharactersRef in showLanding effect
```tsx
// In the showLanding effect, after clearing history:
greetedCharactersRef.current.delete(charId);
```
This was previously in the code (the diff shows it being removed — line `-    greetedCharactersRef.current.delete(charId);`).

### Option B: Only deduplicate within a single continuous visit
Track visit count separately and only suppress greeting if it fired during this continuous visit (not after returning from landing).

## Recommended Action

Option A — restore the `greetedCharactersRef.current.delete(charId)` line that was removed in this PR.

## Acceptance Criteria

- [ ] Returning to a character after going to landing fires the greeting
- [ ] The greeting does NOT fire twice during a single continuous character visit
