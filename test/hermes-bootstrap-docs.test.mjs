import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, "..");

describe("Hermes bootstrap assets", () => {
  it("tracks schema version and additive migrations in SQL bootstrap", () => {
    const sql = readFileSync(path.join(rootDir, "scripts", "init-postgres.sql"), "utf8");
    assert.match(sql, /schema_meta/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS/);
    assert.match(sql, /SET version = 1/);
  });

  it("loads project and Hermes env files in bootstrap shell script", () => {
    const shell = readFileSync(path.join(rootDir, "scripts", "init-postgres.sh"), "utf8");
    assert.match(shell, /LOCAL_ENV_FILE/);
    assert.match(shell, /HERMES_ENV_FILE/);
    assert.match(shell, /source "\$file"/);
  });
});
