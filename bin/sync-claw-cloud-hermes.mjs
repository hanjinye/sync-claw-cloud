#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installScript = path.join(rootDir, "scripts", "install-hermes-bridge.sh");
const initScript = path.join(rootDir, "scripts", "init-postgres.sh");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", env: process.env });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

function printHelp() {
  console.log(`sync-claw-cloud-hermes

Usage:
  sync-claw-cloud-hermes setup [--env-file PATH] [--dry-run]
  sync-claw-cloud-hermes install-bridge [--env-file PATH] [--dry-run]
  sync-claw-cloud-hermes bootstrap-db

Commands:
  setup           Install the Hermes bridge and seed ~/.hermes/sync-claw-cloud.env
  install-bridge  Install or update only the Hermes bridge files
  bootstrap-db    Run the PostgreSQL bootstrap/migration SQL
`);
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "setup" || command === "install-bridge") {
    await run("bash", [installScript, ...rest]);
    return;
  }
  if (command === "bootstrap-db") {
    await run("bash", [initScript]);
    return;
  }
  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
