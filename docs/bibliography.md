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
