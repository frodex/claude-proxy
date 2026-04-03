# sessions.md — Live Project Context
# Backed up as sessions.md.{SESSION}-{STEP} before each optimize

---

## Project Identity

**Repo:** claude-proxy @ /srv/claude-proxy
**Branch:** dev
**What this is:** SSH multiplexer for shared Claude Code terminal sessions. Multiple users connect via SSH, share live Claude sessions, and collaborate in real-time. Includes a web API (HTTP+WS on port 3101) for browser clients. tmux-backed persistent sessions survive disconnects and proxy restarts.

---

## Active Direction

Phase 1 (SSH multiplexer) and Phase 2 (Web API) are complete. Working directory feature added (pick dir when creating sessions). Remote session reconnect on restart added. Remote launcher with install/update prompts added.

**Next major refactor (APPROVED):** TUI widget system — widgets (state machines) + flow engine (step chaining) + renderers (ANSI/JSON/spans). Widgets produce structured state, renderers convert per transport. Browser JS renders HTML from JSON over WebSocket. SSH gets server-side ANSI rendering. svg-terminal benefits from semantic UI data (knows "list picker with cursor on item 3" not just terminal text). Single spec covering all three layers.

**In progress (research → PRD amendment → plan):** Unified **launch profiles** for session creation — one internal terminal/session pipeline; lobby options such as “New Claude session”, “New Cursor session”, “New terminal” (and future tools) layer **profile** (command, args, form gates, backfill, remote strategy) over the same flow. **Baseline (frozen):** `docs/research/add-terminal.md`. **Active stepped copy:** `docs/research/add-terminal.v03.md` — **§3.4** orchestration (ANSI stepped / web async) vs **stateless API**; **§8** gap analysis. New discoveries: `cp` latest stepped → `add-terminal.v04.md`, edit only the new file; see Operational Conventions. Feature work must not multiply parallel `finalize*` / `startNewSession*` code paths; extend a single path via profile registry.

**Future:** svg-terminal integration, Docker packaging with Vault, web onboarding, Cloudflare Access auth, user registration/invite system.

---

## Operational Conventions

[2026-03-29] Greg cares about internals and architecture quality, not just features. Do not ship duplicated patterns — unify first.
[2026-03-29] Always present a plan before writing code. Do not start implementation without approval.
[2026-03-29] Remote sessions use setup-remote.sh for initial setup. The remote launcher (launch-claude-remote.sh) handles install/update prompts at session creation time.
[2026-03-29] Use the new self-updating claude installer (curl -sL https://claude.ai/install.sh | bash), not npm install -g.

[2026-04-03] **Stepped research / spec documents (process):** When new discoveries land, **do not edit prior versions in place.** Preserve history and reasoning with `cp`: e.g. `cp add-terminal.md add-terminal.v01.md`, then **only** mutate the new stepped file. Later rounds: `cp add-terminal.v01.md add-terminal.v02.md`, edit v02. Use **`diff`** between steps to show progression. **Greg’s responses:** copy the latest stepped file and append **` -NOTES-01.md`** (e.g. `add-terminal.v01-NOTES-01.md`); the assistant diffs NOTES vs stepped, merges, then produces the **next** stepped version. **Do not advance** to the next planning or implementation phase until the current stepped doc is explicitly **approved**.

---

## Key Technical Decisions

[2026-04-03] Session creation should converge on **one code path** parameterized by **launch profile** (command/args, form visibility, Claude-ID backfill, remote launcher), not separate flows per tool — aligns with “no duplicated patterns” convention
[2026-04-03] **Orchestration ≠ API contract:** SSH uses stepped in-process flows; web is async. HTTP operations must remain **stateless** (validate body per request; no server wizard session). Shared **DTO + validator + executor** called from flow submit and `api-server.ts` — see `docs/research/add-terminal.v03.md` §3.4, §8
[2026-03-28] tmux wraps Claude (not node-pty directly) — sessions survive proxy restarts
[2026-03-28] ESM modules throughout — all imports use `import`, not `require()`
[2026-03-28] @xterm/headless for screen buffer — write() is async, flush before reading
[2026-03-28] Ctrl+B prefix for hotkeys (tmux remapped to Ctrl+Q to avoid conflict)
[2026-03-28] Title bar via OSC escape for status (not a scroll-region status bar)
[2026-03-29] Working directory specified at session creation — mkdir -p + cd prefix in tmux launch
[2026-03-29] Remote sessions persist remoteHost in metadata — enables reconnect on proxy restart
[2026-03-29] Remote launcher runs as root for interactive prompts, su only at final claude exec
[2026-03-29] DirScanner scans for git repos + tracks MRU history for workdir picker
[2026-03-29] Security model: OAuth → Linux user → Unix permissions are the security boundary, not proxy ACLs
[2026-03-29] tmux sessions use -S custom sockets with UGO permissions for access control
[2026-03-29] inotify on /etc/group for reactive enforcement when group membership changes externally
[2026-03-29] Proxy ACLs (hidden, public, allowedUsers) become UI hints that map to Unix groups
[2026-04-01] Unified session screen: two-mode form interaction — yellow=field navigation (arrows move between fields), white=widget edit (Enter activates, arrows go to widget, Enter/Escape exits). Color shift signals mode.
[2026-04-01] runas field locked on edit/restart/fork — can't change running process UID. Unlocking requires session export/migration to other user's home dir (future feature).
[2026-04-01] Session form field config is YAML-driven — locked/visible/prefill per field per mode comes from config, not hardcoded. Widget creation and onResult stay in code.
[2026-04-01] FlowStep gets displayValue callback (not _display_ keys) — each step defines how to render its completed value.
[2026-04-01] workdir locked on edit/restart/fork — can't change working directory of existing session.
[2026-04-01] Claude PID discovery must split cmd on space — `ps` reports `claude --resume` not bare `claude`. Always check `cmd.split(' ')[0]`.
[2026-04-01] Locked fields in forms must not enter edit mode — Enter is ignored, user arrows past them.
[2026-04-01] FlowEngine auto-advances cursor to next field after confirming (Enter in edit mode).
[2026-04-01] Fork/edit always discover Claude session ID live from running process, not from stale metadata cache.
[2026-04-01] Prefill values must be merged into FlowEngine initialState — otherwise displayValue reads empty accumulated state.

---

## Pending Items

[2026-04-03] Add terminal / launch profiles — approve stepped research (`docs/research/add-terminal.v03.md`), amend PRD (**orchestration vs API** + gaps), then implement (shared session-request module + profiles + lobby + API + persistence + remote)
[2026-03-29] TUI widget system refactor — extract duplicated picker/input/nav patterns
[2026-03-30] Configure OAuth providers (Google, Microsoft, GitHub) with real client IDs
[2026-03-30] Wire OAuth/provisioner into index.ts startApiServer call
[2026-03-30] Local auth provider (Keycloak or similar) for self-hosted orgs
[2026-03-28] svg-terminal integration (Phase B/C — client adaptation, merge, QC)
[2026-03-28] Docker packaging with Vault companion (migrate SQLite → Vault Transit)
[2026-03-28] Web onboarding wizard
[2026-03-28] User registration + invite system

---

## Session History (most recent first)

### 2026-04-03 — Add terminal / launch profiles (research)
- Goal: menu options for Claude vs Cursor vs plain terminal (and extensibility) without forking creation logic
- Artifacts: `add-terminal.v03.md` adds **§3.4** orchestration vs stateless API, **§8** gap table (shared DTO/executor missing today)
- Next: approve v03 → PRD amend → plan → code

### 2026-04-01 — Unified Session Screen Implementation (15 tasks, 5 phases)
- Phase 1: Widget field states (6 states + ANSI colors) + locked option on all widgets
- Phase 2: FlowEngine two-mode navigation (navigate/edit), displayValue callback, validation + submit gate, full-form renderer
- Phase 3: YAML-driven session form config (12 fields × 4 modes), predicate registry, widget factory, buildSessionFormSteps
- Phase 4: Wired into app — creation, edit (Ctrl+B e), fork (Ctrl+B f), restart, fork-from-lobby all use unified SessionForm
- Phase 5: API endpoints — session CRUD, restart/fork, supporting (remotes, users, groups)
- Pre-implementation: questions to authoring agent, concerns doc, decision journal, YAML impact report
- Key decisions: two-mode color signaling (yellow/white), runas/server/workdir locked on edit, YAML config for field metadata
- 238 tests passing, 31 test files, clean build
- PR: frodex/claude-proxy#1
- Artifacts: v2 plan, decision journal, concerns doc, YAML impact report

### 2026-03-30 — Auth + UGO Security Implementation (Plans A, B, C)
- Plan A complete: UserStore (SQLite), LinuxProvisioner, resolveUser — 34 tests
- Plan B complete: SocketManager (tmux -S sockets), GroupWatcher (inotify), PtyMultiplexer + SessionManager integration — 13 tests
- Plan C complete: session cookies, auth middleware, OAuthManager (Google/Microsoft OIDC), GitHub adapter, auth routes in API server — 10 tests
- 124 total tests, 21 test files, clean build
- OAuth providers not yet configured with real credentials (pending items)
- Artifacts: 3 implementation plans, security spec, research journal, bibliography updates

### 2026-03-29 — Working directory + remote fixes + widget system design
- Widget system architecture approved: widgets + flow engine + renderers
- Key insight: svg-terminal doesn't *need* widgets (ANSI pipeline works), but benefits from semantic UI data for native rendering
- Journal v0.2 written with direction confirmed
- Research journal v0.1: 22 UI element inventory, framework survey (Bubbletea, Ink, Textual, Blessed, Ratatui)
- Bibliography started with framework references

#### Earlier in session
- Added workdir feature: picker + freehand + tab-completion for session creation
- Added remote session reconnect on proxy restart (persist remoteHost, scan remotes)
- Added remote launcher with install/update prompts (launch-claude-remote.sh)
- Fixed step ordering: workdir after server selection for admins
- Fixed lobby to show remote host in cyan (@ct100)
- Discovered 14+ duplicated arrow-key/picker handlers — widget system refactor needed
- CT-100 claude install was corrupt (failed npm auto-update) — reinstalled via curl
- Artifacts: design spec, implementation plan, 12+ commits on dev
