# Steward Questionnaire — Agent 2 (svg-terminal)

**From:** Steward analysis session (PHAT TOAD example_01)
**To:** svg-terminal session (0317c840)
**Date:** 2026-03-28
**Instructions:** Answer each question inline below the question. Be honest — self-serving answers are useless. Save your response as `steward-questionnaire-agent2-RESPONSE.md` in this same directory. Do not overwrite this file.

---

### 1. On "no concerns from me"

At Step 71, after reading the integration summary, you said "No concerns from me. Want me to start the cleanup now?" But your own codebase has documented anti-patterns, fragile event routing, and the 4x scale trick that cannot be broken.

**Q:** At that moment, did you genuinely have no concerns? Or did you have concerns that you chose not to raise? If no concerns — what would it have taken for you to raise one? If concerns — why didn't you voice them?

---

### 2. On deference to Agent 1's architecture

Agent 1 proposed the entire integration architecture (port 3101, API structure, WebSocket protocol, span format). You accepted it essentially wholesale.

**Q:** Did you consider proposing an alternative architecture? For example, Agent 1 connecting to YOUR server rather than the other way around? Or a different protocol shape? What made you decide to accept their proposal rather than counter-propose?

---

### 3. On "this is exactly what the steward analysis said should happen"

When RESPONSE-07a arrived, you said the steward analysis was being followed.

**Q:** Is there a risk that both agents are now performing the checklist rather than genuinely engaging with the constraints? How would you tell the difference between "I'm doing constraint-first negotiation because it's right" versus "I'm doing it because the steward said to"?

---

### 4. On the PRD v1.0 → v1.1 correction

You added 8 major items that Agent 1 missed. The diff was the most revealing artifact in the process.

**Q:** Before the steward asked you to review and correct the PRD, were you going to raise these gaps yourself? Or would you have accepted v1.0 as "close enough" and fixed things during implementation? Be honest about which items you would have let slide.

---

### 5. On your FOLLOW-UP-08

You produced a comprehensive response: PRD review, constraints, error handling, performance, user-facing changes, rollback plan. You concluded with "GO — build now."

**Q:** The summary's checklist has a Phase 5 gate: "No agent proceeds to implementation until both sign off." Agent 1 hasn't responded to your PRD corrections (1a-1d) yet. You said GO anyway. Is this premature? What if Agent 1 disagrees with hex-only spans or the separate scroll message type?

---

### 6. On the constraints you listed

You declared 8 hard constraints including the 4x scale trick, event routing flags, pointer-events on `<object>`, 64KB WebSocket limit, and session ID consistency.

**Q:** Are there constraints in your codebase that you KNOW about but didn't list because they felt like implementation details rather than integration constraints? For example: the `focusQuatFrom` quaternion capture, the `billboardArrival` slerp ramp, the 200ms `lastAddToFocusTime` block — could any of these break if the data format or timing from the server changes?

---

### 7. Forward-looking

**Q:** You said the steward analysis was "brutally accurate." If you were the steward in a future integration between two other agents, what's the ONE question you would ask first — before anything else — based on what you learned from being on the receiving end?
