# Response Length Research

*Last updated: April 2026*

## Why responses are currently short

Three stacked constraints in the current codebase:

1. System prompt hard cap: `"Keep every reply under 25 words"` (`server/index.js` ~line 719)
2. `maxOutputTokens: 160` (`server/index.js` ~line 736)
3. Frontend trim to 40 words (`src/App.tsx` ~line 1046)
4. Smallest AI TTS hard limit: ~140 chars per call (`src/App.tsx` ~line 955)

The TTS limit is the root constraint — everything else was set to stay within it.

---

## Two pipelines to solve separately

### Pipeline 1: Gemini Live (main characters)

Gemini Live streams audio natively — the 140-char TTS ceiling disappears. Fix is simple:
- Remove the 25-word cap from the system prompt
- Raise `maxOutputTokens` to 400–600
- Remove the 40-word frontend trim
- Replace the hard cap with: *"Keep replies to 2–3 sentences unless the question starts with explain/how/why/tell me"*

### Pipeline 2: STT → LLM → TTS (voice cloning characters)

The 140-char TTS limit per call remains. Four options:

---

### Option A — TTS chunking *(recommended)*
Split the LLM response on sentence boundaries and queue multiple TTS calls sequentially. Character speaks continuously, fed sentence by sentence.
- Remove all word/token caps; raise `maxOutputTokens` to 400–600
- Split on `. `, `? `, `! ` before sending to Smallest AI
- Queue audio so chunks play back-to-back without gaps
- **Pro:** Full natural speech, no UX change
- **Con:** Needs audio queue management; lip sync with Odyssey needs care

### Option B — Speak short, show long
Generate a full LLM response (no caps), speak only the first ~140 chars via TTS, display the full text in a transcript/chat panel.
- **Pro:** Easiest to implement; transcript panel is a useful feature anyway
- **Con:** Speech and text diverge — character "says" less than what's shown

### Option C — Context-aware length
Detect deep questions (keywords: "explain", "tell me about", "how", "why", "what do you think") and switch to verbose mode + TTS chunking for those only. Casual banter stays snappy.
- **Pro:** Best of both worlds
- **Con:** Keyword detection is imperfect; adds branching logic

### Option D — Two-burst rhythm
Change JSON schema to `{reply1, reply2, action, objects}`. Two TTS calls with a brief pause between them. Doubles effective length with minimal pipeline change.
- **Pro:** Works within 140-char TTS limit; feels like natural breath/pacing
- **Con:** Small schema migration; characters need to learn the two-beat rhythm

---

## Recommended sequencing

1. **Voice cloning pipeline:** Start with Option D (lowest risk), then migrate to Option A for full flexibility
2. **Main characters (Gemini Live):** Switch to `"2–3 sentences"` instruction when Gemini Live integration lands

---

## Industry research findings

### The consensus: 2–3 sentences per turn

Every major voice AI platform has converged on the same rule:

| Platform | Guideline |
|---|---|
| **OpenAI Realtime API** | `"Length: 2–3 sentences per turn"` — hardcoded as default in their Personality & Tone section |
| **ElevenLabs** | `"under 3 sentences unless the user requests detail"` |
| **Vapi** | `"Be concise, as you are currently operating as a Voice Conversation"` |
| **Layercode** | `"under 50 words for simple queries; break complex answers into multiple turns"` |

### Write for the ear, not the eye

30 spoken words ≈ 10 seconds of audio. Attention drops sharply after that. The same LLM answer that looks normal in chat feels verbose when spoken aloud. Voice guides universally say responses feel 2–3x longer when heard than when read.

### The Pi (Inflection) pattern

Pi trained with behavioral therapists, psychologists, and playwrights to teach the model *when* to be brief. Their key insight: **answer partially + ask a follow-up question**. This keeps conversation feeling alive rather than like a lecture. Worth copying for character personas.

### Why LLMs pad responses

RLHF trains models to seem thorough. When told to be concise they produce "verbosity compensation" — filler that can be compressed without information loss. They're not padding because they have more to say; they're padding because that's what got rewarded during training.

Source: *"Verbosity ≠ Veracity"* — [arxiv 2411.07858](https://arxiv.org/html/2411.07858v1)

### Gemini Live's approach

They don't hardcode response length — they expose it as a user-facing setting: `concise / socratic / formal / custom`. Worth considering a per-character version of this in Interact Studio.

---

## Proven prompt phrases

| Technique | Example phrase |
|---|---|
| Sentence cap + escape hatch | `"Keep replies to 2–3 sentences unless the user asks for detail"` |
| Question-depth matching | `"Match your response length to the depth of the question"` |
| Turn-taking instead of long answers | `"If a topic needs more than 3 sentences, ask a follow-up instead of continuing"` |
| Ear-not-eye framing | `"You are speaking aloud. Short sentences. No lists. Sound natural when spoken."` |
| Hard cap + exception | `"Under 50 words. For how/why/explain questions, up to 100 words."` |

---

## DSPy experiment

Script at [`experiments/prompt_length_experiment.py`](../experiments/prompt_length_experiment.py) tests all 5 strategies against 3 characters with 6 test cases (mix of casual + deep questions) using a local Ollama model — no Gemini credits consumed.

**Setup:**
```bash
ollama pull llama3.2
pip install -r experiments/requirements.txt
```

**Run:**
```bash
python experiments/prompt_length_experiment.py
```

**Strategies tested:** `baseline_25w`, `match_question`, `two_burst`, `no_cap`, `context_aware`

---

## Sources

- [OpenAI Realtime Prompting Guide](https://developers.openai.com/cookbook/examples/realtime_prompting_guide)
- [ElevenLabs Prompting Guide](https://elevenlabs.io/docs/eleven-agents/best-practices/prompting-guide)
- [Vapi Voice Prompting Guide](https://docs.vapi.ai/prompting-guide)
- [Layercode — How to Write Prompts for Voice AI Agents](https://layercode.com/blog/how-to-write-prompts-for-voice-ai-agents)
- [Verbosity ≠ Veracity — arxiv 2411.07858](https://arxiv.org/html/2411.07858v1)
- [Precise Length Control in LLMs — arxiv 2412.11937](https://arxiv.org/html/2412.11937v1)
- [Pi / Inflection product strategy](https://medium.com/@lindseyliu/product-strategy-of-companion-chatbots-such-as-inflections-pi-2f3b7a1538b4)
