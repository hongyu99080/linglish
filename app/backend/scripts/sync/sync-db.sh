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
LOCAL_DB_URL="${LOCAL_DB_URL:-}"
REMOTE_DB_URL="${REMOTE_DB_URL:-}"
TABLES_FILE="${SYNC_TABLES_FILE:-$SCRIPT_DIR/db-tables.txt}"
STATE_DIR="${SYNC_STATE_DIR:-$SCRIPT_DIR/.sync-state}"
SKEW_SEC="${SYNC_SKEW_SEC:-5}"

if [[ -z "$LOCAL_DB_URL" || -z "$REMOTE_DB_URL" ]]; then
  echo "[sync-db] LOCAL_DB_URL and REMOTE_DB_URL are required" >&2
  exit 1
fi
if [[ ! -f "$TABLES_FILE" ]]; then
  echo "[sync-db] tables file not found: $TABLES_FILE" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"

if ! command -v psql >/dev/null 2>&1; then
  echo "[sync-db] psql not found in PATH" >&2
  exit 1
fi

MODE="${1:-}"
if [[ "$MODE" != "push" && "$MODE" != "pull" && "$MODE" != "both" ]]; then
  echo "Usage: $0 push|pull|both" >&2
  exit 1
fi

log() {
  echo "[sync-db][$ROLE] $*"
}

psql_query() {
  local db_url="$1"
  local sql="$2"
  psql "$db_url" -v ON_ERROR_STOP=1 -Atc "$sql"
}

get_pk_column() {
  local db_url="$1"
  local table="$2"
  local pk_cols
  pk_cols=$(psql_query "$db_url" "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'public.${table}'::regclass AND i.indisprimary ORDER BY a.attnum;")
  local count
  count=$(echo "$pk_cols" | sed '/^$/d' | wc -l | tr -d ' ')
  if [[ "$count" != "1" ]]; then
    echo ""
    return
  fi
  echo "$pk_cols" | head -n 1
}

has_updated_at() {
  local db_url="$1"
  local table="$2"
  local hit
  hit=$(psql_query "$db_url" "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND column_name='updated_at' LIMIT 1;")
  [[ "$hit" == "1" ]]
}

get_columns_csv() {
  local db_url="$1"
  local table="$2"
  psql_query "$db_url" "SELECT string_agg(quote_ident(column_name), ',') FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' ORDER BY ordinal_position;"
}

get_update_set_clause() {
  local db_url="$1"
  local table="$2"
  local pk_col="$3"
  psql_query "$db_url" "SELECT string_agg(format('%s=EXCLUDED.%s', quote_ident(column_name), quote_ident(column_name)), ',') FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND column_name <> '${pk_col}' ORDER BY ordinal_position;"
}

sync_one_direction() {
  local src_db="$1"
  local dst_db="$2"
  local direction="$3"

  while IFS= read -r table; do
    table="${table%%#*}"
    table="${table//[[:space:]]/}"
    [[ -z "$table" ]] && continue

    local pk_col
    pk_col=$(get_pk_column "$src_db" "$table")
    if [[ -z "$pk_col" ]]; then
      log "Skip $table: primary key not found or not single-column"
      continue
    fi
    if ! has_updated_at "$src_db" "$table"; then
      log "Skip $table: updated_at not found"
      continue
    fi

    local state_file="$STATE_DIR/${direction}_${table}.txt"
    local last_sync="1970-01-01 00:00:00+00"
    if [[ -f "$state_file" ]]; then
      last_sync=$(cat "$state_file")
    fi

    local sync_time
    sync_time=$(psql_query "$src_db" "SELECT NOW();")

    local tmp_file
    tmp_file="$STATE_DIR/${direction}_${table}_$(date +%s).csv"

    log "${direction} $table: exporting changes since $last_sync"
    psql "$src_db" -v ON_ERROR_STOP=1 -c "COPY (SELECT * FROM ${table} WHERE updated_at > ('${last_sync}'::timestamptz - INTERVAL '${SKEW_SEC} seconds')) TO STDOUT WITH CSV HEADER" > "$tmp_file"

    local line_count
    line_count=$(wc -l < "$tmp_file" | tr -d ' ')
    if [[ "$line_count" -le 1 ]]; then
      rm -f "$tmp_file"
      echo "$sync_time" > "$state_file"
      log "${direction} $table: no changes"
      continue
    fi

    local cols
    cols=$(get_columns_csv "$dst_db" "$table")
    local set_clause
    set_clause=$(get_update_set_clause "$dst_db" "$table" "$pk_col")

    log "${direction} $table: importing $((line_count - 1)) rows"
    psql "$dst_db" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
CREATE TEMP TABLE sync_tmp_${table} (LIKE ${table} INCLUDING DEFAULTS);
\\copy sync_tmp_${table} FROM '${tmp_file}' WITH CSV HEADER
INSERT INTO ${table} (${cols})
SELECT ${cols} FROM sync_tmp_${table}
ON CONFLICT (${pk_col}) DO UPDATE
SET ${set_clause}
WHERE ${table}.updated_at IS NULL OR EXCLUDED.updated_at > ${table}.updated_at;
COMMIT;
SQL

    rm -f "$tmp_file"
    echo "$sync_time" > "$state_file"
    log "${direction} $table: done"
  done < "$TABLES_FILE"
}

if [[ "$MODE" == "push" || "$MODE" == "both" ]]; then
  sync_one_direction "$LOCAL_DB_URL" "$REMOTE_DB_URL" "push"
fi
if [[ "$MODE" == "pull" || "$MODE" == "both" ]]; then
  sync_one_direction "$REMOTE_DB_URL" "$LOCAL_DB_URL" "pull"
fi
