// src/types.ts

export interface Config {
  port: number;
  host: string;
  auth: {
    authorized_keys: string;
  };
  sessions: {
    default_user: string;
    scrollback_bytes: number;
    max_sessions: number;
  };
  lobby: {
    motd: string;
  };
}

export interface Client {
  id: string;
  username: string;
  transport: 'ssh' | 'websocket';
  termSize: { cols: number; rows: number };
  write: (data: Buffer | string) => void;
  lastKeystroke: number;  // Date.now() timestamp
}

export interface Session {
  id: string;
  name: string;
  runAsUser: string;
  createdAt: Date;
  sizeOwner: string;          // client id
  clients: Map<string, Client>;
}

export interface Transport {
  onConnect(callback: (client: Client) => void): void;
  onData(client: Client, callback: (data: Buffer) => void): void;
  onResize(client: Client, callback: (size: { cols: number; rows: number }) => void): void;
  onDisconnect(client: Client, callback: () => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
