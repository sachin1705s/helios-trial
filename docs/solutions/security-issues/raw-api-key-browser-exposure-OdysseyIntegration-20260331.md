---
module: Odyssey Integration
date: 2026-03-31
problem_type: security_issue
component: authentication
symptoms:
  - "Raw ody_ API key sent to browser and visible in DevTools"
  - "No supported ephemeral or session-scoped credential alternative in SDK v1.1.2"
root_cause: missing_tooling
resolution_type: workflow_improvement
severity: high
tags: [api-key-security, odyssey, ephemeral-token, browser-exposure, websocket]
---

# Troubleshooting: Odyssey API Key Raw Exposure in Browser

## Problem

The `@odysseyml/odyssey` SDK requires a raw `ody_` API key at instantiation (`new Odyssey({ apiKey })`). Because the Odyssey WebRTC session must be initiated from the browser, the server is forced to send the real API key to the client. There is no officially supported mechanism to avoid this — no ephemeral token, no session-scoped credential, no proxy pattern documented anywhere.

## Environment

- Module: Odyssey Integration
- Affected Component: `src/lib/odyssey.ts`, `src/App.tsx`, `server/index.js`
- SDK Version: `@odysseyml/odyssey` v1.1.2 (2026-03-18) — all 15 versions since v0.1.0 confirmed same behavior
- Date: 2026-03-31

## Symptoms

- Raw `ody_` API key delivered from `GET /api/odyssey/token` to the browser
- Key stored in React state (`apiKey` useState) and visible in DevTools memory / network responses
- `interface ClientConfig { apiKey: string }` — only accepted credential type; no alternative field exists
- Key is long-lived with no TTL or scope restriction enforced by Odyssey's platform

## What Didn't Work

**Attempted: Ephemeral token via documented API**
- **Why it failed:** No ephemeral token endpoint exists in Odyssey's public API. Exhaustive search of official docs, npm package, and all version history confirmed `ClientConfig.apiKey: string` is the only credential type since v0.1.0. No auth improvements appear in any changelog or release note.

**Attempted: OAuth / JWT / scoped credential**
- **Why it failed:** Not supported. The type definitions contain no OAuth, JWT, or scoped key parameters. No authentication section exists anywhere in the official documentation.

**Attempted: Server-side proxy (keep key fully server-side)**
- **Why it failed:** Odyssey provides no first-class proxy architecture. The SDK must run in the browser and initiate the WebRTC session directly with `api.odyssey.ml`. There is no documented way to have the server hold the key and broker the connection transparently.

## Solution

### Current mitigations (in production)

The raw key crosses to the browser but blast radius is limited by a layered system:

**1. Lease pool with capacity cap (`server/index.js:228`)**
The server allocates a `leaseId` per session, tracked in Redis (production) or memory (dev). Concurrent sessions per key are capped by `ODYSSEY_KEY_LIMIT` (default: 5). A stolen key used to call Odyssey directly bypasses this — the lease pool only controls sessions issued through your own endpoint.

**2. Lease TTL — 2 hours (`ODYSSEY_LEASE_TTL_MS`)**
Leases auto-expire. Abandoned sessions release their slots. Does not invalidate the raw key itself.

**3. Heartbeat required (`POST /api/odyssey/heartbeat`)**
Browser sends heartbeat every 60s. Reclaims slots from dropped sessions. Does not validate that the key is being used legitimately.

**4. Rate limiting (`generalLimiter` — 150 req / 15 min / IP)**
Limits how fast the `/api/odyssey/token` endpoint can be farmed. Does not limit direct use of a captured key.

### Fragile workaround (undocumented — use with caution)

SDK source inspection revealed an internal two-stage bootstrap:

```
// Stage 1 (internal, happens inside connect()):
POST https://api.odyssey.ml/auth/token
{ "api_key": "ody_..." }
→ { "access_token": "...", "expires_in": <seconds> }

// Stage 2 (internal):
POST https://api.odyssey.ml/sessions/token
Authorization: Bearer <access_token>
{ "session_id": "..." }
→ { "session_token": "..." }  ← used for WebSocket auth
```

The raw key is only used for Stage 1. A workaround is possible:

```ts
// Server: call /auth/token with real key, return only access_token to browser
const r = await fetch('https://api.odyssey.ml/auth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ api_key: runtimeConfig.odysseyApiKey }),
});
const { access_token, expires_in } = await r.json();
// Return { accessToken: access_token, expiresIn: expires_in } — NOT the raw key

// Browser: intercept the SDK's own /auth/token call before new Odyssey() runs
const _fetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
  if (url === 'https://api.odyssey.ml/auth/token') {
    return new Response(
      JSON.stringify({ access_token: preFetchedToken, expires_in: expiresIn }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return _fetch(input, init);
};

const service = new OdysseyService('__intercepted__'); // dummy string — SDK calls /auth/token internally
window.fetch = _fetch; // restore immediately after SDK bootstraps
```

⚠️ **This is NOT production-ready without explicit sign-off.** See Why This Works section for caveats.

### Interim mitigation: API key rotation

Rotate the Odyssey API key on a short interval (e.g., hourly or daily). A captured key becomes invalid after the next rotation. Requires:
- Odyssey supports programmatic key generation (verify before implementing)
- Graceful drain: issue new key, keep old key valid briefly while active sessions expire, then invalidate

## Why This Works

**The lease pool** limits concurrent sessions through your endpoint — but not direct API use. It's capacity management, not a security boundary.

**The fetch interceptor workaround** works because the Odyssey SDK calls `POST /auth/token` on every fresh `connect()`. By intercepting that call and returning a pre-fetched `access_token`, the raw `ody_` key never reaches the browser. However:

- `/auth/token` is **undocumented and unstable** — Odyssey could rename it, change the request shape, or add request signing at any time with no notice
- The `access_token` scope is **unknown** — if it's equivalent in privilege to the raw key (just shorter-lived), the security gain depends entirely on `expires_in`
- Monkey-patching `window.fetch` must be done atomically around `new Odyssey()` — any race condition either leaks the dummy string (harmless) or leaves fetch patched permanently (bad)

**Key rotation** caps the window of abuse. A leaked key is only valid until the next rotation cycle.

## Prevention

- Do not pass the raw Odyssey API key to the browser in any new integration without explicitly documenting the accepted risk
- If implementing the fetch interceptor workaround, add a prominent warning comment explaining it relies on undocumented SDK internals and must be re-verified on every `@odysseyml/odyssey` version bump
- Monitor Odyssey's npm release notes and changelog for any auth API changes (check on every dependency update)
- Track the formal feature request sent to Odyssey engineering — if they ship ephemeral tokens, migrate immediately and remove the workaround
- Consider key rotation as a near-term mitigation while awaiting Odyssey's response

## Formal Feature Request

A detailed feature request has been drafted and sent to the Odyssey engineering team covering:
- The root cause and exhaustive verification of the limitation
- Discovery of the undocumented `/auth/token` internal endpoint
- Specific ask: documented ephemeral token endpoint + `new Odyssey({ sessionToken })` SDK support
- Secondary ask: documented key rotation API as an interim solution

## Related Issues

- See also: [stream-never-starts-odyssey-switching-20260327.md](../integration-issues/stream-never-starts-odyssey-switching-20260327.md) — related Odyssey session lifecycle pitfall
