---
name: summarizeLogs performs O(n×c) scan — blocks Node.js event loop
description: Second pass in summarizeLogs re-scans all 10,000 log entries once per unique character to compute averages
type: p2
status: pending
issue_id: "008"
tags: [performance, code-review]
---

## Problem Statement

`summarizeLogs` in `server/index.js` has two passes:
- First pass: O(n) — correct
- Second pass: iterates `Object.entries(summary.characters)` and for each character re-scans all `entries` to find `time_to_first_prompt` and `character_closed` events

With `LOG_MAX = 10,000` and 8 characters: **80,000 iterations** running synchronously on the Node.js event loop. This blocks all other requests during execution.

## Proposed Solutions

### Option A: Accumulate ttfp/dwell arrays during first pass (recommended)
```js
// During first pass, accumulate per-character arrays
const ttfpByChar = {};
const dwellByChar = {};

for (const entry of entries) {
  // ...existing logic...
  if (characterId) {
    if (event === 'time_to_first_prompt' && Number.isFinite(entry.data?.timeMs)) {
      (ttfpByChar[characterId] ??= []).push(Number(entry.data.timeMs));
    }
    if (event === 'character_closed' && Number.isFinite(entry.data?.timeSpentMs)) {
      (dwellByChar[characterId] ??= []).push(Number(entry.data.timeSpentMs));
    }
  }
}

// After first pass, compute means — no second scan needed
for (const [characterId, character] of Object.entries(summary.characters)) {
  character.avgTimeToFirstPromptMs = mean(ttfpByChar[characterId] ?? []);
  character.avgTimeSpentMs = mean(dwellByChar[characterId] ?? []);
}
```
Reduces to O(n) total.

## Recommended Action

Option A — one-pass accumulation.

## Acceptance Criteria

- [ ] `summarizeLogs` makes exactly one pass over the entries array
- [ ] `avgTimeToFirstPromptMs` and `avgTimeSpentMs` values are correct
