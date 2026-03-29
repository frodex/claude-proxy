# Session Working Directory

Allow users to specify a working directory when creating a new session. Claude launches in that directory instead of the default home directory.

## Components

### 1. Directory Scanner (`src/dir-scanner.ts`)

New module that provides a merged list of directories for the picker.

**Sources (in display order):**
1. **History** — most-recently-used directories from past sessions, stored in `/srv/claude-proxy/data/dir-history.json`
2. **Git repos** — discovered by scanning for `.git/` directories under root paths

**Scan behavior:**
- Default root paths: `/srv`, `/home`, `/root`
- Max depth: 3 levels from each root
- Skip: `node_modules`, `.git`, `dist`, `build`, hidden directories (except `.config`)
- Results cached in memory after first scan
- `rescan()` method to refresh on demand

**History file (`data/dir-history.json`):**
```json
["/srv/claude-proxy", "/srv/svg-terminal", "/root/myproject"]
```
- Simple array of paths, most-recent first
- Capped at 50 entries
- Updated when a session is created with a working directory
- `addToHistory(path)` — pushes to front, deduplicates, trims

**Public API:**
```typescript
export class DirScanner {
  constructor(rootPaths?: string[]);
  scan(): string[];                    // cached git repo scan
  rescan(): string[];                  // force rescan
  getDirectories(): string[];          // history + scan results, deduplicated
  addToHistory(dir: string): void;     // record usage
  getHistory(): string[];              // history only
}
```

### 2. Lobby Flow — `'workdir'` Step

New step in the session creation state machine in `src/index.ts`.

**Position in flow:**
- After `'name'`
- Before `'runas'` (admins) or `'hidden'` (non-admins)

**UI behavior:**
- Header: `"Working directory:"`
- Show list of directories (history section labeled `"Recent"`, scan section labeled `"Projects"`)
- Arrow keys navigate, Enter selects
- Typing filters the list (prefix match on the last path component, or anywhere in full path)
- First entry is always `"~ (home directory)"` — selects the default
- Last entry is always `"Custom path..."` — switches to freehand text input
- In freehand mode: type a path, Enter to confirm, Esc to go back to picker
- Validate: directory must exist (check with `existsSync`). Show error inline if not.

**Flow state additions:**
```typescript
// Add to the flow interface
workingDir?: string;

// Add to step union
step: 'name' | 'workdir' | 'runas' | 'server' | 'hidden' | ...
```

### 3. Plumbing

**`src/types.ts` — Session interface:**
```typescript
export interface Session {
  // ... existing fields
  workingDir?: string;  // absolute path, undefined = home directory
}
```

**`src/session-store.ts` — StoredSession:**
```typescript
interface StoredSession {
  // ... existing fields
  workingDir?: string;
}
```

**`src/pty-multiplexer.ts` — PtyOptions:**
```typescript
interface PtyOptions {
  // ... existing fields
  workingDir?: string;
}
```

**PtyMultiplexer constructor — tmux launch:**

For local sessions, the inner command changes from:
```bash
/path/to/launch-claude.sh [args]
```
to:
```bash
cd /srv/myproject && /path/to/launch-claude.sh [args]
```

For `su` commands:
```bash
su - user -c 'cd /srv/myproject && /path/to/launch-claude.sh [args]'
```

For remote sessions, same pattern:
```bash
su - user -c 'cd /srv/myproject && claude [args]'
```

If `workingDir` is undefined or `"~"`, no `cd` prefix is added (existing behavior).

**`src/session-manager.ts` — createSession:**
```typescript
createSession(
  name: string,
  creator: Client,
  runAsUser?: string,
  command?: string,
  access?: Partial<SessionAccess>,
  commandArgs?: string[],
  remoteHost?: string,
  workingDir?: string,    // new parameter
): Session
```

Passes `workingDir` to `PtyMultiplexer` constructor and includes it in `saveSessionMeta()`.

### 4. Web API

**`GET /api/sessions` response** — add `workingDir` field:
```json
{
  "id": "cp-myproject",
  "name": "myproject",
  "workingDir": "/srv/claude-proxy",
  ...
}
```

**`GET /api/directories`** — new endpoint:
```json
{
  "history": ["/srv/claude-proxy", "/srv/svg-terminal"],
  "projects": ["/srv/other-repo", "/home/greg/stuff"]
}
```

Returns the same data the lobby picker uses. Browser clients use this to build their own directory picker UI.

### 5. Session Restart

When restarting a dead session (`'r'` in lobby), the stored `workingDir` is reused. The restart flow already reads `StoredSession` metadata — it will pick up `workingDir` automatically.

## Files Changed

| File | Change |
|------|--------|
| `src/dir-scanner.ts` | **New** — directory scanner + history |
| `src/types.ts` | Add `workingDir?: string` to Session |
| `src/session-store.ts` | Add `workingDir?: string` to StoredSession |
| `src/pty-multiplexer.ts` | Add `workingDir` to PtyOptions, prepend `cd` to innerCommand |
| `src/session-manager.ts` | Accept + pass `workingDir` in createSession, persist in metadata |
| `src/index.ts` | Add `'workdir'` step to creation flow, wire up DirScanner |
| `src/api-server.ts` | Add `workingDir` to session list, add `GET /api/directories` |
| `tests/dir-scanner.test.ts` | **New** — unit tests for scanner + history |

## Edge Cases

- **Path doesn't exist**: Validation rejects it, user re-prompted
- **Path exists but no permission**: Claude will fail to start — same as today if you `su` to a user without access. Not a new problem.
- **Empty scan results**: Picker shows only history + home + custom. Still usable.
- **Remote sessions**: `workingDir` is validated locally but the `cd` runs on the remote host. If the path doesn't exist remotely, claude fails to start. Acceptable — same trust model as remote sessions today.
