import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ProfileDocStore, ProfileDocumentRecord } from "./profile-doc-store.js";

export type ProfileMergeStrategy = "canonical-plus-variants" | "union-blocks" | "snapshot";

export type CoreDocSpec = {
  docKey: string;
  logicalName: string;
  sourcePath: string;
  pullTargetPath: string;
  mergeStrategy: ProfileMergeStrategy;
  syncTransform: (content: string) => string;
  syncClass?: "core-doc" | "skill" | "plugin" | "config-snapshot";
  rootKey?: string;
  relativePath?: string;
};

export type ProfileSyncConfig = {
  enabled?: boolean;
  startupSync?: boolean;
  startupDelayMs?: number;
  intervalMinutes?: number;
  backupDir?: string;
  backupRetentionDays?: number;
  maxBackupsPerDoc?: number;
  includeHermes?: boolean;
  includeHermesPlugins?: boolean;
  includeCodex?: boolean;
  includeOpenClawSkills?: boolean;
  includeAgentSkills?: boolean;
  skillRoots?: string[];
  pluginRoots?: string[];
  configFiles?: string[];
};

export type ProfileSyncLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type LocalDocState = {
  exists: boolean;
  rawContent: string;
  syncContent: string;
  syncHash: string | null;
  mtimeMs: number | null;
};

export type ProfileSyncResult = {
  docKey: string;
  logicalName: string;
  localAction: "unchanged" | "updated_local" | "wrote_snapshot" | "missing_remote";
  pushed: boolean;
  contentHash: string;
  remoteVariantCount: number;
  mergedFromTerminals: string[];
  backupPath: string | null;
  targetPath: string;
};

type MergeVariant = {
  sourceLabel: string;
  terminal: string | null;
  createdAt: string | null;
  content: string;
  syncContent: string;
  syncHash: string;
};

type MergeOutcome = {
  localContent: string;
  syncPayload: string;
  syncHash: string;
  mergedFromTerminals: string[];
  remoteVariantCount: number;
  localAction: "unchanged" | "updated_local" | "wrote_snapshot" | "missing_remote";
};

const SYNC_VARIANTS_HEADER = "## Synced Variants (sync-claw-cloud)";

export function resolveOpenClawHome(): string {
  return process.env.OPENCLAW_HOME?.trim()
    ? path.resolve(process.env.OPENCLAW_HOME.trim())
    : path.join(homedir(), ".openclaw");
}

export function resolveHermesHome(): string {
  return process.env.HERMES_HOME?.trim()
    ? path.resolve(process.env.HERMES_HOME.trim())
    : path.join(homedir(), ".hermes");
}

export function resolveCodexHome(): string {
  return process.env.CODEX_HOME?.trim()
    ? path.resolve(process.env.CODEX_HOME.trim())
    : path.join(homedir(), ".codex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sanitizeOpenClawConfigText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    const sanitized = deepRedactSecrets(parsed);
    return `${JSON.stringify(sanitized, null, 2)}\n`;
  } catch {
    return content
      .replace(/("token"\s*:\s*)"[^"]+"/gi, '$1"***"')
      .replace(/("apiKey"\s*:\s*)"[^"]+"/gi, '$1"***"')
      .replace(/("api_key"\s*:\s*)"[^"]+"/gi, '$1"***"')
      .replace(/("clientSecret"\s*:\s*)"[^"]+"/gi, '$1"***"')
      .replace(/("password"\s*:\s*)"[^"]+"/gi, '$1"***"')
      .replace(/^(\s*(?:token|apiKey|api_key|clientSecret|client_secret|secret|password|authorization|auth)\s*:\s*).+$/gim, "$1***");
  }
}

function deepRedactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepRedactSecrets);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/(token|apikey|api_key|secret|password|authorization|auth)$/i.test(key)) {
      out[key] = typeof raw === "string" && raw.length > 0 ? "***" : raw;
      continue;
    }
    out[key] = deepRedactSecrets(raw);
  }
  return out;
}

function stripManagedVariantSection(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const marker = `\n${SYNC_VARIANTS_HEADER}\n`;
  const exact = normalized.indexOf(marker);
  if (exact >= 0) {
    return normalized.slice(0, exact).replace(/\s+$/, "") + "\n";
  }
  if (normalized.startsWith(`${SYNC_VARIANTS_HEADER}\n`)) {
    return "";
  }
  return normalized;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function normalizeBlockKey(value: string): string {
  return normalizeWhitespace(value)
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function renderVariantSection(variants: MergeVariant[]): string {
  if (variants.length === 0) return "";
  const lines: string[] = ["", SYNC_VARIANTS_HEADER, ""];
  for (const variant of variants) {
    const labelParts = [variant.sourceLabel];
    if (variant.createdAt) labelParts.push(variant.createdAt);
    lines.push(`### ${labelParts.join(" | ")}`);
    lines.push("");
    lines.push("```md");
    lines.push(variant.syncContent.replace(/\n$/, ""));
    lines.push("```");
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function mergeCanonicalPlusVariants(
  local: LocalDocState,
  variants: MergeVariant[],
): MergeOutcome {
  const localBase = normalizeWhitespace(local.syncContent);
  const canonical = localBase.length > 0
    ? local.syncContent
    : variants[0]?.syncContent || "";
  if (!canonical) {
    return {
      localContent: local.rawContent,
      syncPayload: local.syncContent,
      syncHash: local.syncHash || sha256Text(local.syncContent),
      mergedFromTerminals: [],
      remoteVariantCount: variants.length,
      localAction: "missing_remote",
    };
  }

  const canonicalHash = sha256Text(canonical);
  const unique = new Map<string, MergeVariant>();
  for (const variant of variants) {
    if (variant.syncHash === canonicalHash) continue;
    if (!unique.has(variant.syncHash)) {
      unique.set(variant.syncHash, variant);
    }
  }
  const orderedVariants = Array.from(unique.values())
    .sort((a, b) => {
      const timeDiff = new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      if (timeDiff !== 0) return timeDiff;
      return (a.sourceLabel || "").localeCompare(b.sourceLabel || "");
    });

  const variantSection = renderVariantSection(orderedVariants);
  const localContent = `${canonical.replace(/\s+$/, "")}\n${variantSection ? `\n${variantSection}` : ""}`
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
  const mergedFromTerminals = orderedVariants
    .map((variant) => variant.terminal)
    .filter((terminal): terminal is string => Boolean(terminal));

  return {
    localContent,
    syncPayload: canonical.endsWith("\n") ? canonical : `${canonical}\n`,
    syncHash: canonicalHash,
    mergedFromTerminals,
    remoteVariantCount: variants.length,
    localAction: "updated_local",
  };
}

function mergeUnionBlocks(local: LocalDocState, variants: MergeVariant[]): MergeOutcome {
  const blocks: string[] = [];
  const seen = new Set<string>();
  const orderedBodies = [
    { content: local.syncContent, terminal: "local" },
    ...variants
      .slice()
      .sort((a, b) => {
        const timeDiff = new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
        if (timeDiff !== 0) return timeDiff;
        return (a.sourceLabel || "").localeCompare(b.sourceLabel || "");
      })
      .map((variant) => ({ content: variant.syncContent, terminal: variant.terminal || variant.sourceLabel })),
  ];

  for (const body of orderedBodies) {
    const candidates = body.content
      .replace(/\r\n/g, "\n")
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean);
    for (const candidate of candidates) {
      const key = normalizeBlockKey(candidate);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      blocks.push(candidate);
    }
  }

  const merged = blocks.join("\n\n").trim();
  const mergedContent = merged ? `${merged}\n` : "";
  const syncHash = sha256Text(mergedContent);
  return {
    localContent: mergedContent,
    syncPayload: mergedContent,
    syncHash,
    mergedFromTerminals: variants
      .map((variant) => variant.terminal)
      .filter((terminal): terminal is string => Boolean(terminal)),
    remoteVariantCount: variants.length,
    localAction: mergedContent ? "updated_local" : "missing_remote",
  };
}

function mergeSnapshot(local: LocalDocState, variants: MergeVariant[]): MergeOutcome {
  const latest = variants[0];
  const chosen = local.syncContent || latest?.syncContent || "";
  const syncPayload = chosen ? (chosen.endsWith("\n") ? chosen : `${chosen}\n`) : "";
  return {
    localContent: syncPayload,
    syncPayload,
    syncHash: sha256Text(syncPayload),
    mergedFromTerminals: latest?.terminal ? [latest.terminal] : [],
    remoteVariantCount: variants.length,
    localAction: chosen ? "wrote_snapshot" : "missing_remote",
  };
}

function mergeDocument(spec: CoreDocSpec, local: LocalDocState, remoteRecords: ProfileDocumentRecord[]): MergeOutcome {
  const variants: MergeVariant[] = remoteRecords.map((record) => ({
    sourceLabel: record.terminal || "unknown-terminal",
    terminal: record.terminal || null,
    createdAt: record.createdAt || null,
    content: record.content,
    syncContent: spec.syncTransform(record.content),
    syncHash: sha256Text(spec.syncTransform(record.content)),
  }));

  if (spec.mergeStrategy === "snapshot") {
    return mergeSnapshot(local, variants);
  }
  if (spec.mergeStrategy === "union-blocks") {
    return mergeUnionBlocks(local, variants);
  }
  return mergeCanonicalPlusVariants(local, variants);
}

function sanitizeDocKeyPart(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 140) || "root";
}

function normalizeRelativePath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) {
    return null;
  }
  return normalized;
}

function resolveRootPath(rootKey: string, config?: ProfileSyncConfig): string | null {
  const openclawHome = resolveOpenClawHome();
  const hermesHome = resolveHermesHome();
  const codexHome = resolveCodexHome();
  const defaults: Record<string, string> = {
    openclaw_skills: path.join(openclawHome, "skills"),
    agent_skills: path.join(homedir(), ".agents", "skills"),
    hermes_skills: path.join(hermesHome, "skills"),
    hermes_user_plugins: path.join(hermesHome, "plugins"),
    hermes_agent_plugins: path.join(hermesHome, "hermes-agent", "plugins"),
    codex_skills: path.join(codexHome, "skills"),
  };
  if (defaults[rootKey]) return defaults[rootKey];
  const customRoots = config?.skillRoots || [];
  const customIndex = /^custom_skill_root_(\d+)$/.exec(rootKey)?.[1];
  if (customIndex !== undefined) {
    const raw = customRoots[Number(customIndex)];
    return raw ? path.resolve(raw.replace(/^~(?=\/|$)/, homedir())) : null;
  }
  const customPluginRoots = config?.pluginRoots || [];
  const customPluginIndex = /^custom_plugin_root_(\d+)$/.exec(rootKey)?.[1];
  if (customPluginIndex !== undefined) {
    const raw = customPluginRoots[Number(customPluginIndex)];
    return raw ? path.resolve(raw.replace(/^~(?=\/|$)/, homedir())) : null;
  }
  return null;
}

function shouldSkipSyncedTreePath(fullPath: string): boolean {
  const parts = fullPath.split(path.sep);
  return parts.some((part) => (
    part.startsWith(".") ||
    part === "node_modules" ||
    part === "dist" ||
    part === "build" ||
    part === "venv" ||
    part === ".venv" ||
    part === "site-packages" ||
    part === "tests" ||
    part === "test" ||
    part.endsWith(".egg-info") ||
    part === "cache" ||
    part === "__pycache__"
  ));
}

function isSyncablePluginFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (
    lower === ".ds_store" ||
    lower.endsWith(".pyc") ||
    lower.endsWith(".pyo") ||
    lower.includes(".bak-") ||
    lower.endsWith(".bak") ||
    lower.endsWith(".tmp")
  ) {
    return false;
  }
  return [
    ".py",
    ".yaml",
    ".yml",
    ".json",
    ".md",
    ".toml",
    ".txt",
    ".sh",
    ".js",
    ".ts",
  ].some((ext) => lower.endsWith(ext));
}

function collectSkillSpecs(rootKey: string, rootPath: string): CoreDocSpec[] {
  const resolvedRoot = path.resolve(rootPath);
  if (!existsSync(resolvedRoot)) return [];
  const specs: CoreDocSpec[] = [];
  const stack = [resolvedRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (shouldSkipSyncedTreePath(path.relative(resolvedRoot, fullPath))) continue;
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== "SKILL.md") continue;
      const relativePath = path.relative(resolvedRoot, fullPath).replace(/\\/g, "/");
      specs.push({
        docKey: `${rootKey}__${sanitizeDocKeyPart(relativePath)}`,
        logicalName: `${rootKey}:${relativePath}`,
        sourcePath: fullPath,
        pullTargetPath: fullPath,
        mergeStrategy: "snapshot",
        syncTransform: (content) => content.replace(/\r\n/g, "\n"),
        syncClass: "skill",
        rootKey,
        relativePath,
      });
    }
  }
  return specs.sort((a, b) => a.docKey.localeCompare(b.docKey));
}

function collectPluginSpecs(rootKey: string, rootPath: string): CoreDocSpec[] {
  const resolvedRoot = path.resolve(rootPath);
  if (!existsSync(resolvedRoot)) return [];
  const specs: CoreDocSpec[] = [];
  const stack = [resolvedRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(resolvedRoot, fullPath).replace(/\\/g, "/");
      if (shouldSkipSyncedTreePath(relativePath)) continue;
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !isSyncablePluginFile(entry.name)) continue;
      specs.push({
        docKey: `${rootKey}__${sanitizeDocKeyPart(relativePath)}`,
        logicalName: `${rootKey}:${relativePath}`,
        sourcePath: fullPath,
        pullTargetPath: fullPath,
        mergeStrategy: "snapshot",
        syncTransform: (content) => content.replace(/\r\n/g, "\n"),
        syncClass: "plugin",
        rootKey,
        relativePath,
      });
    }
  }
  return specs.sort((a, b) => a.docKey.localeCompare(b.docKey));
}

function buildConfigSnapshotSpec(params: {
  docKey: string;
  logicalName: string;
  sourcePath: string;
  snapshotName: string;
}): CoreDocSpec {
  const snapshotDir = path.join(resolveOpenClawHome(), "workspace", "profile-sync");
  return {
    docKey: params.docKey,
    logicalName: params.logicalName,
    sourcePath: params.sourcePath,
    pullTargetPath: path.join(snapshotDir, params.snapshotName),
    mergeStrategy: "snapshot",
    syncTransform: sanitizeOpenClawConfigText,
    syncClass: "config-snapshot",
  };
}

function specFromRemoteRecord(record: ProfileDocumentRecord, config?: ProfileSyncConfig): CoreDocSpec | null {
  const metadata = record.metadata || {};
  if (metadata.syncClass !== "skill" && metadata.syncClass !== "plugin") return null;
  const rootKey = typeof metadata.rootKey === "string" ? metadata.rootKey : undefined;
  const relativePath = typeof metadata.relativePath === "string" ? normalizeRelativePath(metadata.relativePath) : null;
  if (!rootKey || !relativePath) return null;
  if (
    !rootKey.startsWith("hermes_") &&
    !rootKey.startsWith("custom_skill_root_") &&
    !rootKey.startsWith("custom_plugin_root_")
  ) {
    return null;
  }
  const rootPath = resolveRootPath(rootKey, config);
  if (!rootPath) return null;
  const targetPath = path.join(rootPath, relativePath);
  return {
    docKey: record.docKey,
    logicalName: record.logicalName || `${rootKey}:${relativePath}`,
    sourcePath: targetPath,
    pullTargetPath: targetPath,
    mergeStrategy: "snapshot",
    syncTransform: (content) => content.replace(/\r\n/g, "\n"),
    syncClass: metadata.syncClass === "plugin" ? "plugin" : "skill",
    rootKey,
    relativePath,
  };
}

export function getCoreDocSpecs(config?: ProfileSyncConfig): CoreDocSpec[] {
  const hermesHome = resolveHermesHome();
  const specs: CoreDocSpec[] = [];

  if (config?.includeHermes !== false) {
    specs.push({
      docKey: "hermes_agents_md",
      logicalName: "Hermes AGENTS.md",
      sourcePath: path.join(hermesHome, "hermes-agent", "AGENTS.md"),
      pullTargetPath: path.join(hermesHome, "hermes-agent", "AGENTS.md"),
      mergeStrategy: "canonical-plus-variants",
      syncTransform: stripManagedVariantSection,
      syncClass: "core-doc",
    });
    specs.push(buildConfigSnapshotSpec({
      docKey: "hermes_config_sanitized",
      logicalName: "Hermes config (sanitized snapshot)",
      sourcePath: path.join(hermesHome, "config.yaml"),
      snapshotName: "hermes.config.sanitized.yaml",
    }));
    specs.push(...collectSkillSpecs("hermes_skills", path.join(hermesHome, "skills")));
    if (config?.includeHermesPlugins !== false) {
      specs.push(...collectPluginSpecs("hermes_user_plugins", path.join(hermesHome, "plugins")));
      specs.push(...collectPluginSpecs("hermes_agent_plugins", path.join(hermesHome, "hermes-agent", "plugins")));
    }
  }

  for (const [index, root] of (config?.skillRoots || []).entries()) {
    if (typeof root === "string" && root.trim()) {
      specs.push(...collectSkillSpecs(`custom_skill_root_${index}`, root.trim()));
    }
  }

  for (const [index, root] of (config?.pluginRoots || []).entries()) {
    if (typeof root === "string" && root.trim()) {
      specs.push(...collectPluginSpecs(`custom_plugin_root_${index}`, root.trim()));
    }
  }

  for (const [index, file] of (config?.configFiles || []).entries()) {
    if (typeof file === "string" && file.trim()) {
      const sourcePath = path.resolve(file.trim().replace(/^~(?=\/|$)/, homedir()));
      specs.push(buildConfigSnapshotSpec({
        docKey: `custom_config_${index}_${sanitizeDocKeyPart(path.basename(sourcePath))}`,
        logicalName: `Custom config snapshot: ${sourcePath}`,
        sourcePath,
        snapshotName: `custom-${index}-${sanitizeDocKeyPart(path.basename(sourcePath))}.sanitized.txt`,
      }));
    }
  }

  const unique = new Map<string, CoreDocSpec>();
  for (const spec of specs) {
    if (!unique.has(spec.docKey)) unique.set(spec.docKey, spec);
  }
  return Array.from(unique.values());
}

export async function readLocalDoc(spec: CoreDocSpec): Promise<LocalDocState> {
  try {
    const rawContent = await readFile(spec.sourcePath, "utf8");
    const st = await stat(spec.sourcePath);
    const syncContent = spec.syncTransform(rawContent);
    return {
      exists: true,
      rawContent,
      syncContent,
      syncHash: sha256Text(syncContent),
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return {
      exists: false,
      rawContent: "",
      syncContent: "",
      syncHash: null,
      mtimeMs: null,
    };
  }
}

function resolveBackupRoot(config?: ProfileSyncConfig): string {
  const openclawHome = resolveOpenClawHome();
  return path.resolve(
    config?.backupDir?.trim() || path.join(openclawHome, "workspace", "profile-sync", "backups"),
  );
}

async function pruneDocBackups(docDir: string, config?: ProfileSyncConfig): Promise<void> {
  const entries = await readdir(docDir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .map(async (entry) => {
      const fullPath = path.join(docDir, entry.name);
      const st = await stat(fullPath).catch(() => null);
      return st ? { fullPath, mtimeMs: st.mtimeMs } : null;
    }));
  const validFiles = files.filter((item): item is { fullPath: string; mtimeMs: number } => Boolean(item))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const maxBackups = Math.max(1, Math.trunc(config?.maxBackupsPerDoc || 30));
  const retentionMs = Math.max(1, Math.trunc(config?.backupRetentionDays || 30)) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;

  for (const item of validFiles.slice(maxBackups)) {
    await unlink(item.fullPath).catch(() => {});
  }
  for (const item of validFiles.slice(0, maxBackups)) {
    if (item.mtimeMs < cutoff) {
      await unlink(item.fullPath).catch(() => {});
    }
  }
}

export async function backupDocFile(
  spec: CoreDocSpec,
  content: string,
  reason: string,
  config?: ProfileSyncConfig,
): Promise<string> {
  const backupRoot = resolveBackupRoot(config);
  const docDir = path.join(backupRoot, spec.docKey);
  await mkdir(docDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = path.extname(spec.pullTargetPath || spec.sourcePath || spec.logicalName) || ".txt";
  const safeReason = reason.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const filePath = path.join(docDir, `${timestamp}__${safeReason}${ext}`);
  await writeFile(filePath, content, "utf8");
  await pruneDocBackups(docDir, config);
  return filePath;
}

export async function backupCurrentCoreDocs(config?: ProfileSyncConfig): Promise<Array<{ docKey: string; path: string }>> {
  const specs = getCoreDocSpecs(config);
  const results: Array<{ docKey: string; path: string }> = [];
  for (const spec of specs) {
    const local = await readLocalDoc(spec);
    if (!local.exists) continue;
    const backupPath = await backupDocFile(spec, local.rawContent, "manual-backup", config);
    results.push({ docKey: spec.docKey, path: backupPath });
  }
  return results;
}

export async function runProfileSyncCycle(params: {
  profileDocStore: ProfileDocStore;
  terminal: string;
  client: string;
  config?: ProfileSyncConfig;
  logger?: ProfileSyncLogger;
  source?: string;
}): Promise<ProfileSyncResult[]> {
  const localSpecs = getCoreDocSpecs(params.config);
  const variants = await params.profileDocStore.latestVariantsByDocKey();
  const variantsByKey = new Map<string, ProfileDocumentRecord[]>();
  for (const variant of variants) {
    const list = variantsByKey.get(variant.docKey) || [];
    list.push(variant);
    variantsByKey.set(variant.docKey, list);
  }

  const specsByKey = new Map(localSpecs.map((spec) => [spec.docKey, spec]));
  for (const record of variants) {
    if (specsByKey.has(record.docKey)) continue;
    const remoteSpec = specFromRemoteRecord(record, params.config);
    if (remoteSpec) specsByKey.set(remoteSpec.docKey, remoteSpec);
  }
  const specs = Array.from(specsByKey.values()).sort((a, b) => a.docKey.localeCompare(b.docKey));

  const results: ProfileSyncResult[] = [];
  for (const spec of specs) {
    const local = await readLocalDoc(spec);
    const remoteRecords = variantsByKey.get(spec.docKey) || [];
    const merged = mergeDocument(spec, local, remoteRecords);

    let backupPath: string | null = null;
    const targetPath = spec.pullTargetPath;
    const normalizedCurrent = local.exists ? local.rawContent.replace(/\r\n/g, "\n") : "";
    const normalizedNext = merged.localContent.replace(/\r\n/g, "\n");
    const shouldWriteLocal = spec.mergeStrategy === "snapshot"
      ? normalizedNext.length > 0 && normalizedCurrent !== normalizedNext
      : normalizedCurrent !== normalizedNext;

    if (shouldWriteLocal) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      if (local.exists) {
        backupPath = await backupDocFile(spec, local.rawContent, "before-sync-update", params.config);
      }
      await writeFile(targetPath, merged.localContent, "utf8");
      params.logger?.info?.(`profile-sync: updated ${spec.logicalName}${backupPath ? ` (backup: ${backupPath})` : ""}`);
    }

    const pushed = await params.profileDocStore.pushDocument({
      docKey: spec.docKey,
      logicalName: spec.logicalName,
      sourcePath: spec.sourcePath,
      content: merged.syncPayload,
      terminal: params.terminal,
      client: params.client,
      sourceMtime: Math.trunc(Date.now()),
      metadata: {
        syncSource: params.source || "profile-sync-cycle",
        mergeStrategy: spec.mergeStrategy,
        mergedFromTerminals: merged.mergedFromTerminals,
        remoteVariantCount: merged.remoteVariantCount,
        syncClass: spec.syncClass || "core-doc",
        rootKey: spec.rootKey,
        relativePath: spec.relativePath,
      },
    });

    results.push({
      docKey: spec.docKey,
      logicalName: spec.logicalName,
      localAction: shouldWriteLocal
        ? (spec.mergeStrategy === "snapshot" ? "wrote_snapshot" : "updated_local")
        : (remoteRecords.length === 0 && !local.exists ? "missing_remote" : "unchanged"),
      pushed: pushed.inserted,
      contentHash: pushed.record.contentHash,
      remoteVariantCount: merged.remoteVariantCount,
      mergedFromTerminals: merged.mergedFromTerminals,
      backupPath,
      targetPath,
    });
  }
  return results;
}
