import type { PostgresConnectionConfig } from "./postgres-config.js";
import type { RuntimeDimensions } from "./runtime-dimensions.js";
import { LanceMemoryStore, loadLanceDB, validateStoragePath } from "./lancedb-store.js";
import {
  PostgresMemoryStore,
  type MemoryEntry,
  type MemorySearchResult,
  type MetadataPatch,
} from "./postgres-store.js";

export type { MemoryEntry, MemorySearchResult, MetadataPatch };
export { loadLanceDB, validateStoragePath };

export interface StoreConfig {
  dbPath: string;
  vectorDim: number;
  postgres?: PostgresConnectionConfig;
  runtimeDimensions?: RuntimeDimensions;
}

type StoreBackend = LanceMemoryStore | PostgresMemoryStore;

export class MemoryStore {
  private backend: StoreBackend;
  readonly dbPath: string;

  constructor(private readonly config: StoreConfig) {
    this.dbPath = config.dbPath;
    if (PostgresMemoryStore.canUse(config)) {
      this.backend = new PostgresMemoryStore(config);
      return;
    }
    this.backend = new LanceMemoryStore(config);
  }

  get backendName(): "postgres" | "lancedb" {
    return (this.backend as any).backend === "postgres" ? "postgres" : "lancedb";
  }

  get hasFtsSupport(): boolean {
    return this.backend.hasFtsSupport;
  }

  get lastFtsError(): string | null {
    return this.backend.lastFtsError;
  }

  getFtsStatus(): { available: boolean; lastError: string | null } {
    return this.backend.getFtsStatus();
  }

  async rebuildFtsIndex(): Promise<{ success: boolean; error?: string }> {
    return this.withBackend((backend) => backend.rebuildFtsIndex());
  }

  async store(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<MemoryEntry> {
    return this.withBackend((backend) => backend.store(entry));
  }

  async importEntry(entry: MemoryEntry): Promise<MemoryEntry> {
    return this.withBackend((backend) => backend.importEntry(entry));
  }

  async hasId(id: string): Promise<boolean> {
    return this.withBackend((backend) => backend.hasId(id));
  }

  async getById(id: string, scopeFilter?: string[]): Promise<MemoryEntry | null> {
    return this.withBackend((backend) => backend.getById(id, scopeFilter));
  }

  async vectorSearch(
    vector: number[],
    limit = 5,
    minScore = 0.3,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean },
  ): Promise<MemorySearchResult[]> {
    return this.withBackend((backend) => backend.vectorSearch(vector, limit, minScore, scopeFilter, options));
  }

  async bm25Search(
    query: string,
    limit = 5,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean },
  ): Promise<MemorySearchResult[]> {
    return this.withBackend((backend) => backend.bm25Search(query, limit, scopeFilter, options));
  }

  async delete(id: string, scopeFilter?: string[]): Promise<boolean> {
    return this.withBackend((backend) => backend.delete(id, scopeFilter));
  }

  async list(
    scopeFilter?: string[],
    category?: string,
    limit = 20,
    offset = 0,
  ): Promise<MemoryEntry[]> {
    return this.withBackend((backend) => backend.list(scopeFilter, category, limit, offset));
  }

  async stats(scopeFilter?: string[]): Promise<{
    totalCount: number;
    scopeCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
  }> {
    return this.withBackend((backend) => backend.stats(scopeFilter));
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
    return this.withBackend((backend) => backend.update(id, updates, scopeFilter));
  }

  async patchMetadata(
    id: string,
    patch: MetadataPatch,
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null> {
    return this.withBackend((backend) => backend.patchMetadata(id, patch, scopeFilter));
  }

  async bulkDelete(scopeFilter: string[], beforeTimestamp?: number): Promise<number> {
    return this.withBackend((backend) => backend.bulkDelete(scopeFilter, beforeTimestamp));
  }

  private async withBackend<T>(fn: (backend: StoreBackend) => Promise<T>): Promise<T> {
    try {
      return await fn(this.backend);
    } catch (error) {
      if (
        this.backendName === "postgres" &&
        this.config.postgres?.fallbackToLanceDb === true
      ) {
        this.backend = new LanceMemoryStore(this.config);
        return fn(this.backend);
      }
      throw error;
    }
  }
}
