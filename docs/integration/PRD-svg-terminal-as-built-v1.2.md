# svg-terminal — Product Requirements Document (As-Built)
**Version:** 1.2
**Date:** 2026-04-01
**Status:** Implemented
**Changelog from v1.1:**
- Added dual-pipeline architecture section (local tmux vs claude-proxy)
- Added client-side URL detection (fixes URL highlighting for claude-proxy sessions)
- Added click-to-move-cursor feature
- Added terminal resize UI (keybindings config, +/- buttons, alt+scroll, alt+drag)
- Added claude-proxy session discovery (merged /api/sessions from both sources)
- Documented pipeline parity gaps and affected features
- Referenced journal: `docs/research/2026-04-01-v0.1-dual-pipeline-url-detection-journal.md`

**Previous versions:**
- v1.1 (2026-03-28): reviewed and corrected by svg-terminal session
- v1.0-original (2026-03-28): written by claude-proxy session (preserved as PRD-svg-terminal-as-built-v1.0-original.md)

---

## What It Is

A browser-based 3D terminal viewer that renders live terminal sessions as SVG elements inside a Three.js CSS3DRenderer scene. Terminals are displayed as floating panels in 3D space with real-time output, full keyboard input, scrollback, and multi-focus support. Now supports BOTH local tmux sessions and claude-proxy managed sessions.

## Problem It Solves

- Terminal sessions are trapped in SSH clients → view them in a browser
- No visual dashboard for multiple sessions → 3D spatial layout of terminals
- tmux capture-pane is text-only → full ANSI color/style rendering via SVG
- **Text crispness in 3D** → 4x scale trick (1280x992 DOM, CSS3DObject scale 0.25)
- **claude-proxy sessions on custom sockets invisible to tmux list-sessions** → dual-source session discovery

## Core Architecture

**v1.2 CHANGE: Dual pipeline.** Two data paths produce spans:

```
PIPELINE 1 (local tmux):
tmux capture-pane -e → sgr-parser.mjs → spans (with url tags) → WebSocket → SVG

PIPELINE 2 (claude-proxy):
xterm/headless buffer → screen-renderer.ts → spans (NO url tags) → WebSocket proxy → SVG

Session discovery merges both:
tmux list-sessions + GET http://127.0.0.1:3101/api/sessions → unified session list
```

**Pipeline parity gaps** (see journal `2026-04-01-v0.1-dual-pipeline-url-detection-journal.md`):
- URL tagging: Pipeline 1 has `span.url`, Pipeline 2 does not → client-side fallback added
- Color format: Pipeline 1 uses CSS classes (`c0`-`c7`), Pipeline 2 uses hex RGB → SVG handles both
- Title format: Pipeline 1 = tmux pane_title (OSC 0), Pipeline 2 = composed title (name | users | uptime)
- Scrollback: Pipeline 1 = `capture-pane -S/-E`, Pipeline 2 = xterm buffer ranges (not yet connected)
- OSC 8 hyperlinks: Pipeline 1 parses them, Pipeline 2 unknown → needs investigation

**Any feature that reads span properties must handle BOTH pipeline variants.** The client-side fallback pattern (check server property first, detect client-side if missing) is the established approach.

## Features (Implemented)

### Terminal Rendering
- Full ANSI SGR color support (16, 256, RGB)
- Bold, italic, underline, dim, strikethrough
- Animated blinking cursor
- SVG vector rendering
- Embedded FiraCode Nerd Font Mono subset (31KB woff2)
- Runtime font measurement via getBBox()

### Real-Time Streaming
- WebSocket per terminal with server-side 30ms poll + line-by-line diff
- Full `screen` event on connect, incremental `delta` events
- Atomic tmux capture (display-message + capture-pane in one invocation)
- **v1.2:** WebSocket proxy to claude-proxy API for sessions on custom sockets

### Input
- Direct keystroke capture (document-level keydown)
- Key translation map (SPECIAL_KEY_MAP)
- Ctrl combos, special keys, F1-F12
- Paste support (Ctrl+V + right-click context menu)
- **v1.2:** Click-to-move-cursor — click on terminal text sends Left/Right arrow keys to position cursor. Uses parallel tmux send-keys with repeat count for speed. Linear calculation (same row or cross-line via col offset math).

### URL Detection and Linking
- **v1.2:** Dual-source URL detection:
  - Server-side: `sgr-parser.mjs` tags spans with `url` property (Pipeline 1 only)
  - Client-side: `findUrlsInText()` in terminal.svg scans for http/https patterns (both pipelines)
  - `getUrlAtCell()` in dashboard.mjs checks both sources for click handling
- Click URL → opens sidecar browser card (`addBrowserCard`)
- Alt+click URL → opens in new browser tab

### Text Selection + Copy/Paste
- Focused terminal: drag = select text (blue highlight overlay)
- Shift+arrow keyboard selection
- Ctrl+C with selection copies to clipboard (fallback to execCommand for HTTP)
- Ctrl+C without selection sends C-c to terminal
- Selection reads actual terminal dimensions from SVG viewBox

### 3D Dashboard
- Three.js CSS3DRenderer with 4x scale trick
- Camera controls: drag orbit, shift+drag pan, ctrl+drag rotate, scroll zoom, shift+scroll dolly
- Specular lighting, shadows, gray gradient background
- **v1.2:** KEYBINDINGS config — all input mappings in one object, auto-generates help panel

### Focus System
- Single focus: 1:1 pixel mapping
- Multi-focus: ctrl+click, grid layout
- Yellow neon input-active indicator (multi-focus only)
- Esc unfocuses, click empty space does NOT unfocus
- **v1.2:** Z-slide only in multi-focus mode (was causing bounce in single focus)

### Scrollback
- Server-side scroll offset per pane (shared across WebSocket connections)
- Absolute scrollTo offset via WebSocket
- Acceleration-aware step from deltaY magnitude
- PgUp/PgDn: 24-line jumps
- Unified scrollBy/scrollReset on terminal object

### Terminal Resize (v1.2)
- KEYBINDINGS config for all input mappings
- +/- title bar buttons for font zoom (changes tmux cols/rows, not CSS transform)
- ⊡ Optimize button (resize PTY to fill card at current font)
- Alt+scroll: resize tmux cols/rows
- Alt+drag: resize card, PTY adjusts on release
- **IMPORTANT:** All resize is tmux resize, NOT CSS transform. Font size changes = different cols/rows.

### Session Discovery (v1.2)
- Merges two sources: local `tmux list-sessions` + claude-proxy `GET /api/sessions`
- Deduplicates by session name
- claude-proxy sessions marked with `source: 'claude-proxy'`
- WebSocket proxy for claude-proxy sessions (routes to `ws://127.0.0.1:3101/api/session/:id/stream`)

### Help Panel
- Frosted glass overlay, ? button upper-left
- **v1.2:** Auto-generated from KEYBINDINGS config

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22 |
| HTTP/WS | Node.js built-in `http` + `ws` package |
| Terminal capture | tmux capture-pane (Pipeline 1) / claude-proxy API (Pipeline 2) |
| ANSI parsing | sgr-parser.mjs (Pipeline 1) / screen-renderer.ts (Pipeline 2) |
| Rendering | SVG (text/tspan) |
| Font | FiraCode Nerd Font Mono subset |
| 3D scene | Three.js CSS3DRenderer (CDN) |
| Module system | ES modules (.mjs) |
| Testing | Node.js built-in test runner + puppeteer |

## Key Anti-Patterns (from dashboard.mjs header)

1. DO NOT remove the 4x scale trick — text blurs
2. DO NOT propose HTML overlays for crispness — SVG is the target
3. DO NOT add per-terminal click handlers — breaks ctrl+click
4. DO NOT simplify event routing flags
5. Always syncOrbitFromCamera() on orbit start
6-8. Fly-in rotation effects REMOVED — caused unpredictable bouncing
9. **v1.2:** NO CSS font scaling for resize — all visual changes via tmux cols/rows
10. **v1.2:** Any feature reading span properties must handle both pipeline variants

## Limitations

- claude-proxy WebSocket proxy is fragile (async upgrade handler)
- Pipeline 2 scrollback not connected yet
- Pipeline 2 doesn't support OSC 8 hyperlinks (unknown)
- Terminal resize constrained by claude-proxy size ownership model for cp-* sessions
- Click-to-move-cursor only works in readline-style prompts (not vim/htop)
- No TypeScript
- Single server
