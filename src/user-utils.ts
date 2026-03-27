// src/user-utils.ts

import { execSync } from 'child_process';
import { existsSync } from 'fs';

/**
 * Get users who have a ~/.claude/ directory (have used Claude)
 */
export function getClaudeUsers(): string[] {
  try {
    const output = execSync("getent passwd | cut -d: -f1,6", { encoding: 'utf-8' });
    return output.trim().split('\n')
      .map(line => {
        const [username, home] = line.split(':');
        return { username, home };
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
    const output = execSync("getent group", { encoding: 'utf-8' });
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
    const output = execSync(`id -nG ${username}`, { encoding: 'utf-8' }).trim();
    return output.split(' ').includes(systemGroup);
  } catch {
    return false;
  }
}

/**
 * Check if a user can access a session based on its access rules
 */
export function canUserAccessSession(username: string, access: { owner: string; hidden: boolean; public: boolean; allowedUsers: string[]; allowedGroups: string[] }): boolean {
  // Owner always has access
  if (username === access.owner) return true;

  // Hidden sessions: only owner
  if (access.hidden) return false;

  // Public sessions: everyone
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
