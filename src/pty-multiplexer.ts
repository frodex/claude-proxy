// src/pty-multiplexer.ts

import { spawn, type IPty } from 'node-pty';
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
import type { Client } from './types.js';

interface PtyOptions {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  scrollbackBytes: number;
  runAsUser?: string;
  onExit?: (code: number) => void;
}

export class PtyMultiplexer {
  private pty: IPty;
  private clients: Map<string, Client> = new Map();
  private scrollback: Buffer[] = [];
  private scrollbackSize = 0;
  private maxScrollback: number;
  private vterm: InstanceType<typeof Terminal>;

  constructor(options: PtyOptions) {
    this.maxScrollback = options.scrollbackBytes;

    // Headless xterm for interpreting PTY output into a readable screen buffer
    this.vterm = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: 10000,
      allowProposedApi: true,
    });

    let command = options.command;
    let args = options.args;

    if (options.runAsUser) {
      args = ['-', options.runAsUser, '-c', [command, ...args].join(' ')];
      command = 'su';
    }

    this.pty = spawn(command, args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      env: process.env as Record<string, string>,
    });

    this.pty.onData((data: string) => {
      const buf = Buffer.from(data);
      this.appendScrollback(buf);
      // Feed into virtual terminal for readable scrollback
      this.vterm.write(data);
      for (const client of this.clients.values()) {
        client.write(buf);
      }
    });

    this.pty.onExit(({ exitCode }) => {
      options.onExit?.(exitCode);
    });
  }

  attach(client: Client): void {
    // Replay scrollback to new joiner
    for (const chunk of this.scrollback) {
      client.write(chunk);
    }
    this.clients.set(client.id, client);
  }

  detach(client: Client): void {
    this.clients.delete(client.id);
  }

  write(data: Buffer): void {
    this.pty.write(data.toString());
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
    this.vterm.resize(cols, rows);
  }

  destroy(): void {
    this.pty.kill();
    this.vterm.dispose();
    this.clients.clear();
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getScrollbackText(): string {
    return Buffer.concat(this.scrollback).toString();
  }

  /**
   * Get the interpreted terminal content as readable text lines.
   * Uses the headless xterm to produce what a user would actually see,
   * including scrollback history.
   * Returns a Promise because xterm.write() is async — we flush pending writes first.
   */
  getReadableScrollback(): Promise<string> {
    return new Promise((resolve) => {
      this.vterm.write('', () => {
        const buffer = this.vterm.buffer.active;
        const lines: string[] = [];

        const totalLines = buffer.length;
        for (let i = 0; i < totalLines; i++) {
          const line = buffer.getLine(i);
          if (line) {
            let text = line.translateToString(true);
            // Replace box-drawing chars with ASCII equivalents
            text = text
              .replace(/[╭╮┌┐]/g, '+')
              .replace(/[╰╯└┘]/g, '+')
              .replace(/[│║▐▌]/g, '|')
              .replace(/[─═]/g, '-')
              .replace(/[├┤╠╣┬┴╦╩┼╬]/g, '+')
              .replace(/[▛▜▝▘░▸⎿]/g, ' ')
              .replace(/[❯●⌨]/g, ' ');
            lines.push(text);
          }
        }

        // Trim trailing empty lines
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
          lines.pop();
        }

        // Collapse runs of 3+ blank lines into 2
        const result = lines.join('\n').replace(/\n{3,}/g, '\n\n');
        resolve(result);
      });
    });
  }

  private appendScrollback(data: Buffer): void {
    this.scrollback.push(data);
    this.scrollbackSize += data.length;

    while (this.scrollbackSize > this.maxScrollback && this.scrollback.length > 1) {
      const removed = this.scrollback.shift()!;
      this.scrollbackSize -= removed.length;
    }
  }
}
