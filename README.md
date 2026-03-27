# sync-claw-cloud

`sync-claw-cloud` is an OpenClaw memory plugin refocused on PostgreSQL as the primary shared memory backend.

This repository is source-first and is installed manually into OpenClaw.

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

## Install from source

### 1. Clone the repository

```bash
git clone https://github.com/hanjinye/sync-claw-cloud.git
cd sync-claw-cloud
npm install
```

### 2. Copy the environment file to the OpenClaw env directory

OpenClaw reads environment variables from `~/.openclaw/.env`.

Use the example in this repository as the starting point:

```bash
cp .env.sync-claw-cloud.example ~/.openclaw/.env
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
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-4B
EMBEDDING_BASE_URL=https://your-openai-compatible-endpoint/v1
EMBEDDING_DIMENSIONS=2560
```

### 3. Bootstrap PostgreSQL

The database must have `vector` available. This project is designed around PostgreSQL plus `pgvector`, and can also use `pg_search` when available.

Bootstrap manually:

```bash
bash scripts/init-postgres.sh
```

The SQL bootstrap creates the schema/table/indexes used by the plugin. For 2560-dimension embeddings it creates a `halfvec` HNSW index and the runtime query path reranks with the original full-precision vector.

### 4. Register the plugin in OpenClaw

Update `~/.openclaw/openclaw.json` so OpenClaw loads the repository path and uses `sync-claw-cloud` as the memory slot:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/sync-claw-cloud"
      ]
    },
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
            "dimensions": 2560
          },
          "autoCapture": true,
          "autoRecall": true,
          "smartExtraction": true
        }
      }
    }
  }
}
```

### 5. Validate and test

```bash
openclaw config validate
openclaw plugins info sync-claw-cloud
openclaw sync-claw-cloud stats
```

Optional repository tests:

```bash
node --test test/postgres-config.test.mjs
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
