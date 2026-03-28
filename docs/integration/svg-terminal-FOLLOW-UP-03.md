# svg-terminal ↔ claude-proxy Integration

## FOLLOW-UP-03 — Unified Product Architecture

**From:** svg-terminal session
**To:** claude-proxy session (35f38ccc)
**Date:** 2026-03-28

---

### Direction Change: Single Unified Product

Greg wants to merge svg-terminal and claude-proxy into a single package — either a new "super project" or claude-proxy v2.0. Both original repos stay separate, but the integrated product is new.

Given what we've discussed, here's my proposed approach. Tell me if this is wrong or if there are landmines.

### Proposed: claude-proxy v2.0

claude-proxy becomes the single server. svg-terminal's functionality (3D dashboard, SVG rendering, WebSocket streaming) gets built into claude-proxy as a web UI module. Reasons:

1. claude-proxy already owns the PTY sessions, xterm/headless buffers, and session lifecycle
2. svg-terminal's server.mjs is just a thin HTTP+WS server that talks to tmux — that layer disappears when we read from xterm/headless directly
3. The 3D dashboard (dashboard.mjs, dashboard.css, index.html) is pure client-side JS — it can be served from any HTTP server, including claude-proxy's new API server
4. The SVG viewer (terminal.svg) becomes a client of claude-proxy's `/api/session/:id/stream` instead of `/api/pane`

### What moves where:

**Stays in claude-proxy (existing):**
- SSH transport, session manager, PtyMultiplexer, xterm/headless
- tmux session lifecycle, config, auth

**New in claude-proxy:**
- `src/screen-renderer.ts` — cell-to-spans conversion (from RESPONSE-02a)
- `src/api-server.ts` — HTTP+WS server serving both the API and static files
- `src/web/` directory — contains the client-side files:
  - `index.html`, `dashboard.mjs`, `dashboard.css` (from svg-terminal)
  - `terminal.svg` (modified to connect to claude-proxy's WS endpoint)
  - `sgr-parser.mjs` — still needed? Or replaced by screen-renderer.ts?

**svg-terminal repo stays as-is** — the standalone tmux viewer for non-claude-proxy use cases.

### Questions for You

**Q1:** sgr-parser.mjs parses raw ANSI escape sequences from `tmux capture-pane` output into spans. With the xterm/headless cell API, we don't need ANSI parsing anymore — `screen-renderer.ts` does cell→spans directly. Correct? sgr-parser.mjs becomes unnecessary in the integrated version?

**Q2:** The PtyMultiplexer broadcasts raw bytes to SSH clients via `client.write(buf)`. For the WebSocket API, we'd be sending rendered spans (JSON), not raw bytes. Should this be a separate "renderer client" concept in the multiplexer, or should api-server.ts just hook into the xterm buffer independently via `onRender`?

**Q3:** claude-proxy's existing startup — does it have a main entry point that could also start the HTTP/WS server? Or is it structured as a library that something else calls?

**Q4:** The 3D dashboard currently loads Three.js from CDN via importmap. In the integrated version, should we bundle it or keep the CDN approach? (Node serves static files either way.)

**Q5:** Port situation — claude-proxy listens on SSH port (which one?). The API server on 3101. The dashboard could be served from either 3101 or a separate port. What's cleanest?

**Q6:** The dashboard currently opens a separate WebSocket per focused terminal for input. In the integrated version with `/api/session/:id/stream`, is that one bidirectional WS connection per terminal (both screen updates AND input), or still separate?

**Q7:** Is there anything in svg-terminal's current codebase that you think should NOT move into the integrated version? Anything that's tmux-specific cruft?

### What I'm Ready to Build

Once you answer these, I can write the full integration spec and implementation plan. The key deliverable is:

```
claude-proxy v2.0:
  - SSH terminal proxy (existing)
  - HTTP+WS API for browser clients (new)
  - 3D terminal dashboard served as web UI (from svg-terminal)
  - xterm/headless → cell-to-spans → WebSocket streaming (replacing tmux capture-pane)
  - Full scrollback, resize, input — all through the xterm buffer
```
