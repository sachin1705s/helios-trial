---
name: Broadcast room creation unauthenticated with no rate limit — Redis flooding risk
description: POST /api/broadcast/room has no auth and no rate limiter; a loop can exhaust Redis memory
type: p3
status: resolved
issue_id: "012"
tags: [security, code-review]
resolved_at: 2026-05-16
resolved_in: server/index.js — broadcastLimiter (5/min/IP) on room creation + /ready, hostToken returned at creation and validated on /ready, /heartbeat, DELETE
---

## Problem Statement

`POST /api/broadcast/room` creates a room and writes to Redis with no authentication and no rate limiting. A simple loop can flood Redis with unclaimed room records.

Also: `POST /api/broadcast/room/:code/ready` (host marks room live) has no host token — any caller who knows the room code can inject arbitrary `webrtcUrl` and `spectatorToken` values, spoofing the host.

## Proposed Solutions

### Option A: Rate limit room creation
Apply IP-based rate limiter:
```js
app.post('/api/broadcast/room', broadcastLimiter, async (_req, res) => {
```

### Option B: Return host token at creation time
```js
const hostToken = randomUUID();
// store in Redis: { status: 'waiting', hostToken, ... }
return res.json({ code, hostToken });

// Then on /ready:
app.post('/api/broadcast/room/:code/ready', async (req, res) => {
  const { hostToken, webrtcUrl, spectatorToken } = req.body ?? {};
  const room = await redis.hgetall(bcRoomKey(code));
  if (room.hostToken !== hostToken) return res.status(403).json({ error: 'Invalid host token.' });
```

## Recommended Action

Option A at minimum (rate limit). Option B for the host token spoofing protection.

## Acceptance Criteria

- [ ] `POST /api/broadcast/room` has a rate limiter applied
- [ ] `POST /api/broadcast/room/:code/ready` validates a host token
