# sync-claw-cloud

`sync-claw-cloud` is a Hermes memory bridge backed by PostgreSQL.

It is designed for one goal: let multiple Hermes machines share the same long-term memory through one PostgreSQL database, while keeping Hermes-side installation and updates simple.

## What it includes

- A Hermes memory provider: `sync_claw_cloud`
- Hybrid retrieval in the bridge: vector + BM25 + decay + noise filtering
- PostgreSQL bootstrap and schema migration SQL
- Hermes install tooling for both `npm` and source checkout workflows

## Configuration model

Runtime configuration is read from:

```text
~/.hermes/sync-claw-cloud.env
```

This file holds:

- PostgreSQL connection info
- embedding `BASE_URL`
- embedding `MODEL`
- embedding `API_KEY`
- the shared schema/table names
- a unique `OPENCLAW_SOURCE_NODE` per machine

The provider also reads `~/.hermes/.env` and process environment as fallback, but `~/.hermes/sync-claw-cloud.env` is the recommended primary config file.

## Option A: npm install (recommended)

If you do not want to clone the repository, use the published package directly:

```bash
npm install -g sync-claw-cloud
sync-claw-cloud setup
```

You can also use `npx` without a global install:

```bash
npx sync-claw-cloud@latest setup
```

That command will:

- install the Hermes bridge into `~/.hermes/hermes-agent/plugins/memory/sync_claw_cloud`
- create `~/.hermes/sync-claw-cloud.env.example`
- create `~/.hermes/sync-claw-cloud.env` if it does not already exist

Then edit:

```text
~/.hermes/sync-claw-cloud.env
```

and fill in the real values.

Bootstrap or upgrade the database schema:

```bash
sync-claw-cloud bootstrap-db
```

Enable the provider in:

```text
~/.hermes/config.yaml
```

with:

```yaml
memory:
  provider: sync_claw_cloud
```

If Hermes is already running:

```bash
hermes gateway --accept-hooks restart
hermes memory status
```

## Option B: source install

If you want to work from a checked-out repository:

```bash
git clone https://github.com/hanjinye/sync-claw-cloud.git
cd sync-claw-cloud
cp .env.sync-claw-cloud.example .env
```

Then edit:

```text
./.env
```

and fill in the real values.

Install the Hermes bridge and copy that config into the Hermes runtime location:

```bash
bash scripts/install-hermes-bridge.sh --env-file .env
```

Bootstrap or upgrade the database schema:

```bash
bash scripts/init-postgres.sh
```

Enable the provider in `~/.hermes/config.yaml`:

```yaml
memory:
  provider: sync_claw_cloud
```

Then restart and verify:

```bash
hermes gateway --accept-hooks restart
hermes memory status
```

## Required config fields

Example config file:

```dotenv
POSTGRES_HOST=your-postgres-host
POSTGRES_PORT=5432
POSTGRES_DB=sync_claw
POSTGRES_USER=your-postgres-user
POSTGRES_PASSWORD=your-postgres-password
POSTGRES_SCHEMA=sync_claw_cloud
POSTGRES_TABLE=memories
POSTGRES_SSLMODE=disable

EMBEDDING_API_KEY=your-embedding-api-key
EMBEDDING_BASE_URL=https://your-openai-compatible-endpoint/v1
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-4B
EMBEDDING_DIMENSIONS=2560

OPENCLAW_SOURCE_NODE=Kit-Macmini
```

Notes:

- `OPENCLAW_SOURCE_NODE` must be unique on every machine.
- `EMBEDDING_BASE_URL` and `EMBEDDING_MODEL` are still required unless your bridge will use the built-in Ollama fallback path.
- `EMBEDDING_DIMENSIONS=2560` matches the current PostgreSQL vector schema.
- `POSTGRES_TABLE` should stay at the default value `memories`.

## Database behavior

The bootstrap script is safe to run repeatedly:

```bash
bash scripts/init-postgres.sh
```

It will:

- create the schema only if missing
- create tables only if missing
- add missing columns with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
- create missing indexes with `CREATE INDEX IF NOT EXISTS`
- record schema state in a version table

Current schema metadata is stored in:

```text
sync_claw_cloud.schema_meta
```

This means:

- an existing user database is not recreated
- rerunning bootstrap after upgrades applies additive schema changes
- future schema upgrades can be tracked by version

## Updating

### npm workflow

```bash
npm install -g sync-claw-cloud@latest
sync-claw-cloud setup
sync-claw-cloud bootstrap-db
hermes gateway --accept-hooks restart
```

### source workflow

```bash
git pull --rebase
bash scripts/install-hermes-bridge.sh --env-file .env
bash scripts/init-postgres.sh
hermes gateway --accept-hooks restart
```

## Multi-machine sharing

To share memory with another MacBook:

1. Install `sync-claw-cloud` on the second machine using either workflow above.
2. Point it at the same PostgreSQL database.
3. Use a different `OPENCLAW_SOURCE_NODE`, for example:

```dotenv
OPENCLAW_SOURCE_NODE=Kit-Macbook
```

4. Restart Hermes on that machine:

```bash
hermes gateway --accept-hooks restart
hermes memory status
```

Once both machines point at the same PostgreSQL database, they share the same long-term memory backend.
