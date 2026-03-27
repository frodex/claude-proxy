// src/session-manager.ts

import { randomUUID, createHash } from 'crypto';
import { PtyMultiplexer } from './pty-multiplexer.js';
import { StatusBar } from './status-bar.js';
import { HotkeyHandler } from './hotkey.js';
import { setScrollRegion, enterAltScreen, leaveAltScreen } from './ansi.js';
import { renderMenu, getActionAtCursor, findItemByKey, nextSelectable, type MenuSection, type MenuItem } from './interactive-menu.js';
import { ScrollbackViewer } from './scrollback-viewer.js';
import { saveSessionMeta, loadSessionMeta, deleteSessionMeta } from './session-store.js';
import { canUserAccessSession, canUserEditSession, getClaudeUsers, getClaudeGroups } from './user-utils.js';
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
  editMenu: Map<string, { step: string; cursor: number; buffer?: string; pickerCursor?: number; pickerItems?: string[] }>;
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
          admins: [],
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
      admins: access?.admins ?? [],
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
        if (session.access.viewOnly && !canUserEditSession(client.username, session.access)) {
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

      // Sub-state: edit allowed users (checkbox picker)
      if (edit.step === 'users') {
        if (!edit.pickerItems) edit.pickerItems = getClaudeUsers().filter(u => u !== session.access.owner);
        if (edit.pickerCursor === undefined) edit.pickerCursor = 0;
        const selected = new Set(session.access.allowedUsers);
        const totalItems = edit.pickerItems.length + 1;

        if (str === '\x1b' && data.length === 1) { edit.step = 'menu'; this.renderEditMenu(sessionId, client); return; }
        if (str === '\x1b[A' || str === '\x1bOA') {
          edit.pickerCursor = Math.max(0, edit.pickerCursor - 1);
          this.renderCheckboxPicker(client, 'Allowed users', 'empty = everyone can join', edit.pickerItems, selected, edit.pickerCursor, edit.buffer || '');
          return;
        }
        if (str === '\x1b[B' || str === '\x1bOB') {
          edit.pickerCursor = Math.min(totalItems - 1, edit.pickerCursor + 1);
          this.renderCheckboxPicker(client, 'Allowed users', 'empty = everyone can join', edit.pickerItems, selected, edit.pickerCursor, edit.buffer || '');
          return;
        }
        if (str === ' ' && edit.pickerCursor < edit.pickerItems.length) {
          const user = edit.pickerItems[edit.pickerCursor];
          if (selected.has(user)) {
            session.access.allowedUsers = session.access.allowedUsers.filter(u => u !== user);
          } else {
            session.access.allowedUsers.push(user);
          }
          this.renderCheckboxPicker(client, 'Allowed users', 'empty = everyone can join', edit.pickerItems, new Set(session.access.allowedUsers), edit.pickerCursor, edit.buffer || '');
          return;
        }
        if (str === '\r' || str === '\n') {
          if (edit.pickerCursor === edit.pickerItems.length && edit.buffer && edit.buffer.trim()) {
            const name = edit.buffer.trim();
            if (!session.access.allowedUsers.includes(name)) session.access.allowedUsers.push(name);
            if (!edit.pickerItems.includes(name)) edit.pickerItems.push(name);
            edit.buffer = '';
            this.renderCheckboxPicker(client, 'Allowed users', 'empty = everyone can join', edit.pickerItems, new Set(session.access.allowedUsers), edit.pickerCursor, '');
            return;
          }
          edit.step = 'menu'; edit.pickerCursor = undefined; edit.pickerItems = undefined;
          this.renderEditMenu(sessionId, client);
          return;
        }
        if (edit.pickerCursor === edit.pickerItems.length) {
          if (str === '\x7f' || str === '\b') { if (edit.buffer && edit.buffer.length > 0) edit.buffer = edit.buffer.slice(0, -1); }
          else { if (!edit.buffer) edit.buffer = ''; edit.buffer += str; }
          this.renderCheckboxPicker(client, 'Allowed users', 'empty = everyone can join', edit.pickerItems, new Set(session.access.allowedUsers), edit.pickerCursor, edit.buffer || '');
        }
        return;
      }

      // Sub-state: edit allowed groups (checkbox picker)
      if (edit.step === 'groups') {
        // getClaudeGroups imported at top
        if (!edit.pickerItems) edit.pickerItems = getClaudeGroups().map(g => g.name);
        if (edit.pickerCursor === undefined) edit.pickerCursor = 0;
        const selected = new Set(session.access.allowedGroups);
        const totalItems = edit.pickerItems.length + 1;

        if (str === '\x1b' && data.length === 1) { edit.step = 'menu'; this.renderEditMenu(sessionId, client); return; }
        if (str === '\x1b[A' || str === '\x1bOA') {
          edit.pickerCursor = Math.max(0, edit.pickerCursor - 1);
          this.renderCheckboxPicker(client, 'Allowed groups', 'cp- prefix added automatically', edit.pickerItems, selected, edit.pickerCursor, edit.buffer || '');
          return;
        }
        if (str === '\x1b[B' || str === '\x1bOB') {
          edit.pickerCursor = Math.min(totalItems - 1, edit.pickerCursor + 1);
          this.renderCheckboxPicker(client, 'Allowed groups', 'cp- prefix added automatically', edit.pickerItems, selected, edit.pickerCursor, edit.buffer || '');
          return;
        }
        if (str === ' ' && edit.pickerCursor < edit.pickerItems.length) {
          const group = edit.pickerItems[edit.pickerCursor];
          if (selected.has(group)) {
            session.access.allowedGroups = session.access.allowedGroups.filter(g => g !== group);
          } else {
            session.access.allowedGroups.push(group);
          }
          this.renderCheckboxPicker(client, 'Allowed groups', 'cp- prefix added automatically', edit.pickerItems, new Set(session.access.allowedGroups), edit.pickerCursor, edit.buffer || '');
          return;
        }
        if (str === '\r' || str === '\n') {
          if (edit.pickerCursor === edit.pickerItems.length && edit.buffer && edit.buffer.trim()) {
            const name = edit.buffer.trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
            if (name && !session.access.allowedGroups.includes(name)) session.access.allowedGroups.push(name);
            if (name && !edit.pickerItems.includes(name)) edit.pickerItems.push(name);
            edit.buffer = '';
            this.renderCheckboxPicker(client, 'Allowed groups', 'cp- prefix added automatically', edit.pickerItems, new Set(session.access.allowedGroups), edit.pickerCursor, '');
            return;
          }
          edit.step = 'menu'; edit.pickerCursor = undefined; edit.pickerItems = undefined;
          this.renderEditMenu(sessionId, client);
          return;
        }
        if (edit.pickerCursor === edit.pickerItems.length) {
          if (str === '\x7f' || str === '\b') { if (edit.buffer && edit.buffer.length > 0) edit.buffer = edit.buffer.slice(0, -1); }
          else { if (!edit.buffer) edit.buffer = ''; edit.buffer += str; }
          this.renderCheckboxPicker(client, 'Allowed groups', 'cp- prefix added automatically', edit.pickerItems, new Set(session.access.allowedGroups), edit.pickerCursor, edit.buffer || '');
        }
        return;
      }

      // Sub-state: edit admins (checkbox picker)
      if (edit.step === 'admins') {
        if (!session.access.admins) session.access.admins = [];
        if (!edit.pickerItems) edit.pickerItems = getClaudeUsers().filter(u => u !== session.access.owner);
        if (edit.pickerCursor === undefined) edit.pickerCursor = 0;
        const selected = new Set(session.access.admins);
        const totalItems = edit.pickerItems.length + 1; // +1 for "type to add"

        if (str === '\x1b' && data.length === 1) { edit.step = 'menu'; this.renderEditMenu(sessionId, client); return; }

        if (str === '\x1b[A' || str === '\x1bOA') {
          edit.pickerCursor = Math.max(0, edit.pickerCursor - 1);
          this.renderCheckboxPicker(client, 'Session admins', 'users in cp-admins group are always admins', edit.pickerItems, selected, edit.pickerCursor, edit.buffer || '');
          return;
        }
        if (str === '\x1b[B' || str === '\x1bOB') {
          edit.pickerCursor = Math.min(totalItems - 1, edit.pickerCursor + 1);
          this.renderCheckboxPicker(client, 'Session admins', 'users in cp-admins group are always admins', edit.pickerItems, selected, edit.pickerCursor, edit.buffer || '');
          return;
        }

        // Space toggles if on a user item
        if (str === ' ' && edit.pickerCursor < edit.pickerItems.length) {
          const user = edit.pickerItems[edit.pickerCursor];
          if (selected.has(user)) {
            session.access.admins = session.access.admins.filter(a => a !== user);
          } else {
            session.access.admins.push(user);
          }
          this.renderCheckboxPicker(client, 'Session admins', 'users in cp-admins group are always admins', edit.pickerItems, new Set(session.access.admins), edit.pickerCursor, edit.buffer || '');
          return;
        }

        // Enter — if on "type to add" with text, add it. Otherwise finish.
        if (str === '\r' || str === '\n') {
          if (edit.pickerCursor === edit.pickerItems.length && edit.buffer && edit.buffer.trim()) {
            const name = edit.buffer.trim();
            if (!session.access.admins.includes(name)) session.access.admins.push(name);
            if (!edit.pickerItems.includes(name)) edit.pickerItems.push(name);
            edit.buffer = '';
            this.renderCheckboxPicker(client, 'Session admins', 'users in cp-admins group are always admins', edit.pickerItems, new Set(session.access.admins), edit.pickerCursor, '');
            return;
          }
          edit.step = 'menu'; edit.pickerCursor = undefined; edit.pickerItems = undefined;
          this.renderEditMenu(sessionId, client);
          return;
        }

        // Typing in the "type to add" field
        if (edit.pickerCursor === edit.pickerItems.length) {
          if (str === '\x7f' || str === '\b') {
            if (edit.buffer && edit.buffer.length > 0) { edit.buffer = edit.buffer.slice(0, -1); }
          } else {
            if (!edit.buffer) edit.buffer = '';
            edit.buffer += str;
          }
          this.renderCheckboxPicker(client, 'Session admins', 'users in cp-admins group are always admins', edit.pickerItems, new Set(session.access.admins), edit.pickerCursor, edit.buffer || '');
        }
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
        if (action === 'editAdmins') {
          edit.step = 'admins'; edit.buffer = '';
          this.renderAdminEditor(client, session.access.admins ?? [], '');
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

    // Session admins — always editable
    const adminList = (access.admins?.length ?? 0) > 0 ? access.admins!.join(', ') : 'none';
    items.push({ label: `Session admins: ${adminList}`, key: '7', action: 'editAdmins' });

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

  private renderCheckboxPicker(client: Client, title: string, note: string, allItems: string[], selected: Set<string>, cursor: number, buffer: string): void {
    client.write('\x1b[2J\x1b[H');
    client.write(`  \x1b[1m${title}\x1b[0m\r\n`);
    if (note) client.write(`  \x1b[38;5;245m${note}\x1b[0m\r\n`);
    client.write('\r\n');

    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i];
      const checked = selected.has(item);
      const arrow = i === cursor ? '\x1b[33m>\x1b[0m' : ' ';
      const box = checked ? '\x1b[32m[x]\x1b[0m' : '[ ]';
      client.write(`  ${arrow} ${box} ${item}\r\n`);
    }

    // "Type to add" option at the bottom
    const addIdx = allItems.length;
    const addArrow = cursor === addIdx ? '\x1b[33m>\x1b[0m' : ' ';
    client.write(`\r\n  ${addArrow} Type to add: ${buffer}\r\n`);
    client.write(`\r\n  \x1b[38;5;245mspace=toggle, enter=done, type name at bottom\x1b[0m\r\n`);
  }

  private renderAdminEditor(client: Client, admins: string[], buffer: string): void {
    // Legacy — redirect to checkbox picker
    const edit = this.getEditForClient(client);
    if (!edit) return;
    const allUsers = getClaudeUsers().filter(u => u !== 'root');
    const selected = new Set(admins);
    this.renderCheckboxPicker(client, 'Session admins', 'users in cp-admins group are always admins', allUsers, selected, edit.pickerCursor ?? 0, buffer);
  }

  private getEditForClient(client: Client): { step: string; cursor: number; buffer?: string; pickerCursor?: number; pickerItems?: string[] } | undefined {
    for (const session of this.sessions.values()) {
      const edit = session.editMenu.get(client.id);
      if (edit) return edit as any;
    }
    return undefined;
  }

  private startEditSession(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Only owner, session admins, or cp-admins can edit
    if (!canUserEditSession(client.username, session.access)) {
      client.write('\r\n  Only the session owner or admins can edit settings.\r\n');
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
