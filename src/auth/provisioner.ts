import { execFileSync } from 'child_process';
import type { Provisioner } from './types.js';

const GROUP_PREFIX = 'cp-';
const VALID_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

export function validateUsername(name: string): void {
  if (!name || !VALID_NAME.test(name)) throw new Error(`Invalid username: "${name}"`);
}

export function validateGroupName(name: string): void {
  if (!name || !VALID_NAME.test(name)) throw new Error(`Invalid group name: "${name}"`);
}

export class LinuxProvisioner implements Provisioner {
  createSystemAccount(username: string, displayName: string): void {
    validateUsername(username);
    execFileSync('useradd', ['-m', '-c', displayName, '-s', '/bin/bash', username], { stdio: 'pipe' });
    this.addToGroup(username, 'users');
  }

  deleteSystemAccount(username: string): void {
    validateUsername(username);
    execFileSync('userdel', ['-r', username], { stdio: 'pipe' });
  }

  installClaude(username: string): void {
    validateUsername(username);
    execFileSync('su', ['-', username, '-c', 'curl -sL https://claude.ai/install.sh | bash'],
      { stdio: 'pipe', timeout: 120000 });
  }

  addToGroup(username: string, group: string): void {
    validateUsername(username);
    validateGroupName(group);
    execFileSync('usermod', ['-aG', `${GROUP_PREFIX}${group}`, username], { stdio: 'pipe' });
  }

  removeFromGroup(username: string, group: string): void {
    validateUsername(username);
    validateGroupName(group);
    execFileSync('gpasswd', ['-d', username, `${GROUP_PREFIX}${group}`], { stdio: 'pipe' });
  }

  createGroup(group: string): void {
    validateGroupName(group);
    execFileSync('groupadd', [`${GROUP_PREFIX}${group}`], { stdio: 'pipe' });
  }

  deleteGroup(group: string): void {
    validateGroupName(group);
    execFileSync('groupdel', [`${GROUP_PREFIX}${group}`], { stdio: 'pipe' });
  }

  getGroups(username: string): string[] {
    validateUsername(username);
    try {
      const output = execFileSync('id', ['-nG', username], { encoding: 'utf-8' }).trim();
      return output.split(' ').filter(g => g.startsWith(GROUP_PREFIX)).map(g => g.slice(GROUP_PREFIX.length));
    } catch { return []; }
  }

  getGroupMembers(group: string): string[] {
    validateGroupName(group);
    try {
      const output = execFileSync('getent', ['group', `${GROUP_PREFIX}${group}`], { encoding: 'utf-8' }).trim();
      const members = output.split(':')[3] || '';
      return members ? members.split(',') : [];
    } catch { return []; }
  }

  userExists(username: string): boolean {
    validateUsername(username);
    try { execFileSync('getent', ['passwd', username], { stdio: 'pipe' }); return true; }
    catch { return false; }
  }

  groupExists(group: string): boolean {
    validateGroupName(group);
    try { execFileSync('getent', ['group', `${GROUP_PREFIX}${group}`], { stdio: 'pipe' }); return true; }
    catch { return false; }
  }
}
