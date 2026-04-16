---
name: ttsGenerationRef not incremented on character switch — character A TTS can play during character B
description: In-flight TTS fetch for character A can schedule audio while character B is active if user switches without returning to landing
type: p2
status: pending
issue_id: "007"
tags: [correctness, code-review]
---

## Problem Statement

`ttsGenerationRef` is only incremented in the `showLanding` effect. When the user switches from character A to character B **without going back to landing**, the generation counter stays the same. A `playCharacterTTS` call mid-flight for character A passes its generation snapshot check and schedules audio nodes on the shared `ttsAudioCtxRef` — playing character A's voice while character B's stream is active.

The abort controller (`ttsAbortRef`) is also not reset on character switch — only on landing navigation.

## Proposed Solutions

### Option A: Increment ttsGenerationRef and abort in handleSelectCharacter
```tsx
const handleSelectCharacter = (id: string) => {
  ++ttsGenerationRef.current;           // cancel any in-flight TTS
  ttsAbortRef.current?.abort();
  ttsAbortRef.current = null;
  try { ttsSourceRef.current?.stop(); } catch { /* ok */ }
  ttsSourceRef.current = null;
  // ... rest of existing logic
};
```

### Option B: Also close the AudioContext on character switch
More aggressive — ensures all scheduled audio stops immediately. But may add latency when the next character's audio starts since a new context must be created.

## Recommended Action

Option A — increment generation and abort in `handleSelectCharacter`.

## Acceptance Criteria

- [ ] Switching from character A to B while A's TTS is mid-fetch cancels the fetch
- [ ] Character A's voice never plays after switching to character B
- [ ] Character B's greeting TTS plays correctly after the switch
