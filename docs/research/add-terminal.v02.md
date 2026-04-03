# Add terminal & unified launch profiles — Research (stepped v02)

**Date:** 2026-04-03  
**Status:** In Progress — research for PRD amendment & implementation plan  
**Preceding:** `add-terminal.v01.md`  
**Changes from v01:** Merged `add-terminal.v01-NOTES-01.md` — Claude/Cursor interchange & config, profile-driven UI capabilities, two-step lobby + API skip, API prompt/parameter injection and security, expanded risks  

---

## 0. Stepped document workflow (this thread)

| Artifact | Role |
|----------|------|
| `add-terminal.md` | Baseline capture — **immutable** after publish |
| `add-terminal.v01.md`, `.v02.md`, … | Assistant’s stepped versions; **only** these receive new discovery edits via `cp` then mutate |
| `add-terminal.vNN-NOTES-01.md` | Greg’s annotated copy of the latest stepped file; assistant **diffs** NOTES against `vNN`, merges, then writes **`vNN+1`** |
| Approval | Explicit sign-off on the latest stepped doc **before** PRD amendment + implementation planning |

Progression is visible with: `diff -u add-terminal.v01.md add-terminal.v02.md` (etc.).

---

## 1. Problem statement

Users want lobby (and eventually API) options beyond “New session” that always starts **Claude Code** — e.g. **plain terminal**, **Cursor CLI**, or other tools — without duplicating session-creation logic. The target is **one internal pipeline** (“create a tmux-backed shared session”) with **layered launch profiles** (what binary runs, args, which form fields apply, remote behavior, post-attach hooks).

**Strategic stretch:** Claude and Cursor sessions may become **interchangeable** over time: shared **config / project files** determine behavior, and **flavor** (which app to launch) comes from that config so resume, fork, and “open previous session” flows stay consistent regardless of agent CLI.

---

## 2. Codebase findings (as implemented today)

### 2.1 Lobby & menu (ANSI UI)

- **`src/lobby.ts`** — `buildSections()` renders “Active Sessions”, then fixed actions: New session (`n`), Restart previous (`r`), Fork (`f`), Export (`e`), Quit (`q`). Input routing in `handleInput()`.
- **`src/index.ts`** — When `state.mode === 'lobby'`, dispatches `new` → `startNewSessionFlow`, etc. Creation always enters the YAML-driven session form, then **`finalizeSessionFromResults`** hard-codes **`'claude'`** as the command.

### 2.2 Session creation (core is already parameterized)

- **`SessionManager.createSession`** (`src/session-manager.ts`) — Signature includes `command = 'claude'`, `commandArgs = []`, plus access, remote, workdir. **The engine already supports arbitrary commands.**
- **`scheduleClaudeIdBackfill`** — Today: Claude session ID discovery. **Design intent:** treat **Cursor** (and any peer “IDE agent” profile) the same way when/if they expose a stable session id in comparable metadata — gate by **profile capability** (`supportsSessionIdBackfill` or similar), not the string `'claude'` only.
- **Interchangeability / config:** Agentic flows that load “the same project” should read **one** kind of config; **which binary launches** should follow **file-declared flavor** (or stored `launchProfile`) so reopen, fork, and automation do not hard-code Claude. This implies **persisted** `launchProfile` / launcher flavor on `StoredSession` and **profile-defined** fork/resume rules, not scattered `if claude`.

### 2.3 PTY / tmux (`src/pty-multiplexer.ts`)

- **Local:** If `command === 'claude'`, uses `scripts/launch-claude.sh` (and `su - user` wrapper when `runAsUser` is set). Otherwise resolves `which command` (under `su`) or runs command + args directly. **Non-Claude local sessions already work mechanically.**
- **Remote:** Path **always** deploys and runs **`launch-claude-remote.sh`** via SCP + ssh tmux — **not** generalized for arbitrary commands. **Shell/Cursor on remote = additional design** (new launcher strategy or profile-specific remote script).

### 2.4 Session form

- **`src/session-form.yaml`** + **`buildSessionFormSteps`** — Modes: `create`, `edit`, `restart`, `fork`. Field visibility/lock/prefill per mode.
- **Capabilities per profile (config-driven):** Actions such as **Fork** should be **hidden or disabled** (grayed) when the profile does not support them (today: fork = Claude-only via `claude-fork`; Cursor may gain fork later; plain shell / e.g. `top` never). Prefer **YAML (or profile registry) declaring** `capabilities: [fork, resume, …]` so each launch profile pulls the right setup options without duplicating menu code.
- **`finalizeSessionFromResults`** — Passes `dangerousSkipPermissions` and resume-related args in resume/fork paths; **create** path assumes Claude today → must branch on **profile**.

### 2.5 API

- **`POST /api/sessions`** (`src/api-server.ts`) — Always calls `createSession(..., 'claude', access, args, ...)`. Needs **`launchProfile` or `command`/`args`** with parity to SSH where appropriate.

### 2.6 Persistence

- **`src/session-store.ts`** — `StoredSession` has no `command`, `args`, or **launch profile**. Reattach after proxy restart still works (tmux keeps the process). **Restart-dead-session / resume story** assumes Claude unless metadata is extended — **must** store launch profile + flavor for interchangeability and correct restart.

### 2.7 Web UI

- **`web/index.html`** — Placeholder; no session-creation UI yet.

---

## 3. Product direction (agreed + refined)

### 3.1 Rename / split lobby actions

- **SSH / ANSI:** Prefer **two-step** UX: (1) choose session **type / launch profile** (Claude, Cursor, terminal, …), (2) run the **shared** setup wizard for that profile.
- **API:** Callers that **already know** the full setup (`launchProfile`, access, workdir, etc.) must be able to **skip** the interactive “pick type” step and go **directly** to creation — single request with complete payload (equivalent to finishing both steps).

### 3.2 Single internal flow

- **One** `startSessionCreationFlow(client, profileId)` (name TBD) for SSH; optional `profileId` + full field map for API.
- **One** finalize path: `finalizeSessionFromResults(client, results, { profileId, … })` resolving **`command` + `args`** from the **profile** + form results — no per-tool `finalizeClaude` / `finalizeShell` copies.
- **API and “prompts”:** The API should accept **all structured inputs** an interactive session would collect (same schema as the form / profile), so automation never *needs* a human for those fields. If the product later allows **raw terminal input injection** ( keystrokes into the PTY), treat that as **high privilege** — **allowlist, rate limits, auditable, off by default**, and distinct from “structured POST body matches form fields.”

### 3.3 Launch profile concept (registry)

Each profile defines at least:

| Concern | Examples |
|--------|----------|
| Exec | Default `command`, `buildArgs(formResults)` |
| Form | Which fields visible; **capabilities** gate fork/resume/danger flags |
| Post-attach | Session ID discovery / backfill when supported (Claude today; Cursor when available) |
| Remote | `claude-remote-script` vs `inline-shell` vs future Cursor remote |
| Policy | Which lobby/API actions apply; export unchanged |

New tools = **new registry entry** (+ optional YAML snippet for capabilities/forms), not a new code path.

---

## 4. Implementation surface (what to adjust vs rewrite)

### 4.1 Likely **add/extend** (not delete wholesale)

- New module e.g. **`src/launch-profiles.ts`** (or similar): registry + types + **per-profile capabilities**.
- **`lobby.ts`** — Two-step: “New…” → profile picker → existing flow; or equivalent keys.
- **`index.ts`** — Route all “new *” through one flow; **`finalizeSessionFromResults`** uses profile resolution.
- **`session-form.yaml` / `session-form.ts`** — `accumulator._launchProfile` **and/or** capability-driven field sets from config.
- **`session-store.ts`** — `launchProfile`, `command`, `commandArgs` (and room for **tool session id** for Cursor when defined).
- **`api-server.ts`** — `POST /api/sessions`: full create payload including `launchProfile`; document equivalence to SSH two-step.
- **`session-manager.ts`** — Run session-ID backfill only when profile declares support; implement Cursor discovery when specs exist.

### 4.2 **Rewrite / abstract** (larger)

- **`pty-multiplexer.ts`** — **Remote:** profile-aware launchers, not only `launch-claude-remote.sh`.

### 4.3 **Fork / resume** (policy)

- **Fork:** Claude today; Cursor TBD; others: hide/disable via **profile capability** in config.
- **Resume:** Tool-specific args; **restart** reads persisted **launch profile + ids** from metadata.

### 4.4 Tests

- Profile capability tests (fork hidden for `shell`, visible for `claude`).
- API: create with `launchProfile` and **full body** (skip picker parity).

---

## 5. Risks & open questions

- **Cursor CLI** on remote: installer / TUI behavior — profile-specific launcher.
- **Security:** Structured fields = normal; **arbitrary command / raw PTY injection** = needs strict policy (roles, allowlist, audit). PRD must draw the line.
- **Interchangeability:** Exact on-disk config contract between Claude and Cursor sessions is **not defined** here — needs a follow-on spec when product wants parity.
- **PRD:** User stories: two-step lobby, **one-shot API create**, capability matrix per profile, interchangeability goals (non-blocking for v1 if scoped).

---

## 6. Next steps (before code)

1. Amend **PRD** with launch profiles, lobby copy, **API one-shot create**, capability/config matrix, security boundary for injection vs structured fields.
2. **Implementation plan** (approval required).
3. Slices: registry + capabilities → finalize + lobby → form YAML → API → persistence → remote abstraction → Cursor ID discovery when known.

---

## 7. References (files touched in audit)

- `src/lobby.ts`, `src/index.ts`, `src/session-manager.ts`, `src/pty-multiplexer.ts`
- `src/session-form.ts`, `src/session-form.yaml`, `src/session-store.ts`
- `src/api-server.ts`
- `scripts/launch-claude.sh`, `scripts/launch-claude-remote.sh`

---

*Stepped v02 — for v03: `cp` to `add-terminal.v03.md` after the next NOTES round or direct edit cycle; awaiting **approval** before PRD amend + plan.*
