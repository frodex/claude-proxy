// src/session-store.ts

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import type { SessionAccess } from './types.js';

import { dirname } from 'path';

const STORE_DIR = join(dirname(new URL(import.meta.url).pathname), '..', 'data', 'sessions');

interface StoredSession {
  tmuxId: string;
  name: string;
  runAsUser: string;
  workingDir?: string;
  remoteHost?: string;
  socketPath?: string;
  createdAt: string;
  access: SessionAccess;
  claudeSessionId?: string;  // for resuming after tmux dies
}

export function ensureStoreDir(): void {
  mkdirSync(STORE_DIR, { recursive: true });
}

export function saveSessionMeta(tmuxId: string, meta: StoredSession): void {
  ensureStoreDir();
  const path = join(STORE_DIR, `${tmuxId}.json`);
  writeFileSync(path, JSON.stringify(meta, null, 2));
}

export function loadSessionMeta(tmuxId: string): StoredSession | null {
  const path = join(STORE_DIR, `${tmuxId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function deleteSessionMeta(tmuxId: string): void {
  const path = join(STORE_DIR, `${tmuxId}.json`);
  try { unlinkSync(path); } catch {}
}

export function listStoredSessions(): StoredSession[] {
  ensureStoreDir();
  const files = readdirSync(STORE_DIR).filter(f => f.endsWith('.json'));
  const sessions: StoredSession[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(STORE_DIR, file), 'utf-8'));
      sessions.push(data);
    } catch {}
  }
  return sessions;
}

/**
 * List tmux session names on a remote host (or locally if host is undefined)
 */
export function listTmuxSessionNames(remoteHost?: string): Set<string> {
  try {
    const cmd = remoteHost
      ? `ssh ${remoteHost} "tmux list-sessions -F '#{session_name}' 2>/dev/null"`
      : "tmux list-sessions -F '#{session_name}' 2>/dev/null";
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    return new Set(output ? output.split('\n') : []);
  } catch {
    return new Set();
  }
}

/**
 * List dead sessions — metadata exists but tmux session is gone
 */
export function listDeadSessions(): StoredSession[] {
  const stored = listStoredSessions();

  // Cache remote lookups by host to avoid repeated SSH calls
  const runningByHost: Map<string, Set<string>> = new Map();
  const getRunning = (host?: string): Set<string> => {
    const key = host ?? '__local__';
    if (!runningByHost.has(key)) {
      runningByHost.set(key, listTmuxSessionNames(host));
    }
    return runningByHost.get(key)!;
  };

  return stored.filter(s => !getRunning(s.remoteHost).has(s.tmuxId));
}

export type { StoredSession };
