// src/pty-multiplexer.ts

import { spawn, type IPty } from 'node-pty';
import { execSync, execFileSync, execFile } from 'child_process';
import { resolve } from 'path';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
import type { Client } from './types.js';

/** Must match `tmux -f` used for new-session / attach on the default socket. */
const TMUX_CONF_PATH = resolve(import.meta.dirname ?? '.', '..', 'tmux.conf');

function execFileAsync(cmd: string, args: string[], options: { encoding: 'utf-8'; timeout: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

interface PtyOptions {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  scrollbackBytes: number;
  tmuxSessionId: string;
  /** shell | claude | cursor — drives remote installer vs generic runner (do not rely on command string alone). */
  launchProfile?: string;
  runAsUser?: string;
  remoteHost?: string;
  workingDir?: string;
  socketPath?: string;
  onExit?: (code: number) => void;
}

interface AttachOptions {
  tmuxSessionId: string;
  cols: number;
  rows: number;
  scrollbackBytes: number;
  remoteHost?: string;
  socketPath?: string;
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
  private socketPath?: string;
  private onExitCallback?: (code: number) => void;
  private settled = false;
  private settleTimer: NodeJS.Timeout | null = null;
  private screenCache: string | null = null;
  private screenCacheReady = false;

  constructor(options: PtyOptions) {
    this.maxScrollback = options.scrollbackBytes;
    this.tmuxId = options.tmuxSessionId;
    this.remoteHost = options.remoteHost;
    this.socketPath = options.socketPath;
    this.onExitCallback = options.onExit;

    this.vterm = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: 10000,
      allowProposedApi: true,
    });

    // Shell-safe quoting for working directory (mkdir -p so new dirs work)
    const safeDir = options.workingDir?.replace(/'/g, "'\\''");
    const cdPrefix = options.workingDir
      ? `mkdir -p '${safeDir}' && cd '${safeDir}' && `
      : '';

    const launcherPath = resolve(import.meta.dirname ?? '.', '..', 'scripts', 'launch-claude.sh');

    // Remote: Claude installer only when profile is claude (or legacy: no profile + command claude).
    // Do not use `command === 'claude'` alone — must match launch profile so shell/cursor never hit the installer.
    const useClaudeRemoteInstaller =
      !!this.remoteHost &&
      (options.launchProfile === 'claude' ||
        (options.launchProfile == null && options.command === 'claude'));

    // Build the command to run inside tmux (local sessions only — set below)
    let innerCommand: string;

    if (this.remoteHost && !useClaudeRemoteInstaller) {
      // Remote shell / Cursor / etc. — must NOT use launch-claude-remote.sh (that forwards args to `claude`)
      const remoteScript = `/tmp/claude-proxy-launch-${this.tmuxId}.sh`;
      // Remote shell: omit bash `-l` — on some LXC/minimal setups it surfaces as "unknown option '-l'"
      // (or was passed through to `claude` when the wrong remote path ran). Plain bash is enough here.
      let remoteArgs = [...options.args];
      if (options.launchProfile === 'shell') {
        remoteArgs = remoteArgs.filter(a => a !== '-l');
      }
      const remoteCmdLine = [options.command, ...remoteArgs].join(' ');
      let innerGeneric: string;
      if (options.runAsUser) {
        innerGeneric = `su - ${options.runAsUser} -c '${cdPrefix}${remoteCmdLine}'`;
      } else {
        innerGeneric = `${cdPrefix}${remoteCmdLine}`;
      }
      // Ensure prerequisites on remote host before launching
      try {
        const checkResult = execSync(
          `ssh ${this.remoteHost} "which tmux && which ${options.command}"`,
          { stdio: 'pipe', timeout: 15000 },
        ).toString();
        console.log(`[remote-prereq] ${this.remoteHost}: ${checkResult.trim().replace(/\n/g, ', ')}`);
      } catch {
        // Something missing — try to install
        console.log(`[remote-prereq] ${this.remoteHost}: prerequisites missing, installing...`);
        const installSteps = [
          // tmux
          `which tmux >/dev/null 2>&1 || { echo "Installing tmux..."; apt-get update -qq && apt-get install -y -qq tmux || yum install -y tmux || apk add tmux; }`,
          // cursor-agent
          ...(options.launchProfile === 'cursor' ? [
            `which cursor-agent >/dev/null 2>&1 || { echo "Installing cursor-agent..."; npm install -g @anthropic-ai/cursor-agent 2>/dev/null || echo "cursor-agent install failed — may need manual setup"; }`,
          ] : []),
        ];
        try {
          execSync(
            `ssh ${this.remoteHost} '${installSteps.join(' && ')}'`,
            { stdio: 'pipe', timeout: 120000 },
          );
          console.log(`[remote-prereq] ${this.remoteHost}: installation complete`);
        } catch (installErr: any) {
          console.error(`[remote-prereq] ${this.remoteHost}: installation failed: ${installErr.message}`);
          throw new Error(`Remote host ${this.remoteHost} missing prerequisites (tmux, ${options.command}). Auto-install failed.`);
        }
      }

      const localStaging = `/tmp/claude-proxy-generic-remote-${this.tmuxId}.sh`;
      writeFileSync(
        localStaging,
        `#!/bin/bash\nrm -f "${remoteScript}"\n${innerGeneric}\n`,
        { mode: 0o755 },
      );
      try {
        execSync(`scp -q "${localStaging}" ${this.remoteHost}:${remoteScript}`, { stdio: 'pipe' });
        try {
          unlinkSync(localStaging);
        } catch {}
        execSync(
          `ssh ${this.remoteHost} "tmux new-session -d -s ${this.tmuxId} -x ${options.cols} -y ${options.rows} ${remoteScript}"`,
          { stdio: 'pipe' },
        );
        console.log(
          `[tmux] created remote session ${this.tmuxId} on ${this.remoteHost} (profile=${options.launchProfile ?? 'legacy'} cmd=${options.command})`,
        );
      } catch (err: any) {
        try {
          unlinkSync(localStaging);
        } catch {}
        console.error(`[tmux] failed to create remote session: ${err.message}`);
        throw err;
      }
    } else if (this.remoteHost && useClaudeRemoteInstaller) {
      // Remote Claude — scp launcher + wrapper scripts, then run in tmux
      const remoteScript = `/tmp/claude-proxy-launch-${this.tmuxId}.sh`;
      const remoteLauncher = `/tmp/claude-proxy-launcher-${this.tmuxId}.sh`;
      const argsStr = options.args.length > 0 ? ' ' + options.args.join(' ') : '';
      const user = options.runAsUser;

      // Build the wrapper script that cleans up, then calls the launcher.
      // The launcher runs as root (for interactive install/update prompts).
      // CLAUDE_PROXY_CD and CLAUDE_PROXY_USER env vars tell the launcher
      // how to cd and su when it execs claude at the end.
      const wrapperLines = [
        '#!/bin/bash',
        `rm -f "${remoteScript}"`,
        `chmod +x "${remoteLauncher}"`,
        `export CLAUDE_PROXY_CD='${options.workingDir?.replace(/'/g, "'\\''") || ''}'`,
        `export CLAUDE_PROXY_USER='${user || ''}'`,
        `"${remoteLauncher}"${argsStr}`,
        'EXIT_CODE=$?',
        `rm -f "${remoteLauncher}"`,
        'if [ $EXIT_CODE -ne 0 ]; then',
        '  echo ""',
        '  echo "  Press Enter to return to lobby..."',
        '  read',
        'fi',
        'exit $EXIT_CODE',
      ];

      // Write wrapper to a local temp file, then scp both scripts
      const localWrapper = `/tmp/claude-proxy-wrapper-${this.tmuxId}.sh`;
      const launcherPath = resolve(import.meta.dirname ?? '.', '..', 'scripts', 'launch-claude-remote.sh');
      writeFileSync(localWrapper, wrapperLines.join('\n') + '\n', { mode: 0o755 });

      // Ensure tmux on remote host
      try {
        execSync(`ssh ${this.remoteHost} "which tmux"`, { stdio: 'pipe', timeout: 15000 });
      } catch {
        console.log(`[remote-prereq] ${this.remoteHost}: tmux missing, installing...`);
        try {
          execSync(`ssh ${this.remoteHost} 'apt-get update -qq && apt-get install -y -qq tmux || yum install -y tmux || apk add tmux'`, { stdio: 'pipe', timeout: 120000 });
        } catch (e: any) {
          throw new Error(`Remote host ${this.remoteHost} missing tmux. Auto-install failed: ${e.message}`);
        }
      }

      try {
        // Copy both scripts to remote
        execSync(`scp -q "${launcherPath}" ${this.remoteHost}:${remoteLauncher}`, { stdio: 'pipe' });
        execSync(`scp -q "${localWrapper}" ${this.remoteHost}:${remoteScript}`, { stdio: 'pipe' });
        // Clean up local temp
        try { unlinkSync(localWrapper); } catch {}
        // Create tmux session with the wrapper script
        execSync(`ssh ${this.remoteHost} "tmux new-session -d -s ${this.tmuxId} -x ${options.cols} -y ${options.rows} ${remoteScript}"`, { stdio: 'pipe' });
        console.log(`[tmux] created remote session ${this.tmuxId} on ${this.remoteHost}`);
      } catch (err: any) {
        try { unlinkSync(localWrapper); } catch {}
        console.error(`[tmux] failed to create remote session: ${err.message}`);
        throw err;
      }
    } else {
      // Local session — use temp script to avoid quote escaping.
      // Use 'exec su' so the launch script is replaced by su — tmux's SIGWINCH
      // reaches su directly without bash intercepting it. This fixes terminal
      // resize for non-root sessions (su - creates a new session group).
      if (options.runAsUser) {
        if (options.command === 'claude') {
          const argsStr = options.args.length > 0 ? ' ' + options.args.join(' ') : '';
          innerCommand = `exec su - ${options.runAsUser} -c '${cdPrefix}exec ${launcherPath}${argsStr}'`;
        } else {
          const innerForBash = ['exec', options.command, ...options.args].join(' ');
          const line = `${cdPrefix}bash -lc ${JSON.stringify(innerForBash)}`;
          innerCommand = `exec su - ${options.runAsUser} -c ${JSON.stringify(line)}`;
        }
      } else if (options.command === 'claude') {
        innerCommand = `${cdPrefix}${launcherPath}`;
      } else {
        innerCommand = `${cdPrefix}${[options.command, ...options.args].join(' ')}`;
      }

      const scriptPath = `/tmp/claude-proxy-launch-${this.tmuxId}.sh`;
      writeFileSync(scriptPath, `#!/bin/bash\nrm -f "${scriptPath}"\n${innerCommand}\n`, { mode: 0o755 });

      const tmuxCmd = this.socketPath
        ? `tmux -S ${this.socketPath} new-session -d -s ${this.tmuxId} -x ${options.cols} -y ${options.rows} ${scriptPath}`
        : `tmux -f ${TMUX_CONF_PATH} new-session -d -s ${this.tmuxId} -x ${options.cols} -y ${options.rows} ${scriptPath}`;
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

    // Warm screen cache async — available before vterm settles
    this.warmCache().catch(() => {});
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
    mux.socketPath = options.socketPath;
    mux.onExitCallback = options.onExit;

    mux.vterm = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: 10000,
      allowProposedApi: true,
    });

    console.log(`[tmux] reattaching to session ${mux.tmuxId}`);
    mux.attachToTmux(options.cols, options.rows);

    // Warm screen cache async — available before vterm settles
    mux.warmCache().catch(() => {});

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
    } else if (this.socketPath) {
      // Local — attach via custom socket
      this.pty = spawn('tmux', ['-S', this.socketPath, 'attach-session', '-t', this.tmuxId], {
        name: 'xterm-256color',
        cols,
        rows,
        env: process.env as Record<string, string>,
      });
    } else {
      // Local — attach via default server
      this.pty = spawn('tmux', ['-f', TMUX_CONF_PATH, 'attach-session', '-t', this.tmuxId], {
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

      // Settle detection: mark unsettled on each data chunk,
      // settled after 200ms of silence
      this.settled = false;
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.settled = true;
        // Don't invalidate cache here — getInitialScreen() prefers vterm
        // when settled, so cache is simply unused. Keeping it as fallback
        // in case settle is brief (new data arrives, resets settled=false).
      }, 200);
    });

    this.pty.onExit(({ exitCode }) => {
      console.log(`[tmux] attach exited for ${this.tmuxId} with code ${exitCode}`);
      // Check if the tmux session itself is still alive
      if (!this.isTmuxSessionAlive()) {
        console.log(`[tmux] session ${this.tmuxId} is dead`);
        this.onExitCallback?.(exitCode);
      } else {
        // tmux attach exited but session is alive — re-attach automatically
        console.log(`[tmux] session ${this.tmuxId} still alive — re-attaching...`);
        setTimeout(() => {
          try {
            this.attachToTmux(cols, rows);
            console.log(`[tmux] re-attached to ${this.tmuxId}`);
          } catch (e: any) {
            console.error(`[tmux] re-attach failed for ${this.tmuxId}: ${e.message}`);
            this.onExitCallback?.(exitCode);
          }
        }, 1000);
      }
    });
  }

  /** Local tmux argv prefix: same server as new-session / attach (-S socket or -f config). */
  private tmuxLocalCliPrefix(): string[] {
    if (this.socketPath) return ['-S', this.socketPath];
    return ['-f', TMUX_CONF_PATH];
  }

  private isTmuxSessionAlive(): boolean {
    try {
      if (this.remoteHost) {
        execSync(`ssh ${this.remoteHost} tmux has-session -t ${this.tmuxId}`, { stdio: 'pipe' });
        return true;
      }
      execFileSync('tmux', [...this.tmuxLocalCliPrefix(), 'has-session', '-t', this.tmuxId], { stdio: 'pipe' });
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
    // Resize the attached PTY client FIRST — this is the tmux client that constrains
    // the pane size. Without resizing it first, tmux resize-window is limited by the
    // smallest attached client (which is us at the old size).
    if (this.pty) {
      this.pty.resize(cols, rows);
    }
    this.vterm.resize(cols, rows);

    // Now resize the tmux window — with the attached client already at the new size,
    // the window can grow to match.
    try {
      if (this.remoteHost) {
        execSync(
          `ssh ${this.remoteHost} tmux resize-window -t ${this.tmuxId} -x ${cols} -y ${rows}`,
          { stdio: 'pipe', timeout: 3000 },
        );
      } else {
        execFileSync(
          'tmux',
          [...this.tmuxLocalCliPrefix(), 'resize-window', '-t', this.tmuxId, '-x', String(cols), '-y', String(rows)],
          { stdio: 'pipe', timeout: 3000 },
        );
      }
    } catch { /* session may not exist yet */ }

    // Send SIGWINCH to all descendant processes of the pane.
    // su - creates a new session group that doesn't receive SIGWINCH from tmux's
    // resize-window. We find all child processes and signal each one.
    if (!this.remoteHost) {
      try {
        const panePid = execFileSync(
          'tmux',
          [...this.tmuxLocalCliPrefix(), 'display-message', '-t', this.tmuxId, '-p', '#{pane_pid}'],
          { encoding: 'utf-8', timeout: 2000 },
        ).trim();
        if (panePid) {
          // Find ALL descendant PIDs recursively (su → sh → claude chain can be 4+ deep)
          const descendants: string[] = [];
          const queue = [panePid];
          while (queue.length > 0) {
            const pid = queue.shift()!;
            try {
              const children = execFileSync(
                'ps', ['--ppid', pid, '-o', 'pid=', '--no-headers'],
                { encoding: 'utf-8', timeout: 1000 },
              ).trim().split('\n').map(s => s.trim()).filter(Boolean);
              for (const child of children) {
                if (!descendants.includes(child)) {
                  descendants.push(child);
                  queue.push(child);
                }
              }
            } catch { /* no children */ }
          }
          // Signal all descendants + the pane pid itself
          const allPids = [panePid, ...descendants];
          for (const pid of allPids) {
            try {
              process.kill(parseInt(pid), 'SIGWINCH');
            } catch { /* process may have exited */ }
          }
        }
      } catch (e: any) {
        console.warn('[pty-resize] SIGWINCH broadcast failed:', e.message);
      }
    }
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
      if (this.remoteHost) {
        execSync(`ssh ${this.remoteHost} tmux kill-session -t ${this.tmuxId}`, { stdio: 'pipe' });
      } else {
        execFileSync('tmux', [...this.tmuxLocalCliPrefix(), 'kill-session', '-t', this.tmuxId], { stdio: 'pipe' });
      }
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
    this.vterm.onWriteParsed(() => {
      callback(0, this.vterm.rows);
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
   * Current mouse tracking mode requested by the running application.
   * 'none' means the app hasn't enabled mouse reporting.
   */
  getMouseMode(): 'none' | 'x10' | 'vt200' | 'drag' | 'any' {
    return this.vterm.modes.mouseTrackingMode;
  }

  /** Terminal modes relevant to input handling. */
  getInputModes(): {
    applicationCursorKeys: boolean;
    bracketedPaste: boolean;
    sendFocus: boolean;
  } {
    const m = this.vterm.modes;
    return {
      applicationCursorKeys: m.applicationCursorKeysMode,
      bracketedPaste: m.bracketedPasteMode,
      sendFocus: m.sendFocusMode,
    };
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

  /**
   * Whether the vterm has finished receiving initial data from tmux.
   * True after 200ms of no PTY data.
   */
  isSettled(): boolean {
    return this.settled;
  }

  /**
   * Async cache warm — reads current screen from tmux directly.
   * Called once at reattach/creation. Cache is served until vterm settles,
   * then invalidated (vterm becomes authoritative).
   */
  async warmCache(): Promise<void> {
    try {
      if (this.remoteHost) {
        const args = this.socketPath
          ? ['-S', this.socketPath, 'capture-pane', '-p', '-e', '-t', this.tmuxId]
          : ['capture-pane', '-p', '-e', '-t', this.tmuxId];
        const stdout = await execFileAsync('ssh', [this.remoteHost, 'tmux', ...args], { encoding: 'utf-8', timeout: 5000 });
        this.screenCache = stdout;
      } else {
        const stdout = await execFileAsync(
          'tmux',
          [...this.tmuxLocalCliPrefix(), 'capture-pane', '-p', '-e', '-t', this.tmuxId],
          { encoding: 'utf-8', timeout: 2000 },
        );
        this.screenCache = stdout;
      }
      this.screenCacheReady = true;
    } catch {
      // tmux not ready yet or session gone — no cache, fall back to vterm
      this.screenCache = null;
      this.screenCacheReady = false;
    }
  }

  /**
   * Get the best available screen content for initial client connection.
   * Priority: settled vterm > cache > unsettled vterm (partial, best effort).
   */
  getInitialScreen(): { source: 'vterm' | 'cache' | 'vterm-partial'; buffer?: any; text?: string } {
    if (this.settled) {
      return { source: 'vterm', buffer: this.vterm.buffer.active };
    }
    if (this.screenCacheReady && this.screenCache) {
      return { source: 'cache', text: this.screenCache };
    }
    return { source: 'vterm-partial', buffer: this.vterm.buffer.active };
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

  getSocketPath(): string | undefined {
    return this.socketPath;
  }

  getHistorySize(): number {
    try {
      if (this.remoteHost) {
        const output = execSync(
          `ssh ${this.remoteHost} tmux display-message -t ${this.tmuxId} -p '#{history_size}'`,
          { encoding: 'utf-8', timeout: 2000 },
        ).trim();
        return parseInt(output) || 0;
      }
      const output = execFileSync(
        'tmux',
        [...this.tmuxLocalCliPrefix(), 'display-message', '-t', this.tmuxId, '-p', '#{history_size}'],
        { encoding: 'utf-8', timeout: 2000 },
      ).trim();
      return parseInt(output) || 0;
    } catch {
      return 0;
    }
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
      // Use execFileSync — a shell string breaks: `#` in #{...} can be parsed as a comment and drop the format.
      const output = execFileSync(
        'tmux',
        ['-f', TMUX_CONF_PATH, 'list-sessions', '-F', '#{session_name}|#{session_created}'],
        { encoding: 'utf-8' },
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
