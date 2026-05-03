import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});
const { parsePluginConfig } = jiti("../index.ts");

function baseConfig() {
  return {
    embedding: {
      apiKey: "test-api-key",
    },
  };
}

describe("sessionStrategy legacy compatibility mapping", () => {
  it("maps legacy sessionMemory.enabled=true to systemSessionMemory", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      sessionMemory: { enabled: true },
    });
    assert.equal(parsed.sessionStrategy, "systemSessionMemory");
  });

  it("maps legacy sessionMemory.enabled=false to none", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      sessionMemory: { enabled: false },
    });
    assert.equal(parsed.sessionStrategy, "none");
  });

  it("prefers explicit sessionStrategy over legacy sessionMemory.enabled", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      sessionStrategy: "memoryReflection",
      sessionMemory: { enabled: false },
    });
    assert.equal(parsed.sessionStrategy, "memoryReflection");
  });

  it("defaults to none when neither field is set", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.equal(parsed.sessionStrategy, "none");
  });

  it("preserves embedding.chunking when explicitly configured", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      embedding: {
        ...baseConfig().embedding,
        chunking: false,
      },
    });
    assert.equal(parsed.embedding.chunking, false);
  });

  it("parses Hermes-oriented profile sync toggles", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      profileSync: {
        includeHermes: true,
        includeHermesPlugins: true,
        skillRoots: ["/tmp/custom-skills", 42, ""],
        pluginRoots: ["/tmp/custom-plugins", false],
        configFiles: ["/tmp/hermes.toml", null],
      },
    });
    assert.equal(parsed.profileSync.includeHermes, true);
    assert.equal(parsed.profileSync.includeHermesPlugins, true);
    assert.equal(parsed.profileSync.includeCodex, false);
    assert.equal(parsed.profileSync.includeOpenClawSkills, false);
    assert.equal(parsed.profileSync.includeAgentSkills, false);
    assert.deepEqual(parsed.profileSync.skillRoots, ["/tmp/custom-skills"]);
    assert.deepEqual(parsed.profileSync.pluginRoots, ["/tmp/custom-plugins"]);
    assert.deepEqual(parsed.profileSync.configFiles, ["/tmp/hermes.toml"]);
  });
});
