# User Registration & Web Terminal — Design Spec

**Date:** 2026-03-27
**Status:** Proposal

## Overview



NEEDS TO WORK WITH oAuth (google) and/or cloudflare.

A web-based frontend for claude-proxy that handles user registration, authentication (via Cloudflare Access), and provides a browser-based terminal. This replaces the SSH-only access model with a web UI that non-technical users can access.

---

## User Flow

### New User (Invite-Based)

1. Admin generates an invite code (from admin panel or CLI)
2. Admin shares the code (email, Slack, etc.)
3. User visits the web UI landing page
4. User enters: invite code, name, email
5. System provisions the user automatically
6. User is redirected to Cloudflare Access login
7. After auth, they land in the lobby

### New User (Request Access)

1. User visits the web UI landing page
2. Clicks "Request access"
3. Enters: name, email, reason (optional)
4. Request is stored as pending
5. Admin gets notified (email or admin panel badge)
6. Admin approves or denies from admin panel
7. On approval: system provisions user, sends approval email
8. User visits web UI, authenticates via Cloudflare Access, lands in lobby

### Returning User

1. User visits web UI
2. Cloudflare Access authenticates (email-based)
3. Proxy reads `Cf-Access-Authenticated-User-Email` header
4. Looks up email → system username mapping
5. User lands in the lobby

---

## Components

### 1. Web Server (HTTP + WebSocket)

- Express.js or plain Node HTTP server on a second port (e.g., 3101)
- Serves static HTML/JS for the landing page, lobby, terminal, and admin panel
- WebSocket endpoint for xterm.js terminal connections
- All pages behind Cloudflare Access except the landing page

**Routes:**

```
GET  /                    — Landing page (public)
GET  /register            — Registration form (public)
POST /register            — Submit registration
GET  /register/invite     — Invite code form (public)
POST /register/invite     — Submit invite code
GET  /app                 — Lobby + terminal (authenticated)
WS   /ws                  — WebSocket terminal (authenticated)
GET  /admin               — Admin panel (cp-admins only)
POST /admin/approve/:id   — Approve a pending request
POST /admin/deny/:id      — Deny a pending request
POST /admin/invite        — Generate invite code
GET  /admin/users         — List users
```

### 2. User Store

JSON file at `/srv/claude-proxy/data/users.json`:

```json
{
  "users": [
    {
      "email": "greg@frodex.com",
      "username": "greg",
      "name": "Greg",
      "status": "active",
      "createdAt": "2026-03-27T00:00:00Z",
      "invitedBy": "root"
    }
  ],
  "pending": [
    {
      "id": "abc123",
      "email": "alice@company.com",
      "name": "Alice",
      "reason": "Joining the dev team",
      "requestedAt": "2026-03-27T00:00:00Z",
      "status": "pending"
    }
  ],
  "invites": [
    {
      "code": "INV-xk29f",
      "createdBy": "root",
      "createdAt": "2026-03-27T00:00:00Z",
      "usedBy": null,
      "maxUses": 1,
      "uses": 0,
      "expiresAt": "2026-04-03T00:00:00Z"
    }
  ]
}
```

### 3. User Provisioning

On approval or invite redemption:

1. `useradd -m -s /bin/bash <username>` — create system user
2. `usermod -aG claude <username>` — add to claude group (if exists)
3. Add email → username mapping to user store
4. Claude Code will prompt for auth on first session (user's own API keys)

**Username derivation:** email local part by default, admin can override. Collision detection.

### 4. Email→Username Mapping

The web terminal needs to map `Cf-Access-Authenticated-User-Email` to a system username. This is stored in the user store and loaded at startup. The proxy checks this mapping on every WebSocket connection.

### 5. Admin Panel

Simple web page (cp-admins only) showing:

- Pending requests with approve/deny buttons
- Active users list
- Invite code generator (with expiry and max-use settings)
- User management (deactivate, change username)

No framework — plain HTML with fetch() calls to the API endpoints.

### 6. Web Terminal (xterm.js)

The browser terminal page:

```html
<div id="terminal"></div>
<script>
  const term = new Terminal();
  const ws = new WebSocket('wss://host/ws');
  term.open(document.getElementById('terminal'));
  // bidirectional pipe between xterm.js and WebSocket
</script>
```

The WebSocket transport implements the same `Transport` interface as SSH. The lobby, sessions, hotkeys — everything works the same.

**Status bar returns here** — rendered as an HTML element below the terminal canvas. Not in the PTY stream. Shows session name, users, typing indicators.

---

## Authentication Layers

```
Internet → Cloudflare Access (email auth) → Web Server → User Store (email→username) → Session Manager
                                                                                          │
LAN/VPN  → SSH (pubkey auth) ──────────────────────────────────────────────────────────────┘
```

Both paths converge at the Session Manager with an authenticated username.

---

## Implementation Phases

### Phase 3a: Basic Web Terminal

- HTTP server on port 3101
- WebSocket transport
- xterm.js client
- Auth via Cloudflare Access headers
- Manual email→username mapping in config
- No registration, no admin panel

### Phase 3b: Admin Panel

- Admin web page for cp-admins
- User list, invite generation
- Approve/deny pending requests
- User provisioning (useradd)

### Phase 3c: Self-Registration

- Public landing page
- Request access form
- Invite code redemption
- Email notifications (optional, can start with admin panel only)

---

## Security Considerations

- Landing page and registration are the only public endpoints
- All other pages require Cloudflare Access authentication
- Admin panel requires cp-admins group membership
- Invite codes have expiry and max-use limits
- Rate limiting on registration endpoints
- No passwords stored — Cloudflare Access handles all authentication
- WebSocket connections authenticated on upgrade via Cloudflare headers
- System users are sandboxed by Unix permissions

---

## Open Questions

1. **Email notifications** — required for approval flow? Or admin panel polling is enough?
2. **Username format** — always email local part? Or let admin choose?
3. **User deactivation** — lock the system account? Or just remove from the mapping?
4. **Multiple emails per user** — needed? Or 1:1 mapping?
5. **Guest access** — anonymous view-only for public sessions without registration?
