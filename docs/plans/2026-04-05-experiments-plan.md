# Interact Studio — Experiments Plan

> Last updated: April 5, 2026
> Overview: 10-day experiment sprint launching April 13. One experiment every 2 days. Poll on day 11.

---

## Timeline at a Glance

| Date | Action |
|------|--------|
| **Apr 6** | LinkedIn announcement post goes live |
| **Apr 10** | Announcement video drops (experiments preview) |
| **Apr 13–14** | Experiment 1: Object Detection |
| **Apr 15–16** | Experiment 2: Gesture Detection |
| **Apr 17–18** | Experiment 3: Drawing to Live |
| **Apr 19–20** | Experiment 4: Custom Characters |
| **Apr 21–22** | Experiment 5: Broadcast |
| **Apr 23** | Poll goes live across all platforms |

---

## The 5 Experiments

### Experiment 1 — Object Detection
**Dates:** Mon Apr 13 – Tue Apr 14

**What it does:** MediaPipe webcam detects objects in real time. Character reacts to whatever the user holds up.

**Why it opens the sprint:** Strong first impression. Passive "whoa" moment. No user effort required — just hold something up. Highly shareable. Good hook for content ("what does [character] think of my coffee mug?")

**Technical complexity:** Low — MediaPipe already in deps.

**Content angle:** "I showed [character] everything on my desk. Their reaction to [X] broke me." Post as a Reel, clip the funniest reactions.

**Party game tie-in:** Scavenger Hunt — character calls out an object, first player to hold it up wins the round.

---

### Experiment 2 — Gesture Detection
**Dates:** Wed Apr 15 – Thu Apr 16

**What it does:** Webcam loop → `/api/gesture-vision` → character mirrors or reacts to the user's gesture.

**Why it's here:** Continues the vision/camera theme from Experiment 1. Thematically paired — week 1 is the "vision" week.

**Known weakness:** Weakest experiment in the sprint. Sits after a strong opener. Content and framing around it need to be strong to carry momentum.

**Technical complexity:** Low — endpoint already exists.

**Content angle:** Lead with the experience, not the technology. "I waved at [character] and this happened." The character's reaction to gesture is the content, not the gesture detection itself.

**Party game tie-in:** Simon Says — character calls gestures, players replicate them, character confirms. Miss three = eliminated.

---

### Experiment 3 — Drawing to Live
**Dates:** Fri Apr 17 – Sat Apr 18

**What it does:** User draws on canvas → image sent as file → `startUploadStream` pipeline → drawing becomes a live animated character.

**Notes:** Doesn't naturally slot into the character paradigm — drawing replaces the character rather than augmenting it. Keep as-is for the experiment, observe user reaction, decide on permanent integration after the poll.

**Technical complexity:** Low — pipeline already exists.

**Content angle:** "I drew [thing] and it came alive." The novelty is the content. Show the before (drawing) and the after (live character) in a tight 15-second Reel.

**Party game tie-in:** Pictionary reversed — players draw something, character guesses what it is. Most creative wrong guess from the character wins the round.

---

### Experiment 4 — Custom Characters
**Dates:** Sun Apr 19 – Mon Apr 20

**What it does:** User uploads an image + provides a voice recording. Voice cloned via Smallest AI. Character rendered via Nano Banana. Result: a fully interactive custom character with the user's chosen face and voice.

**Why it's here:** Most personal experiment. Strong emotional hook. Highly shareable — people will create characters of people they know, people they've lost, fictional figures.

**Technical complexity:** Medium — voice clone pipeline + image upload + Nano Banana integration.

**Content angle:** "I cloned [person] using Interact Studio." Most powerful UGC driver in the sprint. People will post their creations without being asked.

**Watch for:** The "talk to your grandfather" moment — users uploading photos of deceased family members. The emotional weight of this use case is significant. Be prepared to feature it sensitively or have a statement ready.

**Party game tie-in:** Impersonation Reveal — player uploads a friend's photo as a custom character. Group guesses who it is based on how it talks.

---

### Experiment 5 — Broadcast
**Dates:** Tue Apr 21 – Wed Apr 22

**What it does:** One host creates a room. Audience joins with a room code. Audience submits prompts. Host fires prompts at the character live. Inherently multiplayer — the character is shared.

**Why it's last:** Viral by design, needs the largest possible audience when it launches. Saved for day 9–10 when the sprint audience is at its peak.

**Technical complexity:** Medium — SSE room management.

**Content angle:** "I put [character] in front of 50 people and let the internet ask anything." Record the live session, clip the best moments. The chaos is the content.

**Party game tie-in:** This experiment IS the party game platform. All party games designed in the content strategy run on Broadcast. Launch the party game format with this experiment.

**Broadcast game formats:**
- Audience vs Character — audience competes to get the funniest response
- Collective Dare — everyone submits a dare, host picks the best to run
- Story Circle — audience votes on which direction the story takes at each fork
- Speed Trivia — entire audience answers simultaneously, character picks a winner

---

## Poll — Day 11

**Date:** Thu Apr 23

**Platforms:** LinkedIn, X/Twitter, Instagram, TikTok — simultaneously

**Question:** "Which experiment did you love most?"
- Object Detection
- Gesture Mode
- Drawing to Live
- Custom Characters
- Broadcast

**After the poll:**
- Winning experiment gets prioritised for deep integration
- All 5 remain live permanently — users can pick one at a time
- Mutual exclusion still applies — one experiment active at a time

---

## Experiment Framework (Technical)

| Element | Implementation |
|---------|---------------|
| Access | "Lab" button in stream view top bar — not on landing page. Discovery after engagement. |
| Mutual exclusion | One experiment active at a time |
| Feedback | 👍/👎 logged to Redis after at least one interaction |
| Time-gating | `server/experiments.json` controls start/end dates — experiments flip on/off automatically |
| Logging events | `experiment_opened`, `experiment_used`, `experiment_feedback` |
| Day 11 state | All 5 live simultaneously, mutual exclusion still applies, no timers |

---

## Content Strategy Per Experiment

| Experiment | Primary content format | Platform |
|-----------|----------------------|----------|
| Object Detection | "I showed [character] my [object]" — Reel clip | Instagram, TikTok |
| Gesture Detection | "I waved at [character]" — short demo | Instagram, TikTok |
| Drawing to Live | Before/after — drawing → live character | Instagram Reels |
| Custom Characters | "I cloned [person]" — creator shows the build | TikTok, Instagram |
| Broadcast | Live session recording — clip the chaos | YouTube, TikTok |

---

## What to Watch

The experiments tell you where to invest the next quarter of product development. Beyond the poll, watch:

**Engagement depth:** Does the user do one interaction or many? Custom Characters and Broadcast should score highest here.

**Share rate:** Do users share what they made? Drawing to Live and Custom Characters are the most shareable outputs.

**Return rate:** Do users come back to the same experiment the next day?

**Creator interest:** Which experiment do creators naturally want to make content about without being asked?

The poll captures preference. The behavioral data captures truth.
