# claude-proxy API Reference

## Security Model

```
OAuth (Cloudflare Access) → identity
Identity → Linux user mapping
Linux user → su to that user for tmux/claude
Unix permissions → process isolation, file isolation
Proxy ACLs → UI-level session visibility (convenience, not security)
```

### Principles

- **OAuth identity maps to a real Linux user.** Every authenticated user has a corresponding system account.
- **Sessions run as the authenticated user.** `runAsUser` is the core security mechanism, not an admin convenience. tmux and claude processes are owned by the user who created the session.
- **Unix permissions are the security boundary.** One user cannot `tmux attach` to another user's session because the OS blocks it. Files created by Claude belong to the creating user. Normal UGO permissions apply.
- **Proxy ACLs are a UI layer.** Session visibility rules (hidden, public, allowed users/groups) control what appears in the lobby and API responses. They are not the security boundary — the OS is.
- **API requests carry identity.** Every API call includes a bearer token or session cookie validated against the OAuth provider. The server resolves the token to a Linux user and executes all operations as that user.

### SSH Transport (Current)

- Authentication: SSH public key → Linux username
- All proxy access control enforced at the application layer
- tmux sessions run as `runAsUser` (default: session creator's username)
- Direct shell access bypasses proxy ACLs (acceptable in trusted environments)

### Web Transport (With OAuth)

- Authentication: Cloudflare Access → JWT → Linux user mapping
- All API endpoints require valid token
- Session creation: proxy `su`s to the mapped Linux user before launching tmux/claude
- Session join: proxy verifies OS-level access before attaching
- No direct tmux access from web — all interaction through the proxy API

### User Provisioning

When a new OAuth user first connects:
1. Cloudflare Access validates identity
2. Proxy checks for corresponding Linux user
3. If no user exists: create system account, set up home directory, install claude
4. Map OAuth identity to Linux username (stored in proxy config or DB)
5. All subsequent requests execute as that Linux user

---

## Existing Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sessions` | GET | List active sessions (id, name, title, clients, owner, workingDir) |
| `/api/directories` | GET | Directory history for picker |
| `/api/session/:id/screen` | GET | Current screen state (spans) |
| `/api/session/:id/stream` | WS | Bidirectional terminal stream (input/output/resize/scroll) |

## Needed for Session Creation

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sessions` | POST | Create a session (name, workingDir, remoteHost, access, commandArgs) |
| `/api/remotes` | GET | List configured remote hosts |
| `/api/remotes/:host/check-path` | POST | Check if a path exists on a remote host |
| `/api/users` | GET | List available users (for allowed-users picker) |
| `/api/groups` | GET | List available groups (for allowed-groups picker) |

Note: `runAsUser` is no longer a user-supplied parameter — it is always the authenticated user. Admin override (run as different user) requires `cp-admins` group membership.

## Needed for Session Management

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sessions/:id` | DELETE | Destroy a session |
| `/api/sessions/:id/settings` | GET | Get session access settings |
| `/api/sessions/:id/settings` | PATCH | Update session settings (hidden, viewOnly, public, password, users, groups, admins) |
| `/api/sessions/dead` | GET | List dead sessions (for restart picker) |
| `/api/sessions/:id/restart` | POST | Restart a dead session |

## Needed for Export

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/export` | POST | Export selected sessions (body: session IDs), returns zip |

## Auth Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/login` | GET | Redirect to Cloudflare Access login |
| `/api/auth/callback` | GET | OAuth callback — validates JWT, maps to Linux user, returns session token |
| `/api/auth/me` | GET | Current user info (username, groups, admin status) |
| `/api/auth/logout` | POST | Invalidate session |

## Admin Endpoints

Require `cp-admins` group membership.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/users` | GET | List all registered users (OAuth identity + Linux mapping) |
| `/api/admin/users/:id` | PATCH | Update user (groups, admin status, disable) |
| `/api/admin/users/:id/provision` | POST | Manually provision a Linux account for an OAuth identity |
| `/api/admin/invites` | POST | Generate invite code (if using invite-gated registration) |

## WebSocket Protocol

### Endpoint: `WS /api/session/:id/stream`

Bidirectional terminal streaming. On connect, server sends full screen state. Then sends deltas at 30ms intervals.

### Server → Client Messages

**Initial screen (on connect):**
```json
{
  "type": "screen",
  "width": 80,
  "height": 24,
  "cursor": { "x": 5, "y": 12 },
  "title": "session name | *root | 5m",
  "lines": [
    { "spans": [{ "text": "hello", "fg": "#c0c0c0", "bg": "#000000" }] },
    { "spans": [] }
  ]
}
```

**Delta (30ms batched, only changed lines):**
```json
{
  "type": "delta",
  "cursor": { "x": 5, "y": 12 },
  "title": "session name | *root | 5m",
  "changed": {
    "5": { "spans": [{ "text": "updated line", "fg": "#ffffff" }] },
    "12": { "spans": [{ "text": "another change" }] }
  }
}
```

Keys in `changed` are viewport-relative line indices (strings). Title updates on every delta (includes uptime).

**Scroll response:**
```json
{
  "type": "screen",
  "width": 80,
  "height": 24,
  "cursor": { "x": 0, "y": 0 },
  "title": "...",
  "scrollOffset": 20,
  "maxScrollback": 5000,
  "lines": [...]
}
```

When `scrollOffset > 0`, cursor is `{x:0, y:0}` (not meaningful in history). `maxScrollback` is total lines of history available.

### Client → Server Messages

**Keystroke:**
```json
{ "type": "input", "keys": "hello" }
```

**Special key:**
```json
{ "type": "input", "specialKey": "Enter" }
```

Special key names: Enter, Tab, Escape, Backspace, Delete, Up, Down, Right, Left, Home, End, PageUp, PageDown, Insert, F1-F12.

**Ctrl combo:**
```json
{ "type": "input", "keys": "c", "ctrl": true }
```

**Alt combo:**
```json
{ "type": "input", "keys": "x", "alt": true }
```

**Scroll:**
```json
{ "type": "scroll", "offset": 20 }
```

Offset is lines from bottom. 0 = live viewport. Server responds with a `screen` message.

**Resize:**
```json
{ "type": "resize", "cols": 120, "rows": 40 }
```

Server responds with a full `screen` message after 50ms delay.

### Span Format

```json
{
  "text": "content",
  "fg": "#c0c0c0",
  "bg": "#000000",
  "bold": true,
  "italic": false,
  "underline": false,
  "dim": false,
  "strikethrough": false
}
```

All style fields are optional. Colors are hex RGB strings from the 256-color palette.

### Error Responses

All API endpoints return JSON on error:

```json
{ "error": "Description of what went wrong" }
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request (missing params, invalid provider) |
| 401 | Not authenticated (missing/expired cookie) |
| 404 | Session not found |
| 500 | Server error (OAuth callback failure, etc.) |
