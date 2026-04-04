# sessions.md — Live Project Context
# Backed up as sessions.md.2026-04-03 before optimize

---

## Project Identity

**Repo:** claude-proxy @ /srv/claude-proxy
**Branch:** dev
**What this is:** SSH multiplexer for shared Claude Code terminal sessions. Multiple users connect via SSH, share live Claude sessions, and collaborate in real-time. **HTTP/WebSocket API** on `127.0.0.1:3101` serves browsers/OAuth; **Unix socket** `/run/claude-proxy/api.sock` serves local JSON-RPC (svg-terminal integration). tmux-backed persistent sessions survive disconnects and proxy restarts.

---

## Active Direction

**Unified project (2026-04-03):** **Start here:** `docs/integration/UNIFIED-PROJECT.md` — dashboard, doc map, checklist. Workspace: **`unified.code-workspace`** (repo root) opens claude-proxy + svg-terminal. **claude-proxy is the platform** (runs standalone); svg-terminal is a client (depends on CP for `cp-*` integration).

**Architecture refactor:**
1. **Phase A** — **DONE.** Operations module, auth wiring, security hardening. Plan: `docs/superpowers/plans/2026-04-03-phase-a-operations-auth.md`
2. **Phase C** — **DONE** on this stack: Unix socket JSON-RPC + svg-terminal socket client; host runs **`svg-terminal.service`** (systemd) after **`claude-proxy.service`**. Plan: `docs/superpowers/plans/2026-04-03-phase-c-unix-socket.md`. **PRD:** `/srv/svg-terminal/docs/PRD-amendment-006.md`. **Journal:** `docs/research/2026-04-03-v0.1-phase-c-socket-systemd-journal.md`
3. **Launch profiles** (independent, parallel) — lobby offers terminal/Claude/Cursor; one internal flow. Plan: `docs/superpowers/plans/2026-04-03-launch-profiles.md` (8 tasks)

**Master roadmap (W1–W8):** `/srv/svg-terminal/ui-web/ROADMAP.md` — phases through full web UI, user management, remote profiles, Cursor session-ID, Phase D merge.

**Research (stepped, approved through v05/v03):**
- Launch profiles: `docs/research/add-terminal.v05.md`
- Unix socket + layered OAuth + security: `docs/research/2026-04-03-v0.2-unix-socket-transport-journal.v03.md`

---

## Operational Conventions

[2026-03-29] Greg cares about internals and architecture quality, not just features. Do not ship duplicated patterns — unify first.
[2026-03-29] Always present a plan before writing code. Do not start implementation without approval.
[2026-03-29] Remote sessions use setup-remote.sh for initial setup. The remote launcher (launch-claude-remote.sh) handles install/update prompts at session creation time.
[2026-03-29] Use the new self-updating claude installer (curl -sL https://claude.ai/install.sh | bash), not npm install -g.
[2026-04-03] **Stepped research / spec documents:** Do not edit prior versions in place. `cp` → new stepped file, edit only the new one. Greg's responses: `vNN-NOTES-01.md`; assistant diffs, merges into `vNN+1`. Do not advance to planning/implementation until approved.
[2026-04-03] **First principles over shortcuts.** If the design would be different starting from scratch, do it the right way. Don't wrap HTTP semantics over a Unix socket when JSON messages are the natural protocol. Don't optimize for speed at the expense of architecture.
[2026-04-03] **Security findings in-path:** When modifying a file for a feature, fix security audit findings in that file at the same time. `execSync` → `execFileSync` with array args. Validate all interpolated inputs. See `/root/security-audit-findings.csv` and research v03 §12.

---

## Key Technical Decisions

[2026-04-03] **Operations module:** All API business logic extracted from HTTP route handlers into `src/operations.ts` — typed methods, transport-agnostic. HTTP adapter and Unix socket adapter both call it. This IS the "shared executor" from add-terminal research §3.4.
[2026-04-03] **Unix socket as primary internal transport:** claude-proxy ↔ svg-terminal communicate via JSON-RPC over `/run/claude-proxy/api.sock` (not HTTP-over-socket). HTTP adapter stays for browsers, OAuth redirects, dev/debug. TCP port is optional.
[2026-04-03] **Layered OAuth:** claude-proxy owns all auth logic (standalone path). svg-terminal hooks in via internal `authStart`/`authExchange` operations over socket. Zero OAuth deps in svg-terminal.
[2026-04-03] **Launch profiles:** `shell`/`claude`/`cursor` — each a registry entry with command, capabilities (fork, resume, sessionIdBackfill, dangerMode, remoteSupport), form field gating. Cursor session-ID discovery is a sub-project.
[2026-04-03] Session creation converges on one code path parameterized by launch profile, not separate flows per tool.
[2026-04-03] Orchestration ≠ API contract: SSH uses stepped flows; web is async. Server operations are stateless — no wizard sessions.
[2026-03-28] tmux wraps Claude (not node-pty directly) — sessions survive proxy restarts
[2026-03-28] ESM modules throughout — all imports use `import`, not `require()`
[2026-03-28] @xterm/headless for screen buffer — write() is async, flush before reading
[2026-03-28] Ctrl+B prefix for hotkeys (tmux remapped to Ctrl+Q to avoid conflict)
[2026-03-29] Security model: OAuth → Linux user → Unix permissions are the security boundary, not proxy ACLs
[2026-03-29] tmux sessions use -S custom sockets with UGO permissions for access control
[2026-04-01] Session form field config is YAML-driven — locked/visible/prefill per field per mode from config, not hardcoded
[2026-04-01] FlowEngine two-mode navigation (navigate/edit), displayValue callback, auto-advance after confirm
[2026-04-01] Fork/edit always discover Claude session ID live from running process, not stale metadata

---

## Pending Items

[2026-04-03] ~~Execute Phase A~~ — **DONE.** Operations module, auth wired, security hardening, 293 tests passing, restart verified
[2026-04-03] ~~Execute Phase C~~ — **DONE.** Socket server, svg-terminal client, `api.socket` in YAML, live restart + `svg-terminal.service` on host. PRD-006 + journal above.
[2026-04-03] **Execute launch profiles** — independent, can run parallel with Phase A (plan written)
[2026-04-03] **Security remediation pass** — ~95 out-of-scope findings (pty-multiplexer, scripts, systemd, svg-terminal) tracked in research v03 §13
[2026-04-03] **Phase D (OAuth hardening + login UX)** — Plan: `docs/superpowers/plans/2026-04-04-phase-d-oauth-browser-hardening.md` (PKCE, CSRF, AES cookie, `web/login`, svg-terminal redirects). **Gate:** verify `docs/superpowers/specs/2026-04-03-oauth-web-api-wiring-spec.md` (W1) first.
[2026-04-03] Phase W2+: live web UI via svg-terminal dashboard (plan not yet written, depends on Phase A+C)
[2026-03-30] Configure OAuth providers with real client IDs
[2026-03-28] Docker packaging with Vault companion
[2026-03-28] User registration + invite system

---

## Session History (most recent first)

### 2026-04-03 — Phase C shipped + svg-terminal systemd + docs
- Unix socket API (`socket-protocol.ts`, `socket-server.ts`), shared `ProxyOperations`, resize/scroll on socket; `claude-proxy.yaml` enables `api.socket` + TCP 3101
- svg-terminal: `server.mjs` uses `CLAUDE_PROXY_SOCKET`; `/etc/systemd/system/svg-terminal.service` — `After=claude-proxy.service`, `PORT=3200`, enabled on boot
- Docs: PRD-amendment-006 (svg-terminal), research journal (this repo), `UNIFIED-PROJECT.md` map row; this `sessions.md` updated

### 2026-04-03 — Architecture research + planning + Phase A execution
- **Phase A completed** (by separate agent): operations.ts extracted from api-server.ts, auth modules hardened + wired, execSync sweep, scrypt passwords, prototype pollution guard. 293 tests, 34 files. Restart verified — sessions rediscovered, API returns correct JSON.

### 2026-04-03 — Architecture research + implementation planning (earlier in session)
- **Launch profiles research:** Stepped through v01–v05 with NOTES round-trips. Concrete profiles (shell/claude/cursor), Cursor session-ID as sub-project, form field gating by capability, two-step lobby, orchestration vs stateless API contract, gap analysis
- **OAuth wiring spec:** Full spec for wiring dormant auth modules into `startApiServer` — ACL parity with SSH, protected routes, WS auth, `api.auth.required` flag
- **Unix socket research:** Stepped through v01–v03. First-principles design: operations module (not HTTP-over-socket), JSON-RPC protocol, layered OAuth (CP standalone → svg-terminal hooks). Security audit (189 findings) folded: ~55 in-path mapped to refactor tasks, ~95 out-of-scope cataloged
- **Unified project:** UNIFIED-PROJECT.md dashboard in claude-proxy (platform-first), multi-root workspace file, svg-terminal redirects to it. Web UI master ROADMAP (W1–W8) in svg-terminal `ui-web/`
- **Plans written:** Phase A (7 tasks), Phase C (6 tasks), Launch profiles (8 tasks)
- **Process established:** Stepped doc convention, NOTES round-trips, approval gates
- Artifacts: 5 research docs (stepped), 3 implementation plans, 1 OAuth spec, 1 ROADMAP, UNIFIED-PROJECT dashboard, workspace file

### 2026-04-01 — Unified Session Screen Implementation (15 tasks, 5 phases)
- Widget system, FlowEngine, YAML-driven session form, wired into app
- 238 tests, PR: frodex/claude-proxy#1

### 2026-03-30 — Auth + UGO Security Implementation (Plans A, B, C)
- UserStore, LinuxProvisioner, resolveUser, SocketManager, GroupWatcher, OAuth, session cookies
- 124 tests — code built but NOT wired into startApiServer (Phase A fixes this)

### 2026-03-29 — Working directory + remote fixes + widget system design
- Workdir feature, remote reconnect, remote launcher, widget system spec approved
