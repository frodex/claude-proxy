# Launch Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded `'claude'` session creation path with a profile registry so the lobby offers "New terminal", "New Claude session", and "New Cursor session" through **one** shared flow — and the API accepts `launchProfile` for the same.

**Architecture:** New `src/launch-profiles.ts` defines profile types and a registry. `StoredSession` persists the profile. Lobby gets a two-step picker (choose profile → shared form). `finalizeSessionFromResults` and `POST /api/sessions` both resolve command/args from the profile instead of hard-coding. `scheduleClaudeIdBackfill` is gated by profile capability. YAML form fields gain a profile-aware condition for Claude-only fields (`dangermode`, `claudeSessionId`). Remote launches remain Claude-only for now (out of scope for non-Claude profiles on remotes).

**Tech Stack:** TypeScript, ESM, vitest, YAML (session-form config)

**Research doc:** `docs/research/add-terminal.v05.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/launch-profiles.ts` | **New.** `LaunchProfile` type, `PROFILES` registry, `getProfile()`, `resolveCommand()`, `buildCommandArgs()` |
| `src/session-store.ts` | **Modify.** Add `launchProfile?` to `StoredSession` |
| `src/lobby.ts` | **Modify.** Replace single "New session" with three profile menu items |
| `src/session-form.ts` | **Modify.** Add `claude-profile-only` predicate; pass `_launchProfile` to accumulator |
| `src/session-form.yaml` | **Modify.** Add `condition: claude-profile-only` to `dangermode` and `claudeSessionId` fields |
| `src/index.ts` | **Modify.** `startNewSessionFlow` accepts `profileId`; `finalizeSessionFromResults` resolves via profile; lobby dispatch routes new actions |
| `src/session-manager.ts` | **Modify.** Gate `scheduleClaudeIdBackfill` on profile capability |
| `src/api-server.ts` | **Modify.** `POST /api/sessions` accepts `launchProfile`; resolves command from registry |
| `tests/launch-profiles.test.ts` | **New.** Unit tests for profile registry, command resolution, arg building |
| `tests/session-form.test.ts` | **Modify.** Add tests for profile-gated fields |

---

## Task 1: Create launch profile registry

**Files:**
- Create: `src/launch-profiles.ts`
- Create: `tests/launch-profiles.test.ts`

- [ ] **Step 1: Write failing tests for profile registry**

```typescript
// tests/launch-profiles.test.ts
import { describe, test, expect } from 'vitest';
import { getProfile, listProfiles, resolveCommand, buildCommandArgs } from '../src/launch-profiles.js';

describe('launch-profiles', () => {
  test('listProfiles returns all registered profiles', () => {
    const profiles = listProfiles();
    expect(profiles.map(p => p.id)).toContain('shell');
    expect(profiles.map(p => p.id)).toContain('claude');
    expect(profiles.map(p => p.id)).toContain('cursor');
  });

  test('getProfile returns profile by id', () => {
    const claude = getProfile('claude');
    expect(claude).toBeDefined();
    expect(claude!.id).toBe('claude');
    expect(claude!.label).toBe('New Claude session');
  });

  test('getProfile returns undefined for unknown id', () => {
    expect(getProfile('nonexistent')).toBeUndefined();
  });

  test('resolveCommand for shell profile', () => {
    const { command, useLauncher } = resolveCommand('shell');
    expect(command).toBe('/bin/bash');
    expect(useLauncher).toBe(false);
  });

  test('resolveCommand for claude profile', () => {
    const { command, useLauncher } = resolveCommand('claude');
    expect(command).toBe('claude');
    expect(useLauncher).toBe(true);
  });

  test('resolveCommand for cursor profile', () => {
    const { command, useLauncher } = resolveCommand('cursor');
    expect(command).toBe('cursor');
    expect(useLauncher).toBe(false);
  });

  test('buildCommandArgs for shell — no special args', () => {
    const args = buildCommandArgs('shell', { dangerousSkipPermissions: true });
    expect(args).toEqual(['-l']);
  });

  test('buildCommandArgs for claude with resume', () => {
    const args = buildCommandArgs('claude', { isResume: true, dangerousSkipPermissions: true });
    expect(args).toContain('--resume');
    expect(args).toContain('--dangerously-skip-permissions');
  });

  test('buildCommandArgs for claude without flags', () => {
    const args = buildCommandArgs('claude', {});
    expect(args).toEqual([]);
  });

  test('buildCommandArgs for cursor — no claude-specific flags', () => {
    const args = buildCommandArgs('cursor', { dangerousSkipPermissions: true });
    expect(args).toEqual([]);
  });

  test('profile capabilities', () => {
    const shell = getProfile('shell')!;
    expect(shell.capabilities.fork).toBe(false);
    expect(shell.capabilities.resume).toBe(false);
    expect(shell.capabilities.sessionIdBackfill).toBe(false);

    const claude = getProfile('claude')!;
    expect(claude.capabilities.fork).toBe(true);
    expect(claude.capabilities.resume).toBe(true);
    expect(claude.capabilities.sessionIdBackfill).toBe(true);

    const cursor = getProfile('cursor')!;
    expect(cursor.capabilities.fork).toBe(false);
    expect(cursor.capabilities.resume).toBe(false);
    expect(cursor.capabilities.sessionIdBackfill).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/launch-profiles.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement launch-profiles module**

```typescript
// src/launch-profiles.ts

export interface ProfileCapabilities {
  fork: boolean;
  resume: boolean;
  sessionIdBackfill: boolean;
  dangerMode: boolean;
  remoteSupport: boolean;
}

export interface LaunchProfile {
  id: string;
  label: string;
  key: string;
  command: string;
  defaultArgs: string[];
  useLauncher: boolean;
  capabilities: ProfileCapabilities;
}

const PROFILES: LaunchProfile[] = [
  {
    id: 'shell',
    label: 'New terminal',
    key: 't',
    command: '/bin/bash',
    defaultArgs: ['-l'],
    useLauncher: false,
    capabilities: { fork: false, resume: false, sessionIdBackfill: false, dangerMode: false, remoteSupport: false },
  },
  {
    id: 'claude',
    label: 'New Claude session',
    key: 'n',
    command: 'claude',
    defaultArgs: [],
    useLauncher: true,
    capabilities: { fork: true, resume: true, sessionIdBackfill: true, dangerMode: true, remoteSupport: true },
  },
  {
    id: 'cursor',
    label: 'New Cursor session',
    key: 'c',
    command: 'cursor',
    defaultArgs: [],
    useLauncher: false,
    capabilities: { fork: false, resume: false, sessionIdBackfill: false, dangerMode: false, remoteSupport: false },
  },
];

export function listProfiles(): LaunchProfile[] {
  return PROFILES;
}

export function getProfile(id: string): LaunchProfile | undefined {
  return PROFILES.find(p => p.id === id);
}

export function resolveCommand(profileId: string): { command: string; useLauncher: boolean } {
  const profile = getProfile(profileId);
  if (!profile) throw new Error(`Unknown launch profile: ${profileId}`);
  return { command: profile.command, useLauncher: profile.useLauncher };
}

export function buildCommandArgs(
  profileId: string,
  options: { isResume?: boolean; claudeSessionId?: string; dangerousSkipPermissions?: boolean },
): string[] {
  const profile = getProfile(profileId);
  if (!profile) throw new Error(`Unknown launch profile: ${profileId}`);

  const args = [...profile.defaultArgs];

  if (profile.capabilities.resume && options.isResume) {
    args.push('--resume');
    if (options.claudeSessionId) args.push(options.claudeSessionId);
  }

  if (profile.capabilities.dangerMode && options.dangerousSkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  return args;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/launch-profiles.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/launch-profiles.ts tests/launch-profiles.test.ts && git commit -m "feat: launch profile registry — shell, claude, cursor with capabilities"
```

---

## Task 2: Extend StoredSession with launchProfile

**Files:**
- Modify: `src/session-store.ts`

- [ ] **Step 1: Add `launchProfile` to `StoredSession` interface**

In `src/session-store.ts`, add to the `StoredSession` interface after the `forkSourceProject` field:

```typescript
  launchProfile?: string;           // profile id (shell, claude, cursor) — defaults to 'claude' for legacy sessions
```

- [ ] **Step 2: Run existing tests to verify nothing breaks**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All existing tests pass (field is optional, no logic change yet)

- [ ] **Step 3: Commit**

```bash
cd /srv/claude-proxy && git add src/session-store.ts && git commit -m "feat: add launchProfile field to StoredSession"
```

---

## Task 3: Update lobby with profile picker

**Files:**
- Modify: `src/lobby.ts`

- [ ] **Step 1: Import profiles and replace "New session" with profile items**

In `src/lobby.ts`, add import at the top:

```typescript
import { listProfiles } from './launch-profiles.js';
```

Replace the actions section in `buildSections()`:

```typescript
    const profileItems: MenuItem[] = listProfiles().map(p => ({
      label: p.label,
      key: p.key,
      action: `new:${p.id}`,
    }));

    sections.push({
      items: [
        ...profileItems,
        { label: 'Restart previous session', key: 'r', action: 'continue' },
        { label: 'Fork a session', key: 'f', action: 'fork' },
        { label: 'Export sessions', key: 'e', action: 'export' },
        { label: 'Quit', key: 'q', action: 'quit' },
      ],
    });
```

- [ ] **Step 2: Update handleInput to parse `new:profileId` actions**

In the `handleInput` method, after the existing `join:` parsing block, add parsing for `new:` prefix:

```typescript
      if (found.action.startsWith('new:')) {
        return { type: 'select', action: found.action };
      }
```

- [ ] **Step 3: Run build to check for type errors**

Run: `cd /srv/claude-proxy && npm run build`
Expected: Clean build (the `new:profileId` actions are strings, which `InputResult.action` already accepts)

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add src/lobby.ts && git commit -m "feat: lobby shows profile-specific new session items (terminal/claude/cursor)"
```

---

## Task 4: Wire lobby actions to profile-aware flow in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import `getProfile` and `buildCommandArgs`**

Add to imports in `src/index.ts`:

```typescript
import { getProfile, buildCommandArgs, resolveCommand } from './launch-profiles.js';
```

- [ ] **Step 2: Update `startNewSessionFlow` to accept `profileId`**

Change the signature of `startNewSessionFlow`:

```typescript
function startNewSessionFlow(client: Client, profileId: string = 'claude'): void {
```

Add `_launchProfile` to the `initialState` object inside the function:

```typescript
  const initialState: Record<string, any> = {
    _isAdmin: isAdmin(client.username),
    _hasRemotes: (config.remotes?.length ?? 0) > 0,
    _defaultUser: client.username,
    _remotes: config.remotes || [],
    _availableUsers: getClaudeUsers().filter(u => u !== client.username),
    _availableGroups: getClaudeGroups(),
    _launchProfile: profileId,
  };
```

- [ ] **Step 3: Update lobby dispatch to extract profileId from `new:X` actions**

In the `case 'select':` block where `result.action === 'new'` is handled, replace:

```typescript
          } else if (result.action === 'new') {
            console.log(`[lobby] ${client.username} starting new session flow`);
            startNewSessionFlow(client);
```

with:

```typescript
          } else if (result.action.startsWith('new:')) {
            const profileId = result.action.split(':')[1];
            console.log(`[lobby] ${client.username} starting new session flow (profile: ${profileId})`);
            startNewSessionFlow(client, profileId);
          } else if (result.action === 'new') {
            console.log(`[lobby] ${client.username} starting new session flow`);
            startNewSessionFlow(client, 'claude');
```

- [ ] **Step 4: Update `finalizeSessionFromResults` to use profile**

Replace the hard-coded `'claude'` command resolution with profile-based:

```typescript
function finalizeSessionFromResults(client: Client, results: Record<string, any>, isResume?: boolean): void {
  const access: Partial<SessionAccess> = {
    owner: client.username,
    hidden: results.hidden ?? false,
    public: results.public ?? true,
    allowedUsers: results.allowedUsers ?? [],
    allowedGroups: results.allowedGroups ?? [],
    passwordHash: results.password ? hashPassword(results.password) : null,
    viewOnly: results.viewOnly ?? false,
  };

  try {
    const profileId = results._launchProfile || 'claude';
    const { command } = resolveCommand(profileId);
    const commandArgs = buildCommandArgs(profileId, {
      isResume,
      claudeSessionId: results.claudeSessionId,
      dangerousSkipPermissions: results.dangerousSkipPermissions,
    });
    const runAs = results.runAsUser || client.username;
    const remote = results.remoteHost || undefined;
    const workDir = results.workingDir || undefined;

    console.log(`[create] ${client.username} creating "${results.name}" [${profileId}] as ${runAs} on ${remote || 'local'}`);
    const session = sessionManager.createSession(results.name, client, runAs, command, access, commandArgs, remote, workDir);

    if (workDir) dirScanner.addToHistory(workDir);

    const state = clientState.get(client.id);
    if (state) {
      state.mode = 'session';
      state.sessionId = session.id;
    }
    client.write('\x1b[2J\x1b[H');
  } catch (err: any) {
    client.write(`\r\nError: ${err.message}\r\n`);
    showLobby(client);
  }
}
```

- [ ] **Step 5: Update `renderSessionForm` title to show profile name**

In `renderSessionForm`, replace:

```typescript
  const title = entry.isFork ? 'Fork session' : entry.isResume ? 'Resume session' : 'New session';
```

with:

```typescript
  const profileId = entry.flow.getAccumulated()?._launchProfile;
  const profile = profileId ? getProfile(profileId) : undefined;
  const profileLabel = profile ? profile.label.replace('New ', '') : 'session';
  const title = entry.isFork ? 'Fork session' : entry.isResume ? `Resume ${profileLabel}` : `New ${profileLabel}`;
```

- [ ] **Step 6: Build and verify**

Run: `cd /srv/claude-proxy && npm run build`
Expected: Clean build

- [ ] **Step 7: Commit**

```bash
cd /srv/claude-proxy && git add src/index.ts && git commit -m "feat: wire lobby profile actions to session creation — command resolved from profile registry"
```

---

## Task 5: Gate YAML form fields by profile capability

**Files:**
- Modify: `src/session-form.yaml`
- Modify: `src/session-form.ts`
- Modify: `tests/session-form.test.ts`

- [ ] **Step 1: Write failing test for profile-gated fields**

Add to `tests/session-form.test.ts`:

```typescript
import { getProfile } from '../src/launch-profiles.js';

test('dangermode field hidden for shell profile', () => {
  const mockClient = { username: 'root', id: 'test', transport: 'ssh' as const, termSize: { cols: 80, rows: 24 }, write: () => {}, lastKeystroke: 0 };
  const steps = buildSessionFormSteps('create', mockClient, {});
  const dangerStep = steps.find(s => s.id === 'dangermode');
  expect(dangerStep).toBeDefined();

  // With claude profile, condition should pass for admin
  const claudeAcc = { _isAdmin: true, _launchProfile: 'claude' };
  expect(dangerStep!.condition?.(claudeAcc)).toBe(true);

  // With shell profile, condition should fail even for admin
  const shellAcc = { _isAdmin: true, _launchProfile: 'shell' };
  expect(dangerStep!.condition?.(shellAcc)).toBe(false);
});

test('claudeSessionId field hidden for shell profile', () => {
  const mockClient = { username: 'root', id: 'test', transport: 'ssh' as const, termSize: { cols: 80, rows: 24 }, write: () => {}, lastKeystroke: 0 };
  const steps = buildSessionFormSteps('edit', mockClient, {});
  const sessionIdStep = steps.find(s => s.id === 'claudeSessionId');
  expect(sessionIdStep).toBeDefined();

  const claudeAcc = { _launchProfile: 'claude' };
  expect(sessionIdStep!.condition?.(claudeAcc)).toBe(true);

  const shellAcc = { _launchProfile: 'shell' };
  expect(sessionIdStep!.condition?.(shellAcc)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /srv/claude-proxy && npx vitest run tests/session-form.test.ts`
Expected: FAIL — conditions not profile-aware yet

- [ ] **Step 3: Add profile-aware predicates to `session-form.ts`**

In `src/session-form.ts`, in the `PREDICATES` registry, add:

```typescript
  'claude-profile-only': (acc) => {
    const profileId = acc._launchProfile || 'claude';
    const profile = getProfile(profileId);
    return profile?.capabilities.dangerMode === true;
  },
  'has-session-id-backfill': (acc) => {
    const profileId = acc._launchProfile || 'claude';
    const profile = getProfile(profileId);
    return profile?.capabilities.sessionIdBackfill === true;
  },
```

Add the import at the top of `session-form.ts`:

```typescript
import { getProfile } from './launch-profiles.js';
```

- [ ] **Step 4: Update `session-form.yaml` — gate `dangermode` and `claudeSessionId`**

In `src/session-form.yaml`, change the `dangermode` field condition from `admin-only` to `claude-profile-only` (this predicate internally checks both admin status and profile):

Actually, `dangermode` needs both admin AND claude profile. Update the predicate instead:

```typescript
  'claude-profile-only': (acc) => {
    if (acc._isAdmin !== true) return false;
    const profileId = acc._launchProfile || 'claude';
    const profile = getProfile(profileId);
    return profile?.capabilities.dangerMode === true;
  },
```

In `session-form.yaml`, change `dangermode` condition:

```yaml
  - id: dangermode
    label: Skip permissions?
    widget: yesno
    default: false
    condition: claude-profile-only
```

Change `claudeSessionId` condition:

```yaml
  - id: claudeSessionId
    label: Claude session ID
    widget: text
    condition: has-session-id-backfill
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/session-form.test.ts`
Expected: All tests pass including new profile-gated tests

- [ ] **Step 6: Commit**

```bash
cd /srv/claude-proxy && git add src/session-form.ts src/session-form.yaml tests/session-form.test.ts && git commit -m "feat: form fields gated by launch profile capabilities"
```

---

## Task 6: Gate session-ID backfill by profile

**Files:**
- Modify: `src/session-manager.ts`

- [ ] **Step 1: Add `launchProfile` parameter to `createSession`**

In `src/session-manager.ts`, update the `createSession` signature to accept an optional `launchProfile`:

```typescript
  createSession(
    name: string,
    creator: Client,
    runAsUser?: string,
    command: string = 'claude',
    access?: Partial<SessionAccess>,
    commandArgs: string[] = [],
    remoteHost?: string,
    workingDir?: string,
    launchProfile?: string,
  ): Session {
```

- [ ] **Step 2: Persist `launchProfile` in session metadata**

In the `saveSessionMeta` call inside `createSession`, add `launchProfile`:

```typescript
    saveSessionMeta(tmuxId, {
      tmuxId,
      name,
      runAsUser: user,
      workingDir,
      remoteHost,
      socketPath,
      createdAt: session.createdAt.toISOString(),
      access: sessionAccess,
      launchProfile,
    });
```

- [ ] **Step 3: Gate backfill by profile capability**

Replace the unconditional `scheduleClaudeIdBackfill` call with a capability check:

```typescript
    // Backfill session ID only for profiles that support it
    const profile = launchProfile ? getProfile(launchProfile) : undefined;
    if (!profile || profile.capabilities.sessionIdBackfill) {
      this.scheduleClaudeIdBackfill(tmuxId, socketPath, user);
    }
```

Add import at top of `session-manager.ts`:

```typescript
import { getProfile } from './launch-profiles.js';
```

- [ ] **Step 4: Update callers to pass `launchProfile`**

In `src/index.ts`, update `finalizeSessionFromResults` — the `createSession` call now passes profile:

```typescript
    const session = sessionManager.createSession(results.name, client, runAs, command, access, commandArgs, remote, workDir, profileId);
```

In `src/api-server.ts`, update `POST /api/sessions`:

```typescript
        const launchProfile = body.launchProfile || 'claude';
        const session = sessionManager.createSession(
          body.name, fakeClient, body.runAsUser, 'claude', access, args, undefined, body.workingDir, launchProfile,
        );
```

- [ ] **Step 5: Build and run full test suite**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: Clean build, all tests pass

- [ ] **Step 6: Commit**

```bash
cd /srv/claude-proxy && git add src/session-manager.ts src/index.ts src/api-server.ts && git commit -m "feat: persist launchProfile in session metadata; gate backfill by capability"
```

---

## Task 7: API accepts launchProfile and resolves command

**Files:**
- Modify: `src/api-server.ts`

- [ ] **Step 1: Update `POST /api/sessions` to resolve command from profile**

In `src/api-server.ts`, add import:

```typescript
import { getProfile, resolveCommand, buildCommandArgs } from './launch-profiles.js';
```

Replace the hard-coded `'claude'` in `POST /api/sessions`:

```typescript
        const launchProfile = body.launchProfile || 'claude';
        const profile = getProfile(launchProfile);
        if (!profile) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unknown launch profile: ${launchProfile}` }));
          return;
        }

        const { command } = resolveCommand(launchProfile);
        const commandArgs = buildCommandArgs(launchProfile, {
          dangerousSkipPermissions: body.dangerousSkipPermissions,
        });

        const session = sessionManager.createSession(
          body.name, fakeClient, body.runAsUser, command, access, commandArgs, undefined, body.workingDir, launchProfile,
        );
```

- [ ] **Step 2: Update `POST .../restart` to use stored profile**

In the restart handler, after loading the dead session:

```typescript
        const launchProfile = deadSession.launchProfile || 'claude';
        const { command } = resolveCommand(launchProfile);
        const commandArgs = buildCommandArgs(launchProfile, {
          isResume: true,
          claudeSessionId: deadSession.claudeSessionId,
        });

        const session = sessionManager.createSession(
          settings.name ?? deadSession.name,
          fakeClient,
          deadSession.runAsUser,
          command,
          access,
          commandArgs,
          deadSession.remoteHost,
          deadSession.workingDir,
          launchProfile,
        );
```

- [ ] **Step 3: Build and run tests**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: Clean build, all tests pass

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add src/api-server.ts && git commit -m "feat: API resolves command from launchProfile — create and restart"
```

---

## Task 8: End-to-end manual verification

- [ ] **Step 1: Build and restart**

```bash
cd /srv/claude-proxy && npm run build && systemctl restart claude-proxy
```

- [ ] **Step 2: SSH and verify lobby**

```bash
ssh -p 3100 localhost
```

Expected: Lobby shows three items — "New terminal [t]", "New Claude session [n]", "New Cursor session [c]" — followed by Restart, Fork, Export, Quit.

- [ ] **Step 3: Create a terminal session**

Press `t`, enter a name (e.g. "test-shell"), fill form, submit.
Expected: Lands in a bash shell, not Claude. Session shows in lobby on reconnect.

- [ ] **Step 4: Create a Claude session**

Press `n`, enter a name, submit.
Expected: Claude starts (same as before). Session ID backfill runs (check logs).

- [ ] **Step 5: Verify API with profile**

```bash
curl -s -X POST http://127.0.0.1:3101/api/sessions -H 'Content-Type: application/json' \
  -d '{"name":"api-shell-test","launchProfile":"shell"}' | jq .
```

Expected: `{ "id": "cp-api-shell-test", "name": "api-shell-test" }`

- [ ] **Step 6: Verify stored metadata has launchProfile**

```bash
cat /srv/claude-proxy/data/sessions/cp-api-shell-test.json | jq .launchProfile
```

Expected: `"shell"`

- [ ] **Step 7: Verify no backfill log for shell session**

```bash
journalctl -u claude-proxy --no-pager -n 50 | grep backfill
```

Expected: No backfill log entry for shell session; backfill **does** appear for Claude sessions.

- [ ] **Step 8: Commit any fixes from verification**

```bash
cd /srv/claude-proxy && git add -A && git commit -m "fix: adjustments from launch-profile manual verification"
```

---

## Scope boundaries (not in this plan)

- **Remote launches for non-Claude profiles** — shell/cursor on `remoteHost` needs a new launcher strategy; tracked separately.
- **Cursor session-ID discovery** — sub-project per research v05 §5.
- **OAuth / web API auth wiring** — separate spec (`2026-04-03-oauth-web-api-wiring-spec.md`).
- **Fork gating in lobby** — fork is Claude-only via `claude-fork`; lobby "Fork" item could be hidden when no Claude sessions exist, but this is a UI refinement, not a blocker.
