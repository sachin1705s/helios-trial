---
module: Gemini Live Integration
date: 2026-03-31
problem_type: integration_issue
component: tooling
symptoms:
  - "Vercel Edge Functions cannot hold a persistent WebSocket connection"
  - "Architecture plan assumed Edge Function could proxy WebSocket to Gemini Live — not feasible"
  - "Vercel Serverless Functions also cannot act as a WebSocket server"
root_cause: wrong_api
resolution_type: workflow_improvement
severity: high
tags: [vercel, websocket, edge-functions, gemini-live, ephemeral-token, architecture, real-time]
---

# Troubleshooting: Vercel Cannot Act as a WebSocket Server or Proxy

## Problem

Any architecture that requires a Vercel function (Serverless or Edge) to hold a persistent bidirectional WebSocket connection is not feasible. Vercel explicitly does not support WebSocket server capability, including for proxying to an external WebSocket endpoint. This caused a full architecture pivot when planning the Gemini Flash Live integration: the initial plan called for a Vercel Edge Function to proxy the browser ↔ Gemini Live WebSocket, which research confirmed is impossible.

## Environment

- Module: Gemini Live Integration
- Affected component: `server/index.js` (Vercel Serverless), planned `api/gemini-live-proxy` (Edge Function)
- Vercel deployment: Serverless Functions via `api/server.js` catch-all rewrite
- Date: 2026-03-31

## Symptoms

- Planning assumed a Vercel Edge Function could hold a persistent WebSocket proxy to `wss://generativelanguage.googleapis.com`
- Vercel KB confirms: "Vercel Functions do not support acting as a WebSocket server" — applies to both Serverless and Edge runtimes
- Fluid Compute (longer-lived Vercel invocations) also does not add WebSocket server capability
- The existing `vercel.json` uses `maxDuration: 30` (Serverless, Node.js) — a persistent Gemini Live session would exceed this regardless

## What Didn't Work

**Attempted: Vercel Edge Function WebSocket proxy**
- **Why it failed:** Vercel Edge Runtime does not support upgrading an incoming HTTP connection to WebSocket. Even outbound WebSocket connections to external services are possible from Edge Functions, but the browser → Vercel leg cannot be a WebSocket — it must be standard HTTP or SSE. Official Vercel KB statement: "Vercel Functions do not support acting as a WebSocket server."

**Attempted: Vercel Serverless Function with extended duration**
- **Why it failed:** Same limitation. `maxDuration` can be extended on Pro/Enterprise plans, but duration alone is irrelevant — the infrastructure does not support WebSocket server capability regardless of runtime length.

**Considered: Vercel Fluid Compute**
- **Why it was ruled out:** Fluid Compute enables longer-lived function invocations but does not add WebSocket server support. Community confirmation: Fluid Compute does not change the WebSocket constraint.

## Solution

### Pattern: Browser-direct WebSocket with server-issued ephemeral token

For APIs that support it (e.g., Gemini Live), the browser opens the WebSocket directly to the external service using a short-lived ephemeral token. The Vercel server's only role is issuing that token — a fast, stateless HTTP call that fits the serverless model perfectly.

```
Browser ──[POST /api/gemini-live-token]──► Vercel Serverless Fn
                                           └─► POST /v1beta/ephemeralApiKeys (Gemini)
                                           ◄── { ephemeralKey: "...", ttl: 60s }
Browser ◄── { token: "..." }

Browser ──[WebSocket with token]──────────────────────────────► Gemini Live API
                                           (Vercel not involved)
```

**Implementation in this project:**

```js
// server/index.js — stateless token endpoint, no persistent connection needed
app.post('/api/gemini-live-token', async (req, res) => {
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/ephemeralApiKeys',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': runtimeConfig.geminiApiKey },
      body: JSON.stringify({ model: 'models/gemini-3.1-flash-live-preview' }),
    }
  );
  const data = await response.json();
  return res.json({ token: data.ephemeralKey });
});
```

```ts
// Browser: direct WebSocket to Gemini using the ephemeral token
const ws = new WebSocket(
  `wss://generativelanguage.googleapis.com/ws/...BidiGenerateContent?key=${token}`
);
```

### Alternative patterns (when ephemeral tokens are not available)

If the target API does not support ephemeral tokens (e.g., Odyssey):

| Option | Detail | Tradeoff |
|---|---|---|
| Dedicated WebSocket server | Separate persistent Node.js service on Railway / Fly.io | Additional infrastructure dependency; complicates local dev |
| Cloudflare Workers + Durable Objects | Supports persistent WebSocket proxying | Requires moving off Vercel for that route |
| Rivet (third-party) | Tunnels WebSocket through Vercel via long-poll | Third-party dependency; added latency |

### What this means for future real-time features

Any feature requiring a persistent bidirectional connection from the browser through Vercel needs one of:
1. An ephemeral token pattern (ideal — keeps Vercel serverless)
2. A separate always-on server outside Vercel
3. A different infrastructure provider for that specific route

## Why This Works

The ephemeral token pattern works because the external API (Gemini Live) handles the stateful WebSocket connection entirely. Vercel only needs to do a single fast HTTP call to issue the token — stateless, sub-second, perfectly suited to serverless. The browser then connects directly. The API key never crosses to the browser (only the short-lived token does), and Vercel's serverless constraint is bypassed entirely.

## Prevention

- Before designing any real-time feature on the Vercel stack, confirm whether the target API supports an ephemeral/session token pattern — if yes, the serverless model works cleanly
- Never assume Vercel Edge Functions are a general-purpose WebSocket proxy — they are not
- When evaluating new real-time APIs (WebSocket, SSE streaming, long-lived connections), check upfront whether their auth model supports browser-direct connections with short-lived credentials
- If a feature genuinely requires a persistent server-side WebSocket proxy and the target API has no ephemeral token support, that is an infrastructure decision (separate service) — document it as an architectural dependency, not a Vercel configuration issue

## Related Issues

- See also: [raw-api-key-browser-exposure-OdysseyIntegration-20260331.md](../security-issues/raw-api-key-browser-exposure-OdysseyIntegration-20260331.md) — Odyssey does not support ephemeral tokens; this WebSocket constraint compounds that security issue
- See also: [stream-never-starts-odyssey-switching-20260327.md](./stream-never-starts-odyssey-switching-20260327.md) — related Odyssey WebRTC session lifecycle pitfall
