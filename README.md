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
openclaw plugins update sync-claw-cloud
```

You can preview an update first:

```bash
openclaw plugins update sync-claw-cloud --dry-run
```

Reinstalling the latest published package also works:

```bash
openclaw plugins install sync-claw-cloud@latest
```

If you want a specific published version:

```bash
openclaw plugins install sync-claw-cloud@1.1.0-beta.12
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

## Hermes state sync

Profile sync treats the shared PostgreSQL database as a portable Hermes state layer, not only a memory table. To share information across several computers, configure every computer with the same PostgreSQL database credentials and a different `OPENCLAW_SOURCE_NODE`.

By default it syncs:

- Hermes `~/.hermes/hermes-agent/AGENTS.md`
- sanitized Hermes `~/.hermes/config.yaml` snapshots
- Hermes skills under `~/.hermes/skills/**/SKILL.md`
- Hermes plugin source/config files under `~/.hermes/plugins` and `~/.hermes/hermes-agent/plugins`

Commands:

```bash
openclaw sync-claw-cloud profile-sync status
openclaw sync-claw-cloud profile-sync sync
openclaw sync-claw-cloud profile-sync hermes-status
openclaw sync-claw-cloud profile-sync hermes-sync
```

The `hermes-*` commands are aliases for the same PostgreSQL-backed profile sync flow, provided so Hermes setup scripts can call an explicit Hermes command name.

Skill and plugin files use local-first snapshot semantics: remote files can restore missing local files, but an existing local variant is not overwritten by another computer. Live Hermes config files are stored as sanitized snapshots under `~/.openclaw/workspace/profile-sync/` instead of being written directly over local machine config.

Optional profile sync config:

```json
{
  "profileSync": {
    "includeHermes": true,
    "includeHermesPlugins": true,
    "skillRoots": ["/path/to/extra/skills"],
    "pluginRoots": ["/path/to/extra/plugins"],
    "configFiles": ["~/.hermes/config.yaml"]
  }
}
```

## Hermes agent usage

The package includes a Hermes memory bridge under `hermes_plugins/memory/sync_claw_cloud`. Install or refresh it with:

```bash
openclaw sync-claw-cloud hermes install-bridge
```

That command copies the packaged bridge into:

```bash
~/.hermes/hermes-agent/plugins/memory/sync_claw_cloud
```

Then set Hermes to use this provider in `~/.hermes/config.yaml`:

```yaml
memory:
  provider: sync_claw_cloud
```

If the Hermes gateway is already running, restart it so the updated bridge is loaded:

```bash
hermes gateway --accept-hooks restart
```

Basic verification:

```bash
hermes memory status
openclaw sync-claw-cloud profile-sync hermes-status
openclaw sync-claw-cloud profile-sync hermes-sync
```

When the npm package is updated later, refresh both the OpenClaw plugin and the Hermes bridge:

```bash
openclaw plugins update sync-claw-cloud
openclaw sync-claw-cloud hermes update-bridge
hermes gateway --accept-hooks restart
```

## Another MacBook

On another MacBook:

```bash
openclaw plugins install sync-claw-cloud
cp ~/.openclaw/extensions/sync-claw-cloud/.env.sync-claw-cloud.example ~/.openclaw/.env
```

Edit `~/.openclaw/.env` so it points at the same PostgreSQL database as the first computer, then set a unique source node, for example:

```bash
OPENCLAW_SOURCE_NODE=Kit-Macbook
```

Then validate and sync:

```bash
openclaw config validate
openclaw sync-claw-cloud hermes install-bridge
openclaw sync-claw-cloud profile-sync hermes-sync
hermes memory status
hermes gateway --accept-hooks restart
```
