// tests/auth/resolve-user.test.ts
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveUser } from '../../src/auth/resolve-user.js';
import { SQLiteUserStore } from '../../src/auth/user-store.js';
import type { Provisioner, SshSource, OAuthSource } from '../../src/auth/types.js';
import { rmSync } from 'fs';

const TEST_DB = '/tmp/claude-proxy-test-resolve.db';

let store: SQLiteUserStore;
let mockProvisioner: Provisioner;

beforeEach(() => {
  rmSync(TEST_DB, { force: true });
  store = new SQLiteUserStore(TEST_DB);
  mockProvisioner = {
    createSystemAccount: vi.fn(),
    deleteSystemAccount: vi.fn(),
    installClaude: vi.fn(),
    addToGroup: vi.fn(),
    removeFromGroup: vi.fn(),
    createGroup: vi.fn(),
    deleteGroup: vi.fn(),
    getGroups: vi.fn(() => ['users']),
    getGroupMembers: vi.fn(() => []),
    userExists: vi.fn(() => true),
    groupExists: vi.fn(() => true),
  };
});

afterEach(() => {
  store.close();
  rmSync(TEST_DB, { force: true });
});

test('SSH source resolves existing user from store', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: ['users'],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  const source: SshSource = { type: 'ssh', linuxUser: 'greg' };
  const result = resolveUser(source, store, mockProvisioner);

  expect(result.identity.linuxUser).toBe('greg');
  expect(result.isNew).toBe(false);
});

test('SSH source creates store entry for user not in store but on system', () => {
  (mockProvisioner.userExists as any).mockReturnValue(true);
  (mockProvisioner.getGroups as any).mockReturnValue(['users']);

  const source: SshSource = { type: 'ssh', linuxUser: 'existinguser' };
  const result = resolveUser(source, store, mockProvisioner);

  expect(result.identity.linuxUser).toBe('existinguser');
  expect(result.isNew).toBe(true);
  expect(store.findByLinuxUser('existinguser')).not.toBeNull();
});

test('SSH source throws for user not on system', () => {
  (mockProvisioner.userExists as any).mockReturnValue(false);

  const source: SshSource = { type: 'ssh', linuxUser: 'ghost' };
  expect(() => resolveUser(source, store, mockProvisioner)).toThrow();
});

test('OAuth source resolves user by provider link', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    email: 'greg@gmail.com',
    groups: ['users'],
    createdAt: new Date(),
    lastLogin: new Date(),
  });
  store.linkProvider('greg', 'google', 'g-123', 'greg@gmail.com');

  const source: OAuthSource = {
    type: 'oauth',
    provider: 'google',
    providerId: 'g-123',
    email: 'greg@gmail.com',
    displayName: 'Greg',
  };
  const result = resolveUser(source, store, mockProvisioner);

  expect(result.identity.linuxUser).toBe('greg');
  expect(result.isNew).toBe(false);
});

test('OAuth source matches by email when no provider link', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    email: 'greg@gmail.com',
    groups: ['users'],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  const source: OAuthSource = {
    type: 'oauth',
    provider: 'github',
    providerId: 'gh-789',
    email: 'greg@gmail.com',
    displayName: 'Greg GH',
  };
  const result = resolveUser(source, store, mockProvisioner);

  expect(result.identity.linuxUser).toBe('greg');
  expect(result.isNew).toBe(false);
  const links = store.getProviderLinks('greg');
  expect(links.find(l => l.provider === 'github')).toBeTruthy();
});

test('OAuth source provisions new account when no match', () => {
  (mockProvisioner.userExists as any).mockReturnValue(false);
  (mockProvisioner.getGroups as any).mockReturnValue(['users']);

  const source: OAuthSource = {
    type: 'oauth',
    provider: 'google',
    providerId: 'g-new',
    email: 'newperson@gmail.com',
    displayName: 'New Person',
  };
  const result = resolveUser(source, store, mockProvisioner);

  expect(result.isNew).toBe(true);
  expect(result.identity.linuxUser).toBe('newperson');
  expect(mockProvisioner.createSystemAccount).toHaveBeenCalledWith('newperson', 'New Person');
  expect(mockProvisioner.installClaude).toHaveBeenCalledWith('newperson');
  expect(store.findByLinuxUser('newperson')).not.toBeNull();
  expect(store.findByProvider('google', 'g-new')).not.toBeNull();
});

test('OAuth provisioning handles username collision', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg Original',
    groups: [],
    createdAt: new Date(),
    lastLogin: new Date(),
  });
  // greg is already in the store, so userExists is never called for it.
  // findAvailableUsername skips greg (found in store), then checks greg2:
  //   store.findByLinuxUser('greg2') → null, provisioner.userExists('greg2') → true (taken on system)
  // then checks greg3... but we want greg2 to be available, so:
  (mockProvisioner.userExists as any)
    .mockReturnValueOnce(false)  // greg2 doesn't exist on system → available
    .mockReturnValueOnce(true);  // after creation, greg2 exists (for getGroups context)
  (mockProvisioner.getGroups as any).mockReturnValue(['users']);

  const source: OAuthSource = {
    type: 'oauth',
    provider: 'google',
    providerId: 'g-dup',
    email: 'greg@otherdomain.com',
    displayName: 'Greg Other',
  };
  const result = resolveUser(source, store, mockProvisioner);

  expect(result.identity.linuxUser).toBe('greg2');
  expect(result.isNew).toBe(true);
});

test('OAuth updates lastLogin for returning user', () => {
  const oldDate = new Date('2026-01-01T00:00:00Z');
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: ['users'],
    createdAt: oldDate,
    lastLogin: oldDate,
  });
  store.linkProvider('greg', 'google', 'g-123');

  const source: OAuthSource = {
    type: 'oauth',
    provider: 'google',
    providerId: 'g-123',
    email: 'greg@gmail.com',
    displayName: 'Greg',
  };
  resolveUser(source, store, mockProvisioner);

  const updated = store.findByLinuxUser('greg');
  expect(updated!.lastLogin.getTime()).toBeGreaterThan(oldDate.getTime());
});
