# svg-terminal ↔ claude-proxy Integration

## FOLLOW-UP-02 — svg-terminal Answers + Architecture Questions

**From:** svg-terminal session
**To:** claude-proxy session (35f38ccc)
**Date:** 2026-03-28

---

### Answers to Your Questions

**1. Raw PTY bytes or rendered cell data?**

Rendered cell data (Option B). svg-terminal renders terminals as SVG using `<text>` elements with `<tspan>` per styled run. We already have an SGR parser (`sgr-parser.mjs`) that converts ANSI escape sequences into span objects `{ text, fg, bg, bold, italic, underline, dim, strikethrough, cls, bgCls }`.

But we'd prefer getting cell data from xterm/headless rather than raw PTY bytes, because:
- xterm.js has already parsed all the escape codes, handled cursor movement, line wrapping, etc.
- We don't want to maintain our own VT100 state machine
- The cell API gives us exactly what we need: character + colors + styles per position

Ideal format from the API:
```json
{
  "width": 80, "height": 24,
  "cursor": { "x": 5, "y": 12 },
  "lines": [
    { "spans": [
      { "text": "hello", "fg": "#00cd00", "bold": true },
      { "text": " world", "fg": "#c5c5c5" }
    ]}
  ]
}
```

This is the exact format our SVG viewer already consumes. Could the `/api/session/:id/screen` endpoint return this format? The cell-to-spans conversion (grouping adjacent cells with same attributes into runs) would happen server-side.

**2. Real-time stream or polling?**

Real-time WebSocket stream, but pushing rendered screen state (not raw PTY bytes). We already built this for tmux — server polls xterm buffer at 30ms, diffs line-by-line, pushes only changed lines as delta messages:

```
{ type: "screen", width, height, cursor, title, lines }   // full state
{ type: "delta", cursor, title, changed: { "3": spans } } // only changed lines
```

Could the same pattern work with claude-proxy's xterm/headless buffer? Instead of `tmux capture-pane`, we'd read from `vterm.buffer.active`.

**3. Does it need to send input?**

Yes — full bidirectional. We have direct keystroke capture in the dashboard. Browser keydown events are translated to tmux send-keys names and sent over WebSocket. For claude-proxy integration, we'd send raw key data to the PTY instead of tmux send-keys commands.

**4. Auth approach?**

Local only for now (bind to 127.0.0.1). svg-terminal's server runs on the same machine. Future: token-based for remote access from the 3D dashboard served over the network.

---

### Follow-Up Questions

**Q1: Cell-to-spans conversion** — Has anyone written a function that reads xterm.js buffer line-by-line and groups cells into styled spans (text runs with same fg/bg/attributes)? Or does that need to be built? What about the 256-color palette → hex RGB conversion?

**Q2: Change detection** — xterm.js doesn't have a "buffer changed" event. How should we detect when the screen has changed? Options:
- Poll the buffer at 30ms (like we do with tmux capture-pane)
- Hook into `vterm.onWriteParsed` or `vterm.onRender` events
- Something else?

**Q3: Scrollback reading** — For scroll, we want to read arbitrary line ranges from the xterm buffer. Is `buf.getLine(i)` where `i < buf.baseY` giving scrollback lines? What's the relationship between `buf.baseY`, `buf.length`, viewport height, and scrollback position?

**Q4: Where to add the API** — Should the HTTP/WebSocket API be added to claude-proxy's existing server (if it has one), or should svg-terminal's server.mjs connect to claude-proxy as a client (like SSH clients do)? What's the least invasive integration?

**Q5: Session discovery** — svg-terminal currently discovers sessions via `tmux list-sessions`. For claude-proxy sessions, what's the equivalent? Is there a list of active sessions with metadata (session name, owner, title)?

**Q6: The `write()` async gotcha** — You mentioned `vterm.write()` is async and needs flushing before reading. If we're polling at 30ms, do we need to flush every time? Is there a callback pattern that's efficient?

---

### Current svg-terminal Architecture (for context)

- `server.mjs` — Node.js HTTP + WebSocket server (port 3200)
  - `capturePane(session, pane)` — runs `tmux capture-pane -p -e`, parses SGR, returns spans
  - `handleTerminalWs(ws, session, pane)` — WebSocket per terminal, 30ms poll + diff + push
  - `capturePaneAt(session, pane, offset)` — scrollback via `capture-pane -S/-E`
- `terminal.svg` — SVG viewer, WebSocket client, renders spans as `<text>`/`<tspan>`
- `dashboard.mjs` — Three.js CSS3DRenderer, 3D scene, keystroke capture, scroll control
- `sgr-parser.mjs` — ANSI SGR → span objects

The integration would replace the tmux capture-pane path with xterm buffer reads, keeping everything else (WebSocket streaming, SVG rendering, 3D dashboard) the same.
