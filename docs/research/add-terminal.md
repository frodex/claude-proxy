# Add terminal & unified launch profiles — Research v0.1

**Date:** 2026-04-03  
**Status:** In Progress — research for PRD amendment & implementation plan  
**Preceding:** none  
**Changes from start:** Initial capture of codebase audit + architecture direction  

---

## 1. Problem statement

Users want lobby (and eventually API) options beyond “New session” that always starts **Claude Code** — e.g. **plain terminal**, **Cursor CLI**, or other tools — without duplicating session-creation logic. The target is **one internal pipeline** (“create a tmux-backed shared session”) with **layered launch profiles** (what binary runs, args, which form fields apply, remote behavior, post-attach hooks).

---

## 2. Codebase findings (as implemented today)

### 2.1 Lobby & menu (ANSI UI)

- **`src/lobby.ts`** — `buildSections()` renders “Active Sessions”, then fixed actions: New session (`n`), Restart previous (`r`), Fork (`f`), Export (`e`), Quit (`q`). Input routing in `handleInput()`.
- **`src/index.ts`** — When `state.mode === 'lobby'`, dispatches `new` → `startNewSessionFlow`, etc. Creation always enters the YAML-driven session form, then **`finalizeSessionFromResults`** hard-codes **`'claude'`** as the command.

### 2.2 Session creation (core is already parameterized)

- **`SessionManager.createSession`** (`src/session-manager.ts`) — Signature includes `command = 'claude'`, `commandArgs = []`, plus access, remote, workdir. **The engine already supports arbitrary commands.**
- **`scheduleClaudeIdBackfill`** — Polls for Claude session ID after attach; **only meaningful for Claude** (should be gated by profile).

### 2.3 PTY / tmux (`src/pty-multiplexer.ts`)

- **Local:** If `command === 'claude'`, uses `scripts/launch-claude.sh` (and `su - user` wrapper when `runAsUser` is set). Otherwise resolves `which command` (under `su`) or runs command + args directly. **Non-Claude local sessions already work mechanically.**
- **Remote:** Path **always** deploys and runs **`launch-claude-remote.sh`** via SCP + ssh tmux — **not** generalized for arbitrary commands. **Shell/Cursor on remote = additional design** (new launcher strategy or profile-specific remote script).

### 2.4 Session form

- **`src/session-form.yaml`** + **`buildSessionFormSteps`** — Modes: `create`, `edit`, `restart`, `fork`. Field visibility/lock/prefill per mode. **`finalizeSessionFromResults`** passes through `dangerousSkipPermissions` and resume-related args only in resume/fork paths — all assume Claude for **create**.

### 2.5 API

- **`POST /api/sessions`** (`src/api-server.ts`) — Always calls `createSession(..., 'claude', access, args, ...)`. Needs **`launchProfile` or `command`/`args`** with allowlisting for parity with SSH.

### 2.6 Persistence

- **`src/session-store.ts`** — `StoredSession` has no `command`, `args`, or **launch profile**. Reattach after proxy restart still works (tmux keeps the process). **Restart-dead-session / resume story** assumes Claude unless metadata is extended.

### 2.7 Web UI

- **`web/index.html`** — Placeholder; no session-creation UI yet.

---

## 3. Product direction (agreed in conversation)

### 3.1 Rename / split lobby actions

- Replace generic “New session” with explicit options, e.g. **New Claude session**, **New Cursor session**, **New terminal** (or a two-step: pick type → same wizard). Internally each sets a **`launchProfileId`** and enters **one** flow.

### 3.2 Single internal flow

- **One** `startSessionCreationFlow(client, profileId)` (name TBD).
- **One** finalize path: `finalizeSessionFromResults(client, results, { profileId, … })` that resolves **`command` + `args`** from the **profile** + form results — no per-tool `finalizeClaude` / `finalizeShell` copies.

### 3.3 Launch profile concept (registry)

Each profile defines at least:

| Concern | Examples |
|--------|----------|
| Exec | Default `command`, `buildArgs(formResults)` |
| Form | Which fields visible (hide `dangermode` for shell; Claude-only toggles) |
| Post-attach | Run Claude session ID backfill or unknown |
| Remote | `claude-remote-script` vs `inline-shell` vs future Cursor remote |
| Policy | Fork may be Claude-only; export unchanged |

New tools = **new registry entry** + menu/API reference, not a new code path.

---

## 4. Implementation surface (what to adjust vs rewrite)

### 4.1 Likely **add/extend** (not delete wholesale)

- New module e.g. **`src/launch-profiles.ts`** (or similar): registry + types.
- **`lobby.ts`** — Extra menu rows + distinct actions or one action + sub-picker.
- **`index.ts`** — Route all “new *” through one flow; replace hard-coded `'claude'` in **`finalizeSessionFromResults`** with profile resolution.
- **`session-form.yaml` / `session-form.ts`** — Conditions on `accumulator._launchProfile` **or** profile-driven enabled field list; avoid duplicating entire YAML trees per profile.
- **`session-store.ts`** — Optional `launchProfile`, `command`, `commandArgs` on `StoredSession` for restart accuracy.
- **`api-server.ts`** — `POST /api/sessions` accepts profile or constrained command/args.
- **`session-manager.ts`** — Skip `scheduleClaudeIdBackfill` when profile says not needed.

### 4.2 **Rewrite / abstract** (larger)

- **`pty-multiplexer.ts`** — **Remote** branch: factor a **profile-aware remote launch** so non-Claude sessions can start on remotes without `launch-claude-remote.sh` only.

### 4.3 **Fork / resume** (policy)

- **Fork** stays Claude-oriented (and **claude-fork** tool); profiles that are not Claude should not expose fork or should show a clear “not available”.
- **Resume** (`--resume`, session id) is Claude-specific; **restart** flows must read persisted launch spec when we add metadata.

### 4.4 Tests

- Extend **`tests/session-form.test.ts`** / integration tests for profile-gated fields.
- New tests for **finalize** resolving correct command/args per profile (mock PTY if needed).
- API tests for **`POST /api/sessions`** with `launchProfile`.

---

## 5. Risks & open questions

- **Cursor CLI** on remote: may need its own installer/PTY behavior — treat as profile-specific remote launcher when we get there.
- **Security:** arbitrary `command` from API must be restricted (allowlist profiles, not free-form for non-admin).
- **PRD:** This doc feeds an **amended PRD** section: user stories (lobby + API), non-goals (e.g. fork on shell), remote parity scope.

---

## 6. Next steps (before code)

1. Amend **PRD** with launch profiles, lobby copy, API contract, remote scope (local-only v1 vs full remote parity).
2. **Implementation plan** (per project convention: plan before code, approval required).
3. Implement in small slices: registry + finalize + lobby labels → form gating → API → persistence → remote abstraction.

---

## 7. References (files touched in audit)

- `src/lobby.ts`, `src/index.ts`, `src/session-manager.ts`, `src/pty-multiplexer.ts`
- `src/session-form.ts`, `src/session-form.yaml`, `src/session-store.ts`
- `src/api-server.ts`
- `scripts/launch-claude.sh`, `scripts/launch-claude-remote.sh`

---

*End of research v0.1 — increment this doc or add a summary when direction is confirmed for PRD.*
