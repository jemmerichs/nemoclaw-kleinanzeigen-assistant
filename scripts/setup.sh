#!/usr/bin/env bash
set -euo pipefail

export DOCKER_HOST="unix://$HOME/Library/Containers/com.docker.docker/Data/docker-cli.sock"

# ── Node / nvm guard ──────────────────────────────────────────────────────────
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh"
fi

if ! command -v node &>/dev/null; then
  echo "[setup] Node.js nicht gefunden. Installiere via nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  source "$NVM_DIR/nvm.sh"
  nvm install --lts
fi

echo "[setup] Node $(node --version) / npm $(npm --version)"

# ── claude CLI prüfen ────────────────────────────────────────────────────────
CLAUDE_BIN="/Users/$USER/Library/Application Support/Claude/claude-code/2.1.87/claude.app/Contents/MacOS/claude"
if [ -x "$CLAUDE_BIN" ]; then
  echo "[setup] claude CLI gefunden: $CLAUDE_BIN"
else
  echo "[setup] WARNUNG: claude CLI nicht gefunden. Stelle sicher dass Claude Desktop installiert ist."
fi

# ── nemoclaw shim ────────────────────────────────────────────────────────────
SHIM_DIR="$HOME/.nemoclaw-bin"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/nemoclaw" <<'SHIM'
#!/usr/bin/env bash
case "${1:-}" in
  connect)
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
    PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)/dev/nemoclaw-kleinanzeigen"
    ENV_FILE="$PROJECT_DIR/.env"
    if [ -f "$ENV_FILE" ]; then
      export $(grep -v '^#' "$ENV_FILE" | xargs)
    fi
    exec node "$PROJECT_DIR/workspace/agent.js"
    ;;
  *)
    echo "Usage: nemoclaw connect"
    ;;
esac
SHIM
chmod +x "$SHIM_DIR/nemoclaw"

# ── PATH & .zshrc ─────────────────────────────────────────────────────────────
SHELL_RC="$HOME/.zshrc"
[ -f "$SHELL_RC" ] || touch "$SHELL_RC"
if ! grep -q "nemoclaw-bin" "$SHELL_RC"; then
  echo 'export PATH="$HOME/.nemoclaw-bin:$PATH"' >> "$SHELL_RC"
fi
if ! grep -q "NVM_DIR" "$SHELL_RC"; then
  echo 'export NVM_DIR="$HOME/.nvm"' >> "$SHELL_RC"
  echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> "$SHELL_RC"
fi

# ── Projekt-Dependencies ──────────────────────────────────────────────────────
cd "$(dirname "$0")/.."
npm install

echo ""
echo "[setup] Fertig. Starte mit: bash scripts/start.sh"
