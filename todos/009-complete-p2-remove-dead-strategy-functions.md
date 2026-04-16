---
name: 9 dead Gemini Live strategy functions created every render
description: GL_OBJECT_STRATEGY is hardcoded to 'keyword-stream' — the other 9 strategies are dead code that inflates App.tsx by ~250 lines
type: p2
status: pending
issue_id: "009"
tags: [maintainability, code-review]
---

## Problem Statement

`GL_OBJECT_STRATEGY` is a string constant fixed to `'keyword-stream'`. There are 10 strategy functions defined inside the App component (re-created every render):
- `glStrategy_turnComplete`
- `glStrategy_keywordStream` ← the only one that runs
- `glStrategy_stageDirStream`
- `glStrategy_predictAtInput`
- `glStrategy_wordThreshold`
- `glStrategy_hybrid`
- `glStrategy_speculativeCorrect`
- `glStrategy_odysseyLastPrompt`
- `glStrategy_odysseyAckInject`
- `glStrategy_odysseyVideoFrame`

The 9 inactive strategies add ~250 lines and make the session message handler hard to read. Any developer must trace through all 9 strategies to understand what actually fires. The `glOnChunk`/`glOnInput`/`glOnComplete` router functions are also dead indirection.

## Proposed Solutions

### Option A: Delete the 9 inactive strategies
Keep only `glStrategy_keywordStream`, `glDispatchObjects`, `glKeywordMatch`, and direct calls in the message handler. The dead strategies can be recovered from git history if needed for future experiments.

### Option B: Move strategies to a separate file
Keep all strategies but move them out of App.tsx into `src/lib/gemini-live-strategies.ts`. The component imports only the active one.

## Recommended Action

Option A — delete the dead code. The experiments are done; `keyword-stream` is the winner. This removes ~250 lines from App.tsx and makes the Gemini Live message handler immediately readable.

## Acceptance Criteria

- [ ] App.tsx no longer contains the 9 inactive strategy functions
- [ ] `glOnChunk`, `glOnInput`, `glOnComplete` router indirection removed
- [ ] Only `keyword-stream` logic remains inline
- [ ] Gemini Live object dispatch behavior is unchanged
