#!/bin/bash
# Remote launcher for claude-proxy sessions
# Checks for claude, prompts to install/update, then launches
# Arguments are passed through to claude

HOSTNAME=$(hostname)
CLAUDE_ARGS="$@"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

# Find claude binary
find_claude() {
  command -v claude 2>/dev/null && return
  for p in ~/.local/bin/claude /usr/local/bin/claude ~/.npm-global/bin/claude; do
    [ -x "$p" ] && echo "$p" && return
  done
  return 1
}

# Check if claude is functional
check_claude() {
  local bin="$1"
  "$bin" --version >/dev/null 2>&1
}

# Get installed version
get_version() {
  local bin="$1"
  "$bin" --version 2>/dev/null | head -1 | grep -oP '[\d]+\.[\d]+\.[\d]+'
}

# Get latest available version
get_latest_version() {
  if command -v curl >/dev/null 2>&1; then
    curl -sL "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest/manifest.json" 2>/dev/null | grep -oP '"version"\s*:\s*"\K[^"]+'
  fi
}

# Prompt user with default
ask() {
  local prompt="$1"
  local default="$2"
  local reply
  echo -ne "$prompt"
  read -r reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

CLAUDE_BIN=$(find_claude)

if [ -z "$CLAUDE_BIN" ]; then
  # Not installed
  echo ""
  echo -e "  ${YELLOW}Claude Code is not installed on ${CYAN}${HOSTNAME}${NC}"
  echo ""
  echo -e "  ${BOLD}Install now?${NC}"
  echo -e "    Method:    ${GRAY}curl -sL https://claude.ai/install.sh | bash${NC}"
  echo -e "    Location:  ${GRAY}~/.local/share/claude/${NC}"
  echo -e "    User:      ${GRAY}$(whoami)${NC}"
  echo -e "    Self-updating: ${GREEN}yes${NC}"
  echo ""
  if ask "  [Y/n]: " "Y"; then
    echo ""
    curl -sL https://claude.ai/install.sh | bash
    echo ""
    # Re-find after install
    export PATH="$HOME/.local/bin:$PATH"
    CLAUDE_BIN=$(find_claude)
    if [ -z "$CLAUDE_BIN" ]; then
      echo -e "  ${RED}Installation failed. Claude not found after install.${NC}"
      echo ""
      echo "  Press Enter to exit..."
      read
      exit 1
    fi
    echo -e "  ${GREEN}Installed successfully.${NC}"
    echo ""
  else
    echo ""
    echo "  Cancelled. Press Enter to return to lobby..."
    read
    exit 1
  fi
elif ! check_claude "$CLAUDE_BIN"; then
  # Installed but broken
  echo ""
  echo -e "  ${RED}Claude Code appears to be corrupt on ${CYAN}${HOSTNAME}${NC}"
  echo -e "  ${GRAY}(${CLAUDE_BIN} exists but fails to run)${NC}"
  echo ""
  echo -e "  ${BOLD}Reinstall now?${NC}"
  echo -e "    Method:    ${GRAY}curl -sL https://claude.ai/install.sh | bash${NC}"
  echo -e "    Location:  ${GRAY}~/.local/share/claude/${NC}"
  echo -e "    User:      ${GRAY}$(whoami)${NC}"
  echo -e "    Self-updating: ${GREEN}yes${NC}"
  echo ""
  if ask "  [Y/n]: " "Y"; then
    echo ""
    curl -sL https://claude.ai/install.sh | bash
    echo ""
    export PATH="$HOME/.local/bin:$PATH"
    CLAUDE_BIN=$(find_claude)
    if [ -z "$CLAUDE_BIN" ] || ! check_claude "$CLAUDE_BIN"; then
      echo -e "  ${RED}Reinstallation failed.${NC}"
      echo ""
      echo "  Press Enter to exit..."
      read
      exit 1
    fi
    echo -e "  ${GREEN}Reinstalled successfully.${NC}"
    echo ""
  else
    echo ""
    echo "  Cancelled. Press Enter to return to lobby..."
    read
    exit 1
  fi
else
  # Claude works — check for updates
  INSTALLED=$(get_version "$CLAUDE_BIN")
  LATEST=$(get_latest_version)

  if [ -n "$LATEST" ] && [ -n "$INSTALLED" ] && [ "$INSTALLED" != "$LATEST" ]; then
    echo ""
    echo -e "  Claude Code ${BOLD}v${INSTALLED}${NC} is installed on ${CYAN}${HOSTNAME}${NC}"
    echo -e "  Version ${GREEN}v${LATEST}${NC} is available."
    echo ""
    if ask "  Update now? [Y/n]: " "Y"; then
      echo ""
      if ! "$CLAUDE_BIN" update 2>&1; then
        echo ""
        echo -e "  ${YELLOW}Update failed. Attempting full reinstall...${NC}"
        echo ""
        curl -sL https://claude.ai/install.sh | bash
      fi
      echo ""
      # Re-find in case path changed
      export PATH="$HOME/.local/bin:$PATH"
      CLAUDE_BIN=$(find_claude)
    fi
  fi
fi

# Launch claude — apply cd and su from wrapper env vars
CD_PREFIX=""
if [ -n "$CLAUDE_PROXY_CD" ]; then
  CD_PREFIX="mkdir -p '$CLAUDE_PROXY_CD' && cd '$CLAUDE_PROXY_CD' && "
fi

if [ -n "$CLAUDE_PROXY_USER" ]; then
  exec su -l "$CLAUDE_PROXY_USER" -c "${CD_PREFIX}\"$CLAUDE_BIN\" $CLAUDE_ARGS"
else
  if [ -n "$CLAUDE_PROXY_CD" ]; then
    mkdir -p "$CLAUDE_PROXY_CD" && cd "$CLAUDE_PROXY_CD"
  fi
  exec "$CLAUDE_BIN" $CLAUDE_ARGS
fi
