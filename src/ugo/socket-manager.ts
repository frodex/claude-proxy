// src/ugo/socket-manager.ts
import { execSync } from 'child_process';
import { mkdirSync, chownSync, chmodSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { Provisioner } from '../auth/types.js';

export type SessionMode = 'private' | 'shared' | 'team' | 'public';

export class SocketManager {
  private socketDir: string;
  private provisioner: Provisioner;

  constructor(socketDir: string, provisioner: Provisioner) {
    this.socketDir = socketDir;
    this.provisioner = provisioner;
    mkdirSync(this.socketDir, { recursive: true, mode: 0o755 });
  }

  getSocketPath(sessionName: string): string {
    const safe = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.socketDir, `cp-${safe}.sock`);
  }

  createSessionSocket(
    sessionName: string,
    owner: string,
    termSize: { cols: number; rows: number },
    mode: SessionMode,
    teamGroup?: string,
  ): string {
    const socketPath = this.getSocketPath(sessionName);
    const tmuxId = `cp-${sessionName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    // Create session group if shared
    if (mode === 'shared') {
      const groupName = `sess-${sessionName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      if (!this.provisioner.groupExists(groupName)) {
        this.provisioner.createGroup(groupName);
      }
      this.provisioner.addToGroup(owner, groupName);
    }

    // Launch tmux with custom socket as the owner
    const tmuxCmd = `tmux -S ${socketPath} new-session -d -s ${tmuxId} -x ${termSize.cols} -y ${termSize.rows}`;
    execSync(`su - ${owner} -c '${tmuxCmd}'`, { stdio: 'pipe' });

    // Set socket permissions based on mode
    this.setSocketPermissions(socketPath, owner, mode, sessionName, teamGroup);

    // Grant owner write access via server-access
    execSync(
      `su - ${owner} -c 'tmux -S ${socketPath} server-access -a ${owner} -w'`,
      { stdio: 'pipe' },
    );

    return socketPath;
  }

  private setSocketPermissions(
    socketPath: string,
    owner: string,
    mode: SessionMode,
    sessionName: string,
    teamGroup?: string,
  ): void {
    const ownerUid = parseInt(
      execSync(`id -u ${owner}`, { encoding: 'utf-8' }).trim()
    );

    let groupGid: number;
    switch (mode) {
      case 'private':
        groupGid = parseInt(
          execSync(`id -g ${owner}`, { encoding: 'utf-8' }).trim()
        );
        chownSync(socketPath, ownerUid, groupGid);
        chmodSync(socketPath, 0o700);
        break;

      case 'shared': {
        const groupName = `cp-sess-${sessionName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        groupGid = parseInt(
          execSync(`getent group ${groupName} | cut -d: -f3`, { encoding: 'utf-8' }).trim()
        );
        chownSync(socketPath, ownerUid, groupGid);
        chmodSync(socketPath, 0o770);
        break;
      }

      case 'team': {
        const tg = teamGroup ? `cp-${teamGroup}` : 'cp-users';
        groupGid = parseInt(
          execSync(`getent group ${tg} | cut -d: -f3`, { encoding: 'utf-8' }).trim()
        );
        chownSync(socketPath, ownerUid, groupGid);
        chmodSync(socketPath, 0o770);
        break;
      }

      case 'public': {
        groupGid = parseInt(
          execSync(`getent group cp-users | cut -d: -f3`, { encoding: 'utf-8' }).trim()
        );
        chownSync(socketPath, ownerUid, groupGid);
        chmodSync(socketPath, 0o770);
        break;
      }
    }
  }

  grantAccess(
    sessionName: string,
    owner: string,
    targetUser: string,
    accessLevel: 'write' | 'read',
  ): void {
    const socketPath = this.getSocketPath(sessionName);
    const flag = accessLevel === 'write' ? '-w' : '-r';
    execSync(
      `su - ${owner} -c 'tmux -S ${socketPath} server-access -a ${targetUser} ${flag}'`,
      { stdio: 'pipe' },
    );
  }

  revokeAccess(sessionName: string, owner: string, targetUser: string): void {
    const socketPath = this.getSocketPath(sessionName);
    try {
      execSync(
        `su - ${owner} -c 'tmux -S ${socketPath} server-access -d ${targetUser}'`,
        { stdio: 'pipe' },
      );
    } catch {}
    try {
      execSync(
        `su - ${owner} -c 'tmux -S ${socketPath} detach-client -s ${targetUser}'`,
        { stdio: 'pipe' },
      );
    } catch {}
  }

  destroySessionSocket(sessionName: string, owner: string): void {
    const socketPath = this.getSocketPath(sessionName);
    try {
      execSync(
        `su - ${owner} -c 'tmux -S ${socketPath} kill-server'`,
        { stdio: 'pipe' },
      );
    } catch {}
    try { unlinkSync(socketPath); } catch {}

    const groupName = `sess-${sessionName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    if (this.provisioner.groupExists(groupName)) {
      try { this.provisioner.deleteGroup(groupName); } catch {}
    }
  }

  discoverSockets(): string[] {
    if (!existsSync(this.socketDir)) return [];
    const files = readdirSync(this.socketDir).filter(f => f.endsWith('.sock'));
    const alive: string[] = [];

    for (const file of files) {
      const socketPath = join(this.socketDir, file);
      try {
        execSync(`tmux -S ${socketPath} list-sessions`, { stdio: 'pipe' });
        alive.push(socketPath);
      } catch {
        try { unlinkSync(socketPath); } catch {}
      }
    }

    return alive;
  }
}
