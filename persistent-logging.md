# Persistent Logging

Custom event logging system built on top of Vercel Analytics to track detailed user behavior inside the character interaction flow.

---

## Architecture

- **Frontend** (`src/App.tsx`) fires events via a `logEvent` helper
- **Backend** (`server/index.js`) receives them at `POST /api/log` and writes to SQLite (`data.sqlite`)
- **Table**: `logs(id, event, data_json, timestamp)`
- **Query**: `GET /api/logs?event=<event_name>&limit=500`

---

## Helper Functions

### `logEvent`
Fire-and-forget POST to the log endpoint. Defined inside the `App` component.

```ts
const logEvent = (event: string, data: Record<string, unknown>) => {
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
  }).catch(() => undefined);
};
```

### `logFirstPromptIfNeeded`
Fires `time_to_first_prompt` exactly once per character session, then marks itself as done via `hasLoggedFirstPromptRef`.

```ts
const logFirstPromptIfNeeded = (characterId: string, characterName: string, inputMethod: string) => {
  if (!hasLoggedFirstPromptRef.current && characterOpenedAtRef.current !== null) {
    logEvent('time_to_first_prompt', {
      characterId,
      characterName,
      inputMethod,
      timeMs: Date.now() - characterOpenedAtRef.current,
    });
    hasLoggedFirstPromptRef.current = true;
  }
};
```

---

## Refs Used

| Ref | Type | Purpose |
|---|---|---|
| `characterOpenedAtRef` | `number \| null` | Timestamp (ms) when current character was opened |
| `hasLoggedFirstPromptRef` | `boolean` | Guards `time_to_first_prompt` to fire only once per session |

Both refs reset in `handleSelectCharacter` whenever a new character is opened.

---

## Events

### `character_opened`
Fired when a user clicks a character card on the landing grid.

| Field | Type | Description |
|---|---|---|
| `characterId` | string | e.g. `"einstein"` |
| `characterName` | string | e.g. `"Einstein"` |

---

### `character_closed`
Fired when a user switches to a different character (i.e. goes back and picks another one).

| Field | Type | Description |
|---|---|---|
| `characterId` | string | Character being left |
| `characterName` | string | Character being left |
| `timeSpentMs` | number | Total milliseconds spent on that character |

> Note: if the user closes the tab without switching, `character_closed` does not fire — the last session's time is not captured.

---

### `prompt_sent`
Fired every time a message is dispatched to the character chat API, regardless of input method.

| Field | Type | Description |
|---|---|---|
| `characterId` | string | Active character |
| `characterName` | string | Active character name |
| `inputMethod` | `'text'` \| `'stt'` | Whether the prompt came from the text box or voice recording |
| `promptLength` | number | Character count of the prompt |

---

### `response_received`
Fired when the character chat API returns a reply successfully.

| Field | Type | Description |
|---|---|---|
| `characterId` | string | Active character |
| `characterName` | string | Active character name |
| `latencyMs` | number | Milliseconds from fetch start to response parsed |
| `responseLength` | number | Character count of the trimmed reply |

---

### `time_to_first_prompt`
Fired once per character session — when the user sends their very first message after opening a character. Measures how long they observed/explored before engaging.

| Field | Type | Description |
|---|---|---|
| `characterId` | string | Active character |
| `characterName` | string | Active character name |
| `inputMethod` | `'text'` \| `'stt'` | How they chose to engage first |
| `timeMs` | number | Milliseconds from character open to first prompt sent |

---

## Vercel Deployment — What Broke and Why

The original SQLite-based logging system failed on Vercel in three distinct ways. These are documented here so the replacement system avoids the same traps.

---

### Problem 1 — `better-sqlite3` native binary crashes the entire serverless function

**What happened:** `import Database from 'better-sqlite3'` is a top-level static import. `better-sqlite3` is a native Node.js addon that compiles a `.node` binary during `npm install`. The binary compiled fine in Vercel's build environment, but failed to load at runtime on Vercel's Lambda (Amazon Linux) environment. Because the import is at module level, the entire serverless function failed to initialize — every single endpoint (`/api/stt`, `/api/character/stt`, `/api/character/chat`, etc.) returned Vercel's generic HTML `500 Internal Server Error` page instead of JSON.

**Why the try/catch didn't help:** The try/catch only wrapped `new Database(DB_PATH)` — not the `import` statement itself. A failed static import throws before any application code runs.

**Attempted fix 1:** Converted to dynamic import with try/catch:
```js
let Database = null;
try { ({ default: Database } = await import('better-sqlite3')); } catch { }
```
This still failed — either the native module crash was unrecoverable at the process level, or top-level await caused its own initialization issue in the Vercel runtime.

**Final fix:** Removed `better-sqlite3` entirely from `package.json` and the codebase. The DB init block and both `/api/log` and `/api/logs` endpoints were deleted.

---

### Problem 2 — SQLite `/tmp` storage is per-instance and ephemeral

Even if `better-sqlite3` had loaded successfully, writing to `/tmp/data.sqlite` on Vercel would have been useless:
- Vercel spins up multiple serverless function instances in parallel — each gets its own `/tmp`, so writes from one instance are invisible to others
- `/tmp` is wiped when the instance is recycled (typically after a few minutes of inactivity)
- There is no shared persistent filesystem on Vercel

Any SQLite-on-serverless approach is fundamentally broken for cross-request persistence.

---

### Problem 3 — DB write errors inside the endpoint returned 500 to the client

The `/api/log` endpoint had a single try/catch wrapping everything including the DB write. When `insertLog.run()` threw (e.g. due to a `/tmp` permission issue or DB not initialized), the catch block returned `res.status(500).json({ error: 'Log failed.' })`. This caused the client to see a 500 for what should be a silent, non-critical operation.

**Fix applied before full removal:** Moved the DB write into its own inner try/catch so errors were swallowed server-side:
```js
if (insertLog) {
  try { insertLog.run(...); } catch (err) { console.warn('[db] write failed:', err.message); }
}
return res.json({ ok: true });
```

---

### What the replacement system must satisfy

1. **No native binaries** — HTTP-only clients only (rules out any SQLite, LevelDB, or `pg` with native bindings)
2. **Serverless-safe** — writes go to an external service, not the local filesystem or process memory
3. **Non-blocking to the client** — log failures must never cause the API endpoint to return a non-2xx response
4. **No new endpoints needed** — ideally fire-and-forget from the client or a thin server wrapper

**Candidates evaluated:**
- `@upstash/redis` — HTTP-based Redis, no native modules, works on Vercel ✓ (already added to `package.json`)
- Axiom (`@axiomhq/js`) — structured log ingestion over HTTP, has a Vercel integration ✓
- `console.log` → Vercel function logs — zero setup, but no persistence or querying

---

## What Is Not Logged

- User closing the tab (last session time is lost)
- TTS playback success or failure
- STT failures (e.g. "we did not hear anything")
- Moderation blocks
- Prompts sent to the Odyssey video stream directly (non-character mode)

---

## Querying Logs

```bash
# All events for a specific type
GET /api/logs?event=prompt_sent&limit=500

# All logs (no filter)
GET /api/logs?limit=1000
```

Response shape:
```json
[
  {
    "id": 1,
    "event": "prompt_sent",
    "data": { "characterId": "einstein", "inputMethod": "text", ... },
    "timestamp": "2026-03-26T10:00:00.000Z"
  }
]
```
