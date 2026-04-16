---
date: 2026-04-13
topic: character-memory
---

# Character Memory System

## Problem Frame

Interact Studio's characters currently have no memory beyond a single browser session.
Every conversation starts cold — the character has no idea who the user is, what they care
about, or what they've talked about before. This breaks the illusion of a real relationship
and removes one of the most powerful reasons to come back. The fix is per-user, per-character
persistent memory that makes each character feel like it genuinely knows its user over time.

Memory is gated on authenticated users — unauthenticated sessions remain session-only.

## Requirements

- R1. At the start of each authenticated session, the character loads a memory context for the
  (user, character) pair and injects it silently into the Gemini system prompt, so the character
  arrives already knowing relevant facts about the user.

- R2. After each conversation exchange (user turn + character reply), the exchange is sent to the
  memory service. The service automatically extracts and stores: name/introductions, topics and
  interests discussed, opinions and preferences expressed, and notable moments from conversation
  history.

- R3. The character references past interactions naturally and organically in conversation
  ("You mentioned you're into physics puzzles…") — there is no explicit memory UI shown to the user.

- R4. Memory is scoped per (user_id, character) pair — Einstein remembers each user independently,
  and a user's history with Einstein is separate from their history with any other character.

- R5. Memory is only active for authenticated users. Unauthenticated sessions get no persistence;
  the existing rolling in-session history continues to work as before.

- R6. Memory storage and extraction is handled by **Mem0** (managed platform). The app does not
  run its own extraction LLM calls — Mem0 handles all fact distillation from conversation messages.

## Success Criteria

- A returning authenticated user is greeted or referenced by name if they've introduced themselves
  before, without prompting.
- A character correctly recalls a topic or preference from a prior session in natural conversation.
- No extra Gemini API calls are made for memory extraction — Mem0 handles it.
- Unauthenticated sessions behave identically to today (no regression).

## Scope Boundaries

- No memory management UI for users (no "view/delete my memories" screen) — deferred post-MVP.
- No shared or cross-character memory (what a user told Einstein stays with Einstein).
- No memory for anonymous/unauthenticated users in this release.
- No changes to the existing Gemini Live two-phase Odyssey flow — memory injection targets the
  `/api/character/chat` endpoint (STT→LLM→TTS pipeline) first; Gemini Live path is a follow-up.

## Key Decisions

- **Mem0 over Supermemory**: Mem0's dual `user_id` + `agent_id` keys map exactly to the
  (user, character) namespace. Passing full conversation message arrays gives Mem0 richer
  extraction context than raw strings. No extra LLM calls needed.
- **Server-side only**: All Mem0 calls happen in the Express backend. The client is unchanged.
- **Auth gate**: Memory writes and reads are skipped entirely if `req.user` is not present —
  zero risk of leaking or mixing anonymous memories.
- **Injection location**: Memory summary is prepended to the system prompt in `/api/character/chat`,
  after the character persona block but before the formatting rules.
- **Memory write strategy**: Fire-and-forget with error logging. The Mem0 write runs after the
  character reply is sent; failures are logged to the server console but do not surface to the user.

## Dependencies / Assumptions

- Auth is live and `req.user.id` is available in the request context before this ships.
- Mem0 managed platform API key is provisioned (free tier is sufficient to start).
- The `user_id` passed to Mem0 is the Supabase user UUID.
- The `agent_id` passed to Mem0 is the character name slug (e.g. `"einstein"`).

## Outstanding Questions

### Resolve Before Planning

_(none — all product decisions resolved)_

### Deferred to Planning

- [Affects R1][Needs research] What is the right search query to pass to `mem0.search()` at session
  start? Options: the user's opening message, a fixed "tell me about this user" probe, or recent
  history summary.
- [Affects R1][Technical] How many memory items to inject and how to format them in the system
  prompt without blowing up token count for shorter character replies.
- [Affects R2][Needs research] Confirm Mem0 Node.js SDK supports `agent_id` field — verify against
  current docs before implementation (Python SDK definitely does; JS SDK needs verification).
- [Affects R5][Technical] How to gracefully skip Mem0 calls in dev/local without an API key set.

## Next Steps

→ `/ce:plan` for structured implementation planning.
