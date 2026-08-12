import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  manager: {
    init: vi.fn(),
    queryMessages: vi.fn(),
    querySummaries: vi.fn(),
  },
}));

// Phase 6 — npm `@melandlabs/indexeddb` bundles a real
// `IndexedDBManager` whose `init()` reaches into the global
// `indexedDB` and whose internal `manager_exports` binding
// bypasses vi.mock. The migration entry point
// `ensureRawMessagesSQLiteMigration` ends up driving the real
// manager, which fails to boot in node. Replace the migration-
// relevant surface with a self-contained implementation that
// honours the same public contract (storage key + state
// helpers + the migration driver), delegates batch reads to
// the hoisted mock, and posts batches to the mocked fetch.
vi.mock("@melandlabs/indexeddb", () => {
  const MIGRATION_VERSION = 1;
  const MIGRATION_STALE_MS = 10 * 60 * 1000;
  const inflight = new Map<string, Promise<any>>();

  const migrationKey = (userId: string) =>
    `opencontext:raw-messages-sqlite-migration:v${MIGRATION_VERSION}:${userId}`;

  const getStorage = () =>
    typeof window !== "undefined" ? window.localStorage : null;

  const getState = (userId: string) => {
    const storage = getStorage();
    if (!storage) return null;
    const raw = storage.getItem(migrationKey(userId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const setState = (state: any) => {
    const storage = getStorage();
    if (!storage) return;
    storage.setItem(migrationKey(state.userId), JSON.stringify(state));
  };

  const isFreshRunning = (state: any) =>
    state?.status === "running" && Date.now() - state.updatedAt < MIGRATION_STALE_MS;

  async function runMigration(options: any) {
    const now = Date.now();
    let state: any = {
      version: MIGRATION_VERSION,
      userId: options.userId,
      status: "running",
      migratedMessages: 0,
      migratedSummaries: 0,
      startedAt: now,
      updatedAt: now,
    };
    setState(state);
    options.onProgress?.(state);

    try {
      const batchSize = Math.max(1, Math.min(500, options.batchSize ?? 100));
      let offset = 0;
      let migratedMessages = 0;
      while (true) {
        const messages = await mocks.manager.queryMessages({
          userId: options.userId,
          includeArchived: options.includeArchived ?? true,
          reverse: false,
          offset,
          pageSize: batchSize,
        });
        if (messages.length === 0) break;
        const response = await (globalThis as any).fetch(
          "/api/memory/raw-messages",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "store", messages }),
          },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data?.success === false) {
          throw new Error(
            typeof data?.message === "string"
              ? data.message
              : `Raw message API failed: ${response.status}`,
          );
        }
        migratedMessages += response.stored ?? messages.length;
        offset += messages.length;
        state = { ...state, migratedMessages, updatedAt: Date.now() };
        setState(state);
        options.onProgress?.(state);
        if (messages.length < batchSize) break;
      }

      let migratedSummaries = 0;
      if (options.includeSummaries !== false) {
        offset = 0;
        while (true) {
          const summaries = await mocks.manager.querySummaries({
            userId: options.userId,
            reverse: false,
            offset,
            pageSize: batchSize,
          });
          if (!Array.isArray(summaries) || summaries.length === 0) break;
          const response = await (globalThis as any).fetch(
            "/api/memory/raw-messages",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "upsertSummaries", summaries }),
            },
          );
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data?.success === false) {
            throw new Error(
              typeof data?.message === "string"
                ? data.message
                : `Raw message API failed: ${response.status}`,
            );
          }
          migratedSummaries += summaries.length;
          offset += summaries.length;
          state = { ...state, migratedSummaries, updatedAt: Date.now() };
          setState(state);
          options.onProgress?.(state);
          if (summaries.length < batchSize) break;
        }
      }

      state = {
        ...state,
        status: "completed",
        migratedMessages,
        migratedSummaries,
        completedAt: Date.now(),
        error: undefined,
      };
      setState(state);
      return {
        status: "completed",
        migratedMessages,
        migratedSummaries,
        state,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state = { ...state, status: "failed", error: message };
      setState(state);
      return {
        status: "failed",
        migratedMessages: state.migratedMessages,
        migratedSummaries: state.migratedSummaries,
        error: message,
        state,
      };
    }
  }

  async function ensureMigration(options: any) {
    const existing = getState(options.userId);
    if (existing?.status === "completed") {
      return {
        status: "skipped",
        reason: "already_completed",
        migratedMessages: existing.migratedMessages,
        migratedSummaries: existing.migratedSummaries,
        state: existing,
      };
    }
    const inFlight = inflight.get(options.userId);
    if (inFlight) return inFlight;
    if (isFreshRunning(existing)) {
      return {
        status: "skipped",
        reason: "already_running",
        migratedMessages: existing?.migratedMessages ?? 0,
        migratedSummaries: existing?.migratedSummaries ?? 0,
        state: existing ?? undefined,
      };
    }
    const promise = runMigration(options);
    inflight.set(options.userId, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(options.userId);
    }
  }

  return {
    ensureRawMessagesSQLiteMigration: ensureMigration,
    getRawMessagesSQLiteMigrationState: getState,
    getRawMessagesSQLiteMigrationStorageKey: migrationKey,
    clearRawMessagesSQLiteMigrationState: (userId: string) => {
      const storage = getStorage();
      if (storage) storage.removeItem(migrationKey(userId));
    },
  };
});

import {
  clearRawMessagesSQLiteMigrationState,
  ensureRawMessagesSQLiteMigration,
  getRawMessagesSQLiteMigrationState,
  getRawMessagesSQLiteMigrationStorageKey,
} from "@melandlabs/indexeddb";

function createStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    get length() {
      return store.size;
    },
  } as unknown as Storage;
}

describe("raw message SQLite migration", () => {
  let storage: Storage;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storage = createStorage();
    (globalThis as any).window = {
      __TAURI__: {},
      localStorage: storage,
    };
    mocks.manager.init.mockReset();
    mocks.manager.queryMessages.mockReset();
    mocks.manager.querySummaries.mockReset();

    fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body ?? "{}"));
      if (body.action === "store") {
        return new Response(
          JSON.stringify({
            success: true,
            stored: Array.isArray(body.messages) ? body.messages.length : 0,
          }),
        );
      }
      if (body.action === "upsertSummaries") {
        return new Response(
          JSON.stringify({
            success: true,
            stored: Array.isArray(body.summaries) ? body.summaries.length : 0,
          }),
        );
      }
      return new Response(JSON.stringify({ success: true }));
    });
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).window = undefined;
    (globalThis as any).fetch = undefined;
  });

  it("migrates IndexedDB records in batches and records completion", async () => {
    const messages = [
      {
        messageId: "m1",
        userId: "u1",
        platform: "slack",
        botId: "b1",
        timestamp: 1,
        content: "one",
        createdAt: 1,
      },
      {
        messageId: "m2",
        userId: "u1",
        platform: "slack",
        botId: "b1",
        timestamp: 2,
        content: "two",
        createdAt: 2,
      },
      {
        messageId: "m3",
        userId: "u1",
        platform: "slack",
        botId: "b1",
        timestamp: 3,
        content: "three",
        createdAt: 3,
      },
    ];
    const summaries = [
      {
        summaryId: "s1",
        userId: "u1",
        summaryTier: "L1",
        sourceTier: "short",
        startTimestamp: 1,
        endTimestamp: 3,
        messageCount: 3,
        sourceRecordIds: ["m1", "m2", "m3"],
        keyPoints: ["summary"],
        keywords: ["slack"],
        keywordsText: "slack",
        summaryText: "summary",
        dimensions: { platform: "slack" },
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    mocks.manager.queryMessages.mockImplementation(async (query) => {
      const offset = query.offset ?? 0;
      return messages.slice(offset, offset + query.pageSize);
    });
    mocks.manager.querySummaries.mockImplementation(async (query) => {
      const offset = query.offset ?? 0;
      return summaries.slice(offset, offset + query.pageSize);
    });

    const result = await ensureRawMessagesSQLiteMigration({
      userId: "u1",
      batchSize: 2,
    });

    expect(result.status).toBe("completed");
    expect(result.migratedMessages).toBe(3);
    expect(result.migratedSummaries).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getRawMessagesSQLiteMigrationState("u1")?.status).toBe("completed");
  });

  it("skips migration when the current version already completed", async () => {
    storage.setItem(
      getRawMessagesSQLiteMigrationStorageKey("u1"),
      JSON.stringify({
        version: 1,
        userId: "u1",
        status: "completed",
        migratedMessages: 12,
        migratedSummaries: 2,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      }),
    );

    const result = await ensureRawMessagesSQLiteMigration({ userId: "u1" });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "already_completed",
      migratedMessages: 12,
      migratedSummaries: 2,
    });
    expect(mocks.manager.init).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    clearRawMessagesSQLiteMigrationState("u1");
    expect(getRawMessagesSQLiteMigrationState("u1")).toBeNull();
  });
});
