export interface PostgresConnectionConfig {
  enabled?: boolean;
  psqlPath?: string;
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  schema?: string;
  sslmode?: string;
  tableName?: string;
  initOnStart?: boolean;
  fallbackToLanceDb?: boolean;
  terminalFilterMode?: "off" | "prefer" | "strict";
  clientFilterMode?: "off" | "prefer" | "strict";
}

export interface ResolvedPostgresConfig {
  enabled: boolean;
  psqlPath: string;
  schema: string;
  tableName: string;
  initOnStart: boolean;
  fallbackToLanceDb: boolean;
  terminalFilterMode: "off" | "prefer" | "strict";
  clientFilterMode: "off" | "prefer" | "strict";
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  sslmode?: string;
}

const DEFAULT_PSQL_CANDIDATES = [
  process.env.SYNC_CLAW_CLOUD_PSQL_PATH,
  process.env.MEMORY_LANCEDB_PRO_PSQL_PATH,
  "psql",
];

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? resolveEnvVars(trimmed) : undefined;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = resolveEnvVars(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function asInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") return undefined;
  const resolved = resolveEnvVars(value).trim();
  if (!resolved) return undefined;
  const parsed = Number(resolved);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function asMode(
  value: unknown,
  fallback: "off" | "prefer" | "strict",
): "off" | "prefer" | "strict" {
  const normalized = asString(value)?.toLowerCase();
  return normalized === "off" || normalized === "prefer" || normalized === "strict"
    ? normalized
    : fallback;
}

export function getDefaultPostgresConfig(): ResolvedPostgresConfig {
  return {
    enabled: true,
    psqlPath: DEFAULT_PSQL_CANDIDATES.find((candidate) => candidate && candidate.trim()) || "psql",
    schema:
      process.env.SYNC_CLAW_CLOUD_PGSCHEMA?.trim() ||
      process.env.POSTGRES_SCHEMA?.trim() ||
      "sync_claw_cloud",
    tableName:
      process.env.SYNC_CLAW_CLOUD_PGTABLE?.trim() ||
      process.env.POSTGRES_TABLE?.trim() ||
      "memories",
    initOnStart: true,
    fallbackToLanceDb: false,
    terminalFilterMode: "prefer",
    clientFilterMode: "prefer",
    connectionString:
      process.env.SYNC_CLAW_CLOUD_DATABASE_URL?.trim() ||
      process.env.POSTGRES_URL?.trim() ||
      process.env.POSTGRES_URI?.trim() ||
      process.env.DATABASE_URL?.trim() ||
      process.env.MEMORY_LANCEDB_PRO_DATABASE_URL?.trim(),
    host:
      process.env.SYNC_CLAW_CLOUD_PGHOST?.trim() ||
      process.env.POSTGRES_HOST?.trim() ||
      process.env.PGHOST?.trim(),
    port:
      asInt(process.env.SYNC_CLAW_CLOUD_PGPORT) ||
      asInt(process.env.POSTGRES_PORT) ||
      asInt(process.env.PGPORT),
    database:
      process.env.SYNC_CLAW_CLOUD_PGDATABASE?.trim() ||
      process.env.POSTGRES_DB?.trim() ||
      process.env.PGDATABASE?.trim(),
    user:
      process.env.SYNC_CLAW_CLOUD_PGUSER?.trim() ||
      process.env.POSTGRES_USER?.trim() ||
      process.env.PGUSER?.trim(),
    password:
      process.env.SYNC_CLAW_CLOUD_PGPASSWORD ||
      process.env.POSTGRES_PASSWORD ||
      process.env.PGPASSWORD ||
      process.env.MEMORY_LANCEDB_PRO_PGPASSWORD,
    sslmode:
      process.env.SYNC_CLAW_CLOUD_PGSSLMODE?.trim() ||
      process.env.POSTGRES_SSLMODE?.trim() ||
      process.env.PGSSLMODE?.trim(),
  };
}

export function resolvePostgresConfig(
  value: PostgresConnectionConfig | undefined,
): ResolvedPostgresConfig {
  const defaults = getDefaultPostgresConfig();
  return {
    enabled: asBool(value?.enabled) ?? defaults.enabled,
    psqlPath: asString(value?.psqlPath) || defaults.psqlPath,
    schema: asString(value?.schema) || defaults.schema,
    tableName: asString(value?.tableName) || defaults.tableName,
    initOnStart: asBool(value?.initOnStart) ?? defaults.initOnStart,
    fallbackToLanceDb: asBool(value?.fallbackToLanceDb) ?? defaults.fallbackToLanceDb,
    terminalFilterMode: asMode(value?.terminalFilterMode, defaults.terminalFilterMode),
    clientFilterMode: asMode(value?.clientFilterMode, defaults.clientFilterMode),
    connectionString: asString(value?.connectionString) || defaults.connectionString,
    host: asString(value?.host) || defaults.host,
    port: asInt(value?.port) || defaults.port,
    database: asString(value?.database) || defaults.database,
    user: asString(value?.user) || defaults.user,
    password: asString(value?.password) || defaults.password,
    sslmode: asString(value?.sslmode) || defaults.sslmode,
  };
}

export function hasUsablePostgresConfig(config: ResolvedPostgresConfig): boolean {
  if (!config.enabled) return false;
  if (config.connectionString) return true;
  return Boolean(config.host && config.database && config.user);
}

export function redactPostgresConfig(config: ResolvedPostgresConfig): Record<string, unknown> {
  return {
    ...config,
    connectionString: config.connectionString ? redactConnectionString(config.connectionString) : undefined,
    password: config.password ? "***" : undefined,
  };
}

function redactConnectionString(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return value.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:***@");
  }
}
