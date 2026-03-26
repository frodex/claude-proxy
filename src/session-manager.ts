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
      onExit: () => {
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
    });
    session.hotkeys.set(client.id, hotkey);

    this.refreshStatusBars(sessionId);
  }

  leaveSession(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Exit scrollback if active
    session.scrollbackViewers.delete(client.id);

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

    // If client is in scrollback mode, route input there
    const viewer = session.scrollbackViewers.get(client.id);
    if (viewer) {
      viewer.handleInput(data);
      return;
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
