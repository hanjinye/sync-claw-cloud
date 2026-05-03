# sync-claw-cloud (Hermes only)

`sync-claw-cloud` is a Hermes memory provider backed by PostgreSQL.  
This repository now documents and supports a Hermes-only workflow.

## What this gives you

- Shared long-term memory across multiple Hermes machines via one PostgreSQL database
- Hybrid retrieval signals in the bridge (BM25 + decay + noise filtering + vector fallback)
- Hermes bridge source under `hermes_plugins/memory/sync_claw_cloud`

## 1. Clone and prepare

```bash
git clone https://github.com/hanjinye/sync-claw-cloud.git
cd sync-claw-cloud
```

## 2. Configure database/env

Set env vars in your shell profile or launch environment:

```bash
POSTGRES_HOST=your-postgres-host
POSTGRES_PORT=5432
POSTGRES_DB=sync_claw
POSTGRES_USER=your-postgres-user
POSTGRES_PASSWORD=your-postgres-password
POSTGRES_SCHEMA=sync_claw_cloud
POSTGRES_TABLE=memories
POSTGRES_SSLMODE=disable
OPENCLAW_SOURCE_NODE=Kit-Macmini
```

`OPENCLAW_SOURCE_NODE` must be unique per machine.

## 3. Bootstrap PostgreSQL once

```bash
bash scripts/init-postgres.sh
```

## 4. Install Hermes bridge

```bash
bash scripts/install-hermes-bridge.sh
```

This installs files to:

```bash
~/.hermes/hermes-agent/plugins/memory/sync_claw_cloud
```

## 5. Enable provider in Hermes

Edit `~/.hermes/config.yaml`:

```yaml
memory:
  provider: sync_claw_cloud
```

Install runtime deps into Hermes venv if needed:

```bash
~/.hermes/hermes-agent/venv/bin/pip install psycopg2-binary requests
```

## 6. Restart and verify

```bash
hermes gateway --accept-hooks restart
hermes memory status
```

Expected: active provider is `sync_claw_cloud`.

## Update flow (no OpenClaw)

When this repo updates:

```bash
cd sync-claw-cloud
git pull --rebase
bash scripts/install-hermes-bridge.sh
hermes gateway --accept-hooks restart
```

## Another MacBook

Repeat the same steps on the second machine, pointing to the same PostgreSQL database and using a different node name:

```bash
OPENCLAW_SOURCE_NODE=Kit-Macbook
```

Then restart Hermes and run:

```bash
hermes memory status
```
