# Gesture Experiment — Engineer Handoff

**Branch:** `experiment/gestures`  
**Date:** 2026-05-09  
**Route:** `/lab/gesture`

---

## What We're Building

A timed discovery game built on top of the Body Language experiment. Einstein (an Odyssey AI avatar) has been given baked-in reactions to 10 specific gestures. Users don't know which gestures trigger reactions — they have 3 minutes to find all 10. The mechanic turns a passive webcam demo into something with stakes, a daily return hook, and a score worth sharing.

**The pitch to users:** *"I baked specific reactions into Einstein for 10 gestures. You have 3 minutes to find them all."*

### How It Works

1. User lands on `/lab/gesture` → Einstein streams via Odyssey, webcam is off
2. User turns on webcam → gesture detection starts (Gemini Vision, every 1.5s)
3. Each webcam frame is sent to `/api/gesture-vision` → returns the detected gesture label
4. When a new gesture is detected, Einstein reacts (`interact()` call to Odyssey) and it's logged as discovered
5. Counter shows **X / 10** — no gesture names shown, just the count (discovery stays rewarding)
6. Timer hits 0 or user finds all 10 → results screen with score + share button
7. One attempt per day, gated by `localStorage`

**Gesture vocabulary (10 gestures, A/B tested):**
`hello`, `thumbs_up`, `victory`, `namaste`, `pointing`, `thinking`, `shrug`, `crossed_arms`, `facepalm`, `clapping`

**Interact prompt (Variant D — won A/B test):**
`"The user just did {gesture label}. React!"`

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
| SEO: `applySeo(SEO_PAGES.gesture)` wired up on mount | ✅ Done |
| `SEO_PAGES.gesture` entry in `src/lib/seo.ts` | ✅ Done |

---

## What's Left — Prioritised

### P0 — Blocks launch

**1. OG invite image (`public/images/og-gesture.png`)**

The share infrastructure is fully wired — `SEO_PAGES.gesture` already points at this file. Without it, link unfurls on Twitter/Discord/Slack/iMessage will show a broken image or fall back to the default forest image. This is the single remaining deliverable for sharing to work.

Size: **1200 × 630px**

Design brief:
- **Left ~half:** Einstein full-bleed (use `public/images/character-background/einstein2.webp` or `characters/einstein.png`), fading into the right panel with a gradient edge
- **Right ~half:** Dark background `#0E1614`, thin moss-green left border `#2F5E48`
  - Eyebrow: `THE LAB · INTERACT STUDIO` — Inter 500, ~18px, `#2F5E48`, uppercase
  - Headline: `Find Einstein's 10 secret reactions` — Fraunces 600, ~72px, `#F5F1E8`
  - Sub: `3 minutes. Webcam. One attempt per day.` — Inter 400, ~24px, `#6B7B72`
  - URL pill at bottom: `interactstudio.space/lab/gesture` — moss bg, paper text

Drop the file into `public/images/og-gesture.png` and push. No code changes needed.

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

Things to check:
- Fraunces font loads before the card is drawn (it should — draw fires after `gameState === 'finished'` which is well after page load)
- Einstein image isn't clipped or distorted
- Encouragement text wraps correctly for the longest string ("Einstein kept most of his cards close.")
- Score `10` doesn't overflow the numeral area

---

### P2 — Nice to have, non-blocking

**4. Share event tracking**

PostHog is already connected. Adding a capture call to `handleShare` takes 2 minutes and gives visibility into how many people actually share.

```ts
// In handleShare, after a successful share:
posthog.capture('gesture_share', { score, method: 'web_share' | 'clipboard' | 'download' });
```

**5. "Play again tomorrow" email/notification hook**

Currently there's no way to re-engage users after they've played. A lightweight option: after the results screen appears, show an email field with "Remind me tomorrow" — stores in a simple list. Not designed yet, lower priority.

---

## Key Files

| File | What it does |
|------|-------------|
| `src/components/experiments/GestureExperiment.tsx` | Main experiment component — game logic, canvas draw, share flow |
| `src/components/experiments/GestureExperiment.css` | Game UI styles (timer, counter, flash, results, already-played) |
| `src/lib/seo.ts` | `SEO_PAGES.gesture` entry + `image?` support in `applySeo()` |
| `src/hooks/useOdysseyStream.ts` | Odyssey lifecycle — has 5× retry on `startStream` (race condition fix) |
| `server/index.js` | `/api/gesture-vision` — Gemini Vision classifier, returns `{ gesture }` |
| `public/images/og-gesture.png` | **MISSING — needs to be created** |

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
- **iOS 15+ / Android Chrome 75+** — full experience: native sheet, PNG image attached, can share directly to Instagram Stories, WhatsApp, etc.
- **Desktop Chrome/Edge** — system share dialog, file support inconsistent → Download Card button fills the gap
- **Desktop Firefox** — no `navigator.share` → clipboard text only → Download Card button fills the gap

---

## Running the Branch Locally

```bash
git checkout experiment/gestures
npm install
npm run dev
```

Navigate to `/lab/gesture`. You'll need:
- A `GEMINI_API_KEY` in `.env` for gesture classification
- Odyssey credentials (`ODYSSEY_*` env vars) for the avatar stream

The gesture test harness is at `/lab/gesture-test` if you need to validate Einstein's reactions without playing the full game.
