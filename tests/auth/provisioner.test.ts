// tests/auth/provisioner.test.ts
import { test, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { LinuxProvisioner } from '../../src/auth/provisioner.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockExec = vi.mocked(execSync);

let provisioner: LinuxProvisioner;

beforeEach(() => {
  vi.clearAllMocks();
  provisioner = new LinuxProvisioner();
});

test('createSystemAccount runs useradd with correct args', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.createSystemAccount('newuser', 'New User');

  expect(mockExec).toHaveBeenCalledWith(
    expect.stringContaining('useradd'),
    expect.any(Object),
  );
  const cmd = mockExec.mock.calls[0][0] as string;
  expect(cmd).toContain('newuser');
  expect(cmd).toContain('New User');
});

test('deleteSystemAccount runs userdel', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.deleteSystemAccount('olduser');

  const cmd = mockExec.mock.calls[0][0] as string;
  expect(cmd).toContain('userdel');
  expect(cmd).toContain('olduser');
});

test('addToGroup runs usermod -aG with cp- prefix', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.addToGroup('greg', 'devteam');

  const cmd = mockExec.mock.calls[0][0] as string;
  expect(cmd).toContain('usermod');
  expect(cmd).toContain('-aG');
  expect(cmd).toContain('cp-devteam');
  expect(cmd).toContain('greg');
});

test('removeFromGroup runs gpasswd -d with cp- prefix', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.removeFromGroup('greg', 'devteam');

  const cmd = mockExec.mock.calls[0][0] as string;
  expect(cmd).toContain('gpasswd');
  expect(cmd).toContain('-d');
  expect(cmd).toContain('greg');
  expect(cmd).toContain('cp-devteam');
});

test('createGroup runs groupadd with cp- prefix', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.createGroup('devteam');

  const cmd = mockExec.mock.calls[0][0] as string;
  expect(cmd).toContain('groupadd');
  expect(cmd).toContain('cp-devteam');
});

test('deleteGroup runs groupdel with cp- prefix', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.deleteGroup('devteam');

  const cmd = mockExec.mock.calls[0][0] as string;
  expect(cmd).toContain('groupdel');
  expect(cmd).toContain('cp-devteam');
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

  const cmd = mockExec.mock.calls[0][0] as string;
  expect(cmd).toContain('su');
  expect(cmd).toContain('newuser');
  expect(cmd).toContain('curl');
  expect(cmd).toContain('claude.ai/install.sh');
});
