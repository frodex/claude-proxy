// src/pty-multiplexer.ts

import { spawn, type IPty } from 'node-pty';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
import type { Client } from './types.js';

interface PtyOptions {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  scrollbackBytes: number;
  tmuxSessionId: string;
  runAsUser?: string;
  onExit?: (code: number) => void;
}

interface AttachOptions {
  tmuxSessionId: string;
  cols: number;
  rows: number;
  scrollbackBytes: number;
  onExit?: (code: number) => void;
}

export class PtyMultiplexer {
  private pty: IPty | null = null;
  private clients: Map<string, Client> = new Map();
  private scrollback: Buffer[] = [];
  private scrollbackSize = 0;
  private maxScrollback: number;
  private vterm: InstanceType<typeof Terminal>;
  private tmuxId: string;
  private onExitCallback?: (code: number) => void;

  constructor(options: PtyOptions) {
    this.maxScrollback = options.scrollbackBytes;
    this.tmuxId = options.tmuxSessionId;
    this.onExitCallback = options.onExit;

    this.vterm = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: 10000,
      allowProposedApi: true,
    });

    // Build the command to run inside tmux
    let innerCommand: string;
    const launcherPath = resolve(import.meta.dirname ?? '.', '..', 'scripts', 'launch-claude.sh');

    if (options.runAsUser) {
      if (options.command === 'claude') {
        const argsStr = options.args.length > 0 ? ' ' + options.args.join(' ') : '';
        innerCommand = `su - ${options.runAsUser} -c '${launcherPath}${argsStr}'`;
      } else {
        let commandPath = options.command;
        try { commandPath = execSync(`which ${options.command}`, { encoding: 'utf-8' }).trim(); } catch {}
        const fullCmd = [commandPath, ...options.args].join(' ');
        innerCommand = `su - ${options.runAsUser} -c '${fullCmd}'`;
      }
    } else {
      if (options.command === 'claude') {
        innerCommand = launcherPath;
      } else {
        innerCommand = [options.command, ...options.args].join(' ');
      }
    }

    // Write inner command to a temp script to avoid quote escaping issues with nested su/tmux
    const scriptPath = `/tmp/claude-proxy-launch-${this.tmuxId}.sh`;
    writeFileSync(scriptPath, `#!/bin/bash\nrm -f "${scriptPath}"\n${innerCommand}\n`, { mode: 0o755 });

    const confPath = resolve(import.meta.dirname ?? '.', '..', 'tmux.conf');
    const tmuxCmd = `tmux -f ${confPath} new-session -d -s ${this.tmuxId} -x ${options.cols} -y ${options.rows} ${scriptPath}`;
    try {
      execSync(tmuxCmd, { stdio: 'pipe' });
      console.log(`[tmux] created session ${this.tmuxId}`);
    } catch (err: any) {
      console.error(`[tmux] failed to create session: ${err.message}`);
      throw err;
    }

    // Now attach to it via a PTY
    this.attachToTmux(options.cols, options.rows);
  }

  /**
   * Re-attach to an existing tmux session (e.g., after proxy restart)
   */
  static reattach(options: AttachOptions): PtyMultiplexer {
    const mux = Object.create(PtyMultiplexer.prototype) as PtyMultiplexer;
    mux.clients = new Map();
    mux.scrollback = [];
    mux.scrollbackSize = 0;
    mux.maxScrollback = options.scrollbackBytes;
    mux.tmuxId = options.tmuxSessionId;
    mux.onExitCallback = options.onExit;

    mux.vterm = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: 10000,
      allowProposedApi: true,
    });

    console.log(`[tmux] reattaching to session ${mux.tmuxId}`);
    mux.attachToTmux(options.cols, options.rows);

    return mux;
  }

  private attachToTmux(cols: number, rows: number): void {
    // Spawn a PTY that attaches to the tmux session
    const confPath = resolve(import.meta.dirname ?? '.', '..', 'tmux.conf');
    this.pty = spawn('tmux', ['-f', confPath, 'attach-session', '-t', this.tmuxId], {
      name: 'xterm-256color',
      cols,
      rows,
      env: process.env as Record<string, string>,
    });

    this.pty.onData((data: string) => {
      const buf = Buffer.from(data);
      this.appendScrollback(buf);
      this.vterm.write(data);
      for (const client of this.clients.values()) {
        client.write(buf);
      }
    });

    this.pty.onExit(({ exitCode }) => {
      console.log(`[tmux] attach exited for ${this.tmuxId} with code ${exitCode}`);
      // Check if the tmux session itself is still alive
      if (!this.isTmuxSessionAlive()) {
        console.log(`[tmux] session ${this.tmuxId} is dead`);
        this.onExitCallback?.(exitCode);
      } else {
        // tmux attach exited but session is alive — proxy might be shutting down
        console.log(`[tmux] session ${this.tmuxId} still alive (proxy detaching)`);
      }
    });
  }

  private isTmuxSessionAlive(): boolean {
    try {
      execSync(`tmux has-session -t ${this.tmuxId}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  attach(client: Client): void {
    for (const chunk of this.scrollback) {
      client.write(chunk);
    }
    this.clients.set(client.id, client);
  }

  detach(client: Client): void {
    this.clients.delete(client.id);
  }

  write(data: Buffer): void {
    if (this.pty) {
      this.pty.write(data.toString());
    }
  }

  resize(cols: number, rows: number): void {
    if (this.pty) {
      this.pty.resize(cols, rows);
    }
    this.vterm.resize(cols, rows);
  }

  /**
   * Destroy — kills the tmux session and the PTY
   */
  destroy(): void {
    if (this.pty) {
      this.pty.kill();
      this.pty = null;
    }
    this.vterm.dispose();
    this.clients.clear();
    // Kill the tmux session
    try {
      execSync(`tmux kill-session -t ${this.tmuxId}`, { stdio: 'pipe' });
      console.log(`[tmux] killed session ${this.tmuxId}`);
    } catch {}
  }

  /**
   * Detach cleanly — kills the PTY attach process but leaves tmux session alive
   */
  detachFromTmux(): void {
    if (this.pty) {
      this.pty.kill();
      this.pty = null;
    }
    this.clients.clear();
    console.log(`[tmux] detached from ${this.tmuxId} (session still alive)`);
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getTmuxId(): string {
    return this.tmuxId;
  }

  getScrollbackText(): string {
    return Buffer.concat(this.scrollback).toString();
  }

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

        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
          lines.pop();
        }

        const result = lines.join('\n').replace(/\n{3,}/g, '\n\n');
        resolve(result);
      });
    });
  }

  /**
   * List all tmux sessions with our prefix
   */
  static listTmuxSessions(): Array<{ tmuxId: string; name: string; created: Date }> {
    try {
      const output = execSync(
        "tmux list-sessions -F '#{session_name}|#{session_created}' 2>/dev/null",
        { encoding: 'utf-8' }
      ).trim();

      if (!output) return [];

      return output.split('\n')
        .filter(line => line.startsWith('cp-'))
        .map(line => {
          const [tmuxId, createdTs] = line.split('|');
          return {
            tmuxId,
            name: tmuxId.replace(/^cp-/, ''),
            created: new Date(parseInt(createdTs) * 1000),
          };
        });
    } catch {
      return [];
    }
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
