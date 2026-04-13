# Research: Gemini Live UI Design

**Date:** 2026-04-13  
**Purpose:** Inform the UI design for Interact Studio's Gemini Live speech-to-speech feature.  
**Decision needed:** How to visually communicate conversation state with minimal UI.

---

## Industry Research Summary

Every major real-time voice AI product (ChatGPT Advanced Voice, Gemini Live, ElevenLabs) has converged on the same pattern: a **central animated element** whose animation communicates conversation state, with minimal or no text labels.

### Products surveyed

| Product | Main element | State communication |
|---|---|---|
| ChatGPT Advanced Voice | Animated orb (blue/black) | Animation intensity — slow pulse = listening, energetic flow = responding |
| Gemini Live | Multi-colour animated dot cluster | Fluid morphing shape — calm = idle, expanding = responding |
| ElevenLabs Conversational AI | 3D WebGL orb (Three.js) | Audio-reactive displacement + Fresnel glow, 4 explicit named states |
| Vapi / Retell / Bland | API platforms, no canonical UI | Follow orb/waveform conventions when embedding widgets |

### The four universal states

All products define exactly four conversation states:

| State | What's happening | Visual treatment |
|---|---|---|
| **Idle** | Not connected | Static, obvious CTA — user needs to know to click |
| **Listening** | Session live, waiting for user speech | Slow ambient pulse — "I'm here, speak anytime" |
| **Thinking** | Processing / LLM call in flight | Slow ambient motion — deliberately NOT a spinner |
| **Speaking** | Character audio playing back | More energetic animation, audio-reactive |

### Key design principles from research

**1. Animation carries the state, not text**  
Sparse or no text labels during conversation. The animation IS the feedback. Text labels ("Listening…") appear occasionally as contextual hints but are not the primary channel.

**2. No loading spinners for thinking**  
The "thinking" state uses slow ambient motion — deliberate industry choice to avoid anxiety-inducing progress indicators. Users perceive slow pulse as "alive and working" vs. a spinner which reads as "broken or slow."

**3. Transcript as safety net, not primary UI**  
Chat history / live transcript is a secondary confirmation layer — "yes, Einstein heard you correctly." The avatar and the animated button are the primary feedback. Designs that put the transcript front and centre feel like a text chat with audio bolted on, not a real conversation.

**4. Explicit end button always present**  
No product relies on a gesture or timeout to end the session. There is always a visible, dedicated stop/end control. Users need to feel in control.

**5. Interruption affordance**  
Modern products use server-side VAD so users can speak at any time. The animated element visually "yields" when the user interrupts rather than cutting off hard. No PTT (push-to-talk) required.

**6. Audio-reactive animation**  
Amplitude from the mic input (user speaking) and from the AI's audio output (character speaking) both drive the animation — making it a mirror of the actual conversation rhythm.

---

## Our current UI (as of 2026-04-13)

```
[mic icon button]  ← idle: static mic icon
[Stop]             ← recording: text label
[Thinking...]      ← thinking: text label, button disabled
```

**What's working:**
- Mic icon is universally understood — good discoverability
- One click to start, one click to stop — correct interaction model for Gemini Live (server-side VAD, no hold-to-talk needed)
- Chat panel already positioned correctly as a secondary transcript layer

**What to improve:**
- "Stop" and "Thinking..." text labels go against the industry pattern — animation should carry this
- Button is disabled during thinking state — this is explicitly what the research says to avoid (slow pulse instead)
- No visual feedback that a live conversation is in progress — user can't tell if the session is active just by looking at the button
- "Hold Ctrl + Space to talk" tooltip is wrong for Gemini Live (VAD handles turn-taking, no hold needed)

---

## Design direction for Interact Studio

### Approach: Evolving the mic button (not replacing it)

The mic button icon already solves discoverability — users know what a mic means. The change is purely in the **live state visual language**.

#### Idle state (no change needed)
- Static mic icon button
- Clear CTA, universally understood

#### Live states (new)
- A **pulsing ring** around the existing button that communicates state through animation
- The button icon itself stays as-is — the ring is the only addition

| State | Ring behaviour |
|---|---|
| Connecting | Fast spin / loading arc |
| Listening | Slow breathing pulse (scale 1.0 → 1.15 → 1.0, ~2s cycle) |
| User speaking | Ring reacts to mic amplitude — expands with voice |
| Character speaking | Ring shifts colour (e.g. accent colour), gentle pulse |
| Thinking | Same as listening — slow pulse, NOT disabled, NOT spinner |

#### What gets removed
- "Stop" text label → button stays as mic icon with the ring indicating live state
- "Thinking..." text + disabled state → slow pulse ring instead
- "Hold Ctrl + Space to talk" tooltip → remove entirely (VAD handles turn-taking)

### Future: Full orb (when voice is a core product feature)

ElevenLabs has open-sourced their Three.js orb component at [ui.elevenlabs.io](https://ui.elevenlabs.io/docs/components/orb) — fully customisable colours, all 4 states built in, audio-reactive. Worth adopting when Gemini Live is the primary interaction mode rather than a feature alongside text.

---

## Implementation plan

**Phase 1 — Ship with Gemini Live:**
1. Add pulsing ring CSS animation to the mic button for live states
2. Drive ring amplitude from Gemini's PCM output (already available in `enqueuePCMChunk`)
3. Remove "Stop" / "Thinking..." text labels
4. Remove Ctrl+Space tooltip on character slides

**Phase 2 — Post-launch:**
1. Evaluate ElevenLabs orb component for a more immersive experience
2. Consider overlay/fullscreen mode (Option 3 from earlier ideation) once users are familiar with the interaction

---

## References

- [ChatGPT Voice Mode FAQ — OpenAI](https://help.openai.com/en/articles/8400625-voice-mode-faq)
- [Gemini AI Visual Design — Google Design](https://design.google/library/gemini-ai-visual-design)
- [Orb Component — ElevenLabs UI](https://ui.elevenlabs.io/docs/components/orb)
- [ElevenLabs UI: Open-source agent components](https://elevenlabs.io/blog/elevenlabs-ui)
- [Voice UI Design Guide 2026 — FuseLab Creative](https://fuselabcreative.com/voice-user-interface-design-guide-2026/)
