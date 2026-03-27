// src/ssh-transport.ts

import ssh2 from 'ssh2';
const { Server } = ssh2;
type Connection = ssh2.Connection;
type SSHSession = ssh2.Session;
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import type { Transport, Client, Config } from './types.js';

interface SSHTransportOptions {
  port: number;
  host: string;
  hostKeyPath: string;
  authorizedKeysPath: string;
}

type ConnectCallback = (client: Client) => void;
type DataCallback = (data: Buffer) => void;
type ResizeCallback = (size: { cols: number; rows: number }) => void;
type DisconnectCallback = () => void;

export class SSHTransport implements Transport {
  private server: InstanceType<typeof Server>;
  private options: SSHTransportOptions;
  private connectCallbacks: ConnectCallback[] = [];
  private dataCallbacks: Map<string, DataCallback> = new Map();
  private resizeCallbacks: Map<string, ResizeCallback> = new Map();
  private disconnectCallbacks: Map<string, DisconnectCallback> = new Map();
  private authorizedKeys: Array<{ username: string; keyData: Buffer }> = [];

  constructor(options: SSHTransportOptions) {
    this.options = options;
    this.loadAuthorizedKeys();

    const hostKeyPath = resolve(options.hostKeyPath, 'ssh_host_ed25519_key');
    const hostKey = readFileSync(hostKeyPath);

    this.server = new Server({
      hostKeys: [hostKey],
    }, (conn: Connection) => {
      this.handleConnection(conn);
    });
  }

  private loadAuthorizedKeys(): void {
    // Load global authorized_keys (from config)
    const keyPath = this.options.authorizedKeysPath.replace('~', process.env.HOME ?? '/root');
    if (existsSync(keyPath)) {
      this.loadKeysFromFile(keyPath, '__global__');
    }
  }

  private loadKeysFromFile(path: string, username: string): void {
    if (!existsSync(path)) return;

    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split(' ');
        if (parts.length >= 2) {
          try {
            const keyData = Buffer.from(parts[1], 'base64');
            this.authorizedKeys.push({ username, keyData });
          } catch {}
        }
      }
    }
  }

  private getUserHome(username: string): string | null {
    try {
      const result = execSync(`getent passwd ${username}`, { encoding: 'utf-8' }).trim();
      const parts = result.split(':');
      return parts[5] ?? null;
    } catch {
      return null;
    }
  }

  private isKeyAuthorizedForUser(username: string, keyData: Buffer): boolean {
    // Check global keys first
    const globalMatch = this.authorizedKeys.some(
      (ak) => ak.username === '__global__' && ak.keyData.equals(keyData)
    );
    if (globalMatch) return true;

    // Check user's own authorized_keys
    const home = this.getUserHome(username);
    if (!home) return false;

    const userKeyPath = resolve(home, '.ssh', 'authorized_keys');
    if (!existsSync(userKeyPath)) return false;

    const content = readFileSync(userKeyPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split(' ');
        if (parts.length >= 2) {
          try {
            const ak = Buffer.from(parts[1], 'base64');
            if (ak.equals(keyData)) return true;
          } catch {}
        }
      }
    }

    return false;
  }

  private handleConnection(conn: Connection): void {
    let username = '';

    conn.on('authentication', (ctx) => {
      username = ctx.username;

      if (ctx.method === 'publickey') {
        const keyData = ctx.key.data;
        if (this.isKeyAuthorizedForUser(ctx.username, keyData)) {
          console.log(`[auth] ${ctx.username}: pubkey accepted`);
          ctx.accept();
          return;
        }
        console.log(`[auth] ${ctx.username}: pubkey rejected`);
      }

      if (ctx.method === 'none') {
        // SSH protocol sends 'none' first to discover available methods
        ctx.reject(['publickey']);
        return;
      }

      // Reject everything else — pubkey only
      console.log(`[auth] ${ctx.username}: method '${ctx.method}' rejected`);
      ctx.reject(['publickey']);
    });

    conn.on('ready', () => {
      conn.on('session', (accept) => {
        const session: SSHSession = accept();

        session.on('pty', (accept, reject, info) => {
          accept();

          const clientId = randomUUID();
          let client: Client;
          // Default to 80x24 if terminal reports 0x0
          const cols = info.cols || 80;
          const rows = info.rows || 24;

          session.on('shell', (accept) => {
            const stream = accept();

            client = {
              id: clientId,
              username,
              transport: 'ssh',
              termSize: { cols, rows },
              write: (data: Buffer | string) => {
                if (stream.writable) {
                  stream.write(data);
                }
              },
              lastKeystroke: Date.now(),
            };

            for (const cb of this.connectCallbacks) {
              cb(client);
            }

            stream.on('data', (data: Buffer) => {
              this.dataCallbacks.get(clientId)?.(data);
            });

            stream.on('close', () => {
              this.disconnectCallbacks.get(clientId)?.();
              this.dataCallbacks.delete(clientId);
              this.resizeCallbacks.delete(clientId);
              this.disconnectCallbacks.delete(clientId);
            });
          });

          session.on('window-change', (accept, reject, info) => {
            if (typeof accept === 'function') accept();
            // resize event received
            if (client) {
              client.termSize = { cols: info.cols, rows: info.rows };
              this.resizeCallbacks.get(clientId)?.({ cols: info.cols, rows: info.rows });
            }
          });
        });
      });
    });

    conn.on('error', (err) => {
      console.error('SSH connection error:', err.message);
    });
  }

  onConnect(callback: ConnectCallback): void {
    this.connectCallbacks.push(callback);
  }

  onData(client: Client, callback: DataCallback): void {
    this.dataCallbacks.set(client.id, callback);
  }

  onResize(client: Client, callback: ResizeCallback): void {
    this.resizeCallbacks.set(client.id, callback);
  }

  onDisconnect(client: Client, callback: DisconnectCallback): void {
    this.disconnectCallbacks.set(client.id, callback);
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.options.port, this.options.host, () => {
        console.log(`claude-proxy SSH server listening on ${this.options.host}:${this.options.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
