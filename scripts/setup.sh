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
  echo "[setup] .env wurde angelegt. Trage mindestens den OpenRouter-Key ein; Telegram ist optional."
fi
chmod 600 .env

if [ "$(uname -s)" = "Darwin" ]; then
  if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
    echo "[setup] Google Chrome gefunden."
  else
    echo "[setup] Hinweis: Google Chrome fehlt; der Kleinanzeigen-Login benötigt Chrome."
  fi
fi

echo "[setup] Fertig. Reihenfolge: npm run doctor | npm run login | npm run verify:account | npm run chat"
