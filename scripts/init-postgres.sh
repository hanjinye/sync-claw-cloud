#!/usr/bin/env bash
set -euo pipefail

PSQL_BIN="${SYNC_CLAW_CLOUD_PSQL_PATH:-psql}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SQL_FILE="${SCRIPT_DIR}/init-postgres.sql"
BOOTSTRAP_NODE_SCRIPT="${SCRIPT_DIR}/bootstrap-db.mjs"
LOCAL_ENV_FILE="${ROOT_DIR}/.env"
HERMES_ENV_FILE="${HERMES_HOME:-$HOME/.hermes}/sync-claw-cloud.env"
PG_SCHEMA="${SYNC_CLAW_CLOUD_PGSCHEMA:-${POSTGRES_SCHEMA:-sync_claw_cloud}}"

load_env_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    return
  fi
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
}

load_env_file "${LOCAL_ENV_FILE}"
load_env_file "${HERMES_ENV_FILE}"
PG_SCHEMA="${SYNC_CLAW_CLOUD_PGSCHEMA:-${POSTGRES_SCHEMA:-sync_claw_cloud}}"

if ! command -v "${PSQL_BIN}" >/dev/null 2>&1; then
  exec node "${BOOTSTRAP_NODE_SCRIPT}"
fi

if [[ ! "$PG_SCHEMA" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "Invalid PostgreSQL schema name: $PG_SCHEMA" >&2
  exit 1
fi

RENDERED_SQL="$(mktemp)"
trap 'rm -f "$RENDERED_SQL"' EXIT
sed "s/__SYNC_SCHEMA__/${PG_SCHEMA}/g" "${SQL_FILE}" > "${RENDERED_SQL}"

if [[ -n "${SYNC_CLAW_CLOUD_DATABASE_URL:-}" ]]; then
  exec "${PSQL_BIN}" "${SYNC_CLAW_CLOUD_DATABASE_URL}" -f "${RENDERED_SQL}"
fi

exec "${PSQL_BIN}" \
  -h "${SYNC_CLAW_CLOUD_PGHOST:-${POSTGRES_HOST:-${PGHOST:-localhost}}}" \
  -p "${SYNC_CLAW_CLOUD_PGPORT:-${POSTGRES_PORT:-${PGPORT:-5432}}}" \
  -U "${SYNC_CLAW_CLOUD_PGUSER:-${POSTGRES_USER:-${PGUSER:-postgres}}}" \
  -d "${SYNC_CLAW_CLOUD_PGDATABASE:-${POSTGRES_DB:-${PGDATABASE:-postgres}}}" \
  -f "${RENDERED_SQL}"
