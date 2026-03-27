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
 * List dead sessions — metadata exists but tmux session is gone
 */
export function listDeadSessions(): StoredSession[] {
  // execSync imported at top
  const stored = listStoredSessions();

  // Get running tmux sessions
  let running: Set<string>;
  try {
    const output = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", { encoding: 'utf-8' }).trim();
    running = new Set(output ? output.split('\n') : []);
  } catch {
    running = new Set();
  }

  return stored.filter(s => !running.has(s.tmuxId));
}

export type { StoredSession };
