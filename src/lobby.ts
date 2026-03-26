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

    // Clear screen
    parts.push('\x1b[2J');
    parts.push(hideCursor());

    // Use simple line-by-line rendering with moveTo for each line
    let row = 2;

    const line = (text: string) => {
      parts.push(moveTo(row, 3));
      parts.push(clearLine());
      parts.push(text);
      row++;
    };

    line(color('claude-proxy', 1));
    line(`Connected as: ${color(username, 36)}`);
    line('');
    line(color('─'.repeat(Math.min(cols - 6, 50)), 90));
    line('');

    if (sessions.length === 0) {
      line('  No active sessions');
    } else {
      line(color('  Active Sessions:', 1));
      line('');

      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const arrow = i === selectedIndex ? color('>', 33) : ' ';
        const userCount = s.clients.size;
        const userWord = userCount === 1 ? 'user' : 'users';
        const userNames = Array.from(s.clients.values()).map(c => c.username).join(', ');
        const entry = `  ${arrow} ${i + 1}. ${s.name} (${userCount} ${userWord}) [${userNames}]`;
        line(i === selectedIndex ? color(entry, 1) : entry);
      }
    }

    line('');
    line(`  ${color('[n]', 33)} New session`);
    line(`  ${color('[q]', 33)} Quit`);
    line('');
    line(color('─'.repeat(Math.min(cols - 6, 50)), 90));

    if (this.motd) {
      line('');
      line(color(this.motd, 90));
    }

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
