# claude-proxy

SSH multiplexer for shared Claude Code terminal sessions. Multiple users connect via SSH, share live Claude sessions, and collaborate in real-time.

## Features

- **Shared sessions** — multiple users connect to the same Claude Code session simultaneously
- **Persistent sessions** — sessions survive SSH disconnects and proxy restarts (tmux-backed)
- **Session lobby** — interactive menu to create, join, restart, and export sessions
- **Access control** — per-session: hidden, password-protected, view-only, allowed users/groups
- **Admin system** — system-wide admins (cp-admins group) and per-session admins
- **Session resume** — restart dead sessions or browse all past Claude conversations
- **Export** — zip sessions with install script for restoring on another machine
- **Title bar status** — session name, connected users, typing indicators, uptime
- **Hotkey system** — tmux-style `Ctrl+B` prefix for detach, help, scrollback, settings

## Requirements

- Node.js 22+
- tmux
- Claude Code (`claude` binary in PATH)
- Linux (tested on Debian 13)

## Quick Start

```bash
git clone https://github.com/frodex/claude-proxy.git
cd claude-proxy
npm install
npm run build

# Generate SSH host keys
./scripts/generate-host-keys.sh

# Start
node dist/index.js
```

Connect: `ssh -p 3100 youruser@hostname`

## Configuration

Edit `claude-proxy.yaml`:

```yaml
port: 3100
host: 0.0.0.0

auth:
  authorized_keys: ~/.ssh/authorized_keys

sessions:
  default_user: root
  scrollback_bytes: 1048576
  max_sessions: 10

lobby:
  motd: "Welcome to claude-proxy"
```

Override with CLI flag (`--port 4000`) or env var (`PORT=4000`).

## systemd

```bash
ln -sf /path/to/claude-proxy/systemd/claude-proxy.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now claude-proxy
```

## Hotkeys (in session)

| Key | Action |
|-----|--------|
| `Ctrl+B h` | Help menu (interactive) |
| `Ctrl+B d` | Detach (back to lobby) |
| `Ctrl+B s` | Claim size ownership |
| `Ctrl+B r` | Redraw screen |
| `Ctrl+B l` | Scrollback dump (terminal scrollbar) |
| `Ctrl+B b` | Scrollback viewer |
| `Ctrl+B e` | Edit session settings (owner/admin) |

## Lobby

| Key | Action |
|-----|--------|
| Arrow keys | Navigate |
| Enter/Space | Select |
| `n` | New session |
| `r` | Restart previous session |
| `e` | Export sessions |
| `q` | Quit |
| Tab | Refresh |

## Access Control

Sessions support:
- **Hidden** — only owner sees it
- **View-only** — only owner/admins can type
- **Password** — required to join
- **Allowed users/groups** — restrict who can join
- **Session admins** — can edit settings and type in view-only

System-wide: add users to the `cp-admins` group for admin access to all sessions.

## Architecture

```
SSH Client → SSH Server (ssh2) → Lobby → tmux session (claude)
                                    ↕
SSH Client → SSH Server (ssh2) → Join existing session
```

Sessions run inside tmux. The proxy attaches to tmux sessions via PTY and multiplexes output to all connected SSH clients. If the proxy restarts, tmux sessions persist and are rediscovered on startup.

## License

MIT
