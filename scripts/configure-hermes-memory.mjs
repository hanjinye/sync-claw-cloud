#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const hermesHome = process.env.HERMES_HOME?.trim()
  ? path.resolve(process.env.HERMES_HOME.trim())
  : path.join(os.homedir(), ".hermes");
const configPath = path.join(hermesHome, "config.yaml");
const provider = "sync_claw_cloud";

function replaceOrInsertMemoryBlock(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const blockPattern = /^memory:\n(?:^[ \t].*\n?)*/m;
  const desiredBlock =
    "memory:\n" +
    "  memory_enabled: true\n" +
    "  provider: sync_claw_cloud\n";

  if (blockPattern.test(normalized)) {
    const existing = normalized.match(blockPattern)?.[0] ?? "";
    const lines = existing.split("\n").filter(Boolean);
    const kept = [];
    let sawEnabled = false;
    let sawProvider = false;
    for (const line of lines.slice(1)) {
      if (/^\s*memory_enabled:\s*/.test(line)) {
        kept.push("  memory_enabled: true");
        sawEnabled = true;
        continue;
      }
      if (/^\s*provider:\s*/.test(line)) {
        kept.push(`  provider: ${provider}`);
        sawProvider = true;
        continue;
      }
      kept.push(line);
    }
    if (!sawEnabled) kept.unshift("  memory_enabled: true");
    if (!sawProvider) kept.push(`  provider: ${provider}`);
    const rebuilt = `memory:\n${kept.join("\n")}\n`;
    return normalized.replace(blockPattern, rebuilt);
  }

  const trimmed = normalized.trimEnd();
  return trimmed ? `${trimmed}\n\n${desiredBlock}` : desiredBlock;
}

async function main() {
  await mkdir(path.dirname(configPath), { recursive: true });
  const original = existsSync(configPath) ? await readFile(configPath, "utf8") : "";
  const next = replaceOrInsertMemoryBlock(original);
  await writeFile(configPath, next, "utf8");
  console.log(`Configured Hermes memory provider in ${configPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
