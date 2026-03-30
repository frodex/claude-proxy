# Auth + UGO Security Model

Session access control enforced by Unix permissions, not application logic. OAuth for web clients. SQLite user store, designed for Vault migration.

## Principles

1. **Unix permissions are the security boundary.** tmux sockets use UGO to control who can attach. The proxy enforces nothing the OS doesn't already enforce.
2. **OAuth identity maps to a real Linux user.** Every authenticated web user has a system account. Sessions run as that user.
3. **Proxy ACLs are a UI layer.** Hidden/public/allowedUsers control what appears in the lobby. The OS controls what's actually accessible.
4. **Storage is swappable.** SQLite now. Vault Transit for Docker distribution later. The interface is the same.

## Architecture

```
SSH Client:
  SSH public key → Linux username → resolveUser() → LinuxIdentity

Web Client:
  Browser → /api/auth/login?provider=google → OAuth flow → JWT
  JWT → resolveUser() → LinuxIdentity

Both paths converge:
  LinuxIdentity → su to user → tmux -S socket (UGO enforced)
```

## Phase 1: Shared Contract

### User Store Interface

```typescript
interface UserIdentity {
  linuxUser: string;           // system account name
  displayName: string;         // human-readable name
  email?: string;              // from OAuth provider
  provider?: string;           // 'ssh' | 'google' | 'microsoft' | 'github'
  providerId?: string;         // provider-specific unique ID
  groups: string[];            // cp-* groups (without prefix)
  createdAt: Date;
  lastLogin: Date;
}

interface UserStore {
  // Lookup
  findByLinuxUser(username: string): UserIdentity | null;
  findByProvider(provider: string, providerId: string): UserIdentity | null;
  findByEmail(email: string): UserIdentity | null;

  // Mutation
  createUser(identity: UserIdentity): void;
  updateLastLogin(linuxUser: string): void;
  linkProvider(linuxUser: string, provider: string, providerId: string, email: string): void;

  // Listing
  listUsers(): UserIdentity[];
  listByGroup(group: string): UserIdentity[];
}
```

### resolveUser()

Single entry point for identity resolution. Both SSH and OAuth paths call this.

```typescript
interface ResolveResult {
  identity: UserIdentity;
  isNew: boolean;              // true if account was just provisioned
}

function resolveUser(source: SshSource | OAuthSource): ResolveResult;
```

For SSH: looks up Linux username in user store. Creates entry if first time (user already exists in OS).

For OAuth: looks up provider+providerId in user store. If not found, provisions a new Linux account, creates user store entry, returns `isNew: true`.

### Provisioning Interface

```typescript
interface Provisioner {
  createSystemAccount(username: string, displayName: string): void;
  // useradd, set up home dir, add to cp-users group

  installClaude(username: string): void;
  // su to user, run curl installer

  addToGroup(username: string, group: string): void;
  removeFromGroup(username: string, group: string): void;

  createGroup(group: string): void;
  deleteGroup(group: string): void;

  getGroups(username: string): string[];
}
```

Wraps Linux commands (`useradd`, `usermod`, `groupadd`, `gpasswd`, etc.). Single place for all system account management.

### SQLite Implementation

Database: `/srv/claude-proxy/data/users.db`

```sql
CREATE TABLE users (
  linux_user TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL,
  last_login TEXT NOT NULL
);

CREATE TABLE provider_links (
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  linux_user TEXT NOT NULL REFERENCES users(linux_user),
  email TEXT,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_id)
);

CREATE INDEX idx_provider_links_user ON provider_links(linux_user);
CREATE INDEX idx_users_email ON users(email);
```

No secrets in SQLite. OAuth tokens are kept in memory only (session lifetime). Refresh tokens stored encrypted with a local key derived from machine identity (for Vault migration later — swap the encryption to Vault Transit).

## Phase 2: Tests

Tests verify the contract before either side is built:

- `resolveUser` with SSH source returns existing user
- `resolveUser` with SSH source creates user store entry for new SSH user
- `resolveUser` with OAuth source returns linked user
- `resolveUser` with OAuth source provisions new account when unlinked
- `resolveUser` with OAuth source links to existing account by email match
- `UserStore` CRUD operations on SQLite
- `Provisioner` creates/deletes system accounts and groups (test in a sandbox or mock)
- Provider link: same Linux user can have multiple OAuth providers linked

## Phase 3: UGO Security

### tmux Socket Layout

```
/var/run/claude-proxy/
  sessions/
    cp-myproject.sock         owner=greg  group=cp-sess-myproject  mode=0770
    cp-private-work.sock      owner=greg  group=greg               mode=0700
    cp-team-debug.sock        owner=greg  group=cp-devteam         mode=0770
```

Directory `/var/run/claude-proxy/sessions/` created on startup, mode `0755`, owned by root.

### Session Creation

```typescript
// 1. Create session group (if shared)
provisioner.createGroup(`cp-sess-${sessionName}`);
provisioner.addToGroup(owner, `cp-sess-${sessionName}`);

// 2. Launch tmux with custom socket
const socketPath = `/var/run/claude-proxy/sessions/cp-${sessionName}.sock`;
execSync(`su - ${owner} -c "tmux -S ${socketPath} new-session -d -s cp-${sessionName} ..."`);

// 3. Set socket permissions
chownSync(socketPath, ownerUid, groupGid);
chmodSync(socketPath, 0o770);  // or 0o700 for private

// 4. Configure tmux server-access
execSync(`su - ${owner} -c "tmux -S ${socketPath} server-access -a ${owner} -w"`);
```

### Session Join

```typescript
// Proxy su's to the requesting user, tmux checks socket permissions
execSync(`su - ${joiner} -c "tmux -S ${socketPath} attach-session -t cp-${sessionName}"`);
// If joiner doesn't have group access → OS returns permission denied
```

### Permission Levels

| Setting | Socket Mode | Socket Group | tmux server-access |
|---------|-----------|-------------|-------------------|
| Private | 0700 | owner's primary group | owner only |
| Shared (specific users) | 0770 | `cp-sess-{name}` | each user added with `-a` |
| Team | 0770 | `cp-{teamname}` | derived from group members |
| Public | 0770 | `cp-users` | all registered users |
| View-only user | 0770 | in group | `server-access -a user -r` (read-only) |

### Live Permission Changes

When owner modifies access on a running session:

**Add user:**
1. `provisioner.addToGroup(user, sessionGroup)`
2. `tmux -S socket server-access -a user -w` (or `-r` for view-only)
3. User can join immediately (proxy mediates attach via `su`)

**Remove user:**
1. `tmux -S socket detach-client` for their connection (immediate kick)
2. `tmux -S socket server-access -d user` (revoke tmux ACL)
3. `provisioner.removeFromGroup(user, sessionGroup)`

**Change visibility (public → private):**
1. Change socket group from `cp-users` to `cp-sess-{name}`
2. Detach users not in new group
3. Update tmux `server-access` to match

### inotify Group Watch

```typescript
import { watch } from 'fs';

watch('/etc/group', () => {
  for (const session of activeSessions) {
    for (const client of session.clients) {
      const groups = provisioner.getGroups(client.linuxUser);
      const sessionGroup = getSessionGroup(session);
      if (!groups.includes(sessionGroup)) {
        detachClient(session, client);
        revokeServerAccess(session, client.linuxUser);
      }
    }
  }
});
```

### Discovery Changes

Current `discoverSessions()` uses `tmux list-sessions` on the default server. With `-S` sockets, each session has its own tmux server. Discovery becomes: scan the socket directory, check which sockets are alive, load metadata.

```typescript
function discoverSessions(): void {
  const socketDir = '/var/run/claude-proxy/sessions/';
  const sockets = readdirSync(socketDir).filter(f => f.endsWith('.sock'));

  for (const socketFile of sockets) {
    const socketPath = join(socketDir, socketFile);
    // Check if tmux server is alive
    try {
      execSync(`tmux -S ${socketPath} list-sessions`, { stdio: 'pipe' });
      // Alive — load metadata and reattach
      reattachSession(socketPath);
    } catch {
      // Dead socket — clean up
      unlinkSync(socketPath);
    }
  }
}
```

### Lobby Visibility

The lobby filters sessions by what the requesting user can see:

```typescript
function listSessionsForUser(username: string): Session[] {
  const userGroups = provisioner.getGroups(username);
  return allSessions.filter(session => {
    // Check if user is in the session's socket group
    const socketGroup = getSessionGroup(session);
    if (username === session.owner) return true;
    if (!userGroups.includes(socketGroup)) return false;
    // UI-level: respect hidden flag
    if (session.hidden && username !== session.owner) return false;
    return true;
  });
}
```

Group membership check runs server-side (not `accessSync` as root). The group list comes from `getent`, which reflects current OS state.

## Phase 4: OAuth

### Providers

Configuration in `claude-proxy.yaml`:

```yaml
auth:
  # Existing SSH key auth
  authorized_keys: ~/.ssh/authorized_keys

  # OAuth providers
  providers:
    google:
      client_id: "xxx.apps.googleusercontent.com"
      client_secret: "xxx"
      # discovery URL is automatic for OIDC providers

    microsoft:
      client_id: "xxx"
      client_secret: "xxx"
      tenant: "common"  # or specific tenant ID

    github:
      client_id: "xxx"
      client_secret: "xxx"

  # How OAuth emails map to Linux usernames
  user_mapping:
    strategy: "email-prefix"  # greg@example.com → greg
    # or "explicit" — manual mapping in user store
    # or "auto" — create username from display name

  # Auto-provision Linux accounts for new OAuth users?
  auto_provision: true

  # Default groups for new users
  default_groups: ["users"]

  # Session cookie settings
  session:
    secret: "xxx"  # for signing cookies
    max_age: 86400  # 24 hours
```

### OIDC Flow (Google, Microsoft)

Uses `openid-client` npm package. Both providers are OIDC-compliant — same code, different discovery URLs.

```
GET /api/auth/login?provider=google
  → build auth URL from provider's OIDC discovery
  → redirect to Google consent screen

GET /api/auth/callback?code=XXX&state=YYY
  → exchange code for tokens via OIDC
  → extract email, name, provider ID from ID token
  → resolveUser({ provider: 'google', providerId, email, displayName })
  → set signed session cookie
  → redirect to app
```

### GitHub Flow (Custom Adapter)

GitHub is OAuth 2.0 but not OIDC. Needs ~50 lines of custom code:

```
GET /api/auth/login?provider=github
  → redirect to github.com/login/oauth/authorize

GET /api/auth/callback?code=XXX
  → POST github.com/login/oauth/access_token (exchange code)
  → GET api.github.com/user (get profile)
  → GET api.github.com/user/emails (get verified email)
  → resolveUser({ provider: 'github', providerId, email, displayName })
  → set session cookie
  → redirect to app
```

### API Auth Middleware

Every API endpoint (except `/api/auth/*`) requires authentication:

```typescript
function authMiddleware(req, res, next) {
  // Check session cookie first (web clients)
  const session = validateCookie(req);
  if (session) {
    req.user = session.identity;
    return next();
  }

  // No cookie — reject
  res.writeHead(401);
  res.end(JSON.stringify({ error: 'Authentication required' }));
}
```

SSH clients don't go through the API — they're authenticated at the SSH transport level and the proxy already knows their Linux username.

### User Provisioning Flow

When `resolveUser()` encounters a new OAuth user:

1. Determine Linux username from email (configurable strategy)
2. Check if username is taken — if so, append number (`greg` → `greg2`)
3. `provisioner.createSystemAccount(username, displayName)` — runs `useradd`
4. `provisioner.addToGroup(username, 'cp-users')` — everyone gets base group
5. `provisioner.installClaude(username)` — runs installer as the new user
6. `userStore.createUser(identity)` — persist in SQLite
7. `userStore.linkProvider(username, provider, providerId, email)` — link OAuth identity
8. Return `{ identity, isNew: true }`

### Linking Multiple Providers

A user can log in with Google first, then later link their GitHub account. If the email matches, the accounts merge automatically. If not, they can link manually through the settings UI.

```
GET /api/auth/link?provider=github  (while already logged in)
  → OAuth flow with GitHub
  → callback links GitHub identity to current user's Linux account
```

## Migration Path

### From Current State

1. Add SQLite user store — populate from existing `/etc/passwd` for SSH users
2. Switch tmux launch to use `-S` custom sockets
3. Migrate session access control to use socket permissions + `server-access`
4. Add inotify watch
5. Proxy ACLs become UI hints, mapped to group operations
6. Add OAuth endpoints
7. Add auth middleware to API

### From SQLite to Vault (Docker)

The `UserStore` interface stays the same. The SQLite implementation is swapped for a Vault-backed implementation that:
- Stores user records in Vault KV
- Encrypts sensitive fields through Vault Transit
- Uses Vault's audit log for compliance

The `Provisioner` interface also stays the same but may use container-specific user management in Docker.

## Files

| File | Purpose |
|------|---------|
| `src/auth/user-store.ts` | UserStore interface + SQLite implementation |
| `src/auth/resolve-user.ts` | resolveUser() — identity resolution |
| `src/auth/provisioner.ts` | Provisioner interface + Linux implementation |
| `src/auth/oauth.ts` | OIDC + GitHub OAuth flows |
| `src/auth/middleware.ts` | API auth middleware (cookie validation) |
| `src/auth/session-cookie.ts` | Signed cookie creation/validation |
| `src/ugo/socket-manager.ts` | tmux socket creation, permissions, server-access |
| `src/ugo/group-watcher.ts` | inotify on /etc/group, reactive enforcement |
| `tests/auth/user-store.test.ts` | UserStore contract tests |
| `tests/auth/resolve-user.test.ts` | resolveUser tests |
| `tests/auth/provisioner.test.ts` | Provisioner tests (mocked) |
| `tests/ugo/socket-manager.test.ts` | Socket permission tests |
