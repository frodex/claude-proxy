// src/auth/user-store.ts
import Database from 'better-sqlite3-multiple-ciphers';
import type { UserIdentity, ProviderLink, UserStore } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  linux_user TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  groups_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_login TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_links (
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  linux_user TEXT NOT NULL REFERENCES users(linux_user),
  email TEXT,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_links_user ON provider_links(linux_user);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
`;

export class SQLiteUserStore implements UserStore {
  private db: InstanceType<typeof Database>;

  constructor(dbPath: string, encryptionKey?: string) {
    this.db = new Database(dbPath);
    if (encryptionKey) {
      this.db.pragma(`key='${encryptionKey}'`);
    }
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  findByLinuxUser(username: string): UserIdentity | null {
    const row = this.db.prepare('SELECT * FROM users WHERE linux_user = ?').get(username) as any;
    return row ? this.rowToIdentity(row) : null;
  }

  findByProvider(provider: string, providerId: string): UserIdentity | null {
    const link = this.db.prepare(
      'SELECT linux_user FROM provider_links WHERE provider = ? AND provider_id = ?'
    ).get(provider, providerId) as any;
    if (!link) return null;
    return this.findByLinuxUser(link.linux_user);
  }

  findByEmail(email: string): UserIdentity | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    return row ? this.rowToIdentity(row) : null;
  }

  createUser(identity: UserIdentity): void {
    this.db.prepare(
      'INSERT INTO users (linux_user, display_name, email, groups_json, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      identity.linuxUser,
      identity.displayName,
      identity.email ?? null,
      JSON.stringify(identity.groups),
      identity.createdAt.toISOString(),
      identity.lastLogin.toISOString(),
    );
  }

  updateLastLogin(linuxUser: string): void {
    this.db.prepare(
      'UPDATE users SET last_login = ? WHERE linux_user = ?'
    ).run(new Date().toISOString(), linuxUser);
  }

  linkProvider(linuxUser: string, provider: string, providerId: string, email?: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO provider_links (provider, provider_id, linux_user, email, linked_at) VALUES (?, ?, ?, ?, ?)'
    ).run(provider, providerId, linuxUser, email ?? null, new Date().toISOString());
  }

  getProviderLinks(linuxUser: string): ProviderLink[] {
    const rows = this.db.prepare(
      'SELECT * FROM provider_links WHERE linux_user = ?'
    ).all(linuxUser) as any[];
    return rows.map(row => ({
      provider: row.provider,
      providerId: row.provider_id,
      linuxUser: row.linux_user,
      email: row.email ?? undefined,
      linkedAt: new Date(row.linked_at),
    }));
  }

  listUsers(): UserIdentity[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY linux_user').all() as any[];
    return rows.map(row => this.rowToIdentity(row));
  }

  listByGroup(group: string): UserIdentity[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY linux_user').all() as any[];
    return rows
      .map(row => this.rowToIdentity(row))
      .filter(user => user.groups.includes(group));
  }

  close(): void {
    this.db.close();
  }

  private rowToIdentity(row: any): UserIdentity {
    return {
      linuxUser: row.linux_user,
      displayName: row.display_name,
      email: row.email ?? undefined,
      groups: JSON.parse(row.groups_json),
      createdAt: new Date(row.created_at),
      lastLogin: new Date(row.last_login),
    };
  }
}
