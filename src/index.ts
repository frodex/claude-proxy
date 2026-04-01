// src/index.ts

import { loadConfig } from './config.js';
import { startApiServer } from './api-server.js';
import { SSHTransport } from './ssh-transport.js';
import { SessionManager } from './session-manager.js';
import { Lobby } from './lobby.js';
import { DirScanner } from './dir-scanner.js';
import { setScrollRegion } from './ansi.js';
import { parseKey } from './widgets/keys.js';
import { ListPicker } from './widgets/list-picker.js';
import { CheckboxPicker } from './widgets/checkbox-picker.js';
import { FlowEngine } from './widgets/flow-engine.js';
import { renderListPicker, renderCheckboxPicker, renderFlowForm } from './widgets/renderers.js';
import { buildSessionFormSteps } from './session-form.js';
import { getClaudeUsers, getClaudeGroups, isUserInGroup } from './user-utils.js';
import { listDeadSessions, saveSessionMeta, loadSessionMeta, type StoredSession } from './session-store.js';
import { findUserSessions, createExportZip, type ExportableSession } from './export.js';
import { createHash } from 'crypto';
import { existsSync, readdirSync, statSync } from 'fs';
import type { Client, Session, SessionAccess } from './types.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { hostname } from 'os';
import { LinuxProvisioner } from './auth/provisioner.js';
import { SocketManager } from './ugo/socket-manager.js';
import { GroupWatcher } from './ugo/group-watcher.js';

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

const provisioner = new LinuxProvisioner();
const socketManager = new SocketManager('/var/run/claude-proxy/sessions', provisioner);
const groupWatcher = new GroupWatcher(provisioner);

const sessionManager = new SessionManager({
  defaultUser: config.sessions.default_user,
  scrollbackBytes: config.sessions.scrollback_bytes,
  maxSessions: config.sessions.max_sessions,
  socketManager,
  groupWatcher,
  provisioner,
});

const lobby = new Lobby({ motd: config.lobby.motd });

const dirScanner = new DirScanner({
  historyPath: resolve(__dirname, '..', 'data', 'dir-history.json'),
});

// Discover existing tmux sessions from previous proxy instance
sessionManager.discoverSessions();
sessionManager.startGroupWatcher();

const clientState: Map<string, {
  mode: 'lobby' | 'session';
  sessionId?: string;
  selectedIndex: number;
  client: Client;
}> = new Map();

const creationFlows: Map<string, { flow: FlowEngine; isResume?: boolean }> = new Map();

// Password hashing (simple SHA-256 — not bcrypt to avoid dependency)
function hashPassword(pw: string): string {
  return createHash('sha256').update(pw).digest('hex');
}

const passwordFlow: Map<string, { sessionId: string; buffer: string }> = new Map();

const restartFlows: Map<string, { picker: ListPicker; deadSessions: StoredSession[] }> = new Map();

const resumeIdFlow: Map<string, { dead: StoredSession; buffer: string }> = new Map();

const exportFlows: Map<string, { picker: CheckboxPicker; sessions: ExportableSession[] }> = new Map();

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

function renderSessionForm(client: Client): void {
  const entry = creationFlows.get(client.id);
  if (!entry) return;

  const summary = entry.flow.getFlowSummary();
  const state = entry.flow.getCurrentState();
  const missing = entry.flow.getMode() !== 'legacy' ? entry.flow.getMissingRequired() : [];
  const title = entry.isResume ? 'Resume session' : 'New session';

  client.write(renderFlowForm(title, summary, state.widget, state.stepId, missing.length > 0 ? missing : undefined));
}

function isAdmin(username: string): boolean {
  return username === 'root' || isUserInGroup(username, 'admins');
}

function startNewSessionFlow(client: Client): void {
  const steps = buildSessionFormSteps('create', client, {}, {
    getUsers: () => getClaudeUsers().filter(u => u !== client.username),
    getGroups: () => getClaudeGroups(),
    getServerItems: () => {
      const items = [{ label: 'local' }];
      for (const r of config.remotes || []) {
        items.push({ label: `${r.name} (${r.host})` });
      }
      return items;
    },
    getDirItems: (acc) => {
      const items: Array<{ label: string }> = [];
      const history = dirScanner.getHistory();
      const scanned = acc.remoteHost ? [] : dirScanner.scan();
      const historySet = new Set(history);
      for (const dir of history) items.push({ label: dir });
      for (const dir of scanned) {
        if (!historySet.has(dir)) items.push({ label: dir });
      }
      return items;
    },
  });

  const initialState: Record<string, any> = {
    _isAdmin: isAdmin(client.username),
    _hasRemotes: (config.remotes?.length ?? 0) > 0,
    _defaultUser: client.username,
    _remotes: config.remotes || [],
    _availableUsers: getClaudeUsers().filter(u => u !== client.username),
    _availableGroups: getClaudeGroups(),
  };

  const flow = new FlowEngine(steps, initialState);
  flow.setMode('navigate');
  creationFlows.set(client.id, { flow });
  renderSessionForm(client);
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


function finalizeSessionFromResults(client: Client, results: Record<string, any>, isResume?: boolean): void {
  const access: Partial<SessionAccess> = {
    owner: client.username,
    hidden: results.hidden ?? false,
    public: results.public ?? true,
    allowedUsers: results.allowedUsers ?? [],
    allowedGroups: results.allowedGroups ?? [],
    passwordHash: results.password ? hashPassword(results.password) : null,
    viewOnly: results.viewOnly ?? false,
  };

  try {
    const commandArgs: string[] = [];
    if (isResume) commandArgs.push('--resume');
    if (results.dangerousSkipPermissions) commandArgs.push('--dangerously-skip-permissions');
    const runAs = results.runAsUser || client.username;
    const remote = results.remoteHost || undefined;
    const workDir = results.workingDir || undefined;

    console.log(`[create] ${client.username} creating "${results.name}" as ${runAs} on ${remote || 'local'}`);
    const session = sessionManager.createSession(results.name, client, runAs, 'claude', access, commandArgs, remote, workDir);

    if (workDir) dirScanner.addToHistory(workDir);

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
    showLobby(client);
  }
}

function startResumeFlow(client: Client): void {
  const dead = listDeadSessions().filter(s =>
    s.access?.owner === client.username || s.runAsUser === client.username
  );

  const items = dead.map((s, i) => {
    const date = new Date(s.createdAt);
    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const owner = s.access?.owner || s.runAsUser;
    const displayName = s.name.startsWith('resume-') ? `\x1b[38;5;245m${s.name}\x1b[0m` : s.name;
    const vis = s.access?.viewOnly ? ' [view-only]' : '';
    return { label: `${i + 1}. ${displayName}${vis} \x1b[38;5;245m${dateStr} @${owner}\x1b[0m` };
  });
  items.push({ label: '\x1b[36mD. Deep scan — browse all past Claude sessions\x1b[0m' });

  const picker = new ListPicker({
    items,
    title: 'Restart previous session:',
    hint: 'arrows to select, enter to restart, D=deep scan, esc to cancel',
  });

  restartFlows.set(client.id, { picker, deadSessions: dead });
  client.write(renderListPicker(picker.state));
}

function handleRestartInput(client: Client, data: Buffer): void {
  const flow = restartFlows.get(client.id);
  if (!flow) return;

  const str = data.toString();

  // D for deep scan shortcut (before delegating to picker)
  if (str === 'd' || str === 'D') {
    restartFlows.delete(client.id);
    launchDeepScan(client);
    return;
  }

  const key = parseKey(data);
  const event = flow.picker.handleKey(key);

  if (event.type === 'cancel') {
    restartFlows.delete(client.id);
    showLobby(client);
    return;
  }

  if (event.type === 'select') {
    // Deep scan option (last item)
    if (event.index === flow.deadSessions.length) {
      restartFlows.delete(client.id);
      launchDeepScan(client);
      return;
    }

    // Prompt for Claude session ID before restarting
    const dead = flow.deadSessions[event.index];
    restartFlows.delete(client.id);
    resumeIdFlow.set(client.id, { dead, buffer: dead.claudeSessionId || '' });
    renderResumeIdPrompt(client);
    return;
  }

  if (event.type === 'navigate') {
    client.write(renderListPicker(flow.picker.state));
  }
}

function renderResumeIdPrompt(client: Client): void {
  const flow = resumeIdFlow.get(client.id);
  if (!flow) return;
  client.write('\x1b[2J\x1b[H');
  client.write(`\x1b[1mRestarting: ${flow.dead.name}\x1b[0m\r\n\r\n`);
  client.write(`  Claude session ID to resume\r\n`);
  client.write(`  \x1b[90m(paste ID for exact resume, or leave blank for picker)\x1b[0m\r\n\r\n`);
  client.write(`  > ${flow.buffer}\x1b[K`);
}

function handleResumeIdInput(client: Client, data: Buffer): void {
  const flow = resumeIdFlow.get(client.id);
  if (!flow) return;
  const str = data.toString();

  // Esc or Ctrl+C — cancel back to lobby
  if ((str === '\x1b' && data.length === 1) || str === '\x03') {
    resumeIdFlow.delete(client.id);
    showLobby(client);
    return;
  }

  // Backspace
  if (str === '\x7f' || str === '\b') {
    if (flow.buffer.length > 0) {
      flow.buffer = flow.buffer.slice(0, -1);
      client.write('\b \b');
    }
    return;
  }

  // Enter — launch with whatever ID is in the buffer
  if (str === '\r' || str === '\n') {
    const sessionId = flow.buffer.trim();
    const dead = flow.dead;
    resumeIdFlow.delete(client.id);

    // Save the session ID to metadata for future restarts
    if (sessionId) {
      try {
        const meta = loadSessionMeta(dead.tmuxId);
        if (meta) {
          meta.claudeSessionId = sessionId;
          saveSessionMeta(dead.tmuxId, meta);
        }
      } catch {}
    }

    try {
      const resumeArgs = sessionId ? ['--resume', sessionId] : ['--resume'];
      console.log(`[restart] ${client.username} restarting "${dead.name}" with resume ${sessionId || '(picker)'}`);
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

  // Printable character — add to buffer
  if (str.length === 1 && str.charCodeAt(0) >= 32) {
    flow.buffer += str;
    client.write(str);
  }

  // Handle paste (multiple chars at once)
  if (str.length > 1 && !str.startsWith('\x1b')) {
    flow.buffer += str;
    client.write(str);
  }
}

function launchDeepScan(client: Client): void {
  const steps = buildSessionFormSteps('create', client, {}, {
    getUsers: () => getClaudeUsers().filter(u => u !== client.username),
    getGroups: () => getClaudeGroups(),
    getServerItems: () => {
      const items = [{ label: 'local' }];
      for (const r of config.remotes || []) {
        items.push({ label: `${r.name} (${r.host})` });
      }
      return items;
    },
    getDirItems: (acc) => {
      const items: Array<{ label: string }> = [];
      const history = dirScanner.getHistory();
      const scanned = acc.remoteHost ? [] : dirScanner.scan();
      const historySet = new Set(history);
      for (const dir of history) items.push({ label: dir });
      for (const dir of scanned) {
        if (!historySet.has(dir)) items.push({ label: dir });
      }
      return items;
    },
  });

  const initialState: Record<string, any> = {
    _isAdmin: isAdmin(client.username),
    _hasRemotes: (config.remotes?.length ?? 0) > 0,
    _defaultUser: client.username,
    _remotes: config.remotes || [],
    _availableUsers: getClaudeUsers().filter(u => u !== client.username),
    _availableGroups: getClaudeGroups(),
  };

  const flow = new FlowEngine(steps, initialState);
  flow.setMode('navigate');
  creationFlows.set(client.id, { flow, isResume: true });
  renderSessionForm(client);
}

function startExportFlow(client: Client): void {
  const sessions = findUserSessions(client.username);
  if (sessions.length === 0) {
    client.write('\x1b[2J\x1b[H');
    client.write('  No sessions found to export.\r\n\r\n  Press any key...');
    // One-key return using empty flow
    exportFlows.set(client.id, {
      picker: new CheckboxPicker({ items: [] }),
      sessions: [],
    });
    return;
  }

  const items = sessions.map(s => {
    const date = s.date ? s.date.toLocaleDateString() + ' ' + s.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const size = s.sizeBytes ? (s.sizeBytes > 1048576 ? `${(s.sizeBytes / 1048576).toFixed(1)}MB` : `${Math.round(s.sizeBytes / 1024)}KB`) : '';
    const msg = s.firstMessage ? `\x1b[36m${s.firstMessage}\x1b[0m` : `\x1b[38;5;245m(no message)\x1b[0m`;
    return { label: `${date} ${size} ${msg}` };
  });

  const picker = new CheckboxPicker({
    items,
    title: 'Export sessions',
    hint: 'space=toggle, a=select all, enter=export selected, esc=cancel',
  });

  exportFlows.set(client.id, { picker, sessions });
  client.write(renderCheckboxPicker(picker.state));
}

function handleExportInput(client: Client, data: Buffer): void {
  const flow = exportFlows.get(client.id);
  if (!flow) return;
  const str = data.toString();

  // No sessions — any key returns
  if (flow.sessions.length === 0) {
    exportFlows.delete(client.id);
    showLobby(client);
    return;
  }

  // 'a'/'A' toggle-all shortcut (not built into CheckboxPicker)
  if (str === 'a' || str === 'A') {
    const sel = flow.picker.state.selected;
    if (sel.size === flow.sessions.length) {
      sel.clear();
    } else {
      for (let i = 0; i < flow.sessions.length; i++) sel.add(i);
    }
    client.write(renderCheckboxPicker(flow.picker.state));
    return;
  }

  const key = parseKey(data);
  const event = flow.picker.handleKey(key);

  if (event.type === 'cancel') {
    exportFlows.delete(client.id);
    showLobby(client);
    return;
  }

  if (event.type === 'submit') {
    if (event.selectedIndices.length === 0) {
      client.write('\r\n  No sessions selected.\r\n');
      return;
    }

    const toExport = event.selectedIndices.map(i => flow.sessions[i]);
    exportFlows.delete(client.id);

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
      exportFlows.set(client.id, {
        picker: new CheckboxPicker({ items: [] }),
        sessions: [],
      });
    } catch (err: any) {
      client.write(`\r\n  \x1b[31mExport failed: ${err.message}\x1b[0m\r\n`);
      client.write(`\r\n  Press any key to return...\r\n`);
      exportFlows.set(client.id, {
        picker: new CheckboxPicker({ items: [] }),
        sessions: [],
      });
    }
    return;
  }

  // Navigate or toggle — re-render
  if (event.type === 'navigate' || event.type === 'toggle') {
    client.write(renderCheckboxPicker(flow.picker.state));
  }
}

function handleCreationInput(client: Client, data: Buffer): void {
  const entry = creationFlows.get(client.id);
  if (!entry) return;

  const key = parseKey(data);
  const event = entry.flow.handleKey(key);

  if (event.type === 'flow-complete') {
    creationFlows.delete(client.id);
    finalizeSessionFromResults(client, event.results, entry.isResume);
  } else if (event.type === 'flow-cancelled') {
    creationFlows.delete(client.id);
    showLobby(client);
  } else if (event.type === 'widget-event') {
    const widgetEvent = event.event;
    if (widgetEvent.type === 'tab') {
      const result = tabComplete(widgetEvent.partial || '~');
      const state = entry.flow.getCurrentState();
      if (state.widget && 'setTextBuffer' in state.widget) {
        if (result.completed !== (widgetEvent.partial || '~')) {
          (state.widget as any).setTextBuffer(result.completed);
        }
      }
    }
    renderSessionForm(client);
  } else {
    // mode-change, none, step-complete — re-render
    renderSessionForm(client);
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

    if (creationFlows.has(client.id)) {
      handleCreationInput(client, data);
      return;
    }

    if (exportFlows.has(client.id)) {
      handleExportInput(client, data);
      return;
    }

    if (restartFlows.has(client.id)) {
      handleRestartInput(client, data);
      return;
    }

    if (resumeIdFlow.has(client.id)) {
      handleResumeIdInput(client, data);
      return;
    }

    // Handle password prompt for joining
    if (passwordFlow.has(client.id)) {
      const pf = passwordFlow.get(client.id)!;
      const str = data.toString();
      if ((str === '\x1b' && data.length === 1) || str === '\x03') { passwordFlow.delete(client.id); showLobby(client); return; }
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
    creationFlows.delete(client.id);
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
