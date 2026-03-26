#!/usr/bin/env bash
set -euo pipefail

PSQL_BIN="${SYNC_CLAW_CLOUD_PSQL_PATH:-psql}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="${SCRIPT_DIR}/init-postgres.sql"

if [[ -n "${SYNC_CLAW_CLOUD_DATABASE_URL:-}" ]]; then
  exec "${PSQL_BIN}" "${SYNC_CLAW_CLOUD_DATABASE_URL}" -f "${SQL_FILE}"
fi

exec "${PSQL_BIN}" \
  -h "${SYNC_CLAW_CLOUD_PGHOST:-${POSTGRES_HOST:-${PGHOST:-localhost}}}" \
  -p "${SYNC_CLAW_CLOUD_PGPORT:-${POSTGRES_PORT:-${PGPORT:-5432}}}" \
  -U "${SYNC_CLAW_CLOUD_PGUSER:-${POSTGRES_USER:-${PGUSER:-postgres}}}" \
  -d "${SYNC_CLAW_CLOUD_PGDATABASE:-${POSTGRES_DB:-${PGDATABASE:-postgres}}}" \
  -f "${SQL_FILE}"
