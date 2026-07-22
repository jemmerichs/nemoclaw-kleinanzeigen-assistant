#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "[start] .env fehlt. Führe zuerst 'npm run setup' aus."
  exit 1
fi

if command -v openshell >/dev/null 2>&1; then
  echo "[start] Setze Netzwerk-Policy..."
  openshell policy set "$PROJECT_DIR/policies/kleinanzeigen-network.yaml"
fi

echo "[start] Starte nemoclaw Agent..."
cd "$PROJECT_DIR"
exec node workspace/agent.js
