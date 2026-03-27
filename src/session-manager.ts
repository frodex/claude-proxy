// src/session-manager.ts

import { randomUUID, createHash } from 'crypto';
import { PtyMultiplexer } from './pty-multiplexer.js';
import { StatusBar } from './status-bar.js';
import { HotkeyHandler } from './hotkey.js';
import { setScrollRegion, enterAltScreen, leaveAltScreen } from './ansi.js';
import { renderMenu, getActionAtCursor, findItemByKey, nextSelectable, type MenuSection, type MenuItem } from './interactive-menu.js';
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
  helpMenu: Map<string, number>;
  editMenu: Map<string, { step: string; cursor: number; buffer?: string }>;
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
      editMenu: new Map(),
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
      editMenu: new Map(),
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
      onEditSession: () => {
        this.startEditSession(sessionId, client);
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

    // Edit session settings menu
    if (session.editMenu.has(client.id)) {
      const str = data.toString();
      const edit = session.editMenu.get(client.id)!;

      // Sub-state: password input
      if (edit.step === 'password') {
        if (str === '\x1b' && data.length === 1) { edit.step = 'menu'; this.renderEditMenu(sessionId, client); return; }
        if (str === '\x7f' || str === '\b') {
          if (edit.buffer && edit.buffer.length > 0) { edit.buffer = edit.buffer.slice(0, -1); client.write('\b \b'); }
          return;
        }
        if (str === '\r' || str === '\n') {
          if (edit.buffer && edit.buffer.length > 0) {
            session.access.passwordHash = createHash('sha256').update(edit.buffer).digest('hex');
          }
          edit.step = 'menu'; edit.buffer = '';
          this.renderEditMenu(sessionId, client);
          return;
        }
        if (!edit.buffer) edit.buffer = '';
        edit.buffer += str;
        client.write('*');
        return;
      }

      // Sub-state: edit users (type username, enter to add, backspace on empty to remove last)
      if (edit.step === 'users') {
        if (str === '\x1b' && data.length === 1) { edit.step = 'menu'; this.renderEditMenu(sessionId, client); return; }
        if (str === '\x7f' || str === '\b') {
          if (edit.buffer && edit.buffer.length > 0) { edit.buffer = edit.buffer.slice(0, -1); client.write('\b \b'); }
          else if (session.access.allowedUsers.length > 0) {
            const removed = session.access.allowedUsers.pop();
            this.renderUserEditor(client, session.access.allowedUsers, '');
          }
          return;
        }
        if (str === '\r' || str === '\n') {
          if (edit.buffer && edit.buffer.trim()) {
            const user = edit.buffer.trim();
            if (!session.access.allowedUsers.includes(user)) session.access.allowedUsers.push(user);
            edit.buffer = '';
          } else {
            edit.step = 'menu';
            this.renderEditMenu(sessionId, client);
            return;
          }
          this.renderUserEditor(client, session.access.allowedUsers, '');
          return;
        }
        if (!edit.buffer) edit.buffer = '';
        edit.buffer += str;
        client.write(str);
        return;
      }

      // Sub-state: edit groups
      if (edit.step === 'groups') {
        if (str === '\x1b' && data.length === 1) { edit.step = 'menu'; this.renderEditMenu(sessionId, client); return; }
        if (str === '\x7f' || str === '\b') {
          if (edit.buffer && edit.buffer.length > 0) { edit.buffer = edit.buffer.slice(0, -1); client.write('\b \b'); }
          else if (session.access.allowedGroups.length > 0) {
            session.access.allowedGroups.pop();
            this.renderGroupEditor(client, session.access.allowedGroups, '');
          }
          return;
        }
        if (str === '\r' || str === '\n') {
          if (edit.buffer && edit.buffer.trim()) {
            const group = edit.buffer.trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
            if (group && !session.access.allowedGroups.includes(group)) session.access.allowedGroups.push(group);
            edit.buffer = '';
          } else {
            edit.step = 'menu';
            this.renderEditMenu(sessionId, client);
            return;
          }
          this.renderGroupEditor(client, session.access.allowedGroups, '');
          return;
        }
        if (!edit.buffer) edit.buffer = '';
        edit.buffer += str;
        client.write(str);
        return;
      }

      // Main menu state
      const sections = this.buildEditSections(session.access);

      if (str === '\x1b' && data.length === 1) {
        session.editMenu.delete(client.id);
        client.write('\x1b[2J\x1b[H');
        session.pty.attach(client);
        return;
      }
      if (str === '\x1b[A' || str === '\x1bOA') {
        edit.cursor = nextSelectable(sections, edit.cursor, -1);
        this.renderEditMenu(sessionId, client);
        return;
      }
      if (str === '\x1b[B' || str === '\x1bOB') {
        edit.cursor = nextSelectable(sections, edit.cursor, 1);
        this.renderEditMenu(sessionId, client);
        return;
      }

      const doAction = (action: string | null) => {
        if (!action) return false;
        if (action === 'save' || action === 'cancel') {
          session.editMenu.delete(client.id);
          if (action === 'save') {
            saveSessionMeta(sessionId, {
              tmuxId: sessionId, name: session.name, runAsUser: session.runAsUser,
              createdAt: session.createdAt.toISOString(), access: session.access,
            });
            console.log(`[edit] ${client.username} updated settings for "${session.name}"`);
          }
          client.write('\x1b[2J\x1b[H');
          session.pty.attach(client);
          return true;
        }
        if (action === 'toggle:hidden') { session.access.hidden = !session.access.hidden; this.renderEditMenu(sessionId, client); return true; }
        if (action === 'toggle:viewOnly') { session.access.viewOnly = !session.access.viewOnly; this.renderEditMenu(sessionId, client); return true; }
        if (action === 'toggle:password') {
          if (session.access.passwordHash) {
            session.access.passwordHash = null;
            this.renderEditMenu(sessionId, client);
          } else {
            edit.step = 'password'; edit.buffer = '';
            client.write('\x1b[2J\x1b[H');
            client.write('  Enter new password: ');
          }
          return true;
        }
        if (action === 'setPassword') {
          edit.step = 'password'; edit.buffer = '';
          client.write('\x1b[2J\x1b[H');
          client.write('  Enter new password: ');
          return true;
        }
        if (action === 'editUsers') {
          edit.step = 'users'; edit.buffer = '';
          this.renderUserEditor(client, session.access.allowedUsers, '');
          return true;
        }
        if (action === 'editGroups') {
          edit.step = 'groups'; edit.buffer = '';
          this.renderGroupEditor(client, session.access.allowedGroups, '');
          return true;
        }
        return false;
      };

      if (str === '\r' || str === '\n' || str === ' ') {
        if (doAction(getActionAtCursor(sections, edit.cursor))) return;
      }

      const found = findItemByKey(sections, str);
      if (found) { if (doAction(found.action)) return; }
      return;
    }

    // Help menu active
    if (session.helpMenu.has(client.id)) {
      const str = data.toString();
      let cursor = session.helpMenu.get(client.id) ?? 0;

      if (str === '\x1b' && data.length === 1) {
        this.handleHelpAction(sessionId, client, 'back');
        return;
      }
      if (str === '\x1b[A' || str === '\x1bOA') {
        cursor = nextSelectable(this.helpSections, cursor, -1);
        session.helpMenu.set(client.id, cursor);
        client.write(renderMenu({ title: 'claude-proxy help', sections: this.helpSections, footer: 'arrows to navigate, enter/space to select, esc to return', cursor }));
        return;
      }
      if (str === '\x1b[B' || str === '\x1bOB') {
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
        { label: 'Detach (back to lobby)', key: 'd', hint: 'Ctrl-B d', action: 'detach' },
        { label: 'Claim size ownership', key: 's', hint: 'Ctrl-B s', action: 'claimSize' },
        { label: 'Redraw screen', key: 'r', hint: 'Ctrl-B r', action: 'redraw' },
        { label: 'Scrollback dump', key: 'l', hint: 'Ctrl-B l — use terminal scrollbar', action: 'scrolldump' },
        { label: 'Scrollback viewer', key: 'b', hint: 'Ctrl-B b — arrows/pgup/pgdn', action: 'scrollview' },
        { label: 'Edit session settings', key: 'e', hint: 'Ctrl-B e — owner only', action: 'editSession' },
      ],
    },
    {
      title: 'Info',
      items: [
        { label: 'Title bar shows: session | *owner, users | uptime', action: 'none', disabled: true },
        { label: 'Sessions persist across proxy restarts (tmux-backed)', action: 'none', disabled: true },
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
      case 'editSession':
        this.startEditSession(sessionId, client);
        break;
    }
  }

  private buildEditSections(access: SessionAccess): MenuSection[] {
    const items: MenuItem[] = [
      { label: `Hidden: ${access.hidden ? 'YES' : 'no'}`, key: '1', action: 'toggle:hidden' },
      { label: `View-only: ${access.viewOnly ? 'YES' : 'no'}`, key: '2', action: 'toggle:viewOnly' },
      { label: `Require password: ${access.passwordHash ? 'YES' : 'no'}`, key: '3', action: 'toggle:password' },
    ];

    // Password value — only editable when password is on
    if (access.passwordHash) {
      items.push({ label: 'Change password...', key: '4', action: 'setPassword' });
    } else {
      items.push({ label: 'Password: off', action: 'none', disabled: true });
    }

    // Allowed users — editable when not hidden
    if (!access.hidden) {
      const userList = access.allowedUsers.length > 0 ? access.allowedUsers.join(', ') : 'everyone';
      items.push({ label: `Allowed users: ${userList}`, key: '5', action: 'editUsers' });
      const groupList = access.allowedGroups.length > 0 ? access.allowedGroups.join(', ') : 'all';
      items.push({ label: `Allowed groups: ${groupList}`, key: '6', action: 'editGroups' });
    } else {
      items.push({ label: 'Allowed users: hidden (owner only)', action: 'none', disabled: true });
      items.push({ label: 'Allowed groups: hidden (owner only)', action: 'none', disabled: true });
    }

    return [{
      title: `Session settings (owner: ${access.owner})`,
      items,
    }, {
      items: [
        { label: 'Save and return', action: 'save' },
        { label: 'Cancel', key: 'esc', action: 'cancel' },
      ],
    }];
  }

  private renderEditMenu(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const edit = session.editMenu.get(client.id);
    if (!edit) return;

    const sections = this.buildEditSections(session.access);
    client.write(renderMenu({
      title: 'Edit session settings',
      sections,
      footer: 'arrows to navigate, space/enter to toggle, esc to cancel',
      cursor: edit.cursor,
    }));
  }

  private renderUserEditor(client: Client, users: string[], buffer: string): void {
    client.write('\x1b[2J\x1b[H');
    client.write('  \x1b[1mAllowed users:\x1b[0m\r\n\r\n');
    if (users.length > 0) {
      users.forEach(u => client.write(`    \x1b[36m${u}\x1b[0m\r\n`));
    } else {
      client.write(`    \x1b[38;5;245m(none — everyone can join)\x1b[0m\r\n`);
    }
    client.write('\r\n  Type username + enter to add, backspace to remove last\r\n');
    client.write('  Empty enter to finish\r\n\r\n  > ');
    if (buffer) client.write(buffer);
  }

  private renderGroupEditor(client: Client, groups: string[], buffer: string): void {
    client.write('\x1b[2J\x1b[H');
    client.write('  \x1b[1mAllowed groups:\x1b[0m (cp- prefix added automatically)\r\n\r\n');
    if (groups.length > 0) {
      groups.forEach(g => client.write(`    \x1b[36m${g}\x1b[0m (cp-${g})\r\n`));
    } else {
      client.write(`    \x1b[38;5;245m(none — all groups)\x1b[0m\r\n`);
    }
    client.write('\r\n  Type group name + enter to add, backspace to remove last\r\n');
    client.write('  Empty enter to finish\r\n\r\n  > ');
    if (buffer) client.write(buffer);
  }

  private startEditSession(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Only owner can edit
    if (client.username !== session.access.owner) {
      // Not owner — just flash a message and return
      client.write('\r\n  Only the session owner can edit settings.\r\n');
      setTimeout(() => {
        client.write('\x1b[2J\x1b[H');
        session.pty.attach(client);
      }, 1500);
      return;
    }

    session.pty.detach(client);
    session.editMenu.set(client.id, { step: 'menu', cursor: 0 });
    this.renderEditMenu(sessionId, client);
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
