# claude-proxy v2.0 — Unified Product Requirements Document
**Version:** 2.0
**Date:** 2026-03-28
**Status:** Planned
**References:**
- [PRD-claude-proxy-as-built.md](PRD-claude-proxy-as-built.md) — SSH proxy, session management, access control
- [PRD-svg-terminal-as-built.md](PRD-svg-terminal-as-built.md) — 3D browser terminal viewer

---

## What It Is

A collaborative Claude Code session manager with both SSH and browser access. Multiple users share live Claude sessions in real-time — via SSH terminal or a 3D web dashboard. Sessions are persistent, access-controlled, and survive server restarts.

## Vision

One server. Two access methods. Full session lifecycle.

```
SSH Client ──────┐
                 ├──→ Session Manager ──→ tmux (claude) ←── xterm/headless buffer
Browser (3D) ────┘         │
                           ├── Access control, persistence, admin
                           └── User registration, invites (future)
```

## What Changes From the Originals

### From claude-proxy v1 → v2
- **Added:** HTTP+WebSocket API server (port 3101)
- **Added:** screen-renderer.ts — xterm cell-to-spans conversion
- **Added:** PtyMultiplexer event hooks (onRender, onCursorMove, onTitleChange)
- **Added:** Static file serving for web dashboard
- **Added:** Structured input translation (browser keystrokes → PTY escape codes)
- **Unchanged:** SSH transport, session manager, lobby, hotkeys, access control, tmux backend

### From svg-terminal → integrated
- **Removed:** server.mjs (replaced by api-server.ts)
- **Removed:** sgr-parser.mjs (replaced by screen-renderer.ts)
- **Removed:** tmux capture-pane polling (replaced by xterm onRender events)
- **Removed:** tmux send-keys (replaced by direct PTY write)
- **Modified:** dashboard.mjs — new WebSocket endpoint, new session discovery API
- **Modified:** terminal.svg — new WebSocket protocol for screen deltas
- **Modified:** Input handling — structured keys instead of tmux send-keys names
- **Unchanged:** Three.js 3D scene, CSS3DRenderer, SVG rendering approach

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    claude-proxy v2.0                          │
│                                                               │
│  ┌──────────────┐    ┌──────────────────────────────┐        │
│  │ SSH Server    │    │ HTTP + WebSocket Server       │        │
│  │ (ssh2)       │    │ (api-server.ts)               │        │
│  │ Port 3100    │    │ Port 3101                     │        │
│  └──────┬───────┘    │  GET /api/sessions            │        │
│         │            │  WS  /api/session/:id/stream  │        │
│         │            │  GET /* (static: web/)        │        │
│         │            └──────────┬─────────────────────┘        │
│         │                       │                              │
│  ┌──────▼───────────────────────▼──────────┐                  │
│  │          Session Manager                 │                  │
│  │  - Access control (hidden/public/pwd)    │                  │
│  │  - User/group permissions                │                  │
│  │  - Admin system                          │                  │
│  │  - Session lifecycle                     │                  │
│  └──────────────────┬──────────────────────┘                  │
│                     │                                          │
│  ┌──────────────────▼──────────────────────┐                  │
│  │          PtyMultiplexer                  │                  │
│  │  - tmux session ownership                │                  │
│  │  - node-pty attach                       │                  │
│  │  - Raw byte fan-out (SSH clients)        │                  │
│  │  - xterm/headless buffer                 │                  │
│  │  - onRender events → screen-renderer     │                  │
│  │  - Scrollback (raw + interpreted)        │                  │
│  └──────────────────┬──────────────────────┘                  │
│                     │                                          │
│  ┌──────────────────▼──────────────────────┐                  │
│  │          screen-renderer.ts              │                  │
│  │  - Cell → Span conversion                │                  │
│  │  - 256-color palette                     │                  │
│  │  - Dirty line tracking                   │                  │
│  │  - JSON screen state output              │                  │
│  └─────────────────────────────────────────┘                  │
│                                                               │
│  ┌─────────────────────────────────────────┐                  │
│  │  web/ (static files)                     │                  │
│  │  - index.html (dashboard entry)          │                  │
│  │  - dashboard.mjs (Three.js 3D scene)     │                  │
│  │  - terminal.svg (SVG terminal viewer)    │                  │
│  │  - dashboard.css                         │                  │
│  └─────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────┘

External:
  tmux ←── owns Claude processes (survives proxy restarts)
```

---

## Features

### Tier 1: Core (from claude-proxy v1)
- SSH access with pubkey auth
- Interactive lobby with session management
- tmux-backed persistent sessions
- Multi-user shared sessions
- Access control (hidden, password, view-only, users, groups, admins)
- Hotkey system (Ctrl+B)
- Session restart/resume
- Session export
- Remote host sessions
- Title bar status

### Tier 2: Web Access (new in v2)
- HTTP+WebSocket API on port 3101
- `GET /api/sessions` — session list as JSON
- `WS /api/session/:id/stream` — bidirectional terminal stream
  - Server → Client: `screen` (full state), `delta` (changed lines only)
  - Client → Server: `input` (structured keystrokes), `resize`
- Screen rendered as styled spans via xterm/headless cell API
- Event-driven updates via `onRender` (not polling)
- 30ms batched delta pushes
- Scrollback access via buffer line ranges
- Static file serving for web dashboard

### Tier 3: 3D Dashboard (from svg-terminal)
- Three.js CSS3DRenderer — terminals as 3D floating panels
- SVG-based terminal rendering (text/tspan)
- Multiple terminals visible simultaneously
- Camera controls (orbit, zoom, pan)
- Direct keystroke input to focused terminal
- Scroll support via xterm buffer ranges

### Tier 4: User Management (future — see user-registration-design.md)
- Cloudflare Access authentication for web UI
- Self-registration with invite codes
- Admin panel for user management
- Email → system username mapping

---

## Data Flow

### SSH Client
```
Keystroke → SSH stream → Hotkey handler → PtyMultiplexer.write() → tmux PTY
tmux PTY output → PtyMultiplexer → raw bytes → SSH stream → terminal
```

### Browser Client
```
Keystroke → { type: "input", specialKey: "Up" } → WebSocket
→ api-server translates → \x1b[A → PtyMultiplexer.write() → tmux PTY

tmux PTY output → PtyMultiplexer → vterm.write(data)
→ vterm.onRender() → dirty lines → screen-renderer → spans JSON
→ WebSocket → { type: "delta", changed: { "5": [...spans] } }
→ terminal.svg renders SVG
```

---

## WebSocket Protocol

### Server → Client

```json
// Full screen state (on connect)
{
  "type": "screen",
  "width": 120, "height": 40,
  "cursor": { "x": 5, "y": 12 },
  "title": "session-name",
  "lines": [
    { "spans": [{ "text": "hello", "fg": "#00cd00", "bold": true }] },
    ...
  ]
}

// Incremental update
{
  "type": "delta",
  "cursor": { "x": 10, "y": 12 },
  "title": "session-name",
  "changed": {
    "5": { "spans": [{ "text": "updated line", "fg": "#ffffff" }] },
    "12": { "spans": [...] }
  }
}

// Session ended
{ "type": "exit", "code": 0 }
```

### Client → Server

```json
// Printable characters
{ "type": "input", "keys": "hello" }

// Special keys
{ "type": "input", "specialKey": "Enter" }
{ "type": "input", "specialKey": "Up" }

// Modifiers
{ "type": "input", "keys": "c", "ctrl": true }
{ "type": "input", "keys": "x", "alt": true }

// Resize
{ "type": "resize", "cols": 120, "rows": 40 }
```

---

## Span Format

```json
{
  "text": "hello world",
  "fg": "#00cd00",      // hex RGB or undefined (default)
  "bg": "#000000",      // hex RGB or undefined (default)
  "bold": true,
  "italic": false,
  "underline": false,
  "dim": false,
  "strikethrough": false
}
```

Adjacent cells with identical attributes are grouped into a single span. Wide characters (CJK) are handled correctly (2-cell width, spacer cell skipped).

---

## API Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | /api/sessions | List active sessions (filtered by user access) | Required |
| WS | /api/session/:id/stream | Bidirectional terminal stream | Required |
| GET | /api/session/:id/screen | Full screen state as JSON | Required |
| GET | /api/session/:id/screen?start=N&end=M | Line range (scrollback) | Required |
| POST | /api/session/:id/resize | Resize terminal | Required |
| GET | /* | Static files (dashboard, SVG viewer) | Required |

Auth: localhost (127.0.0.1) = trusted. Remote = Cloudflare Access headers or token.

---

## Configuration (claude-proxy.yaml additions)

```yaml
api:
  port: 3101
  host: 127.0.0.1          # localhost only by default
  static_dir: web           # directory for dashboard files
```

---

## New Files in v2

| File | Purpose |
|------|---------|
| `src/screen-renderer.ts` | Cell-to-spans, palette, color conversion |
| `src/api-server.ts` | HTTP + WebSocket API server |
| `web/index.html` | Dashboard entry point |
| `web/dashboard.mjs` | Three.js 3D scene |
| `web/dashboard.css` | Dashboard styles |
| `web/terminal.svg` | SVG terminal viewer |

## Modified Files in v2

| File | Changes |
|------|---------|
| `src/pty-multiplexer.ts` | Add onScreenChange, onCursorChange, onTitleChange, getScreenLine, getScreenDimensions |
| `src/index.ts` | Wire api-server startup |
| `src/types.ts` | Add API config types |
| `claude-proxy.yaml` | Add api section |
| `package.json` | Add ws dependency |

---

## Implementation Phases

### Phase A: Server-Side API
1. `screen-renderer.ts` — cell-to-spans with full color/style support
2. PtyMultiplexer hooks — onRender, buffer access methods
3. `api-server.ts` — HTTP + WS with session list and streaming
4. Wire into index.ts

### Phase B: Client Adaptation
1. Copy dashboard/SVG files to web/
2. Adapt WebSocket client to new endpoints
3. Adapt session discovery
4. Adapt input format (structured keys)
5. Adapt scroll (xterm buffer ranges)
6. Remove tmux-specific code

### Phase C: Integration & QC
1. Code style unification (TS server, clean JS client)
2. De-duplication and dead code removal
3. End-to-end testing (SSH + browser simultaneously)
4. README update
5. Config documentation

### Phase D: User Management (future)
1. Cloudflare Access integration
2. User registration + invites
3. Admin panel
4. Docker packaging

---

## Success Criteria

1. SSH access works exactly as v1 — no regression
2. Browser opens dashboard at port 3101, sees session list
3. Click a session → 3D terminal appears with live Claude output
4. Type in browser → keystrokes appear in Claude
5. Multiple SSH + browser clients in the same session — all see same output
6. Session access control applies to both SSH and browser
7. Proxy restart → both SSH and browser clients reconnect, sessions intact

---

## Open Questions

1. Should the browser lobby mirror the SSH lobby (same interactive menus), or be a different UI?
2. Session creation from the browser — same flow as SSH, or simplified?
3. Voice input via Web Speech API — still on the roadmap for Phase 3?
4. Session recording/playback — defer or include in v2?
