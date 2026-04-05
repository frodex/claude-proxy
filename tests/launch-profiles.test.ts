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
    expect(command).toBe('cursor-agent');
    expect(useLauncher).toBe(false);
  });

  test('buildCommandArgs for shell — no special args', () => {
    const args = buildCommandArgs('shell', { dangerousSkipPermissions: true });
    expect(args).toEqual([]);
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
