# svg-terminal — Product Requirements Document (As-Built)
**Version:** 1.1 (reviewed and corrected by svg-terminal session)
**Date:** 2026-03-28
**Status:** Implemented
**Changelog from v1.0:** Added missing features, corrected architectural details, expanded limitations

---

## What It Is

A browser-based 3D terminal viewer that renders live terminal sessions as SVG elements inside a Three.js CSS3DRenderer scene. Terminals are displayed as floating panels in 3D space with real-time output, full keyboard input, scrollback, and multi-focus support.

## Problem It Solves

- Terminal sessions are trapped in SSH clients → view them in a browser
- No visual dashboard for multiple sessions → 3D spatial layout of terminals
- tmux capture-pane is text-only → full ANSI color/style rendering via SVG
- **Text crispness in 3D** → the core design challenge. Chrome softens text under 3D transforms. The 4x scale trick (render at 1280x992, CSS3DObject scale 0.25) forces Chrome to rasterize at high resolution before the 3D transform.

## Core Architecture

```
tmux session → capture-pane -e → sgr-parser.mjs → spans → WebSocket → terminal.svg → SVG render
                                                                          ↓
Browser keystroke → WebSocket → send-keys → tmux session        Three.js CSS3DRenderer (3D scene)

Scrollback: capture-pane -S offset -E offset → server-side diff → WebSocket delta
```

- **Backend:** Node.js HTTP + WebSocket server (server.mjs, port 3200, zero server deps)
- **Terminal capture:** `tmux capture-pane -p -e` — server polls at 30ms via `setInterval`, diffs line-by-line, pushes only changed lines
- **ANSI parsing:** `sgr-parser.mjs` converts SGR escape codes to styled span objects
- **Transport:** WebSocket per terminal (`ws` package, already in node_modules via puppeteer) — pushes screen deltas, receives keystrokes
- **Rendering:** SVG `<text>` elements with `<tspan>` per styled run, positioned via explicit x-offset from runtime font measurement
- **3D scene:** Three.js CSS3DRenderer with CSS3DObject wrapping terminal DOM elements containing `<object>` tags loading terminal.svg
- **Fallback:** If WebSocket fails, SVG client falls back to HTTP polling at 150ms

## Features (Implemented)

### Terminal Rendering
- Full ANSI SGR color support (16 standard, 256, RGB via sgr-parser.mjs)
- Bold, italic, underline, dim, strikethrough styles
- Animated blinking cursor
- SVG-based — infinite zoom, vector-crisp
- Embedded FiraCode Nerd Font Mono subset (31KB woff2, base64) for Unicode terminal symbols
- Runtime font measurement via hidden `<text>` getBBox() — character cell width/height measured, not hardcoded
- `dominant-baseline: text-before-edge` for precise y-positioning

### Real-Time Streaming
- WebSocket endpoint `/ws/terminal?session=X&pane=Y`
- Server-side 30ms poll of tmux capture-pane (async via `tmuxAsync()`)
- Server-side line-by-line diff via `JSON.stringify` comparison (`diffState()`)
- Full `screen` event on connect or dimension change
- Incremental `delta` events with only changed line indices + spans
- Input-triggered immediate re-capture (5ms delay after keystroke for tmux to process)
- Shared scroll offset per pane across all WebSocket connections (`paneScrollOffsets` Map)

### Input
- **Direct keystroke capture** — document-level `keydown` handler when terminal is focused
- No input text field — keystrokes go directly to tmux
- Key translation map (`SPECIAL_KEY_MAP`): browser KeyboardEvent.key → tmux send-keys names
- Ctrl combos: `C-a` through `C-z`
- Special keys: Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PgUp, PgDn, F1-F12, Insert, Space
- Paste support via `document.addEventListener('paste', ...)`
- Per-terminal `inputWs` WebSocket opened on focus, closed on unfocus
- POST `/api/input` fallback if WebSocket not connected
- Browser shortcuts excluded (Ctrl+T/W/N/R, F12, Alt+F4)

### 3D Dashboard
- Three.js CSS3DRenderer — terminals as CSS3DObjects in 3D scene
- **4x scale trick** for text crispness: DOM elements are 1280x992, CSS3DObject scale 0.25 — forces Chrome to rasterize at 4x before 3D transform. DO NOT CHANGE THIS.
- Camera controls:
  - Drag: orbit around look target
  - Shift+drag: dolly X/Y (pan camera + target)
  - Ctrl+drag: rotate around world origin (or center of mass of focused terminals)
  - Scroll (unfocused): zoom (FOV)
  - Ctrl+scroll: zoom (FOV)
  - Shift+scroll: dolly Z (forward/backward)
- `syncOrbitFromCamera()` derives orbit params from actual camera position — prevents snap on drag start
- Specular lighting: panel normal dot light direction, intensity 0.4
- Shadows: radial-gradient ellipse on floor plane (Y=-300), opacity/blur/scale from height
- Background: medium gray gradient

### Focus System
- **Single focus:** Click terminal → flies to center with 1:1 pixel mapping (DOM resized to screen pixels)
- **Multi-focus:** Ctrl+click adds terminals to focused set, grid layout (2=side-by-side, 3=triangle, 4=2x2)
- **Input-active indicator:** Yellow neon border shows which focused terminal receives keystrokes (only visible when 2+ focused)
- **Click to switch input:** Click between focused terminals to change which receives keystrokes
- Esc unfocuses all, regular click replaces multi-focus with single

### Focus Animations
- Cards spawn at random 3D angles (`rotation.set()` in `addTerminal()`)
- Fly-in: cards slerp from random angle toward face-camera during morph
- `focusQuatFrom` captures current quaternion — prevents z-rotation snap on focus
- `billboardArrival` tracks when card finishes morphing — billboard slerp ramps from near-zero during fly-in
- Previously focused terminal morphs back to ring position when new terminal clicked

### Scrollback
- Server-side scroll offset per pane (`paneScrollOffsets` Map, shared across connections)
- `capturePaneAt(session, pane, offset)` uses `tmux capture-pane -S <start> -E <end>` for scrollback ranges
- Dashboard sends absolute `scrollTo` offset via WebSocket
- Acceleration-aware step: deltaY magnitude → step 1/3/6/12 lines
- PgUp/PgDn: 24-line jumps
- Alt+scroll: Up/Down arrows (command history at prompt)
- Any keystroke resets scroll to live view (offset 0)
- `scrollBy(lines)` and `scrollReset()` methods on terminal object — unified, all input methods share one offset

### Help Panel
- Frosted glass panel (backdrop-filter blur) in upper-left corner
- Triggered by `?` button or `?` key (only when no terminal focused)
- Lists all keyboard/mouse controls
- When terminal focused, `?` goes to terminal instead of toggling help

### Event Routing (CRITICAL — read dashboard.mjs header notes)
- Three competing click paths: `onMouseUp` (document), `onSceneClick` (renderer), thumbnail click handler (sidebar)
- `mouseDownOnSidebar` flag prevents double-fire when ctrl+clicking thumbnails
- `suppressNextClick` flag prevents `onSceneClick` from re-handling after `onMouseUp`
- `lastAddToFocusTime` timestamp blocks `focusTerminal()` for 200ms after `addToFocus()`
- `ctrlHeld` tracked via keydown/keyup because `e.ctrlKey` is unreliable in click events on Windows
- DO NOT add per-terminal click handlers on DOM elements — see note 4 in dashboard.mjs header

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22 |
| HTTP/WS | Node.js built-in `http` + `ws` package (via puppeteer) |
| Terminal capture | tmux capture-pane |
| ANSI parsing | Custom sgr-parser.mjs |
| Rendering | SVG (text/tspan with explicit x-positioning) |
| Font | FiraCode Nerd Font Mono subset (31KB woff2, embedded base64) |
| 3D scene | Three.js CSS3DRenderer (CDN via importmap) |
| Module system | ES modules (.mjs) |
| Build | None — plain ES modules, no bundler |
| Testing | Node.js built-in test runner (`node --test`) |

## File Structure

```
svg-terminal/
├── server.mjs          # HTTP + WebSocket server, async tmux, capture, diff, scroll
├── sgr-parser.mjs      # ANSI SGR → span objects
├── terminal.svg        # SVG terminal viewer (WebSocket client, polling fallback)
├── terminal.html       # HTML wrapper for terminal.svg (font loading)
├── dashboard.mjs       # Three.js 3D scene, focus system, keystroke capture, scroll
├── dashboard.css       # Dashboard styles (4x scale, specular, shadows, help panel)
├── index.html          # Dashboard entry point (importmap, sidebar, help, input bar)
├── polyhedra.mjs       # Utility: easeInOutCubic, lerpPos
├── color-table.mjs     # ANSI color definitions
├── test-server.mjs     # Server tests (16 tests: HTTP + WebSocket)
├── test-sgr-parser.mjs # SGR parser tests (22 tests)
├── package.json        # v0.3.0, puppeteer dependency only
└── docs/               # Research journals, specs, plans, bibliography
```

## Limitations

- **Depends on tmux directly** — capture-pane, send-keys, list-sessions. Replaced by xterm/headless in v2.
- **No authentication** — anyone who can reach port 3200 has full access
- **No session management** — tmux manages sessions, svg-terminal just discovers them
- **No access control** — no concept of users or permissions
- **Server-side polling** — 30ms setInterval captures tmux state. Replaced by onRender events in v2.
- **No TypeScript** — plain JavaScript ES modules
- **Single server, single user assumed**
- **SGR parser limited** — doesn't handle all edge cases (256-color bg via class names, some OSC sequences). Replaced by xterm cell API in v2.
- **Text crispness under 3D transforms** — the 4x scale trick mitigates but doesn't fully solve Chrome's GPU compositing softening. SVG is the target format — no HTML overlay hacks.
- **Smooth scrolling not implemented** — server responds fast enough (~30ms) that client-side animation caused visible bounce. Current approach: line-granular jumps with acceleration.

## Key Anti-Patterns (documented in dashboard.mjs header)

1. DO NOT remove the 4x scale trick (1280x992 + scale 0.25) — text will blur
2. DO NOT propose HTML overlays for text crispness — SVG is the target format
3. DO NOT add per-terminal click handlers — causes double-fire with ctrl+click
4. DO NOT simplify the event routing flags — they prevent real bugs found through testing
5. DO NOT use `execFileSync` — blocks event loop, breaks WebSocket streaming
6. Always call `syncOrbitFromCamera()` when orbit starts — prevents camera snap
7. `focusQuatFrom` must capture quaternion on focus — prevents rotation snap
