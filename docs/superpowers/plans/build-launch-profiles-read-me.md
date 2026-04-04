# Agent startup — Launch profiles + post-work web UI

Use this document as the **first message** (or project instructions) for a new agent session tasked with implementing launch profiles and, later, unifying the web UI.

---

## Mission

1. **Implement** the full plan at **`/srv/claude-proxy/docs/superpowers/plans/2026-04-03-launch-profiles.md`** (launch profile registry: `shell` / `claude` / `cursor`; `StoredSession.launchProfile`; lobby two-step flow; `session-form` + YAML gating; `operations` / API `POST /api/sessions` with `launchProfile`; session-manager backfill gating; tests). Follow the plan’s task order and checkboxes; use **`superpowers:subagent-driven-development`** or **`superpowers:executing-plans`** as the plan header requires.
2. **After** launch profiles ship, **unify the web UI** so the browser experience matches the new session model (see **“Follow-up: unify web UI”** at the end — not part of the same PR unless the user says otherwise).

---

## Repos and roots

| Repo | Path |
|------|------|
| **Platform (this work)** | `/srv/claude-proxy` |
| **Client / dashboard + prototype** | `/srv/svg-terminal` |

---

## History you need (short)

- **Phase A** moved API logic into **`/srv/claude-proxy/src/operations.ts`**. **`createSession`** still hardcodes launch kind **`'claude'`** in **`sessionManager.createSession(..., 'claude', ...)`** — launch profiles are **not** implemented yet despite optional **`launchProfile`** on **`CreateSessionRequest`** in **`operation-types.ts`**.
- **`StoredSession`** in **`/srv/claude-proxy/src/session-store.ts`** does **not** yet persist **`launchProfile`** (plan adds it).
- **Unix socket / Phase C** exists; **`socket-server`** dispatches to **`ProxyOperations`** — any new **`createSession`** behavior must stay consistent over HTTP + socket.
- **Web UI today:** claude-proxy **`/srv/claude-proxy/web/index.html`** is a stub. The **spec’d unified web UI prototype** is **`/srv/svg-terminal/ui-web/prototype.html`** with roadmap **`/srv/svg-terminal/ui-web/ROADMAP.md`** — it does **not** yet send **`launchProfile`** or fully mirror launch-profile UX; that is **follow-up** after this plan.

---

## Canonical plan (execute this)

- **`/srv/claude-proxy/docs/superpowers/plans/2026-04-03-launch-profiles.md`**  
  - Contains file map, tasks, suggested tests, and commits. **This is the source of truth for scope.**

---

## Research / context (read for design intent)

- **`/srv/claude-proxy/docs/research/add-terminal.v05.md`** (cited by the plan as **research doc**)
- **`/srv/claude-proxy/sessions.md`** — project context, launch-profile bullets, pending items
- **`/srv/claude-proxy/docs/integration/UNIFIED-PROJECT.md`** — unified checklist; launch profiles row points at this plan

---

## Core implementation files (plan will modify — read as you touch them)

### New (per plan)

- **`/srv/claude-proxy/src/launch-profiles.ts`** (registry — create)
- **`/srv/claude-proxy/tests/launch-profiles.test.ts`** (create)

### Existing — expect edits

- **`/srv/claude-proxy/src/session-store.ts`** — `StoredSession` + `launchProfile?`
- **`/srv/claude-proxy/src/lobby.ts`** — profile menu / two-step “new session”
- **`/srv/claude-proxy/src/session-form.ts`** — `_launchProfile`, `claude-profile-only` predicate
- **`/srv/claude-proxy/src/session-form.yaml`** — conditions on Claude-only fields
- **`/srv/claude-proxy/src/index.ts`** — `startNewSessionFlow`, `finalizeSessionFromResults`, lobby actions
- **`/srv/claude-proxy/src/session-manager.ts`** — `scheduleClaudeIdBackfill` gated by profile capability
- **`/srv/claude-proxy/src/operations.ts`** — **`createSession`** must use profile (today hardcodes `'claude'`)
- **`/srv/claude-proxy/src/api-server.ts`** — if still delegating `POST /api/sessions`, stay aligned with **`operations`**
- **`/srv/claude-proxy/src/socket-server.ts`** — `createSession` / params already pass body; ensure **`launchProfile`** flows
- **`/srv/claude-proxy/src/operation-types.ts`** — already has **`launchProfile?`**; verify end-to-end
- **`/srv/claude-proxy/tests/session-form.test.ts`** — profile-gated fields

---

## Tests and verification

```bash
cd /srv/claude-proxy && npm run build && npx vitest run
```

Add/extend tests exactly as the plan specifies (e.g. **`tests/launch-profiles.test.ts`**, session-form tests).

---

## Skills / process (Cursor / superpowers)

- Start with **`/root/.cursor/skills/using-superpowers/SKILL.md`** (or workspace equivalent) for skill usage.
- For implementation: **`subagent-driven-development`** or **`executing-plans`** per the plan header.
- Optional: **`/root/.cursor/skills/verification-before-completion/SKILL.md`** before claiming “done”.

---

## Follow-up: unify the web UI (after launch profiles)

**Goal:** One coherent browser story: **`/srv/svg-terminal/ui-web/prototype.html`** (and/or **`server.mjs`**-served pages) should **offer the same profile choices** (“New terminal” / “New Claude session” / “New Cursor session” or equivalent) and **`POST /api/sessions`** (or socket **`createSession`**) must send **`launchProfile`** matching the registry IDs. Track alignment with **`/srv/svg-terminal/ui-web/ROADMAP.md`** (W2/W3 rows on profile-aware form). **claude-proxy** **`web/`** may get real **`login.html` / `app.html`** later (OAuth / Phase D) — coordinate with **`/srv/claude-proxy/docs/superpowers/specs/2026-04-03-oauth-web-api-wiring-spec.md`** and **`/srv/claude-proxy/docs/superpowers/plans/2026-04-04-phase-d-oauth-browser-hardening.md`** if auth-gated UI is in scope.

**Do not** conflate this follow-up with the launch-profile plan unless the user explicitly asks for one combined effort.

---

## Success criteria (launch profiles implementation only)

- Plan **`2026-04-03-launch-profiles.md`** tasks implemented, tests green, **`npm run build`** clean.
- **`sessions.md`** and/or **`UNIFIED-PROJECT.md`** updated if you complete the launch-profiles checklist (optional but recommended).
- Clear commit message(s) referencing launch profiles.
