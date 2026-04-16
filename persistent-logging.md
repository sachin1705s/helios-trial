# Persistent Logging

Custom product analytics for the character interaction flow.

---

## Architecture

- Frontend helper: [`src/lib/analytics.ts`](src/lib/analytics.ts)
- App instrumentation: [`src/App.tsx`](src/App.tsx)
- Backend ingestion + querying: [`server/index.js`](server/index.js)
- Storage: Upstash Redis list at `logs:all`
- Raw query: `GET /api/logs?event=<event_name>&limit=500`
- Summary query: `GET /api/logs/summary?days=30`

Every event includes:

- `sessionId`
- `path`
- `url`
- `referrer`
- `viewport`
- `timestamp`

Page-exit events use `navigator.sendBeacon` when available so the last character session is more likely to be captured.

---

## Core Helpers

### `trackEvent`

Shared client helper for fire-and-forget analytics.

```ts
trackEvent('prompt_sent', {
  characterId: slide.id,
  characterName: activeCharacterName,
  inputMethod: 'text',
  promptLength: prompt.length,
});
```

### `logFirstPromptIfNeeded`

Fires `time_to_first_prompt` once per character session.

---

## Events

### Navigation

- `page_view`
- `character_opened`
- `character_closed`

`character_closed` includes:

- `characterId`
- `characterName`
- `timeSpentMs`
- `reason`: `'switch' | 'landing_back' | 'page_exit'`

### Funnel

- `prompt_sent`
- `response_received`
- `time_to_first_prompt`

### Failure and friction

- `response_failed`
- `stream_error`
- `moderation_blocked`
- `stt_failed`
- `stt_empty`
- `browser_stt_failed`
- `character_input_error`
- `character_flow_error`
- `character_mic_blocked`
- `world_mic_blocked`

---

## Summary Endpoint

`GET /api/logs/summary?days=30`

Returns a rollup for the requested lookback window:

- total events
- events by type
- unique sessions
- page-view counts
- per-character opens, closes, prompts, responses
- average `time_to_first_prompt`
- average character dwell time
- input-method counts
- failure counts
- daily event trend

Use `LOGS_SECRET_KEY` via `?key=...` the same way as the raw logs endpoint.

---

## What Is Still Missing

- TTS playback success and failure
- Non-character Odyssey prompt analytics
- Cost and model-usage analytics

---

## Querying

```bash
# Raw events
GET /api/logs?limit=1000

# Filtered raw events
GET /api/logs?event=prompt_sent&limit=500

# Last 30 days aggregated summary
GET /api/logs/summary?days=30
```
