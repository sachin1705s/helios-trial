# Debugging Logs

## Overview

Debug logs for the Odyssey stream pipeline and TTS pipeline are present throughout `src/App.tsx` but are **silent by default in production**. This prevents internal details (like prompts sent to Odyssey) from being visible to end users in the browser console.

The logs use a small `debug()` helper defined at the top of `src/App.tsx`:

```ts
const debug = (...args: unknown[]) => {
  if (import.meta.env.DEV || localStorage.getItem('debug') === 'true') {
    console.log(...args);
  }
};
```

- In **development** (`vite dev`) — logs are always on.
- In **production** — logs are off unless you manually enable them (see below).

`console.error` and `console.warn` calls are unaffected and always visible — these represent actual failures.

---

## Enabling logs in production

1. Open the browser **DevTools console** on the production URL (F12 → Console tab).
2. Run:
   ```js
   localStorage.setItem('debug', 'true')
   ```
3. **Refresh the page.** Logs will now appear.

To turn them off again:
```js
localStorage.removeItem('debug')
```
Then refresh.

---

## What the logs cover

### `[odyssey]` — Odyssey stream lifecycle

| Log | What it tells you |
|-----|-------------------|
| `onConnected — stream:` | WebRTC stream object attached; video should start |
| `status:` | Connection status changes (connecting, connected, etc.) |
| `onStreamStarted` | Stream is live and ready for interact() calls |
| `onStreamEnded` | Stream ended; auto-restart will be attempted |
| `auto-restarting stream after end` | Retry logic fired |
| `moderation_failed — retrying (attempt N)` | Odyssey blocked the prompt; retrying up to 3 times |
| `calling startStream — slide: X | prompt: ...` | Which slide and prompt were sent to Odyssey |
| `startStream resolved` | Odyssey accepted the stream request |

### `[tts]` — Text-to-speech pipeline

| Log | What it tells you |
|-----|-------------------|
| `playCharacterTTS called, text:` | TTS was triggered and what text was sent |
| `AudioContext state:` | Whether the AudioContext is running/suspended |
| `AudioContext resumed` | Context successfully resumed after user gesture |
| `sending fetch to /api/character/tts, voiceId:` | Which voice was resolved for the slide |
| `server response status:` | HTTP status from the TTS API |
| `content-type:` | Whether the response is streaming PCM or buffered WAV |
| `streaming PCM playback started, sampleRate:` | Streaming path taken; confirms sample rate |
| `streaming playback scheduled, total duration:` | All PCM chunks scheduled; total audio length |
| `arrayBuffer size:` | Buffered path taken; size of the audio response |
| `decoded audio duration:` | Web Audio successfully decoded the response |
| `audio playback started` | Audio node started playing |
| `fallback audio playback started` | Web Audio decoding failed; fell back to HTMLAudioElement |

---

## Adding new debug logs

Use `debug()` instead of `console.log()` anywhere in `src/App.tsx`:

```ts
debug('[my-feature] something happened:', someValue);
```

This ensures the log respects the same on/off behaviour as the rest of the debug output.
