# Add terminal & unified launch profiles — Research (stepped v05)

**Date:** 2026-04-03  
**Status:** In Progress — research for PRD amendment & implementation plan  
**Preceding:** `add-terminal.v04.md`  
**Changes from v04:** Merged missed `add-terminal.v02-NOTES-01a.md` — concrete profile names (terminal / Claude / Cursor), Cursor runs `cursor-agent`, session-ID discovery for Cursor is a **sub-project**  

---

## 0. Stepped document workflow (this thread)

| Artifact | Role |
|----------|------|
| `add-terminal.md` | Baseline capture — **immutable** after publish |
| `add-terminal.v01.md`, `.v02.md`, … | Assistant’s stepped versions; **only** these receive new discovery edits via `cp` then mutate |
| `add-terminal.vNN-NOTES-01.md` | Greg’s annotated copy of the latest stepped file; assistant **diffs** NOTES against `vNN`, merges, then writes **`vNN+1`** |
| Approval | Explicit sign-off on the latest stepped doc **before** PRD amendment + implementation planning |

Progression: `diff -u docs/research/add-terminal.v04.md docs/research/add-terminal.v05.md`

**Unified project:** `docs/integration/UNIFIED-PROJECT.md` — client index: `/srv/svg-terminal/docs/integration/2026-04-02-claude-proxy-partial-screen-fix.v01.md`.

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
- **Related routes today:** `GET/POST /api/sessions`, `GET /api/sessions/dead`, `DELETE /api/sessions/:id`, `GET/PATCH .../settings`, `POST .../restart`, `POST .../fork`, `GET /api/remotes`, `/users`, `/groups`, `/directories`, stream/screen — **partial** parity with SSH flows, but **not** driven from one shared request schema module.

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

**Concrete lobby options (v1 profiles):**

| Lobby label | `profileId` | Binary / command | Notes |
|-------------|-------------|------------------|-------|
| New terminal | `shell` | `/bin/bash -l` (or configurable) | Baseline — pure PTY, no agent tooling |
| New Claude session | `claude` | `claude` via `launch-claude.sh` | Today's default; session-ID backfill, fork, resume |
| New Cursor session | `cursor` | `cursor-agent` in target directory | Session-ID discovery needs same tooling as Claude — **sub-project** (see §5) |

- **One** `startSessionCreationFlow(client, profileId)` for SSH; optional `profileId` + full field map for API.
- **One** finalize path: `finalizeSessionFromResults(client, results, { profileId, … })` resolving **`command` + `args`** from the **profile** + form results — no per-tool `finalizeClaude` / `finalizeShell` copies.
- **API and “prompts”:** The API should accept **all structured inputs** an interactive session would collect (same schema as the form / profile), so automation never *needs* a human for those fields. If the product later allows **raw terminal input injection** (keystrokes into the PTY), treat that as **high privilege** — **allowlist, rate limits, auditable, off by default**, and distinct from “structured POST body matches form fields.”

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

### 3.4 Orchestration vs API contract (documented goal)

**Two layers:**

| Layer | Meaning | SSH / ANSI | Web |
|-------|---------|------------|-----|
| **Orchestration** | How the client **collects** inputs over time | In-process stepped menus, `FlowEngine`, lobby — **linear UI state** inside `index.ts` | **Async**: multiple requests, tabs, WebSocket, caches; any order that makes sense for UX |
| **API contract** | What the server accepts per **operation** | *Not* “must complete menu step 1 before step 5” — the **server** exposes **stateless** operations | Same **HTTP** (or WS control) endpoints |

**Rules:**

1. **Interactive discovery** (e.g. list dead sessions, read settings, resolve session id for edit) maps to **read** endpoints — SSH embeds those steps in flows; the web app calls them when it needs data.
2. **Mutations** (create, fork, restart, PATCH settings) each validate **their own** payload. If inputs are valid and domain rules pass (session exists, user allowed, profile supports fork), the server executes — **no** requirement that the web client replay ANSI step order.
3. **Do not** model the public API as a **sessionful wizard** on the server (e.g. “cookie: you are on wizard step 3”) unless there is an exceptional requirement. Prefer **explicit ids and bodies** so web clients stay async and can “jump” to any allowed operation.
4. **Shared truth:** The **canonical request/response shapes** (TypeScript types, ideally **OpenAPI / JSON Schema**) are the **template** for both clients. ANSI does **not** call HTTP internally today; the target is **one shared validation + execution module** invoked from `index.ts` (flow submit) and `api-server.ts` (JSON body) — *not* necessarily loopback HTTP.

---

## 4. Implementation surface (what to adjust vs rewrite)

### 4.1 Likely **add/extend** (not delete wholesale)

- **`src/launch-profiles.ts`** (or similar): registry + types + **per-profile capabilities**.
- **`src/session-requests.ts`** (or similar) — **new:** `CreateSessionRequest`, `validateCreateSession`, `executeCreateSession` (names TBD) used by **both** `finalizeSessionFromResults` and `POST /api/sessions`.
- **`lobby.ts`** — Two-step: “New…” → profile picker → existing flow.
- **`index.ts`** — Flow completion calls shared executor; no duplicate field → `createSession` mapping.
- **`session-form.yaml` / `session-form.ts`** — Profile/capability-driven fields; align field names with **request DTO** keys.
- **`session-store.ts`** — `launchProfile`, `command`, `commandArgs`, tool session ids as needed.
- **`api-server.ts`** — Parse JSON → validate → same executor; extend bodies for `launchProfile`.
- **`session-manager.ts`** — Session-ID backfill gated by profile.

### 4.2 **Rewrite / abstract** (larger)

- **`pty-multiplexer.ts`** — **Remote:** profile-aware launchers, not only `launch-claude-remote.sh`.

### 4.3 **Fork / resume** (policy)

- **Fork:** Claude today; Cursor TBD; others: hide/disable via **profile capability** in config.
- **Resume:** Tool-specific args; **restart** reads persisted **launch profile + ids** from metadata.

### 4.4 Tests

- Profile capability tests; API **one-shot** create matches flow output.
- Contract tests: same invalid payload rejected whether sent from test harness simulating “API” or “flow submit.”

---

## 5. Risks & open questions

- **Cursor session-ID discovery (sub-project):** `cursor-agent` does not currently expose a session ID the way Claude does (`~/.claude/sessions/<pid>.json`). To get resume/fork parity for the `cursor` profile, we need to research how Cursor stores session state, then build a **`discoverCursorSessionId`** equivalent. Until that sub-project is done, `cursor` profile works for **new sessions only** (no resume/fork). Scope and track separately.
- **Cursor CLI** on remote: profile-specific launcher — may need its own installer.
- **Security:** Structured fields vs raw PTY injection — PRD draws the line.
- **Interchangeability:** On-disk config contract Claude vs Cursor — follow-on spec.
- **PRD:** Must include **§ orchestration vs API** so implementers do not reintroduce server-side wizard state.

---

## 6. Next steps (before code)

1. Amend **PRD** (`docs/integration/…`) — launch profiles, lobby, **stateless API**, **orchestration vs contract** subsection, OpenAPI/JSON Schema pointer, security boundary.
2. **Implementation plan** (approval required).
3. Slices: shared request module + validation → profiles → ANSI + API callers → persistence → remote.

---

## 7. References (files touched in audit)

- `src/lobby.ts`, `src/index.ts`, `src/session-manager.ts`, `src/pty-multiplexer.ts`
- `src/session-form.ts`, `src/session-form.yaml`, `src/session-store.ts`
- `src/api-server.ts`
- `scripts/launch-claude.sh`, `scripts/launch-claude-remote.sh`
- PRD amend target (example): `docs/integration/PRD-claude-proxy-as-built-v2.1.md` *or* successor doc per release process

---

## 8. Gap analysis: current codebase vs §3.4 goal

| Goal | Current state | Adjustment |
|------------|---------------|------------|
| **Single canonical schema** for create/edit/restart/fork bodies | Form fields in **YAML**; API hand-parses **ad-hoc** `body.name`, `body.password`, etc. in `api-server.ts` | Introduce shared **DTOs + validators**; map YAML field ids to DTO keys once |
| **One executor** for “create session” from flow + API | **`finalizeSessionFromResults`** in `index.ts` vs **`POST /api/sessions`** — **parallel** logic, both call `createSession` differently | Extract **`executeCreateSession(req, clientCtx)`**; flow and route both call it |
| **ANSI as template for web API** | **No** formal OpenAPI/JSON Schema; web is **placeholder** | Publish **OpenAPI** (or schema files) from same types; web UI generated or hand-built against it |
| **Jump to any operation** with valid body | API routes already **mostly** stateless (`POST .../fork`, `PATCH .../settings`); **create** is incomplete vs future `launchProfile` | Extend **`POST /api/sessions`**; ensure **no** new endpoints require prior “wizard cookie” |
| **SSH stepped flows discover data like API reads** | Flows call **`sessionManager` / `session-store` / `listDeadSessions`** directly — **good**; not HTTP | Keep in-process; optionally refactor so “discovery” helpers match **GET** route behavior **one implementation** |
| **Web async** | No real web session management UI | Build against published contract; WS stream already separate from CRUD |
| **Launch profiles / persisted flavor** | **Missing** — Claude hard-coded in API + finalize | Profiles + **`StoredSession`** extension (see §4) |

**Summary:** The **biggest** gap is **not** “web must walk ANSI steps” — it is **duplicated business logic and absent shared types** between `index.ts` flows and `api-server.ts`. Closing that gap realizes §3.4; launch-profile work should land **on top of** (or together with) the shared request module so we do not triplicate validation.

---

*Stepped v05 — next: `cp` → `add-terminal.v06.md` after NOTES or approval revision; merge into PRD when direction is approved.*
