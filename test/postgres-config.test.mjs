import test from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  getDefaultPostgresConfig,
  hasUsablePostgresConfig,
  resolvePostgresConfig,
} = jiti("../src/postgres-config.ts");
const { extractRuntimeDimensions } = jiti("../src/runtime-dimensions.ts");

test("resolvePostgresConfig prefers explicit values and env placeholders", () => {
  process.env.TEST_SYNC_CLAW_PGHOST = "db.internal";
  const config = resolvePostgresConfig({
    host: "${TEST_SYNC_CLAW_PGHOST}",
    database: "sync_claw_cloud",
    user: "postgres",
    schema: "custom_schema",
    tableName: "memory_rows",
  });

  assert.equal(config.host, "db.internal");
  assert.equal(config.database, "sync_claw_cloud");
  assert.equal(config.user, "postgres");
  assert.equal(config.schema, "custom_schema");
  assert.equal(config.tableName, "memory_rows");
  assert.equal(hasUsablePostgresConfig(config), true);
});

test("default postgres config supports DATABASE_URL fallback", () => {
  process.env.DATABASE_URL = "postgres://user:secret@localhost:5432/openclaw";
  const config = getDefaultPostgresConfig();
  assert.equal(config.connectionString, "postgres://user:secret@localhost:5432/openclaw");
  assert.equal(hasUsablePostgresConfig(config), true);
});

test("default postgres config supports POSTGRES_* variables", () => {
  process.env.POSTGRES_HOST = "106.54.212.240";
  process.env.POSTGRES_PORT = "5432";
  process.env.POSTGRES_DB = "sync_claw";
  process.env.POSTGRES_USER = "postgres";
  process.env.POSTGRES_PASSWORD = "secret";

  const config = getDefaultPostgresConfig();
  assert.equal(config.host, "106.54.212.240");
  assert.equal(config.port, 5432);
  assert.equal(config.database, "sync_claw");
  assert.equal(config.user, "postgres");
  assert.equal(config.password, "secret");
  assert.equal(hasUsablePostgresConfig(config), true);
});

test("runtime dimensions derive terminal and client from session context", () => {
  const dims = extractRuntimeDimensions({
    sessionKey: "agent:main:discord:channel:42",
    channelId: "discord",
    conversationId: "channel:42",
  });

  assert.equal(dims.client, "discord");
  assert.equal(dims.terminal, "discord:channel:42");
  assert.equal(dims.sessionKey, "agent:main:discord:channel:42");
});
