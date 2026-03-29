#!/bin/bash
# Launch claude for a user — installs if not found

# Block Ctrl+Z unless CLAUDE_PROXY_ALLOW_SUSPEND is set
# Suspended Claude inside tmux is unrecoverable for most users
if [ "${CLAUDE_PROXY_ALLOW_SUSPEND}" != "1" ]; then
  trap '' TSTP
fi

# Check if claude is available
if command -v claude &>/dev/null; then
  exec claude "$@"
fi

# Check common locations
for p in ~/.local/bin/claude /usr/local/bin/claude ~/.npm-global/bin/claude; do
  if [ -x "$p" ]; then
    exec "$p" "$@"
  fi
done

# Not found — install it
echo ""
echo "  Claude Code is not installed for user: $(whoami)"
echo "  Installing now..."
echo ""

# Check if npm is available
if ! command -v npm &>/dev/null; then
  echo "  npm not found. Installing Node.js first..."
  echo ""
  # Try to use nvm or direct install
  if command -v nvm &>/dev/null; then
    nvm install --lts
  else
    # Install node via the system package if available
    echo "  Please ask an admin to install Node.js for your account."
    echo "  Or run: curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs"
    echo ""
    echo "  Press Enter to return to lobby..."
    read
    exit 1
  fi
fi

echo "  Running: npm install -g @anthropic-ai/claude-code"
echo ""
npm install -g @anthropic-ai/claude-code

if command -v claude &>/dev/null; then
  echo ""
  echo "  Installation complete! Launching Claude Code..."
  echo ""
  sleep 2
  exec claude "$@"
else
  # Check npm global bin
  NPM_BIN=$(npm config get prefix)/bin/claude
  if [ -x "$NPM_BIN" ]; then
    echo ""
    echo "  Installation complete! Launching Claude Code..."
    echo ""
    sleep 2
    exec "$NPM_BIN" "$@"
  fi

  echo ""
  echo "  Installation failed. Claude not found after install."
  echo "  Try manually: npm install -g @anthropic-ai/claude-code"
  echo ""
  echo "  Press Enter to return to lobby..."
  read
  exit 1
fi
