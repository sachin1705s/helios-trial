# Voice Quality Metrics & Logging — Implementation Plan

> **Status:** Research complete, not yet implemented  
> **Last updated:** 2026-04-14  
> **Relevant pipelines:** STT→LLM→TTS (old/voice-clone path) + Gemini Live (new path)

---

## Background

Interact Studio runs two voice pipelines:

| Pipeline | Path | Where TTS lives |
|---|---|---|
| **Old / voice-clone** | User audio → Smallest AI Pulse (STT) → Gemini (LLM) → Smallest AI Waves lightning-v3.1 (TTS) → PCM | `/api/character/tts` (server/index.js ~L930) |
| **Gemini Live** | Gemini Live WebSocket handles STT + LLM + TTS end-to-end | Client WebSocket; we get `inputTranscription` + `outputTranscription` events |

Currently, all logging is scattered `console.log` strings. There is no structured quality data, no latency percentiles, and no WER measurement of any kind.

---

## What is WER

**Word Error Rate (WER)** = `(Substitutions + Deletions + Insertions) / Total words in reference`

Computed via minimum edit distance (Levenshtein) at word level.

| Variant | When to use |
|---|---|
| WER | Standard English evaluation |
| CER (Character Error Rate) | Multilingual systems; also more granular for short utterances |
| MER (Match Error Rate) | Rarely needed; skip for now |

**Good baseline targets for Smallest AI Pulse in English:** WER < 10% in clean audio. Ambient noise can push to 15–25%.

---

## The Two WER Problems

### Problem 1 — STT WER (did Pulse correctly transcribe the user?)

In live production there is **no ground truth**, so direct WER is impossible per-request.

**Proxy approaches:**

| Signal | Reliability | Cost | Notes |
|---|---|---|---|
| Confidence score from Pulse API response | Medium | Free | Pulse returns `confidence`; log it every call |
| Downstream coherence (LLM reply non-sequitur?) | Low | Free | Implicit; noisy |
| User correction signal (user rephrases?) | Medium | Free | Infer from conversation flow |
| Stratified manual review (1% sample + 10% low-confidence) | High | Human time | Best long-term option |
| Scheduled round-trip test on known phrases | High | API cost | Offline batch job; best for regression detection |

**Confidence monitoring (recommended immediate action):**
- Log `confidence` for every STT call (currently not captured at all)
- Compute daily P10/P50/P90 per character
- Alert if 7-day P50 drops > 5 points — this predicts accuracy problems before users notice

### Problem 2 — TTS WER (does Waves pronounce the text correctly?)

More tractable because you have the **reference text** (what you sent to TTS).

**Round-trip method:**
1. Send known phrase → `POST /api/character/tts` → stream PCM back
2. Re-send PCM as WAV → `POST /api/stt`
3. Compare STT output vs original phrase → compute WER with jiwer (Python) or speech-recognition-evaluation (npm)

**Limitation:** measures TTS + STT quality combined, not TTS alone. A high WER could be Waves mispronouncing or Pulse mishearing the TTS audio.

**When to run:** Offline batch job (weekly), not per-request. Too slow and too expensive for real-time.

---

## TTS-Specific Issues to Track (Old Pipeline)

### Issues the current server catches
- ✅ HTTP error from Smallest AI (logged with status code)
- ✅ 30s timeout abort
- ✅ `chunksReceived` and `bytesWritten` at stream end (L1064)
- ✅ Truncation events (L970) — but only as a `console.log` string

### Issues currently missed
| Issue | What to capture |
|---|---|
| **Silent audio** | `chunksReceived === 0` at stream end — this is a silent failure, currently undetectable |
| **TTFB (Time to First Byte)** | ms from TTS request send to first audio chunk arriving |
| **Total stream latency** | ms from request to `res.end()` |
| **Truncation metadata** | `originalLength`, `truncatedLength`, what boundary type was used (sentence / comma / hard cut) |
| **Abbreviation expansions** | Which abbrevs were expanded (helps debug TTS mispronunciation) |
| **Voice ID fallback** | When `voiceId` was empty and fell back to `'magnus'` |
| **Text passed to TTS** | The actual (post-processed) text, not the raw input — needed to correlate WER results |

---

## Structured Log Event (TTS)

Replace all `console.log` strings in `/api/character/tts` with one structured JSON object per call:

```json
{
  "event": "tts_call",
  "ts": "2026-04-14T10:00:00.000Z",
  "character": "einstein",
  "voiceId": "magnus",
  "voiceIdFallback": false,
  "inputLenRaw": 155,
  "inputLenFinal": 138,
  "truncated": true,
  "truncateBoundary": "sentence",
  "abbrevExpansions": ["rn→right now", "ngl→not gonna lie"],
  "ttfbMs": 87,
  "totalMs": 312,
  "chunksReceived": 14,
  "bytesWritten": 67200,
  "silentAudio": false,
  "status": "ok",
  "errorType": null
}
```

**Status values:** `"ok"` | `"timeout"` | `"api_error"` | `"silent"` | `"validation_error"`

---

## Structured Log Event (STT)

```json
{
  "event": "stt_call",
  "ts": "2026-04-14T10:00:00.000Z",
  "character": "einstein",
  "audioBytes": 48000,
  "audioMime": "audio/webm",
  "confidence": 0.87,
  "outputTextLength": 22,
  "latencyMs": 1240,
  "status": "ok",
  "errorType": null
}
```

---

## Gemini Live Quality Signals

Gemini Live bundles STT + LLM + TTS — we don't control the TTS, so standard round-trip WER testing doesn't apply directly.

**What's available:**
| Signal | Available | Notes |
|---|---|---|
| `inputTranscription` | ✅ | What Gemini heard the user say |
| `outputTranscription` | ✅ | What Gemini's TTS spoke (accumulate per turn) |
| Confidence scores | ❌ | Not exposed via API |
| Audio quality metrics | ❌ | Not exposed |

**What to log per turn:**

```json
{
  "event": "gemini_live_turn",
  "ts": "2026-04-14T10:00:00.000Z",
  "character": "einstein",
  "inputTranscription": "Can you show me how gravity works?",
  "outputTranscription": "Imagine a heavy ball on a trampoline...",
  "inputWordCount": 7,
  "outputWordCount": 42,
  "outputTruncated": false,
  "inputToFirstChunkMs": 320,
  "totalTurnMs": 4200
}
```

**Proxy quality checks (offline batch):**
- Semantic similarity between input question and output answer (embedding cosine distance) — flag if output seems unrelated
- Output word count distribution — very short replies (<8 words) or very long (>150 words) are potential issues
- User immediately rephrasing = implicit signal that the previous turn failed

---

## Round-Trip WER Test Corpus

**Size:** 200–300 utterances  
**Format:** JSON array of `{ id, text, character, difficulty }`

**Difficulty stratification:**

| Level | Examples | Count |
|---|---|---|
| Easy | Simple declaratives, common vocabulary | 100 |
| Medium | Contractions, possessives, character-specific phrases | 100 |
| Hard | Abbreviations (AI, LLM, API), numbers (50%, $3.5M), proper nouns | 50–100 |

**Character-specific phrases to include:**
- Einstein: "E equals MC squared", "spacetime curvature", "thought experiment"
- Sarvam/other characters: their domain vocabulary

**Metric to track per run:**
```json
{
  "runDate": "2026-04-14",
  "voiceId": "magnus",
  "character": "einstein",
  "utteranceCount": 300,
  "meanWER": 0.082,
  "p50WER": 0.071,
  "p90WER": 0.142,
  "silentAudioCount": 2,
  "timeoutCount": 1,
  "totalDurationSec": 840
}
```

**Alert threshold:** If 7-day mean WER increases by +2 percentage points, file a bug.

---

## Storage — Supabase Schema

```sql
CREATE TABLE voice_quality_logs (
  id            bigserial PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT now(),
  event_type    text NOT NULL,          -- 'tts_call' | 'stt_call' | 'gemini_live_turn' | 'wer_batch_run'
  character     text,
  data          jsonb NOT NULL,         -- full structured event
  latency_ms    int,                    -- indexed copy for quick queries
  error_type    text                    -- indexed copy for quick error queries
);

CREATE INDEX voice_quality_logs_ts_idx ON voice_quality_logs (ts DESC);
CREATE INDEX voice_quality_logs_event_type_idx ON voice_quality_logs (event_type);
CREATE INDEX voice_quality_logs_error_type_idx ON voice_quality_logs (error_type) WHERE error_type IS NOT NULL;
```

**Useful queries:**

```sql
-- TTS P50 / P95 latency by voice_id, last 7 days
SELECT
  data->>'voiceId' AS voice_id,
  date_trunc('day', ts) AS day,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
  count(*) FILTER (WHERE error_type IS NOT NULL) AS error_count,
  count(*) AS total_count
FROM voice_quality_logs
WHERE event_type = 'tts_call' AND ts > now() - interval '7 days'
GROUP BY voice_id, day
ORDER BY day DESC, voice_id;

-- Silent audio rate
SELECT
  date_trunc('day', ts) AS day,
  count(*) FILTER (WHERE (data->>'silentAudio')::boolean) AS silent_count,
  count(*) AS total_count,
  round(100.0 * count(*) FILTER (WHERE (data->>'silentAudio')::boolean) / count(*), 2) AS silent_pct
FROM voice_quality_logs
WHERE event_type = 'tts_call'
GROUP BY day
ORDER BY day DESC;

-- Truncation rate
SELECT
  data->>'character' AS character,
  count(*) FILTER (WHERE (data->>'truncated')::boolean) AS truncated_count,
  count(*) AS total_count
FROM voice_quality_logs
WHERE event_type = 'tts_call' AND ts > now() - interval '30 days'
GROUP BY character
ORDER BY truncated_count DESC;
```

---

## Libraries

| Library | Language | Purpose |
|---|---|---|
| `jiwer` (PyPI) | Python | Batch WER computation for offline test corpus |
| `speech-recognition-evaluation` (npm) | Node.js | WER in server-side JS if needed inline |
| `pino` or `winston` (npm) | Node.js | Structured JSON logging with Supabase transport |

**For round-trip batch jobs:** Python script using `jiwer` is the clearest path — call `/api/character/tts` and `/api/stt` from a Python test runner, dump results to Supabase.

---

## MOS (Mean Opinion Score) — Deferred

MOS requires human raters scoring naturalness on a 1–5 scale. Not practical until the user base is large enough to crowdsource. Defer to month 3+. Track WER and latency instead; they're cheaper and more actionable at early stage.

---

## Phased Implementation

### Phase 1 — Structured logging (1–2 days)
- [ ] Add structured TTS log object to `/api/character/tts` (replace console.log strings)
  - TTFB, total latency, truncation metadata, silent audio detection, voice ID fallback flag
- [ ] Add structured STT log object to `/api/character/stt` (confidence, latency, audio size)
- [ ] Create `voice_quality_logs` table in Supabase
- [ ] Write events to Supabase (fire-and-forget, don't block the response)

### Phase 2 — Gemini Live turn logging (1 day)
- [ ] Log each `turnComplete` event: inputTranscription, outputTranscription, word counts, latency
- [ ] Write to same `voice_quality_logs` table under `event_type = 'gemini_live_turn'`

### Phase 3 — Batch WER testing (2–3 days)
- [ ] Build 200-utterance test corpus (JSON file in `docs/` or `test/`)
- [ ] Write Python round-trip script: TTS → PCM → STT → jiwer WER → Supabase insert
- [ ] Schedule as weekly GitHub Actions job or manual run
- [ ] Add 7-day WER trend alert (email/Slack if P50 rises >2pp)

### Phase 4 — Confidence drift monitoring (1 day)
- [ ] Verify Smallest AI Pulse returns `confidence` field; if yes, extract and log
- [ ] Add daily cron to compute P10/P50/P90 confidence per character and store aggregate row
- [ ] Alert on 5-point P50 drop

---

## What NOT to do (research findings)

- **Don't gate real-time requests on WER measurement** — round-trip adds 1–2s; only use offline
- **Don't rely on MOS until you have real users rating** — crowdsourced MOS is expensive to set up early
- **Don't skip confidence logging** — it's the cheapest leading indicator of STT quality degradation
- **Don't combine TTS WER and STT WER without isolating** — if round-trip WER rises, bisect by testing each leg separately
- **Don't run prosody analysis** unless there's a specific complaint — F0 extraction via librosa is complex and the ROI is low at this stage
