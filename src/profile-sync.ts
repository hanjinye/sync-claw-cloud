import { createHash } from "node:crypto";
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
};

export type ProfileSyncConfig = {
  enabled?: boolean;
  startupSync?: boolean;
  startupDelayMs?: number;
  intervalMinutes?: number;
  backupDir?: string;
  backupRetentionDays?: number;
  maxBackupsPerDoc?: number;
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
      .replace(/("clientSecret"\s*:\s*)"[^"]+"/gi, '$1"***"')
      .replace(/("password"\s*:\s*)"[^"]+"/gi, '$1"***"');
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

export function getCoreDocSpecs(): CoreDocSpec[] {
  const openclawHome = resolveOpenClawHome();
  const workspaceDir = path.join(openclawHome, "workspace");
  const snapshotDir = path.join(workspaceDir, "profile-sync");
  return [
    {
      docKey: "soul_md",
      logicalName: "SOUL.md",
      sourcePath: path.join(workspaceDir, "SOUL.md"),
      pullTargetPath: path.join(workspaceDir, "SOUL.md"),
      mergeStrategy: "canonical-plus-variants",
      syncTransform: stripManagedVariantSection,
    },
    {
      docKey: "user_md",
      logicalName: "USER.md",
      sourcePath: path.join(workspaceDir, "USER.md"),
      pullTargetPath: path.join(workspaceDir, "USER.md"),
      mergeStrategy: "canonical-plus-variants",
      syncTransform: stripManagedVariantSection,
    },
    {
      docKey: "memory_md",
      logicalName: "MEMORY.md",
      sourcePath: path.join(workspaceDir, "MEMORY.md"),
      pullTargetPath: path.join(workspaceDir, "MEMORY.md"),
      mergeStrategy: "union-blocks",
      syncTransform: (content) => content.replace(/\r\n/g, "\n"),
    },
    {
      docKey: "agents_md",
      logicalName: "AGENTS.md",
      sourcePath: path.join(workspaceDir, "AGENTS.md"),
      pullTargetPath: path.join(workspaceDir, "AGENTS.md"),
      mergeStrategy: "canonical-plus-variants",
      syncTransform: stripManagedVariantSection,
    },
    {
      docKey: "openclaw_json_sanitized",
      logicalName: "openclaw.json (sanitized snapshot)",
      sourcePath: path.join(openclawHome, "openclaw.json"),
      pullTargetPath: path.join(snapshotDir, "openclaw.json.sanitized.json"),
      mergeStrategy: "snapshot",
      syncTransform: sanitizeOpenClawConfigText,
    },
  ];
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
  const specs = getCoreDocSpecs();
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
  const specs = getCoreDocSpecs();
  const variants = await params.profileDocStore.latestVariantsByDocKey(specs.map((spec) => spec.docKey));
  const variantsByKey = new Map<string, ProfileDocumentRecord[]>();
  for (const variant of variants) {
    const list = variantsByKey.get(variant.docKey) || [];
    list.push(variant);
    variantsByKey.set(variant.docKey, list);
  }

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
