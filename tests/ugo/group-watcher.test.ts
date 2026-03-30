// tests/ugo/group-watcher.test.ts
import { test, expect, vi, beforeEach } from 'vitest';
import { GroupWatcher } from '../../src/ugo/group-watcher.js';
import type { Provisioner } from '../../src/auth/types.js';

let mockProvisioner: Provisioner;

beforeEach(() => {
  mockProvisioner = {
    createSystemAccount: vi.fn(),
    deleteSystemAccount: vi.fn(),
    installClaude: vi.fn(),
    addToGroup: vi.fn(),
    removeFromGroup: vi.fn(),
    createGroup: vi.fn(),
    deleteGroup: vi.fn(),
    getGroups: vi.fn(() => []),
    getGroupMembers: vi.fn(() => []),
    userExists: vi.fn(() => true),
    groupExists: vi.fn(() => true),
  };
});

test('checkAccess returns true when user is in session group', () => {
  (mockProvisioner.getGroups as any).mockReturnValue(['users', 'sess-myproject']);
  const watcher = new GroupWatcher(mockProvisioner);
  expect(watcher.checkAccess('greg', 'sess-myproject')).toBe(true);
});

test('checkAccess returns false when user is not in session group', () => {
  (mockProvisioner.getGroups as any).mockReturnValue(['users']);
  const watcher = new GroupWatcher(mockProvisioner);
  expect(watcher.checkAccess('greg', 'sess-myproject')).toBe(false);
});

test('evaluateSessions calls onRevoke for users who lost access', () => {
  (mockProvisioner.getGroups as any)
    .mockReturnValueOnce(['users'])
    .mockReturnValueOnce(['users', 'sess-myproject']);

  const watcher = new GroupWatcher(mockProvisioner);
  const onRevoke = vi.fn();

  const sessions = [
    {
      sessionName: 'myproject',
      sessionGroup: 'sess-myproject',
      owner: 'admin',
      connectedUsers: ['greg', 'frodex'],
    },
  ];

  watcher.evaluateSessions(sessions, onRevoke);

  expect(onRevoke).toHaveBeenCalledTimes(1);
  expect(onRevoke).toHaveBeenCalledWith('myproject', 'greg');
});

test('evaluateSessions never revokes the owner', () => {
  (mockProvisioner.getGroups as any).mockReturnValue([]);

  const watcher = new GroupWatcher(mockProvisioner);
  const onRevoke = vi.fn();

  const sessions = [
    {
      sessionName: 'myproject',
      sessionGroup: 'sess-myproject',
      owner: 'greg',
      connectedUsers: ['greg'],
    },
  ];

  watcher.evaluateSessions(sessions, onRevoke);
  expect(onRevoke).not.toHaveBeenCalled();
});
