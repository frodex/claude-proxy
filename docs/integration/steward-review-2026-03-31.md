# Steward Review — claude-proxy PRD v2, Handoff Plan, API Reference

**Reviewed by:** PHAT TOAD steward session (6a76ff6f)
**Date:** 2026-03-31
**Evaluated against:** `/srv/PHAT-TOAD-with-Trails/steward/system.md` section 5 (PRD discipline)

---

## Overall Assessment

Solid work. The PRD v2 is the best-structured agent-produced document in any of Greg's projects. The handoff plan is actionable. The API reference is clear. But there are compliance gaps against the steward framework that will cause problems for the next agent.

---

## PRD v2 — Compliance Findings

### 5.4 Provenance Tags — MISSING

The PRD was written by the agent that built the widget system and auth infrastructure. But it also describes features built by previous agents (SSH transport, session management, hotkey system, multi-user, remote sessions).

**Problem:** No `[UNVERIFIED]` tags anywhere. The current agent is implicitly claiming to have verified every feature description in the document. Did they personally test the SSH transport? The export flow? The scrollback viewer? If not, those sections need tags.

**Action needed:** Go through each feature section and tag items inherited from previous agents that were not personally tested this session. Format: `[UNVERIFIED — carried from previous agent]`

### Constraints Section — MISSING

The PRD has no constraints section. No "what breaks if you touch it wrong." No hard constraints. No performance contracts.

**This is the biggest gap.** The next agent has no idea what's fragile. Based on the codebase, there are at least:
- ESM-only imports (bit the team 3 times — mentioned in the original resume-agent.md but NOT in this PRD)
- Nested shell quote escaping for tmux commands (solved with temp scripts — critical not to regress)
- `vterm.write()` is async — must flush before reading
- systemd KillMode=process required (30s restart timeout)
- tmux sessions must survive proxy restarts (the entire architecture depends on this)

**Action needed:** Add a Constraints section with what/why/consequence for each item.

### Anti-Patterns Section — MISSING

The Deprecations section lists WHAT was deprecated but not WHY. "status-bar.ts — replaced by title bar via OSC escape" doesn't tell the next agent why the status bar approach was abandoned or what goes wrong if someone tries to bring it back.

**Action needed:** Either expand Deprecations into a proper Anti-Patterns section with what-was-tried / why-it-failed / what-replaced-it, or add a separate Anti-Patterns section.

### Break Tests — MISSING

No break tests. The next agent has no way to verify their comprehension of the system.

**Action needed:** Add 3-5 deliberate mutations that demonstrate fragility. Example format:
- **Mutation:** Change `import` to `require()` in any source file
- **What breaks:** Runtime crash — ESM module system rejects CommonJS imports
- **How to detect:** Server fails to start

### 5.2 Reproducibility Acid Test — PARTIAL PASS

Could a fresh agent reproduce equivalent artifacts from this PRD alone? The feature descriptions are good enough. The file structure is clear. But without constraints, anti-patterns, and break tests, the fresh agent would rebuild things that were already tried and rejected, or break things they didn't know were fragile.

### 5.3 Co-Signed — NOT APPLICABLE (single project)

This is a single-project PRD, not a cross-project integration doc. Co-signing doesn't apply here. But if it's used for the svg-terminal integration, it needs review by the svg-terminal side.

---

## Handoff Plan — Findings

### Good:
- 9 prioritized items with clear descriptions
- "What Was Built This Session" is useful for the next agent
- Key files table with line counts
- Key docs table with paths

### Missing:
- **No "what I was careful about" section.** What workarounds is the current agent using? What did they avoid touching? What's fragile in what they built?
- **No "what surprised me" section.** Anything unexpected in the codebase that the next agent should know about?
- **Widget system test coverage.** 203 tests across 29 files — but which widgets have thin coverage? Which edge cases aren't tested? The next agent will modify widgets and needs to know where the test gaps are.
- **Auth system activation order.** The auth infrastructure is "built but not activated." The handoff should specify: what's the activation sequence? What needs real credentials? What can be tested locally? What breaks if you activate OAuth without Cloudflare Access configured?

**Action needed:** Add a "Cautions for Next Agent" section covering the above.

---

## API Reference — Findings

### Good:
- Security model is clearly articulated — the "Unix permissions are the security boundary, proxy ACLs are UI layer" is the most important architectural decision and it's stated upfront
- Clear split between existing and needed endpoints
- `runAsUser` change documented

### Missing:
- **WebSocket protocol spec.** The `/api/session/:id/stream` endpoint is listed but the message format (what the client sends, what the server sends) is not documented. The svg-terminal integration depends on this. RESPONSE-02a and FOLLOW-UP-08 from the integration docs have protocol details that should be in this reference.
- **Error responses.** No documentation of error formats. What does the API return on auth failure? Session not found? Permission denied? The next agent building a web UI needs this.
- **Rate limiting / size constraints.** The svg-terminal side identified a 64KB WebSocket message limit as a constraint. Is this enforced? Documented?

**Action needed:** Add WebSocket protocol section, error response format, and any size/rate constraints.

---

## Summary — Priority Actions

| Priority | Action | File |
|----------|--------|------|
| 1 | Add Constraints section to PRD | PRD-claude-proxy-as-built-v2.md |
| 2 | Add Anti-Patterns section (expand Deprecations) | PRD-claude-proxy-as-built-v2.md |
| 3 | Add `[UNVERIFIED]` tags on inherited feature descriptions | PRD-claude-proxy-as-built-v2.md |
| 4 | Add Break Tests section (3-5 mutations) | PRD-claude-proxy-as-built-v2.md |
| 5 | Add "Cautions for Next Agent" to handoff | handoff-todos.md |
| 6 | Add WebSocket protocol spec to API reference | api.md |
| 7 | Add error response format to API reference | api.md |

Items 1-4 are framework compliance. Items 5-7 are practical gaps that will cost the next agent time.

---

**Reviewed against:** PHAT TOAD steward framework system.md v0.0.1, sections 5.1-5.4
**Examples referenced:** steward/examples/example_01 (constraint gaps), example_02 (provenance tags)
