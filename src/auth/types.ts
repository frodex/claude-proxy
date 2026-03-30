// src/auth/types.ts

export interface UserIdentity {
  linuxUser: string;
  displayName: string;
  email?: string;
  groups: string[];
  createdAt: Date;
  lastLogin: Date;
}

export interface ProviderLink {
  provider: string;
  providerId: string;
  linuxUser: string;
  email?: string;
  linkedAt: Date;
}

export interface SshSource {
  type: 'ssh';
  linuxUser: string;
}

export interface OAuthSource {
  type: 'oauth';
  provider: string;
  providerId: string;
  email: string;
  displayName: string;
}

export type AuthSource = SshSource | OAuthSource;

export interface ResolveResult {
  identity: UserIdentity;
  isNew: boolean;
}

export interface UserStore {
  findByLinuxUser(username: string): UserIdentity | null;
  findByProvider(provider: string, providerId: string): UserIdentity | null;
  findByEmail(email: string): UserIdentity | null;

  createUser(identity: UserIdentity): void;
  updateLastLogin(linuxUser: string): void;
  linkProvider(linuxUser: string, provider: string, providerId: string, email?: string): void;
  getProviderLinks(linuxUser: string): ProviderLink[];

  listUsers(): UserIdentity[];
  listByGroup(group: string): UserIdentity[];

  close(): void;
}

export interface Provisioner {
  createSystemAccount(username: string, displayName: string): void;
  deleteSystemAccount(username: string): void;
  installClaude(username: string): void;

  addToGroup(username: string, group: string): void;
  removeFromGroup(username: string, group: string): void;

  createGroup(group: string): void;
  deleteGroup(group: string): void;

  getGroups(username: string): string[];
  getGroupMembers(group: string): string[];

  userExists(username: string): boolean;
  groupExists(group: string): boolean;
}
