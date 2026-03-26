#!/usr/bin/env bash
set -euo pipefail

# Non-destructive smoke test for a real OpenClaw environment where the plugin is installed.
# Intended for release preflight and on-host validation.

openclaw sync-claw-cloud version
openclaw sync-claw-cloud stats
openclaw sync-claw-cloud list --limit 3
openclaw sync-claw-cloud search "plugin" --limit 3

# export/import (dry-run)
TMP_JSON="/tmp/sync-claw-cloud-export.json"
openclaw sync-claw-cloud export --scope global --category decision --output "$TMP_JSON"
openclaw sync-claw-cloud import --dry-run "$TMP_JSON"

# delete commands (dry-run/help only)
openclaw sync-claw-cloud delete --help >/dev/null
openclaw sync-claw-cloud delete-bulk --scope global --before 1900-01-01 --dry-run

# migrate (read-only)
openclaw sync-claw-cloud migrate check

# reembed (dry-run). Adjust source-db path if needed.
if [[ -d "$HOME/.openclaw/memory/lancedb-pro" ]]; then
  openclaw sync-claw-cloud reembed --source-db "$HOME/.openclaw/memory/lancedb-pro" --limit 1 --dry-run
else
  echo "NOTE: $HOME/.openclaw/memory/lancedb-pro not found; skipping reembed smoke."
fi

echo "OK: openclaw smoke suite passed"
