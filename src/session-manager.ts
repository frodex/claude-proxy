// src/session-manager.ts

import { randomUUID } from 'crypto';
import { PtyMultiplexer } from './pty-multiplexer.js';
import { StatusBar } from './status-bar.js';
import { HotkeyHandler } from './hotkey.js';
import { setScrollRegion, enterAltScreen, leaveAltScreen } from './ansi.js';
import { ScrollbackViewer } from './scrollback-viewer.js';
import type { Client, Session } from './types.js';

interface SessionManagerOptions {
  defaultUser: string;
  scrollbackBytes: number;
  maxSessions: number;
}

interface ManagedSession extends Session {
  pty: PtyMultiplexer;
  statusBar: StatusBar;
  hotkeys: Map<string, HotkeyHandler>;
  scrollbackViewers: Map<string, ScrollbackViewer>;
  dumpMode: Set<string>;  // client IDs in scrollback dump mode
  onClientDetach?: (client: Client) => void;
}

export class SessionManager {
  private sessions: Map<string, ManagedSession> = new Map();
  private options: SessionManagerOptions;
  private onSessionEndCallback?: (sessionId: string) => void;

  constructor(options: SessionManagerOptions) {
    this.options = options;
  }

  setOnSessionEnd(callback: (sessionId: string) => void): void {
    this.onSessionEndCallback = callback;
  }

  createSession(
    name: string,
    creator: Client,
    runAsUser?: string,
    command: string = 'claude',
  ): Session {
    if (this.sessions.size >= this.options.maxSessions) {
      throw new Error(`Cannot create session: max sessions (${this.options.maxSessions}) reached`);
    }

    const id = randomUUID();
    const user = runAsUser ?? this.options.defaultUser;

    const pty = new PtyMultiplexer({
      command,
      args: [],
      cols: creator.termSize.cols,
      rows: creator.termSize.rows,
      scrollbackBytes: this.options.scrollbackBytes,
      runAsUser: user !== (process.env.USER ?? 'root') ? user : undefined,
      onExit: (code) => {
        console.log(`[session-exit] "${name}" (${id}) exited with code ${code}`);
        this.destroySession(id);
        this.onSessionEndCallback?.(id);
      },
    });

    const session: ManagedSession = {
      id,
      name,
      runAsUser: user,
      createdAt: new Date(),
      sizeOwner: creator.id,
      clients: new Map(),
      pty,
      statusBar: new StatusBar(),
      hotkeys: new Map(),
      scrollbackViewers: new Map(),
      dumpMode: new Set(),
    };

    this.sessions.set(id, session);
    this.joinSession(id, creator);

    return session;
  }

  joinSession(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.clients.set(client.id, client);

    // Clear screen and attach to PTY output (no alternate screen — native scrolling works)
    client.write('\x1b[2J\x1b[H');
    session.pty.attach(client);
    this.updateTitle(sessionId);

    // Set up hotkey handler for this client
    const hotkey = new HotkeyHandler({
      onPassthrough: (data) => {
        client.lastKeystroke = Date.now();
        session.statusBar.recordKeystroke(client.username);
        session.pty.write(data);
        this.updateTitle(sessionId);
      },
      onDetach: () => {
        this.leaveSession(sessionId, client);
        session.onClientDetach?.(client);
      },
      onClaimSize: () => {
        this.claimSizeOwner(sessionId, client);
      },
      onScrollback: () => {
        this.enterScrollback(sessionId, client);
      },
      onRedraw: () => {
        this.redrawClient(sessionId, client);
      },
      onLessScrollback: () => {
        this.enterLessScrollback(sessionId, client);
      },
      onHelp: () => {
        this.showHelp(sessionId, client);
      },
    });
    session.hotkeys.set(client.id, hotkey);

    this.refreshStatusBars(sessionId);
  }

  leaveSession(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    console.log(`[leave] ${client.username} left "${session.name}" (${session.clients.size - 1} remaining)`);

    // Exit scrollback if active
    session.scrollbackViewers.delete(client.id);
    session.dumpMode.delete(client.id);

    session.pty.detach(client);
    session.clients.delete(client.id);
    session.hotkeys.get(client.id)?.destroy();
    session.hotkeys.delete(client.id);

    // Clear screen before returning to lobby
    client.write('\x1b[2J\x1b[H');

    // Transfer size ownership if owner left
    if (session.sizeOwner === client.id && session.clients.size > 0) {
      const nextOwner = session.clients.values().next().value!;
      session.sizeOwner = nextOwner.id;
      session.pty.resize(nextOwner.termSize.cols, nextOwner.termSize.rows);
    }
    this.updateTitle(sessionId);
  }

  handleInput(sessionId: string, client: Client, data: Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // If client is in scrollback dump mode, any key returns to session
    if (session.dumpMode.has(client.id)) {
      this.exitLessScrollback(sessionId, client);
      return;
    }

    // If client is in scrollback mode, route input there
    const viewer = session.scrollbackViewers.get(client.id);
    if (viewer) {
      viewer.handleInput(data);
      return;
    }

    // Debug: log raw input bytes
    if (data.length <= 4) {
      console.log(`[input] ${client.username}: ${Array.from(data).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')}`);
    }

    const hotkey = session.hotkeys.get(client.id);
    if (hotkey) {
      hotkey.feed(data);
    }
  }

  handleResize(sessionId: string, client: Client, size: { cols: number; rows: number }): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    client.termSize = size;

    if (session.sizeOwner === client.id) {
      session.pty.resize(size.cols, size.rows);
    }
  }

  claimSizeOwner(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.sizeOwner = client.id;
    session.pty.resize(client.termSize.cols, client.termSize.rows);
  }

  setOnClientDetach(sessionId: string, callback: (client: Client) => void): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.onClientDetach = callback;
    }
  }

  private showHelp(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Detach from PTY while showing help
    session.pty.detach(client);
    session.dumpMode.add(client.id);

    const help = [
      '',
      '  \x1b[1mclaude-proxy help\x1b[0m',
      '  ─────────────────────────────────────',
      '',
      '  \x1b[1mIn session:\x1b[0m  (press Ctrl+B, release, then key)',
      '',
      '    Ctrl+B  d     Detach (back to lobby)',
      '    Ctrl+B  s     Claim size ownership',
      '    Ctrl+B  r     Redraw screen',
      '    Ctrl+B  l     Scrollback dump (use terminal scrollbar)',
      '    Ctrl+B  h     Scrollback viewer (arrows/pgup/pgdn)',
      '    Ctrl+B  ?     This help',
      '    Ctrl+B  Ctrl+B   Send literal Ctrl+B',
      '',
      '  \x1b[1mIn lobby:\x1b[0m',
      '',
      '    n         New session',
      '    r         Refresh',
      '    q         Quit',
      '    Up/Down   Navigate sessions',
      '    Enter/1-9 Join session',
      '',
      '  \x1b[1mTitle bar:\x1b[0m  session name | *owner, users | uptime',
      '',
      '  ─────────────────────────────────────',
      '  \x1b[7m Press any key to return \x1b[0m',
      '',
    ];

    client.write('\x1b[2J\x1b[H');
    client.write(help.join('\r\n'));
  }

  private updateTitle(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const users = Array.from(session.clients.values()).map(c => {
      const prefix = c.id === session.sizeOwner ? '*' : '';
      const typing = session.statusBar.isTyping(c.username) ? ' ⌨' : '';
      return `${prefix}${c.username}${typing}`;
    });

    const uptime = this.formatUptime(session.createdAt);
    const title = `${session.name} | ${users.join(', ')} | ${uptime}`;

    // Set terminal title via OSC escape for all clients in this session
    const osc = `\x1b]0;claude-proxy: ${title}\x07`;
    for (const client of session.clients.values()) {
      client.write(osc);
    }
  }

  private formatUptime(created: Date): string {
    const ms = Date.now() - created.getTime();
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h${mins > 0 ? mins + 'm' : ''}`;
  }

  private redrawClient(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Detach, clear screen, re-attach (replays scrollback)
    session.pty.detach(client);
    client.write('\x1b[2J\x1b[H');
    session.pty.attach(client);
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const hotkey of session.hotkeys.values()) {
      hotkey.destroy();
    }
    session.pty.destroy();
    this.sessions.delete(sessionId);
  }

  destroyAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.destroySession(id);
    }
  }

  private enterScrollback(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Detach from live PTY output while viewing scrollback
    session.pty.detach(client);

    const viewer = new ScrollbackViewer({
      content: session.pty.getScrollbackText(),
      cols: client.termSize.cols,
      rows: client.termSize.rows,
      write: (data) => client.write(data),
      onExit: () => {
        this.exitScrollback(sessionId, client);
      },
    });

    session.scrollbackViewers.set(client.id, viewer);
  }

  private exitScrollback(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.scrollbackViewers.delete(client.id);

    // Re-attach to PTY (replays scrollback so client sees current state)
    client.write('\x1b[2J\x1b[H');
    session.pty.attach(client);
  }

  private async enterLessScrollback(sessionId: string, client: Client): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const content = await session.pty.getReadableScrollback();
    console.log(`[scrolldump] ${content.length} chars, ${content.split('\n').length} lines`);

    // Detach from live PTY
    session.pty.detach(client);

    // Leave alternate screen so PuTTY's native scrollback works
    client.write(leaveAltScreen());

    // Clear screen and dump content as plain text
    client.write('\x1b[2J\x1b[H');
    // Write line by line with \r\n for proper rendering
    const lines = content.split('\n');
    for (const line of lines) {
      client.write(line + '\r\n');
    }

    // Separator and prompt
    client.write('\r\n\x1b[7m === SCROLLBACK DUMP === Scroll up with PuTTY scrollbar or Shift+PgUp === Press any key to return === \x1b[0m');

    // Mark client as in "dump" mode — next keypress returns to session
    session.dumpMode.add(client.id);
  }

  private exitLessScrollback(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.dumpMode.delete(client.id);

    // Re-attach to session
    client.write('\x1b[2J\x1b[H');
    session.pty.attach(client);
    this.refreshStatusBars(sessionId);
  }

  private refreshStatusBars(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const users = Array.from(session.clients.values()).map(c => ({
      username: c.username,
      isSizeOwner: c.id === session.sizeOwner,
      isTyping: session.statusBar.isTyping(c.username),
    }));

    for (const client of session.clients.values()) {
      const statusOutput = session.statusBar.renderStatusOnly({
        sessionName: session.name,
        users,
        clientRows: client.termSize.rows,
        clientCols: client.termSize.cols,
      });
      client.write(statusOutput);
    }
  }
}
