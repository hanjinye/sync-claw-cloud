import { createHash } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import type { PostgresConnectionConfig, ResolvedPostgresConfig } from "./postgres-config.js";
import { hasUsablePostgresConfig, resolvePostgresConfig } from "./postgres-config.js";

export interface ProfileDocumentRecord {
  id: number;
  docKey: string;
  logicalName: string;
  sourcePath: string;
  content: string;
  contentHash: string;
  terminal?: string;
  client?: string;
  sourceMtime?: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

type ProfileDocRow = QueryResultRow & {
  id: number;
  doc_key: string;
  logical_name: string;
  source_path: string;
  content: string;
  content_hash: string;
  terminal: string | null;
  client: string | null;
  source_mtime: number | null;
  metadata: string | Record<string, unknown> | null;
  created_at: string;
};

function escapeIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function parseMetadata(value: ProfileDocRow["metadata"]): Record<string, unknown> {
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

function toRecord(row: ProfileDocRow): ProfileDocumentRecord {
  return {
    id: Number(row.id),
    docKey: row.doc_key,
    logicalName: row.logical_name,
    sourcePath: row.source_path,
    content: row.content,
    contentHash: row.content_hash,
    terminal: row.terminal || undefined,
    client: row.client || undefined,
    sourceMtime: Number.isFinite(Number(row.source_mtime)) ? Number(row.source_mtime) : undefined,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
  };
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class ProfileDocStore {
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
    const table = escapeIdentifier("profile_documents");
    const docIdx = escapeIdentifier("profile_documents_doc_key_idx");
    const createdIdx = escapeIdentifier("profile_documents_created_idx");
    const terminalIdx = escapeIdentifier("profile_documents_terminal_idx");
    const hashIdx = escapeIdentifier("profile_documents_hash_idx");

    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE IF NOT EXISTS ${schema}.${table} (
        id bigserial PRIMARY KEY,
        doc_key text NOT NULL,
        logical_name text NOT NULL,
        source_path text NOT NULL,
        content text NOT NULL,
        content_hash text NOT NULL,
        terminal text,
        client text,
        source_mtime bigint,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ${docIdx}
        ON ${schema}.${table} (doc_key);
      CREATE INDEX IF NOT EXISTS ${createdIdx}
        ON ${schema}.${table} (created_at DESC);
      CREATE INDEX IF NOT EXISTS ${terminalIdx}
        ON ${schema}.${table} (terminal);
      CREATE INDEX IF NOT EXISTS ${hashIdx}
        ON ${schema}.${table} (content_hash);
    `);
  }

  async pushDocument(input: {
    docKey: string;
    logicalName: string;
    sourcePath: string;
    content: string;
    terminal?: string;
    client?: string;
    sourceMtime?: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ inserted: boolean; record: ProfileDocumentRecord }> {
    await this.init();
    const pool = this.getPool();
    const schema = escapeIdentifier(this.config.schema);
    const table = escapeIdentifier("profile_documents");
    const contentHash = sha256Text(input.content);

    const existing = await pool.query<ProfileDocRow>(`
      SELECT id, doc_key, logical_name, source_path, content, content_hash, terminal, client, source_mtime, metadata, created_at
      FROM ${schema}.${table}
      WHERE doc_key = $1
        AND content_hash = $2
        AND COALESCE(terminal, '') = COALESCE($3, '')
      ORDER BY id DESC
      LIMIT 1
    `, [input.docKey, contentHash, input.terminal || null]);

    if (existing.rows[0]) {
      return { inserted: false, record: toRecord(existing.rows[0]) };
    }

    const result = await pool.query<ProfileDocRow>(`
      INSERT INTO ${schema}.${table} (
        doc_key, logical_name, source_path, content, content_hash, terminal, client, source_mtime, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      RETURNING
        id, doc_key, logical_name, source_path, content, content_hash, terminal, client, source_mtime, metadata, created_at
    `, [
      input.docKey,
      input.logicalName,
      input.sourcePath,
      input.content,
      contentHash,
      input.terminal || null,
      input.client || null,
      input.sourceMtime || null,
      JSON.stringify(input.metadata || {}),
    ]);
    return { inserted: true, record: toRecord(result.rows[0]) };
  }

  async latestByDocKey(docKeys?: string[]): Promise<ProfileDocumentRecord[]> {
    await this.init();
    const pool = this.getPool();
    const schema = escapeIdentifier(this.config.schema);
    const table = escapeIdentifier("profile_documents");
    const params: unknown[] = [];
    let where = "";
    if (docKeys && docKeys.length > 0) {
      params.push(docKeys);
      where = `WHERE doc_key = ANY($1::text[])`;
    }
    const result = await pool.query<ProfileDocRow>(`
      SELECT DISTINCT ON (doc_key)
        id, doc_key, logical_name, source_path, content, content_hash, terminal, client, source_mtime, metadata, created_at
      FROM ${schema}.${table}
      ${where}
      ORDER BY doc_key, created_at DESC, id DESC
    `, params);
    return result.rows.map(toRecord);
  }

  async historyForDocKey(docKey: string, limit = 20): Promise<ProfileDocumentRecord[]> {
    await this.init();
    const pool = this.getPool();
    const schema = escapeIdentifier(this.config.schema);
    const table = escapeIdentifier("profile_documents");
    const result = await pool.query<ProfileDocRow>(`
      SELECT id, doc_key, logical_name, source_path, content, content_hash, terminal, client, source_mtime, metadata, created_at
      FROM ${schema}.${table}
      WHERE doc_key = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `, [docKey, Math.max(1, Math.min(100, Math.trunc(limit)))]);
    return result.rows.map(toRecord);
  }

  async latestVariantsByDocKey(docKeys?: string[]): Promise<ProfileDocumentRecord[]> {
    await this.init();
    const pool = this.getPool();
    const schema = escapeIdentifier(this.config.schema);
    const table = escapeIdentifier("profile_documents");
    const params: unknown[] = [];
    let where = "";
    if (docKeys && docKeys.length > 0) {
      params.push(docKeys);
      where = `WHERE doc_key = ANY($1::text[])`;
    }
    const result = await pool.query<ProfileDocRow>(`
      SELECT DISTINCT ON (doc_key, COALESCE(terminal, ''))
        id, doc_key, logical_name, source_path, content, content_hash, terminal, client, source_mtime, metadata, created_at
      FROM ${schema}.${table}
      ${where}
      ORDER BY doc_key, COALESCE(terminal, ''), created_at DESC, id DESC
    `, params);
    return result.rows.map(toRecord);
  }
}
