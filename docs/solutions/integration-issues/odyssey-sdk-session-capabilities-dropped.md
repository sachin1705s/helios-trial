---
title: Odyssey SDK streaming fails with image — session capabilities dropped by connectWithCredentials
date: 2026-04-07
category: integration-issues
tags:
  - odyssey-sdk
  - streaming
  - capability-flags
  - client-credentials
  - silent-failure
components:
  - src/lib/odyssey.ts
  - server/index.js
  - "@odysseyml/odyssey ^1.2.0"
problem_type: integration-issues
symptoms:
  - Characters do not animate; stream never starts
  - startStream({ image }) throws immediately — "Image-to-video is not supported by the current model"
  - Error occurs before data channel is touched (no timeout, instant rejection)
  - Text-only startStream({ prompt }) works fine; image variant fails
  - Legacy apiKey flow works; connectWithCredentials flow fails
---

# Odyssey SDK streaming fails with image — session capabilities dropped by `connectWithCredentials`

## Symptom

When calling `startStream({ image, prompt })` with a character portrait using the `connectWithCredentials` credential flow, the SDK throws immediately:

```
Error: Image-to-video is not supported by the current model.
Remove the image parameter or connect to a model that supports i2v.
```

The error fires before any data channel message is sent. Characters do not animate. The same call with no `image` parameter succeeds.

## Root Cause

The Odyssey SDK initializes every `Odyssey` instance with a conservative default:

```js
// node_modules/@odysseyml/odyssey/dist/index.js:616
this.capabilities = { image_to_video: false };
```

Before processing an image, `startStream()` checks this flag:

```js
// line 1317
if (image && !this.capabilities.image_to_video) {
  throw new Error("Image-to-video is not supported by the current model...");
}
```

**The legacy flow** (`new Odyssey({ apiKey })` + `client.connect()`) calls `requestSessionFromApi()` on the client. The API response includes `capabilities: { image_to_video: true }`, and the SDK stores it:

```js
// line 975
this.capabilities = apiResponse.capabilities;
```

**The new credentials flow** (`createClientCredentials()` + `connectWithCredentials()`) breaks this chain:

1. `createClientCredentials()` calls `requestSessionFromApi()` on the *server* — the API response includes `capabilities` — but the method returns only `{ signalingUrl, sessionToken, expiresIn }`. **Capabilities are silently dropped.**
2. `connectWithCredentials()` on the client never calls `requestSessionFromApi()`, so `this.capabilities` stays at the default `{ image_to_video: false }`.
3. `startStream({ image })` hits the guard and throws.

The server provisions sessions that always support i2v. The API is working correctly. The bug is entirely in the SDK's credential handoff.

## Investigation Steps

1. **Suspected `connectWithCredentials` timing** — All React timing fixes were already applied (pendingStartRef, retryStreamRef, startStreamInFlightRef mutex). Ruled out as root cause. *(auto memory [claude])*

2. **Built isolated test script** (`test-stream.html` + `src/test-stream.ts`) — Two modes: Test A (connectWithCredentials), Test B (legacy apiKey). Both passed *without* an image. Confirmed SDK and credentials flow are sound.

3. **Added character image to Test A** — Updated to pass `/images/characters/Alexander.png` (~779 KB), matching the app's actual `startStream` call. **Got the error.** Test B (apiKey with same image) still passed.

4. **Inspected SDK source** — Traced `this.capabilities` initialization (line 616), the capability guard in `startStream` (line 1317), and the two connection flows. Found that `createClientCredentials()` never writes back the capabilities it receives from the API.

## Solution

In `src/lib/odyssey.ts`, pre-set `image_to_video: true` on the `Odyssey` instance immediately after construction — before `connectWithCredentials` is called:

```typescript
// src/lib/odyssey.ts
constructor(credentials: ClientCredentials) {
  this.credentials = credentials;
  this.client = new Odyssey({});
  // connectWithCredentials doesn't propagate session capabilities from the API response
  // (SDK gap — createClientCredentials() drops the capabilities field). Our server always
  // provisions i2v-capable sessions, so pre-set this to unblock startStream({ image }).
  (this.client as unknown as { capabilities: { image_to_video: boolean } }).capabilities.image_to_video = true;
}
```

**Why this works:** The server always provisions i2v-capable sessions. By setting the flag before any streaming call, the `startStream` guard at line 1317 passes, and the actual i2v request proceeds over the data channel as normal.

**Same fix needed in `src/test-stream.ts`** for the isolated test script, since it creates `new Odyssey({})` directly:

```typescript
credClient = new Odyssey({});
(credClient as unknown as { capabilities: { image_to_video: boolean } }).capabilities.image_to_video = true;
```

## SDK Gap — Report to Odyssey

Three changes are needed in `@odysseyml/odyssey`:

1. **`createClientCredentials()` should include capabilities** in the returned `ClientCredentials` object — it already receives them from `requestSessionFromApi()`, it just drops them.
2. **`connectWithCredentials()` should apply capabilities** from the credentials object to `this.capabilities`.
3. **Migration guide** should warn that switching from `connect()` to `connectWithCredentials()` breaks image-to-video if `capabilities` are not propagated.

Alternatively: the SDK should invert the default — initialize `image_to_video: true` and only disable it when the API explicitly says the session doesn't support it.

---

## Detection

- `startStream({ image })` throws immediately with no timeout or network call → SDK capability flag is `false`
- Text-only `startStream({ prompt })` works fine alongside image failures → capability guard is the issue
- Test A (connectWithCredentials) fails, Test B (apiKey) passes → credential propagation gap confirmed
- Run `test-stream.html` as a 30-second smoke test: click **Run Test A** with an image → FAIL means capabilities not set

## Prevention

### On every `@odysseyml/odyssey` upgrade

- [ ] Check SDK changelog: does `ClientCredentials` now include a `capabilities` field?
- [ ] Check if `connectWithCredentials()` now calls the session API to populate capabilities
- [ ] Run `test-stream.html` → Run Test A with image → must reach **onStreamStarted** and show PASS
- [ ] Run `npm run build` to catch any type changes
- [ ] Check if the manual override is now redundant:

```typescript
// After upgrading, try removing the override and running test-stream.html.
// If Test A still passes, the SDK fixed it — delete the workaround and add:
// FIXED in @odysseyml/odyssey@X.Y.Z — capabilities now propagate automatically
```

### Maintaining the workaround

Keep the override in `OdysseyService.constructor()` with the SDK-gap comment. Add a dev-only warning so you notice if the SDK fixes it:

```typescript
if (import.meta.env.DEV && (this.client as any).capabilities?.image_to_video === true) {
  // This will warn if the SDK starts propagating capabilities on its own
  console.warn('[OdysseyService] capabilities.image_to_video already true — manual override may now be redundant');
}
```

### Code review signal

The `(client as unknown as { capabilities: ... })` type-escape in `OdysseyService` is intentional. If a reviewer sees it and wants to clean it up, direct them here — it's load-bearing until the SDK is fixed.

---

## Related

- `SECURITY.md` — Documents the April 2026 migration from direct API key to `createClientCredentials()` for client security. That migration is what introduced this gap.
- `src/lib/odyssey.ts` — Fix location; inline comment references this issue
- `src/test-stream.ts` + `test-stream.html` — Isolation test rig; run this first if streaming regresses
- SDK: `@odysseyml/odyssey ^1.2.0`
