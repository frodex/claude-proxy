// src/lobby.ts

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

  buildSections(_sessions: Session[]): MenuSection[] {
    return [
      {
        items: [
          { label: 'Join a running session', key: 'j', action: 'join_menu' },
          { label: 'New session', key: 'n', action: 'new_menu' },
          { label: 'Restart previous session', key: 'r', action: 'continue' },
          { label: 'Fork a session', key: 'f', action: 'fork' },
          { label: 'Export sessions', key: 'e', action: 'export' },
          { label: 'Quit', key: 'q', action: 'quit' },
        ],
      },
    ];
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
        return { type: 'select', action };
      }
      return { type: 'none' };
    }

    // Shortcut keys
    const found = findItemByKey(sections, str);
    if (found) {
      return { type: 'select', action: found.action };
    }

    // Tab to refresh
    if (str === '\t') {
      return { type: 'select', action: 'refresh' };
    }

    return { type: 'none' };
  }
}
