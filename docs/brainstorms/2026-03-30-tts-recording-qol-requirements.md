---
date: 2026-03-30
topic: tts-recording-qol
---

# TTS & Recording Quality-of-Life Improvements

## Problem Frame

Three friction points in the recording/TTS interaction on mobile and desktop:

1. The record button is tappable before the Odyssey stream is ready — early presses silently fail
2. Navigating back while TTS is playing leaves audio continuing in the background (and in-flight fetches can start playing on the landing page)
3. Click-to-start / click-to-stop recording is cumbersome on mobile; users want a more natural interaction pattern

## Requirements

- R1. Record button is disabled and shows "Connecting…" until the Odyssey stream is live
- R2. Text input placeholder also reflects the connecting state
- R3. Navigating back stops TTS playback immediately and aborts any in-flight TTS fetch
- R4. Two consecutive TTS calls do not overlap — the previous source stops before the new one starts
- R5. The record button supports hold-to-talk on mobile (onPointerDown starts, onPointerUp/onPointerLeave stops)
- R6. Auto-stop on silence (VAD) is deferred — ship PTT first and gather feedback before committing to VAD

## Success Criteria

- Record button is visually inert and labeled "Connecting…" during stream setup; no silent failures on early tap
- Back navigation produces immediate audio silence; no ghost audio on the landing page
- Users on mobile can hold the record button to speak and release to send — consistent with WhatsApp / iOS Voice Memos
- No regression to existing Ctrl+Space PTT keyboard shortcut

## Scope Boundaries

- VAD (auto-stop on silence) is explicitly out of scope for this iteration — deferred until PTT behavior is validated with users
- Record button behavior during active TTS playback (re-enable timing vs. `isCharacterThinking`) is a pre-existing issue — not addressed here

## Key Decisions

- **Fix 3 approach — PTT over VAD:** Mobile hold-to-talk (2-line change) ships now. VAD is a follow-up. Rationale: PTT solves the core UX problem with no new audio code or iOS Safari edge cases; VAD adds ~25 lines and adaptive threshold logic that is better validated once PTT is live.
- **TTS cancellation mechanism — generation counter:** `source.stop()` alone cannot abort an in-flight `fetch + decodeAudioData`. A `ttsGenerationRef` counter is the only reliable cancellation mechanism across the full async pipeline.
- **VAD infrastructure — setInterval over rAF:** When VAD ships, use `setInterval` at 80ms (not `requestAnimationFrame`). rAF pauses when the tab is backgrounded, causing spurious auto-stop on foreground. Full VAD design is documented in `docs/plans/2026-03-28-001-feat-tts-qol-improvements-plan.md`.

## Dependencies / Assumptions

- `pttStartRef` / `pttStopRef` infrastructure already exists (`src/App.tsx:497`) — PTT is wiring, not new logic
- `isStreamingReady` state already exists and is correctly updated by the Odyssey stream lifecycle

## Outstanding Questions

### Deferred to Planning
- None — the implementation plan already exists at `docs/plans/2026-03-28-001-feat-tts-qol-improvements-plan.md` with full code detail for all three fixes

## Next Steps

→ `/ce:work` using `docs/plans/2026-03-28-001-feat-tts-qol-improvements-plan.md` as the implementation guide, with Fix 3 resolved as **mobile PTT**
