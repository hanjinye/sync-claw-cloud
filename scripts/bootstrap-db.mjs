#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sqlFile = path.join(rootDir, "scripts", "init-postgres.sql");
const localEnvFile = path.join(rootDir, ".env");
const hermesHome = process.env.HERMES_HOME?.trim()
  ? path.resolve(process.env.HERMES_HOME.trim())
  : path.join(os.homedir(), ".hermes");
const hermesEnvFile = path.join(hermesHome, "sync-claw-cloud.env");

function parseEnvText(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith("export ")) value = value.slice("export ".length).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  return parseEnvText(await readFile(filePath, "utf8"));
}

function resolveEnv(loaded) {
  return { ...loaded.local, ...loaded.hermes, ...process.env };
}

function resolveSchema(env) {
  const schema = env.SYNC_CLAW_CLOUD_PGSCHEMA || env.POSTGRES_SCHEMA || "sync_claw_cloud";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`Invalid PostgreSQL schema name: ${schema}`);
  }
  return schema;
}

function buildConnectionConfig(env) {
  if (env.SYNC_CLAW_CLOUD_DATABASE_URL) {
    return { connectionString: env.SYNC_CLAW_CLOUD_DATABASE_URL };
  }
  return {
    host: env.SYNC_CLAW_CLOUD_PGHOST || env.POSTGRES_HOST || env.PGHOST || "localhost",
    port: Number(env.SYNC_CLAW_CLOUD_PGPORT || env.POSTGRES_PORT || env.PGPORT || "5432"),
    database: env.SYNC_CLAW_CLOUD_PGDATABASE || env.POSTGRES_DB || env.PGDATABASE || "postgres",
    user: env.SYNC_CLAW_CLOUD_PGUSER || env.POSTGRES_USER || env.PGUSER || "postgres",
    password: env.SYNC_CLAW_CLOUD_PGPASSWORD || env.POSTGRES_PASSWORD || env.PGPASSWORD || undefined,
    ssl: (() => {
      const sslmode = env.POSTGRES_SSLMODE || env.PGSSLMODE;
      return sslmode && sslmode !== "disable" ? { rejectUnauthorized: false } : undefined;
    })(),
  };
}

async function renderSql(schema) {
  const raw = await readFile(sqlFile, "utf8");
  return raw
    .replace(/^\\set ON_ERROR_STOP on\s*$/m, "")
    .replaceAll("__SYNC_SCHEMA__", schema);
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const prev = i > 0 ? sql[i - 1] : "";
    if (ch === "'" && !inDouble && prev !== "\\") {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && prev !== "\\") {
      inDouble = !inDouble;
    }
    if (ch === ";" && !inSingle && !inDouble) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }
  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function printHelp() {
  console.log(`bootstrap-db

Usage:
  node scripts/bootstrap-db.mjs

Reads configuration from:
  - ./.env
  - ~/.hermes/sync-claw-cloud.env
  - process environment

Then creates or upgrades the PostgreSQL schema in place.
`);
}

async function main() {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h" || arg === "help") {
    printHelp();
    return;
  }

  const loaded = {
    local: await loadEnvFile(localEnvFile),
    hermes: await loadEnvFile(hermesEnvFile),
  };
  const env = resolveEnv(loaded);
  const schema = resolveSchema(env);
  const client = new Client(buildConnectionConfig(env));
  const sql = await renderSql(schema);
  const statements = splitSqlStatements(sql);

  await client.connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
    console.log(`Bootstrap complete for schema: ${schema}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
