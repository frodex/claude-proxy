// tests/ugo/socket-manager.test.ts
import { test, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { readdirSync } from 'fs';
import { SocketManager } from '../../src/ugo/socket-manager.js';
import type { Provisioner } from '../../src/auth/types.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    chownSync: vi.fn(),
    chmodSync: vi.fn(),
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ uid: 1000, gid: 1000 })),
  };
});

vi.mock('../../src/auth/provisioner.js', () => ({
  validateUsername: vi.fn(),
}));

const mockExec = vi.mocked(execFileSync);

let mockProvisioner: Provisioner;
let manager: SocketManager;

beforeEach(() => {
  vi.clearAllMocks();
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
  manager = new SocketManager('/tmp/test-sockets', mockProvisioner);
});

test('getSocketPath returns correct path', () => {
  expect(manager.getSocketPath('myproject')).toBe('/tmp/test-sockets/cp-myproject.sock');
});

test('createSessionSocket calls tmux with -S flag', () => {
  mockExec.mockReturnValue('' as any);
  manager.createSessionSocket('myproject', 'greg', { cols: 80, rows: 24 }, 'private');

  const suCalls = mockExec.mock.calls.filter(c => c[0] === 'su');
  const tmuxCall = suCalls.find(c => {
    const args = c[1] as string[];
    return args.some(a => a.includes('tmux') && a.includes('-S'));
  });
  expect(tmuxCall).toBeTruthy();
  const cmdArg = (tmuxCall![1] as string[]).find(a => a.includes('tmux'));
  expect(cmdArg).toContain('/tmp/test-sockets/cp-myproject.sock');
  expect(tmuxCall![1]).toContain('greg');
});

test('createSessionSocket creates session group for shared mode', () => {
  mockExec.mockReturnValue('' as any);
  (mockProvisioner.groupExists as any).mockReturnValue(false);
  manager.createSessionSocket('teamwork', 'greg', { cols: 80, rows: 24 }, 'shared');

  expect(mockProvisioner.createGroup).toHaveBeenCalledWith('sess-teamwork');
  expect(mockProvisioner.addToGroup).toHaveBeenCalledWith('greg', 'sess-teamwork');
});

test('createSessionSocket does not create group for private mode', () => {
  mockExec.mockReturnValue('' as any);
  manager.createSessionSocket('private', 'greg', { cols: 80, rows: 24 }, 'private');

  expect(mockProvisioner.createGroup).not.toHaveBeenCalled();
});

test('grantAccess calls server-access -a with write', () => {
  mockExec.mockReturnValue('' as any);
  manager.grantAccess('myproject', 'greg', 'frodex', 'write');

  const suCalls = mockExec.mock.calls.filter(c => c[0] === 'su');
  const accessCall = suCalls.find(c => {
    const args = c[1] as string[];
    return args.some(a => typeof a === 'string' && a.includes('server-access'));
  });
  expect(accessCall).toBeTruthy();
  const cmdArg = (accessCall![1] as string[]).find(a => a.includes('server-access'))!;
  expect(cmdArg).toContain('-a frodex');
  expect(cmdArg).toContain('-w');
});

test('grantAccess calls server-access -a with read-only', () => {
  mockExec.mockReturnValue('' as any);
  manager.grantAccess('myproject', 'greg', 'viewer', 'read');

  const suCalls = mockExec.mock.calls.filter(c => c[0] === 'su');
  const accessCall = suCalls.find(c => {
    const args = c[1] as string[];
    return args.some(a => typeof a === 'string' && a.includes('server-access'));
  });
  expect(accessCall).toBeTruthy();
  const cmdArg = (accessCall![1] as string[]).find(a => a.includes('server-access'))!;
  expect(cmdArg).toContain('-a viewer');
  expect(cmdArg).toContain('-r');
});

test('revokeAccess calls server-access -d', () => {
  mockExec.mockReturnValue('' as any);
  manager.revokeAccess('myproject', 'greg', 'frodex');

  const suCalls = mockExec.mock.calls.filter(c => c[0] === 'su');
  expect(suCalls.some(c => {
    const args = c[1] as string[];
    return args.some(a => typeof a === 'string' && a.includes('server-access') && a.includes('-d frodex'));
  })).toBe(true);
});

test('destroySessionSocket kills tmux and cleans up', () => {
  mockExec.mockReturnValue('' as any);
  manager.destroySessionSocket('myproject', 'greg');

  const suCalls = mockExec.mock.calls.filter(c => c[0] === 'su');
  expect(suCalls.some(c => {
    const args = c[1] as string[];
    return args.some(a => typeof a === 'string' && (a.includes('kill-server') || a.includes('kill-session')));
  })).toBe(true);
});

test('discoverSockets scans directory for alive sessions', () => {
  vi.mocked(readdirSync).mockReturnValue(['cp-proj1.sock', 'cp-proj2.sock', 'other.txt'] as any);
  mockExec
    .mockReturnValueOnce('cp-proj1: 1 windows\n' as any)
    .mockImplementationOnce(() => { throw new Error('no server'); });

  const alive = manager.discoverSockets();
  expect(alive).toEqual(['/tmp/test-sockets/cp-proj1.sock']);

  const tmuxCalls = mockExec.mock.calls.filter(c => c[0] === 'tmux');
  expect(tmuxCalls.length).toBe(2);
  expect(tmuxCalls[0][1]).toEqual(['-S', '/tmp/test-sockets/cp-proj1.sock', 'list-sessions']);
});
