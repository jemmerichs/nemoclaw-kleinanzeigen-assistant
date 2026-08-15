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

# Als launchd-Dienst ein sichtbares Terminal-Fenster öffnen, das die Logs
# live anzeigt. Der Agent selbst läuft weiter als Hintergrundprozess, sodass
# das Schließen des Fensters den Bot nicht stoppt.
if [ "${NEMOCLAW_SERVICE:-}" = "launchd" ]; then
  LOG_DIR="$PROJECT_DIR/workspace/logs"
  osascript -e "tell application \"Terminal\" to do script \"tail -f '$LOG_DIR/launchd.stdout.log' '$LOG_DIR/launchd.stderr.log'\"" >/dev/null 2>&1 || true
fi

echo "[start] Starte nemoclaw Agent..."
# caffeinate hält den Mac wach, solange der Agent läuft, damit der Bot nicht
# durch Idle-Sleep nach kurzer Zeit stoppt. -i verhindert Idle-Sleep, -s
# verhindert System-Sleep am Netzteil. Der Prozess endet mit dem Agent.
exec caffeinate -i -s node workspace/agent.js
