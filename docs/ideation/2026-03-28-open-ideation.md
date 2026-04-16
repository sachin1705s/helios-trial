---
date: 2026-03-28
topic: open-ideation
focus: open-ended
---

# Ideation: Interact Studio — Open Ideation

## Codebase Context

**Project shape:** React 18 + TypeScript + Vite SPA, Express 5 backend as a single Vercel serverless function. Interactive AI character platform at interactstudio.space.

**Stack:** Odyssey ML (avatar streaming via WebRTC), Smallest AI (TTS/voice), Google Gemini (chat + gesture selection).

**Key observations:**
- Monolithic App.tsx (~900+ lines, 25+ useState, 15+ useEffect) — no routing, no hooks extracted
- Characters defined in `src/data/characters.json` — currently all have placeholder prompts (`"Animate it"`)
- `isCharacterThinking` state exists but is never used in UI
- `syncFromLocation` effect partially implements URL-based character selection but isn't completed
- Upstash Redis already wired in `server/index.js` (persistence is available)
- API keys are already server-side (client fetches token via `/api/odyssey/token`)
- Rate limiter uses in-memory store (acceptable tradeoff at current scale)
- `imageCacheRef` is an unbounded `Map<string, File>` — no eviction (25 MB max per image × N characters)
- Two server files (`api/server.js` + `server/index.js`) — api/server.js is already just 3 re-export lines
- `beforeunload` + `navigator.sendBeacon` for Odyssey lease release does not cover mobile tab abandonment

**Documented bug:** Odyssey stream hangs on character switch — fixed via synchronous refs in SDK callbacks (atomic read-and-clear pattern). Fix lives in monolithic App.tsx with no isolation.

**Past learnings:** The stream-hang fix must be preserved in any refactor: never sync a ref to React state via useEffect; write refs synchronously inside SDK callbacks.

---

## Ranked Ideas

### 1. Proactive Character Engagement
**Description:** Characters open with a line of dialogue before the user says anything (from an `openingLine` field in characters.json), display 2-3 personality-appropriate conversation starter chips, and include light AI-driven pacing — occasionally redirecting with a follow-up question rather than only answering. The opening line triggers the existing `runCharacterInteraction` path with a seed prompt via a `useEffect` on character mount.

**Rationale:** The single highest-signal change to move from "chatbot with a face" to "AI character with presence." `isCharacterThinking` already exists but is unused; the seed prompt approach requires no new infrastructure. Eliminates the blank-screen drop-off moment that kills first sessions. Differentiating against every passive chatbot competitor.

**Downsides:** Only as good as the character prompts beneath it — currently all characters have placeholder prompts. Opening line quality is critical; a generic opener undermines the effect.

**Confidence:** 92%
**Complexity:** Low
**Status:** Unexplored

---

### 2. URL-Per-Character Routing
**Description:** Replace in-app character selection with URL-based routing (`/characters/einstein`) so every character has a shareable direct link. `syncFromLocation` in App.tsx already partially reads pathname for character selection — this completes the pattern and makes the character grid a landing index page rather than an in-app overlay.

**Rationale:** Shareability is the primary organic distribution mechanism at MVP stage. A direct URL per character enables social links, embedding, and makes every conversation a potential user acquisition event. Infrastructure is partially in place. This is the missing distribution primitive for the MVP.

**Downsides:** Character switching becomes a navigation event rather than an in-place state swap, which changes the browsing feel. The grid UI needs to become a proper index page.

**Confidence:** 90%
**Complexity:** Low
**Status:** Unexplored

---

### 3. Avatar Session Architecture Foundation
**Description:** Extract all stream lifecycle logic from App.tsx into a `useCharacter` hook with an explicit state machine (idle → connecting → streaming → error → idle). Bundle in four currently-wired-but-unshown UX resilience items: (a) thinking indicator using existing `isCharacterThinking` state, (b) input disabled during response, (c) audio-only fallback when Odyssey fails, (d) single-click reconnect on stream error. The stream-hang fix (synchronous refs in SDK callbacks) must be preserved inside the hook.

**Rationale:** The documented production bug is a symptom of ad-hoc state in a 900-line monolith. The hook makes the fix durable and isolated. The 4 UX items are nearly free once the hook exists — they wire existing state to UI. Every future avatar feature (barge-in, emotion triggers, multi-character) becomes implementable. This is the architectural investment that makes all subsequent development faster.

**Downsides:** Refactoring a 900-line monolith carries risk. Requires careful preservation of the atomic read-and-clear ref pattern from the stream-hang fix.

**Confidence:** 88%
**Complexity:** Medium
**Status:** Unexplored

---

### 4. Character Definition Platform
**Description:** Define a shared TypeScript `Character` interface used by both client and server (currently defined inline in App.tsx only). Move the hardcoded `mapUtteranceToPrompt` gesture logic (currently 40-line imperative TypeScript with inline regex) into a per-character `gestureMap` field in characters.json. Add a Zod validator at dev startup to guard the schema.

**Rationale:** characters.json is the natural extension point for the entire platform. Right now the TypeScript interface is isolated to the client and the gesture logic is in code. Making the schema the source of truth means new characters, voices, opening lines, and gestures are all data edits. This is the foundation that makes the character creator, operator customization, and A/B testing possible later.

**Downsides:** Adds Zod as a build dependency. Gesture map design needs to be flexible enough for edge cases (the `else` branch fallback in the current implementation).

**Confidence:** 85%
**Complexity:** Low-Medium
**Status:** Unexplored

---

### 5. Persistent Character Memory
**Description:** After each session, summarize the conversation using the last N turns already tracked in `characterHistory` and persist to localStorage (device-local, no auth required). On next session load, inject the summary into the character's system prompt so the character references past interactions. Optional second phase: sync to Upstash Redis (already deployed) for cross-device memory.

**Rationale:** Memory is the feature that transforms a demo into a product worth returning to. Conversation history is already tracked per character in React state. A localStorage-first implementation ships in a day and creates an emotional retention hook that no passive chatbot can replicate. Redis is already available for the cross-device upgrade path.

**Downsides:** Without user auth, memory is device-local and lost on browser clear. Summary quality depends on Gemini; bad summaries produce confusing character behavior. System prompt injection needs a length budget to avoid crowding out the character's personality.

**Confidence:** 75%
**Complexity:** Medium
**Status:** Unexplored

---

### 6. Session Resilience: Lease Leak + Image Cache
**Description:** Two production bug fixes: (1) Extend the Odyssey lease release to cover mobile tab abandonment — add a `visibilitychange` handler and server-side cleanup endpoint to supplement the existing `beforeunload`/`sendBeacon` path, which is suppressed by iOS Safari and mobile Chrome on process kill. (2) Add LRU eviction to `imageCacheRef` (cap at 3-5 entries) to prevent memory growth of up to 25 MB × N characters in long sessions.

**Rationale:** The lease leak is the fastest path to "the product is down" — zombie leases on a limited Odyssey API pool block all new users. The image cache is a mobile crash waiting to happen during a demo. Both are sub-2-hour fixes grounded in code. These should ship before any sustained public traffic.

**Downsides:** Neither is user-visible when working. Low differentiation value, but high reliability value.

**Confidence:** 95%
**Complexity:** Low
**Status:** Unexplored

---

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| — | Character Switch Loading Indicator | Covered by idea 3 (session architecture bundle) |
| — | Microphone Permission Error Message | Polish, not differentiation; generic fallback is sufficient for MVP |
| — | Character Selection Persistence (localStorage) | Lowest-value returning-user feature; memory (#5) is the right primitive |
| — | Emotion-Reactive Camera Framing | Odyssey SDK does not expose camera framing parameters |
| — | Multi-Turn Voice Interruption (Barge-In) | AudioContext source node has no stable reference; multi-day refactor at MVP stage |
| — | Character Creator / Persona Builder | Platform play, wrong sequence — build one great character first |
| — | Session Replay / Highlight Reel Export | Three infrastructure problems before sessions are worth replaying |
| — | Ambient Sound Layer | 30-minute opportunistic feature; not a strategic idea |
| — | Relationship / Affinity Score System | Needs user identity; memory (#5) is the right first step |
| — | Collapse Server Files | api/server.js is already 3 re-export lines — nothing to do |
| — | Replace SQLite with Redis | Already done — Upstash Redis is already wired in server/index.js |
| — | Move API Keys Server-Side | Already done — client fetches token via /api/odyssey/token |
| — | Lightweight Router (standalone) | Correct direction but sequencing: extract useCharacter hook first (#3) |
| — | Character Controls Pacing (standalone) | Subsumed into idea 1 (proactive engagement); vague as a standalone |
| — | Avatar as Navigation Metaphor | Product vision without a concrete implementation path |
| — | Audience Mode | Multiplayer on top of unproven single-player; separate product |
| — | Invert the Persona (user plays a character) | Different product; fragments character identity before it's established |
| — | Kill the Text Box (voice-only mode) | Removes accessibility fallback before voice is robust |
| — | Rate Limiter Redis Backend | In-memory is an accepted tradeoff at current scale |
| — | TTS + Video Lip Sync | Platform constraint — neither SDK exposes the synchronization hooks needed |
| — | Typed API Client Auto-Generated | Correct but premature; the API surface needs to stabilize first |
| — | Vercel Edge Config Feature Flags | Correct but premature; ship known features before adding a flag layer |

---

## Session Log
- 2026-03-28: Initial ideation — 48 raw candidates generated (6 agents × 8 ideas), 6 survivors after two-agent adversarial critique. Key discoveries: Redis already deployed, API keys already server-side, `isCharacterThinking` state exists unused, `syncFromLocation` partially implements URL routing.
