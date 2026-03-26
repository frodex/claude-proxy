// src/lobby.ts

import { moveTo, clearLine, color, hideCursor, showCursor } from './ansi.js';
import type { Session } from './types.js';

interface LobbyOptions {
  motd: string;
}

interface RenderOptions {
  username: string;
  sessions: Session[];
  selectedIndex: number;
  cols: number;
  rows: number;
}

interface InputState {
  selectedIndex: number;
  sessionCount: number;
}

type InputResult =
  | { type: 'navigate'; selectedIndex: number }
  | { type: 'join'; selectedIndex: number }
  | { type: 'new' }
  | { type: 'quit' }
  | { type: 'none' };

export class Lobby {
  private motd: string;

  constructor(options: LobbyOptions) {
    this.motd = options.motd;
  }

  renderScreen(options: RenderOptions): string {
    const { username, sessions, selectedIndex, cols, rows } = options;
    const parts: string[] = [];

    parts.push('\x1b[2J');
    parts.push(hideCursor());
    parts.push(moveTo(1, 1));

    const width = Math.min(cols - 4, 56);
    const hr = '═'.repeat(width);
    const pad = (text: string) => {
      const visible = text.replace(/\x1b\[[0-9;]*m/g, '');
      const remaining = width - 2 - visible.length;
      return `║ ${text}${' '.repeat(Math.max(0, remaining))} ║`;
    };

    parts.push(`╔${hr}╗\n`);
    parts.push(pad(color('claude-proxy', 1)));
    parts.push('\n');
    parts.push(pad(`Connected as: ${color(username, 36)}`));
    parts.push('\n');
    parts.push(`╠${hr}╣\n`);
    parts.push(pad(''));
    parts.push('\n');

    if (sessions.length === 0) {
      parts.push(pad('  No active sessions'));
      parts.push('\n');
    } else {
      parts.push(pad(color('  Active Sessions:', 1)));
      parts.push('\n');

      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const arrow = i === selectedIndex ? '▸' : ' ';
        const userCount = s.clients.size;
        const userWord = userCount === 1 ? 'user' : 'users';
        const userNames = Array.from(s.clients.values()).map(c => c.username).join(', ');
        const line = `  ${arrow} ${i + 1}. ${s.name} (${userCount} ${userWord}) [${userNames}]`;
        parts.push(pad(i === selectedIndex ? color(line, 1) : line));
        parts.push('\n');
      }
    }

    parts.push(pad(''));
    parts.push('\n');
    parts.push(pad(`  ${color('[n]', 33)} New session`));
    parts.push('\n');
    parts.push(pad(`  ${color('[q]', 33)} Quit`));
    parts.push('\n');
    parts.push(pad(''));
    parts.push('\n');

    if (this.motd) {
      parts.push(pad(color(this.motd, 90)));
      parts.push('\n');
    }

    parts.push(`╚${hr}╝\n`);

    return parts.join('');
  }

  handleInput(data: Buffer, state: InputState): InputResult {
    const str = data.toString();

    if (str === '\x1b[B') {
      if (state.sessionCount === 0) return { type: 'none' };
      const next = (state.selectedIndex + 1) % state.sessionCount;
      return { type: 'navigate', selectedIndex: next };
    }

    if (str === '\x1b[A') {
      if (state.sessionCount === 0) return { type: 'none' };
      const next = (state.selectedIndex - 1 + state.sessionCount) % state.sessionCount;
      return { type: 'navigate', selectedIndex: next };
    }

    if (str === '\r' || str === '\n') {
      if (state.sessionCount === 0) return { type: 'none' };
      return { type: 'join', selectedIndex: state.selectedIndex };
    }

    if (/^[1-9]$/.test(str)) {
      const idx = parseInt(str, 10) - 1;
      if (idx < state.sessionCount) {
        return { type: 'join', selectedIndex: idx };
      }
      return { type: 'none' };
    }

    if (str === 'n' || str === 'N') return { type: 'new' };
    if (str === 'q' || str === 'Q') return { type: 'quit' };

    return { type: 'none' };
  }
}
