# claude-proxy — Product Requirements Document (As-Built)
**Version:** 1.0
**Date:** 2026-03-28
**Status:** Implemented

---

## What It Is

An SSH multiplexer server that lets multiple users share live Claude Code terminal sessions. Users connect via SSH, land in an interactive lobby, and create or join shared sessions backed by tmux.

## Problem It Solves

- SSH disconnections kill Claude sessions → tmux-backed sessions survive disconnects and proxy restarts
- No way to share a Claude session with collaborators → multiple users join the same session
- No session management → lobby with create, join, restart, export
- No access control → per-session: hidden, password, view-only, allowed users/groups, admins

## Core Architecture

```
SSH Client → ssh2 Server (port 3100) → Lobby UI → tmux session (claude)
                                           ↕
SSH Client → ssh2 Server → Join existing session
```

- **Transport:** ssh2 npm package implementing custom SSH server with pubkey auth
- **Session backend:** tmux — each Claude session is a detached tmux session
- **PTY bridge:** node-pty spawns `tmux attach` and multiplexes output to all connected SSH clients
- **Terminal emulation:** @xterm/headless maintains a virtual screen buffer for scrollback and screen state
- **Persistence:** tmux sessions survive proxy restarts; metadata stored on disk

## Features (Implemented)

### Session Management
- Interactive lobby with arrow-key navigation
- Create new sessions (name, access settings, remote host)
- Join existing sessions by number or arrow+enter
- Restart dead sessions with original settings preserved
- Deep scan — launch Claude's own `--resume` picker
- Export sessions — zip with install script for portability

### Access Control
- Per-session: hidden, view-only, password-protected
- Allowed users list (checkbox picker from known Claude users)
- Allowed groups (cp-* prefixed system groups)
- Per-session admins who can edit settings
- System-wide admins (cp-admins group)
- Session settings editor (Ctrl+B e)

### Multi-User
- Multiple SSH clients in the same session see identical output
- Size ownership model — one user controls terminal dimensions
- Title bar shows session name, connected users, typing indicators, uptime
- Free-for-all input (view-only restricts to owner/admins)

### Hotkey System (Ctrl+B prefix)
- h: Interactive help menu
- d: Detach (back to lobby)
- s: Claim size ownership
- r: Redraw screen
- l: Scrollback dump (terminal native scrollbar)
- b: Scrollback viewer
- e: Edit session settings

### Session Persistence
- tmux-backed — sessions survive SSH disconnects
- Graceful proxy restart — detach from tmux, rediscover on startup
- Metadata on persistent disk (/srv/claude-proxy/data/sessions/)
- Session resume via Claude's --resume flag

### Admin Features
- Root can run sessions as any user
- Root can launch sessions on remote hosts (SSH to configured remotes)
- --dangerously-skip-permissions flag for admin sessions
- Remote host setup script (scripts/setup-remote.sh)

### Authentication
- SSH public key only — per-user authorized_keys lookup
- No passwords, no anonymous access
- Each user runs Claude with their own ~/.claude/ config and API keys

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22, TypeScript |
| SSH server | ssh2 |
| PTY | node-pty |
| Session backend | tmux |
| Terminal emulator | @xterm/headless |
| Config | YAML + env + CLI flags |
| Process manager | systemd |
| Tests | vitest |

## File Structure

```
claude-proxy/
├── src/
│   ├── index.ts              # main entry point
│   ├── types.ts              # shared interfaces
│   ├── config.ts             # config loader
│   ├── ssh-transport.ts      # SSH server
│   ├── session-manager.ts    # session lifecycle + access control
│   ├── pty-multiplexer.ts    # PTY + tmux + xterm buffer
│   ├── lobby.ts              # lobby UI
│   ├── hotkey.ts             # Ctrl+B handler
│   ├── status-bar.ts         # (deprecated — using title bar)
│   ├── scrollback-viewer.ts  # custom scrollback pager
│   ├── interactive-menu.ts   # reusable menu component
│   ├── ansi.ts               # ANSI escape helpers
│   ├── user-utils.ts         # user/group discovery
│   ├── session-store.ts      # metadata persistence
│   ├── export.ts             # session export/zip
│   └── transport.ts          # transport type re-export
├── scripts/
│   ├── launch-claude.sh      # claude launcher with auto-install
│   ├── generate-host-keys.sh # SSH host key generation
│   └── setup-remote.sh       # remote host setup
├── tests/                    # vitest test suite
├── tmux.conf                 # tmux config (prefix remapped to Ctrl+Q)
├── claude-proxy.yaml         # server config
├── systemd/                  # systemd unit file
└── docs/                     # specs, plans, research, integration
```

## Limitations

- No web UI — SSH only (Phase 3 planned)
- No user registration — manual user creation
- Terminal scrollback via dump only (alternate screen breaks native scroll)
- No session recording/playback
- Single server (remote sessions via SSH, no clustering)
