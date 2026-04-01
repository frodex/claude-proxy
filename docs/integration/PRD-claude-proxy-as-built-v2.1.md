# claude-proxy — Product Requirements Document (As-Built)
**Version:** 2.1
**Date:** 2026-03-31
**Previous version:** v2.0 (2026-03-31)
**Status:** Implemented
**Review:** Steward review at `docs/integration/steward-review-2026-03-31.md`

### Changes from v2.0 (steward review response)

- Added Constraints section (10 hard constraints with why/consequence)
- Added Anti-Patterns section (8 tried-and-abandoned approaches with reasons)
- Added Break Tests section (5 deliberate mutations)
- Added Provenance Tags (built-this-session vs inherited/unverified)
- Expanded Deprecations with why-it-failed context

### Changes from v1.0

- Widget system: 14 duplicated handlers replaced with 6 composable widget types + FlowEngine
- Auth infrastructure: OAuth (Google/Microsoft/GitHub), SQLite user store, session cookies, UGO socket security
- Working directory picker for session creation
- Remote session reconnect on proxy restart
- Remote launcher with install/update prompts
- Auto-discover Claude session IDs from running processes
- Fork session (Ctrl+B f)
- Scroll fix (tmux capture-pane for alternate screen)
- Multiple cancel keys (Esc, Ctrl+C, q)
- Arrow key dual-variant support (CSI + SS3)

---

## What It Is

An SSH multiplexer server that lets multiple users share live Claude Code terminal sessions. Users connect via SSH, land in an interactive lobby, and create or join shared sessions backed by tmux. Web API on port 3101 serves session data for browser clients (svg-terminal integration).

## Core Architecture

```
SSH Client → ssh2 Server (port 3100) → Lobby UI → tmux session (claude)
                                           ↕
SSH Client → ssh2 Server → Join existing session

Browser → HTTP+WS API (port 3101) → Session list, terminal stream, auth
```

## Features (Implemented)

### Session Management
- Interactive lobby with arrow-key navigation (wraps, both CSI+SS3 variants)
- Create new sessions with multi-step wizard (FlowEngine + composable widgets)
- Working directory picker (ComboInput — list + freehand + tab-completion)
- Join existing sessions by number or arrow+enter
- Restart dead sessions with original settings preserved
- Resume by Claude session ID (paste ID or use Claude's picker)
- Deep scan — launch Claude's own `--resume` picker
- Fork session (Ctrl+B f) — `claude --resume <id> --fork-session`
- Auto-discover Claude session IDs from `~/.claude/sessions/<pid>.json`
- Export sessions — zip with install script for portability

### Widget System
- `src/widgets/` — 6 composable widget types + FlowEngine + ANSI renderers
- parseKey: normalizes terminal bytes (both arrow variants handled once)
- ListPicker: arrow nav, wrap, disabled skip, select/cancel
- TextInput: type, backspace, submit, tab-completion, paste, masked mode
- YesNoPrompt: y/n/enter with configurable default
- CheckboxPicker: composes ListPicker + toggle + manual entry
- ComboInput: composes ListPicker + TextInput, picker/freehand modes
- FlowEngine: chains widgets into multi-step forms with conditions
- All widgets support Esc, Ctrl+C, and q (where safe) for cancel

### Access Control
- Per-session: hidden, view-only, password-protected
- Allowed users list (CheckboxPicker from known Claude users)
- Allowed groups (cp-* prefixed system groups)
- Per-session admins who can edit settings
- System-wide admins (cp-admins group)
- Session settings editor (Ctrl+B e)

### UGO Socket Security (infrastructure built, wiring in progress)
- tmux sessions use -S custom sockets with UGO permissions
- SocketManager creates sockets, sets ownership/mode, manages server-access ACLs
- GroupWatcher monitors /etc/group via inotify, revokes access reactively
- Proxy ACLs become UI hints, Unix permissions are the security boundary

### Auth (infrastructure built, not yet activated)
- OAuth: Google (OIDC), Microsoft (OIDC), GitHub (custom adapter)
- SQLite user store with provider links
- LinuxProvisioner: useradd, groupadd, installClaude
- resolveUser: SSH username or OAuth token → Linux user identity
- Session cookies (HMAC-SHA256 signed)
- Auth middleware for API endpoints
- Auth routes: /api/auth/providers, /login, /callback, /me, /logout

### Multi-User
- Multiple SSH clients in the same session see identical output
- Size ownership model — one user controls terminal dimensions
- Title bar shows session name, connected users, typing indicators, uptime
- View-only restricts input to owner/admins

### Hotkey System (Ctrl+B prefix)
- h: Interactive help menu
- d: Detach (back to lobby)
- s: Claim size ownership
- r: Redraw screen
- l: Scrollback dump (terminal native scrollbar)
- b: Scrollback viewer
- e: Edit session settings
- f: Fork session

### Remote Sessions
- Launch sessions on configured remote hosts via SSH
- Remote launcher (launch-claude-remote.sh) with install/update prompts
- Remote session reconnect on proxy restart (persists remoteHost in metadata)
- Lobby shows remote host in cyan (@hostname)

### Web API (port 3101)
Implemented:
- `GET /api/sessions` — list sessions (id, name, title, clients, owner, workingDir)
- `GET /api/directories` — directory history for picker
- `GET /api/session/:id/screen` — screen state as spans
- `WS /api/session/:id/stream` — bidirectional terminal stream
- `GET /api/auth/providers` — configured OAuth providers
- `GET /api/auth/login?provider=X` — start OAuth flow
- `GET /api/auth/callback` — OAuth callback
- `GET /api/auth/me` — current user from session cookie
- `POST /api/auth/logout` — clear session

Not yet implemented: see `docs/api.md` for full planned endpoint list.

### Session Persistence
- tmux-backed — sessions survive SSH disconnects
- Socket-based sessions (-S flag) for UGO permissions
- Graceful proxy restart — detach from tmux, rediscover on startup
- Remote sessions rediscovered via SSH to configured hosts
- Metadata on disk (/srv/claude-proxy/data/sessions/)
- Claude session IDs auto-discovered and stored
- Past session IDs tracked in pastClaudeSessionIds[]

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22, TypeScript, ESM |
| SSH server | ssh2 |
| PTY | node-pty |
| Session backend | tmux 3.5a (server-access ACLs) |
| Terminal emulator | @xterm/headless 6.x |
| User store | better-sqlite3-multiple-ciphers (encrypted SQLite) |
| OAuth | openid-client (OIDC) |
| Config | YAML + env + CLI flags |
| Process manager | systemd |
| Tests | vitest (203 tests, 29 files) |

## File Structure

```
claude-proxy/
├── src/
│   ├── index.ts              # main entry, lobby, creation/restart/export flows
│   ├── types.ts              # shared interfaces
│   ├── config.ts             # config loader
│   ├── ssh-transport.ts      # SSH server
│   ├── session-manager.ts    # session lifecycle, help menu, edit settings, fork
│   ├── pty-multiplexer.ts    # PTY + tmux + xterm buffer + socket support
│   ├── lobby.ts              # lobby UI
│   ├── hotkey.ts             # Ctrl+B handler
│   ├── scrollback-viewer.ts  # custom scrollback pager
│   ├── interactive-menu.ts   # menu component (used by lobby + help)
│   ├── ansi.ts               # ANSI escape helpers
│   ├── user-utils.ts         # user/group discovery
│   ├── session-store.ts      # metadata persistence + Claude ID discovery
│   ├── export.ts             # session export/zip
│   ├── dir-scanner.ts        # git repo scanner + history
│   ├── screen-renderer.ts    # xterm cells → spans for WebSocket
│   ├── api-server.ts         # HTTP + WebSocket API + auth routes
│   ├── widgets/
│   │   ├── keys.ts           # parseKey + isCancelKey
│   │   ├── list-picker.ts    # ListPicker
│   │   ├── text-input.ts     # TextInput
│   │   ├── yes-no.ts         # YesNoPrompt
│   │   ├── checkbox-picker.ts # CheckboxPicker (composes ListPicker)
│   │   ├── combo-input.ts    # ComboInput (composes ListPicker + TextInput)
│   │   ├── flow-engine.ts    # FlowEngine
│   │   └── renderers.ts      # ANSI render functions
│   ├── auth/
│   │   ├── types.ts          # UserIdentity, UserStore, Provisioner interfaces
│   │   ├── user-store.ts     # SQLiteUserStore
│   │   ├── provisioner.ts    # LinuxProvisioner
│   │   ├── resolve-user.ts   # resolveUser()
│   │   ├── oauth.ts          # OAuthManager (Google/Microsoft OIDC)
│   │   ├── github-adapter.ts # GitHub OAuth
│   │   ├── session-cookie.ts # HMAC-SHA256 cookies
│   │   └── middleware.ts     # Auth middleware
│   └── ugo/
│       ├── socket-manager.ts # tmux socket creation + permissions
│       └── group-watcher.ts  # inotify /etc/group enforcement
├── scripts/
│   ├── launch-claude.sh          # local launcher with auto-install
│   ├── launch-claude-remote.sh   # remote launcher with install/update prompts
│   ├── generate-host-keys.sh     # SSH host key generation
│   └── setup-remote.sh           # remote host setup (curl installer)
├── tests/                        # 203 tests across 29 files
├── data/
│   ├── sessions/                 # session metadata JSON
│   ├── users.db                  # SQLite user store (when activated)
│   └── dir-history.json          # working directory MRU history
├── claude-proxy.yaml             # server config (with auth section)
├── tmux.conf                     # tmux config (prefix = Ctrl+Q)
├── systemd/                      # systemd unit file
├── sessions.md                   # live project context
└── docs/
    ├── api.md                    # API reference + security model
    ├── bibliography.md           # sources referenced
    ├── research/                 # journals
    ├── integration/              # PRDs, cross-project docs
    └── superpowers/              # specs + plans
```

## Constraints

| Constraint | Why | Violation consequence |
|-----------|-----|----------------------|
| ESM-only imports (`import` not `require()`) | `"type": "module"` in package.json. Bit the team 3 times. | Runtime crash on startup |
| Nested shell quotes use temp scripts | tmux launch commands have layers of quoting (su, bash, claude args). Direct quoting breaks. | Session fails to launch, silent failures |
| `vterm.write()` is async | @xterm/headless processes input asynchronously. Must flush before reading buffer. | Stale/empty screen reads |
| tmux sessions MUST survive proxy restarts | The entire architecture depends on detach-not-kill. systemd KillMode=process + graceful shutdown. | All active Claude sessions destroyed |
| Arrow keys have TWO escape variants | CSI (`\x1b[A`) and SS3 (`\x1bOA`). Both must be handled. parseKey() handles this once. | Arrow keys silently stop working for some terminals |
| Ctrl+B prefix remapped tmux to Ctrl+Q | tmux.conf sets prefix to Ctrl+Q so Ctrl+B is available for proxy hotkeys. | Ctrl+B commands intercepted by tmux instead of proxy |
| `onRender` removed in @xterm/headless 6.x | Replaced with `onWriteParsed`. Does not provide line ranges. | Crash loop on startup (commit 2cdf195 fixed this) |
| Scroll MUST use tmux capture-pane | xterm buffer has no scrollback in alternate screen mode (Claude Code). | Scroll returns empty/current viewport instead of history |
| DO NOT kill tmux sessions | Sessions are the product. tmux processes survive server restarts. | Active agent work destroyed with no recovery |
| Socket-based sessions need `-S` flag on ALL tmux commands | has-session, list-sessions, attach, kill — all need `-S /path/to/socket` | Commands silently operate on wrong tmux server |

## Anti-Patterns (Tried and Abandoned)

| Approach | Problem | Replacement | Why it failed |
|----------|---------|-------------|---------------|
| Scroll bar as status bar (scroll-region) | Occupied terminal real estate, broke scrollback | Title bar via OSC escape | Status info in title bar is invisible to terminal buffer, doesn't consume rows |
| `npm install -g` for Claude on remotes | npm auto-update corrupted the install (ENOTEMPTY during rename) | `curl -sL https://claude.ai/install.sh \| bash` | Self-updating native build, no npm dependency, no corruption risk |
| Per-handler arrow key checks (`\x1b[A`) | 14 handlers, each checking differently, some missing SS3 variant | `parseKey()` in `src/widgets/keys.ts` | Single function normalizes both variants, widgets never see raw bytes |
| `Math.max/Math.min` for cursor bounds | Cursor stops at edges instead of wrapping | `ListPicker` with modulo wrapping | Lobby wrapped but pickers didn't — inconsistent UX |
| Renderer abstraction (widgets → ANSI/JSON/spans) | Over-engineering — browser uses its own HTML via API, not shared widget rendering | ANSI stays ANSI, browser calls API directly | Three transports don't need shared rendering, they need shared operations |
| `require('fs')` in ESM module | Runtime crash | `import { ... } from 'fs'` at top level | ESM doesn't support require(). Caught 3 times. |
| xterm buffer for scroll | baseY=0 in alternate screen, scroll returns current viewport | `tmux capture-pane -e` reads tmux's history buffer directly | Claude Code uses alternate screen, xterm has no scrollback there |
| `su -c` for remote interactive prompts | stdin not connected, `read` gets EOF, prompts auto-accept | Run launcher as root, `su` only at final `exec claude` | Remote launcher needs interactive prompts for install/update |

## Break Tests

| Mutation | What breaks | How to detect |
|----------|------------|---------------|
| Change any `import` to `require()` | Runtime crash — ESM rejects CommonJS | Server fails to start |
| Remove `-S` flag from a tmux command for socket sessions | Command operates on default tmux server, session not found | Session appears dead, create/attach fails silently |
| Remove `\x1bOA` check from `parseKey()` | Arrow keys stop working for terminals in application cursor mode | Arrows do nothing in PuTTY after exiting a tmux session |
| Change `onWriteParsed` back to `onRender` | Crash loop — `onRender` removed in xterm 6.x | Service crash-loops, systemd restart counter climbs |
| Kill a tmux session instead of detaching | Active Claude agent work destroyed | Session gone from lobby, no recovery possible |

## Provenance Tags

Features personally built and tested this session (c9510550):
- Widget system (all 8 files + migration)
- Auth infrastructure (UserStore, Provisioner, resolveUser, OAuth, cookies, middleware)
- UGO socket infrastructure (SocketManager, GroupWatcher)
- Working directory picker, remote launcher, scroll fix, fork session, cancel keys, arrow variants

Features inherited from previous agents, NOT retested this session:
- `[UNVERIFIED]` SSH transport (ssh2 server, pubkey auth)
- `[UNVERIFIED]` Lobby UI rendering (lobby.ts — tested indirectly via tmux)
- `[UNVERIFIED]` Export flow (zip creation, install script)
- `[UNVERIFIED]` Scrollback viewer (scrollback-viewer.ts)
- `[UNVERIFIED]` Status bar / typing indicators
- `[UNVERIFIED]` Session resume via `--resume` with Claude's picker
- `[UNVERIFIED]` Remote host setup script (setup-remote.sh)
- `[UNVERIFIED]` systemd graceful shutdown behavior

## Deprecations

- `status-bar.ts` — replaced by title bar via OSC escape
- `interactive-menu.ts` `wrapCursor()` — superseded by ListPicker's built-in wrapping (but still used by lobby's `nextSelectable`)
- Old inline picker/input handlers in index.ts — replaced by widget system
- npm-based Claude install on remotes — replaced by curl installer (self-updating)

## Limitations

- No web UI — SSH + API only (HTML pages not built yet)
- OAuth not activated — infrastructure built, needs real credentials + wiring
- UGO sockets wired but running alongside legacy default-server sessions
- No session recording/playback
- Single server (remote sessions via SSH, no clustering)
- Full-form rendering not implemented (one step at a time)
