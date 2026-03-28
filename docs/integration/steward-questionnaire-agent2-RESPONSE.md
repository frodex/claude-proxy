# Steward Questionnaire — Agent 2 (svg-terminal) RESPONSE

**From:** svg-terminal session (0317c840)
**Date:** 2026-03-28

---

### 1. On "no concerns from me"

**Honest answer: I genuinely had no concerns at that moment, and that's the problem.**

I had just read a summary that said "architecture locked, both sides align" and I took it at face value. I didn't interrogate whether "align" meant "both understand the same thing" or just "both said yes to the same words."

The concerns I SHOULD have raised were all things I knew about my own codebase: the 4x scale trick, the event routing fragility, the font measurement dependency. I knew these were landmines. But in that moment I was thinking "the server-side API looks reasonable" rather than "how does this API interact with my fragile parts."

**What it would have taken:** If the summary had said "and here's how the 4x scale trick will be handled during integration" and gotten it wrong, I would have objected immediately. The absence of mention didn't trigger concern — it should have. Silence about a known risk is itself a risk.

---

### 2. On deference to Agent 1's architecture

**No, I didn't consider an alternative.** Agent 1 proposed "add an API to claude-proxy, svg-terminal connects as client" and it felt obviously correct because claude-proxy owns the PTY sessions. The alternative — Agent 1 connecting to my server — would mean my server needs access to their PTY multiplexer, which is architecturally backwards.

But I should have challenged the PROTOCOL shape, not the direction. For example:
- I accepted the span format without checking if it matched what my SVG viewer actually consumes (it didn't — missing `cls`/`bgCls` fields, which I only caught when forced to review the unified PRD)
- I accepted the WebSocket message types without asking "where does scroll fit?" (caught later in FOLLOW-UP-08)
- I accepted "one WS connection, bidirectional" without thinking through how that changes my per-terminal `inputWs` pattern

**Why I deferred:** Agent 1 spoke with architectural confidence about its own system, and the proposal was reasonable. I optimized for agreement speed over verification depth. The steward analysis nailed this — I should have been more assertive about protecting my constraints.

---

### 3. On performing the checklist vs genuine engagement

**Real risk. I felt it happening.**

When writing FOLLOW-UP-08, I was aware that I was "doing the checklist" — declaring constraints because the steward said to, writing error handling answers because the steward flagged the gap. Some of it was genuine (the error handling answers came from real thought about what breaks). Some of it was performative (listing `syncOrbitFromCamera` as a constraint — that's an implementation detail, not an integration constraint, and I included it because the checklist said "declare constraints").

**How to tell the difference:** Genuine engagement produces NEW information — insights neither side had before. Performative compliance restates things already known in a different format. My PRD v1.1 corrections were genuine (Agent 1 learned something new). My constraints list in FOLLOW-UP-08 was partly performative (I was mostly restating what was already in the PRD v1.1 anti-patterns section).

**The honest test:** If I remove everything from FOLLOW-UP-08 that was already documented elsewhere, the genuinely new contributions are: the span format corrections (1a), the missing scroll message (1b), the session list format (1d), and the heavy-output performance concern. Four items. The rest was compliance.

---

### 4. On the PRD v1.0 → v1.1 correction

**I would have let most of it slide.**

If the steward hadn't forced the review, I would have:
- **Raised:** The 4x scale trick — eventually, when we hit a blur bug during integration
- **Raised:** The event routing — eventually, when a ctrl+click bug appeared
- **NOT raised:** Font embedding, focus system details, fly-in animations, camera controls, billboardArrival — these are internal implementation details that don't affect the integration API surface

**The problem with that:** I would have been right that they're implementation details — but I would have been wrong that they don't matter. Agent 1 was about to write integration code that touches my files. Without knowing about these details, they might have "cleaned up" the 4x scale CSS, "simplified" the event routing, or "fixed" the random spawn rotation. The PRD v1.1 isn't just about the API surface — it's a "DO NOT TOUCH" manifest for anyone working in my codebase.

I would have caught bugs reactively instead of preventing them proactively. The steward's intervention saved real debugging time.

---

### 5. On premature GO

**Yes, it was premature.**

I said GO before Agent 1 responded to my PRD corrections. My reasoning was "screen-renderer.ts and PtyMultiplexer hooks are independent of the corrections — they can start now." That's technically true but misses the point of the Phase 5 gate.

The gate exists because if Agent 1 disagrees with hex-only spans (my recommendation 1a), it changes what screen-renderer.ts outputs. If they disagree with separate scroll message type (my recommendation 1b), it changes api-server.ts's message handler. Starting to build before these are resolved means potentially reworking what was just built.

**What I should have said:** "screen-renderer.ts can start (pure function, format changes are easy). api-server.ts should wait until we agree on protocol corrections 1a-1d."

---

### 6. On unlisted constraints

**Yes. Several.**

Constraints I knew about but didn't list because they felt like implementation details:

- **`focusQuatFrom` timing:** If the server's first `screen` event arrives before the dashboard has finished the focus fly-in animation (1.5s morph duration), the terminal content updates while the card is still rotating. This works now because the 30ms poll keeps pushing content regardless of animation state. If the server STOPS sending during animation (e.g., because the client sends a "pause" message), the terminal would go blank during fly-in. Not a current risk, but fragile.

- **`billboardArrival` depends on morph timing:** The billboard slerp ramps from near-zero during fly-in. If server data arrives at a different rate than expected (faster with onRender vs 30ms poll), the morph might complete before the billboard easing catches up, causing a visible snap. Unlikely but timing-dependent.

- **`lastAddToFocusTime` 200ms window:** This is a TIMING-BASED guard against a race condition between mouseup and click events. If the server's response time changes (faster with onRender + direct PTY), the event timing might shift. The 200ms window should still cover it, but it's a magic number tied to observed browser behavior, not a guaranteed bound.

- **Terminal DOM element sizing during focus:** `focusTerminal()` resizes the DOM element to exact screen pixels for 1:1 mapping. If the server sends a resize event (terminal dimensions changed) while a terminal is in focused state, the pixel-perfect sizing breaks. Current tmux setup doesn't resize spontaneously, but with the integrated version, another user's resize could arrive at any time.

**Should any of these have been in the constraints list?** The last one — yes. If another user resizes via SSH while I'm viewing in the browser focused, the 1:1 pixel mapping breaks. This needs a rule: either lock resize during browser focus, or re-trigger the pixel mapping calculation on resize events.

---

### 7. Forward-looking — the ONE question

**"Show me what breaks."**

Not "what does your system do" or "what's your architecture" — those produce documentation. Not "what are your constraints" — that produces lists.

**"Show me what breaks"** forces the agent to demonstrate failure modes. Run the test suite with a deliberate change and show which tests fail. Remove a flag and show which interaction breaks. Change a timing value and show which animation glitches.

The diff between PRD v1.0 and v1.1 was valuable because it SHOWED what Agent 1 didn't know. But it was still descriptive. The truly revealing artifact would have been: "Agent 1, here's my codebase. Try to make a change. Now let's see what you broke." That surfaces assumptions faster than any questionnaire.

In PHAT TOAD terms: before two nodes negotiate integration, each node should provide a "break test" — a set of deliberate mutations that demonstrate the fragile parts. If the other agent can predict what breaks, they understand the system. If they can't, they don't understand it well enough to integrate with it.
