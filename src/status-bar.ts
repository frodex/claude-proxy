// src/status-bar.ts

import { moveTo, clearLine, color, saveCursor, restoreCursor, setScrollRegion, hideCursor, showCursor } from './ansi.js';

interface UserPresence {
  username: string;
  isSizeOwner: boolean;
  isTyping: boolean;
}

interface RenderOptions {
  sessionName: string;
  users: UserPresence[];
  cols: number;
}

interface FrameOptions {
  ptyData: string;
  sessionName: string;
  users: UserPresence[];
  clientRows: number;
  clientCols: number;
}

const TYPING_TIMEOUT_MS = 2000;

export class StatusBar {
  private typingTimestamps: Map<string, number> = new Map();

  recordKeystroke(username: string): void {
    this.typingTimestamps.set(username, Date.now());
  }

  isTyping(username: string): boolean {
    const ts = this.typingTimestamps.get(username);
    if (!ts) return false;
    return (Date.now() - ts) < TYPING_TIMEOUT_MS;
  }

  render(options: RenderOptions): string {
    const { sessionName, users, cols } = options;

    // Line 1: session name | user list
    const userParts = users.map(u => {
      const name = u.isSizeOwner ? `[${u.username}]` : u.username;
      if (u.isTyping) {
        return color(name, 33);  // orange
      }
      return color(name, 90);    // gray
    });

    const left = color(sessionName, 36);  // cyan
    const right = userParts.join(' ');
    const line1 = `${left} │ ${right}`;

    // Line 2: typing indicator
    const typers = users.filter(u => u.isTyping).map(u => u.username);
    let line2 = '';
    if (typers.length > 0) {
      const pad = ' '.repeat(sessionName.length + 3);
      line2 = `${pad}⌨  ${color(typers.join(', '), 33)}`;
    }

    return `${line1}\n${line2}`;
  }

  renderFrame(options: FrameOptions): string {
    const { ptyData, sessionName, users, clientRows, clientCols } = options;
    const statusRows = 2;
    const contentRows = clientRows - statusRows;

    const parts: string[] = [];

    // Set scroll region for PTY content (top area)
    parts.push(setScrollRegion(1, contentRows));

    // Write PTY data into the scroll region
    parts.push(moveTo(1, 1));
    parts.push(ptyData);

    // Render status bar in the reserved bottom rows
    parts.push(saveCursor());
    parts.push(hideCursor());

    const barOutput = this.render({ sessionName, users, cols: clientCols });
    const barLines = barOutput.split('\n');

    // Status bar separator + content
    const separatorRow = clientRows - 1;
    parts.push(moveTo(separatorRow, 1));
    parts.push(clearLine());
    parts.push(barLines[0] || '');

    parts.push(moveTo(clientRows, 1));
    parts.push(clearLine());
    parts.push(barLines[1] || '');

    parts.push(restoreCursor());
    parts.push(showCursor());

    return parts.join('');
  }

  renderStatusOnly(options: {
    sessionName: string;
    users: UserPresence[];
    clientRows: number;
    clientCols: number;
  }): string {
    const parts: string[] = [];
    const barOutput = this.render({
      sessionName: options.sessionName,
      users: options.users,
      cols: options.clientCols,
    });
    const barLines = barOutput.split('\n');

    parts.push(saveCursor());
    parts.push(hideCursor());

    const separatorRow = options.clientRows - 1;
    parts.push(moveTo(separatorRow, 1));
    parts.push(clearLine());
    parts.push(barLines[0] || '');

    parts.push(moveTo(options.clientRows, 1));
    parts.push(clearLine());
    parts.push(barLines[1] || '');

    parts.push(restoreCursor());
    parts.push(showCursor());

    return parts.join('');
  }
}
