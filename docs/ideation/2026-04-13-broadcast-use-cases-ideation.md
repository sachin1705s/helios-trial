---
date: 2026-04-13
topic: broadcast-use-cases
focus: What are the highest-value contexts for Interact Studio's Broadcast feature?
---

# Ideation: Broadcast Use Cases

## Codebase Context

- **Stack:** React 18 + TypeScript + Vite frontend, Express backend on Vercel serverless
- **Characters:** Einstein, Cleopatra, Da Vinci, Steve Jobs, Circus Lion, Alexander, Grandpa Turtle, Bear + founders (Farza, Dan Shipper, Oliver Cameron, Varun Mayya)
- **Broadcast mechanics (just built):** One host, one character, audience joins via 6-char room code, submits text prompts, host selects which to fire at character. All viewers share one stream via Odyssey's WebRTC broadcast path.
- **Key constraints:** Web-only, no enterprise sales, no custom character builder yet, characters have fixed personalities, Vercel SSE limits mean host polls for prompts on 2s interval
- **Critical infra note:** Vercel cannot act as a persistent WebSocket relay — any long-running room state goes through in-memory Map (dev) or Upstash Redis (prod)

---

## Ranked Ideas

### 1. Creator "Stump the Genius" — Recurring Weekly Format
**Description:** A content creator hosts a weekly broadcast where their audience competes to submit the prompt that gets the most surprising, chaotic, or contradictory response from the character. A leaderboard tracks whose prompt "won" each week. The creator recaps the best moments as a clip reel.

**Rationale:** This is Interact Studio's growth engine. Content creators distribute to audiences the platform can't reach organically. The clip format ("Einstein said WHAT?") is inherently shareable. The leaderboard mechanic creates a reason to return next week. No enterprise sales, no integration work — just a room code shared in a Discord or stream description.

**Downsides:** Dependent on acquiring creator champions. Early clips might be low quality if creators don't know how to frame the session. Characters' fixed personalities may limit how surprising responses actually get.

**Confidence:** 85%
**Complexity:** Low (existing broadcast feature, optional leaderboard UI layer)
**Status:** Unexplored

---

### 2. Classroom Historical Interrogation
**Description:** A teacher hosts a broadcast where their class submits questions to a historical figure (Einstein, Cleopatra, Da Vinci). The teacher curates which questions get fired. The whole class watches the same response simultaneously, making it a shared anchor moment for the lesson.

**Rationale:** Teachers already have a captive audience with a structured time slot. The broadcast format is a better fit than solo chat because the shared simultaneous reaction creates a social learning moment — not just individual Q&A. Edtech purchase intent is real; this maps onto existing "living history" and Socratic pedagogy that teachers are trained in. One teacher champion drives 30 students through the door.

**Downsides:** School procurement is slow. School networks often block WebRTC or WebSocket connections. Teachers need confidence the character won't say something awkward to a room of 13-year-olds.

**Confidence:** 80%
**Complexity:** Low (existing broadcast) + Medium (content moderation for school contexts)
**Status:** Unexplored

---

### 3. Audience Earns Prompt Power (Gamified Broadcast)
**Description:** A product mechanic (applicable across use cases) where audience members start with zero prompt slots. They earn the right to fire a prompt by answering a character-posed quiz question correctly. Wrong answers give the slot to someone else. Host sets the questions.

**Rationale:** This single mechanic transforms broadcast from a passive watch format into a competitive experience. It creates stakes, drives re-engagement, and rewards knowledge — making it genuinely useful for education and entertainment simultaneously. Applicable to any use case: the classroom teacher uses it for review, the creator uses it as a game show format.

**Downsides:** Adds UI complexity to both host and audience views. Requires character to pose questions, which needs orchestration. Risk of alienating users who "can't get in" if the mechanic is too competitive.

**Confidence:** 75%
**Complexity:** Medium (quiz mechanic, prompt slot gating, host controls)
**Status:** Unexplored

---

### 4. Adversarial Audience — Two-Team Contradiction Game
**Description:** The host splits the audience into two teams: one team tries to get the character to contradict itself or say something inconsistent; the other team tries to defend the character's consistency by pre-empting with supportive prompts. A judge (host or LLM scoring) awards points for confirmed contradictions or successful defenses.

**Rationale:** Competitive structure creates shareable, clip-worthy moments. Two opposing teams create natural social conflict that makes the stream worth watching even for people who aren't participating. This format teaches critical thinking (can you catch a logical inconsistency?) in a format that feels like a game, not a lesson.

**Downsides:** Requires host to manage two team inputs simultaneously. The "contradiction detection" mechanic needs either manual host judgment or an LLM judge layer. Might be too complex for casual sessions.

**Confidence:** 70%
**Complexity:** Medium (team assignment, point scoring, contradiction detection)
**Status:** Unexplored

---

### 5. Weekly Recurring Ritual (Living Archive Format)
**Description:** Any broadcast session that is designed to recur — weekly, by chapter, by curriculum unit. The sessions accumulate into a canon: a linked archive of what Einstein said about gravity week 1, what Cleopatra said about power week 3. The archive is shareable and functions as compounding content.

**Rationale:** Single-session products plateau. Recurring formats build habits, justify return visits, and create the kind of accumulated lore that makes a platform feel like a place rather than a tool. This is how YouTube channels become franchises. The archive is free marketing — "here's what we've built together over 12 sessions" is a compelling creator story.

**Downsides:** Requires session persistence and archive tooling that doesn't exist yet. The value only becomes apparent after several sessions — early sessions look thin.

**Confidence:** 75%
**Complexity:** Medium (session archive, linking, display)
**Status:** Unexplored

---

### 6. Museum / Cultural Institution Hot Seat Events
**Description:** A museum or heritage site hosts a ticketed evening event (50–300 people) where a character tied to the exhibition — Da Vinci at a Renaissance show, Cleopatra at an Egypt exhibition — takes live audience questions. The curator acts as host. Premium ticket price ($30–60) relative to normal admission.

**Rationale:** Real revenue signal (ticketed, not just engagement). Museums are under sustained pressure to make collections experiential. This format is already proven by "After Dark" museum events that routinely sell out; broadcast adds the interactive layer. One venue is worth more than 1,000 individual users — it anchors the platform's credibility and creates case study material.

**Downsides:** Sales cycle for institutions is long. Event-night reliability pressure is high — one dropped stream in front of 200 paying attendees is damaging. Museum audience skews older; interface needs to be very simple.

**Confidence:** 70%
**Complexity:** Low (existing broadcast) + operational (onboarding institution, event support)
**Status:** Unexplored

---

### 7. Law School Live Cross-Examination
**Description:** A law professor hosts a broadcast where 90+ students collectively cross-examine a historical figure — a Founding Father, a Nuremberg defendant, a robber baron — as part of a constitutional law, ethics, or history of law course. The professor selects the sharpest student questions to fire.

**Rationale:** Law school pedagogy is built on Socratic interrogation and adversarial reasoning. The broadcast format maps perfectly: professor is the host, class is the audience, character is the witness. A historical figure who can answer novel questions that aren't in any casebook is a genuinely differentiated teaching tool. Law schools already pay heavily for simulation tools.

**Downsides:** Law faculty are slow adopters. The character's responses need to be sophisticated enough to hold up under legal-quality interrogation — current characters may not have the depth for the most advanced seminars. Narrow initial market.

**Confidence:** 65%
**Complexity:** Low (existing broadcast) — value is in character depth, not new features
**Status:** Unexplored

---

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Corporate All-Hands Keynote | Enterprise trust gap — no SSO, no SLA, one dropped stream at all-hands is permanently damaging |
| 2 | Grief / Legacy Session | Legally and ethically high-risk; characters can't be tuned to represent a deceased person |
| 3 | Product Launch / Brand Oracle | Too vague; brands need custom characters; no enterprise sales motion |
| 4 | Speed Mentorship / Founder Office Hours | Character can't provide real judgment or network access — novelty wears off immediately |
| 5 | Escape Room Finale | Requires physical venue integration partnership; niche within niche |
| 6 | Corporate Onboarding Founder Mythology | Requires custom characters + enterprise trust that doesn't exist yet |
| 7 | Group Therapy Psychodrama | Clinical liability; no crisis infrastructure; serious regulatory exposure |
| 8 | Audience-Run Character (no host) | Prompt quality collapses without editorial control; broadcast format's value is the curation layer |
| 9 | Character Plays the Host | Requires capabilities that don't exist — character cannot call on specific audience members |
| 10 | Automated Curriculum Script | Removes the live social element that justifies broadcast over async solo tool |
| 11 | Character Is the Audience (Pitch Critique) | Character can't perceive the human performance — just gets a description via prompt |
| 12 | The Open Room (always-on, no moderation) | Without moderation infrastructure, becomes unusable within hours |
| 13 | The Confessional Booth | Mental health product territory; requires ToS, crisis escalation, liability coverage |
| 14 | Institutional Voice | Reputational risk of hallucinations at institutional scale; needs enterprise sales infrastructure |
| 15 | Crisis Comms War-Gaming | Fixed characters not tuned for adversarial interviewing; B2B training sales motion required |
| 16 | Game Studio Narrative Stress-Test | Studios won't use uncontrolled third-party tool for pre-ship character QA |
| 17 | Character Debates Character | Requires two simultaneous Odyssey streams — capability doesn't exist |
| 18 | Fan Canon Expansion | Characters have no persistent memory across sessions — premise doesn't hold |
| 19 | Fan Convention Press Conference | IP licensing for franchises is a legal minefield; convention attendance declining |
| 20 | Political Campaign Town Hall | Platform liability in political contexts far exceeds upside |

---

---

## Capability-Gated Ideas

These ideas were rejected from the first pass because a required capability doesn't exist yet. Each is tagged with the specific build that would unlock it. These are ordered by the leverage of the underlying capability — the ones near the top unlock the most ideas if built.

---

### CAPABILITY: Persistent Character Memory
> Character remembers prior sessions — what was said, what topics were covered, what the community has built.

**Fan Canon Archive**
A fan community (sci-fi, history, philosophy) runs recurring sessions that accumulate into shared lore. Week 3 Einstein can be asked "Last week you said time is an illusion — do you still believe that after what happened in the quantum mechanics session?" The character's growing context becomes the community's collective artifact.
*Why it matters:* Recurring engagement is the hardest thing to manufacture. Memory makes every session more valuable than the last — the opposite of every other live format.
*What's needed:* Per-character session log, injected into context on connect. Redis-backed. ~1 sprint.

**The Living Curriculum**
A teacher runs weekly sessions with the same character across a semester. The character "remembers" what the class covered and can reference it: "As we discussed last week when Ava asked about gravity..." Creates continuity that no static LLM session can replicate.
*What's needed:* Same session log capability. Room code tied to a persistent context key.

---

### CAPABILITY: Custom Characters (Bring Your Own)
> User uploads an image + voice sample → live animated character with that face and voice.

**Bring Your Own Character — Broadcast**
The most personal version of broadcast. A founder broadcasts with a character built from their own face and voice. A teacher becomes the animated character. A brand deploys its mascot. The audience isn't watching Einstein — they're watching *you*, live and animated.
*Why it matters:* Collapses the distance between creator and character. The "I cloned myself" moment is more shareable than any historical figure. This is Experiment 4 (Custom Characters) merged with Broadcast.
*What's needed:* Custom character pipeline (Experiment 4 scope) + broadcast startStream with uploaded image. Medium complexity.

**Memorial Broadcast**
A family uses a character built from a deceased grandparent's photos and voice recordings. Extended family joins via room code for a structured "conversation" on a meaningful date — a birthday, an anniversary. A trusted family member hosts and curates the prompts.
*Why it matters:* The grief use case that was rejected in the first pass was too high-risk with *fixed* historical characters. With a custom character, the family controls the persona entirely. The ethical weight is real but the decision is theirs.
*What's needed:* Custom character pipeline. Recommend keeping this private/invite-only to avoid misuse.

---

### CAPABILITY: Two Simultaneous Character Streams
> Two characters run in the same broadcast room and the host can fire prompts at either or both.

**The Rival Stage — Live Debate**
Einstein vs. Jobs on whether intuition or rigor matters more. Cleopatra vs. Alexander on how empires fall. The audience fires provocations, follow-up challenges, and curveballs at both sides. The characters respond independently to the same prompt, revealing their different worldviews.
*Why it matters:* Debate as entertainment has proven, durable demand. Two characters arguing creates inherently clip-worthy moments. No live product does this.
*What's needed:* Two Odyssey client connections, two video elements side-by-side, host fires to left/right/both. Two API key leases. ~1–2 sprints.

**Good Cop / Bad Cop**
One character is warm and encouraging, one is adversarial and skeptical. The host fires the same audience question at both. The contrast is the entertainment. Natural fit for pitch critique, philosophy sessions, any topic with a genuine tension.
*What's needed:* Same dual-stream capability.

#### Variant: Bring Your Own Character — Two Co-Hosts
> Person A creates their own character, Person B creates their own. Both join one broadcast room. Audience watches both simultaneously.

This is the most personal version of the dual-stream format. Each person is the co-host of their own character — not one host controlling two.

**Architecture (fully designed, deferred):**
- Each person uploads a face photo → `startStream({ image: facePhoto, broadcast: true })`. Both flags are independent `StartStreamOptions` fields and should compose; needs a quick test to confirm.
- Room has two co-host slots (A and B). Room goes live only when both are filled.
- `POST /api/broadcast/room/:code/ready?slot=A` and `?slot=B` fill each slot independently.
- Audience connects to both streams via two `Odyssey.connectToStream()` calls, two video elements side by side.
- Prompt queue is split — Person A only sees prompts targeted at A or both; Person B only sees theirs.
- Voice (TTS) is decoupled from the Odyssey video stream — custom voice clone from Experiment 4 works without extra wiring.

**User journey:**
1. Person A → "Create Debate Room" → uploads photo → gets room code → goes live (waiting for B)
2. Person B → "Join as Co-host" → enters code → uploads photo → goes live
3. Audience → "Join as Audience" → enters code → sees two video feeds side by side → submits prompts targeted at A, B, or both

**Build order:**
1. Test `startStream({ image, broadcast: true })` combined — the only real unknown
2. Server: dual co-host slot schema
3. Image upload in broadcast host flow
4. Co-host join path (slot B entry)
5. Prompt targeting + split queues
6. Audience dual-stream layout

**Estimated effort:** ~1.5 days after Experiment 4 (custom character pipeline) exists.

*Status: Deferred — revisit after Experiment 4 ships.*

---

### CAPABILITY: Character-Initiated Interaction
> Character can pose questions to the audience, not just respond to them. Could call audience members by (user)name.

**Socratic Host — No Human Required**
The character runs the session. It poses a question to the room, audience submits answers, the host fires the most interesting one back, and the character responds and continues. Human host becomes optional — or disappears entirely for advanced sessions.
*Why it matters:* Removes the host as a bottleneck. A school district deploys ten simultaneous sessions with one teacher monitoring all of them.
*What's needed:* Character needs a "pose a question" mode — structured prompt that ends with a question, system surfaces audience responses for host selection. The host role becomes "moderator not writer." Medium complexity.

**The Interrogation Game**
Character asks the audience questions; audience members who answer correctly unlock prompt power (feeds directly into the Audience Earns Prompt Power mechanic). The character is simultaneously the teacher and the game master.
*What's needed:* Same character-question mode + prompt slot mechanic.

---

### CAPABILITY: Session Recording + Auto Clip Extraction
> Sessions are recorded server-side. Key moments (highest audience reaction, longest silence, most surprising response) are flagged and clipped automatically.

**Highlight Reel Auto-Generation**
After every broadcast, the system identifies the 3–5 most clip-worthy moments — based on audience reaction spikes, prompt voting, or content heuristics. Creator gets a ready-to-post package without editing.
*Why it matters:* The biggest friction for creator adoption is the gap between "I ran a cool session" and "I have content I can post." Auto-clips collapse that friction entirely. This is a distribution multiplier for every other use case.
*What's needed:* Server-side stream recording (Odyssey recording API already exists), reaction event timestamps, clip extraction pipeline. Medium-high complexity but high leverage.

**The Session Archive**
Every broadcast is archived and linked. A teacher's semester of Einstein sessions becomes a public or private library. A creator's "Stump the Genius" season becomes a playlist. Archive pages are SEO-able and shareable.
*What's needed:* Recording storage (S3/R2), session metadata, archive UI. Composable with clip extraction above.

---

### CAPABILITY: Audience Voting / Upvoting
> Audience can upvote submitted prompts before the host fires them. Most-upvoted rises to the top of the host's queue.

**Democratic Prompt Queue**
The host sees prompts ranked by audience vote rather than submission order. The crowd self-curates. The host still has final say but the best question surfaces naturally.
*Why it matters:* Solves the host's biggest problem — reading dozens of prompts while managing a live session. Also gives audience members a participation mechanic even when their prompt isn't selected.
*What's needed:* Voting UI on audience side, vote-sorted queue on host side. Low-medium complexity. High value per unit of effort.

**The Crowd Verdict**
After the character responds to a prompt, audience votes: Did the character answer well, dodge the question, or contradict itself? Votes are visible to everyone. Creates a real-time accountability layer.
*What's needed:* Post-response voting UI, results display. Could be a simple thumbs up/down per response.

---

### CAPABILITY: Moderated Open Room
> An always-on broadcast room with a persistent code, content filtering, and rate limiting — no active human host required.

**The Community Fixture**
A Discord server's "Einstein is always in #science." Anyone who has the link can walk in and talk to the character. The room accumulates visitors organically across the day. Low-key ambient interactions that don't require scheduling.
*Why it matters:* Scheduled events require coordination. Always-on rooms drive ambient discovery — the character becomes part of a community's infrastructure.
*What's needed:* Persistent room codes, content moderation layer (prompt filtering before it reaches the character), rate limiting per user. The moderation gap is the only reason this was rejected in the first pass. Medium complexity.

---

### CAPABILITY: Audience Sub-Rooms / Team Assignment
> Audience members are split into named teams. Prompts are tagged by team. Host can fire a "team A prompt" vs. a "team B prompt."

**Multi-Team Tournament**
Multiple teams compete across several broadcast sessions. Each session the winning team (most surprising response elicited, most audience reactions) earns points. Cross-session leaderboard. End-of-season championship.
*Why it matters:* Recurring competitive formats have the best retention in games and education. This is the Kahoot model applied to broadcast.
*What's needed:* Team assignment on join, prompt tagging by team, cross-session scoring. Medium complexity.

---

## Session Log
- 2026-04-13: Initial ideation — 45 raw candidates generated across 6 frames, deduplicated to 25, 7 survived adversarial filtering
- 2026-04-13: Extended with capability-gated ideas — 14 additional ideas across 7 capability categories added per user request
- 2026-04-13: Two Co-Hosts / Bring Your Own Character variant fully architected and added to dual-stream section. Deferred until Experiment 4 (custom character pipeline) ships.
