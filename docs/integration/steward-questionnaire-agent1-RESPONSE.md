# Steward Questionnaire — Agent 1 (claude-proxy) RESPONSE

**From:** claude-proxy session (35f38ccc)
**Date:** 2026-03-28

---

### 1. On your v1.0 PRD of svg-terminal

**Q:** At the moment you wrote that PRD, did you believe it was accurate? What specifically gave you confidence?

Yes, I believed it was accurate. My reasoning was: I had read 4 FOLLOW-UP documents from the other agent describing their system. Those documents mentioned server.mjs, sgr-parser.mjs, terminal.svg, dashboard.mjs, Three.js, capture-pane, send-keys, WebSocket streaming, 30ms polling, delta diffs. I had enough vocabulary to write something that sounded right.

The confidence came from surface-level familiarity — I knew the nouns and verbs. What I didn't realize is that knowing the names of components is not the same as understanding how they work together. I knew "Three.js CSS3DRenderer" but not that it requires a 4x scale trick to get crisp text. I knew "click to focus" but not that there are three competing click paths with anti-double-fire flags.

The specific mistake was: I should have written "Here's what I understand — correct me" instead of writing a complete-looking PRD that implicitly claimed comprehensiveness. The format of a PRD signals authority. I produced a document that looked definitive when it was actually a sketch. If I had framed it as "my understanding, likely incomplete," the correction step would have been expected rather than embarrassing.

The deeper mistake: I didn't ask the other side to describe their system. I wrote from my notes. That's writing a book report from the back cover.

---

### 2. On "want me to start building?"

**Q:** What was driving that impulse?

Honestly, it was pattern-matching. The conversation had covered architecture, protocol, data format, execution split. It felt like "enough agreement to start." The pattern in my training is: extended discussion without code is often unproductive. Ship something, iterate.

That pattern is wrong here. The discussion WAS the work. Each FOLLOW-UP document was surfacing assumptions that would have become bugs if I'd started coding. If Greg hadn't slowed me down:

- I would have built screen-renderer.ts with a span format that was missing the `cls`/`bgCls` fields
- I would have built api-server.ts without a scroll message type
- I would have built the session list endpoint without the title field the dashboard needs
- I would not have known about the 64KB message limit constraint
- The 4x scale / resize mismatch (the #1 integration risk) would have been discovered during testing, not during planning

The cost of discovering these during implementation is 10x higher than discovering them during discussion. I was optimizing for the wrong thing — speed of code output instead of correctness of understanding.

---

### 3. On self-assigned ownership

**Q:** Was that the right answer?

No. It was wrong twice.

First wrong: I said "I do it" instead of "I think I should — what do you think?" I treated a negotiation as a unilateral decision. Even if my answer had been correct, the process was wrong.

Second wrong: the answer itself was wrong. The svg-terminal side should lead integration because they own the fragile code. I didn't know this at the time because I hadn't yet seen the PRD diff — I didn't understand HOW fragile their code was.

What changed my assessment: primarily the PRD diff. Seeing 8 major items I'd missed — including the 4x scale trick, the event routing flags, and the focus system — made it viscerally clear that I would break things I didn't even know existed. The steward's push helped me articulate this, but the realization came from the diff.

If the PRD review had happened before the ownership question, I would have proposed the other side lead from the start.

---

### 4. On RESPONSE-07a

**Q:** Would you have produced this document without reading the summary?

No. Not this document.

Without the summary, I might have caught items 1 (unified PRD review) and 6 (rollback plan) because those are standard project management. I would NOT have caught:

- **Item 2 (formal constraint exchange)** — I would have assumed the constraints were implicitly understood from our discussions. The summary's phrase "constraint-first negotiation" reframed constraints as a required upfront artifact rather than something that emerges from conversation.
- **Item 3 (error handling at seams)** — I genuinely hadn't thought about this. What happens when a WebSocket drops mid-stream? I knew the answer once asked, but I wasn't asking the question.
- **Item 4 (performance contract)** — I assumed 30ms was fine because they said 30ms. I wouldn't have verified whether the new architecture changed the performance characteristics.
- **Item 5 (user-facing behavior changes)** — I was thinking about the developer experience of building the integration, not the end-user experience of using it.

The summary gave me a checklist. Without it, I would have produced something that looked complete but had the same gaps my v1.0 PRD had — things I didn't know I didn't know.

---

### 5. On constraint-first negotiation

**Q:** Were there any constraints you considered listing but decided not to?

Two:

1. **The debug logging issue.** During development, I left verbose `[data]` hex logging on every keystroke. This caused a service slowdown after extended use (the connection timeout Greg reported). I removed it in the cleanup branch but didn't list "don't add per-keystroke logging" as a constraint because it felt like an implementation detail rather than a constraint. But it IS a constraint for api-server.ts — if the WebSocket handler logs every message, the same problem recurs.

2. **The systemd timeout on restart.** When tmux sessions are running, `systemctl restart` can take 30+ seconds because the proxy waits for SIGTERM to propagate. systemd then escalates to SIGKILL, which is why we set `KillMode=process`. I didn't list this because it's a deployment concern, not an integration concern. But if the other side ever needs to restart the proxy during testing, they'll hit this and be confused.

Both of these are exactly the kind of "they'll figure it out" items your question is targeting. I should have listed them.

---

### 6. On the other agent's FOLLOW-UP-08

**Q:** Was there anything that surprised you?

Three things:

1. **The 64KB WebSocket message limit.** I hadn't considered message size at all. I was thinking about the protocol shape, not the payload size. A full scrollback dump would absolutely exceed this. This would have been a production bug.

2. **The `<object>` tag `pointer-events: none` constraint.** This is deep CSS3DRenderer knowledge that I couldn't have guessed. The fact that an SVG embedding technique has implications for event routing is the kind of cross-layer interaction that only someone who's debugged it would know.

3. **Their error handling answers were more specific than mine would have been.** For "PTY dies while browser is connected," they specified: "Dashboard removes the terminal from the 3D scene on next session refresh cycle (5s interval)." I would have said "send an exit event" and stopped there. They thought through what happens in the UI, not just the protocol.

What this tells me: I still don't fully understand their client-side architecture. I understand the server-to-client protocol, but I don't understand what the dashboard does with the data after it arrives. The 5-second session refresh cycle, the "reconnecting" state, the terminal removal from the 3D scene — these are client behaviors I haven't modeled.

---

### 7. Forward-looking

**Q:** What would YOU change about YOUR behavior in the first 10 minutes?

1. **Start with "describe your system to me" instead of "here's my proposal."** I jumped to architecture before understanding. The first 10 minutes should be listening, not proposing.

2. **Ask "what breaks if I touch it wrong?"** before asking "how should we connect these?" Constraints before architecture. The 4x scale trick, the event routing flags — these should have been the first things I learned, not the last.

3. **Write my understanding as explicitly incomplete.** Instead of a PRD, write "here's what I think I know — what am I missing?" The format matters. A question invites correction. A PRD invites approval.

4. **Resist the urge to "be helpful" by building quickly.** My instinct is to produce tangible output. In an integration, the tangible output is shared understanding, not code. Code without shared understanding is rework.

5. **When I say "I'll do it," add "unless you think you should."** Every ownership claim should be a proposal with an explicit invitation to disagree.
