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
  remoteHost?: string;
  workingDir?: string;
  onExit?: (code: number) => void;
}

interface AttachOptions {
  tmuxSessionId: string;
  cols: number;
  rows: number;
  scrollbackBytes: number;
  remoteHost?: string;
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
  private remoteHost?: string;
  private onExitCallback?: (code: number) => void;

  constructor(options: PtyOptions) {
    this.maxScrollback = options.scrollbackBytes;
    this.tmuxId = options.tmuxSessionId;
    this.remoteHost = options.remoteHost;
    this.onExitCallback = options.onExit;

    this.vterm = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: 10000,
      allowProposedApi: true,
    });

    // Build the command to run inside tmux
    let innerCommand: string;

    // Shell-safe quoting for working directory (mkdir -p so new dirs work)
    const safeDir = options.workingDir?.replace(/'/g, "'\\''");
    const cdPrefix = options.workingDir
      ? `mkdir -p '${safeDir}' && cd '${safeDir}' && `
      : '';

    if (this.remoteHost) {
      // Remote — use claude directly (it's installed on the remote host)
      const argsStr = options.args.length > 0 ? ' ' + options.args.join(' ') : '';
      if (options.runAsUser) {
        innerCommand = `su - ${options.runAsUser} -c '${cdPrefix}claude${argsStr}'`;
      } else {
        innerCommand = `${cdPrefix}claude${argsStr}`;
      }
    } else {
      // Local — use launcher script
      const launcherPath = resolve(import.meta.dirname ?? '.', '..', 'scripts', 'launch-claude.sh');
      if (options.runAsUser) {
        if (options.command === 'claude') {
          const argsStr = options.args.length > 0 ? ' ' + options.args.join(' ') : '';
          innerCommand = `su - ${options.runAsUser} -c '${cdPrefix}${launcherPath}${argsStr}'`;
        } else {
          let commandPath = options.command;
          try { commandPath = execSync(`which ${options.command}`, { encoding: 'utf-8' }).trim(); } catch {}
          const fullCmd = [commandPath, ...options.args].join(' ');
          innerCommand = `su - ${options.runAsUser} -c '${cdPrefix}${fullCmd}'`;
        }
      } else {
        if (options.command === 'claude') {
          innerCommand = `${cdPrefix}${launcherPath}`;
        } else {
          innerCommand = `${cdPrefix}${[options.command, ...options.args].join(' ')}`;
        }
      }
    }

    if (this.remoteHost) {
      // Remote session — SSH to host, write a temp script there, run tmux with it
      const remoteScript = `/tmp/claude-proxy-launch-${this.tmuxId}.sh`;
      try {
        // Write launch script on the remote host
        execSync(`ssh ${this.remoteHost} "cat > ${remoteScript} << 'SCRIPT'\n#!/bin/bash\nrm -f ${remoteScript}\n${innerCommand}\nSCRIPT\nchmod +x ${remoteScript}"`, { stdio: 'pipe' });
        // Create tmux session with the script
        execSync(`ssh ${this.remoteHost} "tmux new-session -d -s ${this.tmuxId} -x ${options.cols} -y ${options.rows} ${remoteScript}"`, { stdio: 'pipe' });
        console.log(`[tmux] created remote session ${this.tmuxId} on ${this.remoteHost}`);
      } catch (err: any) {
        console.error(`[tmux] failed to create remote session: ${err.message}`);
        throw err;
      }
    } else {
      // Local session — use temp script to avoid quote escaping
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
    }

    // Attach to the session via a PTY
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
    mux.remoteHost = options.remoteHost;
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
    if (this.remoteHost) {
      // Remote — SSH to attach to tmux on remote host
      // node-pty provides the PTY, ssh -tt forces remote PTY allocation even without local tty
      this.pty = spawn('ssh', ['-tt', this.remoteHost, 'tmux', 'attach-session', '-t', this.tmuxId], {
        name: 'xterm-256color',
        cols,
        rows,
        env: process.env as Record<string, string>,
      });
    } else {
      // Local — attach directly
      const confPath = resolve(import.meta.dirname ?? '.', '..', 'tmux.conf');
      this.pty = spawn('tmux', ['-f', confPath, 'attach-session', '-t', this.tmuxId], {
        name: 'xterm-256color',
        cols,
        rows,
        env: process.env as Record<string, string>,
      });
    }

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
      const cmd = this.remoteHost
        ? `ssh ${this.remoteHost} tmux has-session -t ${this.tmuxId}`
        : `tmux has-session -t ${this.tmuxId}`;
      execSync(cmd, { stdio: 'pipe' });
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
      const cmd = this.remoteHost
        ? `ssh ${this.remoteHost} tmux kill-session -t ${this.tmuxId}`
        : `tmux kill-session -t ${this.tmuxId}`;
      execSync(cmd, { stdio: 'pipe' });
      console.log(`[tmux] killed session ${this.tmuxId}`);
    } catch {}
  }

  /**
   * Detach cleanly — kills the PTY attach process but leaves tmux session alive
   */
  // --- Event hooks for api-server / screen-renderer ---

  /**
   * Register callback for when screen content changes.
   * Fires after vterm processes PTY data.
   * start/end are viewport-relative row indices.
   */
  onScreenChange(callback: (startLine: number, endLine: number) => void): void {
    (this.vterm as any).onRender(({ start, end }: { start: number; end: number }) => {
      callback(start, end);
    });
  }

  /**
   * Register callback for cursor position changes.
   */
  onCursorChange(callback: () => void): void {
    (this.vterm as any).onCursorMove(callback);
  }

  /**
   * Register callback for terminal title changes (OSC 0/2).
   */
  onTitleChange(callback: (title: string) => void): void {
    (this.vterm as any).onTitleChange(callback);
  }

  /**
   * Read a single line from the xterm buffer.
   * Index is absolute (0 = first scrollback line).
   */
  getScreenLine(lineIndex: number): any | undefined {
    return this.vterm.buffer.active.getLine(lineIndex);
  }

  /**
   * Get current screen dimensions and buffer geometry.
   */
  getScreenDimensions(): {
    cols: number;
    rows: number;
    baseY: number;
    length: number;
    cursorX: number;
    cursorY: number;
  } {
    const buf = this.vterm.buffer.active;
    return {
      cols: this.vterm.cols,
      rows: this.vterm.rows,
      baseY: buf.baseY,
      length: buf.length,
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
    };
  }

  /**
   * Get the active buffer object directly (for screen-renderer).
   */
  getBuffer(): any {
    return this.vterm.buffer.active;
  }

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
