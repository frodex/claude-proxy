# claude-proxy — Design Spec

**Date:** 2026-03-26
**Status:** Draft

## What This Is

A Node.js SSH server that multiplexes Claude Code terminal sessions. Multiple users connect via SSH, land in a lobby, and can create or join shared Claude sessions. The server spawns `claude` as a child process in a PTY and broadcasts the terminal output to all connected clients. Any connected user can type.

Sessions survive SSH disconnects — the PTY lives in the server process. Reconnect and rejoin from the lobby.

## Non-Goals (Phase 1)

- Web UI (Phase 3)
- Role-based permissions (Phase 2)
- Session recording/playback
- Clustering / multi-server

---

## Architecture

```
┌──────────────┐
│  SSH Client   │──┐
└──────────────┘  │
┌──────────────┐  │    ┌─────────────────────────────────┐
│  SSH Client   │──┼──▶│        claude-proxy              │
└──────────────┘  │    │                                   │
┌──────────────┐  │    │  ┌───────────┐   ┌────────────┐ │
│  SSH Client   │──┘    │  │ SSH Server│   │  Session    │ │
└──────────────┘       │  │  (ssh2)   │   │  Manager    │ │
                       │  └─────┬─────┘   └──────┬─────┘ │
                       │        │                 │        │
                       │  ┌─────▼─────────────────▼─────┐ │
                       │  │       Lobby / Router         │ │
                       │  └─────────────┬───────────────┘ │
                       │                │                  │
                       │  ┌─────────────▼───────────────┐ │
                       │  │     PTY Pool                 │ │
                       │  │  ┌─────┐ ┌─────┐ ┌─────┐   │ │
                       │  │  │PTY 1│ │PTY 2│ │PTY N│   │ │
                       │  │  │claude│ │claude│ │claude│  │ │
                       │  │  └─────┘ └─────┘ └─────┘   │ │
                       │  └─────────────────────────────┘ │
                       └─────────────────────────────────┘
```

---

## Components

### 1. SSH Server

**Library:** `ssh2` (npm)

- Listens on a configurable port (default: 3100)
- Authenticates via SSH public keys (reads from `~/.ssh/authorized_keys` or a configurable path)
- Client's SSH username becomes their display name in sessions
- Allocates a virtual terminal (PTY) per client connection for the lobby UI

### 2. Lobby

On connect, the client sees:

```
╔══════════════════════════════════════════╗
║           claude-proxy                    ║
║   Connected as: greg                      ║
╠══════════════════════════════════════════╣
║                                           ║
║   Active Sessions:                        ║
║   ▸ 1. bugfix-auth (2 users) [greg, sam] ║
║     2. feature-api (1 user)  [alice]      ║
║                                           ║
║   [n] New session                         ║
║   [q] Quit                                ║
║                                           ║
╚══════════════════════════════════════════╝
```

- Arrow keys / number keys to select
- Enter to join
- `n` to create new session (prompts for name and run-as user)
- `q` to disconnect
- Shows connected users per session

### 3. Session Manager

Manages the lifecycle of Claude sessions:

- **Create session:** spawns `claude` in a new PTY, optionally as a specific system user
- **Join session:** attaches client to an existing PTY's output stream, enables input
- **Leave session:** detaches client, session stays alive
- **Destroy session:** kills the PTY process (only when last user leaves, or explicit kill)
- **List sessions:** returns active sessions with metadata (name, users, created time)

**Run-as user:**

```javascript
// Spawns claude as a specific system user
spawn('su', ['-', targetUser, '-c', 'claude'], { /* pty options */ })
```

Configurable per-session at creation time. Defaults to the server process user.

### 4. PTY Multiplexer

The core of the system. For each Claude session:

- Spawns `claude` via `node-pty` in a pseudo-terminal
- Maintains a **scrollback buffer** (last N bytes of output) so new joiners see recent context
- **Output fan-out:** every byte from the PTY is broadcast to all attached clients
- **Input merge:** keystrokes from any attached client are written to the PTY's stdin
- **Resize handling:** PTY dimensions match the **size owner's** terminal (see Status Bar below)

### 5. Status Bar & Presence System

The proxy composites a status bar onto each client's output independently — it is NOT part of the PTY stream. The proxy reserves the bottom 2 rows of each client's terminal and renders the PTY output into the remaining viewport above.

**Layout:**

```
│ bugfix-auth │ [greg] sam alice josh              │
│             │  ⌨                                  │
```

- **Line 1:** session name (left) + user presence (right)
- **Line 2:** typing indicator for active user(s)

**Presence colors (ANSI):**

- **Orange/yellow (33m):** user is actively typing (any keystroke within last 2 seconds)
- **Gray (90m):** user is connected but idle
- **Bracketed + bold `[name]`:** this user is the **size owner** — PTY dimensions match their terminal
- Colors update in real-time as users type

**Size owner:**

- Defaults to session creator
- Transferable: `Ctrl+B` then `s` — current user claims size ownership
- When size owner's terminal resizes, PTY resizes to match
- Other clients' terminals may wrap or pad — their status bar still renders correctly at THEIR bottom edge

**Typing detection:**

- Proxy tracks last keystroke timestamp per client
- Any key within last 2 seconds = "typing" (orange)
- Timeout → idle (gray)
- No injection into the PTY stream — purely a status bar render

**Rendering approach:**

- Proxy intercepts the PTY output and re-frames it into rows `1` to `client.rows - 2`
- Rows `client.rows - 1` and `client.rows` are the status bar, rendered per-client
- Uses ANSI cursor positioning and scrolling regions (`\e[1;{n}r`) to keep the PTY output contained
- Status bar redraws on: user join/leave, typing state change, size owner change

### 6. Transport Layer (Abstract)

All client communication goes through a transport interface:

```typescript
interface Transport {
  onConnect(callback: (client: Client) => void): void;
  send(client: Client, data: Buffer): void;
  onData(client: Client, callback: (data: Buffer) => void): void;
  onDisconnect(client: Client, callback: () => void): void;
}

interface Client {
  id: string;
  username: string;
  transport: 'ssh' | 'websocket';  // Phase 3 adds websocket
  termSize: { cols: number; rows: number };
}
```

Phase 1 implements `SSHTransport`. Phase 3 adds `WebSocketTransport`. Session Manager and PTY Multiplexer never know the difference.

---

## Session Lifecycle

```
Connect → Lobby → Create/Join Session → Interact → Detach (Ctrl+B, d) → Lobby
                                                         │
                                                   SSH drops
                                                         │
                                                   Reconnect → Lobby → Rejoin
```

**Detach key:** `Ctrl+B` then `d` (tmux-style, familiar). Returns to lobby. Session stays alive.

**Session death:** when the `claude` process exits (user types `/exit`, or it crashes), the session is marked dead and removed from the lobby.

---

## Configuration

```yaml
# claude-proxy.yaml
port: 3100
host: 0.0.0.0

auth:
  authorized_keys: ~/.ssh/authorized_keys   # or a custom path

sessions:
  default_user: root                         # default run-as user
  scrollback_bytes: 1048576                  # 1MB scrollback for late joiners
  max_sessions: 10

lobby:
  motd: "Welcome to droidware claude-proxy"  # optional message of the day
```

---

## Tech Stack

| Component    | Library               | Why                                           |
| ------------ | --------------------- | --------------------------------------------- |
| Runtime      | Node.js 24            | Already installed                             |
| SSH server   | `ssh2`                | Mature, full SSH2 protocol, key auth          |
| PTY          | `node-pty`            | Industry standard PTY spawning for Node       |
| Lobby UI     | Raw ANSI escape codes | No dependency, full control, works everywhere |
| Config       | `yaml`                | Human-readable config file                    |
| Process mgmt | systemd               | Auto-start, restart on crash                  |

---

## File Structure

```
claude-proxy/
├── package.json
├── claude-proxy.yaml              # config
├── src/
│   ├── index.ts                   # entry point, loads config, starts server
│   ├── ssh-server.ts              # SSH server (ssh2), key auth
│   ├── transport.ts               # Transport interface definition
│   ├── ssh-transport.ts           # SSH transport implementation
│   ├── lobby.ts                   # Lobby UI rendering and input handling
│   ├── session-manager.ts         # Session CRUD, tracks connected clients
│   ├── pty-multiplexer.ts         # PTY spawn, fan-out, input merge
│   ├── status-bar.ts              # Per-client status bar rendering, presence tracking
│   └── types.ts                   # Shared types (Client, Session, Config)
├── host-keys/                     # Generated SSH host keys
│   ├── ssh_host_rsa_key
│   └── ssh_host_ed25519_key
└── systemd/
    └── claude-proxy.service       # systemd unit file
```

---

## Phases

### Phase 1 (Now)

- SSH server with key auth
- Lobby UI (list, create, join)
- PTY multiplexer with scrollback
- Free-for-all input
- Detach/reattach (`Ctrl+B d`)
- Run-as user per session
- **Status bar with live presence** (gray=idle, orange=typing, [bracketed]=size owner)
- **Size owner model** — PTY follows size owner's terminal, transferable via `Ctrl+B s`
- systemd service
- Transport abstraction (SSH implementation only)
- OWNER CAN TERMINATE SESSION - COULD BE AS EASY AS /EXIT <= BUT THIS MEANS ANYONE CAN TERMINATE - FINE FOR NOW.
- CUT AND PASTE MUST WORK - MOUSE TO SELECT AND PASTE / CTRL-C CTRL-V ALSO

### Phase 2

- Role system: Owner / Collaborator / Spectator
- Owner promotion/demotion from within session (hotkey menu)
- Lobby gates (password-protected sessions, invite-only)
- Session naming, pinning, archival
- Role indicators in status bar (icon or color per role)

### Phase 3

- WebSocket transport implementation
- xterm.js web client
- Shareable URL per session
- Same role system applies
- Optional: session recording/playback

---

## Resolved Questions

1. **Session timeout:** No timeout. Sessions live until the `claude` process exits or is explicitly killed.
2. **Input indicator:** Solved — status bar shows username in orange when typing (last 2s). No PTY stream injection.
3. **Resize strategy:** Size owner model. One user "owns" the PTY dimensions (default: session creator). Transferable via `Ctrl+B s`. Other clients may wrap/pad but status bar always renders correctly at their own terminal bottom.
