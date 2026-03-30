// src/auth/provisioner.ts
import { execSync } from 'child_process';
import type { Provisioner } from './types.js';

const GROUP_PREFIX = 'cp-';

export class LinuxProvisioner implements Provisioner {
  createSystemAccount(username: string, displayName: string): void {
    execSync(
      `useradd -m -c '${displayName.replace(/'/g, "\\'")}' -s /bin/bash ${username}`,
      { stdio: 'pipe' },
    );
    this.addToGroup(username, 'users');
  }

  deleteSystemAccount(username: string): void {
    execSync(`userdel -r ${username}`, { stdio: 'pipe' });
  }

  installClaude(username: string): void {
    execSync(
      `su - ${username} -c 'curl -sL https://claude.ai/install.sh | bash'`,
      { stdio: 'pipe', timeout: 120000 },
    );
  }

  addToGroup(username: string, group: string): void {
    const systemGroup = `${GROUP_PREFIX}${group}`;
    execSync(`usermod -aG ${systemGroup} ${username}`, { stdio: 'pipe' });
  }

  removeFromGroup(username: string, group: string): void {
    const systemGroup = `${GROUP_PREFIX}${group}`;
    execSync(`gpasswd -d ${username} ${systemGroup}`, { stdio: 'pipe' });
  }

  createGroup(group: string): void {
    const systemGroup = `${GROUP_PREFIX}${group}`;
    execSync(`groupadd ${systemGroup}`, { stdio: 'pipe' });
  }

  deleteGroup(group: string): void {
    const systemGroup = `${GROUP_PREFIX}${group}`;
    execSync(`groupdel ${systemGroup}`, { stdio: 'pipe' });
  }

  getGroups(username: string): string[] {
    try {
      const output = execSync(`id -nG ${username}`, { encoding: 'utf-8' }).trim();
      return output.split(' ')
        .filter(g => g.startsWith(GROUP_PREFIX))
        .map(g => g.slice(GROUP_PREFIX.length));
    } catch {
      return [];
    }
  }

  getGroupMembers(group: string): string[] {
    const systemGroup = `${GROUP_PREFIX}${group}`;
    try {
      const output = execSync(`getent group ${systemGroup}`, { encoding: 'utf-8' }).trim();
      const members = output.split(':')[3] || '';
      return members ? members.split(',') : [];
    } catch {
      return [];
    }
  }

  userExists(username: string): boolean {
    try {
      execSync(`getent passwd ${username}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  groupExists(group: string): boolean {
    const systemGroup = `${GROUP_PREFIX}${group}`;
    try {
      execSync(`getent group ${systemGroup}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}
