#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
AGENT_PID_FILE="$PROJECT_DIR/workspace/agent.pid"

read_running_agent_pid() {
  local pid_file="${1:-$AGENT_PID_FILE}"
  local pid=""
  [ -f "$pid_file" ] || return 1
  IFS= read -r pid < "$pid_file" || return 1
  [[ "$pid" =~ ^[0-9]{1,10}$ ]] || return 1
  [ "$pid" -gt 1 ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s\n' "$pid"
}

open_agent_terminal() {
  local command=""
  printf -v command "cd %q && echo %q && exec caffeinate -i -s node workspace/agent.js" \
    "$PROJECT_DIR" "[start] Starte nemoclaw Agent..."
  osascript \
    -e 'on run argv' \
    -e 'tell application "Terminal" to do script (item 1 of argv)' \
    -e 'end run' \
    "$command" >/dev/null
}

if [ "${NEMOCLAW_SERVICE:-}" = "launchd" ]; then
  echo "[start] Die alte launchd-Integration wurde entfernt; Start nur über 'npm start'."
  exit 0
fi

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

if existing_pid="$(read_running_agent_pid)"; then
  echo "[start] Agent läuft bereits (PID $existing_pid)."
  exit 0
fi

echo "[start] Starte nemoclaw Agent im eigenen Terminal..."
if ! open_agent_terminal; then
  echo "[start] Terminal konnte nicht geöffnet werden. Prüfe die macOS-Automationsfreigabe." >&2
  exit 1
fi
echo "[start] Terminal-Fenster geöffnet."
