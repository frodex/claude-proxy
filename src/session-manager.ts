// src/session-manager.ts

import { randomUUID } from 'crypto';
import { PtyMultiplexer } from './pty-multiplexer.js';
import { StatusBar } from './status-bar.js';
import { HotkeyHandler } from './hotkey.js';
import { setScrollRegion, enterAltScreen, leaveAltScreen } from './ansi.js';
import { renderMenu, getActionAtCursor, findItemByKey, nextSelectable, type MenuSection } from './interactive-menu.js';
import { ScrollbackViewer } from './scrollback-viewer.js';
import { saveSessionMeta, loadSessionMeta, deleteSessionMeta } from './session-store.js';
import { canUserAccessSession } from './user-utils.js';
import type { Client, Session, SessionAccess } from './types.js';

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
  dumpMode: Set<string>;
  helpMenu: Map<string, number>;  // client ID -> cursor position
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

  /**
   * Discover existing tmux sessions from a previous proxy instance and reattach
   */
  discoverSessions(): void {
    const tmuxSessions = PtyMultiplexer.listTmuxSessions();
    console.log(`[discover] found ${tmuxSessions.length} existing tmux sessions`);

    for (const ts of tmuxSessions) {
      const id = ts.tmuxId;

      try {
        // Load persisted metadata (access control, etc.)
        const meta = loadSessionMeta(ts.tmuxId);
        const sessionAccess: SessionAccess = meta?.access ?? {
          owner: 'root',
          hidden: false,
          public: true,
          allowedUsers: [],
          allowedGroups: [],
          passwordHash: null,
          viewOnly: false,
        };

        const pty = PtyMultiplexer.reattach({
          tmuxSessionId: ts.tmuxId,
          cols: 120,
          rows: 40,
          scrollbackBytes: this.options.scrollbackBytes,
          onExit: (code) => {
            console.log(`[session-exit] "${ts.name}" (${id}) exited with code ${code}`);
            deleteSessionMeta(id);
            this.sessions.delete(id);
            this.onSessionEndCallback?.(id);
          },
        });

        const session: ManagedSession = {
          id,
          name: meta?.name ?? ts.name,
          runAsUser: meta?.runAsUser ?? this.options.defaultUser,
          createdAt: meta ? new Date(meta.createdAt) : ts.created,
          sizeOwner: '',
          clients: new Map(),
          access: sessionAccess,
          pty,
          statusBar: new StatusBar(),
          hotkeys: new Map(),
          scrollbackViewers: new Map(),
          dumpMode: new Set(),
      helpMenu: new Map(),
        };

        this.sessions.set(id, session);
        console.log(`[discover] reattached to "${session.name}" (owner: ${sessionAccess.owner}, public: ${sessionAccess.public})`);
      } catch (err: any) {
        console.error(`[discover] failed to reattach to ${ts.tmuxId}: ${err.message}`);
      }
    }
  }

  createSession(
    name: string,
    creator: Client,
    runAsUser?: string,
    command: string = 'claude',
    access?: Partial<SessionAccess>,
    commandArgs: string[] = [],
  ): Session {
    if (this.sessions.size >= this.options.maxSessions) {
      throw new Error(`Cannot create session: max sessions (${this.options.maxSessions}) reached`);
    }

    // tmux session names: cp-<sanitized-name>
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const tmuxId = `cp-${safeName}`;
    const user = runAsUser ?? this.options.defaultUser;

    const sessionAccess: SessionAccess = {
      owner: creator.username,
      hidden: access?.hidden ?? false,
      public: access?.public ?? true,
      allowedUsers: access?.allowedUsers ?? [],
      allowedGroups: access?.allowedGroups ?? [],
      passwordHash: access?.passwordHash ?? null,
      viewOnly: access?.viewOnly ?? false,
    };

    const pty = new PtyMultiplexer({
      command,
      args: commandArgs,
      cols: creator.termSize.cols,
      rows: creator.termSize.rows,
      scrollbackBytes: this.options.scrollbackBytes,
      tmuxSessionId: tmuxId,
      runAsUser: user,
      onExit: (code) => {
        console.log(`[session-exit] "${name}" (${tmuxId}) exited with code ${code}`);
        deleteSessionMeta(tmuxId);
        this.sessions.delete(tmuxId);
        this.onSessionEndCallback?.(tmuxId);
      },
    });

    const session: ManagedSession = {
      id: tmuxId,
      name,
      runAsUser: user,
      createdAt: new Date(),
      sizeOwner: creator.id,
      clients: new Map(),
      access: sessionAccess,
      pty,
      statusBar: new StatusBar(),
      hotkeys: new Map(),
      scrollbackViewers: new Map(),
      dumpMode: new Set(),
      helpMenu: new Map(),
    };

    // Persist metadata for restart recovery
    saveSessionMeta(tmuxId, {
      tmuxId,
      name,
      runAsUser: user,
      createdAt: session.createdAt.toISOString(),
      access: sessionAccess,
    });

    this.sessions.set(tmuxId, session);
    this.joinSession(tmuxId, creator);

    return session;
  }

  joinSession(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.clients.set(client.id, client);

    // Set size owner if none set (e.g., reattached session)
    if (!session.sizeOwner) {
      session.sizeOwner = client.id;
      session.pty.resize(client.termSize.cols, client.termSize.rows);
    }

    client.write('\x1b[2J\x1b[H');
    session.pty.attach(client);
    this.updateTitle(sessionId);

    const hotkey = new HotkeyHandler({
      onPassthrough: (data) => {
        // View-only: block input from non-owners
        if (session.access.viewOnly && client.username !== session.access.owner) {
          return;
        }
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
  }

  leaveSession(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    console.log(`[leave] ${client.username} left "${session.name}" (${session.clients.size - 1} remaining)`);

    session.scrollbackViewers.delete(client.id);
    session.dumpMode.delete(client.id);

    session.pty.detach(client);
    session.clients.delete(client.id);
    session.hotkeys.get(client.id)?.destroy();
    session.hotkeys.delete(client.id);

    client.write('\x1b[2J\x1b[H');

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

    // Help menu active
    if (session.helpMenu.has(client.id)) {
      const str = data.toString();
      let cursor = session.helpMenu.get(client.id) ?? 0;

      if (str === '\x1b' && data.length === 1) {
        this.handleHelpAction(sessionId, client, 'back');
        return;
      }
      if (str === '\x1b[A') {
        cursor = nextSelectable(this.helpSections, cursor, -1);
        session.helpMenu.set(client.id, cursor);
        client.write(renderMenu({ title: 'claude-proxy help', sections: this.helpSections, footer: 'arrows to navigate, enter/space to select, esc to return', cursor }));
        return;
      }
      if (str === '\x1b[B') {
        cursor = nextSelectable(this.helpSections, cursor, 1);
        session.helpMenu.set(client.id, cursor);
        client.write(renderMenu({ title: 'claude-proxy help', sections: this.helpSections, footer: 'arrows to navigate, enter/space to select, esc to return', cursor }));
        return;
      }
      if (str === '\r' || str === '\n' || str === ' ') {
        const action = getActionAtCursor(this.helpSections, cursor);
        if (action) this.handleHelpAction(sessionId, client, action);
        return;
      }
      // Shortcut keys
      const found = findItemByKey(this.helpSections, str);
      if (found) {
        this.handleHelpAction(sessionId, client, found.action);
        return;
      }
      return;
    }

    if (session.dumpMode.has(client.id)) {
      this.exitLessScrollback(sessionId, client);
      return;
    }

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

  private helpSections: MenuSection[] = [
    {
      title: 'Session actions',
      items: [
        { label: 'Back to session', key: 'esc', action: 'back' },
        { label: 'Detach (back to lobby)', key: 'd', action: 'detach' },
        { label: 'Claim size ownership', key: 's', action: 'claimSize' },
        { label: 'Redraw screen', key: 'r', action: 'redraw' },
        { label: 'Scrollback dump (terminal scrollbar)', key: 'l', action: 'scrolldump' },
        { label: 'Scrollback viewer (arrows/pgup/pgdn)', key: 'b', action: 'scrollview' },
      ],
    },
    {
      title: 'Info',
      items: [
        { label: 'Title bar: session | *owner, users | uptime', action: 'none', disabled: true },
        { label: 'Sessions persist across proxy restarts', action: 'none', disabled: true },
      ],
    },
  ];

  private showHelp(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.pty.detach(client);
    session.helpMenu.set(client.id, 0);

    const output = renderMenu({
      title: 'claude-proxy help',
      sections: this.helpSections,
      footer: 'arrows to navigate, enter/space to select, esc to return',
      cursor: 0,
    });
    client.write(output);
  }

  private handleHelpAction(sessionId: string, client: Client, action: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.helpMenu.delete(client.id);

    switch (action) {
      case 'back':
        client.write('\x1b[2J\x1b[H');
        session.pty.attach(client);
        break;
      case 'detach':
        this.leaveSession(sessionId, client);
        session.onClientDetach?.(client);
        break;
      case 'claimSize':
        this.claimSizeOwner(sessionId, client);
        client.write('\x1b[2J\x1b[H');
        session.pty.attach(client);
        break;
      case 'redraw':
        this.redrawClient(sessionId, client);
        break;
      case 'scrolldump':
        session.pty.attach(client);  // re-attach first
        this.enterLessScrollback(sessionId, client);
        break;
      case 'scrollview':
        session.pty.attach(client);
        this.enterScrollback(sessionId, client);
        break;
    }
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

    const osc = `\x1b]0;[Ctrl-B h help] ${title}\x07`;
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

  /**
   * List sessions visible to a specific user (filtered by access control)
   */
  listSessionsForUser(username: string): Session[] {
    return Array.from(this.sessions.values()).filter(session =>
      canUserAccessSession(username, session.access)
    );
  }

  /**
   * Check if a user can join a specific session
   */
  canUserJoin(username: string, sessionId: string): { allowed: boolean; needsPassword: boolean } {
    const session = this.sessions.get(sessionId);
    if (!session) return { allowed: false, needsPassword: false };

    if (!canUserAccessSession(username, session.access)) {
      return { allowed: false, needsPassword: false };
    }

    if (session.access.passwordHash) {
      return { allowed: true, needsPassword: true };
    }

    return { allowed: true, needsPassword: false };
  }

  /**
   * Destroy a session — kills the tmux session
   */
  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const hotkey of session.hotkeys.values()) {
      hotkey.destroy();
    }
    session.pty.destroy();
    this.sessions.delete(sessionId);
  }

  /**
   * Graceful shutdown — detach from all tmux sessions without killing them
   */
  detachAll(): void {
    console.log(`[shutdown] detaching from ${this.sessions.size} sessions (tmux sessions will persist)`);
    for (const session of this.sessions.values()) {
      for (const hotkey of session.hotkeys.values()) {
        hotkey.destroy();
      }
      session.pty.detachFromTmux();
    }
    this.sessions.clear();
  }

  /**
   * Hard destroy all — kills tmux sessions too
   */
  destroyAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.destroySession(id);
    }
  }

  private enterScrollback(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

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

    client.write('\x1b[2J\x1b[H');
    session.pty.attach(client);
  }

  private async enterLessScrollback(sessionId: string, client: Client): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const content = await session.pty.getReadableScrollback();
    console.log(`[scrolldump] ${content.length} chars, ${content.split('\n').length} lines`);

    session.pty.detach(client);

    client.write('\x1b[2J\x1b[H');
    const lines = content.split('\n');
    for (const line of lines) {
      client.write(line + '\r\n');
    }

    client.write('\r\n\x1b[7m === SCROLLBACK DUMP === Scroll up with PuTTY scrollbar or Shift+PgUp === Press any key to return === \x1b[0m');

    session.dumpMode.add(client.id);
  }

  private exitLessScrollback(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.dumpMode.delete(client.id);

    client.write('\x1b[2J\x1b[H');
    session.pty.attach(client);
  }

  private refreshStatusBars(sessionId: string): void {
    // Status bar rendering disabled (using title bar instead)
    // Keeping method for future Phase 3 web UI
  }
}
