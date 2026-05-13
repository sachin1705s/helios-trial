# Gesture Experiment — Engineer Handoff

**Branch:** `experiment/gestures`  
**Date:** 2026-05-09  
**Route:** `/lab/gesture`

---

## What We're Trying to Build

Interact Studio's lab is a space for experimental AI character interactions — each experiment tests a different modality (voice, vision, gesture) to find what's compelling enough to bring into the main product. The gesture experiment tests whether an AI character responding to body language in real time is worth building out further.

The core idea: **Einstein has been programmed to react to 10 specific gestures.** Users don't know which ones. They have 3 minutes to trigger as many reactions as they can. The mechanic reframes what would otherwise be a passive webcam demo ("look, Einstein waves back") into something with stakes, curiosity, and a score worth sharing — which gives it both replay value and a viral loop.

This is the weakest experiment in the sprint on repeatability. The discovery game format was specifically chosen to fix that: a clear goal, a daily return hook ("come back tomorrow for another attempt"), and a shareable result ("I found 7/10 — can you beat me?") that pulls new users in.

**Success looks like:** Users playing the full 3 minutes, sharing their score, and returning the next day.

Measurement (PostHog, all trivial to add):
- **3-min play:** `game_complete` event with `{ score, timeLeft }` — `timeLeft === 0` = full play
- **Share:** `gesture_share` event with `{ score, method }` — see P1 below
- **Day-2 return:** users with a `gesture_start` on date N+1 who had `game_complete` on date N

---

## How It Works

1. User lands on `/lab/gesture` → Einstein streams live via Odyssey avatar
2. User turns on webcam → gesture detection starts polling every 1.5 seconds
3. Each frame is captured from the webcam, encoded as JPEG base64, and sent to `/api/gesture-vision`
4. Gemini Vision classifies the gesture → returns a label (or `'none'`)
5. If it's a new gesture the user hasn't triggered before, it's added to their discovered set and the counter bumps
6. Einstein reacts to every gesture change via `interact()` — whether or not it's new
7. Timer hits 0 or user finds all 10 → results screen with score + encouragement text
8. Results are saved to `localStorage` keyed by today's date — one attempt per day

**Gesture vocabulary (10 total, A/B tested — leaning gestures removed, failed all prompt variants):**
`hello`, `thumbs_up`, `victory`, `namaste`, `pointing`, `thinking`, `shrug`, `crossed_arms`, `facepalm`, `clapping`

**Interact prompt (Variant D — won A/B test, fastest + highest pass rate):**
`"The user just did {gesture label}. React!"`

---

## What's in the Code

### Frontend — `src/components/experiments/GestureExperiment.tsx`

The main component. Everything runs client-side except the Gemini classification call.

**Odyssey avatar lifecycle**
```
useOdysseyStream() hook → connect() → startStream({ image, prompt }) → interact(prompt)
```
- `useOdysseyStream` manages the WebRTC connection, heartbeat, and lease. It has a 5× retry loop on `startStream` with 200ms backoff — this fixes a race condition where `onConnected` fires before the SDK's internal state fully settles.
- `videoRef` from the hook is attached to the Einstein `<video>` element directly.

**Webcam capture pipeline**
```
getUserMedia() → <video> → drawImage onto <canvas> → toDataURL('image/jpeg', 0.7) → base64 string
```
- `captureFrame()` is synchronous — uses `canvas.toDataURL()` not `canvas.toBlob()` (which is async and was a bug in the original code)
- Captured base64 is split from the data URL header and posted as JSON: `{ image: base64, mimeType }`

**Gesture polling**
- `pollGesture()` is called on a 1500ms `setInterval`
- It guards against overlapping calls with a `detectingRef` — **must be `useRef<boolean>`, not `useState`**. `useState` values are captured by value in the `setInterval` closure and are always stale; the interval always reads the initial `false`, allowing two polls to fire concurrently. Use `useRef(false)` so the mutable container is read correctly from inside the callback.
- On a 429 from the server, polling stops entirely (rate-limit backoff)
- On gesture change → fires `interact()` to make Einstein react
- **Known gap:** `stopWebcam` stops the stream and polling but does not call `finishGame()`. If the user turns off the webcam mid-game, the timer continues and the score is not persisted until it naturally expires. Fix: add `if (gameState === 'playing') finishGame()` inside `stopWebcam`.
- On new gesture (not yet in discovered set) → updates game state, triggers flash toast

**Game state machine**
```
'idle' → startGame() → 'playing' → finishGame() → 'finished'
```
- `gameState` drives which panel is shown: already-played screen | results screen | active game UI
- `discoveredRef` is a `useRef<Set<string>>` that mirrors the `discovered` state — callbacks (like the polling interval) always read from this ref to avoid stale closures
- `pollGestureRef` is a `useRef` to `pollGesture` used by `startGame` to break a circular dependency (startGame sets up the interval, but pollGesture is defined later in the component)
- Timer is a plain `setInterval` decrementing `timeLeft` every second; expiry is caught by a `useEffect` watching `timeLeft === 0 && gameState === 'playing'`
- Attempt lock: `localStorage.setItem` fires at the start of `startGame` (before any gesture is found) so a page refresh after starting counts as a used attempt

**Canvas score card**
- `drawScoreCard()` is a module-level function (no closure, takes explicit args)
- `scorecardCanvasRef` is a hidden 1080×1080 `<canvas>` always in the DOM
- A `useEffect` watching `gameState === 'finished'` loads `einstein.png` then draws: background, inset panel, Einstein portrait, score numeral, `/10` label, word-wrapped encouragement text, divider, URL footer, CTA pill
- The card is drawn before the user taps "Share Result" — so there's no async wait on share

**Share flow**
```
canvas.toBlob() → File → navigator.share({ text, files }) → [OS sheet]
                                    ↓ unsupported/fails
                        navigator.clipboard.writeText(text) → "Copied to clipboard!"
```

**SEO**
- `applySeo(SEO_PAGES.gesture)` fires on mount, updating `og:title`, `og:description`, `og:image`, `og:url`, `twitter:*` and canonical link
- `SEO_PAGES.gesture.image` points at `/images/og-gesture.png` (static invite image — see P0 below)

---

### Backend — `server/index.js` → `/api/gesture-vision`

Receives: `POST { image: string (base64), mimeType: string }`

1. Constructs an inline image part for the Gemini Vision API
2. Sends to `gemini-2.0-flash` with a classification prompt listing the 10 allowed gesture labels + `none`
3. Parses the response text, validates it against the allowed list
4. Returns: `{ gesture: string }` — one of the 10 labels or `'none'`

Rate limited at the server level. Returns `429` when the limit is hit; the frontend stops polling on 429.

**⚠️ Security gaps (not yet addressed):**
- **No auth** — the endpoint is unauthenticated. Any external caller can POST to it and consume the Gemini API key indefinitely. Recommended fix: add a session/token check or same-origin guard before the Gemini call fires.
- **`mimeType` not validated** — the client sends `mimeType` and it's passed directly to the Gemini API. Add a server-side allowlist: accept only `image/jpeg`, `image/png`, `image/webp`.
- **No body size limit** — a large base64 payload exhausts memory before the 429 guard fires. Add `express.json({ limit: '2mb' })` on this route.

---

### Hook — `src/hooks/useOdysseyStream.ts`

Manages the full Odyssey lifecycle: credentials fetch → WebRTC connect → stream start → heartbeat → lease → disconnect. The key addition for this experiment: `startStream` now has a retry loop (5×, 200ms × attempt) to handle the race condition between `onConnected` and the SDK's internal state.

---

### Styles — `src/components/experiments/GestureExperiment.css`

Game UI classes added in this sprint:
- `.bl-game-row` — flex row holding timer + counter
- `.bl-timer` + `--urgent` modifier — monospace, turns clay + pulses when ≤30s remain
- `.bl-counter` + `.bl-counter-bump` — bumps on each new discovery (CSS animation, re-triggered via `key={discovered.size}` which forces a React remount)
- `.bl-flash` — "New reaction found!" toast, slides in on find
- `.bl-results` + sub-elements — results screen layout
- `.bl-already-played` + sub-elements — already-played screen layout

---

## What Needs to Be Tested

### Game Flow

| Scenario | Expected |
|----------|----------|
| Fresh visit (no localStorage) | Idle state, "Turn on Webcam" button, no already-played banner |
| Turn on webcam, click "Start Detecting" | Timer counts from 3:00, counter shows 0 / 10 |
| Turn on webcam → browser denies permission (`NotAllowedError`) | Error state shown: "Camera access is required. Please allow it in your browser settings." — "Start Detecting" stays disabled |
| Make a gesture → Einstein reacts | Flash "New reaction found!", counter bumps to 1 / 10, Einstein responds verbally |
| Same gesture again | Counter stays at 1 (deduped via Set), Einstein still reacts |
| Find all 10 gestures | Results screen appears immediately, timer stops |
| Let timer expire | Results screen with partial count, timer shows 0:00 |
| Refresh after playing | "Already played" screen shows today's score |
| Turn off webcam mid-game | ⚠️ Currently: polling stops but `finishGame()` is NOT called — timer keeps running, score is not saved until natural expiry. **Fix needed:** `stopWebcam` should call `finishGame()` when `gameState === 'playing'` |
| Under 30 seconds left | Timer turns clay colour and pulses |

### Gesture Detection

- Each of the 10 gestures should be recognisable by the Gemini classifier at a normal laptop webcam distance. Known hard ones: `namaste` (subtle), `facepalm` (hand on face, can read as `thinking`). Test in good lighting.
- `none` should return reliably when the user is just sitting still — confirms no phantom detections inflating the score.
- Send a gesture rapidly → confirm no duplicate counting (the `discoveredRef` Set dedupes this, but worth verifying under polling cadence).

### Einstein Reactions

- Trigger each gesture and observe the verbal response. The prompt is `"The user just did {label}. React!"` — responses should feel in-character and energetic, not generic.
- Watch for the avatar going silent after rapid gesture changes (interact() calls colliding). If it happens, check for errors in the Network tab on `/api/interact` or equivalent.
- Test with the Gesture Test Harness at `/lab/gesture-test` to trigger specific gestures manually without webcam.

### Share Flow

| Platform | Test |
|----------|------|
| iOS Safari (15+) | Tap "Share Result" → native share sheet opens with PNG attached |
| Android Chrome | Tap "Share Result" → native share sheet opens with PNG attached |
| Desktop Chrome (macOS/Windows) | Tap "Share Result" → system share dialog, or falls through to "Copied to clipboard!" |
| Desktop Firefox | Tap "Share Result" → falls through directly to clipboard |
| DevTools canvas check | `document.querySelector('canvas[width="1080"]').toDataURL()` → paste in address bar → score card renders correctly |

Score card visual QA checklist:
- [ ] Einstein portrait visible and not clipped
- [ ] Score numeral correct for the session's score
- [ ] Encouragement text wraps cleanly (worst case: "Einstein kept most of his cards close.")
- [ ] URL footer and CTA pill visible and legible on dark background
- [ ] Overall layout looks good at 1080×1080

### OG Image (once `og-gesture.png` is added)

Paste `https://interactstudio.space/lab/gesture` into:
- [ ] Twitter Card Validator (`cards-dev.twitter.com/validator`)
- [ ] LinkedIn Post Inspector (`linkedin.com/post-inspector`)
- [ ] Facebook Debugger (`developers.facebook.com/tools/debug`)
- [ ] Discord message (paste the URL and wait for unfurl)
- [ ] Slack message (paste the URL and wait for unfurl)
- [ ] iMessage (send the URL to yourself)

---

## Current State — What's Done

Everything below is committed and pushed to `experiment/gestures`.

| Area | Status |
|------|--------|
| Gesture detection pipeline (webcam → Gemini → gesture label) | ✅ Done |
| Einstein reacts via `interact()` on each new gesture | ✅ Done |
| 10-gesture vocabulary (A/B tested, leaning gestures removed) | ✅ Done |
| Discovery game: 3-min timer, 1 attempt/day, X/10 counter | ✅ Done |
| Results screen (score + encouragement text) | ✅ Done |
| Already-played screen (returns today's score on refresh) | ✅ Done |
| Game UI CSS (timer pulse at <30s, counter bump animation, flash toast) | ✅ Done |
| Canvas score card drawn on game finish (1080×1080, hidden) | ✅ Done |
| Share button: Web Share API (native sheet + image) → clipboard fallback | ✅ Done |
| SEO: `applySeo(SEO_PAGES.gesture)` wired up on mount | ⚠️ Code done — requires `og-gesture.png` (P0) + server-side meta tags to reach crawlers |
| `SEO_PAGES.gesture` entry in `src/lib/seo.ts` | ✅ Done |

---

## What's Left — Prioritised

### P0 — Blocks launch

**1. OG invite image (`public/images/og-gesture.png`) + server-side meta tags**

Two things are required for link unfurls to work — the image file and server-rendered meta tags. `SEO_PAGES.gesture` points at the image and `applySeo()` injects the OG tags at runtime, but Twitter, Discord, Slack, and iMessage crawlers fetch raw HTML and never execute JavaScript. The static `index.html` the server returns has no gesture-specific OG tags, so crawlers show a generic or broken preview regardless of whether the image exists.

**Image** — Size: **1200 × 630px**

Design brief:
- **Left ~half:** Einstein full-bleed (use `public/images/character-background/einstein2.webp` or `characters/einstein.png`), fading into the right panel with a gradient edge
- **Right ~half:** Dark background `#0E1614`, thin moss-green left border `#2F5E48`
  - Eyebrow: `THE LAB · INTERACT STUDIO` — Inter 500, ~18px, `#2F5E48`, uppercase
  - Headline: `Find Einstein's 10 secret reactions` — Fraunces 600, ~72px, `#F5F1E8`
  - Sub: `3 minutes. Webcam. One attempt per day.` — Inter 400, ~24px, `#6B7B72`
  - URL pill at bottom: `interactstudio.space/lab/gesture` — moss bg, paper text

Drop the file into `public/images/og-gesture.png`.

**Server-side meta tags** — Pick one approach:
- **Express middleware (recommended):** Add a handler in `server/index.js` that intercepts `GET /lab/gesture` and responds with a pre-rendered HTML string containing the correct `og:*` and `twitter:*` tags hard-coded (pointing at the image URL).
- **Build-time injection:** Use `vite-plugin-html` (or similar) to generate a separate `index.html` for the `/lab/gesture` route with the OG tags baked in at build time.

The `applySeo()` client-side call stays — it handles runtime page-title and meta updates for users already in the browser. The server-side fix is only for the crawler path.

---

### P1 — Makes it significantly better

**2. Desktop share — Download button**

`navigator.share()` on desktop Chrome/Edge is inconsistent. The current fallback is clipboard text only — users on desktop have no way to save and share the score card image. Adding a simple **Download Card** button next to the Share button solves this cleanly.

Implementation — add to the results screen in `GestureExperiment.tsx`:

```tsx
<button
  className="bl-btn bl-btn--ghost"
  onClick={() => {
    const canvas = scorecardCanvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = 'einstein-score.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  }}
>
  Download Card
</button>
```

This reuses `scorecardCanvasRef` which already exists and is already drawn when the game finishes. No new state or logic required.

**3. Score card visual QA**

The canvas card is drawn programmatically. Check it renders correctly by running the game, then in DevTools console:

```js
document.querySelector('canvas[width="1080"]').toDataURL()
// paste the output into browser address bar to preview the image
```

---

**3. Share event tracking**

PostHog is already connected. Adding a capture call to `handleShare` takes 2 minutes and gives visibility into how many people actually share — and the viral loop ("can you beat me?") is the experiment's core mechanic. Without this data, there's no way to know whether the mechanic is converting.

```ts
posthog.capture('gesture_share', { score, method: 'web_share' | 'clipboard' | 'download' });
```

---

### P2 — Nice to have, non-blocking

---

## Key Files

| File | What it does |
|------|-------------|
| `src/components/experiments/GestureExperiment.tsx` | Main experiment component — game logic, canvas draw, share flow |
| `src/components/experiments/GestureExperiment.css` | Game UI styles (timer, counter, flash, results, already-played) |
| `src/lib/seo.ts` | `SEO_PAGES.gesture` entry + `image?` support in `applySeo()` |
| `src/hooks/useOdysseyStream.ts` | Odyssey lifecycle — has 5× retry on `startStream` (race condition fix) |
| `server/index.js` | `/api/gesture-vision` — Gemini Vision classifier, returns `{ gesture }` |
| `public/images/og-gesture.png` | **MISSING — needs to be created and dropped in** |

---

## How Sharing Works (end to end)

```
Game finishes
    │
    ├─ useEffect fires → loads einstein.png → drawScoreCard() onto hidden 1080×1080 canvas
    │
User taps "Share Result"
    │
    ├─ canvas.toBlob() → File("einstein-score.png")
    │
    ├─ navigator.canShare({ files: [imageFile] }) ?
    │       YES → navigator.share({ text, files }) → native OS share sheet (iOS/Android)
    │       NO  → strip files, try navigator.share({ text }) → desktop share dialog
    │              FAILS/unsupported → clipboard.writeText(text) → "Copied to clipboard!"
    │
Link lands on Twitter/Discord/iMessage
    │
    └─ og:image resolves to /images/og-gesture.png → invite card preview appears
```

**Platform behaviour:**
- **iOS 15+ / Android Chrome 75+** — full experience: native sheet, PNG image attached
- **Desktop Chrome/Edge** — system share dialog, file support inconsistent → Download Card button fills the gap (P1)
- **Desktop Firefox** — no `navigator.share` → clipboard text only → Download Card button fills the gap (P1)

---

## Running Locally

```bash
git checkout experiment/gestures
npm install
npm run dev
```

Navigate to `/lab/gesture`. Required env vars:
- `GEMINI_API_KEY` — for gesture classification
- `ODYSSEY_*` vars — for the Einstein avatar stream

The gesture test harness at `/lab/gesture-test` lets you trigger specific gestures manually without the webcam — useful for testing Einstein's reactions in isolation.
