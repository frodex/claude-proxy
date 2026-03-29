# claude-proxy API Reference

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
| `/api/sessions` | POST | Create a session (name, workingDir, runAsUser, remoteHost, access, commandArgs) |
| `/api/remotes` | GET | List configured remote hosts |
| `/api/remotes/:host/check-path` | POST | Check if a path exists on a remote host |
| `/api/users` | GET | List available users (for allowed-users picker) |
| `/api/groups` | GET | List available groups (for allowed-groups picker) |

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

## Future (OAuth, User Management)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/providers` | GET | List OAuth providers |
| `/api/auth/login` | POST | Initiate OAuth flow |
| `/api/auth/callback` | GET | OAuth callback |
| `/api/auth/me` | GET | Current user info |
| `/api/admin/users` | GET | List registered users |
| `/api/admin/users/:id` | PATCH | Update user (role, groups) |
| `/api/admin/invites` | POST | Generate invite code |
