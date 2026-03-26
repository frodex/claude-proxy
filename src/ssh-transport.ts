// src/ssh-transport.ts

import { Server, type Connection, type Session as SSHSession } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
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
  private server: Server;
  private options: SSHTransportOptions;
  private connectCallbacks: ConnectCallback[] = [];
  private dataCallbacks: Map<string, DataCallback> = new Map();
  private resizeCallbacks: Map<string, ResizeCallback> = new Map();
  private disconnectCallbacks: Map<string, DisconnectCallback> = new Map();
  private authorizedKeys: Buffer[] = [];

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
    const keyPath = this.options.authorizedKeysPath.replace('~', process.env.HOME ?? '/root');
    if (!existsSync(keyPath)) {
      console.warn(`Warning: authorized_keys not found at ${keyPath}`);
      return;
    }

    const content = readFileSync(keyPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split(' ');
        if (parts.length >= 2) {
          try {
            this.authorizedKeys.push(Buffer.from(parts[1], 'base64'));
          } catch {}
        }
      }
    }
  }

  private handleConnection(conn: Connection): void {
    let username = '';

    conn.on('authentication', (ctx) => {
      username = ctx.username;

      if (ctx.method === 'publickey') {
        const keyData = ctx.key.data;
        const isAuthorized = this.authorizedKeys.some(
          (ak) => ak.equals(keyData)
        );
        if (isAuthorized) {
          ctx.accept();
          return;
        }
      }

      // Accept all if no keys configured (dev mode)
      if (this.authorizedKeys.length === 0) {
        ctx.accept();
        return;
      }

      ctx.reject(['publickey']);
    });

    conn.on('ready', () => {
      conn.on('session', (accept) => {
        const session: SSHSession = accept();

        session.on('pty', (accept, reject, info) => {
          accept?.();

          const clientId = randomUUID();
          let client: Client;

          session.on('shell', (accept) => {
            const stream = accept();

            client = {
              id: clientId,
              username,
              transport: 'ssh',
              termSize: { cols: info.cols, rows: info.rows },
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
            accept?.();
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
