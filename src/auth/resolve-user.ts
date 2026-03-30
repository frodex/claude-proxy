// src/auth/resolve-user.ts
import type { AuthSource, SshSource, OAuthSource, ResolveResult, UserStore, Provisioner } from './types.js';

function emailToUsername(email: string): string {
  return email.split('@')[0].replace(/[^a-z0-9_-]/gi, '').toLowerCase();
}

function findAvailableUsername(base: string, store: UserStore, provisioner: Provisioner): string {
  if (!store.findByLinuxUser(base) && !provisioner.userExists(base)) {
    return base;
  }
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}${i}`;
    if (!store.findByLinuxUser(candidate) && !provisioner.userExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Cannot find available username for base "${base}"`);
}

function resolveSsh(source: SshSource, store: UserStore, provisioner: Provisioner): ResolveResult {
  const existing = store.findByLinuxUser(source.linuxUser);
  if (existing) {
    store.updateLastLogin(source.linuxUser);
    return { identity: { ...existing, lastLogin: new Date() }, isNew: false };
  }

  if (!provisioner.userExists(source.linuxUser)) {
    throw new Error(`System user "${source.linuxUser}" does not exist`);
  }

  const groups = provisioner.getGroups(source.linuxUser);
  const now = new Date();
  const identity = {
    linuxUser: source.linuxUser,
    displayName: source.linuxUser,
    groups,
    createdAt: now,
    lastLogin: now,
  };
  store.createUser(identity);
  return { identity, isNew: true };
}

function resolveOAuth(source: OAuthSource, store: UserStore, provisioner: Provisioner): ResolveResult {
  // 1. Check by provider link
  const byProvider = store.findByProvider(source.provider, source.providerId);
  if (byProvider) {
    store.updateLastLogin(byProvider.linuxUser);
    return { identity: { ...byProvider, lastLogin: new Date() }, isNew: false };
  }

  // 2. Check by email match
  const byEmail = store.findByEmail(source.email);
  if (byEmail) {
    store.linkProvider(byEmail.linuxUser, source.provider, source.providerId, source.email);
    store.updateLastLogin(byEmail.linuxUser);
    return { identity: { ...byEmail, lastLogin: new Date() }, isNew: false };
  }

  // 3. Provision new account
  const baseUsername = emailToUsername(source.email);
  const username = findAvailableUsername(baseUsername, store, provisioner);

  provisioner.createSystemAccount(username, source.displayName);
  provisioner.installClaude(username);

  const groups = provisioner.getGroups(username);
  const now = new Date();
  const identity = {
    linuxUser: username,
    displayName: source.displayName,
    email: source.email,
    groups,
    createdAt: now,
    lastLogin: now,
  };
  store.createUser(identity);
  store.linkProvider(username, source.provider, source.providerId, source.email);

  return { identity, isNew: true };
}

export function resolveUser(
  source: AuthSource,
  store: UserStore,
  provisioner: Provisioner,
): ResolveResult {
  if (source.type === 'ssh') {
    return resolveSsh(source, store, provisioner);
  }
  return resolveOAuth(source, store, provisioner);
}
