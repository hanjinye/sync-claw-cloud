import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(testDir, "..", "scripts", "jsonl_distill.py");

function makeMessage(role, text, ts) {
  return JSON.stringify({
    type: "message",
    timestamp: ts,
    message: {
      role,
      content: [{ type: "text", text }],
    },
  });
}

function runScript(args) {
  const run = spawnSync("python3", [scriptPath, ...args], { encoding: "utf-8" });
  assert.equal(run.status, 0, `script failed: ${run.stderr || run.stdout}`);
  return JSON.parse(run.stdout.trim());
}

describe("jsonl_distill slash-command filtering", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "jsonl-distill-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("filters slash/control-note messages while keeping normal dialog", () => {
    const stateDir = path.join(workDir, "state");
    const agentsDir = path.join(workDir, "agents");
    const sessionsDir = path.join(agentsDir, "main", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const sessionPath = path.join(sessionsDir, "session-1.jsonl");
    writeFileSync(sessionPath, "");

    const init = runScript(["--state-dir", stateDir, "--agents-dir", agentsDir, "init"]);
    assert.equal(init.ok, true);

    appendFileSync(
      sessionPath,
      [
        makeMessage("user", "   /note self-improvement (before reset): write summary", 1),
        makeMessage("assistant", "✅ New session started", 2),
        makeMessage("user", "Please keep my preferred test style as concise.", 3),
        makeMessage("assistant", "Understood. I will keep tests focused and concise.", 4),
      ].join("\n") + "\n",
      "utf-8"
    );

    const run = runScript(["--state-dir", stateDir, "--agents-dir", agentsDir, "run"]);
    assert.equal(run.ok, true);
    assert.equal(run.action, "created");
    assert.ok(typeof run.batchFile === "string" && run.batchFile.length > 0);

    const batch = JSON.parse(readFileSync(run.batchFile, "utf-8"));
    assert.equal(batch.agents.length, 1);
    assert.equal(batch.agents[0].agentId, "main");

    const texts = batch.agents[0].messages.map((m) => m.text);
    assert.equal(texts.length, 2);
    assert.ok(texts.every((t) => !t.trimStart().startsWith("/")));
    assert.deepEqual(texts, [
      "Please keep my preferred test style as concise.",
      "Understood. I will keep tests focused and concise.",
    ]);
    assert.ok(batch.agents[0].messages.every((m) => Array.isArray(m.quality.lexicalTerms)));
    assert.ok(batch.agents[0].messages.every((m) => typeof m.decay.recency === "number"));
    assert.equal(batch.bridge.filteredCounts.slash_command, 1);
  });

  it("annotates extracted messages with BM25 scores when a query is provided", () => {
    const stateDir = path.join(workDir, "state");
    const agentsDir = path.join(workDir, "agents");
    const sessionsDir = path.join(agentsDir, "main", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const sessionPath = path.join(sessionsDir, "session-1.jsonl");
    writeFileSync(sessionPath, "");
    runScript(["--state-dir", stateDir, "--agents-dir", agentsDir, "init"]);

    appendFileSync(
      sessionPath,
      [
        makeMessage("user", "Hermes should sync skills and config files.", 1),
        makeMessage("assistant", "Weather is unrelated here.", 2),
      ].join("\n") + "\n",
      "utf-8"
    );

    const run = runScript([
      "--state-dir", stateDir,
      "--agents-dir", agentsDir,
      "run",
      "--bm25-query", "Hermes skills config",
    ]);
    const batch = JSON.parse(readFileSync(run.batchFile, "utf-8"));
    const [first, second] = batch.agents[0].messages;
    assert.ok(first.retrieval.bm25Score > second.retrieval.bm25Score);
    assert.deepEqual(batch.bridge.bm25Query, "Hermes skills config");
  });
});
