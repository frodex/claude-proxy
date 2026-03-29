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

**Next major refactor:** TUI widget system — extract 14+ duplicated arrow-key/picker/input handlers into a shared widget layer (ListPicker, TextInput, CheckboxPicker, ComboInput) with transport-agnostic rendering. This is prerequisite for web interface, svg-terminal unification, and OAuth flows.

**Future:** svg-terminal integration, Docker packaging with Vault, web onboarding, Cloudflare Access auth, user registration/invite system.

---

## Operational Conventions

[2026-03-29] Greg cares about internals and architecture quality, not just features. Do not ship duplicated patterns — unify first.
[2026-03-29] Always present a plan before writing code. Do not start implementation without approval.
[2026-03-29] Remote sessions use setup-remote.sh for initial setup. The remote launcher (launch-claude-remote.sh) handles install/update prompts at session creation time.
[2026-03-29] Use the new self-updating claude installer (curl -sL https://claude.ai/install.sh | bash), not npm install -g.

---

## Key Technical Decisions

[2026-03-28] tmux wraps Claude (not node-pty directly) — sessions survive proxy restarts
[2026-03-28] ESM modules throughout — all imports use `import`, not `require()`
[2026-03-28] @xterm/headless for screen buffer — write() is async, flush before reading
[2026-03-28] Ctrl+B prefix for hotkeys (tmux remapped to Ctrl+Q to avoid conflict)
[2026-03-28] Title bar via OSC escape for status (not a scroll-region status bar)
[2026-03-29] Working directory specified at session creation — mkdir -p + cd prefix in tmux launch
[2026-03-29] Remote sessions persist remoteHost in metadata — enables reconnect on proxy restart
[2026-03-29] Remote launcher runs as root for interactive prompts, su only at final claude exec
[2026-03-29] DirScanner scans for git repos + tracks MRU history for workdir picker

---

## Pending Items

[2026-03-29] TUI widget system refactor — extract duplicated picker/input/nav patterns
[2026-03-28] svg-terminal integration (Phase B/C — client adaptation, merge, QC)
[2026-03-28] Docker packaging with Vault companion
[2026-03-28] Web onboarding wizard
[2026-03-28] Cloudflare Access auth for web UI
[2026-03-28] User registration + invite system

---

## Session History (most recent first)

### 2026-03-29 — Working directory + remote fixes
- Added workdir feature: picker + freehand + tab-completion for session creation
- Added remote session reconnect on proxy restart (persist remoteHost, scan remotes)
- Added remote launcher with install/update prompts (launch-claude-remote.sh)
- Fixed step ordering: workdir after server selection for admins
- Fixed lobby to show remote host in cyan (@ct100)
- Discovered 14+ duplicated arrow-key/picker handlers — widget system refactor needed
- CT-100 claude install was corrupt (failed npm auto-update) — reinstalled via curl
- Artifacts: design spec, implementation plan, 12+ commits on dev
