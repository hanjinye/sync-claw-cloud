#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/hermes_plugins/memory/sync_claw_cloud"
ENV_EXAMPLE="$ROOT_DIR/.env.sync-claw-cloud.example"
CONFIGURE_SCRIPT="$ROOT_DIR/scripts/configure-hermes-memory.mjs"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
DST_DIR="$HERMES_HOME/hermes-agent/plugins/memory/sync_claw_cloud"
HERMES_ENV="$HERMES_HOME/sync-claw-cloud.env"
HERMES_ENV_EXAMPLE="$HERMES_HOME/sync-claw-cloud.env.example"

DRY_RUN="0"
SOURCE_ENV=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    --env-file)
      SOURCE_ENV="${2:-}"
      if [[ -z "$SOURCE_ENV" ]]; then
        echo "--env-file requires a path" >&2
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Source bridge directory not found: $SRC_DIR" >&2
  exit 1
fi

echo "Hermes home: $HERMES_HOME"
echo "Source: $SRC_DIR"
echo "Target: $DST_DIR"
echo "Hermes env: $HERMES_ENV"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] Would create: $DST_DIR"
  echo "[dry-run] Would copy: plugin.yaml"
  echo "[dry-run] Would copy: __init__.py"
  echo "[dry-run] Would copy example env: $HERMES_ENV_EXAMPLE"
  echo "[dry-run] Would configure ~/.hermes/config.yaml memory.provider=sync_claw_cloud"
  if [[ -n "$SOURCE_ENV" ]]; then
    echo "[dry-run] Would install env from: $SOURCE_ENV -> $HERMES_ENV"
  else
    echo "[dry-run] Would create $HERMES_ENV from example if missing"
  fi
  exit 0
fi

mkdir -p "$DST_DIR"
cp "$SRC_DIR/plugin.yaml" "$DST_DIR/plugin.yaml"
cp "$SRC_DIR/__init__.py" "$DST_DIR/__init__.py"
cp "$ENV_EXAMPLE" "$HERMES_ENV_EXAMPLE"

if [[ -n "$SOURCE_ENV" ]]; then
  cp "$SOURCE_ENV" "$HERMES_ENV"
elif [[ ! -f "$HERMES_ENV" ]]; then
  cp "$ENV_EXAMPLE" "$HERMES_ENV"
fi

HERMES_HOME="$HERMES_HOME" node "$CONFIGURE_SCRIPT"

echo "Installed Hermes bridge successfully."
echo "Config file: $HERMES_ENV"
echo "Hermes config updated: $HERMES_HOME/config.yaml"
echo "Then restart gateway: hermes gateway --accept-hooks restart"
