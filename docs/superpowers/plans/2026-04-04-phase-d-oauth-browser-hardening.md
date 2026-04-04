# Phase D — OAuth browser hardening + login UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship **production-grade browser OAuth** for claude-proxy: **PKCE**, **CSRF protection** for cookie-authenticated browser flows, **confidentiality-hardened session cookies** (encryption, not only HMAC), **first-class login/logout static pages**, and **coordinated svg-terminal routes** so the dashboard can rely on the same trust model when `api.auth.required` is enabled.

**Architecture:** Security fixes live primarily in **`src/auth/`** (OAuth, session cookie, new CSRF helper) and **`src/api-server.ts`** (apply middleware order: CSRF → auth → route). **svg-terminal** adds thin HTTP routes that **redirect** to claude-proxy’s **`public_base_url`** for OAuth when auth is centralized on the platform, and keeps **`getAuthUser`** for sessions that stay local-only. **Unix socket** JSON-RPC remains for session data after login identity is established server-side (svg-terminal passes **`linux_user`** from validated cookie — Phase D **tightens** this by aligning with `api.auth.required` policy).

**Tech Stack:** Node 20+, `openid-client` **^6.8** (PKCE APIs), Node `crypto` (AES-256-GCM for cookies), existing `session-cookie.ts` HMAC as fallback or migration path, Vitest.

**Depends on:** Phase A (operations), Phase C (socket). **Prerequisite doc:** complete or verify **`docs/superpowers/specs/2026-04-03-oauth-web-api-wiring-spec.md`** (W1) — ACL on `/api/*`, `api.auth.required`, WebSocket cookie check — before or in parallel with Phase D; Phase D does **not** replace W1, it **hardens** OAuth and cookies **after** the basic wiring works.

**Out of scope for Phase D:** Admin user CRUD UI, invite system, Cloudflare Access-only mode, **launch profiles**, **socket mTLS** (optional follow-up), bulk **security remediation** from research §13 (pty-multiplexer, scripts).

---

## File map (new / modified)

| Area | Create | Modify |
|------|--------|--------|
| OAuth PKCE | `src/auth/oauth-pkce.ts` (helpers) or inline in `oauth.ts` | `src/auth/oauth.ts`, `src/api-server.ts` (state storage for `code_verifier`) |
| CSRF | `src/auth/csrf.ts` | `src/api-server.ts`, `src/types.ts` (`api.csrf` optional) |
| Cookie encryption | `src/auth/session-cookie.ts` | `src/index.ts` (pass algorithm flag), tests |
| Login UX | `web/login.html`, `web/app.html` (or extend `web/`) | `api-server.ts` static routes |
| svg-terminal | — | `server.mjs` (`/login`, `/logout` redirects), `auth.mjs` if callback URL building needs base URL |
| Docs | — | `sessions.md`, `PRD-amendment-007.md` (svg-terminal) or update **006**, `oauth-web-api-wiring-spec.md` status |

---

## Task 0: W1 wiring spec — verification gate ✅ (2026-04-04)

**Files:** `docs/superpowers/specs/2026-04-03-oauth-web-api-wiring-spec.md` §13, `src/api-server.ts`, `src/operations.ts`, `tests/api-auth-wiring.test.ts`

**Purpose:** Phase D assumes W1 HTTP ACL + WS cookie checks are in place.

- [x] **Step 1:** Walk spec §4–§7 — record in spec **§13 Verification record**.
- [x] **Step 2:** Added **`tests/api-auth-wiring.test.ts`** + **`listDeadSessions` filter test** in `operations.test.ts`.
- [x] **Step 3:** Gaps closed in code: **`/api/remotes|users|groups|directories`** require auth; **WebSocket** validates cookie + **`canUserAccessSession`**; **`/api/auth/me`** returns **501** when no `session.secret`; **`listDeadSessions(username)`** filters by ACL.

**Residual (Phase D, not W1):** explicit YAML **`api.auth.required`** separate from cookie presence; static **`web/login.html`**.

---

## Task 1: PKCE for Google / Microsoft (`OAuthManager`)

**Files:**
- Modify: `src/auth/oauth.ts`
- Modify: `src/api-server.ts` (`/api/auth/login`, `/api/auth/callback`)
- Optional create: `src/auth/oauth-state.ts` — **signed, short-lived state blob** carrying `provider`, `pkce_code_verifier`, `nonce`

**Background:** `openid-client` v6 supports PKCE. **`buildAuthorizationUrl`** should include **`code_challenge`** / **`code_challenge_method=S256`**. The **`code_verifier`** must be presented to **`authorizationCodeGrant`** on callback. Today **`state`** is a random string — extend to either:
- **(Recommended)** **Encrypted signed state** (using `cookieSecret` or a dedicated `oauth_state_secret`): payload `{ provider, verifier, iat, exp }` → base64url, so callback can recover verifier **without server-side session store**, **or**
- **Server-side Map** `state → verifier` with TTL (simpler but stateful across restarts unless persisted).

- [ ] **Step 1:** Add failing test: mock `OAuthManager.getAuthUrl` output contains `code_challenge` when provider is `google`.
- [ ] **Step 2:** Implement PKCE: generate `code_verifier` (43–128 char), `code_challenge = BASE64URL(SHA256(verifier))` per RFC 7636.
- [ ] **Step 3:** Encode verifier in **signed state** passed to `getAuthUrl` (or store in Map); on **`handleCallback`**, recover verifier before `authorizationCodeGrant`.
- [ ] **Step 4:** **GitHub** adapter: if GitHub OAuth supports PKCE in your client lib, align; else document **GitHub exception** in spec (many use client secret only).
- [ ] **Step 5:** Run `npx vitest run tests/` (add `tests/oauth-pkce.test.ts`).
- [ ] **Step 6:** Commit: `feat(auth): PKCE for OAuthManager authorization flow`

---

## Task 2: CSRF tokens for browser mutating API

**Files:**
- Create: `src/auth/csrf.ts` — `createCsrfToken(secret)`, `validateCsrfToken(header, cookie, body)`
- Modify: `src/api-server.ts` — for **`POST`**, **`PATCH`**, **`DELETE`** on `/api/*` when `apiAuthRequired`, require **`X-CSRF-Token`** matching **HttpOnly cookie** `csrf_token` **or** double-submit cookie pattern
- Modify: `web/*` — login page JS fetches `GET /api/auth/csrf` (new **public** route) → sets cookie + returns token for `fetch(..., { headers: { 'X-CSRF-Token': ... } })`

**Semantics:**
- **Safe methods** `GET`, `HEAD`, `OPTIONS` — no CSRF check.
- **OAuth redirects** — already protected by **`state`**; no change.
- **WebSocket** — origin check + cookie already; optional **`Sec-WebSocket-Protocol`** token — **defer** unless product requires.

- [ ] **Step 1:** Add `GET /api/auth/csrf` → `{ token }` + `Set-Cookie: csrf_token=...; HttpOnly; SameSite=Lax; Path=/`
- [ ] **Step 2:** Middleware **`requireCsrfForMutatingMethods`** after body parse for JSON routes.
- [ ] **Step 3:** Vitest: `POST /api/sessions` with cookie but **without** CSRF header → **403** when CSRF enabled.
- [ ] **Step 4:** Feature flag in YAML: `api.csrf.enabled: true` default when `api.auth.required`.

YAML snippet:

```yaml
api:
  auth:
    required: true
  csrf:
    enabled: true   # default true when auth.required
```

- [ ] **Step 5:** Commit: `feat(auth): CSRF protection for mutating web API`

---

## Task 3: Encrypted session cookie (AES-GCM)

**Files:**
- Modify: `src/auth/session-cookie.ts`
- Modify: `src/index.ts` / `api-server.ts` — pass **`cookieEncryptionKey`** (derive from `auth.session.secret` via HKDF or require separate `auth.session.encryption_key` in YAML for rotation)

**Design:**
- **v1 cookie format:** `v2.` + **base64(iv || ciphertext || tag)** where payload JSON is `{ linuxUser, displayName, exp }`.
- **Key:** `crypto.createHmac('sha256', secret).update('cookie-enc-v1').digest()` first 32 bytes, or explicit 32-byte key from env.
- **Migration:** **`validateSessionCookie`** accepts **legacy** `json.sig` HMAC format and **new** encrypted format; **`createSessionCookie`** emits **new** format only.
- **Threat model:** Stops passive DB/log readers from reading `linuxUser` from cookie blob; **still** need **HTTPS** in production for transport.

- [ ] **Step 1:** Unit tests: round-trip encrypt/decrypt; legacy HMAC still validates.
- [ ] **Step 2:** Implement AES-256-GCM helpers; constant-time compare where applicable.
- [ ] **Step 3:** Commit: `feat(auth): AES-GCM encrypted session cookies with HMAC fallback`

---

## Task 4: Standalone login / app static pages (claude-proxy `web/`)

**Files:**
- Create: `web/login.html` — provider buttons → `/api/auth/login?provider=...`
- Create: `web/app.html` — loads JS that calls `GET /api/auth/csrf`, `GET /api/auth/me`, `GET /api/sessions` (minimal table)
- Modify: `api-server.ts` — serve **`/`** → **`login.html`** or **`app.html`** based on cookie (or always `login.html` with link to app)

**Align with spec §8.** Add **`POST /api/auth/logout`** CSRF if mutating.

- [ ] **Step 1:** Manual: open `http://127.0.0.1:3101/login.html`, complete OAuth (dev provider).
- [ ] **Step 2:** Commit: `feat(web): minimal login and app shell for OAuth E2E`

---

## Task 5: svg-terminal coordination

**Files:**
- Modify: `server.mjs` — when **`AUTH_ENABLED`** and **`CLAUDE_PROXY_PUBLIC_BASE`** (new env) set, **`/login`** redirects to **`${CLAUDE_PROXY_PUBLIC_BASE}/api/auth/login?...`** or **`/web/login`**; document **same-site** requirement for cookies (svg-terminal on **:3200**, claude-proxy on **:3101** → different origin — **cookies won’t share** unless **reverse proxy** unifies host).

**Critical product decision (document in plan PRD amendment):**

| Deployment | Approach |
|------------|----------|
| **A — Reverse proxy (recommended prod)** | Single origin `https://terminal.example.com` routes `/api/*` → claude-proxy, `/` → svg-terminal static — **cookie `Path=/`** works |
| **B — Dev (split ports)** | OAuth **only** on claude-proxy **`public_base_url`**; user opens **:3101/login** first, then **:3200** dashboard — svg-terminal validates its **own** cookie only if same OAuth app **redirect** includes both URLs (usually **two** OAuth apps or **localhost** exceptions) — **document as dev-only** |
| **C — Token bridge** | svg-terminal exchanges one-time code with claude-proxy — **Phase D+** |

- [ ] **Step 1:** Add **`CLAUDE_PROXY_PUBLIC_BASE`** to `server.mjs` env section and **redirect** helper.
- [ ] **Step 2:** Document deployment matrix in **`docs/PRD-amendment-007.md`** (svg-terminal) or new **`docs/integration/2026-04-04-oauth-deployment.md`**.

---

## Task 6: Unix socket + `api.auth.required` policy

**Files:**
- Modify: `src/socket-server.ts` (optional), `docs/research/*`

**Problem:** Socket **`listSessions`** trusts **`params.user`** — acceptable for **local root** only. When **`api.auth.required`** is **true**, treat Unix socket as **privileged** (peer **root** / group **`cp-services`**) **or** require **`Authorization: Bearer`** on a future **TCP localhost** bridge — **document** threat model; minimal Phase D: **`socket_group`** + **`chmod`** already restrict socket FS; add **`sessions.md`** note: **“socket API trusts local peer; use group + permissions.”**

- [ ] **Step 1:** Add paragraph to **`PRD-amendment-006`** or **007** — socket identity vs HTTP cookie identity.
- [ ] **Step 2:** Optional: if **`params.user`** ≠ peer’s provisioned identity, **reject** when `api.auth.required` — **only** if product requires (may break svg-terminal) — **default:** document only.

---

## Task 7: Testing & documentation closeout

- [ ] **Step 1:** `npm run build && npx vitest run` in claude-proxy.
- [ ] **Step 2:** Update **`docs/superpowers/specs/2026-04-03-oauth-web-api-wiring-spec.md`** — §12 CSRF/PKCE/cookie **resolved**; status **Implemented** for Phase D slice.
- [ ] **Step 3:** Update **`sessions.md`** — Phase D **DONE** with commit ref.
- [ ] **Step 4:** Update **`docs/integration/UNIFIED-PROJECT.md`** checklist row for OAuth / Phase D.

---

## Self-review (plan author)

| Spec / goal | Task |
|-------------|------|
| PKCE | Task 1 |
| CSRF | Task 2 |
| Cookie encryption | Task 3 |
| Standalone login HTML | Task 4 |
| svg-terminal + OAuth | Task 5 |
| Socket threat model note | Task 6 |
| Tests + docs | Task 7 |

**Placeholder scan:** No TBD in task titles; deployment **C** is explicitly future.

---

*Plan saved: `docs/superpowers/plans/2026-04-04-phase-d-oauth-browser-hardening.md`*

**Execution options after W1 gate is green:**

1. **Subagent-driven** — one subagent per task, review between tasks (recommended for security-sensitive code).
2. **Inline** — execute in one session with checkpoints after Tasks 1–3 (crypto).

Which approach do you want when you start implementation?
