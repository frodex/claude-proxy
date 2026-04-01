# Handoff Plan — Pending Work for Next Agent

**Session:** c9510550-3bf3-4f87-bde0-ca10db1cfbab
**Date:** 2026-03-31
**Branch:** dev
**Previous version:** handoff-todos-v2.md
**Changes from v2:** Applied user review (NOTES-01a). Fork flow redesigned, unified edit/create screen, widget states added, security review on dead session restart.

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

### 1. Unified Session Edit/Create Screen (ONE SCREEN)

The session creation wizard and the edit settings screen (Ctrl+B e) should be THE SAME SCREEN. One widget that handles both creation of new sessions and editing of existing sessions.

**Widget states needed:**

| State | ANSI Color | Meaning | Example |
|-------|-----------|---------|---------|
| Active | White/bold | Current field, accepting input | Session name while typing |
| Completed | Green | Done, shows value, can revisit | `Session name: my-project ✓` |
| Locked | Yellow/dim | Has value, no permission to change | Session ID for non-owners |
| Grayed | Dark gray (`\x1b[38;5;245m`) | Not available (conditional) | "Allowed users" when public |
| Pending | Dim white | Future field, shows default | `Hidden: [N/y]` before you get there |

**Full-form rendering:** All fields visible at once. Completed fields show values. Active field has cursor. Pending fields show defaults grayed out. Enter advances. Arrow keys move between fields.

**This replaces:** TODO items 3, 4, and 9 from v2. One screen for initialization AND editing.

Fields: session name, working directory, run-as user (admin), server (admin+remotes), hidden, view-only, public, allowed users, allowed groups, password, danger mode, Claude session ID (locked/display-only on create, editable on edit for manual entry).

### 2. Fix fork flow — unified edit screen + notice + enter fork

Fork uses the SAME edit screen as create/edit, pre-filled:
- Name: `current-session-fork_001` (editable)
- Claude session ID: grayed/locked (from source session)
- Working directory: pre-filled from source
- All other settings: pre-filled from source

Before creating the fork, show a notice screen:
```
NOTICE: You are creating a fork of "session-name".
Your current session will remain running and can be
accessed from the lobby.

After this confirmation you will be in the forked
session to confirm it was created and working.

[Create Fork]
```

After confirmation → create fork → send user INTO the fork. User can:
- Ctrl+B d → back to lobby (find original session there)
- Ctrl+B h → help menu for the fork

### 3. Dead session restart — ALWAYS show edit screen first

**SECURITY RISK** if we restart immediately. User MUST confirm security settings before a non-running session starts. The stored settings may be stale or inappropriate.

Flow:
- Select dead session from restart picker
- Show the unified edit screen pre-filled with stored settings
- User reviews/edits security settings (hidden, public, allowed users, etc.)
- User confirms → session starts with reviewed settings
- Deep scan → show session ID prompt (paste ID or leave blank for Claude's picker) → then same edit screen

### 4. Fork from lobby

Add `f` key to lobby menu:
- Shows list of sessions with known Claude session IDs (live + dead)
- Select → goes to unified edit screen (pre-filled as fork)
- Same notice screen → enter fork flow
- Also allow pasting a session ID directly

### 5. Missing API endpoints

Every SSH flow needs a corresponding API endpoint for the browser. As we build/fix SSH features, the API endpoint should be built at the same time.

Documented in `docs/api-v2.md` but NOT implemented:

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

### 6. Wire OAuth into index.ts startApiServer call
The OAuth modules exist but aren't passed to startApiServer yet. Need to:
- Read provider config from claude-proxy.yaml
- Create OAuthManager + GitHubAdapter if configured
- Create SQLiteUserStore
- Pass all to startApiServer options

### 7. Web UI
No HTML pages exist yet. Needed:
- Login page (OAuth provider buttons)
- Session list (lobby equivalent)
- Session creation form (calls POST /api/sessions)
- Terminal viewer (already works via WebSocket)
- Admin panel (user management)

---

## Cautions for Next Agent

### What I was careful about
- Never killing tmux sessions — always detach, never kill. `systemctl restart` detaches cleanly.
- Both arrow key variants (`\x1b[A` and `\x1bOA`) — tested with PuTTY which switches between them.
- ESM imports — caught `require()` errors 3 times. Everything must be `import`.
- Temp scripts for tmux launch commands — nested quoting breaks otherwise.

### What surprised me
- `@xterm/headless` 6.x removed `onRender` silently — caused a crash loop that only showed up after installing new deps (the npm install pulled a newer version).
- Claude on ct100 had a corrupt npm install — the package directory was empty. Caused by a failed auto-update (ENOTEMPTY during rename).
- `su -c` doesn't pass stdin — remote launcher prompts auto-accepted because `read` got EOF. Fixed by running launcher as root, `su` only at final exec. NOT a security issue — the launcher only runs `curl` installer and `claude`, both safe. But be aware of this pattern if adding new remote commands.
- The `~/.claude/sessions/<pid>.json` files are the fastest way to discover Claude session IDs — much faster than scanning JSONL files.

### Widget test coverage
- parseKey: 19 tests — solid, covers both variants
- ListPicker: 11 tests — navigation, wrap, disabled skip, select/cancel
- TextInput: 11 tests — typing, backspace, submit, tab, paste, masked
- YesNoPrompt: 8 tests — y/n/enter/escape
- CheckboxPicker: 7 tests — **Thin: no empty list, no toggle-all**
- ComboInput: 10 tests — **No tab-completion callback integration tests**
- FlowEngine: 7 tests — **No escape from mid-flow, no back-navigation tests**
- Renderers: 6 tests — **No long labels, width truncation, or ANSI correctness tests**

### Auth activation sequence
1. Set OAuth env vars in claude-proxy.yaml (client_id, client_secret for Google/Microsoft/GitHub)
2. Set session.secret (random string for cookie signing)
3. Pass OAuth options to `startApiServer()` in index.ts (NOT YET DONE — item 6 in todos)
4. Create `cp-users` group: `groupadd cp-users`
5. The SQLite DB auto-creates on first use at `data/users.db`
6. Without OAuth configured, auth routes return "not configured" — no breakage
7. Auth middleware is NOT applied to existing endpoints yet — backward compatible

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
| API reference (post-review) | `docs/api-v2.md` |
| Auth + UGO spec | `docs/superpowers/specs/2026-03-29-auth-ugo-security-design.md` |
| Widget system spec | `docs/superpowers/specs/2026-03-31-widget-system-design.md` |
| Widget system plan | `docs/superpowers/plans/2026-03-31-widget-system.md` |
| PRD as-built (post-review) | `docs/integration/PRD-claude-proxy-as-built-v2.1.md` |
| Steward review | `docs/integration/steward-review-2026-03-31.md` |
| Sessions context | `sessions.md` |
| Research journals | `docs/research/` |
| Bibliography | `docs/bibliography.md` |
