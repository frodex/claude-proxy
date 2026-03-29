#!/bin/bash
# Setup a remote server for claude-proxy sessions
# Usage: ./setup-remote.sh <hostname>
#
# Checks and installs: tmux, Node.js, Claude Code
# Creates the tmux config for claude-proxy
# Tests the connection

set -e

REMOTE="${1:?Usage: $0 <hostname>}"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
GRAY='\033[0;90m'
NC='\033[0m'

echo ""
echo "  claude-proxy remote setup"
echo "  ─────────────────────────"
echo "  Target: $REMOTE"
echo ""

# Test SSH connection
echo -n "  [1/6] SSH connection... "
if ssh -o ConnectTimeout=5 -o BatchMode=yes "$REMOTE" "echo ok" &>/dev/null; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}FAILED${NC}"
  echo "        Cannot SSH to $REMOTE. Check your SSH config and keys."
  exit 1
fi

# Check/install tmux
echo -n "  [2/6] tmux... "
if ssh "$REMOTE" "which tmux" &>/dev/null; then
  TMUX_VER=$(ssh "$REMOTE" "tmux -V" 2>/dev/null)
  echo -e "${GREEN}OK${NC} ${GRAY}($TMUX_VER)${NC}"
else
  echo -e "${YELLOW}INSTALLING${NC}"
  ssh "$REMOTE" "apt-get update -qq && apt-get install -y -qq tmux" 2>/dev/null || \
  ssh "$REMOTE" "yum install -y -q tmux" 2>/dev/null || \
  ssh "$REMOTE" "apk add tmux" 2>/dev/null || {
    echo -e "        ${RED}FAILED${NC} — install tmux manually on $REMOTE"
    exit 1
  }
  echo -e "        ${GREEN}Installed${NC}"
fi

# Check/install Node.js
echo -n "  [3/6] Node.js... "
if ssh "$REMOTE" "which node" &>/dev/null; then
  NODE_VER=$(ssh "$REMOTE" "node --version" 2>/dev/null)
  echo -e "${GREEN}OK${NC} ${GRAY}($NODE_VER)${NC}"
else
  echo -e "${YELLOW}INSTALLING${NC}"
  ssh "$REMOTE" "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -qq nodejs" 2>/dev/null || {
    echo -e "        ${RED}FAILED${NC} — install Node.js manually on $REMOTE"
    exit 1
  }
  NODE_VER=$(ssh "$REMOTE" "node --version" 2>/dev/null)
  echo -e "        ${GREEN}Installed${NC} ${GRAY}($NODE_VER)${NC}"
fi

# Check/install Claude Code (self-updating native build)
echo -n "  [4/6] Claude Code... "
if ssh "$REMOTE" "which claude" &>/dev/null; then
  CLAUDE_VER=$(ssh "$REMOTE" "claude --version 2>/dev/null | head -1")
  echo -e "${GREEN}OK${NC} ${GRAY}($CLAUDE_VER)${NC}"
else
  echo -e "${YELLOW}INSTALLING${NC}"
  ssh "$REMOTE" "curl -sL https://claude.ai/install.sh | bash" 2>/dev/null || {
    echo -e "        ${RED}FAILED${NC} — install Claude Code manually: curl -sL https://claude.ai/install.sh | bash"
    exit 1
  }
  CLAUDE_VER=$(ssh "$REMOTE" "PATH=\$HOME/.local/bin:\$PATH claude --version 2>/dev/null | head -1")
  echo -e "        ${GREEN}Installed${NC} ${GRAY}($CLAUDE_VER)${NC}"
fi

# Deploy tmux config
echo -n "  [5/6] tmux config... "
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMUX_CONF="$SCRIPT_DIR/../tmux.conf"
if [ -f "$TMUX_CONF" ]; then
  ssh "$REMOTE" "mkdir -p /etc/claude-proxy"
  scp -q "$TMUX_CONF" "$REMOTE:/etc/claude-proxy/tmux.conf"
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${YELLOW}SKIPPED${NC} ${GRAY}(tmux.conf not found)${NC}"
fi

# Test: create and destroy a tmux session
echo -n "  [6/6] tmux test... "
TEST_SESSION="cp-setup-test-$$"
if ssh "$REMOTE" "tmux new-session -d -s $TEST_SESSION 'sleep 5' && tmux has-session -t $TEST_SESSION && tmux kill-session -t $TEST_SESSION" &>/dev/null; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}FAILED${NC} — tmux session creation failed on $REMOTE"
  exit 1
fi

echo ""
echo -e "  ${GREEN}Remote $REMOTE is ready for claude-proxy sessions!${NC}"
echo ""
echo "  Make sure it's in your claude-proxy.yaml:"
echo ""
echo "  remotes:"
echo "    - name: $REMOTE"
echo "      host: $REMOTE"
echo ""
