// src/scrollback-viewer.ts

import { moveTo, clearLine, color, hideCursor, showCursor, enterAltScreen, leaveAltScreen } from './ansi.js';

interface ScrollbackViewerOptions {
  content: string;
  cols: number;
  rows: number;
  onExit: () => void;
  write: (data: string) => void;
}

export class ScrollbackViewer {
  private lines: string[];
  private scrollOffset: number;
  private cols: number;
  private rows: number;
  private viewRows: number;
  private onExit: () => void;
  private write: (data: string) => void;

  constructor(options: ScrollbackViewerOptions) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.viewRows = this.rows - 1;
    this.onExit = options.onExit;
    this.write = options.write;

    // Keep ANSI codes — split on newlines, handle \r\n
    this.lines = options.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    this.scrollOffset = Math.max(0, this.lines.length - this.viewRows);

    this.write(this.render());
  }

  private render(): string {
    const parts: string[] = [];
    parts.push(enterAltScreen());
    parts.push(hideCursor());

    const end = Math.min(this.scrollOffset + this.viewRows, this.lines.length);
    for (let i = 0; i < this.viewRows; i++) {
      const lineIdx = this.scrollOffset + i;
      parts.push(moveTo(i + 1, 1));
      parts.push(clearLine());
      if (lineIdx < this.lines.length) {
        parts.push(this.lines[lineIdx]);
      }
      parts.push('\x1b[0m');  // reset colors at end of each line
    }

    // Status bar
    parts.push(moveTo(this.rows, 1));
    parts.push(clearLine());
    const pct = this.lines.length > this.viewRows
      ? Math.round((this.scrollOffset / (this.lines.length - this.viewRows)) * 100)
      : 100;
    const position = `${pct}%`;
    parts.push(color(` SCROLLBACK ${position} | arrows/PgUp/PgDn scroll | g/G top/bottom | q exit `, 7));

    return parts.join('');
  }

  handleInput(data: Buffer): void {
    const str = data.toString();
    const maxOffset = Math.max(0, this.lines.length - this.viewRows);

    if (str === 'q' || str === 'Q' || (str === '\x1b' && data.length === 1)) {
      this.onExit();
      return;
    }

    let changed = false;

    // Arrow up / k
    if (str === '\x1b[A' || str === 'k') {
      this.scrollOffset = Math.max(0, this.scrollOffset - 3);
      changed = true;
    }
    // Arrow down / j
    else if (str === '\x1b[B' || str === 'j') {
      this.scrollOffset = Math.min(maxOffset, this.scrollOffset + 3);
      changed = true;
    }
    // Page Up / u
    else if (str === '\x1b[5~' || str === 'u') {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.viewRows);
      changed = true;
    }
    // Page Down / d (space too)
    else if (str === '\x1b[6~' || str === 'd' || str === ' ') {
      this.scrollOffset = Math.min(maxOffset, this.scrollOffset + this.viewRows);
      changed = true;
    }
    // Home / g
    else if (str === 'g' || str === '\x1b[1~') {
      this.scrollOffset = 0;
      changed = true;
    }
    // End / G
    else if (str === 'G' || str === '\x1b[4~') {
      this.scrollOffset = maxOffset;
      changed = true;
    }
    // Mouse wheel up
    else if (str === '\x1b[M`' || str === '\x1b[Ma') {
      this.scrollOffset = Math.max(0, this.scrollOffset - 5);
      changed = true;
    }
    // Mouse wheel down
    else if (str === '\x1b[Ma' || str === '\x1b[Mb') {
      this.scrollOffset = Math.min(maxOffset, this.scrollOffset + 5);
      changed = true;
    }

    if (changed) {
      this.write(this.render());
    }
  }
}
