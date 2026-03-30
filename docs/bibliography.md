# Bibliography — claude-proxy

Sources reviewed, referenced, or learned from during development.

| Source | Date | Referenced For |
|--------|------|----------------|
| [Bubbletea - Elm Architecture for Go TUIs](https://github.com/charmbracelet/bubbletea) | 2026-03-29 | Widget architecture research: Model/Update/View pattern, pure state machines, msg-based input handling. Considered for widget system design. |
| [Wish - SSH middleware for Bubbletea](https://github.com/charmbracelet/wish) | 2026-03-29 | Multi-transport pattern: serving same Bubbletea program over SSH with per-session pty. Relevant to our SSH multiplexer model. |
| [Ink - React for CLI](https://github.com/vadimdemedes/ink) | 2026-03-29 | Custom React renderer pattern: JSX components → Yoga flexbox → ANSI. useInput/useFocus hooks. renderToString for non-interactive output. |
| [Textual - Python TUI framework](https://github.com/Textualize/textual) | 2026-03-29 | **Key reference.** Driver abstraction enables same widget code for terminal + web. CSS styling, DOM-based focus, event bubbling. `textual serve` for zero-change web deployment. Most relevant architecture for our multi-transport needs. |
| [Blessed - Node.js curses-like library](https://github.com/chjj/blessed) | 2026-03-29 | DOM-like widget tree, painter's algorithm rendering. Evaluated and rejected — unmaintained, terminal-only, too imperative. |
| [Ratatui - Rust TUI library](https://github.com/ratatui/ratatui) | 2026-03-29 | Backend abstraction pattern: widgets write to abstract Buffer, pluggable backends render to terminal/WASM. Clean separation model. |
| [Claude Code install script](https://claude.ai/install.sh) | 2026-03-29 | Self-updating native installer for remote hosts. Replaces npm install -g which was prone to corruption during auto-updates. |
| [Session 35f38ccc JSONL](/root/.claude/projects/-root/35f38ccc-1788-4481-a303-2fd58534e09e.jsonl) | 2026-03-29 | Original claude-proxy development session. Referenced for remote session history: ct100 setup, -tt SSH fix, nested quote fix, known gap in remote rediscovery. |
| [tmux server-access PR #3019](https://github.com/tmux/tmux/pull/3019) | 2026-03-29 | Per-user ACLs in tmux 3.3+. `server-access -a user` grants access, `-r` read-only, `-w` write, `-d` revoke. Foundation for our UGO security model. |
| [tmux socket permission issue #2110](https://github.com/tmux/tmux/issues/2110) | 2026-03-29 | Discussion of socket permission best practices. tmux resets socket perms to 0770; group ownership is what controls access. |
| [tmux GID support request #4917](https://github.com/tmux/tmux/issues/4917) | 2026-03-29 | `server-access` only supports UIDs, not GIDs. Maintainer says feasible but not implemented. We need thin wrapper for group-based control. |
| [Fine-Grained Access Control in tmux](https://hoop.dev/blog/fine-grained-access-control-in-tmux/) | 2026-03-29 | Practical guide to tmux ACLs with server-access. Confirms the -S socket + chgrp + server-access pattern. |
| [wemux - Multi-User Tmux](https://github.com/zolrath/wemux) | 2026-03-29 | Design reference for mirror/pair/rogue mode concept and user notifications. Not adopted — uses chmod 1777 (world-accessible), unmaintained. |
| [tmux-share](https://github.com/Chouser/tmux-share) | 2026-03-29 | Pattern reference for symlink-based session discovery and periodic permission verification. Minimal but demonstrates the right architecture. |
| [GNU screen multiuser docs](https://aperiodic.net/screen/multiuser) | 2026-03-29 | Design reference for per-window per-command ACL granularity. Not adopted — requires setuid root. |
| [tmate architecture](https://viennot.com/tmate.pdf) | 2026-03-29 | Namespace-based session isolation model. Reference for future sandboxing. Not adopted — relay architecture wrong for local sharing. |
| [better-sqlite3-multiple-ciphers](https://github.com/m4heshd/better-sqlite3-multiple-ciphers) | 2026-03-29 | SQLite with encryption. Chosen for user store — full-DB encryption, synchronous API, actively maintained. Vault Transit planned for Docker migration. |
| [openid-client (Node.js)](https://github.com/panva/node-openid-client) | 2026-03-29 | OIDC-compliant OAuth library for Node.js. Handles Google/Microsoft via discovery URL. GitHub needs custom adapter. |
