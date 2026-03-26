// src/session-manager.ts

import { randomUUID } from 'crypto';
import { spawn as ptySpawn } from 'node-pty';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
  lessPtys: Map<string, { pty: ReturnType<typeof ptySpawn>; tmpFile: string }>;
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
      rows: creator.termSize.rows - 2,
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
      lessPtys: new Map(),
    };

    this.sessions.set(id, session);
    this.joinSession(id, creator);

    return session;
  }

  joinSession(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.clients.set(client.id, client);

    // Enter alternate screen for clean status bar
    client.write(enterAltScreen());

    // Set up scroll region on client
    const contentRows = client.termSize.rows - 2;
    client.write(setScrollRegion(1, contentRows));

    // Attach to PTY output
    session.pty.attach(client);

    // Set up hotkey handler for this client
    const hotkey = new HotkeyHandler({
      onPassthrough: (data) => {
        session.statusBar.recordKeystroke(client.username);
        client.lastKeystroke = Date.now();
        session.pty.write(data);
        this.refreshStatusBars(sessionId);
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
    const lessPty = session.lessPtys.get(client.id);
    if (lessPty) {
      lessPty.pty.kill();
      try { unlinkSync(lessPty.tmpFile); } catch {}
      session.lessPtys.delete(client.id);
    }

    session.pty.detach(client);
    session.clients.delete(client.id);
    session.hotkeys.get(client.id)?.destroy();
    session.hotkeys.delete(client.id);

    // Leave alternate screen
    client.write(leaveAltScreen());

    // Transfer size ownership if owner left
    if (session.sizeOwner === client.id && session.clients.size > 0) {
      const nextOwner = session.clients.values().next().value!;
      session.sizeOwner = nextOwner.id;
      session.pty.resize(nextOwner.termSize.cols, nextOwner.termSize.rows - 2);
    }

    this.refreshStatusBars(sessionId);
  }

  handleInput(sessionId: string, client: Client, data: Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // If client is in less scrollback mode, route input to less PTY
    const lessPty = session.lessPtys.get(client.id);
    if (lessPty) {
      lessPty.pty.write(data.toString());
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
      session.pty.resize(size.cols, size.rows - 2);
    }

    this.refreshStatusBars(sessionId);
  }

  claimSizeOwner(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.sizeOwner = client.id;
    session.pty.resize(client.termSize.cols, client.termSize.rows - 2);
    this.refreshStatusBars(sessionId);
  }

  setOnClientDetach(sessionId: string, callback: (client: Client) => void): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.onClientDetach = callback;
    }
  }

  private redrawClient(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Detach, clear screen, re-enter alternate screen, re-attach (replays scrollback)
    session.pty.detach(client);
    client.write(enterAltScreen());
    const contentRows = client.termSize.rows - 2;
    client.write(setScrollRegion(1, contentRows));
    session.pty.attach(client);
    this.refreshStatusBars(sessionId);
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

    // Re-enter the session view: alternate screen, scroll region, re-attach
    client.write(enterAltScreen());
    const contentRows = client.termSize.rows - 2;
    client.write(setScrollRegion(1, contentRows));

    // Re-attach to PTY (replays scrollback so client sees current state)
    session.pty.attach(client);

    this.refreshStatusBars(sessionId);
  }

  private async enterLessScrollback(sessionId: string, client: Client): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Write readable scrollback to a temp file (interpreted by headless xterm)
    const tmpFile = join(tmpdir(), `claude-proxy-scrollback-${randomUUID()}.txt`);
    const content = await session.pty.getReadableScrollback();
    console.log(`[less] readable scrollback: ${content.length} chars, ${content.split('\n').length} lines`);
    // Also write a debug copy that doesn't get deleted
    writeFileSync('/tmp/claude-proxy-scrollback-debug.txt', content);
    writeFileSync(tmpFile, content);
    console.log(`[less] wrote ${tmpFile}`);

    // Detach from live PTY
    session.pty.detach(client);

    // Spawn less in a new PTY attached to the client
    console.log(`[less] spawning less for ${client.username} (${client.termSize.cols}x${client.termSize.rows})`);
    const lessPty = ptySpawn('less', ['-RS', '--mouse', '--wheel-lines=3', tmpFile], {
      name: 'xterm-256color',
      cols: client.termSize.cols,
      rows: client.termSize.rows,
      env: { ...process.env as Record<string, string>, TERM: 'xterm-256color', LESSCHARSET: 'utf-8' },
    });

    lessPty.onData((data: string) => {
      client.write(data);
    });

    lessPty.onExit(({ exitCode }) => {
      console.log(`[less] exited with code ${exitCode} for ${client.username}`);
      try { unlinkSync(tmpFile); } catch {}
      session.lessPtys.delete(client.id);
      this.exitLessScrollback(sessionId, client);
    });

    session.lessPtys.set(client.id, { pty: lessPty, tmpFile });
  }

  private exitLessScrollback(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Re-enter the session view
    client.write(enterAltScreen());
    const contentRows = client.termSize.rows - 2;
    client.write(setScrollRegion(1, contentRows));
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
