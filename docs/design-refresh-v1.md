# Design Refresh — v1

> A reference build to evaluate three design directions for Interact Studio.
> Branch: `design-refresh-v1`. Routes added under `/demo/*` — the existing
> live app at `/` is untouched.

## What's in this branch

| Route                          | Direction       | Fidelity | Purpose                                       |
| ------------------------------ | --------------- | -------- | --------------------------------------------- |
| `/demo`                        | —               | Index    | Hub linking to all five preview routes        |
| `/demo/landing`                | Atrium          | High     | Marketing landing page (recommended)          |
| `/demo/home`                   | Atrium          | High     | Character chooser — all 8 characters          |
| `/demo/character/:id`          | Atrium          | High     | Single-character "stage" with 4 voice states  |
| `/demo/landing-storyline`      | Storyline       | Low      | Picture-book aesthetic comparison             |
| `/demo/landing-studio`         | Studio Black    | Low      | Cinematic dark aesthetic comparison           |

The existing app continues to handle every other route via the catch-all
`<Route path="*" element={<App />} />`.

---

## Audit summary — what was wrong before

A short version of the full review. (Full audit in conversation history.)

1. **Positioning unreadable.** Hero "Media that responds to you" did not say what
   the product actually is or who it is for. Mixed kid + adult character
   lineup forced visitors to do the segmentation work.
2. **Two design languages stapled together.** Editorial cream/Fraunces outside;
   dark monospace dev-tool inside. Brand whiplash on first click.
3. **Broken CTA hierarchy.** Primary action ("Watch a conversation") rendered
   smaller and quieter than the secondary nav ("Get in touch"). Character-card
   CTA ("Animate it") was hover-only — invisible on mobile.
4. **Auto-opening video modal hijacked the homepage.** The exact passive-media
   pattern the product is supposed to be the answer to.
5. **Four loaded type families** (Fraunces, Work Sans, Space Grotesk, IBM Plex
   Mono) for an 8-card site.
6. **No "how it works", no "what's different", no "what you get"** sections.
   Only a hero and a grid.
7. **Footer wordmark + Discord/X/Instagram** read like an agency portfolio,
   not a product.
8. **Accessibility tells:** card buttons combine name + paragraph + image with
   no semantic separation; modal close uses raw `✕` character with no
   `aria-label`; contrast on cream-photo gradients is borderline.

---

## Design direction — Atrium (recommended)

> Warm editorial outside. Cinematic inside. Same DNA, two intensities.

### Why Atrium

- **Reuses what's already best.** The 3D character renders, the cream paper,
  the dark-green ink, the Fraunces serif — all of that is *good*. The
  mistake was that the existing site stops developing the aesthetic
  exactly where it should be cashing in (CTA, IA, copy, motion). Atrium
  carries the same identity into every screen.
- **Survives a pivot.** The user explicitly said the audience is not locked
  in. Atrium reads as confident editorial — works for parents, curious
  adults, creators, families. None of the three directions feels like a
  "kids product" by default; Atrium has the most room to slide warmer (toward
  Storyline) or darker (toward Studio Black) if the audience locks in later.
- **Anti-generic.** No purple gradients. No glassmorphism. No terminal
  monospace. Looks unlike every voice-AI demo on Twitter — which is the
  point.

### Color tokens

| Token         | Hex       | Use                                |
| ------------- | --------- | ---------------------------------- |
| `--paper`     | `#F5F1E8` | Outer background (warm cream)      |
| `--mist`      | `#E8E3D5` | Section tint                       |
| `--ink`       | `#142826` | Primary text (deep forest, not pure black) |
| `--ink-soft`  | `#3E5450` | Secondary text                     |
| `--moss`      | `#2F5E48` | Eyebrows, secondary accents        |
| `--moss-deep` | `#1F4632` | Italic emphasis in headings        |
| `--clay`      | `#D9492B` | Primary CTA + emotional accent     |
| `--sun`       | `#F0B546` | Highlights, "live" indicators      |
| `--night`     | `#0E1614` | Inner-mode background, dark footer |
| `--glow`      | `#F8E5C8` | Inner-mode highlight, warm light   |

Inner mode (the character stage) is **not** a switch to a different palette.
It uses the same family, just inverted: `night` reads like dusk against
`paper`'s noon. That's the cinematic-inside effect with zero brand
whiplash on click.

### Typography

- **Display:** Fraunces (variable, opsz). Already loaded by the site.
  Italic for emotional emphasis (one word per heading, not whole phrases).
- **Body:** Inter. Workhorse, ultra-legible.
- **Removed:** IBM Plex Mono and Space Grotesk. Two families is enough.

### Motion principles

- Slow, breath-paced. Default ease `cubic-bezier(0.22, 1, 0.36, 1)`. CTAs
  bounce with `cubic-bezier(0.34, 1.56, 0.64, 1)` only on the arrow, never
  the button itself.
- Cards translate `-4px` on hover, image scales `1.04` over 1.2s. No
  spring physics — Atrium is editorial, not playful.
- The voice orb on the character page has four distinct rhythms: idle
  (3s halo cascade), listening (1.4s pulse), thinking (2.4s rotation),
  speaking (0.8s breath).

---

## Page-by-page rationale

### `/demo/landing` — the marketing surface

**What's on it**

1. **Sticky nav** — minimal. Wordmark + 3 links + one primary CTA ("Try a
   character"). The existing site's "Get in touch" agency framing is gone.
2. **Hero** — asymmetric 1.05fr / 0.95fr split.
   - Left: eyebrow ("Real-time interactive voice"), display headline
     **"Worlds that *talk back.*"** — italic on the second clause for
     emphasis, primary CTA + secondary text-link CTA, three signal pills.
   - Right: an inline (not modal) "viewfinder" video — `Starter-Demo.mp4`
     muted/looped/autoplay, slight 0.6° tilt that straightens on hover.
     "LIVE" chrome top-left, italic caption bottom. Treats the demo
     **as the hero**, not as a popup behind the hero.
3. **How it works** — three numbered steps in cream cards on a `mist`
   strip. Display-serif giant numerals, kid-friendly title, parent-readable
   body.
4. **Manifesto / "the opposite of passive"** — three "Not a feed / Not a
   script / Not a chatbot" cards, each with a strikethrough headline and
   the actual product position underneath. Anti-feed positioning, plainly
   stated.
5. **Featured cast preview** — 4 character cards on a `mist` strip,
   linking through to the full home and the character pages. CTA "Talk
   to {name}" replaces the generic "Animate it".
6. **Quote block** — single editorial pullquote on a clean `paper` strip
   with a giant punctuation mark in moss tint.
7. **Footer** — dark `night` mode footer with three columns and a small
   sign-off line ("Made for curious minds, anywhere") that keeps the
   audience deliberately ambiguous.

**Why the copy is what it is**

The user explicitly asked the audience to remain ambiguous so new users
do not feel awkward trying it out. The headline "Worlds that talk back"
works for:

- A 30-year-old who wants to try voice AI ("worlds I can talk to — neat")
- A parent ("worlds that respond to my kid — that's interactive, not
  passive")
- A creator ("interactive media — what's the format?")
- A kid ("a bear that talks back to me — okay")

None of those readings feel awkward; none feel pandered to. The
sub-copy ("speak in your own voice, no script, no scroll, no autoplay
feed in sight") leans on the *anti-feed* framing — that's the position
that actually differentiates the product, regardless of audience.

**What was wrong before — fixed here**

- Hero is no longer abstract poetry. It says what the thing is.
- The video is **inline**, not modal. No autoplay hijack.
- One unmissable primary CTA. Top-right nav uses the *same* CTA, not a
  competing "Get in touch."
- "Animate it" → "Talk to {name}" — speaks to what users actually do.
- "How it works", "What's different", and a manifesto section all
  appear — the previous site had none.
- Two type families instead of four.

**What I'd test next**

- A/B the hero headline against "Talk to anything." (4 syllables, more
  visceral, possibly clearer for a non-English-first reader).
- Add a "What you can do" sub-grid below "How it works" with three
  example conversations as text excerpts (proof, not promise).
- A pricing/access strip near the bottom once the model is ready.

---

### `/demo/home` — the character chooser

**What's on it**

1. **Header strip** — same nav, then a 1fr/auto split: title left ("Choose
   your *conversation.*"), filter pills right (`All eight`, `Storytellers`,
   `Historical`, `Modern minds`). Pills count their members so the user
   sees the catalogue size.
2. **Featured row** — two oversized 4:3.2 cards (currently Bear + Da
   Vinci) with the character image full-bleed, gradient overlay, and the
   character's *greeting line* surfaced on the card. The greeting is
   already in `characters.json` — reusing real data, exactly as the
   user requested.
3. **Cast row** — 3-up grid of the remaining 6 characters, lighter
   treatment but still tappable. CTA visible on every card, no hover
   dependency.
4. **Empty state** — if a filter returns 0 (rare but possible if the
   tags get edited), the user gets a friendly fallback with a one-click
   "see all eight" link.

**Why the layout is what it is**

The user wanted all 8 characters visible without a "show more" gate.
But uniform 4×2 (the existing site's layout) makes everything look
equally important and removes any editorial point of view. So the
solution is **hierarchy, not omission**: feature 2 strongly, present 6
quietly. The user can still scroll, filter, or click any of them — but
the page now *tells you where to start* instead of presenting a wall.

**What was wrong before — fixed here**

- 4×2 dense grid → 2-up featured + 3-up secondary. Density-without-hierarchy
  fixed.
- "Animate it" hover-only CTA → permanent visible CTA on every card.
- Generic body copy on every card → real character greeting on the
  featured cards (much more emotional/tactile).
- No filter / segmentation → optional pills, still ambiguous-friendly
  (set to "All eight" by default).

**What I'd test next**

- Rotate the featured pair on each visit (random / time-of-day / based
  on past activity).
- Add a "Most popular this week" sub-shelf once analytics are flowing.
- A/B "Talk to {firstName}" CTA vs "Begin {character}".

---

### `/demo/character/:id` — the stage

**What's on it**

1. **Stage layer** — the character image full-bleed, with a subtle
   ambient parallax (`stage-float` 22s ease infinite, ~1% drift) and a
   radial veil so the character reads against any background. This
   replaces the existing in-app live-video which only renders when
   credentials are present.
2. **Top HUD** — three-column grid: back-link (left), title with
   subtitle (center), three controls (mute, settings, end-session)
   (right). Glassmorphic on the live video, but minimal — gets out of
   the way.
3. **Demo banner** — an honesty layer that says "Demo preview — voice
   and world-model require live API credentials" + a button to
   `auto-cycle` through the four states. The existing live-API call
   (`/api/odyssey/token`) can be wired in later by replacing the
   banner with a credentials-fetched live stream.
4. **Reply layer** — surfaced in the upper-middle when the phase is
   `listening` or `speaking`. Italic display serif for the character's
   reply (matches the editorial inside-mode); body sans for the user's
   transcript.
5. **Voice console** (bottom center) — three things stacked:
   - **The orb.** 96px button, four phase variants. Idle = breathing
     halos. Listening = fast pulse + tighter halos. Thinking =
     rotation. Speaking = sharp breath. Each rhythm is timed to feel
     like a different *kind* of attention. Tap toggles
     listening/thinking.
   - **Starter prompts.** Three character-specific, italic display
     serif chips. Visible only in `idle`; dim out (not removed) in
     other phases so the layout stays stable. Each is keyed off the
     character (`promptsByCharacter` in `Character.tsx`) to feel
     custom-written.
   - **State switcher.** A small pill-group letting the reviewer flip
     phases manually for evaluation. Hidden in production by removing
     the component; kept for demo review only.
6. **Side rail** — a vertical strip of the other 7 characters so the
   user can switch without losing the stage frame. Hidden under
   880px-wide breakpoints.

**Why the design is what it is**

The voice orb is the most important UI on the entire product — it's
the user's only affordance. So it gets the most motion variety, most
contrast, and most affordance vocabulary. The four states are
distinguishable by **rhythm**, not just color, so users with reduced
contrast vision can still read what's happening.

The demo banner is opinionated: instead of mocking a fake-but-claimed
live experience, it tells the truth. Real character data, real images,
real character-specific prompts; mocked phase transitions. Honest
demos win trust faster than convincing-but-fake ones, especially with
parents and decision-makers.

**What was wrong before — fixed here**

- Existing in-product UI assumes live credentials and renders a black
  screen + dev console without them. New stage works without env vars
  and stays evaluable.
- Voice orb in the existing app is small (~64px) and easy to miss. New
  orb is 96px with multiple halo rings — the "tap and speak"
  affordance is unmissable.
- Existing character page has no "switch character" path — you go back
  to home, then click. New side rail keeps continuity.
- "End session" was a small `✕` with no `aria-label`. Now it's a
  full-text button.

**What I'd test next**

- A subtle character idle animation on the stage image itself
  (lipsync rest-state, eye-blink) — much harder to do without the live
  pipeline, but worth doing for the kid attention loop.
- Real-time live transcript streaming (currently a single-line
  placeholder). Should appear word-by-word during `listening`.
- Time-remaining HUD when parents set a session length (when that
  feature ships).

---

## Variant landings (low fidelity, for comparison)

### Storyline — `/demo/landing-storyline`

**Concept.** Picture-book first. Crayon palette, 2-3px ink borders, sticker
shadows (offset solid drop-shadow), rounded chunky type for kid-facing
copy.

**Tokens.**

| Token             | Hex       |
| ----------------- | --------- |
| `--cream`         | `#FFF8EB` |
| `--ink`           | `#1F2540` |
| `--crayon-red`    | `#E6553F` |
| `--crayon-blue`   | `#4A7BD9` |
| `--crayon-yellow` | `#F2C14E` |
| `--crayon-green`  | `#5BA67A` |
| `--crayon-purple` | `#8262C4` |

**Type.** Reckless Neue (display, hand-set feel) + Inter (body) + Nunito
(rounded, kid-facing CTAs).

**Why look at it.** Highest "this is for kids" legibility on first
glance. Best if the audience locks in to the parents-of-young-kids
buyer eventually.

**Why I didn't recommend it.** It commits hard to a young audience.
The user said the audience is deliberately ambiguous — Storyline
would feel infantilizing to a 30-year-old curious adult who landed
from Twitter.

### Studio Black — `/demo/landing-studio`

**Concept.** Cinematic, A24-website premium. Full-bleed video hero, 1px
hairlines, restrained gold + ember accents on near-black, dramatic
display serif (Fraunces light at 168px).

**Tokens.**

| Token        | Hex       |
| ------------ | --------- |
| `--obsidian` | `#0A0B0F` |
| `--chalk`    | `#F2EEE6` |
| `--ember`    | `#E84F2A` |
| `--gold`     | `#D4A24C` |
| `--forest`   | `#1F3A2E` |

**Type.** Fraunces (display, very light weight) + Inter (body) + IBM
Plex Mono (small typographic detail like timecodes).

**Why look at it.** Highest perceived production value. Best for
press, investors, and a "Pixar of voice AI" pitch deck. Naturally
matches the dark inner stage so there's zero brand whiplash on click.

**Why I didn't recommend it.** Reads "media company" before "kids
product" or "consumer voice AI". Loses the warmth your character
art conveys. If the future lock-in is "premium A24-style brand for
adults", Studio Black is the right answer; for ambiguous-now, Atrium
keeps more options open.

---

## Tech notes

- **Stack unchanged.** Vite + React 18 + TS. Added `react-router-dom@^7`
  to enable the new routes. Did not touch `App.tsx`, `App.css`,
  `index.css`, or any existing component — the live site at `/` still
  renders identically.
- **Routing.** `BrowserRouter` in `main.tsx`. Catch-all `*` route falls
  through to the existing `App` component, so any route the demo
  doesn't claim still works.
- **CSS scoping.** Each direction's CSS is namespaced under a single
  root class (`.atrium`, `.storyline`, `.studio`). No global selector
  leaks. Tokens live in `src/demo/shared/tokens.css` and are scoped to
  the same root classes.
- **Vercel SPA fallback.** Added `/demo` and `/demo/(.*)` rewrites in
  `vercel.json` so direct hits/refreshes on `/demo/character/bear`
  don't 404 in production.
- **API approach.** Live-API probe of the deployed site identified two
  meaningful endpoints: `/api/log` (telemetry, no UI value) and
  `/api/odyssey/token` (gates a live WebRTC session that needs
  `OdysseyService` + valid keys). For the demo, real character data
  is reused from `src/data/characters.json` and real character images
  from `/public/images/character-background/`. The four voice phases
  are driven by `?state=` URL params with an opt-in auto-cycle for
  flowing review.

---

## File map

```
src/main.tsx                              # +5 routes; existing App is the catch-all
src/demo/Index.tsx                        # /demo — preview index
src/demo/Index.css
src/demo/shared/tokens.css                # all tokens, scoped per direction
src/demo/shared/characters.ts             # imports the existing characters.json

src/demo/atrium/Landing.tsx + Atrium.css  # /demo/landing
src/demo/atrium/Home.tsx + Home.css       # /demo/home
src/demo/atrium/Character.tsx + Character.css  # /demo/character/:id

src/demo/storyline/Landing.tsx + Storyline.css # /demo/landing-storyline
src/demo/studio/Landing.tsx + Studio.css       # /demo/landing-studio

vercel.json                               # +2 rewrites for /demo SPA fallback
```

---

## Decision needed from review

1. **Pick a direction.** Atrium / Storyline / Studio Black — or a
   blend. (Recommendation: Atrium.)
2. **Confirm copy direction.** "Worlds that talk back" / "anti-feed"
   positioning — keep, soften, or change entirely?
3. **Featured pair on home.** Bear + Da Vinci is the current pick. Any
   override?
4. **What to do with the existing live `/`.** Once a direction is
   picked, do we cut over `/` to the new Atrium landing in a follow-up
   PR, or run them side-by-side as `/demo/*` for a few weeks of testing?
