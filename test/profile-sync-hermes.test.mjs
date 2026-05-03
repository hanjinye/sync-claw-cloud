import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { getCoreDocSpecs, runProfileSyncCycle, sha256Text } = jiti("../src/profile-sync.ts");

describe("Hermes profile sync specs", () => {
  let workDir;
  let oldOpenClawHome;
  let oldHermesHome;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "profile-sync-hermes-"));
    oldOpenClawHome = process.env.OPENCLAW_HOME;
    oldHermesHome = process.env.HERMES_HOME;
    process.env.OPENCLAW_HOME = path.join(workDir, ".openclaw");
    process.env.HERMES_HOME = path.join(workDir, ".hermes");
  });

  afterEach(() => {
    if (oldOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = oldOpenClawHome;
    if (oldHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = oldHermesHome;
    rmSync(workDir, { recursive: true, force: true });
  });

  it("discovers local Hermes skill files as snapshot sync documents", () => {
    const skillPath = path.join(process.env.HERMES_HOME, "skills", "demo", "SKILL.md");
    mkdirSync(path.dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "# Demo\n", "utf-8");

    const specs = getCoreDocSpecs({ includeHermes: true, includeOpenClawSkills: false });
    const skillSpec = specs.find((spec) => spec.relativePath === "demo/SKILL.md");
    assert.ok(skillSpec);
    assert.equal(skillSpec.syncClass, "skill");
    assert.equal(skillSpec.rootKey, "hermes_skills");
    assert.equal(skillSpec.mergeStrategy, "snapshot");
  });

  it("discovers Hermes config.yaml and plugin source files", () => {
    const configPath = path.join(process.env.HERMES_HOME, "config.yaml");
    const pluginPath = path.join(process.env.HERMES_HOME, "hermes-agent", "plugins", "memory", "demo", "__init__.py");
    mkdirSync(path.dirname(configPath), { recursive: true });
    mkdirSync(path.dirname(pluginPath), { recursive: true });
    writeFileSync(configPath, "memory:\n  provider: sync_claw_cloud\napi_key: secret\n", "utf-8");
    writeFileSync(pluginPath, "def search(query):\n    return []\n", "utf-8");

    const specs = getCoreDocSpecs({ includeHermes: true, includeOpenClawSkills: false });
    const configSpec = specs.find((spec) => spec.docKey === "hermes_config_sanitized");
    const pluginSpec = specs.find((spec) => spec.relativePath === "memory/demo/__init__.py");

    assert.ok(configSpec);
    assert.equal(configSpec.sourcePath, configPath);
    assert.equal(configSpec.syncTransform(readFileSync(configPath, "utf-8")), "memory:\n  provider: sync_claw_cloud\napi_key: ***\n");
    assert.ok(pluginSpec);
    assert.equal(pluginSpec.syncClass, "plugin");
    assert.equal(pluginSpec.rootKey, "hermes_agent_plugins");
    assert.equal(pluginSpec.mergeStrategy, "snapshot");
  });

  it("pulls remote-only Hermes skills into the local Hermes skill root", async () => {
    const remoteContent = "# Remote Skill\n\nSynced from another terminal.\n";
    const remoteRecord = {
      id: 1,
      docKey: "hermes_skills__remote_skill_md",
      logicalName: "hermes_skills:remote/SKILL.md",
      sourcePath: "/other/.hermes/skills/remote/SKILL.md",
      content: remoteContent,
      contentHash: sha256Text(remoteContent),
      terminal: "other-terminal",
      client: "openclaw-local",
      sourceMtime: Date.now(),
      metadata: {
        syncClass: "skill",
        rootKey: "hermes_skills",
        relativePath: "remote/SKILL.md",
      },
      createdAt: new Date().toISOString(),
    };
    const pushed = [];
    const fakeStore = {
      async latestVariantsByDocKey() {
        return [remoteRecord];
      },
      async pushDocument(input) {
        pushed.push(input);
        return {
          inserted: true,
          record: {
            ...remoteRecord,
            docKey: input.docKey,
            logicalName: input.logicalName,
            sourcePath: input.sourcePath,
            content: input.content,
            contentHash: sha256Text(input.content),
            terminal: input.terminal,
            client: input.client,
            metadata: input.metadata || {},
          },
        };
      },
    };

    const results = await runProfileSyncCycle({
      profileDocStore: fakeStore,
      terminal: "this-terminal",
      client: "openclaw-local",
      config: { includeHermes: true, includeOpenClawSkills: false },
    });

    const targetPath = path.join(process.env.HERMES_HOME, "skills", "remote", "SKILL.md");
    assert.equal(readFileSync(targetPath, "utf-8"), remoteContent);
    assert.ok(results.some((result) => result.docKey === "hermes_skills__remote_skill_md"));
    assert.ok(pushed.some((input) => input.metadata?.rootKey === "hermes_skills"));
  });

  it("pulls remote-only Hermes plugin files into the local Hermes plugin root", async () => {
    const remoteContent = "name: demo\n";
    const remoteRecord = {
      id: 1,
      docKey: "hermes_agent_plugins__memory_demo_plugin_yaml",
      logicalName: "hermes_agent_plugins:memory/demo/plugin.yaml",
      sourcePath: "/other/.hermes/hermes-agent/plugins/memory/demo/plugin.yaml",
      content: remoteContent,
      contentHash: sha256Text(remoteContent),
      terminal: "other-terminal",
      client: "openclaw-local",
      sourceMtime: Date.now(),
      metadata: {
        syncClass: "plugin",
        rootKey: "hermes_agent_plugins",
        relativePath: "memory/demo/plugin.yaml",
      },
      createdAt: new Date().toISOString(),
    };
    const fakeStore = {
      async latestVariantsByDocKey() {
        return [remoteRecord];
      },
      async pushDocument(input) {
        return {
          inserted: true,
          record: {
            ...remoteRecord,
            docKey: input.docKey,
            logicalName: input.logicalName,
            sourcePath: input.sourcePath,
            content: input.content,
            contentHash: sha256Text(input.content),
            terminal: input.terminal,
            client: input.client,
            metadata: input.metadata || {},
          },
        };
      },
    };

    await runProfileSyncCycle({
      profileDocStore: fakeStore,
      terminal: "this-terminal",
      client: "openclaw-local",
      config: { includeHermes: true, includeOpenClawSkills: false },
    });

    const targetPath = path.join(process.env.HERMES_HOME, "hermes-agent", "plugins", "memory", "demo", "plugin.yaml");
    assert.equal(readFileSync(targetPath, "utf-8"), remoteContent);
  });
});
