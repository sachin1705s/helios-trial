# Gemini Live — Object Dispatch Strategies

**Status:** Testing in progress. Results to be filled in after running `gemini-live-latency-test.html`.

---

## The Problem

When a character speaks during a Gemini Live voice session, physical objects need to appear on screen in Odyssey. The character might say *"look at this honeycomb"* and the honeycomb should appear at the same moment — not after the character finishes talking.

The Gemini Live WebSocket delivers events in this order:

```
inputTranscription  →  outputChunk (×N)  →  turnComplete
    ↑ user done              ↑ character speaking        ↑ turn over
    talking
```

Objects dispatched at `turnComplete` appear ~2–4 seconds after the character starts speaking. The goal is to dispatch as early as possible without losing accuracy.

---

## How Dispatch Works

All strategies call the same shared function:

```typescript
glDispatchObjects(objects, myGeneration, source)
```

This calls `handleInteract("add X, Y to the scene")` which sends the prompt to Odyssey. A deduplication set (`glDispatchedThisTurnRef`) prevents the same object appearing twice if multiple strategies fire.

The strategy is selected by a single constant in `App.tsx`:

```typescript
const GL_OBJECT_STRATEGY = 'speculative-correct' as const;
```

---

## Strategies

### V1 — turn-complete (baseline)

**When it fires:** After `turnComplete`, once the full character response is buffered.

**How it works:** Sends the full transcript + user question to the LLM and asks what objects should appear.

**Pros:** Most accurate — has the full response to work with.
**Cons:** Worst latency — fires after the character has finished speaking entirely.

**Expected latency:** ~2,500–4,000ms after `inputTranscription`.

---

### V2 — keyword-stream

**When it fires:** On every `outputChunk`, as the character is speaking.

**How it works:** Scans each chunk for ~50 predefined keywords (ball, honeycomb, sword, etc.) and dispatches the matching object immediately. Zero API calls.

**Pros:** Zero latency beyond chunk arrival time. No API cost.
**Cons:** Limited to the keyword list. Misses anything not explicitly mapped. Requires keyword to appear verbatim in speech.

**Expected latency:** ~400–800ms (first matching chunk).

---

### V3 — stage-dir-stream

**When it fires:** On every `outputChunk`.

**How it works:** Extracts `*stage directions*` (text wrapped in asterisks) from each chunk using regex `/\*([^*]+)\*/g`. Stage directions like `*holds up a honeycomb*` are sent directly to Odyssey as animation commands.

**Pros:** Works for any object the character explicitly gestures. Zero API calls.
**Cons:** Only works if the character uses asterisk-wrapped actions. Depends on model following the stage direction convention consistently.

**Expected latency:** ~500–800ms (when stage direction chunk arrives).

---

### V4 — predict-at-input

**When it fires:** At `inputTranscription` — the moment the user's speech is recognised, before the character starts speaking.

**How it works:** Sends the user's question alone to the LLM via `/api/character/chat` and asks what objects the character is likely to show.

**Pros:** Fires before the character speaks — objects can appear simultaneously with the first word.
**Cons:** LLM hasn't seen the character's response yet, so it's guessing from context alone. API call latency (~300–600ms) plus `inputTranscription` delay.

**Expected latency:** ~350–700ms.

---

### V5 — word-threshold

**When it fires:** When the output transcript buffer reaches 15+ words.

**How it works:** Accumulates `outputChunk` text. Once 15 words are buffered, sends the partial transcript + user question to the LLM to predict objects.

**Pros:** Has more context than V4 (partial response seen) while firing before `turnComplete`.
**Cons:** Still an API call. Fires mid-speech so timing depends on how verbose the character is.

**Expected latency:** ~1,200–2,000ms (depends on speech rate).

---

### V6 — hybrid

**When it fires:** Two phases.
- **Immediate:** Keyword match (V2) + stage direction extraction (V3) per chunk.
- **Confirmation:** LLM call at `turnComplete` with full transcript.

**How it works:** Uses fast client-side detection to dispatch early, then sends a correcting LLM call at the end. If the LLM finds something the keyword/stage-dir pass missed, it dispatches that too. Deduplication prevents duplicates.

**Pros:** Best-of-both — fast for common objects, accurate for unusual ones.
**Cons:** Two-phase complexity. LLM confirmation still fires late (same timing as V1).

**Expected latency:** Fast phase ~400–800ms. Confirmation phase ~2,500–4,000ms.

---

### V7 — speculative-correct *(currently active)*

**When it fires:** Two phases.
- **Speculative:** LLM call at `inputTranscription` (same timing as V4) — fires immediately.
- **Correction:** LLM call at `turnComplete` — checks if the speculative guess was right. If wrong, updates the scene.

**How it works:** Makes a best guess before the character speaks and shows it immediately. After the turn, verifies accuracy and corrects if needed. Uses `handleInteract("update the scene to show X")` for corrections.

**Pros:** Objects appear early (like V4) with a self-correcting safety net (like V1).
**Cons:** Two API calls per turn. Visible scene correction if the speculative guess was wrong.

**Expected latency:** Speculative ~350–700ms. Correction ~2,500–4,000ms (only if needed).

---

### V8 — odyssey-last-prompt

**When it fires:** At `inputTranscription`.

**How it works:** Reads `client.lastAppliedPrompt` from the Odyssey SDK — the rewritten scene prompt Odyssey is currently rendering — and injects it as context into the LLM prediction call alongside the user's question.

**Example prompt sent to LLM:**
> "The scene currently shows: 'A friendly bear sitting by a forest stream, looking warm and happy'. The user just asked the character: 'What is your favourite food?'. What physical objects should now appear?"

**SDK source:** `serviceRef.current.lastAppliedPrompt` (public property on the Odyssey client, updated after every `startStream()` and `interact()` call).

**Pros:** Richer context than V4 — the LLM knows what the scene looks like, not just the user's question. Same timing as V4.
**Cons:** `lastAppliedPrompt` is Odyssey's rewritten/expanded prompt, not a direct description of what's on screen. Still a single API call.

**Expected latency:** ~350–700ms.

---

### V9 — odyssey-ack-inject

**When it fires:** At `inputTranscription`.

**How it works:** Reads the last prompt that Odyssey explicitly acknowledged via the `onInteractAcknowledged(prompt)` SDK callback. This is the last prompt Odyssey confirmed it received and processed — the ground truth of what it's currently rendering, rather than what was sent.

Falls back to `lastAppliedPrompt` if no interact has been acknowledged yet (e.g., session just started).

**SDK source:** `onInteractAcknowledged` callback wired into `service.connect({...})` in App.tsx, stored in `glLastAckPromptRef`.

**Pros:** More precise than V8 — reflects what Odyssey has actually rendered, not just what was requested. Matters when multiple fast interact calls are in flight.
**Cons:** Can be stale if acknowledge callback hasn't fired yet. Slightly behind `lastAppliedPrompt` in timing.

**Expected latency:** ~350–700ms.

---

### V10 — odyssey-video-frame

**When it fires:** At `inputTranscription`.

**How it works:** Captures a live frame from the Odyssey video stream using `ImageCapture.grabFrame()` on `odysseyStreamRef.current`. Describes the frame to the LLM and asks what objects should appear next given the user's question.

Falls back to `lastAppliedPrompt` text if the video track is unavailable or capture fails (e.g., in test environments).

**SDK source:** `odysseyStreamRef.current` — the `MediaStream` stored from `onConnected`. `ImageCapture` is a browser-native API.

**Pros:** Richest possible context — sees exactly what's on screen. Not limited to prompt text.
**Cons:** `ImageCapture` browser support is limited (no Safari). Frame capture adds latency on top of the LLM call. Most expensive of the three Odyssey-feedback strategies.

**Expected latency:** ~500–900ms (capture + LLM call).

---

## Test Setup

**Test harness:** `gemini-live-latency-test.html` (open in browser with dev server running).

**Fixtures tested (5 scenarios):**

| ID | Character | User question | Expected objects |
|---|---|---|---|
| einstein-gravity | Albert Einstein | "Can you show me how gravity works?" | heavy ball, trampoline |
| bear-berries | Steve the Bear | "What is your favourite food?" | honeycomb, berries |
| alexander-battle | Alexander | "How do you win a battle against a larger army?" | battle map, sword |
| circus-lion-juggling | Circus Lion | "Can you juggle?" | juggling pins, juggling ball |
| davinci-wing | Da Vinci | "Tell me about your flying machine." | feathered wing, brass gear |

**Scoring:** Each strategy is scored per fixture:
- Hit (all expected objects dispatched): 3 points
- Partial (some expected objects): 1 point
- Miss: 0 points
- Latency penalty: −1 point per 500ms (max −6)

**API endpoint required:** `/api/character/chat` (LLM-based strategies only — V1, V4–V10).

---

## Results

Tested across 5 core fixtures + 5 OOD stress-test fixtures (2026-04-15).

| Strategy | Core score | OOD false positives | Notes |
|---|---|---|---|
| V1 turn-complete | low | low | Too slow — fires after character finishes speaking |
| **V2 keyword-stream** | **best** | **lowest** | Zero API cost, lowest latency, cleanest on OOD |
| V3 stage-dir-stream | low | low | Requires model to emit asterisk actions — unreliable |
| V4 predict-at-input | mid | mid | API latency adds ~400ms; misses on short inputs |
| V5 word-threshold | mid | mid | Fires too late on short responses |
| V6 hybrid | mid | mid | keyword win negated by LLM confirmation delay |
| V7 speculative-correct | mid | high | Visible corrections bad for Odyssey scene coherence |
| V8 odyssey-last-prompt | mid | mid | No accuracy gain over V4 |
| V9 odyssey-ack-inject | mid | mid | Stale ack prompt adds noise |
| V10 odyssey-video-frame | low | mid | Frame capture latency erases any context benefit |

**Winner: V2 keyword-stream** — shipped 2026-04-15.

---

## Shipping the Winner

```typescript
const GL_OBJECT_STRATEGY = 'keyword-stream';
```

---

## Next: Learning Hybrid (V11)

V2 wins on latency and precision but is bounded by the static keyword list. The plan is a hybrid that keeps keyword-stream as the primary fast path and adds a lightweight learning layer to grow the list from real user interactions.

### Architecture

**Fast path (unchanged):** keyword-stream fires on every chunk, zero API calls, sub-500ms dispatch.

**Miss logging:** when a turn completes with `keyword-stream` returning nothing (i.e. `firstDispatchMs === null`) the full turn is logged — user text, character response, character name, and timestamp — to a backend store.

**Keyword expansion:** periodically (or triggered manually) a background job reads the missed-turn log and calls the LLM once per batch: *"Here are N turns where no keyword matched. What recurring physical objects do these turns suggest? Return keyword → object pairs."* New pairs are added to `GL_KEYWORD_MAP`.

**Deduplication guard:** before adding a suggested keyword, check it does not already exist in the map and that it appeared in at least 2 distinct missed turns (prevents one-off hallucinations).

### Implementation sketch

```typescript
// On turnComplete, if keyword-stream dispatched nothing:
if (GL_OBJECT_STRATEGY === 'keyword-stream' && glDispatchedThisTurnRef.current.size === 0) {
  logMissedTurn({
    character: activeCharacterName,
    userText: glCurrentUserTextRef.current,
    response: glOutputTranscriptBufferRef.current,
  });
}

// POST /api/keyword-miss  (append to a JSONL file or Supabase table)
```

```typescript
// Expansion job (run manually or on schedule):
// POST /api/keyword-expand
// reads missed-turn log → LLM → returns new { keyword, object }[] pairs
// write back into GL_KEYWORD_MAP (or a DB table the client hydrates at startup)
```

### Scaling the keyword list

Rather than hardcoding `GL_KEYWORD_MAP` in `App.tsx`, the list moves to a JSON file or DB table fetched at session start. This means keyword additions go live without a deploy.

```typescript
// At app init, replace static KEYWORD_MAP with:
const GL_KEYWORD_MAP = await fetch('/api/keywords').then(r => r.json());
```

**Priority order for V11:** miss logging → expansion endpoint → dynamic fetch. Each step is independently shippable.
