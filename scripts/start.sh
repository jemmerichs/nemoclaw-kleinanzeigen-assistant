#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

export DOCKER_HOST="unix://$HOME/Library/Containers/com.docker.docker/Data/docker-cli.sock"
export PATH="$HOME/.nemoclaw-bin:$PATH"

# Verify .env exists
if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "[start] FEHLER: .env nicht gefunden. Kopiere .env.example und trage Zugangsdaten ein."
  exit 1
fi

# Set network policy if openshell is available
if command -v openshell &>/dev/null; then
  echo "[start] Setze Netzwerk-Policy..."
  openshell policy set "$PROJECT_DIR/policies/kleinanzeigen-network.yaml"
fi

echo "[start] Starte nemoclaw Agent..."
cd "$PROJECT_DIR"
nemoclaw connect
