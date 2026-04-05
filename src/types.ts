// src/types.ts

export interface Config {
  port: number;
  host: string;
  auth: {
    authorized_keys: string;
    providers?: {
      google?: { client_id: string; client_secret: string };
      microsoft?: { client_id: string; client_secret: string; tenant?: string };
      github?: { client_id: string; client_secret: string };
    };
    session?: {
      secret: string;
      max_age?: number;
    };
    auto_provision?: boolean;
    default_groups?: string[];
  };
  sessions: {
    default_user: string;
    scrollback_bytes: number;
    max_sessions: number;
  };
  lobby: {
    motd: string;
  };
  remotes?: Array<{
    name: string;
    host: string;
  }>;
  api?: {
    port?: number;
    host?: string;
    socket?: string;
    socket_mode?: number;
    socket_group?: string;
    public_base_url?: string;
    cors_origin?: string;
    auth?: {
      required?: boolean;
    };
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

export interface SessionAccess {
  owner: string;              // username who created the session
  hidden: boolean;            // only owner sees it in lobby
  public: boolean;            // anyone can join
  allowedUsers: string[];     // usernames (when not public)
  allowedGroups: string[];    // cp- group names without prefix (when not public)
  passwordHash: string | null; // hash, null = no password
  viewOnly: boolean;           // only owner can type, others watch
  viewOnlyAllowScroll: boolean; // allow non-owners to scroll in viewOnly mode (default: true)
  viewOnlyAllowResize: boolean; // allow non-owners to resize in viewOnly mode (default: true)
  admins: string[];            // per-session admins who can edit settings
}

export interface Session {
  id: string;
  name: string;
  runAsUser: string;
  workingDir?: string;
  remoteHost?: string;
  socketPath?: string;
  createdAt: Date;
  sizeOwner: string;          // client id
  clients: Map<string, Client>;
  access: SessionAccess;
}

export interface Transport {
  onConnect(callback: (client: Client) => void): void;
  onData(client: Client, callback: (data: Buffer) => void): void;
  onResize(client: Client, callback: (size: { cols: number; rows: number }) => void): void;
  onDisconnect(client: Client, callback: () => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
