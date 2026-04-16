# Response Length Experiment — Findings

*Run: April 2026 · Model: gemini-2.0-flash · 90 calls (5 strategies × 3 characters × 6 questions)*

---

## Results

| Strategy | Casual avg | Deep avg | Ratio (deep/casual) |
|---|---|---|---|
| `baseline_25w` | 13w | 17w | 1.2x |
| `no_cap` | 77w | 220w | 2.9x |
| `match_question` | 47w | 133w | 2.8x |
| **`context_aware`** ✓ | **28w** | **44w** | **1.5x** |
| `two_burst` | 15w | 16w | 1.1x |

Full responses: [`experiments/results.md`](../experiments/results.md)

---

## What we learned

**`context_aware` is the right default.**
Casual stays tight at ~28w (≈10s of audio). Deep questions expand to ~44w (≈15s). The ratio is real and consistent across all three characters. It's the only strategy that differentiates by question depth without blowing up.

**`no_cap` and `match_question` are too unpredictable for voice.**
Deep questions hit 133–220w average — that's 45–75 seconds of uninterrupted speech. Fine for text, unusable for voice.

**`two_burst` flattens everything.**
~15w regardless of question depth. It doesn't respond to the question at all — every answer gets the same length treatment. Not useful as a default. Could work as an explicit brevity mode.

**`baseline_25w` barely differentiates.**
1.2x ratio means the model barely opens up for deep questions. Users asked complex questions and got short answers — the root complaint.

---

## What's shipped

**Concise mode (default, live now):**
> *"Keep replies to 2–3 sentences unless the question starts with explain, how, why, or tell me."*

Applied to all 8 Gemini Live characters in `src/App.tsx`.

**Detailed mode (wired, UI pending):**
> *"Give full, rich answers. Aim for 4–6 sentences. Elaborate on ideas, use vivid examples, and follow up with a question if the topic invites it."*

State is in `App.tsx` as `responseLengthMode: 'concise' | 'detailed'`. Toggle it via `setResponseLengthMode`. UI hook-up deferred.

---

## Open questions

- Cap `detailed` mode at ~70–80w max to stay listenable? The `no_cap` data suggests uncapped detailed mode could hit 150w+ on deep questions.
- `two_burst` as the ultra-concise option for quick-fire mode? Already designed in the two-burst roadmap.
- Per-character length preference (some characters naturally speak shorter)? Cleopatra and Alexander stayed tighter than Einstein even under `no_cap`.
