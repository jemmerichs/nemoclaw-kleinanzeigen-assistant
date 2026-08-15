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
  exec osascript \
    -e "tell application \"Terminal\"" \
    -e "  activate" \
    -e "  set t to do script \"cd '$PROJECT_DIR' && exec caffeinate -i -s node workspace/agent.js\"" \
    -e "  repeat" \
    -e "    delay 3" \
    -e "    try" \
    -e "      get t" \
    -e "    on error" \
    -e "      exit repeat" \
    -e "    end try" \
    -e "  end repeat" \
    -e "end tell"
fi

echo "[start] Starte nemoclaw Agent..."
exec caffeinate -i -s node workspace/agent.js
