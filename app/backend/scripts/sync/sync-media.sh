#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SYNC_ENV_FILE:-$SCRIPT_DIR/sync.env}"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

ROLE="${SYNC_ROLE:-unknown}"
RCLONE_SRC="${RCLONE_SRC:-}"
RCLONE_DST="${RCLONE_DST:-}"
RCLONE_RESYNC="${RCLONE_RESYNC:-false}"
RCLONE_FLAGS="${RCLONE_FLAGS:-}"
STATE_DIR="${SYNC_STATE_DIR:-$SCRIPT_DIR/.sync-state}"

if [[ -z "$RCLONE_SRC" || -z "$RCLONE_DST" ]]; then
  echo "[sync-media] RCLONE_SRC and RCLONE_DST are required" >&2
  exit 1
fi

if ! command -v rclone >/dev/null 2>&1; then
  echo "[sync-media] rclone not found in PATH" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
LOCK_FILE="$STATE_DIR/rclone-bisync.lock"

log() {
  echo "[sync-media][$ROLE] $*"
}

RESYNC_FLAG=""
if [[ "$RCLONE_RESYNC" == "true" ]]; then
  RESYNC_FLAG="--resync"
fi

log "bisync ${RCLONE_SRC} <-> ${RCLONE_DST}"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another bisync is running, exiting"
  exit 0
fi

rclone bisync "$RCLONE_SRC" "$RCLONE_DST" \
  --create-empty-src-dirs \
  --compare size,modtime \
  --check-access \
  $RESYNC_FLAG \
  $RCLONE_FLAGS
