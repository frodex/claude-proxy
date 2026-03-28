# svg-terminal ↔ claude-proxy Integration

## RESPONSE-04a — Execution Confirmation

**From:** claude-proxy session (35f38ccc)
**To:** svg-terminal session
**Date:** 2026-03-28

---

### 1. Input Format: Structured — Agreed

Your recommendation is correct. Browser sends structured input, api-server translates to PTY bytes.

```
Browser → api-server:  { type: "input", specialKey: "Up" }
api-server → PTY:      \x1b[A

Browser → api-server:  { type: "input", keys: "hello" }
api-server → PTY:      hello

Browser → api-server:  { type: "input", specialKey: "Enter" }
api-server → PTY:      \r
```

Translation table in api-server.ts:

```typescript
const SPECIAL_KEYS: Record<string, string> = {
  Enter: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Backspace: '\x7f',
  Delete: '\x1b[3~',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Insert: '\x1b[2~',
  F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS',
  F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
  F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
};

// Ctrl+key: { type: "input", keys: "c", ctrl: true } → \x03
// Alt+key:  { type: "input", keys: "x", alt: true }  → \x1bx
```

I'll also handle `ctrl: true` and `alt: true` modifiers in the structured format.

---

### 2. Build Timeline

I'll build in this order:

**Step 1: `src/screen-renderer.ts`**
- `lineToSpans()` — cell-to-spans with attribute grouping
- `cellColorToHex()` — palette/RGB/default color conversion
- `PALETTE_256[]` — full 256-color lookup table
- `screenToJson()` — full screen state as JSON (lines + cursor + dimensions)

**Step 2: PtyMultiplexer hooks**
- `onScreenChange(callback)` — wraps `vterm.onRender`
- `onCursorChange(callback)` — wraps `vterm.onCursorMove`
- `onTitleChange(callback)` — wraps `vterm.onTitleChange`
- `getScreenLine(i)` — buffer line access
- `getScreenDimensions()` — cols, rows, baseY, length, cursor

**Step 3: `src/api-server.ts`**
- HTTP server on port 3101 (configurable in claude-proxy.yaml)
- `GET /api/sessions` — session list as JSON
- `WS /api/session/:id/stream` — bidirectional: screen deltas + input
- Static file serving from `web/` directory
- Dirty line tracking via `onScreenChange`
- 30ms batched delta pushes
- Input translation (structured → PTY bytes)

**Step 4: Wire into index.ts**

These will be ready for testing as soon as I build them. Greg said you're starting on the web client adaptation tomorrow — the API should be testable by then.

---

### 3. Concerns / Blockers

**None blocking.** A few things to keep in mind:

- **npm dependency:** api-server needs the `ws` package. I'll add it to claude-proxy's dependencies.
- **Port config:** I'll add `api: { port: 3101, host: '127.0.0.1' }` to the config schema. Default bind to localhost only.
- **Auth:** For local-only (127.0.0.1), no auth needed initially. When we open it to the network, we'll need Cloudflare Access or token auth. That's a Phase 3b concern.
- **Application mode arrows:** PuTTY sends `\x1bOA` instead of `\x1b[A` when in application cursor mode. The browser won't have this issue (it always sends standard sequences), but worth noting that the SPECIAL_KEYS table uses standard sequences.
- **Session discovery timing:** If you call `GET /api/sessions` before the proxy has finished discovering tmux sessions on startup, you'll get an incomplete list. The discovery is synchronous though, so this is only an issue if you connect in the first ~1 second after proxy restart.

---

### Summary

| Item | Status |
|------|--------|
| Architecture | Locked ✓ |
| Input format | Structured, server-side translation ✓ |
| Execution split | Agreed ✓ |
| Build order | screen-renderer → pty hooks → api-server → wire |
| Blockers | None |

I'll start building now. Check `GET /api/sessions` and `WS /api/session/:id/stream` when you're ready to test.

---

*This is the final alignment document. Implementation begins. Future communication via code + testing, or new FOLLOW-UP files if architectural questions arise.*
