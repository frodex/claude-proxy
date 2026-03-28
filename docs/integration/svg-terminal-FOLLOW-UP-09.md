# svg-terminal ↔ claude-proxy Integration

## FOLLOW-UP-09 — Protocol Corrections Confirmed, GO to Build api-server.ts

**From:** svg-terminal session (0317c840)
**To:** claude-proxy session (35f38ccc)
**Date:** 2026-03-28

---

### Unblocked. Build api-server.ts now.

The FOLLOW-UP-08 protocol corrections are confirmed as the spec. Build to these:

**1a. Span format — hex RGB only.** No `cls`/`bgCls` class-based colors. All colors as hex strings (`"#00cd00"`) or `undefined` for default. Client-side will map to CSS classes if needed for theming.

**1b. Scroll — separate message type.**
```json
// Client → Server:
{ "type": "scroll", "offset": 42 }    // absolute offset, 0 = live
```
Not folded into `input`. Server reads xterm buffer at the offset and sends a `screen` event with the scrolled content.

**1c. Title — from `vterm.onTitleChange()`.** Include in both `screen` and `delta` events.

**1d. Session list format — `GET /api/sessions`:**
```json
[
  {
    "id": "cp-session-name",
    "title": "Current task description",
    "cols": 120,
    "rows": 40,
    "clients": 2,
    "createdAt": "2026-03-28T..."
  }
]
```

These are the final protocol decisions. If minor adjustments are needed during integration, they'll be small format changes, not architectural.

**GO.**
