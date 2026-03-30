// tests/auth/user-store.test.ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteUserStore } from '../../src/auth/user-store.js';
import { rmSync } from 'fs';

const TEST_DB = '/tmp/claude-proxy-test-users.db';

let store: SQLiteUserStore;

beforeEach(() => {
  rmSync(TEST_DB, { force: true });
  store = new SQLiteUserStore(TEST_DB, 'test-encryption-key');
});

afterEach(() => {
  store.close();
  rmSync(TEST_DB, { force: true });
});

test('createUser and findByLinuxUser', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    email: 'greg@example.com',
    groups: ['users', 'devteam'],
    createdAt: new Date('2026-03-29T00:00:00Z'),
    lastLogin: new Date('2026-03-29T00:00:00Z'),
  });

  const user = store.findByLinuxUser('greg');
  expect(user).not.toBeNull();
  expect(user!.linuxUser).toBe('greg');
  expect(user!.displayName).toBe('Greg');
  expect(user!.email).toBe('greg@example.com');
  expect(user!.groups).toEqual(['users', 'devteam']);
});

test('findByLinuxUser returns null for nonexistent user', () => {
  expect(store.findByLinuxUser('nobody')).toBeNull();
});

test('findByEmail returns matching user', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    email: 'greg@example.com',
    groups: [],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  const user = store.findByEmail('greg@example.com');
  expect(user).not.toBeNull();
  expect(user!.linuxUser).toBe('greg');
});

test('findByEmail returns null for no match', () => {
  expect(store.findByEmail('nobody@example.com')).toBeNull();
});

test('updateLastLogin changes the timestamp', () => {
  const oldDate = new Date('2026-01-01T00:00:00Z');
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: [],
    createdAt: oldDate,
    lastLogin: oldDate,
  });

  store.updateLastLogin('greg');
  const user = store.findByLinuxUser('greg');
  expect(user!.lastLogin.getTime()).toBeGreaterThan(oldDate.getTime());
});

test('linkProvider and findByProvider', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: [],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  store.linkProvider('greg', 'google', 'google-12345', 'greg@gmail.com');

  const user = store.findByProvider('google', 'google-12345');
  expect(user).not.toBeNull();
  expect(user!.linuxUser).toBe('greg');
});

test('findByProvider returns null for unlinked provider', () => {
  expect(store.findByProvider('google', 'unknown-id')).toBeNull();
});

test('getProviderLinks returns all links for a user', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: [],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  store.linkProvider('greg', 'google', 'g-123', 'greg@gmail.com');
  store.linkProvider('greg', 'github', 'gh-456', 'greg@github.com');

  const links = store.getProviderLinks('greg');
  expect(links).toHaveLength(2);
  expect(links.map(l => l.provider).sort()).toEqual(['github', 'google']);
});

test('listUsers returns all users', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: [],
    createdAt: new Date(),
    lastLogin: new Date(),
  });
  store.createUser({
    linuxUser: 'frodex',
    displayName: 'Frodex',
    groups: [],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  const users = store.listUsers();
  expect(users).toHaveLength(2);
  expect(users.map(u => u.linuxUser).sort()).toEqual(['frodex', 'greg']);
});

test('listByGroup returns users in a specific group', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: ['devteam', 'users'],
    createdAt: new Date(),
    lastLogin: new Date(),
  });
  store.createUser({
    linuxUser: 'frodex',
    displayName: 'Frodex',
    groups: ['users'],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  const devteam = store.listByGroup('devteam');
  expect(devteam).toHaveLength(1);
  expect(devteam[0].linuxUser).toBe('greg');

  const users = store.listByGroup('users');
  expect(users).toHaveLength(2);
});

test('groups are stored and retrieved correctly', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: ['users', 'admins', 'devteam'],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  const user = store.findByLinuxUser('greg');
  expect(user!.groups).toEqual(['users', 'admins', 'devteam']);
});
