// src/index.ts

import { loadConfig } from './config.js';
import { startApiServer } from './api-server.js';
import { SSHTransport } from './ssh-transport.js';
import { SessionManager } from './session-manager.js';
import { Lobby } from './lobby.js';
import { DirScanner } from './dir-scanner.js';
import { setScrollRegion } from './ansi.js';
import { getClaudeUsers, getClaudeGroups, sanitizeGroupName, isUserInGroup } from './user-utils.js';
import { listDeadSessions, type StoredSession } from './session-store.js';
import { findUserSessions, createExportZip, type ExportableSession } from './export.js';
import { color } from './ansi.js';
import { createHash } from 'crypto';
import { existsSync, readdirSync, statSync } from 'fs';
import type { Client, Session, SessionAccess } from './types.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { hostname } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse CLI args
const args = process.argv.slice(2);
let cliPort: number | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    cliPort = parseInt(args[i + 1], 10);
    i++;
  }
}

const config = loadConfig({ port: cliPort });

const sessionManager = new SessionManager({
  defaultUser: config.sessions.default_user,
  scrollbackBytes: config.sessions.scrollback_bytes,
  maxSessions: config.sessions.max_sessions,
});

const lobby = new Lobby({ motd: config.lobby.motd });

const dirScanner = new DirScanner({
  historyPath: resolve(__dirname, '..', 'data', 'dir-history.json'),
});

// Discover existing tmux sessions from previous proxy instance
sessionManager.discoverSessions();

const clientState: Map<string, {
  mode: 'lobby' | 'session';
  sessionId?: string;
  selectedIndex: number;
  client: Client;
}> = new Map();

const creationFlow: Map<string, {
  step: 'name' | 'workdir' | 'runas' | 'server' | 'hidden' | 'viewonly' | 'public' | 'users' | 'groups' | 'password' | 'dangermode';
  isResume?: boolean;
  name: string;
  workingDir?: string;
  runAsUser?: string;
  remoteHost?: string;
  serverCursor?: number;
  hidden: boolean;
  viewOnly: boolean;
  dangerousSkipPermissions: boolean;
  public: boolean;
  selectedUsers: Set<string>;
  selectedGroups: Set<string>;
  availableUsers: string[];
  availableGroups: Array<{ name: string; systemName: string }>;
  userCursor: number;
  groupCursor: number;
  buffer: string;
}> = new Map();

// Password hashing (simple SHA-256 — not bcrypt to avoid dependency)
function hashPassword(pw: string): string {
  return createHash('sha256').update(pw).digest('hex');
}

const passwordFlow: Map<string, { sessionId: string; buffer: string }> = new Map();

const restartFlow: Map<string, { deadSessions: StoredSession[]; cursor: number }> = new Map();

const exportFlow: Map<string, { sessions: ExportableSession[]; selected: Set<number>; cursor: number }> = new Map();

const transport = new SSHTransport({
  port: config.port,
  host: config.host,
  hostKeyPath: resolve(__dirname, '..', 'host-keys'),
  authorizedKeysPath: config.auth.authorized_keys,
});

function showLobby(client: Client): void {
  const state = clientState.get(client.id);
  if (!state) return;

  state.mode = 'lobby';
  state.sessionId = undefined;

  // Reset scroll region to full terminal
  client.write(setScrollRegion(1, client.termSize.rows));

  const sessions = sessionManager.listSessionsForUser(client.username);
  const output = lobby.renderScreen({
    username: client.username,
    sessions,
    cursor: state.selectedIndex,
    cols: client.termSize.cols,
    rows: client.termSize.rows,
  });
  client.write(output);
}

function joinSession(client: Client, sessionId: string): void {
  const state = clientState.get(client.id);
  if (!state) return;

  state.mode = 'session';
  state.sessionId = sessionId;

  client.write('\x1b[2J\x1b[H');

  sessionManager.joinSession(sessionId, client);
  sessionManager.setOnClientDetach(sessionId, (detachedClient) => {
    if (detachedClient.id === client.id) {
      showLobby(client);
    }
  });
}

function renderServerPicker(client: Client, flow: { serverCursor?: number; remoteHost?: string }): void {
  const remotes = config.remotes || [];
  const cursor = flow.serverCursor ?? 0;

  client.write('\x1b[2J\x1b[H');
  client.write('  \x1b[1mRun on server:\x1b[0m\r\n\r\n');

  // Local is always first option
  const localArrow = cursor === 0 ? '\x1b[33m>\x1b[0m' : ' ';
  client.write(`  ${localArrow} \x1b[33m[0]\x1b[0m local\r\n`);

  for (let i = 0; i < remotes.length; i++) {
    const arrow = cursor === i + 1 ? '\x1b[33m>\x1b[0m' : ' ';
    client.write(`  ${arrow} \x1b[33m[${i + 1}]\x1b[0m ${remotes[i].name} \x1b[38;5;245m(${remotes[i].host})\x1b[0m\r\n`);
  }

  client.write('\r\n  \x1b[38;5;245marrows to select, enter to confirm\x1b[0m\r\n');
}

function isAdmin(username: string): boolean {
  return username === 'root' || isUserInGroup(username, 'admins');
}

function startNewSessionFlow(client: Client): void {
  creationFlow.set(client.id, {
    step: 'name',
    name: '',
    runAsUser: client.username,
    hidden: false,
    viewOnly: false,
    dangerousSkipPermissions: false,
    public: true,
    selectedUsers: new Set(),
    selectedGroups: new Set(),
    availableUsers: getClaudeUsers().filter(u => u !== client.username),
    availableGroups: getClaudeGroups(),
    userCursor: 0,
    groupCursor: 0,
    buffer: '',
  });
  client.write('\x1b[2J\x1b[H');
  client.write(`\x1b[1mNew session\x1b[0m (as ${client.username})\r\n\r\n`);
  client.write('Session name: ');
}

function renderUserPicker(flow: ReturnType<typeof creationFlow.get>, client: Client): void {
  if (!flow) return;
  client.write('\x1b[2J\x1b[H');
  client.write('\x1b[1mSelect users who can join:\x1b[0m (space=toggle, enter=done)\r\n\r\n');
  flow.availableUsers.forEach((u, i) => {
    const selected = flow.selectedUsers.has(u);
    const cursor = i === flow.userCursor ? '>' : ' ';
    const check = selected ? '\x1b[32m[x]\x1b[0m' : '[ ]';
    client.write(`  ${cursor} ${check} ${u}\r\n`);
  });
  if (flow.availableUsers.length === 0) {
    client.write('  (no other Claude users found)\r\n');
  }
  client.write('\r\n  Type a username to add: ');
  if (flow.buffer) client.write(flow.buffer);
}

function renderGroupPicker(flow: ReturnType<typeof creationFlow.get>, client: Client): void {
  if (!flow) return;
  client.write('\x1b[2J\x1b[H');
  client.write('\x1b[1mSelect groups who can join:\x1b[0m (space=toggle, enter=done)\r\n\r\n');
  flow.availableGroups.forEach((g, i) => {
    const selected = flow.selectedGroups.has(g.name);
    const cursor = i === flow.groupCursor ? '>' : ' ';
    const check = selected ? '\x1b[32m[x]\x1b[0m' : '[ ]';
    client.write(`  ${cursor} ${check} ${g.name} (${g.systemName})\r\n`);
  });
  if (flow.availableGroups.length === 0) {
    client.write('  (no cp-* groups found)\r\n');
  }
  client.write('\r\n  Type a group name to add: ');
  if (flow.buffer) client.write(flow.buffer);
}

function tabComplete(partial: string): { completed: string; options: string[] } {
  // Resolve ~ to home
  const resolved = partial.startsWith('~') ? partial.replace('~', process.env.HOME || '/root') : partial;

  // Split into parent dir + prefix being typed
  const lastSlash = resolved.lastIndexOf('/');
  const parentDir = lastSlash >= 0 ? resolved.slice(0, lastSlash) || '/' : '.';
  const prefix = lastSlash >= 0 ? resolved.slice(lastSlash + 1) : resolved;

  let entries: string[];
  try {
    entries = readdirSync(parentDir).filter((e) => {
      if (!e.startsWith(prefix)) return false;
      try { return statSync(resolve(parentDir, e)).isDirectory(); } catch { return false; }
    });
  } catch {
    return { completed: partial, options: [] };
  }

  if (entries.length === 0) return { completed: partial, options: [] };
  if (entries.length === 1) {
    const full = parentDir === '/' ? `/${entries[0]}/` : `${parentDir}/${entries[0]}/`;
    // Map back to ~ prefix if applicable
    const home = process.env.HOME || '/root';
    const display = partial.startsWith('~') && full.startsWith(home) ? '~' + full.slice(home.length) : full;
    return { completed: display, options: entries };
  }

  // Multiple matches — find common prefix
  let common = entries[0];
  for (const e of entries.slice(1)) {
    while (!e.startsWith(common)) common = common.slice(0, -1);
  }
  const full = parentDir === '/' ? `/${common}` : `${parentDir}/${common}`;
  const home = process.env.HOME || '/root';
  const display = partial.startsWith('~') && full.startsWith(home) ? '~' + full.slice(home.length) : full;
  return { completed: display, options: entries };
}

function renderWorkdirPrompt(client: Client, flow: ReturnType<typeof creationFlow.get>): void {
  if (!flow) return;

  client.write('\x1b[2J\x1b[H');
  client.write('\x1b[1mWorking directory:\x1b[0m (tab=complete, enter=confirm, esc=cancel)\r\n');

  const history = dirScanner.getHistory();
  if (history.length > 0) {
    client.write('\r\n  \x1b[38;5;245mRecent:\x1b[0m\r\n');
    const shown = history.slice(0, 9);
    for (let i = 0; i < shown.length; i++) {
      client.write(`  \x1b[33m${i + 1}\x1b[0m) ${shown[i]}\r\n`);
    }
  }

  client.write(`\r\n  Path [\x1b[38;5;245m~\x1b[0m]: ${flow.buffer}`);
}

function finalizeSession(client: Client): void {
  const flow = creationFlow.get(client.id);
  if (!flow) return;
  creationFlow.delete(client.id);

  const access: Partial<SessionAccess> = {
    owner: client.username,
    hidden: flow.hidden,
    public: flow.public,
    allowedUsers: Array.from(flow.selectedUsers),
    allowedGroups: Array.from(flow.selectedGroups),
    passwordHash: flow.buffer ? hashPassword(flow.buffer) : null,
    viewOnly: flow.viewOnly,
  };

  try {
    const commandArgs: string[] = [];
    if (flow.isResume) commandArgs.push('--resume');
    if (flow.dangerousSkipPermissions) commandArgs.push('--dangerously-skip-permissions');
    const runAs = flow.runAsUser || client.username;
    const remote = flow.remoteHost || undefined;
    console.log(`[create] ${client.username} creating "${flow.name}" as ${runAs} on ${remote || 'local'}`);
    const session = sessionManager.createSession(flow.name, client, runAs, 'claude', access, commandArgs, remote, flow.workingDir);
    if (flow.workingDir) {
      dirScanner.addToHistory(flow.workingDir);
    }
    const state = clientState.get(client.id);
    if (state) {
      state.mode = 'session';
      state.sessionId = session.id;
    }
    sessionManager.setOnClientDetach(session.id, (detachedClient) => {
      if (detachedClient.id === client.id) {
        showLobby(client);
      }
    });
    client.write('\x1b[2J\x1b[H');
  } catch (err: any) {
    client.write(`\r\nError: ${err.message}\r\n`);
    showLobby(client);
  }
}

function startResumeFlow(client: Client): void {
  const dead = listDeadSessions().filter(s =>
    s.access?.owner === client.username || s.runAsUser === client.username
  );

  restartFlow.set(client.id, { deadSessions: dead, cursor: 0 });
  renderRestartPicker(client);
}

function renderRestartPicker(client: Client): void {
  const flow = restartFlow.get(client.id);
  if (!flow) return;

  client.write('\x1b[2J\x1b[H');
  client.write('\x1b[1mRestart previous session:\x1b[0m\r\n\r\n');

  if (flow.deadSessions.length > 0) {
    for (let i = 0; i < flow.deadSessions.length; i++) {
      const s = flow.deadSessions[i];
      const arrow = i === flow.cursor ? '\x1b[33m>\x1b[0m' : ' ';
      const date = new Date(s.createdAt);
      const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const owner = s.access?.owner || s.runAsUser;
      const displayName = s.name.startsWith('resume-') ? `\x1b[38;5;245m${s.name}\x1b[0m` : s.name;
      const vis = s.access?.viewOnly ? ' [view-only]' : '';
      client.write(`  ${arrow} ${i + 1}. ${displayName}${vis} \x1b[38;5;245m${dateStr} @${owner}\x1b[0m\r\n`);
    }
    client.write('\r\n');
  } else {
    client.write('  No dead sessions found.\r\n\r\n');
  }

  // Deep scan is always the last option
  const dsIdx = flow.deadSessions.length;
  const dsCursor = flow.cursor === dsIdx ? '\x1b[33m>\x1b[0m' : ' ';
  client.write(`  ${dsCursor} \x1b[36mD. Deep scan — browse all past Claude sessions\x1b[0m\r\n`);
  client.write('\r\n  \x1b[90marrows to select, enter to restart, esc to cancel\x1b[0m\r\n');
}

function handleRestartInput(client: Client, data: Buffer): void {
  const flow = restartFlow.get(client.id);
  if (!flow) return;

  const str = data.toString();
  const totalOptions = flow.deadSessions.length + 1; // +1 for deep scan

  if (str === '\x1b' && data.length === 1) {
    restartFlow.delete(client.id);
    showLobby(client);
    return;
  }

  if (str === '\x1b[A') {
    flow.cursor = Math.max(0, flow.cursor - 1);
    renderRestartPicker(client);
    return;
  }

  if (str === '\x1b[B') {
    flow.cursor = Math.min(totalOptions - 1, flow.cursor + 1);
    renderRestartPicker(client);
    return;
  }

  // D for deep scan shortcut
  if (str === 'd' || str === 'D') {
    restartFlow.delete(client.id);
    launchDeepScan(client);
    return;
  }

  if (str === '\r' || str === '\n') {
    // Deep scan option (last item)
    if (flow.cursor === flow.deadSessions.length) {
      restartFlow.delete(client.id);
      launchDeepScan(client);
      return;
    }

    // Restart a dead session with its original settings
    const dead = flow.deadSessions[flow.cursor];
    restartFlow.delete(client.id);

    try {
      console.log(`[restart] ${client.username} restarting "${dead.name}" with original settings`);
      const resumeArgs = dead.claudeSessionId ? ['--resume', dead.claudeSessionId] : ['--resume'];
      const session = sessionManager.createSession(
        dead.name,
        client,
        dead.runAsUser || client.username,
        'claude',
        dead.access,
        resumeArgs,
        undefined,
        dead.workingDir,
      );

      const state = clientState.get(client.id);
      if (state) {
        state.mode = 'session';
        state.sessionId = session.id;
      }
      sessionManager.setOnClientDetach(session.id, (detachedClient) => {
        if (detachedClient.id === client.id) showLobby(client);
      });
      client.write('\x1b[2J\x1b[H');
    } catch (err: any) {
      client.write(`\r\nError: ${err.message}\r\n`);
      setTimeout(() => showLobby(client), 2000);
    }
    return;
  }
}

function launchDeepScan(client: Client): void {
  // Go through session creation flow, then launch with --resume
  // Reuse the creation flow but mark it as a resume
  creationFlow.set(client.id, {
    step: 'name',
    name: '',
    runAsUser: client.username,
    hidden: false,
    viewOnly: false,
    dangerousSkipPermissions: false,
    public: true,
    selectedUsers: new Set(),
    selectedGroups: new Set(),
    availableUsers: getClaudeUsers().filter(u => u !== client.username),
    availableGroups: getClaudeGroups(),
    userCursor: 0,
    groupCursor: 0,
    buffer: '',
    isResume: true,
  });
  client.write('\x1b[2J\x1b[H');
  client.write(`\x1b[1mDeep scan — new session with Claude resume picker\x1b[0m (as ${client.username})\r\n\r\n`);
  client.write('Session name: ');
}

function startExportFlow(client: Client): void {
  const sessions = findUserSessions(client.username);
  if (sessions.length === 0) {
    client.write('\x1b[2J\x1b[H');
    client.write('  No sessions found to export.\r\n\r\n  Press any key...');
    // One-key return using restartFlow hack
    exportFlow.set(client.id, { sessions: [], selected: new Set(), cursor: 0 });
    return;
  }
  exportFlow.set(client.id, { sessions, selected: new Set(), cursor: 0 });
  renderExportPicker(client);
}

function renderExportPicker(client: Client): void {
  const flow = exportFlow.get(client.id);
  if (!flow) return;

  client.write('\x1b[2J\x1b[H');
  client.write('  \x1b[1mExport sessions\x1b[0m\r\n');
  client.write(`  \x1b[38;5;245mspace=toggle, a=select all, enter=export selected, esc=cancel\x1b[0m\r\n\r\n`);

  for (let i = 0; i < flow.sessions.length; i++) {
    const s = flow.sessions[i];
    const arrow = i === flow.cursor ? '\x1b[33m>\x1b[0m' : ' ';
    const checked = flow.selected.has(i) ? '\x1b[32m[x]\x1b[0m' : '[ ]';
    const date = s.date ? s.date.toLocaleDateString() + ' ' + s.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const size = s.sizeBytes ? (s.sizeBytes > 1048576 ? `${(s.sizeBytes / 1048576).toFixed(1)}MB` : `${Math.round(s.sizeBytes / 1024)}KB`) : '';
    const msg = s.firstMessage ? `\x1b[36m${s.firstMessage}\x1b[0m` : `\x1b[38;5;245m(no message)\x1b[0m`;
    client.write(`  ${arrow} ${checked} ${date} ${size} ${msg}\r\n`);
  }

  client.write(`\r\n  \x1b[38;5;245m${flow.selected.size} of ${flow.sessions.length} selected\x1b[0m\r\n`);
}

function handleExportInput(client: Client, data: Buffer): void {
  const flow = exportFlow.get(client.id);
  if (!flow) return;
  const str = data.toString();

  // No sessions — any key returns
  if (flow.sessions.length === 0) {
    exportFlow.delete(client.id);
    showLobby(client);
    return;
  }

  if (str === '\x1b' && data.length === 1) {
    exportFlow.delete(client.id);
    showLobby(client);
    return;
  }

  if (str === '\x1b[A' || str === '\x1bOA') {
    flow.cursor = Math.max(0, flow.cursor - 1);
    renderExportPicker(client);
    return;
  }

  if (str === '\x1b[B' || str === '\x1bOB') {
    flow.cursor = Math.min(flow.sessions.length - 1, flow.cursor + 1);
    renderExportPicker(client);
    return;
  }

  // Space toggles
  if (str === ' ') {
    if (flow.selected.has(flow.cursor)) flow.selected.delete(flow.cursor);
    else flow.selected.add(flow.cursor);
    renderExportPicker(client);
    return;
  }

  // A selects all
  if (str === 'a' || str === 'A') {
    if (flow.selected.size === flow.sessions.length) {
      flow.selected.clear();
    } else {
      for (let i = 0; i < flow.sessions.length; i++) flow.selected.add(i);
    }
    renderExportPicker(client);
    return;
  }

  // Enter exports
  if (str === '\r' || str === '\n') {
    if (flow.selected.size === 0) {
      client.write('\r\n  No sessions selected.\r\n');
      return;
    }

    const toExport = Array.from(flow.selected).map(i => flow.sessions[i]);
    exportFlow.delete(client.id);

    client.write('\x1b[2J\x1b[H');
    client.write(`  Exporting ${toExport.length} session(s)...\r\n`);

    try {
      const zipPath = createExportZip(toExport, client.username);
      client.write(`\r\n  \x1b[32mExport complete!\x1b[0m\r\n\r\n`);
      client.write(`  Download with:\r\n`);
      client.write(`  \x1b[36mscp -P 22 ${client.username}@${hostname()}:${zipPath} .\x1b[0m\r\n`);
      client.write(`\r\n  Or from this machine:\r\n`);
      client.write(`  \x1b[36m${zipPath}\x1b[0m\r\n`);
      client.write(`\r\n  To install on another machine:\r\n`);
      client.write(`  \x1b[36munzip claude-export-*.zip && ./install.sh\x1b[0m\r\n`);
      client.write(`\r\n  Press any key to return to lobby...\r\n`);

      // One-key return
      exportFlow.set(client.id, { sessions: [], selected: new Set(), cursor: 0 });
    } catch (err: any) {
      client.write(`\r\n  \x1b[31mExport failed: ${err.message}\x1b[0m\r\n`);
      client.write(`\r\n  Press any key to return...\r\n`);
      exportFlow.set(client.id, { sessions: [], selected: new Set(), cursor: 0 });
    }
    return;
  }
}

function handleCreationInput(client: Client, data: Buffer): void {
  const flow = creationFlow.get(client.id);
  if (!flow) return;

  const str = data.toString();

  // Escape cancels at any step
  if (str === '\x1b' && data.length === 1) {
    creationFlow.delete(client.id);
    showLobby(client);
    return;
  }

  if (flow.step === 'name') {
    if (str === '\x7f' || str === '\b') {
      if (flow.buffer.length > 0) { flow.buffer = flow.buffer.slice(0, -1); client.write('\b \b'); }
      return;
    }
    if (str === '\r' || str === '\n') {
      if (flow.buffer.trim() === '') { client.write('\r\nName cannot be empty. Session name: '); return; }
      flow.name = flow.buffer.trim();
      flow.buffer = '';
      flow.step = 'workdir';
      renderWorkdirPrompt(client, flow);
      return;
    }
    flow.buffer += str;
    client.write(str);
    return;
  }

  if (flow.step === 'workdir') {
    // Escape cancels
    if (str === '\x1b' && data.length === 1) {
      creationFlow.delete(client.id);
      showLobby(client);
      return;
    }
    // Backspace
    if (str === '\x7f' || str === '\b') {
      if (flow.buffer.length > 0) { flow.buffer = flow.buffer.slice(0, -1); client.write('\b \b'); }
      return;
    }
    // Tab — filesystem completion
    if (str === '\t') {
      const input = flow.buffer || '~';
      const result = tabComplete(input);
      if (result.completed !== input) {
        flow.buffer = result.completed;
        renderWorkdirPrompt(client, flow);
      } else if (result.options.length > 1) {
        // Show options
        client.write('\r\n');
        for (const opt of result.options) {
          client.write(`  ${opt}\r\n`);
        }
        client.write(`\r\n  Path [~]: ${flow.buffer}`);
      }
      return;
    }
    // Number shortcut for history
    if (flow.buffer === '' && str >= '1' && str <= '9') {
      const history = dirScanner.getHistory();
      const idx = parseInt(str) - 1;
      if (idx < history.length) {
        flow.workingDir = history[idx];
        flow.buffer = '';
        if (isAdmin(client.username)) {
          flow.step = 'runas';
          client.write(`\r\n  \x1b[32m${history[idx]}\x1b[0m\r\n\r\nRun as user [${client.username}]: `);
        } else {
          flow.step = 'hidden';
          client.write(`\r\n  \x1b[32m${history[idx]}\x1b[0m\r\n\r\nHidden session? (only you can see it) [\x1b[1mN\x1b[0m/y]: `);
        }
        return;
      }
    }
    // Enter — confirm path
    if (str === '\r' || str === '\n') {
      const dir = flow.buffer.trim();
      if (!dir) {
        // Empty = home directory (default)
        flow.workingDir = undefined;
        flow.buffer = '';
      } else {
        const resolved = dir.startsWith('~') ? dir.replace('~', process.env.HOME || '/root') : dir;
        flow.workingDir = resolved;
        flow.buffer = '';
      }
      if (isAdmin(client.username)) {
        flow.step = 'runas';
        client.write(`\r\n\r\nRun as user [${client.username}]: `);
      } else {
        flow.step = 'hidden';
        client.write(`\r\n\r\nHidden session? (only you can see it) [\x1b[1mN\x1b[0m/y]: `);
      }
      return;
    }
    // Printable character
    flow.buffer += str;
    client.write(str);
    return;
  }

  if (flow.step === 'runas') {
    if (str === '\x7f' || str === '\b') {
      if (flow.buffer.length > 0) { flow.buffer = flow.buffer.slice(0, -1); client.write('\b \b'); }
      return;
    }
    if (str === '\r' || str === '\n') {
      flow.runAsUser = flow.buffer.trim() || client.username;
      flow.buffer = '';
      // If root and remotes configured, show server picker
      if (client.username === 'root' && config.remotes && config.remotes.length > 0) {
        flow.step = 'server';
        flow.serverCursor = 0;
        renderServerPicker(client, flow);
      } else {
        flow.step = 'hidden';
        client.write(`\r\n\r\nHidden session? (only you can see it) [\x1b[1mN\x1b[0m/y]: `);
      }
      return;
    }
    flow.buffer += str;
    client.write(str);
    return;
  }

  if (flow.step === 'server') {
    const remotes = config.remotes || [];
    const totalOptions = remotes.length + 1; // +1 for local

    if (str === '\x1b[A' || str === '\x1bOA') {
      flow.serverCursor = Math.max(0, (flow.serverCursor ?? 0) - 1);
      renderServerPicker(client, flow);
      return;
    }
    if (str === '\x1b[B' || str === '\x1bOB') {
      flow.serverCursor = Math.min(totalOptions - 1, (flow.serverCursor ?? 0) + 1);
      renderServerPicker(client, flow);
      return;
    }
    // Number shortcut
    if (/^[0-9]$/.test(str)) {
      const idx = parseInt(str);
      if (idx < totalOptions) {
        flow.serverCursor = idx;
        renderServerPicker(client, flow);
      }
      return;
    }
    if (str === '\r' || str === '\n' || str === ' ') {
      const cursor = flow.serverCursor ?? 0;
      if (cursor === 0) {
        flow.remoteHost = undefined; // local
      } else {
        flow.remoteHost = remotes[cursor - 1].host;
      }
      flow.step = 'hidden';
      client.write(`\r\n\r\nHidden session? (only you can see it) [\x1b[1mN\x1b[0m/y]: `);
      return;
    }
    if (str === '\x1b' && data.length === 1) {
      creationFlow.delete(client.id);
      showLobby(client);
      return;
    }
    return;
  }

  if (flow.step === 'hidden') {
    if (str === 'y' || str === 'Y') {
      flow.hidden = true;
      flow.public = false;
      flow.step = 'viewonly';
      client.write('y\r\n\r\nView-only? (only you can type, others watch) [\x1b[1mN\x1b[0m/y]: ');
      return;
    }
    if (str === 'n' || str === 'N' || str === '\r' || str === '\n') {
      flow.hidden = false;
      flow.step = 'viewonly';
      client.write('n\r\n\r\nView-only? (only you can type, others watch) [\x1b[1mN\x1b[0m/y]: ');
      return;
    }
    return;
  }

  if (flow.step === 'viewonly') {
    if (str === 'y' || str === 'Y') {
      flow.viewOnly = true;
      client.write('y');
    } else if (str === 'n' || str === 'N' || str === '\r' || str === '\n') {
      flow.viewOnly = false;
      client.write('n');
    } else {
      return;
    }
    // If hidden, skip public/users/groups — go straight to password
    if (flow.hidden) {
      flow.step = 'password';
      client.write('\r\n\r\nPassword (enter for none): ');
      flow.buffer = '';
    } else {
      flow.step = 'public';
      client.write('\r\n\r\nPublic session? (anyone can join) [\x1b[1mY\x1b[0m/n]: ');
    }
    return;
  }

  if (flow.step === 'public') {
    if (str === 'y' || str === 'Y' || str === '\r' || str === '\n') {
      flow.public = true;
      flow.step = 'password';
      client.write('y\r\n\r\nPassword (enter for none): ');
      flow.buffer = '';
      return;
    }
    if (str === 'n' || str === 'N') {
      flow.public = false;
      flow.step = 'users';
      flow.buffer = '';
      renderUserPicker(flow, client);
      return;
    }
    return;
  }

  if (flow.step === 'users') {
    // Arrow up
    if (str === '\x1b[A') {
      flow.userCursor = Math.max(0, flow.userCursor - 1);
      renderUserPicker(flow, client);
      return;
    }
    // Arrow down
    if (str === '\x1b[B') {
      flow.userCursor = Math.min(flow.availableUsers.length - 1, flow.userCursor + 1);
      renderUserPicker(flow, client);
      return;
    }
    // Space toggles
    if (str === ' ') {
      const user = flow.availableUsers[flow.userCursor];
      if (user) {
        if (flow.selectedUsers.has(user)) flow.selectedUsers.delete(user);
        else flow.selectedUsers.add(user);
      }
      renderUserPicker(flow, client);
      return;
    }
    // Enter proceeds
    if (str === '\r' || str === '\n') {
      // If there's text in buffer, add as manual user
      if (flow.buffer.trim()) {
        flow.selectedUsers.add(flow.buffer.trim());
        flow.buffer = '';
      }
      flow.step = 'groups';
      flow.buffer = '';
      renderGroupPicker(flow, client);
      return;
    }
    // Backspace
    if (str === '\x7f' || str === '\b') {
      if (flow.buffer.length > 0) { flow.buffer = flow.buffer.slice(0, -1); renderUserPicker(flow, client); }
      return;
    }
    // Typing a username
    flow.buffer += str;
    client.write(str);
    return;
  }

  if (flow.step === 'groups') {
    if (str === '\x1b[A') {
      flow.groupCursor = Math.max(0, flow.groupCursor - 1);
      renderGroupPicker(flow, client);
      return;
    }
    if (str === '\x1b[B') {
      flow.groupCursor = Math.min(flow.availableGroups.length - 1, flow.groupCursor + 1);
      renderGroupPicker(flow, client);
      return;
    }
    if (str === ' ') {
      const group = flow.availableGroups[flow.groupCursor];
      if (group) {
        if (flow.selectedGroups.has(group.name)) flow.selectedGroups.delete(group.name);
        else flow.selectedGroups.add(group.name);
      }
      renderGroupPicker(flow, client);
      return;
    }
    if (str === '\r' || str === '\n') {
      // If there's text in buffer, add as manual group
      if (flow.buffer.trim()) {
        const name = sanitizeGroupName(flow.buffer.trim());
        if (name) flow.selectedGroups.add(name);
        flow.buffer = '';
      }
      flow.step = 'password';
      flow.buffer = '';
      client.write('\x1b[2J\x1b[H');
      client.write('Password (enter for none): ');
      return;
    }
    if (str === '\x7f' || str === '\b') {
      if (flow.buffer.length > 0) { flow.buffer = flow.buffer.slice(0, -1); renderGroupPicker(flow, client); }
      return;
    }
    flow.buffer += str;
    client.write(str);
    return;
  }

  if (flow.step === 'password') {
    if (str === '\x7f' || str === '\b') {
      if (flow.buffer.length > 0) { flow.buffer = flow.buffer.slice(0, -1); client.write('\b \b'); }
      return;
    }
    if (str === '\r' || str === '\n') {
      if (isAdmin(client.username)) {
        flow.step = 'dangermode';
        client.write(`\r\n\r\nSkip permissions (--dangerously-skip-permissions)? [\x1b[1mN\x1b[0m/y]: `);
      } else {
        finalizeSession(client);
      }
      return;
    }
    flow.buffer += str;
    client.write('*');  // mask password
    return;
  }

  if (flow.step === 'dangermode') {
    if (str === 'y' || str === 'Y') {
      flow.dangerousSkipPermissions = true;
      client.write('y');
    } else if (str === 'n' || str === 'N' || str === '\r' || str === '\n') {
      flow.dangerousSkipPermissions = false;
      client.write('n');
    } else {
      return;
    }
    client.write('\r\n');
    finalizeSession(client);
    return;
  }
}

transport.onConnect((client) => {
  console.log(`[connect] ${client.username} (${client.termSize.cols}x${client.termSize.rows})`);
  clientState.set(client.id, {
    mode: 'lobby',
    selectedIndex: 0,
    client,
  });

  transport.onData(client, (data) => {
    const state = clientState.get(client.id);
    if (!state) return;

    if (creationFlow.has(client.id)) {
      handleCreationInput(client, data);
      return;
    }

    if (exportFlow.has(client.id)) {
      handleExportInput(client, data);
      return;
    }

    if (restartFlow.has(client.id)) {
      handleRestartInput(client, data);
      return;
    }

    // Handle password prompt for joining
    if (passwordFlow.has(client.id)) {
      const pf = passwordFlow.get(client.id)!;
      const str = data.toString();
      if (str === '\x1b' && data.length === 1) { passwordFlow.delete(client.id); showLobby(client); return; }
      if (str === '\x7f' || str === '\b') { if (pf.buffer.length > 0) { pf.buffer = pf.buffer.slice(0, -1); client.write('\b \b'); } return; }
      if (str === '\r' || str === '\n') {
        const session = sessionManager.getSession(pf.sessionId);
        if (session && session.access.passwordHash === hashPassword(pf.buffer)) {
          passwordFlow.delete(client.id);
          joinSession(client, pf.sessionId);
        } else {
          client.write('\r\nWrong password.\r\n');
          passwordFlow.delete(client.id);
          setTimeout(() => showLobby(client), 1000);
        }
        return;
      }
      pf.buffer += str;
      client.write('*');
      return;
    }

    if (state.mode === 'lobby') {
      const sessions = sessionManager.listSessionsForUser(client.username);
      const result = lobby.handleInput(data, sessions, state.selectedIndex);

      switch (result.type) {
        case 'navigate':
          state.selectedIndex = result.cursor;
          showLobby(client);
          break;
        case 'select':
          if (result.action === 'join' && result.sessionIndex !== undefined) {
            const target = sessions[result.sessionIndex];
            if (target) {
              const check = sessionManager.canUserJoin(client.username, target.id);
              if (check.needsPassword) {
                passwordFlow.set(client.id, { sessionId: target.id, buffer: '' });
                client.write('\x1b[2J\x1b[H');
                client.write(`Password for "${target.name}": `);
                break;
              }
              if (check.allowed) {
                joinSession(client, target.id);
              }
            }
          } else if (result.action === 'new') {
            console.log(`[lobby] ${client.username} starting new session flow`);
            startNewSessionFlow(client);
          } else if (result.action === 'continue') {
            startResumeFlow(client);
          } else if (result.action === 'export') {
            startExportFlow(client);
          } else if (result.action === 'quit') {
            client.write('\r\nGoodbye!\r\n');
          } else if (result.action === 'refresh') {
            showLobby(client);
          }
          break;
      }
    } else if (state.mode === 'session' && state.sessionId) {
      sessionManager.handleInput(state.sessionId, client, data);
    }
  });

  transport.onResize(client, (size) => {
    const state = clientState.get(client.id);
    if (!state) return;

    if (state.mode === 'lobby') {
      showLobby(client);
    } else if (state.mode === 'session' && state.sessionId) {
      sessionManager.handleResize(state.sessionId, client, size);
    }
  });

  transport.onDisconnect(client, () => {
    const state = clientState.get(client.id);
    if (state?.mode === 'session' && state.sessionId) {
      sessionManager.leaveSession(state.sessionId, client);
    }
    clientState.delete(client.id);
    creationFlow.delete(client.id);
  });

  showLobby(client);
});

sessionManager.setOnSessionEnd((sessionId) => {
  for (const state of clientState.values()) {
    if (state.mode === 'session' && state.sessionId === sessionId) {
      showLobby(state.client);
    } else if (state.mode === 'lobby') {
      showLobby(state.client);
    }
  }
});

process.on('SIGINT', async () => {
  console.log('\nShutting down (sessions will persist in tmux)...');
  sessionManager.detachAll();
  await transport.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received (sessions will persist in tmux)...');
  sessionManager.detachAll();
  await transport.stop();
  process.exit(0);
});

transport.start();

// Start API server for browser clients
const apiPort = (config as any).api?.port ?? 3101;
const apiHost = (config as any).api?.host ?? '127.0.0.1';
const webDir = resolve(__dirname, '..', 'web');
startApiServer({
  port: apiPort,
  host: apiHost,
  sessionManager,
  config,
  staticDir: webDir,
  dirScanner,
});
