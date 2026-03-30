// src/ugo/group-watcher.ts
import { watch, type FSWatcher } from 'fs';
import type { Provisioner } from '../auth/types.js';

export interface SessionInfo {
  sessionName: string;
  sessionGroup: string;
  owner: string;
  connectedUsers: string[];
}

export type RevokeCallback = (sessionName: string, username: string) => void;

export class GroupWatcher {
  private provisioner: Provisioner;
  private watcher: FSWatcher | null = null;

  constructor(provisioner: Provisioner) {
    this.provisioner = provisioner;
  }

  checkAccess(username: string, sessionGroup: string): boolean {
    const groups = this.provisioner.getGroups(username);
    return groups.includes(sessionGroup);
  }

  evaluateSessions(sessions: SessionInfo[], onRevoke: RevokeCallback): void {
    for (const session of sessions) {
      for (const user of session.connectedUsers) {
        if (user === session.owner) continue;
        if (!this.checkAccess(user, session.sessionGroup)) {
          onRevoke(session.sessionName, user);
        }
      }
    }
  }

  startWatching(
    getSessions: () => SessionInfo[],
    onRevoke: RevokeCallback,
  ): void {
    this.watcher = watch('/etc/group', () => {
      console.log('[group-watcher] /etc/group changed — re-evaluating sessions');
      const sessions = getSessions();
      this.evaluateSessions(sessions, onRevoke);
    });
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
