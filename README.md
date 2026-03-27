# sync-claw-cloud

`sync-claw-cloud` is an OpenClaw memory plugin refocused on PostgreSQL as the primary shared memory backend.

This package is intended to be installed into OpenClaw via npm-backed plugin installation.

## What it keeps

- PostgreSQL as the primary backend
- `pgvector` hybrid retrieval with optional lexical search
- `halfvec` HNSW support for 2560-dimension embeddings
- `openclaw sync-claw-cloud ...` CLI commands
- the local file-backed store implementation as a migration/reference path

## Main files

- [index.ts](/Users/kithan/workspace/qitian/sync_memery/index.ts)
- [cli.ts](/Users/kithan/workspace/qitian/sync_memery/cli.ts)
- [src/postgres-store.ts](/Users/kithan/workspace/qitian/sync_memery/src/postgres-store.ts)
- [src/postgres-config.ts](/Users/kithan/workspace/qitian/sync_memery/src/postgres-config.ts)
- [src/lancedb-store.ts](/Users/kithan/workspace/qitian/sync_memery/src/lancedb-store.ts)
- [scripts/init-postgres.sql](/Users/kithan/workspace/qitian/sync_memery/scripts/init-postgres.sql)

## Install from npm

On a fresh OpenClaw host:

```bash
openclaw plugins install sync-claw-cloud
```

OpenClaw will install the plugin under:

`~/.openclaw/extensions/sync-claw-cloud`

### 1. Configure environment variables

OpenClaw reads environment variables from `~/.openclaw/.env`.

Use this package's example env file as the starting point:

```bash
cp ~/.openclaw/extensions/sync-claw-cloud/.env.sync-claw-cloud.example ~/.openclaw/.env
```

Then edit `~/.openclaw/.env` and replace every placeholder with your own values.

Required variables:

```bash
POSTGRES_HOST=your-postgres-host
POSTGRES_PORT=5432
POSTGRES_DB=sync_claw
POSTGRES_USER=your-postgres-user
POSTGRES_PASSWORD=your-postgres-password
POSTGRES_SCHEMA=sync_claw_cloud
POSTGRES_TABLE=memories
POSTGRES_SSLMODE=disable

EMBEDDING_API_KEY=your-embedding-api-key
EMBEDDING_BASE_URL=https://llm.qitian.ltd/v1
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-4B
EMBEDDING_DIMENSIONS=2560
```

These variables are referenced directly from the plugin config in `~/.openclaw/openclaw.json`.

### 2. Bootstrap PostgreSQL

The database must have `vector` available. This project is designed around PostgreSQL plus `pgvector`, and can also use `pg_search` when available.

Bootstrap manually:

```bash
bash ~/.openclaw/extensions/sync-claw-cloud/scripts/init-postgres.sh
```

The SQL bootstrap creates the schema/table/indexes used by the plugin. For 2560-dimension embeddings it creates a `halfvec` HNSW index and the runtime query path reranks with the original full-precision vector.

### 3. Configure OpenClaw

Update `~/.openclaw/openclaw.json` so OpenClaw enables `sync-claw-cloud` as the memory slot.

Config file location:

- OpenClaw config: `~/.openclaw/openclaw.json`
- OpenClaw env file: `~/.openclaw/.env`
- Installed plugin directory: `~/.openclaw/extensions/sync-claw-cloud`

Recommended minimal config:

```json
{
  "plugins": {
    "allow": [
      "sync-claw-cloud"
    ],
    "slots": {
      "memory": "sync-claw-cloud"
    },
    "entries": {
      "sync-claw-cloud": {
        "enabled": true,
        "config": {
          "dbPath": "${HOME}/.openclaw/memory/sync-claw-cloud",
          "postgres": {
            "host": "${POSTGRES_HOST}",
            "port": 5432,
            "database": "${POSTGRES_DB}",
            "user": "${POSTGRES_USER}",
            "password": "${POSTGRES_PASSWORD}",
            "schema": "${POSTGRES_SCHEMA}",
            "tableName": "${POSTGRES_TABLE}",
            "sslmode": "${POSTGRES_SSLMODE}",
            "initOnStart": true,
            "fallbackToLanceDb": false,
            "terminalFilterMode": "prefer",
            "clientFilterMode": "prefer"
          },
          "embedding": {
            "provider": "openai-compatible",
            "apiKey": "${EMBEDDING_API_KEY}",
            "baseURL": "${EMBEDDING_BASE_URL}",
            "model": "${EMBEDDING_MODEL}",
            "dimensions": "${EMBEDDING_DIMENSIONS}"
          },
          "autoCapture": true,
          "autoRecall": true,
          "smartExtraction": true,
          "enableManagementTools": true,
          "profileSync": {
            "enabled": true,
            "startupSync": true,
            "intervalMinutes": 1440
          }
        }
      }
    }
  }
}
```

If your OpenClaw config prefers numeric literals instead of env substitution for `dimensions`, set it to `2560`.

### 4. Validate and test

```bash
openclaw config validate
openclaw plugins info sync-claw-cloud
openclaw sync-claw-cloud stats
```

### 5. Update the plugin

```bash
openclaw plugins install sync-claw-cloud@latest
```

If you want a specific published version:

```bash
openclaw plugins install sync-claw-cloud@1.1.0-beta.11
```

## Publish to npm

From this repository:

```bash
npm pack --dry-run
npm publish --access public
```

After publishing, a fresh OpenClaw host can install the package with:

```bash
openclaw plugins install sync-claw-cloud
```

## Notes on legacy storage

This project still keeps a local file-backed store implementation as a functional reference during the PostgreSQL transition.

Today the intended primary backend is PostgreSQL. The local file-backed path remains in the repository for migration and fallback-oriented development, not as the default deployment target described in this README.

## Commands

Examples:

```bash
openclaw sync-claw-cloud stats
openclaw sync-claw-cloud list --scope global
openclaw sync-claw-cloud search "keyword" --scope global
openclaw sync-claw-cloud export --scope global --output memories.json
openclaw sync-claw-cloud import memories.json --scope global
```
