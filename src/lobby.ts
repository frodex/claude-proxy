// src/lobby.ts

import { color } from './ansi.js';
import { renderMenu, getActionAtCursor, findItemByKey, nextSelectable, type MenuSection, type MenuItem } from './interactive-menu.js';
import type { Session } from './types.js';

interface LobbyOptions {
  motd: string;
}

interface RenderOptions {
  username: string;
  sessions: Session[];
  cursor: number;
  cols: number;
  rows: number;
}

type InputResult =
  | { type: 'select'; action: string; sessionIndex?: number }
  | { type: 'navigate'; cursor: number }
  | { type: 'none' };

export class Lobby {
  private motd: string;

  constructor(options: LobbyOptions) {
    this.motd = options.motd;
  }

  buildSections(sessions: Session[]): MenuSection[] {
    const sections: MenuSection[] = [];

    if (sessions.length > 0) {
      const sessionItems: MenuItem[] = sessions.map((s, i) => {
        const userCount = s.clients.size;
        const userWord = userCount === 1 ? 'user' : 'users';
        const userNames = Array.from(s.clients.values()).map(c => c.username).join(', ');
        const lock = s.access?.passwordHash ? ' [locked]' : '';
        const vis = s.access?.public === false ? ' (private)' : '';
        const vo = s.access?.viewOnly ? ' [view-only]' : '';
        const owner = s.access?.owner ? ` \x1b[38;5;245m@${s.access.owner}\x1b[0m` : '';
        const host = s.remoteHost ? ` \x1b[36m@${s.remoteHost}\x1b[0m` : '';
        return {
          label: `${s.name}${lock}${vis}${vo}${owner}${host} (${userCount} ${userWord}) [${userNames}]`,
          key: `${i + 1}`,
          action: `join:${i}`,
        };
      });

      sections.push({ title: 'Active Sessions', items: sessionItems });
    } else {
      sections.push({
        items: [{ label: 'No active sessions', action: 'none', disabled: true }],
      });
    }

    sections.push({
      items: [
        { label: 'New session', key: 'n', action: 'new' },
        { label: 'Restart previous session', key: 'r', action: 'continue' },
        { label: 'Fork a session', key: 'f', action: 'fork' },
        { label: 'Export sessions', key: 'e', action: 'export' },
        { label: 'Quit', key: 'q', action: 'quit' },
      ],
    });

    return sections;
  }

  renderScreen(options: RenderOptions): string {
    const { username, sessions, cursor, cols } = options;
    const sections = this.buildSections(sessions);

    return renderMenu({
      title: `claude-proxy`,
      sections,
      footer: this.motd ? `${this.motd} | Connected as: ${username} | tab to refresh` : `Connected as: ${username} | tab to refresh`,
      cursor,
    });
  }

  handleInput(data: Buffer, sessions: Session[], cursor: number): InputResult {
    const str = data.toString();
    const sections = this.buildSections(sessions);

    // Arrow up
    if (str === '\x1b[A' || str === '\x1bOA') {
      const next = nextSelectable(sections, cursor, -1);
      return { type: 'navigate', cursor: next };
    }

    // Arrow down
    if (str === '\x1b[B' || str === '\x1bOB') {
      const next = nextSelectable(sections, cursor, 1);
      return { type: 'navigate', cursor: next };
    }

    // Enter or space — select current
    if (str === '\r' || str === '\n' || str === ' ') {
      const action = getActionAtCursor(sections, cursor);
      if (action) {
        if (action.startsWith('join:')) {
          const idx = parseInt(action.split(':')[1]);
          return { type: 'select', action: 'join', sessionIndex: idx };
        }
        return { type: 'select', action };
      }
      return { type: 'none' };
    }

    // Shortcut keys
    const found = findItemByKey(sections, str);
    if (found) {
      if (found.action.startsWith('join:')) {
        const idx = parseInt(found.action.split(':')[1]);
        return { type: 'select', action: 'join', sessionIndex: idx };
      }
      return { type: 'select', action: found.action };
    }

    // Tab to refresh
    if (str === '\t') {
      return { type: 'select', action: 'refresh' };
    }

    return { type: 'none' };
  }
}
