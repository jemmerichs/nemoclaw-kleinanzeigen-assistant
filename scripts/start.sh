#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
AGENT_PID_FILE="$PROJECT_DIR/workspace/agent.pid"
SERVICE_START_REQUEST_FILE="$PROJECT_DIR/workspace/service-start.request"

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
  local announce="${1:-false}"
  local command=""
  if [ "$announce" = "true" ]; then
    printf -v command "cd %q && echo %q && exec caffeinate -i -s node workspace/agent.js" \
      "$PROJECT_DIR" "[start] Starte nemoclaw Agent..."
  else
    printf -v command "cd %q && exec caffeinate -i -s node workspace/agent.js" "$PROJECT_DIR"
  fi
  osascript \
    -e 'on run argv' \
    -e 'tell application "Terminal" to do script (item 1 of argv)' \
    -e 'end run' \
    "$command" >/dev/null
}

consume_manual_service_start_request() {
  local requested_at=""
  local now=""
  local age=""
  [ -f "$SERVICE_START_REQUEST_FILE" ] || return 1
  IFS= read -r requested_at < "$SERVICE_START_REQUEST_FILE" || true
  rm -f "$SERVICE_START_REQUEST_FILE"
  [[ "$requested_at" =~ ^[0-9]{1,10}$ ]] || return 1
  now="$(date +%s)"
  age=$((now - requested_at))
  [ "$age" -ge 0 ] && [ "$age" -le 120 ]
}

if [ "${NEMOCLAW_SERVICE:-}" = "launchd" ] && ! consume_manual_service_start_request; then
  echo "[start] Automatischer Start ist deaktiviert; Start nur über 'npm run service:restart'."
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

if [ "${NEMOCLAW_SERVICE:-}" = "launchd" ]; then
  if existing_pid="$(read_running_agent_pid)"; then
    echo "[start] Agent läuft bereits (PID $existing_pid); öffne kein zweites Terminal." >&2
    exit 1
  fi

  if ! open_agent_terminal false; then
    echo "[start] Terminal konnte nicht geöffnet werden. Prüfe die macOS-Automationsfreigabe." >&2
    exit 1
  fi

  agent_pid=""
  for _ in $(seq 1 30); do
    if agent_pid="$(read_running_agent_pid)"; then
      break
    fi
    sleep 1
  done

  if [ -z "$agent_pid" ]; then
    echo "[start] Agent hat innerhalb von 30 Sekunden keinen gültigen PID-Lock übernommen." >&2
    exit 1
  fi

  echo "[start] Agent läuft sichtbar (PID $agent_pid)."
  while current_pid="$(read_running_agent_pid)" && [ "$current_pid" = "$agent_pid" ]; do
    sleep 3
  done
  exit 0
fi

if existing_pid="$(read_running_agent_pid)"; then
  echo "[start] Agent läuft bereits (PID $existing_pid)."
  exit 0
fi

echo "[start] Starte nemoclaw Agent im eigenen Terminal..."
open_agent_terminal true
echo "[start] Terminal-Fenster geöffnet."
