# claude-proxy — Agent Resume Info

## Session
- **Session ID:** 35f38ccc-1788-4481-a303-2fd58534e09e
- **JSONL Path:** `/root/.claude/projects/-root/35f38ccc-1788-4481-a303-2fd58534e09e.jsonl`
- **Resume command:** `claude --resume 35f38ccc-1788-4481-a303-2fd58534e09e`
- **Working directory:** `/root`
- **Branch:** `dev`
- **Date range:** 2026-03-26 to 2026-03-28

## What Was Built

### Phase 1: SSH Terminal Multiplexer (Day 1-2)
- SSH server (ssh2) on port 3100 with public key auth
- Interactive lobby with arrow-key navigation, session list
- tmux-backed persistent sessions — survive SSH disconnects and proxy restarts
- Multi-user: multiple SSH clients share the same Claude session
- Hotkey system (Ctrl+B prefix): help, detach, size claim, redraw, scrollback
- Title bar status: session name, connected users, typing indicators, uptime
- Per-session access control: hidden, view-only, password, allowed users/groups, admins
- System-wide admin group (cp-admins)
- Session restart from dead sessions with original settings
- Claude --resume integration (deep scan via Claude's own picker)
- Session export (zip with install script)
- Remote host sessions (SSH to configured servers like ct100)
- Remote host setup script (scripts/setup-remote.sh)
- Run-as-user for admins, --dangerously-skip-permissions flag
- Interactive session settings editor (Ctrl+B e) with checkbox pickers
- systemd service with graceful shutdown (detach, don't kill tmux)

### Phase 2: Web API for Browser Clients (Day 2-3)
- HTTP + WebSocket API server on port 3101 (api-server.ts)
- GET /api/sessions — session list with composed titles
- WS /api/session/:id/stream — bidirectional terminal streaming
- screen-renderer.ts — xterm cell-to-spans conversion with 256-color palette
- PtyMultiplexer event hooks: onScreenChange, onCursorChange, onTitleChange
- 30ms batched delta pushes via onRender events
- Structured input translation (browser keystrokes → PTY escape codes)
- Scroll via absolute offset reading xterm buffer ranges

### Integration with svg-terminal
- 9 FOLLOW-UP/RESPONSE documents exchanged via filesystem
- Architecture agreed: claude-proxy v2.0 = SSH + Web API + 3D dashboard
- Protocol finalized: screen/delta/input/scroll/resize message types
- Span format: hex RGB, grouped by attribute
- Leadership: svg-terminal side leads integration
- Steward questionnaire completed (honest self-assessment)

### Design Docs
- PRD-claude-proxy-as-built.md — what exists today
- PRD-svg-terminal-as-built.md — other project (reviewed and corrected)
- PRD-unified-v2.md — the combined v2.0 product
- Docker distribution design spec — Vault, containers, onboarding
- User registration design spec — Cloudflare Access, invite codes, admin panel
- Docker packaging journal

## Key Technical Decisions
- tmux wraps Claude (not node-pty directly) — sessions survive proxy restarts
- No alternate screen — native terminal scrollback works
- Title bar via OSC escape for status (not a scroll-region status bar)
- Ctrl+B prefix (tmux remapped to Ctrl+Q to avoid conflict)
- ESM modules — all imports must use `import`, not `require()` (bit us 3 times)
- Temp scripts for tmux launch commands (avoids nested quote escaping)
- @xterm/headless for screen buffer — write() is async, flush before reading
- Session metadata on persistent disk (/srv/claude-proxy/data/sessions/)

## Files Changed
- 20+ source files in src/
- 10 test files in tests/
- 10+ integration docs
- 4 design specs
- README.md, LICENSE, tmux.conf, systemd service, setup scripts

## What's Next
- svg-terminal integration (Phase B/C — client adaptation, merge, QC)
- Docker packaging with Vault companion
- Web onboarding wizard
- Cloudflare Access auth for web UI
- User registration + invite system
