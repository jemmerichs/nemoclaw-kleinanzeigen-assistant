#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "[start] .env fehlt. Führe zuerst 'npm run setup' aus."
  exit 1
fi

cd "$PROJECT_DIR"
node scripts/doctor.js --telegram

if command -v openshell >/dev/null 2>&1; then
  echo "[start] Setze Netzwerk-Policy..."
  openshell policy set "$PROJECT_DIR/policies/kleinanzeigen-network.yaml"
fi

if [ "${NEMOCLAW_SERVICE:-}" = "launchd" ]; then
  osascript -e "tell application \"Terminal\" to do script \"cd '$PROJECT_DIR' && exec caffeinate -i -s node workspace/agent.js\"" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    pgrep -f "workspace/agent.js" >/dev/null 2>&1 && break
    sleep 1
  done
  while pgrep -f "workspace/agent.js" >/dev/null 2>&1; do
    sleep 3
  done
  exit 0
fi

echo "[start] Starte nemoclaw Agent im eigenen Terminal..."
osascript -e "tell application \"Terminal\" to do script \"cd '$PROJECT_DIR' && echo '[start] Starte nemoclaw Agent...' && exec caffeinate -i -s node workspace/agent.js\"" >/dev/null 2>&1
echo "[start] Terminal-Fenster geöffnet."
