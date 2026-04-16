---
name: Admin secret passed as URL query param — leaks to server logs and browser history
description: GET /api/logs/summary?key=<secret> exposes the secret in Vercel access logs, browser history, and Referer headers
type: p2
status: pending
issue_id: "006"
tags: [security, code-review]
---

## Problem Statement

Both admin routes authenticate via `req.query.key`:
```js
if (logsSecret && req.query?.key !== logsSecret) { ... }
```

Query parameters appear in:
- Vercel/server access logs (full URL is logged)
- Browser address bar history
- HTTP `Referer` header when navigating from the admin page

Anyone with access to server logs obtains the secret and can read user analytics or trigger arbitrary Gemini API calls.

## Proposed Solutions

### Option A: Use Authorization header
```js
const provided = req.headers['authorization']?.replace('Bearer ', '');
if (!logsSecret || provided !== logsSecret) {
  return res.status(401).json({ error: 'Unauthorized.' });
}
```
Call via: `curl -H "Authorization: Bearer $LOGS_SECRET_KEY" /api/logs/summary`

### Option B: Use custom header
```js
const provided = req.headers['x-admin-key'];
```

## Recommended Action

Option A. Also note: fix 001 (fail-open) should be applied at the same time.

## Acceptance Criteria

- [ ] Neither admin route accepts the secret via query parameter
- [ ] Both accept it via `Authorization: Bearer <secret>` header
- [ ] Server access logs no longer contain the secret value
