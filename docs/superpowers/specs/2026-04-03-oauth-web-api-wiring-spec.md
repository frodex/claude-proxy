# OAuth + Web API wiring specification

**Date:** 2026-04-03  
**Status:** Draft — implementation checklist  
**Purpose:** Fully specify how OAuth, session cookies, and HTTP/WebSocket API identity align so the web UI can be built and tested on real auth. Supersedes scattered TODOs in handoff docs with one executable contract.

**Unified project index:** Cross-repo integration and stepped docs with **svg-terminal** are canonical under **`/srv/svg-terminal/docs/integration/`** (see `2026-04-02-claude-proxy-partial-screen-fix.v01.md` §0). When OAuth wiring ships, update that index and svg-terminal’s WebSocket integration spec for authenticated `fetch` / WS to claude-proxy.

**Related:** `docs/integration/PRD-claude-proxy-as-built-v2.1.md`, `docs/superpowers/plans/2026-03-29-auth-plan-c-oauth.md`, `docs/superpowers/plans/2026-03-31-handoff-todos-v3.md` §6, `sessions.md`

---

## 1. Goals (this slice)

1. **`index.ts` wires** `OAuthManager`, `GitHubAdapter` (when configured), `SQLiteUserStore`, `cookieSecret`, `cookieMaxAge`, and **`callbackBaseUrl`** into `startApiServer()`.
2. **OAuth redirect URIs** match what providers expect (fixed public base URL, not guessed from per-request `Host` alone unless explicitly allowed for dev).
3. **Authenticated API routes** resolve **Linux username** from the signed cookie and use the **same ACL helpers** as SSH (`listSessionsForUser`, `canUserJoin`, `canUserEditSession`, `canUserAccessSession`).
4. **`GET /api/sessions`** returns only sessions **visible** to the current user (parity with lobby).
5. **`POST /api/sessions`** (and other mutating routes) attribute **`access.owner`** and **`fakeClient.username`** to **`req.user.linuxUser`**, not hard-coded `root`.
6. **WebSocket** `/api/session/:id/stream` requires a **valid session cookie** and **join permission** for that session.
7. **Unauthenticated callers** receive **401** on protected routes when web auth is **enabled** (see §7 for dev escape hatch).

**Non-goals for this slice:** Admin user CRUD UI, invite system, Cloudflare Access-only mode, PRD rewrite, launch-profile work.

---

## 2. Configuration

### 2.1 Extend `Config` / YAML

Add an **`api`** block (today `index.ts` uses `(config as any).api` — promote through `src/types.ts`):

```yaml
# claude-proxy.yaml (example)
port: 3100
host: 0.0.0.0

# API + browser OAuth (HTTP server)
api:
  port: 3101
  host: 127.0.0.1          # bind; use 0.0.0.0 only behind a reverse proxy you trust
  public_base_url: "http://localhost:3101"   # REQUIRED for OAuth when web auth enabled
  # public_base_url: "https://claude-proxy.example.com"   # production — must match provider app settings

auth:
  authorized_keys: ~/.ssh/authorized_keys
  providers:
    google:
      client_id: "xxx.apps.googleusercontent.com"
      client_secret: "xxx"
    microsoft:
      client_id: "xxx"
      client_secret: "xxx"
      tenant: "common"
    github:
      client_id: "xxx"
      client_secret: "xxx"
  session:
    secret: "min-32-chars-random-use-openssl-rand-hex-32"   # cookie HMAC — REQUIRED when web auth enabled
    max_age: 86400
  auto_provision: true          # optional; default true — new OAuth users → Linux user via Provisioner
  default_groups: ["users"]   # optional; mapped to cp-* groups per resolve-user / provisioner
```

**Rules:**

- **`api.public_base_url`**: No trailing slash. OAuth **`redirect_uri`** is exactly  
  `{public_base_url}/api/auth/callback`  
  Register that string in Google Cloud Console, Azure app, GitHub OAuth app.
- **`auth.session.secret`**: If web auth is enabled (§7), must be non-empty. **Never commit real secrets** — use env substitution or a secrets manager in production if you extend config loading later.

### 2.2 YAML → `OAuthManager` shape

`OAuthManager` (`src/auth/oauth.ts`) expects **camelCase** `clientId` / `clientSecret`. YAML uses **snake_case**. **Map in `index.ts`** (small helper `buildOAuthManagerConfig(config)`):

| YAML path | `OAuthManagerConfig` |
|-----------|----------------------|
| `auth.providers.google.client_id` | `google.clientId` |
| `auth.providers.google.client_secret` | `google.clientSecret` |
| `auth.providers.microsoft.client_id` | `microsoft.clientId` |
| `auth.providers.microsoft.client_secret` | `microsoft.clientSecret` |
| `auth.providers.microsoft.tenant` | `microsoft.tenant` |

**GitHub** does **not** go into `OAuthManager`. If `auth.providers.github` is present, construct:

`new GitHubAdapter(clientId, clientSecret, callbackBaseUrl)`  
(same `callbackBaseUrl` as `public_base_url`).

If **no** Google/Microsoft keys → omit `OAuthManager` (or pass empty config and rely on `getSupportedProviders()` returning `[]` — prefer omitting if nothing configured).

---

## 3. Bootstrap in `index.ts`

### 3.1 Shared services (already exist)

- **`LinuxProvisioner`** — one instance; already passed to `SessionManager`. **Reuse** for `startApiServer({ provisioner })`.
- **`SQLiteUserStore`** — **create once** (unless testing with in-memory stub):

  - Path: `resolve(__dirname, '..', 'data', 'users.db')`
  - Ensure `data/` exists (`mkdirSync` with `recursive: true` on startup if missing).

### 3.2 Derive `callbackBaseUrl`

```ts
const callbackBaseUrl =
  (config as any).api?.public_base_url?.replace(/\/$/, '')
  ?? `http://${apiHost}:${apiPort}`;  // fallback only for local dev — document risk
```

**Spec requirement:** When any OAuth provider is configured, **`api.public_base_url` must be set**; log **warn** if fallback is used with OAuth enabled.

### 3.3 Build OAuth objects

1. From merged YAML → `OAuthManagerConfig` (Google/Microsoft only).
2. If at least one of google/microsoft → `new OAuthManager(oauthMgrConfig, callbackBaseUrl)`.
3. If `config.auth.providers?.github` → `new GitHubAdapter(clientId, clientSecret, callbackBaseUrl)`.

### 3.4 Cookie session

- `cookieSecret = config.auth.session?.secret`
- `cookieMaxAge = config.auth.session?.max_age ?? 86400`

### 3.5 Call `startApiServer`

Pass **at minimum**:

```ts
startApiServer({
  port: apiPort,
  host: apiHost,
  sessionManager,
  config,
  staticDir: webDir,
  dirScanner,
  oauthManager,           // optional
  githubAdapter,          // optional
  userStore,              // SQLiteUserStore — required for OAuth callback
  provisioner,            // same LinuxProvisioner instance
  cookieSecret,           // required when webProtectionEnabled (§7)
  cookieMaxAge,
  callbackBaseUrl,        // NEW optional field — used only for logging / redirects if needed
  apiAuth: {              // NEW — see §7
    required: boolean,     // require cookie on protected routes
  },
});
```

Extend **`ApiServerOptions`** in `api-server.ts` accordingly.

---

## 4. `api-server.ts` behavior changes

### 4.1 Authenticated request type

Use existing `AuthenticatedRequest` from `auth/middleware.ts`. **`createAuthMiddleware(secret)`** validates `session` cookie and sets `req.user` (`CookiePayload`: `linuxUser`, `displayName`).

Add helper **`getLinuxUser(req: IncomingMessage, cookieSecret: string): CookiePayload | null`** for routes that need optional auth, or always run middleware on protected paths.

### 4.2 Route classes

| Class | Routes | Behavior when `apiAuth.required === true` |
|-------|--------|-------------------------------------------|
| **Public** | `OPTIONS *`, `GET /api/auth/providers`, `GET /api/auth/login`, `GET /api/auth/callback`, static files under `/` | No cookie |
| **Session cookie** | `GET /api/auth/me`, `POST /api/auth/logout` | `me`: validate cookie (already); logout: optional cookie clear |
| **Protected** | All other `/api/*` below | **401** if missing/invalid cookie |

**Protected route list (must match implementation):**

- `POST /api/sessions`
- `GET /api/sessions` (list)
- `GET /api/sessions/dead`
- `DELETE /api/sessions/:id`
- `GET /api/sessions/:id/settings`
- `PATCH /api/sessions/:id/settings`
- `POST /api/sessions/:id/restart`
- `POST /api/sessions/:id/fork`
- `GET /api/session/:id/screen`
- `GET /api/remotes`, `GET /api/users`, `GET /api/groups`, `GET /api/directories` — **restrict** (§5.4) — authenticated user sees data **scoped** to their permissions where applicable

**Implementation pattern:** At the top of the `createServer` callback, after parsing `url`:

1. If route is **public** → handle as today.
2. If route is **protected** and `apiAuth.required`:
   - Parse cookie; if invalid → `401` JSON `{ error: 'Authentication required' }`.
   - Attach `linuxUser` to a local `const user = ...` passed down or hang `req as AuthenticatedRequest`.

Avoid duplicating cookie parsing in every block — one **`requireWebUser(req, res, cookieSecret)`** that returns `CookiePayload | null` and writes 401 on failure.

### 4.3 OAuth callback prerequisites

`GET /api/auth/callback` currently calls `userStore!` and `provisioner!`. **Spec:** If OAuth is enabled:

- `userStore` and `provisioner` **must** be defined; otherwise `500` with clear log before any redirect.

### 4.4 Fix `GET /api/auth/me`

Today: fails when `cookieSecret` is falsy even with a valid cookie. **Spec:** If web auth enabled and secret set — validate cookie. If web auth disabled — return **404** or **501** for `/api/auth/me` with `{ error: 'Web authentication not configured' }` so clients don’t assume logged-in state.

---

## 5. Identity and ACL mapping

Let **`u = req.user!.linuxUser`** (authenticated Linux username).

### 5.1 `GET /api/sessions`

Replace `sessionManager.listSessions()` with **`sessionManager.listSessionsForUser(u)`**.  
Compose title / dims as today.

### 5.2 `POST /api/sessions`

`fakeClient.username = u`.  
Set **`access.owner = u`** in thepartial `SessionAccess` (body may still override other flags; **owner is always** the authenticated user unless you later add admin-impersonation — out of scope).

**`runAsUser`:** If body omits `runAsUser`, default to **`u`** (not `root`). If body sets `runAsUser !== u`, **only allow** if `u` is admin (`u === 'root' || isUserInGroup(u, 'admins')`) — mirror SSH session form `admin-only` behavior.

### 5.3 `GET /api/sessions/dead`

Filter: only return dead sessions where **`canUserAccessSession(u, dead.access)`** or **`dead.access.owner === u`** (align with who may restart). If metadata lacks `access`, define rule: only owner from stored meta (see `listDeadSessions` shape).

### 5.4 `DELETE`, `GET/PATCH settings`, `restart`, `fork`

Before mutating or reading sensitive settings:

1. `sessionManager.getSession(id)` → 404 if missing.
2. **`canUserAccessSession(u, session.access)`** for read/stream.
3. **Destroy:** only if **`canUserEditSession(u, session.access)`** or policy “owner only” — match session-manager SSH rules; today `destroySession` may need a guard; **spec** owner or session admin or `cp-admins`.
4. **PATCH settings:** **`canUserEditSession`** only.
5. **Fork / restart:** **`canUserJoin`** / edit rules consistent with SSH fork flow.

### 5.5 `GET /api/session/:id/screen`

Require **`canUserAccessSession(u, session.access)`**; else **403**.

### 5.6 `GET /api/users`, `GET /api/groups`

Today these return global lists for form pickers. **Minimum for web:** allow only **authenticated** users; optionally filter users list to same policy as `getClaudeUsers()` intersect “visible to `u`” if product requires — **default:** authenticated + keep existing lists for lobby parity (document as future hardening).

### 5.7 `GET /api/directories`

Dir history is global on disk. **Minimum:** require auth; **future:** filter by `u` per directory-selector spec — out of scope except note in PRD follow-up.

### 5.8 WebSocket `GET /api/session/:id/stream` → upgrade

`wss.on('connection', (ws, req) => { ... })`:

1. Read **`req.headers.cookie`**; validate with **`validateSessionCookie`** + `cookieSecret`.
2. If invalid and `apiAuth.required` → **`ws.close(4401, 'Unauthorized')`**.
3. If valid, **`u = payload.linuxUser`**; load session; **`canUserAccessSession(u, session.access)`**; else close **4403** (or 4004 “Forbidden”).

**Note:** Cross-origin WS won’t send cookies unless browsers allow credentials; **same-origin** web app on `public_base_url` is the intended deployment.

---

## 7. Feature flag: **`api.auth.required`**

Add YAML:

```yaml
api:
  auth:
    required: true    # default true when session.secret + any provider configured
```

**Semantics:**

| `session.secret` | OAuth providers | `api.auth.required` | Protected routes |
|------------------|-----------------|---------------------|-------------------|
| set | ≥1 configured | `true` (default) | 401 without cookie |
| set | 0 | `true` | Cookie works for future local login — or disable until provider |
| unset | any | **false** (default) | **Legacy:** match **today’s** open API — **log warning** on startup |
| unset | ≥1 | invalid | **Refuse startup** or **fatal log** — OAuth cannot work without cookie secret |

**Recommendation:** If **`auth.session.secret`** missing and **`api.auth.required !== false`**, **exit process** with message when any provider is configured.

---

## 8. Web UI minimal flow (for testing today)

1. **Static `web/login.html`** (or `/`) — buttons: “Google”, “Microsoft”, “GitHub” → `window.location = '/api/auth/login?provider=google'` etc.
2. After callback, user lands on **`/`** with `Set-Cookie`. Serve **`web/app.html`** (or dashboard) that calls `GET /api/auth/me` and `GET /api/sessions`.
3. Terminal page opens WS to **`/api/session/:id/stream`** on **same origin** so cookie is sent.

---

## 9. Provider console checklist

For each environment’s **`public_base_url`**:

- **Google:** Authorized redirect URIs → `https://host:3101/api/auth/callback`
- **Microsoft:** Redirect URI platform config → same
- **GitHub:** Authorization callback URL → same

Use **exact** scheme/host/port.

---

## 10. Testing

### 10.1 Manual

1. Start proxy with **only** `session.secret` set, **no** providers → `GET /api/sessions` behavior matches flag (401 if required).
2. Configure **one** provider + secret → complete login → `me` returns `linuxUser` → `GET /api/sessions` subset matches SSH lobby for that user.
3. Second Linux user / second OAuth account → verify **cannot** see other user’s **private** sessions in list.
4. **WS:** connect without cookie → rejected; with cookie → attaches when allowed.

### 10.2 Automated (suggested)

- **`tests/api-auth-wiring.test.ts`:** Mount `startApiServer` or extract route handler with mock `SessionManager`; `POST /api/sessions` without cookie → 401 when `required`; with forged invalid cookie → 401; with valid HMAC cookie → `createSession` receives `username` from payload.
- Reuse **`session-cookie`** sign/verify helpers.

---

## 11. File change list (implementation)

| File | Change |
|------|--------|
| `src/types.ts` | Add `api?: { port, host, public_base_url, auth?: { required?: boolean } }` |
| `src/config.ts` | Optional: validate OAuth + secret consistency |
| `src/index.ts` | Build OAuth adapters, UserStore, pass `startApiServer` options |
| `src/api-server.ts` | Extend options; central `requireWebUser`; protect routes; ACL on list/create/mutate/screen/WS; fix `me` |
| `claude-proxy.yaml` | Uncomment / document `api` + `auth.session` + providers |
| `web/*` | Minimal login + shell pages for E2E |
| `docs/integration/PRD-*.md` | Short “Web auth activated” note when done |

---

## 12. Open points (decide during implement)

- **Callback landing:** `302` to `/` vs `/app.html` — pick one and add static file.
- **CSRF:** OAuth state already used; cookie is `SameSite=Lax` — document **no** JSON POST login from third-party site without extra tokens.
- **`auto_provision`:** Ensure `resolve-user` + `LinuxProvisioner` match production policy (default groups `cp-users`, etc.) per existing auth spec.

---

*End of wiring spec — implement in one PR; update this doc status to **Implemented** with commit hash when merged.*
