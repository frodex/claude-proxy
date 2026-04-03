// tests/auth/provisioner.test.ts
import { test, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { LinuxProvisioner } from '../../src/auth/provisioner.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExec = vi.mocked(execFileSync);

let provisioner: LinuxProvisioner;

beforeEach(() => {
  vi.clearAllMocks();
  provisioner = new LinuxProvisioner();
});

test('createSystemAccount runs useradd with correct args', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.createSystemAccount('newuser', 'New User');

  expect(mockExec).toHaveBeenCalledWith(
    'useradd',
    ['-m', '-c', 'New User', '-s', '/bin/bash', 'newuser'],
    expect.any(Object),
  );
});

test('deleteSystemAccount runs userdel', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.deleteSystemAccount('olduser');

  expect(mockExec).toHaveBeenCalledWith(
    'userdel',
    ['-r', 'olduser'],
    expect.any(Object),
  );
});

test('addToGroup runs usermod -aG with cp- prefix', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.addToGroup('greg', 'devteam');

  expect(mockExec).toHaveBeenCalledWith(
    'usermod',
    ['-aG', 'cp-devteam', 'greg'],
    expect.any(Object),
  );
});

test('removeFromGroup runs gpasswd -d with cp- prefix', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.removeFromGroup('greg', 'devteam');

  expect(mockExec).toHaveBeenCalledWith(
    'gpasswd',
    ['-d', 'greg', 'cp-devteam'],
    expect.any(Object),
  );
});

test('createGroup runs groupadd with cp- prefix', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.createGroup('devteam');

  expect(mockExec).toHaveBeenCalledWith(
    'groupadd',
    ['cp-devteam'],
    expect.any(Object),
  );
});

test('deleteGroup runs groupdel with cp- prefix', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.deleteGroup('devteam');

  expect(mockExec).toHaveBeenCalledWith(
    'groupdel',
    ['cp-devteam'],
    expect.any(Object),
  );
});

test('getGroups parses id -nG output and strips cp- prefix', () => {
  mockExec.mockReturnValue('greg cp-users cp-devteam docker\n' as any);

  const groups = provisioner.getGroups('greg');
  expect(groups).toContain('users');
  expect(groups).toContain('devteam');
  expect(groups).not.toContain('greg');
  expect(groups).not.toContain('docker');
});

test('getGroupMembers parses getent group output', () => {
  mockExec.mockReturnValue('cp-devteam:x:1001:greg,frodex\n' as any);

  const members = provisioner.getGroupMembers('devteam');
  expect(members).toEqual(['greg', 'frodex']);
});

test('userExists returns true when getent succeeds', () => {
  mockExec.mockReturnValue('greg:x:1000:1000::/home/greg:/bin/bash\n' as any);
  expect(provisioner.userExists('greg')).toBe(true);
});

test('userExists returns false when getent fails', () => {
  mockExec.mockImplementation(() => { throw new Error('exit code 2'); });
  expect(provisioner.userExists('nobody')).toBe(false);
});

test('groupExists returns true when getent succeeds', () => {
  mockExec.mockReturnValue('cp-devteam:x:1001:\n' as any);
  expect(provisioner.groupExists('devteam')).toBe(true);
});

test('groupExists returns false when getent fails', () => {
  mockExec.mockImplementation(() => { throw new Error('exit code 2'); });
  expect(provisioner.groupExists('nobody')).toBe(false);
});

test('installClaude runs curl installer as the target user', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.installClaude('newuser');

  expect(mockExec).toHaveBeenCalledWith(
    'su',
    ['-', 'newuser', '-c', 'curl -sL https://claude.ai/install.sh | bash'],
    expect.objectContaining({ timeout: 120000 }),
  );
});
