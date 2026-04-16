---
date: 2026-03-30
topic: gemini-live-speech-to-speech
---

# Gemini Flash Live Speech-to-Speech Integration

## Problem Frame

The current voice pipeline has ~1.5–3s of dead air between the user finishing speaking and the character responding:

```
Mic → STT (Smallest AI ~500ms) → Gemini text (~500ms) → TTS (Smallest AI ~500ms) → AudioContext
```

Gemini Flash Live collapses STT + chat + TTS into a single native audio-to-audio model with ~200–500ms first-byte latency. This makes character conversations feel significantly more natural and responsive.

Odyssey (avatar animation) is unaffected — it receives text prompts independently and does not consume audio.

## Requirements

- R1. One character (selected during planning/testing) uses the Gemini Flash Live pipeline; all other characters continue using the existing Smallest AI STT + Gemini text + Smallest AI TTS pipeline unchanged
- R2. Gemini Live session is managed via a Vercel Edge Function, which holds the persistent WebSocket connection to Google's API and keeps the API key server-side
- R3. The browser streams microphone audio (converted to 16-bit PCM at 16kHz) to the Edge Function in real-time; the Edge Function proxies chunks to the Gemini Live WebSocket
- R4. Gemini Live audio output chunks stream back to the browser and play via the existing `AudioContext` PCM playback infrastructure
- R5. Gemini Live is configured with `response_modalities: ["AUDIO", "TEXT"]` (or `output_audio_transcription`) so the text version of the model's response is also available alongside the audio
- R6. The text turn from Gemini Live is used to derive an Odyssey `interact()` action, maintaining avatar gesture animation for the test character
- R7. When Gemini Live signals a barge-in interruption (user speaks while character is responding), audio playback stops immediately and Odyssey receives a neutral `interact("stand idle")` prompt to reset the avatar animation before the next response
- R8. All changes are developed and validated on a feature branch; nothing merges to `main` until the end-to-end flow is confirmed working

## Success Criteria

- Test character responds within ~500ms of the user finishing speaking (measured: mic stop → first audio byte from Gemini Live)
- Avatar animation continues to track the character's speech during a Gemini Live session
- All other characters are unaffected — their pipeline does not change
- No API keys are exposed client-side (Edge Function holds the Gemini API key)
- Back navigation stops Gemini Live audio (same behavior as Fix 2 in the existing TTS QoL plan)

## Scope Boundaries

- Smallest AI STT and TTS are NOT removed — they remain the production path for all non-test characters
- Custom voice cloning is NOT available in Gemini Flash Live (as of March 2026) — the test character will use one of 8 preset voices (Puck, Charon, Kore, Fenrir, Aoede, Leda, Orus, Zephyr). This is a known voice quality tradeoff for the test phase.
- VAD / auto-stop recording behavior for the Gemini Live path is deferred (Gemini Live has its own built-in voice activity detection)
- No changes to the Odyssey connection lifecycle or WebRTC pipeline
- No changes to the Vercel production deployment configuration — branch testing only

## Key Decisions

- **WebSocket approach — Edge Functions over client-side:** Keeps Gemini API key server-side, consistent with how all other API keys (Gemini text, Smallest AI) are handled. Client-side WebSocket would expose the key.
- **One test character first:** Validates the full flow (Edge Function proxy → audio playback → Odyssey sync) before committing to a full pipeline swap.
- **Odyssey continues via text actions:** Gemini Live's text turn (from `response_modalities: ["AUDIO", "TEXT"]`) is used to drive Odyssey `interact()`. Odyssey is not replaced or bypassed.
- **Branch-first deployment:** Feature branch tested end-to-end before any merge to `main`. Mirrors the existing Odyssey stream-hang mitigation pattern of validating correctness before production exposure.

## Dependencies / Assumptions

- Gemini 3.1 Flash Live model is available via the `@google/genai` SDK or via raw WebSocket to `generativelanguage.googleapis.com`
- Vercel Edge Runtime supports persistent WebSocket connections for the duration of a conversation turn
- The existing `AudioContext` PCM playback code (`playCharacterTTS`) can be adapted to consume streaming PCM chunks from Gemini Live (same format it already handles from Smallest AI)
- Character system prompts fit within Gemini Live's session config token budget

## Outstanding Questions

### Resolve Before Planning
- None

### Deferred to Planning
- [Affects R2][Needs research] What is the Gemini 3.1 Flash Live model ID and does the `@google/genai` SDK support it in Edge Runtime, or is a raw WebSocket required?
- [Affects R3][Technical] How to convert `getUserMedia` WebM/Opus audio to 16-bit PCM at 16kHz in the browser before streaming to the Edge Function (Web Audio API `ScriptProcessorNode` or `AudioWorkletNode`)
- [Affects R6][Technical] How to extract an Odyssey action from Gemini Live's text turn — keyword/phrase matching vs. function calling tool in the Live session
- [Affects R1][Technical] Which character to use as the test character and how to gate the Live pipeline (env flag, slide ID check, or separate route)
- [Affects R7][Technical] Vercel Edge Function WebSocket proxy pattern — bidirectional streaming between browser ↔ Edge ↔ Gemini Live

## Next Steps

→ `/ce:plan` for structured implementation planning

---

## Reference: Current vs. Proposed Pipeline

| Step | Current | Proposed (test character) |
|---|---|---|
| STT | Smallest AI Pulse → text | Native in Gemini Flash Live |
| Chat | Gemini 2.0 Flash (text request) | Gemini 3.1 Flash Live (audio stream) |
| TTS | Smallest AI Lightning v3.1 → PCM | Native in Gemini Flash Live → PCM |
| Avatar | Odyssey `interact(action)` from JSON | Odyssey `interact(action)` from text turn |
| Latency | ~1.5–3s | ~200–500ms |
| WebSocket | None (request/response) | Vercel Edge Function ↔ Gemini Live |
