# claude-proxy Docker Distribution — Design Spec
**Date:** 2026-03-28
**Status:** Design (not building yet)
**Goal:** Anyone can `docker-compose up` and have a working collaborative Claude session manager.

---

## User Experience

### First-time install
```bash
git clone https://github.com/frodex/claude-proxy.git
cd claude-proxy
docker-compose up -d
# Open http://localhost:3101 in browser
```

### What the user sees
1. Browser opens to welcome page
2. "Create admin account" — enter name, email, password
3. "Enter your Anthropic API key" — stored in Vault, never on disk
4. "Your SSH access" — generates a keypair, shows public key and connection string
5. Dashboard appears — create first session, start using Claude

### Day-to-day
- SSH: `ssh -p 3100 admin@your-server`
- Browser: `http://your-server:3101`
- Both show the same sessions, same access control

---

## Container Architecture

```
docker-compose.yml
│
├── vault (hashicorp/vault:latest)
│   ├── Internal port 8200
│   ├── Dev mode for quick start (VAULT_DEV_ROOT_TOKEN_ID)
│   ├── KV v2 secrets engine auto-enabled
│   ├── Stores: API keys, SSH keys, user mappings
│   └── Volume: vault-data (persistence)
│
├── claude-proxy (Dockerfile)
│   ├── Port 3100 → SSH proxy
│   ├── Port 3101 → Web UI + API
│   ├── Runtime: Node.js 22 + tmux + claude binary
│   ├── Runs as: claude-proxy user (non-root)
│   ├── Reads secrets from Vault via HTTP API
│   ├── Volume: proxy-data (session metadata, tmux sockets)
│   └── Volume: user-homes (per-user home dirs with ~/.claude)
│
└── (future) cloudflare-tunnel (optional)
    ├── Exposes 3100 + 3101 to internet
    └── Handles OAuth via Cloudflare Access
```

---

## Vault Secret Paths

```
secret/claude-proxy/
├── admin/
│   └── setup          → { initialized: true, admin_user: "admin" }
│
├── users/
│   ├── greg           → { api_key: "sk-ant-...", email: "greg@gmail.com" }
│   └── frodex         → { api_key: "sk-ant-...", email: "alice@company.com" }
│
├── org/
│   └── shared-key     → { api_key: "sk-ant-..." }  (optional shared org key)
│
├── ssh/
│   ├── host-keys      → { ed25519_private: "...", ed25519_public: "..." }
│   ├── ct100          → { private_key: "..." }  (remote host keys)
│   └── bigserver      → { private_key: "..." }
│
└── auth/
    └── email-map      → { "greg@gmail.com": "greg", "alice@co.com": "frodex" }
```

---

## Dockerfile

```dockerfile
FROM node:22-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux openssh-client curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code

# Create non-root service user
RUN useradd -m -s /bin/bash claude-proxy

# App code
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
COPY scripts/ ./scripts/
COPY tmux.conf ./
COPY web/ ./web/
COPY claude-proxy.yaml ./

# Data directories
RUN mkdir -p /data/sessions /data/user-homes && \
    chown -R claude-proxy:claude-proxy /data

# SSH host keys generated at first run, stored in /data
# User home dirs created dynamically in /data/user-homes

EXPOSE 3100 3101

USER claude-proxy
CMD ["node", "dist/index.js"]
```

---

## User Management Inside Docker

**Problem:** Current claude-proxy uses real Unix users (`useradd`, `su - username`). Docker containers don't normally have multiple system users.

**Solution:** The container creates system users dynamically when a new user registers:

```
User registers via web UI
  → API creates system user inside container (needs capability)
  → Home dir at /data/user-homes/<username>
  → Claude runs as that user via su
  → API key fetched from Vault and injected as env var
```

**Capability needed:** Container needs `SYS_ADMIN` or we pre-create a pool of users.

**Alternative:** Don't use `su` at all. Run all Claude sessions as the `claude-proxy` user but with separate `HOME` dirs. Simpler, less isolation.

**Recommendation:** Separate `HOME` dirs, same user. True multi-user isolation is a Phase 2 concern. For an installable package, simplicity wins.

```bash
# Instead of: su - greg -c 'claude'
# Do: HOME=/data/user-homes/greg claude
```

Each user gets their own `~/.claude/` config but shares the same Unix user. API keys from Vault ensure they can't access each other's Claude accounts.

---

## API Key Flow

```
User creates session
  → Proxy reads: secret/claude-proxy/users/<username>
  → Gets: { api_key: "sk-ant-..." }
  → Sets env: ANTHROPIC_API_KEY=sk-ant-...
  → Launches: HOME=/data/user-homes/<username> claude
  → Claude sees the API key in env, doesn't prompt for auth
  → Key never written to disk
```

**Fallback:** If no key in Vault, Claude's interactive auth flow runs (user authenticates through Claude's own UI). The key gets stored in `~/.claude/` as normal.

**Shared org key:** If `secret/claude-proxy/org/shared-key` exists, it's used for all users who don't have their own key.

---

## SSH Key Flow (for remote hosts)

```
User creates remote session on ct100
  → Proxy reads: secret/claude-proxy/ssh/ct100
  → Gets: { private_key: "-----BEGIN..." }
  → Writes to temp file (mode 600)
  → Runs: ssh -i /tmp/key-xxx -tt ct100 tmux new-session...
  → Deletes temp file after SSH connection established
```

**Better (future):** Vault SSH secrets engine issues a signed certificate with 5-minute TTL. No static keys.

---

## SSH Host Key Persistence

```
First run:
  → Check /data/ssh-host-keys/
  → If empty: generate ed25519 + rsa keys
  → Store in Vault: secret/claude-proxy/ssh/host-keys (backup)
  → Use from /data/ssh-host-keys/ (primary)

Container restart:
  → Keys still in /data volume → same host key → no SSH warning
```

---

## Configuration Hierarchy

```
1. Environment variables (highest priority)
   PORT=3100 API_PORT=3101 VAULT_ADDR=... VAULT_TOKEN=...

2. claude-proxy.yaml in /app (bundled defaults)

3. /data/config.yaml (user overrides, persisted in volume)

4. Vault (secrets only, not config)
```

---

## What Gets Persisted (volumes)

| Volume | Contents | Survives |
|--------|----------|----------|
| `proxy-data` | Session metadata JSON, config overrides | Container restart ✓ |
| `user-homes` | Per-user ~/.claude/ dirs | Container restart ✓ |
| `vault-data` | Vault storage backend | Container restart ✓ |

**NOT persisted:** tmux sessions (die with container). After container restart, sessions are dead but metadata survives → users can restart them from the lobby.

---

## docker-compose.yml

```yaml
version: '3.8'

services:
  vault:
    image: hashicorp/vault:latest
    restart: unless-stopped
    cap_add:
      - IPC_LOCK
    environment:
      VAULT_DEV_ROOT_TOKEN_ID: ${VAULT_TOKEN:-claude-proxy-dev}
      VAULT_DEV_LISTEN_ADDRESS: 0.0.0.0:8200
    volumes:
      - vault-data:/vault/data
    networks:
      - internal

  claude-proxy:
    build: .
    restart: unless-stopped
    ports:
      - "${SSH_PORT:-3100}:3100"
      - "${WEB_PORT:-3101}:3101"
    environment:
      VAULT_ADDR: http://vault:8200
      VAULT_TOKEN: ${VAULT_TOKEN:-claude-proxy-dev}
      NODE_ENV: production
    depends_on:
      - vault
    volumes:
      - proxy-data:/data
      - user-homes:/data/user-homes
    networks:
      - internal

volumes:
  vault-data:
  proxy-data:
  user-homes:

networks:
  internal:
```

---

## .env (user creates, git-ignored)

```
VAULT_TOKEN=my-secret-vault-token
SSH_PORT=3100
WEB_PORT=3101
```

---

## What We Build vs What Exists

| Component | Status | Needed for Docker |
|-----------|--------|-------------------|
| SSH proxy | Done | ✓ Already works |
| Session manager | Done | ✓ Already works |
| Access control | Done | ✓ Already works |
| tmux backend | Done | ✓ Already works |
| API server | Done | ✓ Already works |
| Screen renderer | Done | ✓ Already works |
| Vault client | **Not built** | New: src/vault-client.ts |
| Web onboarding | **Not built** | New: first-run wizard |
| User provisioning | **Partial** | Adapt: create users in container |
| Dockerfile | **Not built** | New |
| docker-compose.yml | **Not built** | New |
| Web dashboard | **In progress** | From svg-terminal integration |
| Auth (Cloudflare) | **Not built** | Phase 3b |

---

## Build Order

1. **Vault client** (`src/vault-client.ts`) — read secrets via HTTP
2. **Adapt launch flow** — inject API key from Vault, use HOME override instead of su
3. **Dockerfile** — package everything
4. **docker-compose.yml** — wire claude-proxy + vault
5. **First-run detection** — check if Vault has admin user, show setup wizard if not
6. **Web onboarding pages** — create admin, enter API key, generate SSH key
7. **Test end-to-end** — `docker-compose up` on a clean machine

---

## Constraints

- Container must work on Linux and Mac (Docker Desktop)
- No root inside container (except initial user creation)
- API keys never on disk
- SSH host keys persist across container restarts
- tmux sessions die with container (metadata survives for restart)
- Must work offline after initial setup (no CDN dependencies at runtime)
- Claude Code version pinned in Dockerfile (reproducible builds)

---

## Open Questions

1. **Claude Code auth inside Docker** — Claude's interactive auth opens a browser. In Docker there's no browser. Options: API key injection from Vault (our plan), or headless auth flow if Claude supports it.

2. **Container user management** — `useradd` inside a running container requires privileges. Use `HOME=` override (simpler, less isolation) or pre-create user pool?

3. **Vault production mode** — dev mode is fine for trying out. Production needs init/unseal. Include a production compose variant, or document manual setup?

4. **Image size** — Node.js + tmux + Claude Code binary. Estimate ~500MB. Acceptable?

5. **Auto-update Claude Code** — pin version for reproducibility, or auto-update on container start?

6. **ARM support** — Node.js and tmux work on ARM. Does Claude Code have ARM binaries?
