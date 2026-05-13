#!/usr/bin/env bash
# shmakk installer
# Usage: curl -fsSL https://raw.githubusercontent.com/marbad1994/shmakk/main/install.sh | bash

set -e

REPO="https://github.com/marbad1994/shmakk.git"
INSTALL_DIR="$HOME/.shmakk-install"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

ok()   { echo -e "${GREEN}✓${RESET} $1"; }
warn() { echo -e "${YELLOW}⚠${RESET} $1"; }
fail() { echo -e "${RED}✗${RESET} $1"; exit 1; }
info() { echo -e "  $1"; }

echo ""
echo -e "${GREEN}shmakk installer${RESET}"
echo "────────────────────────────────"

# ── Node.js ──────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install Node.js 18+ first: https://nodejs.org"
fi

NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js 18+ required (you have $NODE_VER)"
fi
ok "Node.js $NODE_VER"

# ── git ───────────────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  fail "git not found. Install git first."
fi
ok "git $(git --version | cut -d' ' -f3)"

# ── Clone or update ───────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  echo ""
  info "Updating existing installation..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo ""
  info "Cloning shmakk..."
  rm -rf "$INSTALL_DIR"
  git clone --depth=1 "$REPO" "$INSTALL_DIR"
fi
ok "source ready at $INSTALL_DIR"

# ── npm install ───────────────────────────────────────────────────────────────
echo ""
info "Installing dependencies..."
cd "$INSTALL_DIR"
npm install --no-fund --no-audit 2>&1 | grep -v "^npm warn" | grep -v "^$" || true
ok "dependencies installed"

# ── Link ──────────────────────────────────────────────────────────────────────
info "Linking shmakk to PATH..."
npm link --no-fund 2>/dev/null || {
  # Fallback: add bin directly to ~/.local/bin
  mkdir -p "$HOME/.local/bin"
  ln -sf "$INSTALL_DIR/bin/shmakk.js" "$HOME/.local/bin/shmakk"
  chmod +x "$INSTALL_DIR/bin/shmakk.js"
}
ok "shmakk linked"

# ── PATH check ───────────────────────────────────────────────────────────────
if ! command -v shmakk &>/dev/null; then
  warn "shmakk not in PATH yet. Add this to your ~/.bashrc or ~/.zshrc or config.fish:"
  info "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  info ""
  info "Then restart your terminal or run: source ~/.bashrc"
else
  ok "shmakk in PATH: $(which shmakk)"
fi

# ── .env setup ───────────────────────────────────────────────────────────────
if [ ! -f "$HOME/.shmakk.env" ]; then
  echo ""
  info "Creating config at ~/.shmakk.env ..."
  cat > "$HOME/.shmakk.env" << 'EOF'
# shmakk configuration
# Set your AI provider details here, then: source ~/.shmakk.env

export SHMAKK_BASE_URL="https://api.anthropic.com/v1"
export SHMAKK_API_KEY="your-api-key-here"
export SHMAKK_MODEL="claude-sonnet-4-20250514"

# Optional: voice settings
# export SHMAKK_TTS_VOICE=am_michael
# export SHMAKK_VOICE_LANGUAGE=en
EOF
  warn "Edit ~/.shmakk.env and add your API key, then: source ~/.shmakk.env"
else
  ok "~/.shmakk.env already exists"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}────────────────────────────────${RESET}"
echo -e "${GREEN}✓ shmakk installed!${RESET}"
echo ""
echo "  1. Add your API key:  nano ~/.shmakk.env"
echo "  2. Load it:           source ~/.shmakk.env"
echo "  3. Launch:            shmakk"
echo ""
echo "  Optional voice mode:"
echo "    sudo pacman -S sox        # Arch/EndeavourOS"
echo "    sudo apt install sox      # Debian/Ubuntu"
echo "    cd $INSTALL_DIR && npm run setup:voice"
echo ""
