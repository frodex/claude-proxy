# Handoff Plan — Pending Work for Next Agent

**Session:** c9510550-3bf3-4f87-bde0-ca10db1cfbab
**Date:** 2026-03-31
**Branch:** dev

---

## What Was Built This Session

### Widget System (complete)
- `src/widgets/` — 8 files: parseKey, ListPicker, TextInput, YesNoPrompt, CheckboxPicker, ComboInput, FlowEngine, renderers
- All menus migrated to use widgets (creation flow, restart, export, session settings)
- 203 tests, 29 test files

### Auth + UGO Security (complete)
- `src/auth/` — UserStore (SQLite), Provisioner (Linux), resolveUser, OAuth (Google/Microsoft/GitHub), session cookies, middleware
- `src/ugo/` — SocketManager (tmux -S sockets), GroupWatcher (inotify /etc/group)
- Wired into SessionManager and index.ts

### Other Features Built
- Working directory picker (ComboInput — list + freehand + tab-completion)
- Remote session reconnect on proxy restart
- Remote launcher with install/update prompts (launch-claude-remote.sh)
- Scroll fix (tmux capture-pane instead of xterm buffer)
- Auto-discover Claude session IDs from ~/.claude/sessions/<pid>.json
- Fork session (Ctrl+B f) — creates background fork with --fork-session
- Multiple cancel keys (Esc, Ctrl+C, q)
- Arrow key dual-variant support (CSI + SS3)

---

## Pending TODOs (priority order)

### 1. Fix fork flow — send user INTO the fork
Currently fork launches in background and user stays in original. Should:
- Create the fork
- Attach user to the fork so they can confirm it works
- Backfill gets the new fork's Claude session ID
- User can Ctrl+B d back to lobby, or Ctrl+B h to stay
- Show message: "Forked from: original-name. Your original session is still running."

### 2. Move session ID prompt to deep scan
Currently the resume ID prompt appears after selecting a dead session (redundant — dead sessions already have metadata). Should:
- Dead session select → restart immediately (use stored claudeSessionId if available)
- Deep scan → show session ID prompt (paste ID or leave blank for Claude's picker)

### 3. Full-form rendering for creation flow
Currently shows one step at a time (clear screen per step). Should:
- Show ALL steps on screen at once
- Completed steps show their values
- Current step has cursor/input
- Future steps show defaults grayed out
- Enter advances to next step (accepts default if unchanged)
- Requires adding `getFlowSummary()` to FlowEngine

### 4. Add session name + Claude session ID to Ctrl+B e (edit settings)
- Rename session while connected
- Manually enter/override Claude session ID
- These fields are in session metadata already, just need UI

### 5. Fork from lobby
- Add `f` key to lobby menu
- Shows list of sessions with known Claude session IDs (live + dead)
- Select → creates fork
- Also allow pasting a session ID directly

### 6. Missing API endpoints
Documented in `docs/api.md` but NOT implemented:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sessions` | POST | Create a session |
| `/api/sessions/:id` | DELETE | Destroy a session |
| `/api/sessions/:id/settings` | GET | Get session settings |
| `/api/sessions/:id/settings` | PATCH | Update session settings |
| `/api/sessions/dead` | GET | List dead sessions |
| `/api/sessions/:id/restart` | POST | Restart a dead session |
| `/api/sessions/:id/fork` | POST | Fork a session |
| `/api/remotes` | GET | List configured remote hosts |
| `/api/remotes/:host/check-path` | POST | Check path on remote |
| `/api/users` | GET | List available users |
| `/api/groups` | GET | List available groups |
| `/api/export` | POST | Export sessions as zip |
| `/api/admin/users` | GET | List registered users |
| `/api/admin/users/:id` | PATCH | Update user flags |
| `/api/admin/users/:id/provision` | POST | Provision Linux account |
| `/api/admin/invites` | POST | Generate invite code |

Currently implemented:
- `GET /api/sessions` — list sessions
- `GET /api/directories` — directory history
- `GET /api/session/:id/screen` — screen state
- `WS /api/session/:id/stream` — terminal stream
- `GET /api/auth/providers` — OAuth providers
- `GET /api/auth/login` — start OAuth
- `GET /api/auth/callback` — OAuth callback
- `GET /api/auth/me` — current user
- `POST /api/auth/logout` — clear session

### 7. Wire OAuth into index.ts startApiServer call
The OAuth modules exist but aren't passed to startApiServer yet. Need to:
- Read provider config from claude-proxy.yaml
- Create OAuthManager + GitHubAdapter if configured
- Create SQLiteUserStore
- Pass all to startApiServer options

### 8. Web UI
No HTML pages exist yet. Needed:
- Login page (OAuth provider buttons)
- Session list (lobby equivalent)
- Session creation form
- Terminal viewer (already works via WebSocket)
- Admin panel (user management)

### 9. Full-form rendering for YesNo inline prompts
YesNo prompts currently clear the screen. Should render inline on the form.

---

## Key Files

| File | Lines | What it does |
|------|-------|-------------|
| `src/index.ts` | 848 | SSH connection handler, lobby, creation/restart/export flows |
| `src/session-manager.ts` | 1071 | Session lifecycle, help menu, edit settings, fork |
| `src/api-server.ts` | ~600 | HTTP + WebSocket API |
| `src/pty-multiplexer.ts` | ~450 | tmux management, socket support |
| `src/widgets/` | 8 files | Widget system |
| `src/auth/` | 6 files | Auth system |
| `src/ugo/` | 2 files | UGO socket security |

## Key Docs

| Doc | Path |
|-----|------|
| API reference | `docs/api.md` |
| Auth + UGO spec | `docs/superpowers/specs/2026-03-29-auth-ugo-security-design.md` |
| Widget system spec | `docs/superpowers/specs/2026-03-31-widget-system-design.md` |
| Widget system plan | `docs/superpowers/plans/2026-03-31-widget-system.md` |
| Sessions context | `sessions.md` |
| Research journals | `docs/research/` |
| Bibliography | `docs/bibliography.md` |
