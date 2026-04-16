---
name: /api/clone-ab/rate has no rate limiting or deduplication — A/B test can be ballot-stuffed
description: Anyone with a valid sessionId can submit unlimited ratings, skewing the epsilon-greedy bandit
type: p2
status: pending
issue_id: "005"
tags: [security, code-review]
---

## Problem Statement

`POST /api/clone-ab/rate` accepts a `sessionId` + `rating` (1–5) with:
- No authentication
- No rate limiting (no `aiLimiter` or similar)
- No per-session deduplication (a sessionId can be rated N times)

An attacker calls `POST /api/clone-ab` once, gets a `sessionId`, then submits thousands of `rating=5` for their preferred provider. The epsilon-greedy bandit will route 80%+ of traffic to that provider based on corrupted data.

## Proposed Solutions

### Option A: Deduplicate ratings per session (recommended)
Store a `rated` flag in Redis alongside the session key:
```js
const alreadyRated = await redis.get(`clone:session:${sessionId}:rated`);
if (alreadyRated) return res.status(409).json({ error: 'Session already rated.' });
// ...after updating stats:
await redis.set(`clone:session:${sessionId}:rated`, '1', { ex: 3600 });
```

### Option B: Add rate limiter
Apply `aiLimiter` (or a tighter IP-based limiter) to the route:
```js
app.post('/api/clone-ab/rate', aiLimiter, async (req, res) => {
```

### Option C: Both A + B
One deduplication + one rate limit for defense in depth.

## Recommended Action

Option C — deduplicate at the session level (prevents replay) AND add a rate limiter (prevents probing for valid sessions).

## Acceptance Criteria

- [ ] A given `sessionId` can only be rated once; second attempt returns 409
- [ ] Route has rate limiting applied
