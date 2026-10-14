#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

DEFAULT_DB_URL="postgres://localhost:5432/linglish"

if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f .env ]; then
    dotenv_db=$(grep -E '^DATABASE_URL=' .env | tail -1 | cut -d '=' -f2-)
    if [ -n "${dotenv_db:-}" ]; then
      export DATABASE_URL="$dotenv_db"
    fi
  fi
fi

if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="$DEFAULT_DB_URL"
fi

if [ ! -d node_modules ]; then
  echo "[linglish] Installing backend dependencies..."
  npm install
fi

echo "[linglish] Database configuration loaded"
echo "[linglish] Starting server on http://localhost:${PORT:-4000}"

node server.js
