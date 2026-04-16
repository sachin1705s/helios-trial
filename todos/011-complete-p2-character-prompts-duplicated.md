---
name: Character system prompts duplicated — text-chat and Gemini Live paths can silently diverge
description: GEMINI_LIVE_SYSTEM_PROMPTS in App.tsx and promptByCharacter in server/index.js define the same 8 characters with different prompts, no cross-reference
type: p2
status: pending
issue_id: "011"
tags: [maintainability, code-review]
---

## Problem Statement

Character personalities are defined in two completely separate places:
1. `server/index.js` `promptByCharacter` — used by `/api/character/chat` (text + TTS path)
2. `src/App.tsx` `GEMINI_LIVE_SYSTEM_PROMPTS` — used by Gemini Live WebSocket sessions

They cover the same 8 characters. There is no shared source, no cross-reference comment, no test that checks consistency. When one character's personality is updated, the other path silently keeps the old behavior. The prompts already differ substantially in style for the same character today.

## Proposed Solutions

### Option A: Add cross-reference comments (minimal fix)
```js
// server/index.js
// NOTE: Gemini Live uses separate prompts in src/App.tsx GEMINI_LIVE_SYSTEM_PROMPTS
// Keep both in sync when editing character personalities.
```

### Option B: Single source of truth (recommended for long term)
Move all character prompts to `server/character-prompts/` (already exists for some). Have the Gemini Live token endpoint include the system prompt for the selected character, so the browser fetches it from the server rather than inlining it.

### Option C: Move to characters.json
Add a `systemPrompt` field to each character entry in `src/data/characters.json`. Both the server route and App.tsx read from there.

## Recommended Action

Option A now (5 minutes), Option C when doing a character data refactor.

## Acceptance Criteria

- [ ] Both locations have a comment pointing to the other
- [ ] OR prompts are consolidated to a single source
