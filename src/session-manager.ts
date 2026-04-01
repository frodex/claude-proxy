// src/session-manager.ts

import { randomUUID, createHash } from 'crypto';
import { PtyMultiplexer } from './pty-multiplexer.js';
import { StatusBar } from './status-bar.js';
import { HotkeyHandler } from './hotkey.js';
import { setScrollRegion, enterAltScreen, leaveAltScreen } from './ansi.js';
import { renderMenu, getActionAtCursor, findItemByKey, nextSelectable, type MenuSection } from './interactive-menu.js';
import { ScrollbackViewer } from './scrollback-viewer.js';
import { saveSessionMeta, loadSessionMeta, deleteSessionMeta, listStoredSessions, listTmuxSessionNames, discoverClaudeSessionId } from './session-store.js';
import { canUserAccessSession, canUserEditSession, getClaudeUsers, getClaudeGroups, isUserInGroup } from './user-utils.js';
import { parseKey } from './widgets/keys.js';
import { renderFlowForm } from './widgets/renderers.js';
import { buildSessionFormSteps } from './session-form.js';
import { FlowEngine } from './widgets/flow-engine.js';
import type { Client, Session, SessionAccess } from './types.js';
import type { SocketManager } from './ugo/socket-manager.js';
import type { GroupWatcher, SessionInfo } from './ugo/group-watcher.js';
import type { Provisioner } from './auth/types.js';

interface SessionManagerOptions {
  defaultUser: string;
  scrollbackBytes: number;
  maxSessions: number;
  socketManager?: SocketManager;
  groupWatcher?: GroupWatcher;
  provisioner?: Provisioner;
}

interface ManagedSession extends Session {
  pty: PtyMultiplexer;
  statusBar: StatusBar;
  hotkeys: Map<string, HotkeyHandler>;
  scrollbackViewers: Map<string, ScrollbackViewer>;
  dumpMode: Set<string>;
  helpMenu: Map<string, number>;
  onClientDetach?: (client: Client) => void;
}

export class SessionManager {
  private sessions: Map<string, ManagedSession> = new Map();
  private editFlows = new Map<string, { flow: FlowEngine; sessionId: string }>();
  private forkFlows = new Map<string, { flow: FlowEngine; sourceSessionId: string; claudeId: string; notice?: boolean; forkResults?: Record<string, any> }>();
  private options: SessionManagerOptions;
  private onSessionEndCallback?: (sessionId: string) => void;
  private socketManager?: SocketManager;
  private groupWatcher?: GroupWatcher;
  private provisioner?: Provisioner;

  constructor(options: SessionManagerOptions) {
    this.options = options;
    this.socketManager = options.socketManager;
    this.groupWatcher = options.groupWatcher;
    this.provisioner = options.provisioner;
  }

  setOnSessionEnd(callback: (sessionId: string) => void): void {
    this.onSessionEndCallback = callback;
  }

  /**
   * Start the group watcher for reactive enforcement of group-based access.
   * When /etc/group changes, connected users who lost group membership are kicked.
   */
  startGroupWatcher(): void {
    if (!this.groupWatcher) return;

    this.groupWatcher.startWatching(
      () => this.getSessionInfos(),
      (sessionName, username) => {
        const tmuxId = `cp-${sessionName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const session = this.sessions.get(tmuxId);
        if (!session) return;
        for (const [, client] of session.clients) {
          if (client.username === username) {
            this.leaveSession(tmuxId, client);
          }
        }
      },
    );
  }

  private getSessionInfos(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter(s => s.socketPath)
      .map(s => ({
        sessionName: s.name,
        sessionGroup: `sess-${s.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        owner: s.access.owner,
        connectedUsers: Array.from(s.clients.values()).map(c => c.username),
      }));
  }

  /**
   * Discover existing tmux sessions from a previous proxy instance and reattach
   */
  discoverSessions(): void {
    // Local sessions — find by listing tmux
    const tmuxSessions = PtyMultiplexer.listTmuxSessions();
    console.log(`[discover] found ${tmuxSessions.length} existing local tmux sessions`);

    for (const ts of tmuxSessions) {
      this.reattachSession(ts.tmuxId, ts.name, ts.created);
    }

    // Remote sessions — check stored metadata for sessions with remoteHost
    this.discoverRemoteSessions();

    // Socket-based sessions — discover via SocketManager
    if (this.socketManager) {
      const aliveSockets = this.socketManager.discoverSockets();
      for (const socketPath of aliveSockets) {
        const filename = socketPath.split('/').pop()!;
        const tmuxId = filename.replace('.sock', '');
        if (!this.sessions.has(tmuxId)) {
          this.reattachSession(tmuxId, tmuxId.replace(/^cp-/, ''), new Date());
        }
      }
    }
  }

  private discoverRemoteSessions(): void {
    const stored = listStoredSessions();
    const remoteSessions = stored.filter(s => s.remoteHost && !this.sessions.has(s.tmuxId));

    // Group by host to minimize SSH calls
    const byHost = new Map<string, typeof remoteSessions>();
    for (const s of remoteSessions) {
      const host = s.remoteHost!;
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host)!.push(s);
    }

    for (const [host, sessions] of byHost) {
      const running = listTmuxSessionNames(host);
      console.log(`[discover] found ${running.size} tmux sessions on ${host}`);

      for (const s of sessions) {
        if (running.has(s.tmuxId)) {
          this.reattachSession(s.tmuxId, s.name, new Date(s.createdAt), s);
        }
      }
    }
  }

  private reattachSession(
    tmuxId: string,
    name: string,
    created: Date,
    meta?: { name: string; runAsUser: string; workingDir?: string; remoteHost?: string; socketPath?: string; createdAt: string; access: SessionAccess },
  ): void {
    const id = tmuxId;
    if (this.sessions.has(id)) return;

    try {
      if (!meta) meta = loadSessionMeta(tmuxId) ?? undefined;
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
        tmuxSessionId: tmuxId,
        cols: 120,
        rows: 40,
        scrollbackBytes: this.options.scrollbackBytes,
        remoteHost: meta?.remoteHost,
        socketPath: meta?.socketPath,
        onExit: (code) => {
          console.log(`[session-exit] "${name}" (${id}) exited with code ${code}`);
          deleteSessionMeta(id);
          this.sessions.delete(id);
          this.onSessionEndCallback?.(id);
        },
      });

      const session: ManagedSession = {
        id,
        name: meta?.name ?? name,
        runAsUser: meta?.runAsUser ?? this.options.defaultUser,
        workingDir: meta?.workingDir,
        remoteHost: meta?.remoteHost,
        socketPath: meta?.socketPath,
        createdAt: meta ? new Date(meta.createdAt) : created,
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
      const where = meta?.remoteHost ? ` on ${meta.remoteHost}` : '';
      console.log(`[discover] reattached to "${session.name}"${where} (owner: ${sessionAccess.owner}, public: ${sessionAccess.public})`);
    } catch (err: any) {
      console.error(`[discover] failed to reattach to ${tmuxId}: ${err.message}`);
    }
  }

  createSession(
    name: string,
    creator: Client,
    runAsUser?: string,
    command: string = 'claude',
    access?: Partial<SessionAccess>,
    commandArgs: string[] = [],
    remoteHost?: string,
    workingDir?: string,
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

    // Generate socket path if socket manager is available
    const socketPath = this.socketManager?.getSocketPath(safeName);

    const pty = new PtyMultiplexer({
      command,
      args: commandArgs,
      cols: creator.termSize.cols,
      rows: creator.termSize.rows,
      scrollbackBytes: this.options.scrollbackBytes,
      tmuxSessionId: tmuxId,
      runAsUser: user,
      remoteHost,
      workingDir,
      socketPath,
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
      workingDir,
      remoteHost,
      socketPath,
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
      workingDir,
      remoteHost,
      socketPath,
      createdAt: session.createdAt.toISOString(),
      access: sessionAccess,
    });

    this.sessions.set(tmuxId, session);
    this.joinSession(tmuxId, creator);

    // Backfill Claude session ID after Claude has time to start
    this.scheduleClaudeIdBackfill(tmuxId, socketPath, user);

    return session;
  }

  private scheduleClaudeIdBackfill(tmuxId: string, socketPath?: string, runAsUser?: string): void {
    // Poll a few times with increasing delay — Claude takes a moment to write its session file
    const delays = [3000, 5000, 10000];
    for (const delay of delays) {
      setTimeout(() => {
        const session = this.sessions.get(tmuxId);
        if (!session) return;  // session already gone

        const meta = loadSessionMeta(tmuxId);
        if (meta?.claudeSessionId) return;  // already have it

        const discoveredId = discoverClaudeSessionId(tmuxId, socketPath, runAsUser);
        if (!discoveredId) return;

        // Store it — rotate old ID to pastClaudeSessionIds if different
        if (meta) {
          if (meta.claudeSessionId && meta.claudeSessionId !== discoveredId) {
            if (!meta.pastClaudeSessionIds) meta.pastClaudeSessionIds = [];
            meta.pastClaudeSessionIds.push(meta.claudeSessionId);
          }
          meta.claudeSessionId = discoveredId;
          saveSessionMeta(tmuxId, meta);
          console.log(`[backfill] discovered Claude session ID for "${session.name}": ${discoveredId}`);
        }
      }, delay);
    }
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

    // Edit session settings (SessionForm)
    if (this.editFlows.has(client.id)) {
      const entry = this.editFlows.get(client.id)!;
      const key = parseKey(data);
      const event = entry.flow.handleKey(key);

      if (event.type === 'flow-complete') {
        this.editFlows.delete(client.id);
        this.applyEditResults(entry.sessionId, event.results, client);
        client.write('\x1b[2J\x1b[H');
        session.pty.attach(client);
      } else if (event.type === 'flow-cancelled') {
        this.editFlows.delete(client.id);
        client.write('\x1b[2J\x1b[H');
        session.pty.attach(client);
      } else {
        this.renderEditForm(client);
      }
      return;
    }

    // Fork flow active (SessionForm + notice screen)
    if (this.forkFlows.has(client.id)) {
      this.handleForkInput(sessionId, client, data);
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
        { label: 'Fork session', key: 'f', hint: 'Ctrl-B f — branch conversation', action: 'forkSession' },
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
      case 'forkSession':
        this.startForkFlow(sessionId, client);
        break;
    }
  }

  private startForkFlow(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Always discover live — cache might be stale
    let claudeId = discoverClaudeSessionId(sessionId, session.socketPath, session.runAsUser) ?? undefined;
    const meta = loadSessionMeta(sessionId);

    // Fall back to stored if live discovery fails
    if (!claudeId) {
      claudeId = meta?.claudeSessionId;
    } else if (meta && meta.claudeSessionId !== claudeId) {
      // Update stored ID if it changed
      if (meta.claudeSessionId) {
        if (!meta.pastClaudeSessionIds) meta.pastClaudeSessionIds = [];
        meta.pastClaudeSessionIds.push(meta.claudeSessionId);
      }
      meta.claudeSessionId = claudeId;
      saveSessionMeta(sessionId, meta);
    }

    if (!claudeId) {
      client.write('\x1b[2J\x1b[H');
      client.write('\r\n  \x1b[31mCannot fork: no Claude session ID found for this session.\x1b[0m\r\n');
      client.write('  \x1b[90mThe session ID is discovered automatically after Claude starts.\x1b[0m\r\n');
      client.write('  \x1b[90mTry again in a few seconds, or use Ctrl-B e to enter one manually.\x1b[0m\r\n\r\n');
      client.write('  Press any key to return...');
      session.pty.attach(client);
      return;
    }

    session.pty.detach(client);

    const prefill: Record<string, any> = {
      name: session.name,
      runAsUser: session.runAsUser,
      remoteHost: session.remoteHost,
      workingDir: session.workingDir,
      hidden: session.access.hidden,
      viewOnly: session.access.viewOnly,
      public: session.access.public,
      allowedUsers: session.access.allowedUsers,
      allowedGroups: session.access.allowedGroups,
      password: '',
      dangerousSkipPermissions: false,
      claudeSessionId: claudeId,
    };

    const generateForkName = (baseName: string): string => {
      let forkNum = 1;
      while (true) {
        const candidate = `${baseName}-fork_${String(forkNum).padStart(2, '0')}`;
        const tmuxId = `cp-${candidate.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        if (!this.sessions.has(tmuxId)) return candidate;
        forkNum++;
      }
    };

    const steps = buildSessionFormSteps('fork', client, prefill, {
      getUsers: () => getClaudeUsers().filter(u => u !== session.access.owner),
      getGroups: () => getClaudeGroups(),
      generateForkName,
    });

    const initialState: Record<string, any> = {
      ...prefill,
      _isAdmin: client.username === 'root' || isUserInGroup(client.username, 'admins'),
      _hasRemotes: false,
      _defaultUser: client.username,
    };

    const flow = new FlowEngine(steps, initialState);
    flow.setMode('navigate');
    this.forkFlows.set(client.id, { flow, sourceSessionId: sessionId, claudeId });
    this.renderForkForm(client);
  }

  private renderForkForm(client: Client): void {
    const entry = this.forkFlows.get(client.id);
    if (!entry) return;
    const summary = entry.flow.getFlowSummary();
    const state = entry.flow.getCurrentState();
    const missing = entry.flow.getMissingRequired();
    client.write(renderFlowForm('Fork session', summary, state.widget, state.stepId, missing.length > 0 ? missing : undefined));
  }

  private showForkNotice(client: Client, sourceName: string, forkName: string): void {
    const parts: string[] = ['\x1b[2J\x1b[H'];
    parts.push(`  \x1b[1mFork session\x1b[0m\r\n`);
    parts.push(`  \x1b[38;5;245m${'─'.repeat(50)}\x1b[0m\r\n\r\n`);
    parts.push(`  You are creating a fork of "\x1b[1m${sourceName}\x1b[0m"\r\n`);
    parts.push(`  New session: \x1b[1m${forkName}\x1b[0m\r\n\r\n`);
    parts.push(`  Your current session will remain running and\r\n`);
    parts.push(`  can be accessed from the lobby.\r\n\r\n`);
    parts.push(`  After confirmation you will be placed in the\r\n`);
    parts.push(`  forked session.\r\n\r\n`);
    parts.push(`  \x1b[38;5;245m[Enter] Create fork    [Esc] Cancel\x1b[0m\r\n`);
    client.write(parts.join(''));
  }

  private handleForkInput(sessionId: string, client: Client, data: Buffer): void {
    const entry = this.forkFlows.get(client.id);
    if (!entry) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (entry.notice) {
      // On notice screen — Enter creates fork, Escape cancels
      const str = data.toString();
      if (str === '\r' || str === '\n') {
        this.forkFlows.delete(client.id);
        this.executeFork(sessionId, client, entry.forkResults!, entry.claudeId);
      } else if (str === '\x1b' && data.length === 1) {
        this.forkFlows.delete(client.id);
        client.write('\x1b[2J\x1b[H');
        session.pty.attach(client);
      }
      return;
    }

    // Delegate to flow engine
    const key = parseKey(data);
    const event = entry.flow.handleKey(key);

    if (event.type === 'flow-complete') {
      entry.forkResults = event.results;
      entry.notice = true;
      const forkName = event.results.name || 'unnamed-fork';
      this.showForkNotice(client, session.name, forkName);
    } else if (event.type === 'flow-cancelled') {
      this.forkFlows.delete(client.id);
      client.write('\x1b[2J\x1b[H');
      session.pty.attach(client);
    } else {
      this.renderForkForm(client);
    }
  }

  private executeFork(sessionId: string, client: Client, results: Record<string, any>, claudeId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const forkName = results.name || `${session.name}-fork`;

    try {
      const forkedSession = this.createSession(
        forkName,
        client,
        session.runAsUser,
        'claude',
        {
          owner: client.username,
          hidden: results.hidden ?? session.access.hidden,
          viewOnly: results.viewOnly ?? session.access.viewOnly,
          public: results.public ?? session.access.public,
          allowedUsers: results.allowedUsers ?? session.access.allowedUsers,
          allowedGroups: results.allowedGroups ?? session.access.allowedGroups,
          passwordHash: results.password
            ? createHash('sha256').update(results.password).digest('hex')
            : null,
        },
        ['--resume', claudeId, '--fork-session'],
        undefined,
        session.workingDir,
      );

      // Store the source Claude session ID in the fork's metadata
      const forkMeta = loadSessionMeta(forkedSession.id);
      if (forkMeta) {
        forkMeta.pastClaudeSessionIds = [claudeId];
        saveSessionMeta(forkedSession.id, forkMeta);
      }

      console.log(`[fork] ${client.username} forked "${session.name}" (${claudeId}) → "${forkName}"`);

      // Detach from original session and enter fork
      // (createSession already called joinSession, so client is in fork now)
      // We need to leave the original session
      this.leaveSession(sessionId, client);
    } catch (err: any) {
      client.write('\x1b[2J\x1b[H');
      client.write(`\r\n  \x1b[31mFork failed: ${err.message}\x1b[0m\r\n\r\n`);
      client.write('  Press any key to return...');
      session.pty.attach(client);
    }
  }

  private startEditSession(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (!canUserEditSession(client.username, session.access)) {
      client.write('\r\n  Only the session owner or admins can edit settings.\r\n');
      setTimeout(() => {
        client.write('\x1b[2J\x1b[H');
        session.pty.attach(client);
      }, 1500);
      return;
    }

    session.pty.detach(client);

    const prefill: Record<string, any> = {
      name: session.name,
      runAsUser: session.runAsUser,
      remoteHost: session.remoteHost,
      workingDir: session.workingDir,
      hidden: session.access.hidden,
      viewOnly: session.access.viewOnly,
      public: session.access.public,
      allowedUsers: session.access.allowedUsers,
      allowedGroups: session.access.allowedGroups,
      password: '',  // don't pre-fill password hash
      dangerousSkipPermissions: false,
      claudeSessionId: discoverClaudeSessionId(sessionId, session.socketPath, session.runAsUser)
        || loadSessionMeta(sessionId)?.claudeSessionId,
    };

    const steps = buildSessionFormSteps('edit', client, prefill, {
      getUsers: () => getClaudeUsers().filter(u => u !== session.access.owner),
      getGroups: () => getClaudeGroups(),
    });

    const initialState: Record<string, any> = {
      ...prefill,
      _isAdmin: client.username === 'root' || isUserInGroup(client.username, 'admins'),
      _hasRemotes: false,
      _defaultUser: client.username,
    };

    const flow = new FlowEngine(steps, initialState);
    flow.setMode('navigate');
    this.editFlows.set(client.id, { flow, sessionId });
    this.renderEditForm(client);
  }

  private renderEditForm(client: Client): void {
    const entry = this.editFlows.get(client.id);
    if (!entry) return;
    const summary = entry.flow.getFlowSummary();
    const state = entry.flow.getCurrentState();
    const missing = entry.flow.getMissingRequired();
    client.write(renderFlowForm('Edit session', summary, state.widget, state.stepId, missing.length > 0 ? missing : undefined));
  }

  private applyEditResults(sessionId: string, results: Record<string, any>, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (results.name !== undefined) session.name = results.name;
    if (results.hidden !== undefined) session.access.hidden = results.hidden;
    if (results.viewOnly !== undefined) session.access.viewOnly = results.viewOnly;
    if (results.public !== undefined) session.access.public = results.public;
    if (results.allowedUsers !== undefined) session.access.allowedUsers = results.allowedUsers;
    if (results.allowedGroups !== undefined) session.access.allowedGroups = results.allowedGroups;
    if (results.password) {
      session.access.passwordHash = createHash('sha256').update(results.password).digest('hex');
    }
    if (results.claudeSessionId) {
      const meta = loadSessionMeta(sessionId);
      if (meta) {
        meta.claudeSessionId = results.claudeSessionId;
        saveSessionMeta(sessionId, meta);
      }
    }

    // Save metadata
    saveSessionMeta(sessionId, {
      tmuxId: sessionId,
      name: session.name,
      runAsUser: session.runAsUser,
      createdAt: session.createdAt.toISOString(),
      access: session.access,
    });

    console.log(`[edit] ${client.username} updated settings for "${session.name}"`);
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
    return Array.from(this.sessions.values()).filter(session => {
      // Socket-based sessions with provisioner: use group-based access control
      if (session.socketPath && this.provisioner) {
        if (username === session.access.owner) return true;
        if (session.access.hidden && username !== session.access.owner) return false;
        const groups = this.provisioner.getGroups(username);
        const sessionGroup = `sess-${session.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        if (session.access.public) {
          return groups.includes('cp-users');
        }
        return groups.includes(sessionGroup) ||
               session.access.allowedGroups.some(g => groups.includes(g));
      }
      // Legacy sessions: use existing ACL check
      return canUserAccessSession(username, session.access);
    });
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
