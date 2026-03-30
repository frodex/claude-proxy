// tests/ugo/socket-manager.test.ts
import { test, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { readdirSync } from 'fs';
import { SocketManager } from '../../src/ugo/socket-manager.js';
import type { Provisioner } from '../../src/auth/types.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
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

const mockExec = vi.mocked(execSync);

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

  const calls = mockExec.mock.calls.map(c => c[0] as string);
  const tmuxCall = calls.find(c => c.includes('tmux') && c.includes('-S'));
  expect(tmuxCall).toBeTruthy();
  expect(tmuxCall).toContain('/tmp/test-sockets/cp-myproject.sock');
  expect(tmuxCall).toContain('su - greg');
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

  const calls = mockExec.mock.calls.map(c => c[0] as string);
  const accessCall = calls.find(c => c.includes('server-access'));
  expect(accessCall).toBeTruthy();
  expect(accessCall).toContain('-a frodex');
  expect(accessCall).toContain('-w');
});

test('grantAccess calls server-access -a with read-only', () => {
  mockExec.mockReturnValue('' as any);
  manager.grantAccess('myproject', 'greg', 'viewer', 'read');

  const calls = mockExec.mock.calls.map(c => c[0] as string);
  const accessCall = calls.find(c => c.includes('server-access'));
  expect(accessCall).toBeTruthy();
  expect(accessCall).toContain('-a viewer');
  expect(accessCall).toContain('-r');
});

test('revokeAccess calls server-access -d', () => {
  mockExec.mockReturnValue('' as any);
  manager.revokeAccess('myproject', 'greg', 'frodex');

  const calls = mockExec.mock.calls.map(c => c[0] as string);
  expect(calls.some(c => c.includes('server-access') && c.includes('-d frodex'))).toBe(true);
});

test('destroySessionSocket kills tmux and cleans up', () => {
  mockExec.mockReturnValue('' as any);
  manager.destroySessionSocket('myproject', 'greg');

  const calls = mockExec.mock.calls.map(c => c[0] as string);
  expect(calls.some(c => c.includes('kill-server') || c.includes('kill-session'))).toBe(true);
});

test('discoverSockets scans directory for alive sessions', () => {
  vi.mocked(readdirSync).mockReturnValue(['cp-proj1.sock', 'cp-proj2.sock', 'other.txt'] as any);
  mockExec
    .mockReturnValueOnce('cp-proj1: 1 windows\n' as any)
    .mockImplementationOnce(() => { throw new Error('no server'); });

  const alive = manager.discoverSockets();
  expect(alive).toEqual(['/tmp/test-sockets/cp-proj1.sock']);
});
