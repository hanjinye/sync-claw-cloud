import { Pool, type QueryResultRow } from "pg";
import type { PostgresConnectionConfig, ResolvedPostgresConfig } from "./postgres-config.js";
import { hasUsablePostgresConfig, resolvePostgresConfig } from "./postgres-config.js";

export interface ConversationTurnEntry {
  participant: string;
  question: string;
  reply: string;
  terminal?: string;
  client?: string;
  sessionKey?: string;
  channelId?: string;
  conversationId?: string;
  accountId?: string;
  agentId?: string;
  userTimestamp?: number;
  assistantTimestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface ConversationTurnRecord extends ConversationTurnEntry {
  id: number;
  createdAt: string;
}

type ConversationRow = QueryResultRow & {
  id: number;
  participant: string;
  question: string;
  reply: string;
  terminal: string | null;
  client: string | null;
  session_key: string | null;
  channel_id: string | null;
  conversation_id: string | null;
  account_id: string | null;
  agent_id: string | null;
  user_timestamp: number | null;
  assistant_timestamp: number | null;
  metadata: string | Record<string, unknown> | null;
  created_at: string;
};

function escapeIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function parseMetadata(value: ConversationRow["metadata"]): Record<string, unknown> {
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

function toRecord(row: ConversationRow): ConversationTurnRecord {
  return {
    id: Number(row.id),
    participant: row.participant,
    question: row.question,
    reply: row.reply,
    terminal: row.terminal || undefined,
    client: row.client || undefined,
    sessionKey: row.session_key || undefined,
    channelId: row.channel_id || undefined,
    conversationId: row.conversation_id || undefined,
    accountId: row.account_id || undefined,
    agentId: row.agent_id || undefined,
    userTimestamp: Number.isFinite(Number(row.user_timestamp)) ? Number(row.user_timestamp) : undefined,
    assistantTimestamp: Number.isFinite(Number(row.assistant_timestamp)) ? Number(row.assistant_timestamp) : undefined,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
  };
}

export class ConversationLogStore {
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

  private async ensureInit(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.init();
    return this.initPromise;
  }

  async init(): Promise<void> {
    const pool = this.getPool();
    const schema = escapeIdentifier(this.config.schema);
    const table = escapeIdentifier("conversation_turns");
    const sessionIdx = escapeIdentifier("conversation_turns_session_idx");
    const terminalIdx = escapeIdentifier("conversation_turns_terminal_idx");
    const createdIdx = escapeIdentifier("conversation_turns_created_idx");
    const participantIdx = escapeIdentifier("conversation_turns_participant_idx");
    const bm25Idx = escapeIdentifier("conversation_turns_bm25_idx");

    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE IF NOT EXISTS ${schema}.${table} (
        id bigserial PRIMARY KEY,
        participant text NOT NULL,
        question text NOT NULL,
        reply text NOT NULL,
        terminal text,
        client text,
        session_key text,
        channel_id text,
        conversation_id text,
        account_id text,
        agent_id text,
        user_timestamp bigint,
        assistant_timestamp bigint,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ${sessionIdx}
        ON ${schema}.${table} (session_key);
      CREATE INDEX IF NOT EXISTS ${terminalIdx}
        ON ${schema}.${table} (terminal);
      CREATE INDEX IF NOT EXISTS ${participantIdx}
        ON ${schema}.${table} (participant);
      CREATE INDEX IF NOT EXISTS ${createdIdx}
        ON ${schema}.${table} (created_at DESC);
      CREATE INDEX IF NOT EXISTS ${bm25Idx}
        ON ${schema}.${table}
        USING bm25 (
          id,
          participant,
          question,
          reply,
          terminal,
          client,
          session_key
        )
        WITH (key_field = 'id');
    `);
  }

  async appendTurn(entry: ConversationTurnEntry): Promise<ConversationTurnRecord> {
    await this.ensureInit();
    const pool = this.getPool();
    const schema = escapeIdentifier(this.config.schema);
    const table = escapeIdentifier("conversation_turns");
    const result = await pool.query<ConversationRow>(`
      INSERT INTO ${schema}.${table} (
        participant,
        question,
        reply,
        terminal,
        client,
        session_key,
        channel_id,
        conversation_id,
        account_id,
        agent_id,
        user_timestamp,
        assistant_timestamp,
        metadata
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb
      )
      RETURNING
        id, participant, question, reply, terminal, client, session_key,
        channel_id, conversation_id, account_id, agent_id,
        user_timestamp, assistant_timestamp, metadata, created_at
    `, [
      entry.participant,
      entry.question,
      entry.reply,
      entry.terminal || null,
      entry.client || null,
      entry.sessionKey || null,
      entry.channelId || null,
      entry.conversationId || null,
      entry.accountId || null,
      entry.agentId || null,
      entry.userTimestamp || null,
      entry.assistantTimestamp || null,
      JSON.stringify(entry.metadata || {}),
    ]);
    return toRecord(result.rows[0]);
  }

  async list(options: {
    limit?: number;
    offset?: number;
    terminal?: string;
    participant?: string;
    sessionKey?: string;
  } = {}): Promise<ConversationTurnRecord[]> {
    await this.ensureInit();
    const pool = this.getPool();
    const schema = escapeIdentifier(this.config.schema);
    const table = escapeIdentifier("conversation_turns");
    const params: unknown[] = [];
    const where: string[] = [];
    if (options.terminal) {
      params.push(options.terminal);
      where.push(`terminal = $${params.length}`);
    }
    if (options.participant) {
      params.push(options.participant);
      where.push(`participant = $${params.length}`);
    }
    if (options.sessionKey) {
      params.push(options.sessionKey);
      where.push(`session_key = $${params.length}`);
    }
    params.push(Math.max(1, Math.min(200, Math.trunc(options.limit ?? 20))));
    params.push(Math.max(0, Math.trunc(options.offset ?? 0)));
    const result = await pool.query<ConversationRow>(`
      SELECT
        id, participant, question, reply, terminal, client, session_key,
        channel_id, conversation_id, account_id, agent_id,
        user_timestamp, assistant_timestamp, metadata, created_at
      FROM ${schema}.${table}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `, params);
    return result.rows.map(toRecord);
  }

  async search(query: string, limit = 20): Promise<ConversationTurnRecord[]> {
    await this.ensureInit();
    const pool = this.getPool();
    const schema = escapeIdentifier(this.config.schema);
    const table = escapeIdentifier("conversation_turns");
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const pattern = `%${query.trim()}%`;
    const result = await pool.query<ConversationRow>(`
      SELECT
        id, participant, question, reply, terminal, client, session_key,
        channel_id, conversation_id, account_id, agent_id,
        user_timestamp, assistant_timestamp, metadata, created_at
      FROM ${schema}.${table}
      WHERE participant ILIKE $1
        OR question ILIKE $1
        OR reply ILIKE $1
        OR terminal ILIKE $1
        OR session_key ILIKE $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `, [pattern, safeLimit]);
    return result.rows.map(toRecord);
  }

  async stats(): Promise<{
    totalCount: number;
    terminalCounts: Record<string, number>;
    participantCounts: Record<string, number>;
  }> {
    await this.ensureInit();
    const pool = this.getPool();
    const schema = escapeIdentifier(this.config.schema);
    const table = escapeIdentifier("conversation_turns");
    const total = await pool.query(`SELECT COUNT(*)::int AS count FROM ${schema}.${table}`);
    const terminals = await pool.query<{ key: string | null; count: number }>(`
      SELECT terminal AS key, COUNT(*)::int AS count
      FROM ${schema}.${table}
      GROUP BY terminal
      ORDER BY count DESC
      LIMIT 20
    `);
    const participants = await pool.query<{ key: string; count: number }>(`
      SELECT participant AS key, COUNT(*)::int AS count
      FROM ${schema}.${table}
      GROUP BY participant
      ORDER BY count DESC
      LIMIT 20
    `);
    return {
      totalCount: Number(total.rows[0]?.count || 0),
      terminalCounts: Object.fromEntries(terminals.rows.map((row) => [row.key || "<NULL>", Number(row.count)])),
      participantCounts: Object.fromEntries(participants.rows.map((row) => [row.key, Number(row.count)])),
    };
  }
}
