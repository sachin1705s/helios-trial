---
title: TTS Audio Silent / Fails — Raw PCM Must Be Decoded Manually
category: runtime-errors
date: 2026-04-08
tags: [audio, tts, web-audio-api, pcm, content-type, smallest-ai, streaming]
components:
  - /api/character/tts (server/index.js)
  - playCharacterTTS (src/App.tsx)
symptoms:
  - "EncodingError: Unable to decode audio data (decodeAudioData throws on raw PCM)"
  - "NotSupportedError: Failed to load because no supported source was found (HTMLAudioElement fallback)"
  - Character speaks (TTS request succeeds, status 200) but no audio plays
---

## Problem

Character TTS responses return HTTP 200 with audio data, but no sound plays in the browser. Two errors appear in the console:

```
EncodingError: Unable to decode audio data
NotSupportedError: Failed to load because no supported source was found
```

The server (`/api/character/tts`) streams raw 16-bit signed little-endian PCM audio from the Smallest AI `lightning-v3.1` endpoint with these response headers:

```
Content-Type: audio/pcm
X-Sample-Rate: 24000
X-Bit-Depth: 16
X-Channels: 1
```

## Root Cause

`AudioContext.decodeAudioData()` only handles **encoded/containerized** formats (MP3, WAV, OGG, AAC). It does not understand raw PCM — bare sample data with no container header — and throws `EncodingError` immediately.

The fallback of creating `new Audio(url)` from a blob typed as `audio/pcm` also fails because **`audio/pcm` is not a valid browser MIME type** for `HTMLAudioElement`. Browsers cannot decode it even as a fallback.

An earlier attempted fix wrapped PCM in a WAV header (`pcmToWav()`) before calling `decodeAudioData()`. This worked but was removed in favour of the simpler direct approach below.

## Solution

Detect the `audio/pcm` content-type header and manually decode the raw PCM into a Web Audio `AudioBuffer`. This bypasses `decodeAudioData()` entirely.

**`src/App.tsx` — `playCharacterTTS` function:**

```typescript
const contentType = ttsRes.headers.get('content-type') || '';
const sampleRate = parseInt(ttsRes.headers.get('x-sample-rate') || '24000', 10);

if (contentType.includes('pcm') || contentType.includes('octet-stream')) {
  // Raw 16-bit signed little-endian PCM — decode manually
  const samples = new Int16Array(arrayBuffer);
  const float32 = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    float32[i] = samples[i] / 32768;   // normalise Int16 → Float32 [-1, 1]
  }
  const buffer = ctx.createBuffer(1, float32.length, sampleRate);
  buffer.copyToChannel(float32, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
} else {
  // Encoded formats (MP3, WAV, OGG) — use the standard path
  const decoded = await ctx.decodeAudioData(arrayBuffer);
  const source = ctx.createBufferSource();
  source.buffer = decoded;
  source.connect(ctx.destination);
  source.start();
}
```

**Why `/ 32768`?** 16-bit signed integers range from -32768 to +32767. Dividing by 32768 (2¹⁵) maps them to the Float32 range [-1.0, 1.0] that the Web Audio API expects.

**Why read sample rate from header?** The Smallest AI API requests `sample_rate: 24000` but this could change. Reading `X-Sample-Rate` from the response makes playback correct if the server ever changes the rate without a client-side deploy.

## Key Facts

| Fact | Detail |
|------|--------|
| `decodeAudioData()` supports | MP3, WAV, OGG, AAC, FLAC — encoded containers only |
| `decodeAudioData()` does NOT support | Raw PCM, `audio/pcm`, `application/octet-stream` |
| `HTMLAudioElement` MIME types | `audio/mpeg`, `audio/ogg`, `audio/wav` — NOT `audio/pcm` |
| Smallest AI PCM format | 16-bit signed little-endian, mono, 24kHz |
| Normalisation formula | `float32 = int16 / 32768` |

## Prevention Checklist

When integrating **any** new streaming audio API:

- [ ] Inspect actual response headers with curl/Postman before writing client code
- [ ] If `Content-Type` contains `pcm` or `octet-stream` → plan for manual decoding
- [ ] If API docs mention "PCM" or "raw audio" → `decodeAudioData()` will not work
- [ ] Confirm sample rate from docs or headers; never hardcode if a header is available
- [ ] Confirm bit depth (8 / 16 / 32-bit) and channel count (mono / stereo)
- [ ] Confirm byte order (little-endian is standard for PCM; big-endian would use `DataView`)
- [ ] Never use `HTMLAudioElement` as a fallback for `audio/pcm` blobs — it will silently fail

## Manual Smoke Test

Open the browser console on any character slide and run:

```javascript
const ctx = new AudioContext();
await ctx.resume();

const res = await fetch('/api/character/tts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Testing one two three.' })
});

console.log('content-type:', res.headers.get('content-type'));
console.log('sample-rate:', res.headers.get('x-sample-rate'));

const buf = await res.arrayBuffer();
const int16 = new Int16Array(buf);
const f32 = new Float32Array(int16.length);
for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
const ab = ctx.createBuffer(1, f32.length, 24000);
ab.copyToChannel(f32, 0);
const src = ctx.createBufferSource();
src.buffer = ab;
src.connect(ctx.destination);
src.start();
console.log('playing, duration:', (f32.length / 24000).toFixed(2), 's');
```

Expected: audio plays and console shows `playing, duration: X.XX s`.

**Common silent-failure causes:**
- `AudioContext.state` is `suspended` — needs a user gesture before `resume()` works
- System or browser volume muted
- `arrayBuffer.byteLength` is 0 or suspiciously small (< 200 bytes) — server error, check server logs

## Related Files

- [`src/App.tsx`](../../src/App.tsx) — `playCharacterTTS` function (~line 703)
- [`server/index.js`](../../server/index.js) — `/api/character/tts` route (~line 900)
