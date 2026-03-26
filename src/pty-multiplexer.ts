// src/pty-multiplexer.ts

import { spawn, type IPty } from 'node-pty';
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

  constructor(options: PtyOptions) {
    this.maxScrollback = options.scrollbackBytes;

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
  }

  destroy(): void {
    this.pty.kill();
    this.clients.clear();
  }

  getClientCount(): number {
    return this.clients.size;
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
