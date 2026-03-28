# svg-terminal — Product Requirements Document (As-Built)
**Version:** 1.0
**Date:** 2026-03-28
**Status:** Implemented
**Note:** Written by claude-proxy session based on integration docs. svg-terminal session should review and correct.

---

## What It Is

A browser-based 3D terminal viewer that renders live terminal sessions as SVG elements inside a Three.js CSS3DRenderer scene. Terminals are displayed as floating panels in 3D space with real-time output, input capture, and scroll support.

## Problem It Solves

- Terminal sessions are trapped in SSH clients → view them in a browser
- No visual dashboard for multiple sessions → 3D spatial layout of terminals
- tmux capture-pane is text-only → full ANSI color/style rendering via SVG

## Core Architecture

```
tmux session → capture-pane -e → sgr-parser.mjs → spans → WebSocket → terminal.svg → SVG render
                                                                          ↓
Browser keystroke → WebSocket → send-keys → tmux session        Three.js CSS3DRenderer (3D scene)
```

- **Backend:** Node.js HTTP + WebSocket server (server.mjs, port 3200)
- **Terminal capture:** `tmux capture-pane -p -e` polled at 30ms
- **ANSI parsing:** `sgr-parser.mjs` converts SGR escape codes to styled span objects
- **Transport:** WebSocket per terminal — pushes screen deltas, receives keystrokes
- **Rendering:** SVG `<text>` elements with `<tspan>` per styled run
- **3D scene:** Three.js CSS3DRenderer with CSS3DObject wrapping terminal SVGs

## Features (Implemented)

### Terminal Rendering
- Full ANSI SGR color support (16, 256, RGB)
- Bold, italic, underline, dim, strikethrough styles
- Cursor display
- SVG-based — infinite zoom, crisp at any scale

### Real-Time Streaming
- 30ms poll of tmux capture-pane
- Line-by-line diff — only changed lines pushed as deltas
- Full screen state on initial connect
- WebSocket protocol: `screen` (full), `delta` (incremental)

### Input
- Browser keystroke capture
- Translated to tmux send-keys format
- Special keys (arrows, function keys, ctrl combos) handled

### 3D Dashboard
- Three.js CSS3DRenderer
- Terminal panels as 3D objects
- Camera controls (orbit, zoom, pan)
- Multiple terminals visible simultaneously

### Scrollback
- `tmux capture-pane -S offset -E offset` for scroll ranges
- Scroll events from browser → fetch historical content

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js |
| HTTP/WS | Plain Node.js http + ws |
| Terminal capture | tmux capture-pane |
| ANSI parsing | Custom sgr-parser.mjs |
| Rendering | SVG (text/tspan) |
| 3D scene | Three.js CSS3DRenderer |
| Module system | ES modules (.mjs) |
| Build | None — plain ES modules |

## File Structure

```
svg-terminal/
├── server.mjs          # HTTP + WebSocket server
├── sgr-parser.mjs      # ANSI SGR → span objects
├── terminal.svg        # SVG terminal viewer (browser)
├── dashboard.mjs       # Three.js 3D scene (browser)
├── dashboard.css       # Dashboard styles
├── index.html          # Dashboard entry point
└── ... (other assets)
```

## Limitations

- Depends on tmux directly (capture-pane, send-keys)
- No authentication
- No session management (tmux manages sessions)
- No access control
- Polling-based capture (30ms intervals)
- No TypeScript
- Single server, single user
