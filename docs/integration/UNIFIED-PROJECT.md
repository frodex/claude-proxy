# Unified project — single entry point

**Purpose:** One place to orient work across **claude-proxy** (platform) and **svg-terminal** (browser client) without hunting both repos blindly.

---

## Dependency (read this first)

| Component | Stands alone? | Depends on |
|-----------|---------------|------------|
| **claude-proxy** | **Yes.** SSH lobby, shared sessions, HTTP/WS API :3101 — full product without svg-terminal. | tmux, Node, optional OAuth/config |
| **svg-terminal** | **Partially.** Local **tmux-only** dashboard can run without claude-proxy. **Claude-proxy sessions** (`cp-*`, socket servers, bridge, `GET :3101/...`) **require** a running claude-proxy. | For integrated use: **claude-proxy must be up** |

**Implication:** Product decisions, auth, session API, and “source of truth” specs **start in claude-proxy**. svg-terminal **consumes** those APIs and documents bridge/UX gaps here: `/srv/svg-terminal/docs/integration/`.

This file is **canonical** for the unified checklist and workspace; it lives in **claude-proxy** because the platform does not depend on the client.

---

## Repos (expected layout)

| Directory | Role |
|-----------|------|
| `/srv/claude-proxy` | **Platform** — SSH multiplexer, session manager, `:3101` API |
| `/srv/svg-terminal` | **Client** — dashboard, WS bridge, discovery merge |

**Open both at once:** **`/srv/claude-proxy/unified.code-workspace`** (File → Open Workspace from File in Cursor/VS Code).

---

## What to do today (rolling checklist)

Edit this section as you finish items.

| Priority | Task | Phase | Spec / doc |
|----------|------|-------|------------|
| 1 | Wire OAuth + cookie auth into `startApiServer` | W1 | `docs/superpowers/specs/2026-04-03-oauth-web-api-wiring-spec.md` |
| 2 | Launch profiles (lobby + API) | W3 | `docs/superpowers/plans/2026-04-03-launch-profiles.md` |
| 3 | Live web UI (login, lobby, terminal) | W2 | `/srv/svg-terminal/ui-web/ROADMAP.md` Phase W2 |
| 4 | svg-terminal auth + identity | W4 | PRD-amendment-005 + WS integration spec |

**Full roadmap (W1–W8):** `/srv/svg-terminal/ui-web/ROADMAP.md`  
**Day-to-day context:** `sessions.md` (this repo, project root)  
**Client-side integration (stepped):** `/srv/svg-terminal/docs/integration/`

---

## Documentation map

| Topic | Canonical doc |
|-------|----------------|
| **This dashboard** | `docs/integration/UNIFIED-PROJECT.md` (here, claude-proxy) |
| **Web UI master roadmap (all phases)** | **`/srv/svg-terminal/ui-web/ROADMAP.md`** — W1–W8, dependency graph, every spec/plan linked |
| Web UI prototype + ANSI reference + auth doc index | `/srv/svg-terminal/ui-web/` (`prototype.html`, `ANSI-UI.md`, `oauth-web-ui-references.md`) |
| OAuth / HTTP / WS auth | `docs/superpowers/specs/2026-04-03-oauth-web-api-wiring-spec.md` |
| Launch profiles & API orchestration | `docs/research/add-terminal.v04.md` |
| Operational conventions | `sessions.md` |
| WS bridge (client behaviour) | `/srv/svg-terminal/docs/superpowers/specs/2026-03-30-claude-proxy-websocket-integration-design.md` |
| Typing / user id browser → CP | `/srv/svg-terminal/docs/PRD-amendment-005.md` |
| Partial screen + client index | `/srv/svg-terminal/docs/integration/2026-04-02-claude-proxy-partial-screen-fix.v01.md` |

---

## Commands

```bash
cd /srv/claude-proxy && npm run build && npx vitest run
cd /srv/svg-terminal && node --test test-auth.mjs   # when working on client
```

---

## Auth boundary (when `api.auth.required`)

svg-terminal must attach the same trust model the wiring spec defines (cookie, proxy, or service token). Client PRD lines like “no auth on localhost” are **wrong** once this flag is true.

---

## Stepped docs

- **claude-proxy:** `sessions.md` + `docs/research/add-terminal.*` stepped convention  
- **svg-terminal:** `docs/integration/*.v01.md` for **consumer** integration narratives

---

*Last updated: 2026-04-03 — platform-first layout.*
