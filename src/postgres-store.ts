import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { buildSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";
import type { PostgresConnectionConfig, ResolvedPostgresConfig } from "./postgres-config.js";
import { hasUsablePostgresConfig, resolvePostgresConfig } from "./postgres-config.js";
import type { RuntimeDimensions } from "./runtime-dimensions.js";
import { getRuntimeDimensions } from "./runtime-dimensions.js";

export interface MemoryEntry {
  id: string;
  text: string;
  vector: number[];
  category: "preference" | "fact" | "decision" | "entity" | "other" | "reflection";
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface MetadataPatch {
  [key: string]: unknown;
}

export interface PostgresStoreConfig {
  dbPath: string;
  vectorDim: number;
  postgres?: PostgresConnectionConfig;
}

type JsonRow = Record<string, unknown>;
type FilterField = "terminal" | "client";
type QueryParams = unknown[];
const HALF_VECTOR_MAX_DIMENSIONS = 4000;
const FULL_VECTOR_HNSW_MAX_DIMENSIONS = 2000;
const HALF_VECTOR_CANDIDATE_MULTIPLIER = 20;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isExplicitDenyAllScopeFilter(scopeFilter?: string[]): boolean {
  return Array.isArray(scopeFilter) && scopeFilter.length === 0;
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => Number(value)).join(",")}]`;
}

function rowToEntry(row: JsonRow, includeVector = true): MemoryEntry {
  const rawVector = row.vector;
  let vector: number[] = [];
  if (includeVector) {
    if (Array.isArray(rawVector)) {
      vector = rawVector.map((value) => Number(value));
    } else if (typeof rawVector === "string") {
      vector = rawVector
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .filter(Boolean)
        .map((value) => Number(value.trim()));
    }
  }

  return {
    id: String(row.id),
    text: String(row.text ?? ""),
    vector,
    category: (row.category as MemoryEntry["category"]) || "other",
    scope: typeof row.scope === "string" && row.scope ? row.scope : "global",
    importance: Number(row.importance ?? 0),
    timestamp: Number(row.timestamp ?? 0),
    metadata:
      typeof row.metadata === "string"
        ? row.metadata
        : JSON.stringify(row.metadata ?? {}),
  };
}

function addParam(params: QueryParams, value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function buildScopeClause(params: QueryParams, scopeFilter?: string[]): string {
  if (!scopeFilter || scopeFilter.length === 0) return "";
  return ` AND scope = ANY(${addParam(params, scopeFilter)}::text[])`;
}

function buildDimensionClause(
  params: QueryParams,
  field: FilterField,
  value: string | undefined,
  mode: "off" | "prefer" | "strict",
): string {
  if (!value || mode === "off") return "";
  const ref = addParam(params, value);
  if (mode === "strict") {
    return ` AND ${field} = ${ref}`;
  }
  return ` AND (${field} IS NULL OR ${field} = '' OR ${field} = ${ref})`;
}

function buildInactiveClause(params: QueryParams, excludeInactive: boolean): string {
  if (!excludeInactive) return "";
  const nowRef = addParam(params, Date.now());
  return ` AND COALESCE((metadata->>'valid_to')::bigint, 9223372036854775807) >= ${nowRef}::bigint`;
}

function buildRuntimeMetadataDimensions(
  metadata: string | undefined,
  runtimeDimensions: RuntimeDimensions | undefined,
): string {
  const base = metadata && metadata.trim() ? metadata : "{}";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(base);
  } catch {
    parsed = {};
  }

  if (runtimeDimensions?.terminal) {
    parsed.terminal = runtimeDimensions.terminal;
  }
  if (runtimeDimensions?.client) {
    parsed.client = runtimeDimensions.client;
  }
  if (runtimeDimensions?.sessionKey) {
    parsed.session_key = runtimeDimensions.sessionKey;
  }

  return JSON.stringify(parsed);
}

function supportsFullVectorHnsw(vectorDim: number): boolean {
  return vectorDim <= FULL_VECTOR_HNSW_MAX_DIMENSIONS;
}

function supportsHalfVectorHnsw(vectorDim: number): boolean {
  return vectorDim > FULL_VECTOR_HNSW_MAX_DIMENSIONS && vectorDim <= HALF_VECTOR_MAX_DIMENSIONS;
}

export class PostgresMemoryStore {
  readonly backend = "postgres";
  readonly dbPath: string;
  readonly config: ResolvedPostgresConfig;
  readonly vectorDim: number;
  private pool: Pool | null = null;
  private initPromise: Promise<void> | null = null;
  private _lastFtsError: string | null = null;
  private extensions = {
    vector: false,
    pgSearch: false,
  };
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(config: PostgresStoreConfig) {
    this.dbPath = config.dbPath;
    this.vectorDim = config.vectorDim;
    this.config = resolvePostgresConfig(config.postgres);
  }

  static canUse(config: PostgresStoreConfig): boolean {
    return config.postgres !== undefined &&
      hasUsablePostgresConfig(resolvePostgresConfig(config.postgres));
  }

  get hasFtsSupport(): boolean {
    return this.extensions.pgSearch;
  }

  get lastFtsError(): string | null {
    return this._lastFtsError;
  }

  getFtsStatus(): { available: boolean; lastError: string | null } {
    return {
      available: this.extensions.pgSearch,
      lastError: this._lastFtsError,
    };
  }

  private getPool(): Pool {
    if (this.pool) return this.pool;

    const poolConfig = this.config.connectionString
      ? {
        connectionString: this.config.connectionString,
      }
      : {
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
      };

    const ssl = normalizeSslMode(this.config.sslmode);
    this.pool = new Pool({
      ...poolConfig,
      ssl,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "sync-claw-cloud",
    });
    return this.pool;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.doInitialize().catch((error) => {
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    if (!PostgresMemoryStore.canUse({ dbPath: this.dbPath, vectorDim: this.vectorDim, postgres: this.config })) {
      throw new Error(
        "PostgreSQL backend selected but no usable PostgreSQL configuration was found. " +
        "Set SYNC_CLAW_CLOUD_DATABASE_URL or POSTGRES_HOST/POSTGRES_DB/POSTGRES_USER.",
      );
    }

    const extensionRows = await this.query<JsonRow>(
      `
        SELECT extname
        FROM pg_extension
        WHERE extname IN ('vector', 'pg_search')
        ORDER BY extname
      `,
    );

    const installed = new Set(extensionRows.map((row) => String(row.extname)));
    this.extensions.vector = installed.has("vector");
    this.extensions.pgSearch = installed.has("pg_search");

    if (!this.extensions.vector) {
      throw new Error(
        "PostgreSQL extension 'vector' is not installed. Main path requires pgvector. " +
        "Install it or enable postgres.fallbackToLanceDb explicitly.",
      );
    }

    if (!this.extensions.pgSearch) {
      throw new Error(
        "PostgreSQL extension 'pg_search' is not installed. Main path requires ParadeDB pg_search. " +
        "Install it or enable postgres.fallbackToLanceDb explicitly.",
      );
    }

    if (this.config.initOnStart) {
      await this.initializeSchema();
    }
  }

  private async initializeSchema(): Promise<void> {
    const schema = escapeIdentifier(this.config.schema);
    const table = escapeIdentifier(this.config.tableName);
    const scopeTimestampIndex = escapeIdentifier(`${this.config.tableName}_scope_timestamp_idx`);
    const terminalIndex = escapeIdentifier(`${this.config.tableName}_terminal_idx`);
    const clientIndex = escapeIdentifier(`${this.config.tableName}_client_idx`);
    const vectorIndex = escapeIdentifier(`${this.config.tableName}_vector_cosine_idx`);
    const halfvecIndex = escapeIdentifier(`${this.config.tableName}_halfvec_cosine_idx`);
    await this.execSql(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE IF NOT EXISTS ${schema}.${table} (
        id text PRIMARY KEY,
        text text NOT NULL,
        vector vector(${this.vectorDim}) NOT NULL,
        category text NOT NULL,
        scope text NOT NULL DEFAULT 'global',
        importance double precision NOT NULL,
        timestamp bigint NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        terminal text,
        client text,
        session_key text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ${scopeTimestampIndex}
        ON ${schema}.${table} (scope, timestamp DESC);
      CREATE INDEX IF NOT EXISTS ${terminalIndex}
        ON ${schema}.${table} (terminal);
      CREATE INDEX IF NOT EXISTS ${clientIndex}
        ON ${schema}.${table} (client);
    `);

    if (supportsFullVectorHnsw(this.vectorDim)) {
      await this.execSql(`
        CREATE INDEX IF NOT EXISTS ${vectorIndex}
          ON ${schema}.${table}
          USING hnsw (vector vector_cosine_ops);
      `);
    } else if (supportsHalfVectorHnsw(this.vectorDim)) {
      await this.execSql(`
        CREATE INDEX IF NOT EXISTS ${halfvecIndex}
          ON ${schema}.${table}
          USING hnsw ((vector::halfvec(${this.vectorDim})) halfvec_cosine_ops);
      `);
    }

    try {
      const bm25Index = escapeIdentifier(`${this.config.tableName}_bm25_idx`);
      await this.execSql(`
        CREATE INDEX IF NOT EXISTS ${bm25Index}
          ON ${schema}.${table}
          USING bm25 (
            id,
            text,
            category,
            scope,
            terminal,
            client
          )
          WITH (key_field = 'id');
      `);
      this._lastFtsError = null;
    } catch (error) {
      this._lastFtsError = error instanceof Error ? error.message : String(error);
      throw new Error(`pg_search BM25 index initialization failed: ${this._lastFtsError}`);
    }
  }

  async rebuildFtsIndex(): Promise<{ success: boolean; error?: string }> {
    await this.ensureInitialized();
    try {
      const schema = escapeIdentifier(this.config.schema);
      const table = escapeIdentifier(this.config.tableName);
      const bm25Index = escapeIdentifier(`${this.config.tableName}_bm25_idx`);
      await this.execSql(`
        DROP INDEX IF EXISTS ${schema}.${bm25Index};
        CREATE INDEX ${bm25Index}
          ON ${schema}.${table}
          USING bm25 (
            id,
            text,
            category,
            scope,
            terminal,
            client
          )
          WITH (key_field = 'id');
      `);
      this._lastFtsError = null;
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._lastFtsError = message;
      return { success: false, error: message };
    }
  }

  async store(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<MemoryEntry> {
    return this.importEntry({
      ...entry,
      id: randomUUID(),
      timestamp: Date.now(),
      metadata: entry.metadata || "{}",
    });
  }

  async importEntry(entry: MemoryEntry): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const vector = entry.vector || [];
    if (!Array.isArray(vector) || vector.length !== this.vectorDim) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.vectorDim}, got ${Array.isArray(vector) ? vector.length : "non-array"}`,
      );
    }

    const full: MemoryEntry = {
      ...entry,
      scope: entry.scope || "global",
      importance: Number.isFinite(entry.importance) ? entry.importance : 0.7,
      timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
      metadata: buildRuntimeMetadataDimensions(entry.metadata, this.getActiveDimensions()),
    };

    const schema = escapeIdentifier(this.config.schema);
    const table = escapeIdentifier(this.config.tableName);
    const dims = this.getActiveDimensions();

    await this.execSql(
      `
        INSERT INTO ${schema}.${table} (
          id, text, vector, category, scope, importance, timestamp, metadata, terminal, client, session_key
        ) VALUES (
          $1, $2, $3::vector, $4, $5, $6, $7, $8::jsonb, $9, $10, $11
        )
        ON CONFLICT (id) DO UPDATE SET
          text = EXCLUDED.text,
          vector = EXCLUDED.vector,
          category = EXCLUDED.category,
          scope = EXCLUDED.scope,
          importance = EXCLUDED.importance,
          timestamp = EXCLUDED.timestamp,
          metadata = EXCLUDED.metadata,
          terminal = EXCLUDED.terminal,
          client = EXCLUDED.client,
          session_key = EXCLUDED.session_key
      `,
      [
        full.id,
        full.text,
        vectorLiteral(full.vector),
        full.category,
        full.scope,
        Number(full.importance),
        Math.trunc(full.timestamp),
        full.metadata || "{}",
        dims?.terminal ?? null,
        dims?.client ?? null,
        dims?.sessionKey ?? null,
      ],
    );

    return full;
  }

  async hasId(id: string): Promise<boolean> {
    await this.ensureInitialized();
    const rows = await this.query(
      `
        SELECT id
        FROM ${escapeIdentifier(this.config.schema)}.${escapeIdentifier(this.config.tableName)}
        WHERE id = $1
        LIMIT 1
      `,
      [id],
    );
    return rows.length > 0;
  }

  async getById(id: string, scopeFilter?: string[]): Promise<MemoryEntry | null> {
    await this.ensureInitialized();
    if (isExplicitDenyAllScopeFilter(scopeFilter)) return null;
    const dims = this.getActiveDimensions();
    const params: QueryParams = [id];

    const rows = await this.query<JsonRow>(
      `
        SELECT id, text, vector::text AS vector, category, scope, importance, timestamp, metadata
        FROM ${escapeIdentifier(this.config.schema)}.${escapeIdentifier(this.config.tableName)}
        WHERE id = $1
          ${buildScopeClause(params, scopeFilter)}
          ${buildDimensionClause(params, "terminal", dims?.terminal, this.config.terminalFilterMode)}
          ${buildDimensionClause(params, "client", dims?.client, this.config.clientFilterMode)}
        LIMIT 1
      `,
      params,
    );
    return rows.length > 0 ? rowToEntry(rows[0]) : null;
  }

  async vectorSearch(
    vector: number[],
    limit = 5,
    minScore = 0.3,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean },
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();
    if (isExplicitDenyAllScopeFilter(scopeFilter)) return [];

    if (supportsHalfVectorHnsw(this.vectorDim)) {
      return this.vectorSearchWithHalfvecIndex(vector, limit, minScore, scopeFilter, options);
    }

    const dims = this.getActiveDimensions();
    const params: QueryParams = [vectorLiteral(vector)];
    const limitRef = addParam(params, clampInt(limit * 10, 1, 200));

    const rows = await this.query<JsonRow>(
      `
        SELECT
          id,
          text,
          vector::text AS vector,
          category,
          scope,
          importance,
          timestamp,
          metadata,
          GREATEST(0, 1 - (vector <=> $1::vector)) AS score
        FROM ${escapeIdentifier(this.config.schema)}.${escapeIdentifier(this.config.tableName)}
        WHERE TRUE
          ${buildScopeClause(params, scopeFilter)}
          ${buildDimensionClause(params, "terminal", dims?.terminal, this.config.terminalFilterMode)}
          ${buildDimensionClause(params, "client", dims?.client, this.config.clientFilterMode)}
          ${buildInactiveClause(params, options?.excludeInactive ?? false)}
        ORDER BY vector <=> $1::vector
        LIMIT ${limitRef}
      `,
      params,
    );

    return rows
      .map((row) => ({
        entry: rowToEntry(row),
        score: Number(row.score ?? 0),
      }))
      .filter((row) => row.score >= minScore)
      .slice(0, clampInt(limit, 1, 20));
  }

  private async vectorSearchWithHalfvecIndex(
    vector: number[],
    limit: number,
    minScore: number,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean },
  ): Promise<MemorySearchResult[]> {
    const dims = this.getActiveDimensions();
    const params: QueryParams = [vectorLiteral(vector)];
    const candidateLimitRef = addParam(
      params,
      clampInt(limit * HALF_VECTOR_CANDIDATE_MULTIPLIER, 20, 400),
    );
    const finalLimitRef = addParam(params, clampInt(limit, 1, 20));

    const rows = await this.query<JsonRow>(
      `
        WITH candidates AS MATERIALIZED (
          SELECT
            id,
            text,
            vector,
            category,
            scope,
            importance,
            timestamp,
            metadata
          FROM ${escapeIdentifier(this.config.schema)}.${escapeIdentifier(this.config.tableName)}
          WHERE TRUE
            ${buildScopeClause(params, scopeFilter)}
            ${buildDimensionClause(params, "terminal", dims?.terminal, this.config.terminalFilterMode)}
            ${buildDimensionClause(params, "client", dims?.client, this.config.clientFilterMode)}
            ${buildInactiveClause(params, options?.excludeInactive ?? false)}
          ORDER BY vector::halfvec(${this.vectorDim}) <=> $1::halfvec(${this.vectorDim})
          LIMIT ${candidateLimitRef}
        )
        SELECT
          id,
          text,
          vector::text AS vector,
          category,
          scope,
          importance,
          timestamp,
          metadata,
          GREATEST(0, 1 - (vector <=> $1::vector)) AS score
        FROM candidates
        ORDER BY vector <=> $1::vector
        LIMIT ${finalLimitRef}
      `,
      params,
    );

    return rows
      .map((row) => ({
        entry: rowToEntry(row),
        score: Number(row.score ?? 0),
      }))
      .filter((row) => row.score >= minScore);
  }

  async bm25Search(
    query: string,
    limit = 5,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean },
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();
    if (isExplicitDenyAllScopeFilter(scopeFilter)) return [];
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];
    const dims = this.getActiveDimensions();
    const params: QueryParams = [trimmedQuery];
    const limitRef = addParam(params, clampInt(limit * 10, 1, 200));

    const rows = await this.query<JsonRow>(
      `
        SELECT
          id,
          text,
          vector::text AS vector,
          category,
          scope,
          importance,
          timestamp,
          metadata,
          paradedb.score(id) AS score
        FROM ${escapeIdentifier(this.config.schema)}.${escapeIdentifier(this.config.tableName)}
        WHERE text ||| $1
          ${buildScopeClause(params, scopeFilter)}
          ${buildDimensionClause(params, "terminal", dims?.terminal, this.config.terminalFilterMode)}
          ${buildDimensionClause(params, "client", dims?.client, this.config.clientFilterMode)}
          ${buildInactiveClause(params, options?.excludeInactive ?? false)}
        ORDER BY score DESC, timestamp DESC
        LIMIT ${limitRef}
      `,
      params,
    );

    return rows.slice(0, clampInt(limit, 1, 20)).map((row) => ({
      entry: rowToEntry(row),
      score: normalizeBm25Score(Number(row.score ?? 0)),
    }));
  }

  async delete(id: string, scopeFilter?: string[]): Promise<boolean> {
    await this.ensureInitialized();
    if (isExplicitDenyAllScopeFilter(scopeFilter)) {
      throw new Error(`Memory ${id} is outside accessible scopes`);
    }

    const existing = await this.getById(id, scopeFilter);
    if (!existing) return false;

    await this.execSql(
      `
        DELETE FROM ${escapeIdentifier(this.config.schema)}.${escapeIdentifier(this.config.tableName)}
        WHERE id = $1
      `,
      [existing.id],
    );
    return true;
  }

  async list(
    scopeFilter?: string[],
    category?: string,
    limit = 20,
    offset = 0,
  ): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    if (isExplicitDenyAllScopeFilter(scopeFilter)) return [];
    const dims = this.getActiveDimensions();
    const params: QueryParams = [];
    let categoryClause = "";
    if (category) {
      categoryClause = ` AND category = ${addParam(params, category)}`;
    }
    const limitRef = addParam(params, Math.max(1, Math.trunc(limit)));
    const offsetRef = addParam(params, Math.max(0, Math.trunc(offset)));

    const rows = await this.query<JsonRow>(
      `
        SELECT id, text, category, scope, importance, timestamp, metadata
        FROM ${escapeIdentifier(this.config.schema)}.${escapeIdentifier(this.config.tableName)}
        WHERE TRUE
          ${buildScopeClause(params, scopeFilter)}
          ${categoryClause}
          ${buildDimensionClause(params, "terminal", dims?.terminal, this.config.terminalFilterMode)}
          ${buildDimensionClause(params, "client", dims?.client, this.config.clientFilterMode)}
        ORDER BY timestamp DESC
        LIMIT ${limitRef}
        OFFSET ${offsetRef}
      `,
      params,
    );
    return rows.map((row) => rowToEntry(row, false));
  }

  async stats(scopeFilter?: string[]): Promise<{
    totalCount: number;
    scopeCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
  }> {
    await this.ensureInitialized();
    if (isExplicitDenyAllScopeFilter(scopeFilter)) {
      return { totalCount: 0, scopeCounts: {}, categoryCounts: {} };
    }
    const dims = this.getActiveDimensions();
    const params: QueryParams = [];

    const rows = await this.query<JsonRow>(
      `
        SELECT scope, category, COUNT(*) AS count
        FROM ${escapeIdentifier(this.config.schema)}.${escapeIdentifier(this.config.tableName)}
        WHERE TRUE
          ${buildScopeClause(params, scopeFilter)}
          ${buildDimensionClause(params, "terminal", dims?.terminal, this.config.terminalFilterMode)}
          ${buildDimensionClause(params, "client", dims?.client, this.config.clientFilterMode)}
        GROUP BY scope, category
      `,
      params,
    );

    const scopeCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};
    let totalCount = 0;
    for (const row of rows) {
      const count = Number(row.count ?? 0);
      const scope = typeof row.scope === "string" && row.scope ? row.scope : "global";
      const category = typeof row.category === "string" ? row.category : "other";
      scopeCounts[scope] = (scopeCounts[scope] || 0) + count;
      categoryCounts[category] = (categoryCounts[category] || 0) + count;
      totalCount += count;
    }

    return { totalCount, scopeCounts, categoryCounts };
  }

  async update(
    id: string,
    updates: {
      text?: string;
      vector?: number[];
      importance?: number;
      category?: MemoryEntry["category"];
      metadata?: string;
    },
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null> {
    await this.ensureInitialized();
    if (isExplicitDenyAllScopeFilter(scopeFilter)) {
      throw new Error(`Memory ${id} is outside accessible scopes`);
    }

    return this.runSerializedUpdate(async () => {
      const existing = await this.getById(id, scopeFilter);
      if (!existing) return null;
      const updated: MemoryEntry = {
        ...existing,
        text: updates.text ?? existing.text,
        vector: updates.vector ?? existing.vector,
        importance: updates.importance ?? existing.importance,
        category: updates.category ?? existing.category,
        metadata: buildRuntimeMetadataDimensions(updates.metadata ?? existing.metadata, this.getActiveDimensions()),
      };

      await this.importEntry(updated);
      return updated;
    });
  }

  async patchMetadata(
    id: string,
    patch: MetadataPatch,
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null> {
    const existing = await this.getById(id, scopeFilter);
    if (!existing) return null;
    const metadata = buildSmartMetadata(existing, patch);
    return this.update(id, { metadata: stringifySmartMetadata(metadata) }, scopeFilter);
  }

  async bulkDelete(scopeFilter: string[], beforeTimestamp?: number): Promise<number> {
    await this.ensureInitialized();
    const dims = this.getActiveDimensions();
    const countParams: QueryParams = [];
    let beforeClause = "";
    if (beforeTimestamp) {
      beforeClause = ` AND timestamp < ${addParam(countParams, Math.trunc(beforeTimestamp))}`;
    }

    const existing = await this.query<JsonRow>(
      `
        SELECT id
        FROM ${escapeIdentifier(this.config.schema)}.${escapeIdentifier(this.config.tableName)}
        WHERE TRUE
          ${buildScopeClause(countParams, scopeFilter)}
          ${beforeClause}
          ${buildDimensionClause(countParams, "terminal", dims?.terminal, this.config.terminalFilterMode)}
          ${buildDimensionClause(countParams, "client", dims?.client, this.config.clientFilterMode)}
      `,
      countParams,
    );
    if (existing.length === 0) return 0;

    const deleteParams: QueryParams = [];
    beforeClause = "";
    if (beforeTimestamp) {
      beforeClause = ` AND timestamp < ${addParam(deleteParams, Math.trunc(beforeTimestamp))}`;
    }

    await this.execSql(
      `
        DELETE FROM ${escapeIdentifier(this.config.schema)}.${escapeIdentifier(this.config.tableName)}
        WHERE TRUE
          ${buildScopeClause(deleteParams, scopeFilter)}
          ${beforeClause}
          ${buildDimensionClause(deleteParams, "terminal", dims?.terminal, this.config.terminalFilterMode)}
          ${buildDimensionClause(deleteParams, "client", dims?.client, this.config.clientFilterMode)}
      `,
      deleteParams,
    );
    return existing.length;
  }

  private async runSerializedUpdate<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.updateQueue;
    let release: (() => void) | undefined;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.updateQueue = previous.then(() => lock);
    await previous;
    try {
      return await action();
    } finally {
      release?.();
    }
  }

  private getActiveDimensions(): RuntimeDimensions | undefined {
    return getRuntimeDimensions();
  }

  private async execSql(sql: string, params: QueryParams = []): Promise<void> {
    await this.query(sql, params);
  }

  private async query<T extends JsonRow = JsonRow>(sql: string, params: QueryParams = []): Promise<T[]> {
    const pool = this.getPool();
    try {
      const result = await pool.query<T & QueryResultRow>(sql, params);
      return result.rows;
    } catch (error) {
      throw normalizePgError(error);
    }
  }
}

function normalizeBm25Score(rawScore: number): number {
  return rawScore > 0 ? 1 / (1 + Math.exp(-rawScore / 5)) : 0.5;
}

function escapeIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function normalizeSslMode(sslmode: string | undefined): false | { rejectUnauthorized: boolean } {
  const normalized = sslmode?.trim().toLowerCase();
  if (!normalized || normalized === "disable") {
    return false;
  }
  if (normalized === "require" || normalized === "preferred" || normalized === "prefer") {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

function normalizePgError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}
