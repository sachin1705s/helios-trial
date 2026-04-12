# Bug Report: Image-to-Video Capability Lost in Client Credentials Flow

**Reported by:** Interact Studio  
**Date:** 2026-04-12  
**Severity:** High — blocks image-to-video in all browser clients using the secure credentials flow  
**Affected SDK:** `@odysseyml/odyssey`  
**Affected method:** `createClientCredentials()` / `connectWithCredentials()`

---

## Summary

When using the recommended secure client credentials flow, the Odyssey SDK drops the session's `capabilities` field before it reaches the browser. As a result, the browser-side SDK object always initializes with `image_to_video: false`, causing `startStream({ image })` to fail — even when the server has provisioned a session with image-to-video capability.

We have traced this to a specific line in the SDK source. This is not a misconfiguration on our end — the bug is in the SDK itself.

---

## Background: The Credentials Flow

The secure flow (introduced to prevent API key exposure in the browser) works as follows:

```
Server
  → calls createClientCredentials() with API key
  → Odyssey API returns session object including capabilities
  → capabilities are silently dropped here ← bug
  → server forwards session token (without capabilities) to browser

Browser
  → calls connectWithCredentials(token)
  → SDK connects, but capabilities were never passed
  → SDK object initializes with image_to_video: false
  → startStream({ image }) fails
```

This flow is documented at [https://documentation.api.odyssey.ml/client-credentials](https://documentation.api.odyssey.ml/client-credentials).

---

## Root Cause: Confirmed in SDK Source

We inspected the SDK's compiled source (`node_modules/@odysseyml/odyssey/dist/index.js`) and identified the exact location where capabilities are dropped.

### Step 1 — `createClientCredentials()` fetches the session correctly

The server-side `createClientCredentials()` calls `requestSessionFromApi()`, which receives the full session object from the Odyssey API including capabilities:

```js
// SDK internals — requestSessionFromApi()
const capabilities = data.capabilities || { image_to_video: false };
this.log("Received session from API:", {
  sessionId: data.session_id,
  capabilities  // ← capabilities ARE present here ✓
});
return {
  sessionId: data.session_id,
  signalingUrl: data.signalling_url,
  capabilities  // ← returned in the session object ✓
};
```

### Step 2 — `createClientCredentials()` drops them when building the return value

Immediately after receiving the session, `createClientCredentials()` builds its return value using only three of the session's fields:

```js
// SDK internals — createClientCredentials()
async createClientCredentials() {
  this.requireApiKey();
  await this.exchangeApiKeyForToken();
  const session = await this.requestSessionFromApi(...);
  // session.capabilities exists here, but is never passed forward ↓
  const tokenInfo = await this.fetchSessionToken(session.sessionId);
  return createClientCredentials(session.signalingUrl, tokenInfo.token, tokenInfo.expiresIn);
  //                             ↑ signalingUrl, token, expiresIn only — capabilities dropped ✗
}
```

The `createClientCredentials` helper function (lowercase) only accepts three arguments and has no knowledge of capabilities:

```js
function createClientCredentials(signalingUrl, sessionToken, expiresIn) {
  return {
    sessionId: extractSessionId(sessionToken),
    signalingUrl,
    sessionToken,
    expiresIn
    // no capabilities field
  };
}
```

### Step 3 — `connectWithCredentials()` never sets capabilities

On the browser side, `connectWithCredentials()` stores the credentials fields but never touches `this.capabilities`, which was initialized to `{ image_to_video: false }` in the constructor:

```js
// SDK internals — connectWithCredentials()
async connectWithCredentials(credentials, handlers) {
  // ...
  this.sessionId = credentials.sessionId;
  this.currentSignalingUrl = credentials.signalingUrl;
  this.sessionToken = credentials.sessionToken;
  // this.capabilities is never set — stays { image_to_video: false } ✗
}
```

### Why the old direct API-key flow worked

In the direct flow (`connect()` with API key), the SDK itself calls `requestSessionFromApi()` and correctly propagates capabilities to `this.capabilities`. That code path was never broken. The bug was introduced specifically in the `createClientCredentials` / `connectWithCredentials` path.

---

## Observed Failure

Calling `startStream({ image: file })` after `connectWithCredentials()` fails because the SDK checks `this.capabilities.image_to_video` before accepting an image argument. With `image_to_video: false`, the call is rejected even though the session was provisioned correctly on the server.

---

## Current Workaround

We are patching the SDK object manually in our `OdysseyService` wrapper immediately after instantiation, before any connection is made:

```ts
// src/lib/odyssey.ts — OdysseyService constructor
constructor(credentials: ClientCredentials) {
  this.credentials = credentials;
  this.client = new Odyssey({});
  // Workaround: connectWithCredentials drops capabilities, so image_to_video stays false.
  // Our server always provisions i2v-capable sessions, so force it true here.
  (this.client as unknown as { capabilities: { image_to_video: boolean } }).capabilities.image_to_video = true;
}
```

This works because our server always provisions i2v-capable sessions — the session itself is correctly set up. The SDK object just doesn't know it.

This is a brittle workaround for two reasons:
1. It accesses a private internal property via a type cast — it will break silently if the SDK's internal structure changes.
2. It unconditionally forces `image_to_video: true` regardless of what the session was actually provisioned with. If a session genuinely doesn't have i2v capability, this would mask the error.

---

## Requested Fix

The fix is straightforward. In `createClientCredentials()`, pass `session.capabilities` through to the return value:

```js
// Suggested fix — createClientCredentials()
async createClientCredentials() {
  this.requireApiKey();
  await this.exchangeApiKeyForToken();
  const session = await this.requestSessionFromApi(...);
  const tokenInfo = await this.fetchSessionToken(session.sessionId);
  return {
    sessionId: extractSessionId(tokenInfo.token),
    signalingUrl: session.signalingUrl,
    sessionToken: tokenInfo.token,
    expiresIn: tokenInfo.expiresIn,
    capabilities: session.capabilities  // ← add this
  };
}
```

Then in `connectWithCredentials()`, apply the capabilities if present:

```js
// Suggested fix — connectWithCredentials()
async connectWithCredentials(credentials, handlers) {
  // ...existing fields...
  if (credentials.capabilities) {
    this.capabilities = credentials.capabilities;  // ← add this
  }
}
```

No changes are needed on the client application side once this is fixed.

---

## Environment

- SDK: `@odysseyml/odyssey` (latest as of 2026-04-12)
- Connection method: `connectWithCredentials()` (secure credentials flow)
- Server: Node.js / Express — provisions sessions via `createClientCredentials()`
- Browser: Chrome / Edge (Chromium-based)
