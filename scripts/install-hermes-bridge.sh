#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/hermes_plugins/memory/sync_claw_cloud"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
DST_DIR="$HERMES_HOME/hermes-agent/plugins/memory/sync_claw_cloud"

DRY_RUN="0"
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="1"
fi

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Source bridge directory not found: $SRC_DIR" >&2
  exit 1
fi

echo "Hermes home: $HERMES_HOME"
echo "Source: $SRC_DIR"
echo "Target: $DST_DIR"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] Would create: $DST_DIR"
  echo "[dry-run] Would copy: plugin.yaml"
  echo "[dry-run] Would copy: __init__.py"
  exit 0
fi

mkdir -p "$DST_DIR"
cp "$SRC_DIR/plugin.yaml" "$DST_DIR/plugin.yaml"
cp "$SRC_DIR/__init__.py" "$DST_DIR/__init__.py"

echo "Installed Hermes bridge successfully."
echo "Next: set memory.provider=sync_claw_cloud in ~/.hermes/config.yaml"
echo "Then restart gateway: hermes gateway --accept-hooks restart"
