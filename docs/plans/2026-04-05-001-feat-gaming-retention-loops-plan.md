---
title: "feat: Gaming Retention Loops — Energy Bar, Streaks, Character Unlocks"
type: feat
status: active
date: 2026-04-05
deepened: 2026-04-05
---

# Gaming Retention Loops — Energy Bar, Streaks, Character Unlocks

## Enhancement Summary

**Deepened on:** 2026-04-05
**Research agents used:** product-lens, feasibility, scope-guardian, design-lens, security-lens, architecture-strategist, julik-frontend-races, kieran-typescript, performance-oracle, reliability, testing, best-practices, coherence

### Key Improvements Added
1. **Dark-measurement recommendation** — ship tracking before UI to validate the 5-minute assumption with real data
2. **`useRetention()` custom hook** — isolate all retention state from monolithic App.tsx rather than adding more useState calls
3. **Three concrete timer race conditions** — cancelation tokens, `characterOpenedAtRef` null safety, and multi-tab leader election
4. **Single consolidated localStorage key** — atomic writes and 10-second polling to avoid storage thrash
5. **Security hardening checklist** — visitorId validation, voiceId ownership binding, and paid-feature identity requirements
6. **Full TypeScript type design** — branded `CalendarDate`, typed `TaskId`, `StreakResult` discriminated union

### New Considerations Discovered
- `getVisitState()` in `analytics.ts` has a write side-effect — streak logic must NOT live there
- Input blocking requires patching 3 separate code paths (text, PTT button, Ctrl+Space keyboard)
- `characterOpenedAtRef` is nulled by `closeActiveCharacter()` — sharing it with the energy timer causes `NaN` corruption
- Phase 2 conflict resolution ("take higher value") is exploitable; must treat streak as an atomic pair
- `/api/character/tts` accepts any `voiceId` from request body with no ownership check — must fix before Phase 3 UI ships
- The experiment sprint (April 13–23) is at risk if energy limits ship first — consider dark measurement only until after experiments

---

## Overview

Introduce three interlocking engagement mechanics inspired by mobile gaming to drive daily return visits and deepen emotional investment in characters:

1. **Energy bar** — 5-minute default talk-time per day; refilled by completing tasks or daily login streaks
2. **Daily streaks** — Consecutive login rewards (bonus talk time, future character unlocks)
3. **Character unlocks** *(Phase 2, post-experiments)* — One character free by default; more unlocked via streaks, tasks, and paid upgrades. Includes custom cosmetics and paid per-character voice cloning.

The three mechanics feed each other: scarcity (energy) drives task completion and daily returns (streaks), which unlock characters users become attached to, which fuels willingness to pay.

---

## Problem Statement / Motivation

Interact Studio currently has no mechanism to encourage return visits or daily habits. Users can talk to characters indefinitely in one session with no reason to come back tomorrow. The retention loop system creates:

- A **reason to return daily** (streak maintenance, energy refill)
- A **reason to engage deeply** (complete tasks to unlock more time)
- A **monetization ladder** (free → earned unlocks → paid cosmetics/voices)

> **⚠️ Product premise check (from review):** The plan assumes session length is the cause of low D2 return rates. This is unverified. If organic D2 returners already spend 20+ min on D1, the energy bar will not improve retention — it will degrade D1. **Strongly recommended:** ship Phase 0 (dark measurement only — no UI shown to users) first and wait for two weeks of data before rendering the energy bar or streak badge. See Phase 0 below.

---

## Technical Foundation (Research Findings)

Key files and hooks identified in the codebase:

| Concern | Current Hook | File |
|---|---|---|
| Session timer start | `characterOpenedAtRef` — set to `Date.now()` on character open | [src/App.tsx](src/App.tsx) ~L129 |
| Analytics last visit | `interact_analytics_last_visit_at` in `localStorage` | [src/lib/analytics.ts](src/lib/analytics.ts) ~L86 |
| Visitor identity | `interact_analytics_visitor_id` UUID in `localStorage` | [src/lib/analytics.ts](src/lib/analytics.ts) ~L71 |
| Visit state reader | `getVisitState()` — returns `{ visitorId, isReturnVisit, lastVisitAt }` | [src/lib/analytics.ts](src/lib/analytics.ts) ~L83 |
| Character data | Static JSON, 8 characters with `id/title/image/prompt/greeting` | [src/data/characters.json](src/data/characters.json) |
| Session end logic | `closeActiveCharacter()` — computes `timeSpentMs` and fires analytics | [src/App.tsx](src/App.tsx) ~L144 |
| Durable storage | Upstash Redis — already used for analytics events and Odyssey lease pool | [server/index.js](server/index.js) |
| Odyssey heartbeat (timer pattern to copy) | `odysseyHeartbeatRef` + `startOdysseyHeartbeat()` / `stopOdysseyHeartbeat()` | [src/App.tsx](src/App.tsx) ~L171–187 |

**Critical patterns to respect (from `docs/solutions/`):**
- **Pattern 3:** Never sync a ref to React state via `useEffect` when it guards an async callback — timer logic must read/write via a ref updated synchronously.
- **Pattern 1:** Vercel cannot proxy WebSockets — not directly relevant here but reinforces serverless constraints.
- `getVisitState()` in `analytics.ts` unconditionally **writes** `lastVisitAt` on every call (L88). It is NOT a pure reader. Streak logic must NOT be added inside it.

---

## Proposed Solution

### Phase 0 — Dark Measurement *(Recommended: ship this first)*

Before rendering any UI, instrument what energy consumption and streak behaviour would look like on real traffic. Build `src/lib/retention.ts` with all tracking logic but **do not render `EnergyBar` or `StreakBadge`**. Log energy-would-deplete events and streak-eligible days to the existing `/api/log` analytics pipeline.

After 2 weeks of data:
- If median D1 session length < 4 min → the 5-min limit is too tight, raise it
- If D2 organic return rate is already low even among long-session users → energy bar is not the lever; character quality is
- Confirm the session length distribution before committing to the exact daily allocation

This ships in one PR with zero user-facing change and protects the experiment sprint (April 13–23) from being distorted by energy limits.

> **⏰ Timeline:** Today is April 6. The experiment sprint begins April 13. **Phase 0 must be merged and deployed within 5 days** to collect meaningful baseline data before experiments start. If Phase 0 slips past April 13, ship it immediately after — do not skip it to ship Phase 1 faster.

---

### Phase 1 — Energy Bar + Streaks (localStorage-first, no auth required)

Build entirely on the existing anonymous `visitorId` identity. All state stored in a **single consolidated localStorage key** for zero-friction MVP. Optional Redis durability added in Phase 2.

#### 1a. Energy Bar

**User-visible behavior:**
- A visible countdown bar in the character view showing remaining talk time
- Default allocation: **5 minutes** per day (adjust based on Phase 0 data)
- Day 1 grace: **15 minutes** (allows emotional connection before scarcity kicks in)
- Pre-cutoff warning: color change + pulsing when < 1 minute remaining (not a hard stop surprise)
- When energy reaches 0: **overlay screen** (not modal — full-screen takeover replacing the video layer) with remaining task CTAs + "come back tomorrow"
- Energy refills: completing defined tasks grants +X minutes

**Placement:**
- `EnergyBar` mounts inside `.top-bar`, right-aligned next to the back button — ambient status, not interruption
- On mobile, the bar is text-only (`4:32 left`) rather than a wide progress bar, to avoid cramping the top bar

**The "out of energy" overlay:**
- Pauses the Odyssey stream (stop heartbeat, no new API calls)
- Shows only incomplete tasks — reads `completedTaskIds` from state and suppresses completed ones
- If all tasks are completed: shows only "Come back tomorrow" + streak info
- Dismissible only by completing a task or navigating back to landing page
- A "+2 min" toast animates when energy is granted

**Task system (MVP — static list):**

```ts
// src/lib/retention.ts

export type TaskId =
  | 'send_first_message'
  | 'use_voice_input'
  | 'explore_new_character'
  | 'daily_return';           // triggered by streak system, not user action

export interface RetentionTask {
  id: TaskId;
  label: string;
  bonusMs: number;            // energy granted in milliseconds
}

export const RETENTION_TASKS: Record<TaskId, RetentionTask> = {
  send_first_message:    { id: 'send_first_message',    label: 'Send your first message today', bonusMs: 2 * 60_000 },
  use_voice_input:       { id: 'use_voice_input',       label: 'Use voice input',               bonusMs: 1 * 60_000 },
  explore_new_character: { id: 'explore_new_character', label: 'Explore a new character',       bonusMs: 2 * 60_000 },
  daily_return:          { id: 'daily_return',           label: 'Come back the next day',        bonusMs: 3 * 60_000 },
};
```

**Note:** `daily_return` is awarded by the streak system on app load, not by a user-facing CTA. Do not show it in the task list on the energy-zero overlay.

**Task callsites in App.tsx (all three must be wired):**
- `send_first_message` → fires in `handleTextPromptSubmit` on the first send of the day
- `use_voice_input` → fires in `startCharacterRecording` on first voice input of the day
- `explore_new_character` → fires in `handleSelectCharacter` on first character switch of the day

**Implementation — consolidated localStorage key:**

```ts
// src/lib/retention.ts

// ONE key, ONE JSON blob — atomic writes are structurally guaranteed
const RETENTION_KEY = 'interact_retention_v1';

interface RetentionPersistedState {
  schemaVersion: 1;
  energy: EnergyState;
  streak: StreakState;
  tasks: PersistedTaskState;
}

export interface EnergyState {
  remainingMs: number;    // never negative
  date: CalendarDate;     // YYYY-MM-DD UTC date of current allocation
  isFirstEver: boolean;   // true until day 2 — grants 15-min Day 1 allocation
}

export interface StreakState {
  count: number;
  longest: number;
  lastActiveDate: CalendarDate | null;        // YYYY-MM-DD UTC
  lastActiveTimestamp: string | null;          // full ISO — needed for 26-hour grace window math
}

interface PersistedTaskState {
  date: CalendarDate;         // resets when this !== today
  completedIds: TaskId[];     // serialized as array, reconstructed as Set on load
}

// Branded date type — cannot confuse with arbitrary strings or ISO timestamps
type CalendarDate = string & { readonly __brand: 'CalendarDate' };

function toUTCCalendarDate(date: Date = new Date()): CalendarDate {
  return date.toISOString().slice(0, 10) as CalendarDate;
}
```

**All date keys use UTC consistently.** "Midnight reset" means UTC midnight. The grace window math uses millisecond timestamps, not string subtraction.

**Timer implementation — ref-based, 10-second polling:**

```ts
// src/hooks/useRetention.ts
// (see Architecture section for why this is a hook, not inline App.tsx state)

export function useRetention() {
  const stateRef = useRef<RetentionPersistedState>(loadRetentionState());
  const [energyRemainingMs, setEnergyRemainingMs] = useState(stateRef.current.energy.remainingMs);
  const [isEnergyBlocked, setIsEnergyBlocked] = useState(stateRef.current.energy.remainingMs <= 0);
  const [streakCount, setStreakCount] = useState(stateRef.current.streak.count);
  const intervalRef = useRef<number | null>(null);
  const cancelTokenRef = useRef<{ canceled: boolean }>({ canceled: false });

  const stopTimer = useCallback(() => {
    cancelTokenRef.current.canceled = true;
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    const token = { canceled: false };
    cancelTokenRef.current = token;
    intervalRef.current = window.setInterval(() => {
      if (token.canceled) return;

      const state = stateRef.current;
      const today = toUTCCalendarDate();

      // Midnight rollover check — inside the tick
      if (state.energy.date !== today) {
        const newState = resetEnergyForNewDay(state, today);
        stateRef.current = newState;
        persistRetentionState(newState);
        setEnergyRemainingMs(newState.energy.remainingMs);
        setIsEnergyBlocked(false);
        return;
      }

      const next = Math.max(0, state.energy.remainingMs - 10_000); // 10s tick
      stateRef.current = { ...state, energy: { ...state.energy, remainingMs: next } };
      persistRetentionState(stateRef.current);        // writes once per 10s, not per second
      setEnergyRemainingMs(next);
      if (next <= 0) {
        setIsEnergyBlocked(true);
        stopTimer();
      }
    }, 10_000);
  }, [stopTimer]);

  // ... completeTask, streak init, etc.

  return { energyRemainingMs, isEnergyBlocked, streakCount, completeTask, startTimer, stopTimer };
}
```

**Display smoothness at 10-second intervals:** `EnergyBar` uses CSS `transition: width 10s linear` on the progress fill element. The bar animates smoothly between ticks at zero JS cost — React re-renders once every 10 seconds only.

**Energy timer and character switches:**
- Call `stopTimer()` inside `closeActiveCharacter()`
- Call `startTimer()` inside `handleSelectCharacter()` after the character is confirmed
- The timer only runs when a character is active — no deduction on the landing page
- `energyRemainingMs` is derived from `stateRef.current`, not `characterOpenedAtRef` — completely independent refs

> **Do NOT reuse `characterOpenedAtRef` for energy tracking.** `closeActiveCharacter()` nulls it, and `Date.now() - null` produces `NaN`, which corrupts localStorage permanently.

**Input blocking — three paths that all need a gate:**

```tsx
// App.tsx — add `isEnergyBlocked` from useRetention() to:

// 1. Text input submit button
<button disabled={isCharacterThinking || isEnergyBlocked} onClick={handleTextPromptSubmit}>

// 2. PTT voice button (currently only gated by isCharacterThinking)
<button disabled={isCharacterThinking || isCharacterRecording || isEnergyBlocked} ...>

// 3. Keyboard Ctrl+Space PTT handler
const pttStart = useCallback(() => {
  if (isCharacterThinking || isCharacterRecording || isEnergyBlocked) return;
  // ... existing logic
}, [isCharacterThinking, isCharacterRecording, isEnergyBlocked]);
```

**Energy expiry during active sessions — two special cases:**

*Gemini Live (Einstein character):* When `isEnergyBlocked` transitions to `true` while a Gemini Live session is active, the `onExhausted` callback in `useRetention` must explicitly call `stopGeminiLiveSession()` — not just show the overlay. Relying on the visual block alone leaves the mic track open and the WebSocket alive, burning quota.

```ts
// src/hooks/useRetention.ts — inside setIsEnergyBlocked(true) path
if (next <= 0) {
  setIsEnergyBlocked(true);
  stopTimer();
  onEnergyExhausted?.(); // App.tsx wires this to stopGeminiLiveSession() when Einstein is active
}
```

`useRetention` takes an optional `onEnergyExhausted?: () => void` prop. `App.tsx` passes `stopGeminiLiveSession` when `selectedCharacterId === 'einstein'` (or whichever character uses Gemini Live).

*Active TTS playback (AudioBufferSourceNode):* When energy expires during TTS, queued audio nodes must be stopped synchronously:

```ts
// App.tsx — in the onEnergyExhausted handler, before showing the overlay
audioQueueRef.current.forEach(node => node.stop(0));
audioQueueRef.current = [];
```

Do not rely on the Odyssey heartbeat stopping new requests — already-buffered audio will still play through. The `stop(0)` call cancels all scheduled nodes immediately.

**Multi-tab deduction (leader election — ~30 lines):**

```ts
const TAB_ID = crypto.randomUUID();
const LEADER_KEY = 'interact_energy_leader';
const LEADER_HEARTBEAT_MS = 2_000;
const LEADER_TIMEOUT_MS = 5_000;

function tryBecomeLeader(): boolean {
  try {
    const raw = localStorage.getItem(LEADER_KEY);
    const existing = raw ? JSON.parse(raw) : null;
    const now = Date.now();
    if (!existing || now - existing.ts > LEADER_TIMEOUT_MS || existing.tabId === TAB_ID) {
      localStorage.setItem(LEADER_KEY, JSON.stringify({ tabId: TAB_ID, ts: now }));
      return true;
    }
    return false;
  } catch { return true; } // storage unavailable → assume leader
}
```

Only the leader tab runs the deduction interval. Non-leader tabs listen on the `storage` event for `RETENTION_KEY` changes and update their display.

**localStorage unavailability fallback:**

```ts
function persistRetentionState(state: RetentionPersistedState): void {
  try {
    localStorage.setItem(RETENTION_KEY, JSON.stringify(state));
  } catch { /* quota full or private browsing — in-memory only is acceptable */ }
}

function loadRetentionState(): RetentionPersistedState {
  try {
    const raw = localStorage.getItem(RETENTION_KEY);
    if (!raw) return buildDefaultState();
    const parsed = JSON.parse(raw);
    return migrateToLatest(parsed);   // schema versioning — see below
  } catch { return buildDefaultState(); }
}
```

**Schema versioning — always include `schemaVersion`:**
Start at `1`. Increment only on breaking shape changes. Include a migration map:

```ts
type MigrationFn = (old: unknown) => RetentionPersistedState;
const MIGRATIONS: Record<number, MigrationFn> = {
  // e.g. 2: (data: any) => ({ ...data, energy: { ...data.energy, isFirstEver: false } })
};

function migrateToLatest(raw: any): RetentionPersistedState {
  let data = raw;
  let version: number = data.schemaVersion ?? 0;
  while (version < 1) {
    data = MIGRATIONS[version + 1]?.(data) ?? buildDefaultState();
    version++;
  }
  return data as RetentionPersistedState;
}
```

**Visibility change flush:**

```ts
// Register once on mount — not inside useEffect with [selectedCharacterId] deps
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    persistRetentionState(stateRef.current);
  }
});
window.addEventListener('pagehide', () => {
  persistRetentionState(stateRef.current); // synchronous write — page may freeze after
});
```

#### 1b. Daily Streaks

**User-visible behavior:**
- Streak counter shown on landing page header area (`StreakBadge` in `.landing-topbar`, right-aligned)
- Hidden on day 1 — only shown from day 2 onward (`streakCount >= 2`)
- Milestone rewards: 3 days → +2 min, 7 days → +5 min, 30 days → unlock badge
- Streak break shown with a reset animation (count ticks down to 0, then 1)

**Implementation — streak computation runs once per session only:**

```ts
// Uses sessionStorage to guarantee once-per-session (not once-per-function-call)
const STREAK_COMPUTED_KEY = 'interact_streak_computed';

export function initStreakOnce(state: RetentionPersistedState): RetentionPersistedState {
  if (sessionStorage.getItem(STREAK_COMPUTED_KEY)) return state; // already done
  sessionStorage.setItem(STREAK_COMPUTED_KEY, '1');
  return computeStreakUpdate(state, toUTCCalendarDate());
}
```

**Do NOT add streak logic to `analytics.ts` `getVisitState()`.** That function writes `lastVisitAt` on every call and is called from event tracking paths. Importing streak logic there would cause double-increments. `retention.ts` reads `getVisitState()` as an input only:

```ts
import { getVisitState } from './analytics';

export function loadRetentionState(): RetentionPersistedState {
  const { isNewVisitor } = getVisitState(); // READ ONLY — do not extend this function
  const raw = safeLoadFromStorage();
  const state = raw ?? buildDefaultState(isNewVisitor);
  return initStreakOnce(state);
}
```

> **⚠️ Ordering caveat:** `getVisitState()` unconditionally writes `lastVisitAt` to localStorage on every call (analytics.ts ~L88). This means calling it inside `loadRetentionState()` updates the analytics visit timestamp before retention streak logic runs. This is acceptable because `retention.ts` uses its own `lastActiveTimestamp` field (not the analytics `lastVisitAt`) for streak math — the two keys are independent. Do NOT use `interact_analytics_last_visit_at` as input to streak calculations; use only `streak.lastActiveTimestamp` in the retention state blob.

**Streak update logic — uses timestamps for grace window, not string arithmetic:**

```ts
type StreakResult =
  | { status: 'continued'; newCount: number }
  | { status: 'maintained' }
  | { status: 'reset'; newCount: 1 };

const GRACE_WINDOW_MS = 26 * 60 * 60_000; // 26 hours in ms

function computeStreakUpdate(state: RetentionPersistedState, today: CalendarDate): RetentionPersistedState {
  const streak = state.streak;

  if (streak.lastActiveDate === today) {
    return state; // already visited today
  }

  let result: StreakResult;

  if (!streak.lastActiveDate || !streak.lastActiveTimestamp) {
    result = { status: 'continued', newCount: 1 }; // first ever visit
  } else {
    const lastMs = new Date(streak.lastActiveTimestamp).getTime();
    const diffMs = Date.now() - lastMs;
    result = diffMs <= GRACE_WINDOW_MS
      ? { status: 'continued', newCount: streak.count + 1 }
      : { status: 'reset', newCount: 1 };
  }

  const newCount = result.status === 'maintained' ? streak.count : result.newCount;
  const milestoneBonus = getMilestoneBonus(streak.count, newCount); // 0 if no milestone crossed

  return {
    ...state,
    streak: {
      count: newCount,
      longest: Math.max(streak.longest, newCount),
      lastActiveDate: today,
      lastActiveTimestamp: new Date().toISOString(),
    },
    energy: {
      ...state.energy,
      remainingMs: Math.min(
        state.energy.remainingMs + milestoneBonus + RETENTION_TASKS.daily_return.bonusMs,
        MAX_ENERGY_MS,
      ),
    },
  };
}
```

#### 1c. Onboarding UX

**Day-1 identity key:**

```ts
function buildDefaultState(isNewVisitor: boolean): RetentionPersistedState {
  return {
    schemaVersion: 1,
    energy: {
      remainingMs: isNewVisitor ? NEW_USER_ENERGY_MS : DEFAULT_ENERGY_MS, // 15min vs 5min
      date: toUTCCalendarDate(),
      isFirstEver: isNewVisitor,
    },
    streak: { count: 0, longest: 0, lastActiveDate: null, lastActiveTimestamp: null },
    tasks: { date: toUTCCalendarDate(), completedIds: [] },
  };
}
```

`isFirstEver` in `EnergyState` persists whether this user has ever received the 15-minute allocation. On subsequent days, it is still `true` in the stored object but `resetEnergyForNewDay()` checks it and resets to `DEFAULT_ENERGY_MS` on day 2+.

**Pre-cutoff warning:** At `remainingMs < 60_000` (< 1 min), `EnergyBar` applies a `warning` CSS class triggering pulsing red color. The `onExhausted` callback fires at exactly 0.

**First energy limit modal (day-1 users only):** On first ever energy-zero hit (`isFirstEver === true`), show a simplified explanation: "You've used your daily talk time! Complete a task below to keep going, or come back tomorrow for a fresh start." On subsequent days, skip the explanation and go straight to the task list.

---

### Phase 2 — Redis-backed Durability (post Phase 1 validation)

Once Phase 1 ships and we see D1→D2 return rate data, harden the system:

**New backend routes in `server/index.js`:**
- `GET /api/user/state?visitorId=<uuid>` — reads from Redis hash keyed by `visitorId`
- `POST /api/user/state` — writes `{ streakCount, streakLastDate, streakLastTimestamp, energyDate }` to Redis

**Input validation (required before Phase 2 ships):**
- `visitorId` must match `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i` — reject anything else with 400
- Server computes streak increments from timestamped events — do NOT accept client-supplied `streakCount` values (bypass risk)
- Apply `generalLimiter` to both routes; add per-`visitorId` write rate limiting (max 5 writes/min per ID) to prevent streak inflation

**Non-blocking client load pattern:**

```ts
// Load from localStorage immediately — no waiting
const localState = loadRetentionState();
initRetentionUI(localState);

// Background reconcile — does not block rendering
fetchWithTimeout('/api/user/state?visitorId=' + visitorId, 3_000)
  .then(remoteState => {
    const reconciled = reconcileStates(localState, remoteState);
    applyRetentionState(reconciled);
  })
  .catch(() => undefined); // Redis failure is non-fatal — localStorage is ground truth
```

**Write cadence — NOT per tick:**
```ts
// Mid-session: 60s writes (mirrors the Odyssey heartbeat pattern)
setInterval(() => syncToRedis(stateRef.current), 60_000);

// On session end: sendBeacon (survives page unload)
window.addEventListener('beforeunload', () => {
  navigator.sendBeacon('/api/user/state', JSON.stringify(buildSyncPayload()));
});
```

**Redis timeout wrapper:**
```ts
const withRedisTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('redis_timeout')), 1_500))]);
```

**Conflict resolution — atomic pair rule:**
Streak `count` and `lastActiveTimestamp` must always be reconciled as a unit. Never mix fields from different sources:
```ts
function reconcileStates(local: RetentionPersistedState, remote: RetentionPersistedState | null) {
  if (!remote) return local;
  // Take the source with the more recent streak timestamp
  const useRemoteStreak = (remote.streak.lastActiveTimestamp ?? '') > (local.streak.lastActiveTimestamp ?? '');
  return {
    ...local,
    energy: { ...local.energy, remainingMs: Math.max(local.energy.remainingMs, remote.energy.remainingMs) },
    streak: useRemoteStreak ? remote.streak : local.streak,
  };
}
```

**visitorId + localStorage unavailability:** If `canUseLocalStorage()` returns `false`, skip all Redis sync calls — the ephemeral UUID from the fallback path must never be used as a Redis key (would leak memory with phantom entries).

---

### Phase 3 — Character Unlocks *(Post-experiments, based on retention data)*

Add a `locked: boolean` field to each character in `characters.json` and to the `Character` TypeScript interface in `App.tsx` (L22-31):
```ts
interface Character {
  // ... existing fields
  locked?: boolean;   // undefined = free (backward compatible)
}
```

The character selector renders locked characters as greyed-out cards with an unlock CTA.

**Unlock tiers:**
- Default: 1 free character (experiment data determines which)
- Streak-gated: 7-day / 30-day milestones
- Task-gated: character-specific onboarding task
- Paid: remaining characters via one-time purchase

**Custom clothing / cosmetics:**
- Add `outfits: string[]` to character schema (image paths under `public/images/characters/`)
- One outfit free, additional outfits unlockable via tasks or paid

**Voice cloning (paid, per character) — security requirements before shipping:**

> **CRITICAL (from security review):** `/api/character/tts` at `server/index.js` ~L943 accepts `voiceId` from `req.body` with no ownership check. Before a voice clone UI ships, add server-side validation:

```js
// server/index.js — in /api/character/tts handler, before forwarding to Smallest AI:
const userState = await redis.hget(`user:${req.body.visitorId}`, 'voiceIds');
const allowedVoiceIds = JSON.parse(userState ?? '{}');
if (voiceId && !allowedVoiceIds[characterId]?.includes(voiceId)) {
  return res.status(403).json({ error: 'voice_not_authorized' });
}
```

Also add `aiLimiter` to `/api/voice-clone` immediately (currently only `generalLimiter` applies — paid Smallest AI quota is unguarded).

Voice clone UI: record/upload audio sample → POST to `/api/voice-clone` → store returned `voiceId` in user state keyed by character. Maximum 1 free clone per user (enforced server-side via Redis counter). Paid users get additional clones.

**Voice biometric disclosure:** Add a consent notice ("Your voice recording will be processed to create a custom voice") before any upload. Store consent timestamp alongside the voiceId in Redis.

**Identity requirement for paid features:** `visitorId` as the sole identity anchor is not sufficient for payments (no recovery path on storage clear, trivially shareable). **Before Phase 3 paid unlocks ship**, implement at minimum an email-capture "save my progress" flow that ties the `visitorId` to a recoverable identifier in Redis. This is not full auth — just an email + magic link that lets users recover their streak/unlocks after a storage wipe.

---

## Architecture

### State management: `useRetention()` hook *(not inline App.tsx state)*

The entire frontend is a ~1500-line monolithic `App.tsx`. Do NOT add 6+ more `useState` calls to it. Create `src/hooks/useRetention.ts` as a custom hook that encapsulates all retention `useState`/`useRef`/`useEffect`:

```ts
// src/hooks/useRetention.ts
export type RetentionAPI = {
  energyRemainingMs: number;
  isEnergyBlocked: boolean;
  streakCount: number;
  streakVisible: boolean;      // false until count >= 2
  completedTaskIds: ReadonlySet<TaskId>;
  completeTask: (id: TaskId) => void;
  startTimer: () => void;      // called from handleSelectCharacter
  stopTimer: () => void;       // called from closeActiveCharacter
};
```

`App.tsx` calls `const retention = useRetention()` once and passes values down as props. `EnergyBar` and `StreakBadge` are pure presentational components — they receive only the props they need to render.

### File structure

**New files:**
- `src/lib/retention.ts` — pure localStorage logic (no React): `loadRetentionState`, `persistRetentionState`, `computeStreakUpdate`, `completeTask`, `buildDefaultState`, `migrateToLatest`
- `src/hooks/useRetention.ts` — React hook: timer lifecycle, `useState`/`useRef`, connects `retention.ts` to React
- `src/components/EnergyBar.tsx` — presentational, props: `{ remainingMs, totalMs, onExhausted }`
- `src/components/StreakBadge.tsx` — presentational, props: `{ count, visible }`
- `src/components/EnergyExhaustedOverlay.tsx` — full-screen takeover (not a modal), props:

```tsx
interface EnergyExhaustedOverlayProps {
  isFirstEver: boolean;             // show explanation text only on day-1 exhaustion
  tasks: RetentionTask[];           // all tasks
  completedTaskIds: ReadonlySet<TaskId>;
  onTaskComplete: (id: TaskId) => void;
  streakCount: number;
}
```

Rendering rules:
- Mounts **above** the video/character layer (z-index above `.character-view`, below navigation)
- Filters out `daily_return` task (never shown as a user-facing CTA)
- Filters out already-completed tasks — shows only actionable items
- If no incomplete tasks remain: shows only "Come back tomorrow" + current streak count
- On `onTaskComplete`: parent calls `completeTask()` from `useRetention`, which grants energy and hides overlay by setting `isEnergyBlocked = false`

**Modified files:**
- [src/App.tsx](src/App.tsx) — add `useRetention()` call; wire `startTimer`/`stopTimer` into character open/close; gate all 3 input paths with `isEnergyBlocked`; render `<EnergyBar>` in `.top-bar` and `<StreakBadge>` in `.landing-topbar`
- [src/lib/analytics.ts](src/lib/analytics.ts) — **no streak logic added here** — only read `getVisitState()` as input to `retention.ts`
- [src/data/characters.json](src/data/characters.json) *(Phase 3)* — add `locked?: boolean` per character
- [server/index.js](server/index.js) *(Phase 2)* — add `GET/POST /api/user/state`; add `aiLimiter` to `/api/voice-clone`

### Module dependency direction:
```
analytics.ts  ←── (read only)  retention.ts  ←── useRetention.ts  ←── App.tsx
```
`analytics.ts` never imports from `retention.ts`.

---

## System-Wide Impact

### Interaction Graph
Energy deduction fires every 10 seconds while a character is active. Task completion fires in `handleTextPromptSubmit`, `startCharacterRecording`, and `handleSelectCharacter`. All writes go through `persistRetentionState()` → single `localStorage.setItem(RETENTION_KEY, ...)` call.

Phase 2: `POST /api/user/state` fires every 60s and on `beforeunload` via `sendBeacon`. This routes through the same Express serverless function as all other API calls — confirmed to share `generalLimiter` (150 req/15 min per IP).

### Error & Failure Propagation
- `localStorage` unavailable → in-memory only, no crash, 5-min default
- `JSON.parse` fails on stored data → `buildDefaultState()` via `migrateToLatest` catch
- Energy stored as `NaN` → `Number.isFinite()` guard in `loadRetentionState` resets to default
- Redis unavailable (Phase 2) → silent, localStorage is authoritative
- `GET /api/user/state` timeout → `AbortSignal.timeout(3000)` + fallback to localStorage

### State Lifecycle Risks
Single consolidated key (`interact_retention_v1`) makes partial writes impossible — one `setItem` call writes the complete state. `persistRetentionState` is the only write path; `stateRef.current` is the only mutation path.

### API Surface Parity
`closeActiveCharacter()` already fires analytics on session end — attach `stopTimer()` here. `handleSelectCharacter()` starts the stream — attach `startTimer()` here. These are the only two callsites needed.

---

## Acceptance Criteria

### Phase 0 — Dark Measurement
- [ ] `retention.ts` tracks energy consumption and streak-eligible behaviour silently
- [ ] Energy-would-deplete events are logged to `/api/log` with `{ event: 'energy_would_deplete', energyRemainingMs, characterId }`
- [ ] No energy bar, streak badge, or task UI is rendered to users
- [ ] Two weeks of data collected before Phase 1 UI ships

### Phase 1 — Energy Bar
- [ ] New user gets 15 minutes on day 1 (`isFirstEver: true`), 5 minutes on subsequent days
- [ ] Visible countdown bar in `.top-bar` with pre-cutoff warning (pulsing at < 1 min)
- [ ] All three input paths blocked when energy = 0: text submit, PTT button, Ctrl+Space keyboard
- [ ] Energy overlay shows only incomplete tasks (completed tasks suppressed)
- [ ] Energy overlay shows "Come back tomorrow" only state when all tasks complete
- [ ] Completing `send_first_message` grants +2 min (idempotent — fires once per day)
- [ ] Completing `use_voice_input` grants +1 min (idempotent)
- [ ] Completing `explore_new_character` grants +2 min on each new character, up to 1x per character per day
- [ ] Task completions stored in single consolidated key, reset when date changes
- [ ] Daily energy resets at UTC midnight
- [ ] Energy state persists across page refreshes (single `interact_retention_v1` key)
- [ ] Energy timer does not run on landing page — only while a character is active
- [ ] Two tabs open → only leader tab deducts; both tabs display correctly
- [ ] Energy expiry during Gemini Live session (Einstein): `stopGeminiLiveSession()` is called explicitly, not just a visual block (mic track + WebSocket must close)
- [ ] Energy expiry during active TTS playback: queued `AudioBufferSourceNode` events are stopped cleanly (no orphaned audio after the wall activates)

### Phase 1 — Streaks
- [ ] Streak computed exactly once per session (sessionStorage gate)
- [ ] Streak increments on return visit within 26-hour window of previous visit
- [ ] Streak resets on gap > 26 hours
- [ ] Streak badge hidden when `count < 2`
- [ ] 3-day milestone grants +2 min bonus (exactly once, not on same-day revisit)
- [ ] 7-day milestone grants +5 min bonus (exactly once)
- [ ] `daily_return` task bonus (+3 min) awarded on app load on streak-continue days
- [ ] Streak count and `lastActiveTimestamp` always updated as an atomic pair

### Phase 2 — Durability
- [ ] `GET /api/user/state` validates `visitorId` as UUID v4 format (400 on invalid)
- [ ] `POST /api/user/state` applies per-`visitorId` write rate limit
- [ ] Client load path: localStorage renders immediately; Redis reconciles in background
- [ ] Redis sync frequency: 60s during session + `sendBeacon` on unload (not per-tick)
- [ ] Redis timeout (> 1.5s): silent fallback to localStorage, no user-visible error
- [ ] Streak reconciliation uses atomic pair rule (no mixing fields from different sources)
- [ ] `canUseLocalStorage()` check gates all Redis sync calls

### Phase 3 — Character Unlocks
- [ ] Locked characters rendered as greyed-out cards with unlock CTA
- [ ] `Character` TypeScript interface includes `locked?: boolean`
- [ ] Server-side `voiceId` ownership check in `/api/character/tts` before forwarding to Smallest AI
- [ ] `aiLimiter` applied to `/api/voice-clone`
- [ ] Voice biometric consent notice shown before upload
- [ ] Email capture "save my progress" flow implemented before paid unlocks ship

---

## Dependencies & Risks

| Risk | Mitigation |
|---|---|
| 5-min limit set wrong before data exists | Phase 0 dark measurement: collect 2 weeks of data, then calibrate |
| Experiment sprint (Apr 13–23) distorted by energy limits | Ship Phase 0 only through experiments; Phase 1 UI after Apr 23 |
| `setInterval` stale closure bug | Ref-callback pattern in `useRetention` hook; never read state inside interval |
| `characterOpenedAtRef` null → NaN energy | Dedicated `stateRef` — do not reuse `characterOpenedAtRef` |
| Multi-tab double-deduction | Leader election via localStorage heartbeat (30 lines) |
| `getVisitState()` side effect corrupts streak | Streak runs in `retention.ts`, reads `analytics.ts` as input only |
| LocalStorage wipe mid-session | `visibilitychange` + `pagehide` flush listeners |
| Streak punishes irregular users | 26-hour grace window + consider streak shield post-MVP |
| Phase 2 `visitorId` as paid entitlement key | Email capture before paid unlocks ship; UUID alone is insufficient |
| `/api/voice-clone` unguarded against abuse | Add `aiLimiter` immediately; `voiceId` ownership check before Phase 3 UI |

---

## Success Metrics

- **D1 → D2 return rate** (primary): does it increase after Phase 1 ships?
- **Session depth per day**: do users complete tasks to refill energy? (track task completion rate)
- **Streak distribution**: % of users with 3+ day streaks after 2 weeks
- **Energy exhaustion rate**: how often do users hit 0? High = engaged but frustrated (good) or trying and leaving (bad) — segment by D1 session length to distinguish

---

## Testing Plan

**Framework: Vitest** (not Jest — project uses native ESM with `"type": "module"` + Vite 7)

```
npm install -D vitest @vitest/coverage-v8 jsdom @testing-library/react @testing-library/jest-dom
```

Add to `vite.config.ts`: `test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'] }`

**Critical unit tests for `src/lib/retention.test.ts`:**

1. Streak increments when last timestamp is within 26 hours
2. Streak resets when gap > 26 hours (use `vi.setSystemTime()`)
3. Streak grace window: visit at hour 25 → still increments (requires ISO timestamp, not string arithmetic)
4. Same-day revisit: streak is idempotent
5. Day-1 allocation is 15 min; Day-2+ allocation is 5 min
6. Energy reset fires at UTC midnight boundary
7. `NaN` stored energy → sanitizes to default on read
8. Malformed date string → resets to new user state
9. `completeTask` is idempotent — energy granted exactly once per day per task
10. setInterval deducts correct elapsed time with fake timers (`vi.useFakeTimers()`)
11. Timer does not continue after `stopTimer()` (cancelation token check)
12. `localStorage` throws `QuotaExceededError` → returns default state without crashing

**The 26-hour grace window requires storing `lastActiveTimestamp` (full ISO) not just `lastActiveDate`.** Date string subtraction cannot represent sub-day precision. This is the single highest-risk edge case in the streak logic.

---

## Sources & References

### Internal References
- Session timer hook: [src/App.tsx](src/App.tsx) ~L129 (`characterOpenedAtRef`)
- Heartbeat pattern to copy: [src/App.tsx](src/App.tsx) ~L171–187 (`odysseyHeartbeatRef`)
- Visit state: [src/lib/analytics.ts](src/lib/analytics.ts) ~L83 (`getVisitState` — read-only input)
- Stale ref pattern: `docs/solutions/patterns/critical-patterns.md` (Pattern 3)
- Voice clone backend: [server/index.js](server/index.js) ~L819 (`POST /api/voice-clone`)
- TTS unguarded voiceId: [server/index.js](server/index.js) ~L943
- Character data: [src/data/characters.json](src/data/characters.json)

### External References
- [usehooks-ts useInterval](https://usehooks-ts.com/react-hook/use-interval) — battle-tested ref-callback interval hook
- [use-local-storage-state](https://github.com/astoilkov/use-local-storage-state) — in-memory fallback, multi-tab sync, 689B
- [Trophy: How to Build a Streaks Feature](https://trophy.so/blog/how-to-build-a-streaks-feature) — grace window patterns
- [Trophy: Handling Time Zones in Gamification](https://trophy.so/blog/handling-time-zones-gamification) — UTC vs local date decisions
- [React useEffectEvent](https://react.dev/reference/react/useEffectEvent) — React 19 canonical solution for stale interval closures
- [Handling localStorage errors](https://mmazzarolo.com/blog/2022-06-25-local-storage-status/) — `QuotaExceededError` cross-browser handling
