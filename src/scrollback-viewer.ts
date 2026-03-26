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

    this.lines = this.prepareLines(options.content);
    this.scrollOffset = Math.max(0, this.lines.length - this.viewRows);

    // Initial render
    this.write(this.render());
  }

  private prepareLines(content: string): string[] {
    const stripped = content
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b[78]/g, '')
      .replace(/\r/g, '');
    return stripped.split('\n');
  }

  private render(): string {
    const parts: string[] = [];
    parts.push(hideCursor());

    const end = Math.min(this.scrollOffset + this.viewRows, this.lines.length);
    for (let i = 0; i < this.viewRows; i++) {
      const lineIdx = this.scrollOffset + i;
      parts.push(moveTo(i + 1, 1));
      parts.push(clearLine());
      if (lineIdx < this.lines.length) {
        parts.push(this.lines[lineIdx].substring(0, this.cols));
      }
    }

    parts.push(moveTo(this.rows, 1));
    parts.push(clearLine());
    const position = this.lines.length > 0
      ? `${Math.min(end, this.lines.length)}/${this.lines.length}`
      : '0/0';
    parts.push(color(` SCROLLBACK \u2502 ${position} \u2502 \u2191\u2193 PgUp/PgDn \u2502 g/G top/bottom \u2502 q exit `, 7));

    return parts.join('');
  }

  handleInput(data: Buffer): void {
    const str = data.toString();

    if (str === 'q' || str === 'Q' || (str === '\x1b' && data.length === 1)) {
      this.onExit();
      return;
    }

    let changed = false;
    if (str === '\x1b[A') { this.scrollOffset = Math.max(0, this.scrollOffset - 1); changed = true; }
    else if (str === '\x1b[B') { this.scrollOffset = Math.min(Math.max(0, this.lines.length - this.viewRows), this.scrollOffset + 1); changed = true; }
    else if (str === '\x1b[5~') { this.scrollOffset = Math.max(0, this.scrollOffset - this.viewRows); changed = true; }
    else if (str === '\x1b[6~') { this.scrollOffset = Math.min(Math.max(0, this.lines.length - this.viewRows), this.scrollOffset + this.viewRows); changed = true; }
    else if (str === 'g') { this.scrollOffset = 0; changed = true; }
    else if (str === 'G') { this.scrollOffset = Math.max(0, this.lines.length - this.viewRows); changed = true; }

    if (changed) {
      this.write(this.render());
    }
  }
}
