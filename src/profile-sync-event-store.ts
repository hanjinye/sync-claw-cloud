import { Pool, type QueryResultRow } from "pg";
import type { PostgresConnectionConfig, ResolvedPostgresConfig } from "./postgres-config.js";
import { hasUsablePostgresConfig, resolvePostgresConfig } from "./postgres-config.js";

export interface ProfileSyncEventRecord {
  id: number;
  docKey: string;
  logicalName: string;
  terminal?: string;
  client?: string;
  source?: string;
  mergeStrategy?: string;
  localAction: string;
  pushed: boolean;
  hasConflict: boolean;
  remoteVariantCount: number;
  mergedFromTerminals: string[];
  backupPath?: string;
  targetPath?: string;
  contentHash?: string;
  summary?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

type ProfileSyncEventRow = QueryResultRow & {
  id: number;
  doc_key: string;
  logical_name: string;
  terminal: string | null;
  client: string | null;
  source: string | null;
  merge_strategy: string | null;
  local_action: string;
  pushed: boolean;
  has_conflict: boolean;
  remote_variant_count: number;
  merged_from_terminals: string[] | string | null;
  backup_path: string | null;
  target_path: string | null;
  content_hash: string | null;
  summary: string | null;
  metadata: Record<string, unknown> | string | null;
  created_at: string;
};

function escapeIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function parseMetadata(value: ProfileSyncEventRow["metadata"]): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value;
}

function parseMergedFromTerminals(value: ProfileSyncEventRow["merged_from_terminals"]): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toRecord(row: ProfileSyncEventRow): ProfileSyncEventRecord {
  return {
    id: Number(row.id),
    docKey: row.doc_key,
    logicalName: row.logical_name,
    terminal: row.terminal || undefined,
    client: row.client || undefined,
    source: row.source || undefined,
    mergeStrategy: row.merge_strategy || undefined,
    localAction: row.local_action,
    pushed: Boolean(row.pushed),
    hasConflict: Boolean(row.has_conflict),
    remoteVariantCount: Number(row.remote_variant_count || 0),
    mergedFromTerminals: parseMergedFromTerminals(row.merged_from_terminals),
    backupPath: row.backup_path || undefined,
    targetPath: row.target_path || undefined,
    contentHash: row.content_hash || undefined,
    summary: row.summary || undefined,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
  };
}

export class ProfileSyncEventStore {
  private readonly config: ResolvedPostgresConfig;
  private pool: Pool | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(postgres?: PostgresConnectionConfig) {
    this.config = resolvePostgresConfig(postgres);
  }

  static canUse(postgres?: PostgresConnectionConfig): boolean {
    return hasUsablePostgresConfig(resolvePostgresConfig(postgres));
  }

  private getPool(): Pool {
    if (this.pool) return this.pool;
    this.pool = new Pool(
      this.config.connectionString
        ? { connectionString: this.config.connectionString }
        : {
          host: this.config.host,
          port: this.config.port,
          database: this.config.database,
          user: this.config.user,
          password: this.config.password,
          ssl: this.config.sslmode && this.config.sslmode !== "disable"
            ? { rejectUnauthorized: false }
            : undefined,
        },
    );
    return this.pool;
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const pool = this.getPool();
    const schema = escapeIdentifier(this.config.schema);
    const table = escapeIdentifier("profile_sync_events");
    const createdIdx = escapeIdentifier("profile_sync_events_created_idx");
    const docIdx = escapeIdentifier("profile_sync_events_doc_key_idx");
    const conflictIdx = escapeIdentifier("profile_sync_events_conflict_idx");
    const terminalIdx = escapeIdentifier("profile_sync_events_terminal_idx");

    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE IF NOT EXISTS ${schema}.${table} (
        id bigserial PRIMARY KEY,
        doc_key text NOT NULL,
        logical_name text NOT NULL,
        terminal text,
        client text,
        source text,
        merge_strategy text,
        local_action text NOT NULL,
        pushed boolean NOT NULL DEFAULT false,
        has_conflict boolean NOT NULL DEFAULT false,
        remote_variant_count integer NOT NULL DEFAULT 0,
        merged_from_terminals jsonb NOT NULL DEFAULT '[]'::jsonb,
        backup_path text,
        target_path text,
        content_hash text,
        summary text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ${createdIdx}
        ON ${schema}.${table} (created_at DESC);
      CREATE INDEX IF NOT EXISTS ${docIdx}
        ON ${schema}.${table} (doc_key);
      CREATE INDEX IF NOT EXISTS ${conflictIdx}
        ON ${schema}.${table} (has_conflict, created_at DESC);
      CREATE INDEX IF NOT EXISTS ${terminalIdx}
        ON ${schema}.${table} (terminal, created_at DESC);
    `);
  }

  async appendEvent(input: {
    docKey: string;
    logicalName: string;
    terminal?: string;
    client?: string;
    source?: string;
    mergeStrategy?: string;
    localAction: string;
    pushed: boolean;
    hasConflict: boolean;
    remoteVariantCount: number;
    mergedFromTerminals?: string[];
    backupPath?: string | null;
    targetPath?: string | null;
    contentHash?: string | null;
    summary?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ProfileSyncEventRecord> {
    await this.init();
    const pool = this.getPool();
    const schema = escapeIdentifier(this.config.schema);
    const table = escapeIdentifier("profile_sync_events");
    const result = await pool.query<ProfileSyncEventRow>(`
      INSERT INTO ${schema}.${table} (
        doc_key, logical_name, terminal, client, source, merge_strategy,
        local_action, pushed, has_conflict, remote_variant_count, merged_from_terminals,
        backup_path, target_path, content_hash, summary, metadata
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16::jsonb
      )
      RETURNING
        id, doc_key, logical_name, terminal, client, source, merge_strategy, local_action, pushed,
        has_conflict, remote_variant_count, merged_from_terminals, backup_path, target_path, content_hash,
        summary, metadata, created_at
    `, [
      input.docKey,
      input.logicalName,
      input.terminal || null,
      input.client || null,
      input.source || null,
      input.mergeStrategy || null,
      input.localAction,
      input.pushed,
      input.hasConflict,
      Math.max(0, Math.trunc(input.remoteVariantCount || 0)),
      JSON.stringify(input.mergedFromTerminals || []),
      input.backupPath || null,
      input.targetPath || null,
      input.contentHash || null,
      input.summary || null,
      JSON.stringify(input.metadata || {}),
    ]);
    return toRecord(result.rows[0]);
  }

  async list(options?: {
    limit?: number;
    onlyConflicts?: boolean;
    docKey?: string;
  }): Promise<ProfileSyncEventRecord[]> {
    await this.init();
    const pool = this.getPool();
    const schema = escapeIdentifier(this.config.schema);
    const table = escapeIdentifier("profile_sync_events");
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options?.onlyConflicts) {
      params.push(true);
      clauses.push(`has_conflict = $${params.length}`);
    }
    if (options?.docKey) {
      params.push(options.docKey);
      clauses.push(`doc_key = $${params.length}`);
    }
    params.push(Math.max(1, Math.min(200, Math.trunc(options?.limit || 20))));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query<ProfileSyncEventRow>(`
      SELECT
        id, doc_key, logical_name, terminal, client, source, merge_strategy, local_action, pushed,
        has_conflict, remote_variant_count, merged_from_terminals, backup_path, target_path, content_hash,
        summary, metadata, created_at
      FROM ${schema}.${table}
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}
    `, params);
    return result.rows.map(toRecord);
  }
}
