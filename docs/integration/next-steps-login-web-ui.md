# Next Steps: Login, Web UI, and Integration Completion

**Date:** 2026-04-01
**For:** Next agent picking up web-facing work
**Context:** claude-proxy backend is feature-complete for SSH. Auth infrastructure built but not activated. svg-terminal integration working for terminal streaming. What's missing: web login pages, session management from browser, and updated plans.

---

## Source Materials

### claude-proxy (this repo: /srv/claude-proxy)

| Document | Path | What it contains |
|----------|------|-----------------|
| PRD as-built v2.1 | `docs/integration/PRD-claude-proxy-as-built-v2.1.md` | Full feature inventory, constraints, anti-patterns, break tests |
| PRD v1 (original) | `docs/integration/PRD-claude-proxy-as-built.md` | Original feature set before this session |
| API reference (post-review) | `docs/api-v2.md` | All endpoints (existing + planned), WebSocket protocol, error format, security model |
| Auth + UGO security spec | `docs/superpowers/specs/2026-03-29-auth-ugo-security-design.md` | OAuth providers, UGO sockets, user store, resolveUser, provisioning |
| Widget system spec | `docs/superpowers/specs/2026-03-31-widget-system-design.md` | 6 widget types, FlowEngine, ANSI renderers |
| Unified session screen plan | `docs/superpowers/plans/2026-03-31-unified-session-screen.md` | YAML-driven session form, widget states, fork/edit/restart/create |
| Unified screen Q&A | `docs/superpowers/plans/2026-03-31-unified-session-screen-QUESTIONS-REPLY-AGENT.md` | Resolved: two-mode nav, displayValue callback, field×mode matrix |
| Handoff plan v3 | `docs/superpowers/plans/2026-03-31-handoff-todos-v3.md` | All pending TODOs, cautions, test gaps, auth activation sequence |
| Session form YAML | `src/session-form.yaml` | Field definitions, per-mode config (create/edit/restart/fork) |
| Steward review | `docs/integration/steward-review-2026-03-31.md` | Compliance gaps identified and resolved in v2.1 |
| Research: widget system | `docs/research/2026-03-29-v0.1-tui-widget-system-journal.md` | 22 UI element inventory, framework survey |
| Research: UGO security | `docs/research/2026-03-29-v0.1-ugo-security-model-journal.md` | tmux sockets, inotify, prior art |
| Research: arrow keys | `docs/research/2026-03-31-v0.1-arrow-key-variants-journal.md` | CSI vs SS3 dual-variant requirement |
| Bibliography | `docs/bibliography.md` | All external sources referenced |
| Sessions context | `sessions.md` | Live project context, decisions, conventions |

### svg-terminal (/srv/svg-terminal)

| Document | Path | What it contains |
|----------|------|-----------------|
| Login & user management spec | `docs/superpowers/specs/2026-03-30-login-and-user-management-design.md` | OAuth flow, user states, approval model, admin UI, code to port |
| Login & user management plan | `docs/superpowers/plans/2026-03-30-login-and-user-management.md` | Implementation tasks (NEEDS REWRITE — see below) |
| WebSocket integration spec | `docs/superpowers/specs/2026-03-30-claude-proxy-websocket-integration-design.md` | Protocol normalization, proxy architecture, key name translation |
| WebSocket integration plan | `docs/superpowers/plans/2026-03-30-claude-proxy-websocket-integration.md` | Implemented — session streaming works |
| PRD v0.5.1 | `PRD-v0.5.1.md` | svg-terminal as-built, constraints, anti-patterns |
| Sessions context | `sessions.md` | Live project context for svg-terminal |

### Auth source code (ready to port)

| claude-proxy source | Purpose | Port to |
|--------------------|---------|---------|
| `src/auth/user-store.ts` | SQLite user DB (better-sqlite3-multiple-ciphers) | `user-store.mjs` |
| `src/auth/oauth.ts` | Google/Microsoft OIDC (openid-client v6) | `auth.mjs` |
| `src/auth/github-adapter.ts` | GitHub OAuth (non-OIDC) | `auth.mjs` |
| `src/auth/session-cookie.ts` | HMAC-SHA256 signed cookies | `session-cookie.mjs` |
| `src/auth/provisioner.ts` | useradd, groupadd, installClaude | `provisioner.mjs` |
| `src/auth/resolve-user.ts` | OAuth identity → Linux user mapping | `resolve-user.mjs` |
| `src/auth/middleware.ts` | Cookie validation for API endpoints | inline in `server.mjs` |

---

## Documents That Need Updates

### 1. Login & user management plan — REWRITE NEEDED

**File:** `/srv/svg-terminal/docs/superpowers/plans/2026-03-30-login-and-user-management.md`

**Why:** Written before:
- Widget system existed (session form is now YAML-driven)
- Unified session screen (create/edit/restart/fork all use same form)
- Session CRUD API endpoints were built (POST /api/sessions, DELETE, PATCH settings, fork, restart)
- openid-client v6 API changes (v5 API in original plan doesn't work)
- Claude session ID auto-discovery and fork feature

**What to change:**
- The auth module code to port is now openid-client v6 (different API than v5 — see `src/auth/oauth.ts`)
- The API routes in claude-proxy are already built — svg-terminal just needs to proxy them or call them
- Session creation from web UI should call `POST /api/sessions` not rebuild the creation logic
- User approval flow (pending → approved → provisioned) is still valid and unchanged
- HTML pages section is still valid

**Source for rewrite:** Auth source code above + `docs/api-v2.md` for current API endpoints

### 2. WebSocket integration spec — NEEDS ADDENDUM

**File:** `/srv/svg-terminal/docs/superpowers/specs/2026-03-30-claude-proxy-websocket-integration-design.md`

**Why:** New API endpoints exist that weren't in the original integration:

| New Endpoint | Purpose | svg-terminal needs |
|-------------|---------|-------------------|
| `POST /api/sessions` | Create session | Web UI session creation form |
| `DELETE /api/sessions/:id` | Destroy session | Web UI session management |
| `GET /api/sessions/:id/settings` | Get settings | Web UI edit form |
| `PATCH /api/sessions/:id/settings` | Update settings | Web UI edit form |
| `GET /api/sessions/dead` | List dead sessions | Web UI restart picker |
| `POST /api/sessions/:id/restart` | Restart dead session | Web UI restart |
| `POST /api/sessions/:id/fork` | Fork a session | Web UI fork |
| `GET /api/remotes` | List remote hosts | Web UI server picker |
| `GET /api/users` | List users | Web UI user picker |
| `GET /api/groups` | List groups | Web UI group picker |

**What to change:** Add a section listing these endpoints and whether svg-terminal's server.mjs should proxy them or call them directly.

---

## Documents That Don't Exist Yet

### 3. Web UI spec — NOT WRITTEN

No spec exists for the actual HTML pages. The login spec describes routes and flows but not the pages.

**Pages needed:**
- `/login` — OAuth provider buttons (Google, Microsoft, GitHub). Dark theme matching dashboard.
- `/pending` — "Your request has been submitted" waiting room with status poll.
- `/admin` — User management: pending requests, user list, pre-approve by email, approval flags.
- `/` — Dashboard (already exists in svg-terminal — just needs auth gate)
- Session creation form — calls `POST /api/sessions` (could be a modal or page)
- Session settings panel — calls `GET/PATCH /api/sessions/:id/settings`

**Source material:** Login spec section 4 (Login Flow) and section 5 (Admin UI) describe the UX. The YAML form config (`session-form.yaml`) defines the fields for session creation/editing.

**Decision needed:** Do the session management pages (create, edit, fork) live in svg-terminal's dashboard or as separate pages? The SSH side uses a full-form widget; the web side could be a standard HTML form.

### 4. YAML form config documentation — NOT WRITTEN

**File to create:** Something like `docs/session-form-config.md`

**What it should document:**
- Field schema: `id`, `label`, `widget`, `required`, `default`, `condition`, `modes`
- Mode configs: `visible`, `locked`, `prefill` (true, false, or special like `fork-name`)
- Widget types: `text`, `text-masked`, `yesno`, `list`, `checkbox`, `combo`
- Conditions: `admin-only`, `admin-with-remotes`, `not-hidden`, `not-hidden-and-not-public`
- How to add a new field or mode
- How the YAML maps to FlowEngine steps at runtime (`src/session-form.ts`)

**Source:** `src/session-form.yaml` + `src/session-form.ts`

---

## Activation Sequence (when ready to go live)

1. Register OAuth apps with Google, Microsoft, GitHub — get client IDs and secrets
2. Add credentials to `claude-proxy.yaml` auth section (example already there, commented out)
3. Wire OAuth options into `startApiServer()` in `src/index.ts` (TODO item 6 in handoff)
4. Create `cp-users` group: `groupadd cp-users`
5. Port auth modules from claude-proxy TypeScript to svg-terminal plain JS
6. Add auth middleware to svg-terminal's `server.mjs`
7. Build HTML pages (login, pending, admin)
8. Test end-to-end: browser → login → OAuth → provision → dashboard

**Auth can be tested locally** without real OAuth by setting `AUTH_ENABLED=false` (dev mode returns root user).
