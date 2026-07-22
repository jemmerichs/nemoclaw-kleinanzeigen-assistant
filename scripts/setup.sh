#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if ! command -v node >/dev/null 2>&1; then
  echo "[setup] Node.js fehlt. Installiere Node.js 20 oder neuer und starte das Setup erneut."
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[setup] Node.js 20 oder neuer ist erforderlich (gefunden: $(node --version))."
  exit 1
fi

echo "[setup] Node $(node --version) / npm $(npm --version)"
cd "$PROJECT_DIR"
npm ci

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "[setup] .env wurde angelegt. Trage Telegram-Token und erlaubte Chat-ID ein."
fi

if command -v claude >/dev/null 2>&1; then
  echo "[setup] Claude CLI gefunden: $(command -v claude)"
else
  echo "[setup] WARNUNG: Claude CLI nicht in PATH. Setze CLAUDE_BIN in .env."
fi

echo "[setup] Fertig. Login: npm run login | Start: npm start"
