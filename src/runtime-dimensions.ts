import { AsyncLocalStorage } from "node:async_hooks";

export interface RuntimeDimensions {
  terminal?: string;
  client?: string;
  sessionKey?: string;
}

const runtimeDimensionsStorage = new AsyncLocalStorage<RuntimeDimensions>();

export function extractRuntimeDimensions(
  input: Record<string, unknown> | undefined,
): RuntimeDimensions {
  const sessionKey = asString(input?.sessionKey);
  const channelId = asString(input?.channelId);
  const conversationId = asString(input?.conversationId);
  const accountId = asString(input?.accountId);
  const clientId = asString(input?.clientId);
  const terminalId = asString(input?.terminalId);

  const parsedSession = parseSessionKey(sessionKey);
  const client =
    clientId ||
    channelId ||
    parsedSession.client;
  const terminal =
    terminalId ||
    accountId ||
    joinSegments(channelId, conversationId) ||
    parsedSession.terminal;

  return {
    terminal,
    client,
    sessionKey,
  };
}

export function getRuntimeDimensions(): RuntimeDimensions | undefined {
  return runtimeDimensionsStorage.getStore();
}

export async function runWithRuntimeDimensions<T>(
  dimensions: RuntimeDimensions | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return runtimeDimensionsStorage.run(dimensions || {}, fn);
}

function parseSessionKey(sessionKey: string | undefined): { client?: string; terminal?: string } {
  if (!sessionKey) return {};
  const parts = sessionKey.trim().split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent") return {};
  if (parts.length === 3) {
    return { terminal: parts.slice(2).join(":") };
  }
  return {
    client: parts[2],
    terminal: parts.slice(2).join(":"),
  };
}

function joinSegments(...parts: Array<string | undefined>): string | undefined {
  const compact = parts.map((part) => part?.trim()).filter(Boolean) as string[];
  return compact.length > 0 ? compact.join(":") : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
