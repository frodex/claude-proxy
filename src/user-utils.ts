// src/user-utils.ts

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { validateUsername } from './auth/provisioner.js';

/**
 * Get users who have a ~/.claude/ directory (have used Claude)
 */
export function getClaudeUsers(): string[] {
  try {
    const output = execFileSync('getent', ['passwd'], { encoding: 'utf-8' });
    return output.trim().split('\n')
      .map(line => {
        const parts = line.split(':');
        return { username: parts[0], home: parts[5] };
      })
      .filter(({ home }) => home && existsSync(`${home}/.claude`))
      .map(({ username }) => username);
  } catch {
    return [];
  }
}

/**
 * Get cp- prefixed groups (displayed without the prefix)
 */
export function getClaudeGroups(): Array<{ name: string; systemName: string; members: string[] }> {
  try {
    const output = execFileSync('getent', ['group'], { encoding: 'utf-8' });
    return output.trim().split('\n')
      .map(line => {
        const parts = line.split(':');
        return {
          systemName: parts[0],
          members: (parts[3] || '').split(',').filter(Boolean),
        };
      })
      .filter(g => g.systemName.startsWith('cp-'))
      .map(g => ({
        name: g.systemName.replace(/^cp-/, ''),
        systemName: g.systemName,
        members: g.members,
      }));
  } catch {
    return [];
  }
}

/**
 * Check if a user is a member of a cp- group (by display name, without prefix)
 */
export function isUserInGroup(username: string, groupDisplayName: string): boolean {
  const systemGroup = `cp-${groupDisplayName}`;
  try {
    validateUsername(username);
    const output = execFileSync('id', ['-nG', username], { encoding: 'utf-8' }).trim();
    return output.split(' ').includes(systemGroup);
  } catch {
    return false;
  }
}

/**
 * Check if a user can edit a session's settings
 * Owner, session admins, and cp-admins group members can edit
 */
export function canUserEditSession(username: string, access: { owner: string; admins?: string[] }): boolean {
  if (username === access.owner) return true;
  if (access.admins?.includes(username)) return true;
  if (isUserInGroup(username, 'admins')) return true;  // cp-admins group
  return false;
}

/**
 * Check if a user can access a session based on its access rules
 */
export function canUserAccessSession(username: string, access: { owner: string; hidden: boolean; public: boolean; allowedUsers: string[]; allowedGroups: string[] }): boolean {
  // Admins and root access all sessions
  if (username === 'root' || isUserInGroup(username, 'admins')) return true;

  // Owner always has access
  if (username === access.owner) return true;

  // cp-users membership required for all non-admin, non-owner access
  if (!isUserInGroup(username, 'users')) return false;

  // Hidden sessions: only owner (owner already returned above)
  if (access.hidden) return false;

  // Public sessions: all cp-users members
  if (access.public) return true;

  // Check allowed users
  if (access.allowedUsers.includes(username)) return true;

  // Check allowed groups
  for (const group of access.allowedGroups) {
    if (isUserInGroup(username, group)) return true;
  }

  return false;
}

/**
 * Sanitize a group name — alphanumeric, hyphens, underscores only
 */
export function sanitizeGroupName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
}

export interface ClaudeSession {
  sessionId: string;
  projectDir: string;
  timestamp: Date;
  firstMessage: string;
}

/**
 * List a user's past Claude Code sessions from ~/.claude/projects/
 * Returns most recent first
 */
export function getUserClaudeSessions(username: string): ClaudeSession[] {
  const home = getUserHome(username);
  if (!home) return [];

  const projectsDir = `${home}/.claude/projects`;
  if (!existsSync(projectsDir)) return [];

  const sessions: ClaudeSession[] = [];

  try {
    const dirs = readdirSync(projectsDir);
    for (const dir of dirs) {
      const dirPath = `${projectsDir}/${dir}`;
      let files: string[];
      try { files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }

      for (const file of files) {
        const filePath = `${dirPath}/${file}`;
        const sessionId = file.replace('.jsonl', '');
        try {
          const stat = statSync(filePath);
          // Skip tiny files (< 5KB likely empty/broken sessions)
          if (stat.size < 5000) continue;

          // Read first few KB to find the first user message
          const fd = openSync(filePath, 'r');
          const buf = Buffer.alloc(4096);
          const bytesRead = readSync(fd, buf, 0, 4096, 0);
          closeSync(fd);

          const content = buf.toString('utf-8', 0, bytesRead);
          const lines = content.split('\n').filter(l => l.trim());

          let firstMessage = '';
          let timestamp = stat.mtime;

          // Find first human/user message
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.timestamp && !timestamp) {
                timestamp = new Date(parsed.timestamp);
              }
              // Look for actual user content
              if (parsed.content && typeof parsed.content === 'string' && parsed.content.length > 2) {
                firstMessage = parsed.content.substring(0, 80);
                if (parsed.timestamp) timestamp = new Date(parsed.timestamp);
                break;
              }
            } catch {}
          }

          // Skip sessions with no user content
          if (!firstMessage) continue;

          sessions.push({
            sessionId,
            projectDir: dir,
            timestamp,
            firstMessage,
          });
        } catch {}
      }
    }
  } catch {}

  // Sort most recent first
  sessions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return sessions;
}

function getUserHome(username: string): string | null {
  try {
    validateUsername(username);
    const result = execFileSync('getent', ['passwd', username], { encoding: 'utf-8' }).trim();
    const parts = result.split(':');
    return parts[5] ?? null;
  } catch {
    return null;
  }
}
