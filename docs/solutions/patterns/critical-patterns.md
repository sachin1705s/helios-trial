# Critical Patterns — Required Reading

These patterns have caused significant architectural pivots or security issues in this project.
Read this before designing any feature that touches real-time connections, external APIs, or browser-facing credentials.

---

## 1. Vercel Cannot Act as a WebSocket Server (ALWAYS REQUIRED)

### ❌ WRONG (silently fails — Vercel will reject the connection upgrade)
```ts
// Designing a Vercel Edge or Serverless Function to proxy a WebSocket
// e.g., browser → Vercel Edge Fn → Gemini Live WebSocket
export const config = { runtime: 'edge' };

export default async function handler(req: Request) {
  // This will never work — Vercel cannot upgrade to WebSocket
  const ws = new WebSocketPair();
  // ...proxy to external wss:// endpoint...
}
```

### ✅ CORRECT
```ts
// Server issues a short-lived ephemeral token — one fast stateless HTTP call
// Browser opens the WebSocket directly to the external API using that token
app.post('/api/gemini-live-token', async (req, res) => {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/ephemeralApiKeys', {
    method: 'POST',
    headers: { 'x-goog-api-key': runtimeConfig.geminiApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'models/gemini-3.1-flash-live-preview' }),
  });
  const data = await r.json();
  res.json({ token: data.ephemeralKey }); // short-lived token only — never the raw key
});

// Browser connects directly — Vercel not involved in the persistent connection
const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/...?key=${token}`);
```

**Why:** Vercel Functions (both Serverless and Edge) do not support acting as a WebSocket server. The browser → Vercel leg cannot be upgraded to a WebSocket regardless of runtime, `maxDuration`, or Fluid Compute settings. This constraint is permanent and infrastructure-level — no configuration change fixes it.

**Placement/Context:** Applies to any feature requiring real-time bidirectional streaming from the browser through Vercel: Gemini Live, OpenAI Realtime, any WebSocket-based API. If the target API supports ephemeral tokens, use the browser-direct pattern. If not, a separate always-on server (Railway, Fly.io) is required.

**Documented in:** `docs/solutions/integration-issues/vercel-cannot-proxy-websocket-GeminiLive-20260331.md`

---

## 2. Odyssey API Key Is Always Exposed to the Browser (ALWAYS REQUIRED)

### ❌ WRONG (assumes there is a secure token alternative — there is not)
```ts
// Do NOT design a flow that assumes Odyssey has an ephemeral token API.
// There is no supported way to avoid the raw key reaching the browser.

// This does not exist:
const { sessionToken } = await fetch('/api/odyssey/ephemeral-token');
const service = new OdysseyService(sessionToken); // ← OdysseyService has no such param
```

### ✅ CORRECT (accepted risk + mitigations layered)
```ts
// The raw ody_ key must cross to the browser — this is unavoidable with v1.1.2.
// Mitigate via: lease pool (capacity cap), TTL, rate limiting, key rotation.

// server: vend key via lease system (capacity-controlled, TTL-bounded)
res.json({ apiKey: lease.apiKey, leaseId: lease.leaseId });

// browser: use it, knowing the exposure is accepted and mitigated
const service = new OdysseyService(apiKey);
```

**Why:** `@odysseyml/odyssey` v1.1.2 (and all prior versions since v0.1.0) only accepts `ClientConfig.apiKey: string`. No ephemeral token, OAuth, or session-scoped credential exists in the public API. Verified against all 15 published versions, full npm source, and official docs. A fragile fetch-interceptor workaround exists (see full doc) but relies on the undocumented internal `POST /auth/token` endpoint — do not use in production without explicit sign-off.

**Placement/Context:** Applies to every browser-facing Odyssey integration. If Odyssey ships an ephemeral token API in a future version, migrate immediately and remove this pattern. Track their engineering response to the formal feature request sent 2026-03-31.

**Documented in:** `docs/solutions/security-issues/raw-api-key-browser-exposure-OdysseyIntegration-20260331.md`

---

## 3. Never Sync a Ref to React State via useEffect When That Ref Is a Guard in an Async Callback (ALWAYS REQUIRED)

### ❌ WRONG (stale ref causes race condition — guard fires on wrong value)
```ts
// Syncing a ref from state via useEffect introduces a render-cycle delay.
// Any async callback that reads the ref between setState and the effect flush
// will see the old value — causing double-calls, missed teardowns, or hangs.
useEffect(() => {
  isStreamingReadyRef.current = isStreamingReady; // ← async — fires after render
}, [isStreamingReady]);

// In an Odyssey SDK callback (fires synchronously):
onStreamEnded: () => {
  if (isStreamingReadyRef.current) { // ← may still read stale true
    endStream(); // called on a dead connection → hangs forever
  }
}
```

### ✅ CORRECT
```ts
// Write the ref synchronously inside the callback that owns the state change.
// Never use useEffect to sync a ref that is read as a guard in async/SDK callbacks.
onStreamStarted: () => {
  streamActiveRef.current = true;  // ← synchronous, always correct
},
onStreamEnded: () => {
  streamActiveRef.current = false; // ← synchronous, atomic read-and-clear
  if (retryStreamRef.current) retryStreamRef.current();
},
```

**Why:** React's `useEffect` fires asynchronously after the render cycle. SDK callbacks (Odyssey, WebSocket `onmessage`, etc.) fire synchronously. The window between `setState` and the effect flush is real — any callback that reads a `useEffect`-synced ref in that window sees stale state. Writing refs directly and synchronously inside the callbacks that own the transition eliminates the window entirely.

**Placement/Context:** Applies to any ref used as a guard inside SDK event callbacks, WebSocket handlers, `setInterval`/`setTimeout` closures, or any async function where stale state would cause incorrect behavior. Established in the Odyssey stream-hang incident (2026-03-27) and applied consistently to `streamActiveRef`, `geminiLiveActiveRef`, and `isCharacterRecordingRef`.

**Documented in:** `docs/solutions/integration-issues/stream-never-starts-odyssey-switching-20260327.md`
