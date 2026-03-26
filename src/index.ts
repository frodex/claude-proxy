// src/index.ts

import { loadConfig } from './config.js';
import { SSHTransport } from './ssh-transport.js';
import { SessionManager } from './session-manager.js';
import { Lobby } from './lobby.js';
import { setScrollRegion } from './ansi.js';
import type { Client, Session } from './types.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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

const clientState: Map<string, {
  mode: 'lobby' | 'session';
  sessionId?: string;
  selectedIndex: number;
  client: Client;
}> = new Map();

const creationFlow: Map<string, {
  step: 'name' | 'user';
  name?: string;
  buffer: string;
}> = new Map();

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

  const sessions = sessionManager.listSessions();
  const output = lobby.renderScreen({
    username: client.username,
    sessions,
    selectedIndex: state.selectedIndex,
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

function startNewSessionFlow(client: Client): void {
  creationFlow.set(client.id, { step: 'name', buffer: '' });
  client.write('\x1b[2J\x1b[H');
  client.write('Session name: ');
}

function handleCreationInput(client: Client, data: Buffer): void {
  const flow = creationFlow.get(client.id);
  if (!flow) return;

  const str = data.toString();

  if (str === '\x7f' || str === '\b') {
    if (flow.buffer.length > 0) {
      flow.buffer = flow.buffer.slice(0, -1);
      client.write('\b \b');
    }
    return;
  }

  if (str === '\x1b') {
    creationFlow.delete(client.id);
    showLobby(client);
    return;
  }

  if (str === '\r' || str === '\n') {
    if (flow.step === 'name') {
      if (flow.buffer.trim() === '') {
        client.write('\r\nName cannot be empty. Session name: ');
        return;
      }
      flow.name = flow.buffer.trim();
      flow.buffer = '';
      flow.step = 'user';
      client.write(`\r\nRun as user [${config.sessions.default_user}]: `);
      return;
    }

    if (flow.step === 'user') {
      const runAsUser = flow.buffer.trim() || config.sessions.default_user;
      creationFlow.delete(client.id);

      try {
        console.log(`[create] ${client.username} creating session "${flow.name}" as ${runAsUser}`);
        const session = sessionManager.createSession(flow.name!, client, runAsUser);
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
      return;
    }
  }

  flow.buffer += str;
  client.write(str);
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
    console.log(`[data] ${client.username} mode=${state.mode} bytes=${data.length} hex=${Array.from(data.slice(0,4)).map(b=>b.toString(16)).join(' ')}`);

    if (creationFlow.has(client.id)) {
      handleCreationInput(client, data);
      return;
    }

    if (state.mode === 'lobby') {
      const sessions = sessionManager.listSessions();
      const result = lobby.handleInput(data, {
        selectedIndex: state.selectedIndex,
        sessionCount: sessions.length,
      });

      switch (result.type) {
        case 'navigate':
          state.selectedIndex = result.selectedIndex;
          showLobby(client);
          break;
        case 'join':
          if (sessions[result.selectedIndex]) {
            joinSession(client, sessions[result.selectedIndex].id);
          }
          break;
        case 'new':
          console.log(`[lobby] ${client.username} starting new session flow`);
          startNewSessionFlow(client);
          break;
        case 'refresh':
          showLobby(client);
          break;
        case 'quit':
          client.write('\r\nGoodbye!\r\n');
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
  console.log('\nShutting down...');
  sessionManager.destroyAll();
  await transport.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  sessionManager.destroyAll();
  await transport.stop();
  process.exit(0);
});

transport.start();
