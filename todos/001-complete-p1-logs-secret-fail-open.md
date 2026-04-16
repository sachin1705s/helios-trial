---
name: LOGS_SECRET_KEY missing → admin endpoints fully open
description: Admin routes fail-open when LOGS_SECRET_KEY env var is unset — any caller can read log summaries and trigger Gemini keyword-expand
type: p1
status: pending
issue_id: "001"
tags: [security, code-review]
---

## Problem Statement

`GET /api/logs/summary` and `POST /api/keyword-expand` guard with:

```js
if (logsSecret && req.query?.key !== logsSecret) {
  return res.status(401).json({ error: 'Unauthorized.' });
}
```

If `LOGS_SECRET_KEY` is unset (undefined, empty string, or omitted in a new deployment), `logsSecret` is falsy and the condition short-circuits — **the check is skipped entirely**. Any unauthenticated caller can read aggregated user log data and trigger Gemini API calls that burn quota.

This is exploitable right now in any environment where the env var hasn't been set.

## Findings

- `server/index.js` — both admin route handlers use the same fail-open pattern
- Affects `GET /api/logs/summary` (reads all user analytics) and `POST /api/keyword-expand` (calls Gemini with up to 50 log entries)
- On Vercel production, the `LOGS_SECRET_KEY` must be explicitly configured — new preview deployments may omit it

## Proposed Solutions

### Option A: Fail closed (recommended)
```js
// Invert the guard — block when secret absent
if (!logsSecret || req.query?.key !== logsSecret) {
  return res.status(401).json({ error: 'Unauthorized.' });
}
```
**Pros:** One-line fix per route, immediately safe  
**Cons:** None  
**Effort:** Small  
**Risk:** Low — existing callers who pass the correct key are unaffected

### Option B: Move secret to Authorization header
```js
const provided = req.headers['authorization']?.replace('Bearer ', '');
if (!logsSecret || provided !== logsSecret) { ... }
```
**Pros:** Secret not exposed in server logs or browser history  
**Cons:** Requires updating any admin scripts that use query param  
**Effort:** Small  
**Risk:** Low

### Option C: Add startup assertion
```js
if (isProduction && !process.env.LOGS_SECRET_KEY) {
  console.error('[startup] LOGS_SECRET_KEY is required in production');
  process.exit(1);
}
```
Combine with Option A.

## Recommended Action

Apply Option A immediately (invert the guard on both routes). Optionally add Option C as a startup check.

## Acceptance Criteria

- [ ] `GET /api/logs/summary` returns 401 when `LOGS_SECRET_KEY` is not set
- [ ] `POST /api/keyword-expand` returns 401 when `LOGS_SECRET_KEY` is not set
- [ ] Existing calls with correct key continue to work
