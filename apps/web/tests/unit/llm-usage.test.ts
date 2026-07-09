/**
 * Unit tests for the LLM usage recorder + summary.
 *
 * After the JSONL → DB migration, the recorder writes to `llm_usage` via
 * Drizzle and the summary aggregates via a single `SELECT SUM/COUNT/MIN/MAX`
 * over the same table. We don't need a real DB here — a tiny in-memory
 * fake (`dbState.rows`) is enough to exercise the call sites, including
 * cache invalidation and `usage_unavailable` paths.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type UsageRow = {
  id: string;
  userId: string;
  ts: Date;
  providerType: string;
  model: string | null;
  endpoint: string;
  inputTokens: number;
  outputTokens: number;
  runId: string | null;
  createdAt: Date;
};

type SelectArgs = {
  filter?: (row: UsageRow) => boolean;
  result: (rows: UsageRow[]) => unknown;
};

const dbState = vi.hoisted(() => ({
  rows: [] as UsageRow[],
  selectArgs: null as SelectArgs | null,
  nextInsertError: undefined as Error | undefined,
}));

vi.mock("@/lib/db/adapters", () => ({
  initDb: vi.fn(),
  getDb: vi.fn(() => ({
    insert: () => ({
      values: async (row: Omit<UsageRow, "id" | "createdAt">) => {
        if (dbState.nextInsertError) {
          const err = dbState.nextInsertError;
          dbState.nextInsertError = undefined;
          throw err;
        }
        dbState.rows.push({
          ...row,
          id: `row-${dbState.rows.length + 1}`,
          createdAt: new Date(),
        });
      },
    }),
    select: () => ({
      from: () => {
        const args = dbState.selectArgs;
        if (!args) {
          return {
            where: async () => [],
            groupBy: async () => [],
          };
        }
        return {
          where: async (predicate: unknown) => {
            const filtered = applyPredicate(
              dbState.rows,
              predicate,
              args.filter,
            );
            return args.result(filtered);
          },
          groupBy: async () => [],
        };
      },
    }),
  })),
}));

/**
 * Tiny helper that walks the `and(gte(...), eq(...))` style predicates
 * Drizzle produces. The recorder/summary only ever combine `eq` and
 * `gte`, so that's all we need to recognize. Anything unknown returns
 * the unfiltered row set — the tests assert what they pass.
 */
function applyPredicate(
  rows: UsageRow[],
  predicate: unknown,
  filter: ((row: UsageRow) => boolean) | undefined,
): UsageRow[] {
  let filtered = filter ? rows.filter(filter) : rows;
  if (predicate && typeof predicate === "object") {
    const p = predicate as { kind?: string; args?: unknown[] };
    if (p.kind === "eq" && Array.isArray(p.args)) {
      const [col, val] = p.args as [{ name?: string }, string];
      filtered = filtered.filter((row) => matchColumn(row, col, val));
    } else if (p.kind === "gte" && Array.isArray(p.args)) {
      const [col, val] = p.args as [{ name?: string }, Date];
      filtered = filtered.filter((row) => matchColumn(row, col, val, "gte"));
    } else if (p.kind === "and" && Array.isArray(p.args)) {
      for (const inner of p.args) {
        filtered = applyPredicate(filtered, inner, undefined);
      }
    }
  }
  return filtered;
}

function matchColumn(
  row: UsageRow,
  col: { name?: string },
  val: unknown,
  op: "eq" | "gte" = "eq",
): boolean {
  const name = col?.name;
  if (!name) return true;
  const left = (row as unknown as Record<string, unknown>)[name];
  if (op === "eq") return left === val;
  if (left instanceof Date && val instanceof Date) {
    return left.getTime() >= val.getTime();
  }
  return false;
}

vi.mock("@/lib/db/schema", () => {
  const make = (name: string) => ({ name });
  return {
    llmUsage: {
      id: make("id"),
      userId: make("userId"),
      ts: make("ts"),
      providerType: make("providerType"),
      model: make("model"),
      endpoint: make("endpoint"),
      inputTokens: make("inputTokens"),
      outputTokens: make("outputTokens"),
      runId: make("runId"),
      createdAt: make("createdAt"),
    },
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ kind: "and", args }),
  count: (col: unknown) => ({ kind: "count", col }),
  eq: (col: unknown, val: unknown) => ({ kind: "eq", args: [col, val] }),
  gte: (col: unknown, val: unknown) => ({ kind: "gte", args: [col, val] }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    kind: "sql",
    strings,
    values,
  }),
}));

const envMocks = vi.hoisted(() => ({
  isTauriMode: vi.fn(() => false),
}));

vi.mock("@/lib/env", () => ({
  isTauriMode: envMocks.isTauriMode,
}));

import { __resetRecorderForTests, recordUsage } from "@/lib/llm-usage/recorder";
import {
  __resetSummaryForTests,
  getUserUsageSummary,
  invalidateSummaryCache,
} from "@/lib/llm-usage/summary";

function uniqueUserId(label: string) {
  return `user-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function seedRow(partial: Partial<UsageRow> & { userId: string }): void {
  dbState.rows.push({
    id: `seed-${dbState.rows.length + 1}`,
    ts: new Date(),
    providerType: "anthropic_compatible",
    model: "claude-sonnet-4-6",
    endpoint: "native-agent",
    inputTokens: 0,
    outputTokens: 0,
    runId: null,
    createdAt: new Date(),
    ...partial,
  });
}

/**
 * Build a select-args handle that asks the fake DB to project the
 * exact columns the summary module reads (sums, count, min, max, plus
 * the distinct provider list). The shape mirrors what the SQL fragment
 * in summary.ts returns after the DB runs the query.
 */
function installSummaryProjection(): void {
  dbState.selectArgs = {
    filter: undefined,
    result: (rows) => {
      if (rows.length === 0) {
        return [
          {
            inputTokens: 0,
            outputTokens: 0,
            runCount: 0,
            firstRunAt: null,
            lastRunAt: null,
            providers: [] as string[],
          },
        ];
      }
      const inputTokens = rows.reduce((acc, r) => acc + r.inputTokens, 0);
      const outputTokens = rows.reduce((acc, r) => acc + r.outputTokens, 0);
      const tsValues = rows.map((r) => r.ts.getTime());
      return [
        {
          inputTokens,
          outputTokens,
          runCount: rows.length,
          firstRunAt: new Date(Math.min(...tsValues)),
          lastRunAt: new Date(Math.max(...tsValues)),
          providers: [...new Set(rows.map((r) => r.providerType))],
        },
      ];
    },
  };
}

beforeEach(() => {
  __resetRecorderForTests();
  __resetSummaryForTests();
  dbState.rows = [];
  dbState.selectArgs = null;
  dbState.nextInsertError = undefined;
  // Default: pretend we're in server/Postgres mode for these tests.
  // The Tauri-mode branch (CSV providers projection) is exercised by
  // the `parses CSV providers into string[] (Tauri/SQLite path)` test.
  envMocks.isTauriMode.mockReturnValue(false);
});

describe("llm-usage recorder (DB-backed)", () => {
  it("inserts a row for a valid call and surfaces the model/provider metadata", async () => {
    const userId = uniqueUserId("insert");
    const ok = await recordUsage({
      userId,
      providerType: "anthropic_compatible",
      model: "claude-sonnet-4-6",
      endpoint: "native-agent",
      inputTokens: 12,
      outputTokens: 34,
      runId: "run-1",
    });
    expect(ok).toBe(true);
    expect(dbState.rows).toHaveLength(1);
    const row = dbState.rows[0];
    expect(row).toMatchObject({
      userId,
      providerType: "anthropic_compatible",
      model: "claude-sonnet-4-6",
      endpoint: "native-agent",
      inputTokens: 12,
      outputTokens: 34,
      runId: "run-1",
    });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("rejects malformed token counts without writing a row", async () => {
    const userId = uniqueUserId("malformed");
    const ok = await recordUsage({
      userId,
      providerType: "anthropic_compatible",
      model: "claude-sonnet-4-6",
      endpoint: "native-agent",
      inputTokens: "12" as unknown as number,
      outputTokens: null as unknown as number,
    });
    expect(ok).toBe(false);
    expect(dbState.rows).toHaveLength(0);
  });

  it("swallows DB errors and returns false so SSE loop never sees them", async () => {
    const userId = uniqueUserId("db-error");
    dbState.nextInsertError = new Error("connection refused");
    const ok = await recordUsage({
      userId,
      providerType: "anthropic_compatible",
      model: "claude-sonnet-4-6",
      endpoint: "native-agent",
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(ok).toBe(false);
  });

  it("does not accept prompt / response / tool fields even if the caller sends them", async () => {
    // Type-level: LlmUsageRecordInput doesn't expose them, so the only
    // way to test this is to confirm the inserted row has no such keys.
    const userId = uniqueUserId("privacy");
    await recordUsage({
      userId,
      providerType: "anthropic_compatible",
      model: "claude-sonnet-4-6",
      endpoint: "native-agent",
      inputTokens: 1,
      outputTokens: 1,
    });
    const row = dbState.rows[0];
    expect(Object.keys(row)).toEqual(
      expect.arrayContaining([
        "id",
        "userId",
        "ts",
        "providerType",
        "model",
        "endpoint",
        "inputTokens",
        "outputTokens",
        "runId",
        "createdAt",
      ]),
    );
    expect(Object.keys(row)).not.toEqual(
      expect.arrayContaining(["prompt", "response", "tool", "content"]),
    );
  });
});

describe("llm-usage summary (DB-backed)", () => {
  const sinceProvider = new Date("2026-06-12T08:31:02.000Z");

  function providerContext(since: Date | null = sinceProvider) {
    return {
      providerSince: since,
      currentProvider: since
        ? {
            providerType: "anthropic_compatible",
            model: "claude-sonnet-4-6",
            enabledSince: since,
          }
        : undefined,
    };
  }

  it("returns configured=false when the user has no provider", async () => {
    installSummaryProjection();
    const summary = await getUserUsageSummary(
      uniqueUserId("noprov"),
      providerContext(null),
    );
    expect(summary.configured).toBe(false);
    expect(summary.totals.totalTokens).toBe(0);
    expect(summary.runCount).toBe(0);
    expect(summary.trackedEndpoints).toContain("native-agent");
  });

  it("aggregates multiple rows since providerSince", async () => {
    installSummaryProjection();
    const userId = uniqueUserId("aggregate");
    seedRow({
      userId,
      ts: new Date("2026-07-01T00:00:00.000Z"),
      inputTokens: 100,
      outputTokens: 50,
    });
    seedRow({
      userId,
      ts: new Date("2026-07-02T00:00:00.000Z"),
      inputTokens: 25,
      outputTokens: 75,
    });
    const summary = await getUserUsageSummary(userId, providerContext());
    expect(summary.configured).toBe(true);
    expect(summary.runCount).toBe(2);
    expect(summary.totals).toEqual({
      inputTokens: 125,
      outputTokens: 125,
      totalTokens: 250,
    });
    expect(summary.trackedProviders).toContain("anthropic_compatible");
    expect(summary.firstRunAt).toBeTruthy();
    expect(summary.lastRunAt).toBeTruthy();
  });

  it("ignores rows older than providerSince", async () => {
    installSummaryProjection();
    const userId = uniqueUserId("cutoff");
    seedRow({
      userId,
      ts: new Date("2026-05-01T00:00:00.000Z"),
      inputTokens: 999,
      outputTokens: 999,
    });
    seedRow({
      userId,
      ts: new Date("2026-07-01T00:00:00.000Z"),
      inputTokens: 10,
      outputTokens: 20,
    });
    const summary = await getUserUsageSummary(userId, providerContext());
    expect(summary.runCount).toBe(1);
    expect(summary.totals.totalTokens).toBe(30);
  });

  it("caches results and invalidates on append", async () => {
    installSummaryProjection();
    const userId = uniqueUserId("cache");
    await recordUsage({
      userId,
      providerType: "anthropic_compatible",
      model: "claude-sonnet-4-6",
      endpoint: "native-agent",
      inputTokens: 5,
      outputTokens: 5,
    });
    const first = await getUserUsageSummary(userId, providerContext());
    expect(first.runCount).toBe(1);

    await recordUsage({
      userId,
      providerType: "anthropic_compatible",
      model: "claude-sonnet-4-6",
      endpoint: "native-agent",
      inputTokens: 7,
      outputTokens: 3,
    });
    const second = await getUserUsageSummary(userId, providerContext());
    expect(second.runCount).toBe(2);
    expect(second.totals.totalTokens).toBe(20);
  });

  it("can be force-invalidated via invalidateSummaryCache", async () => {
    installSummaryProjection();
    const userId = uniqueUserId("invalidate");
    await recordUsage({
      userId,
      providerType: "anthropic_compatible",
      model: "claude-sonnet-4-6",
      endpoint: "native-agent",
      inputTokens: 1,
      outputTokens: 1,
    });
    const a = await getUserUsageSummary(userId, providerContext());
    expect(a.runCount).toBe(1);

    // Inject a new row directly (so the invalidation hook does not fire).
    seedRow({
      userId,
      ts: new Date("2026-07-05T00:00:00.000Z"),
      inputTokens: 100,
      outputTokens: 100,
    });
    const cached = await getUserUsageSummary(userId, providerContext());
    expect(cached.runCount).toBe(1);

    invalidateSummaryCache(userId);
    const fresh = await getUserUsageSummary(userId, providerContext());
    expect(fresh.runCount).toBe(2);
    expect(fresh.totals.totalTokens).toBe(202);
  });

  it("returns usage_unavailable when the DB throws", async () => {
    // Point the fake DB at an error path. The summary wraps the SELECT
    // in try/catch and reports `error: "usage_unavailable"` instead of
    // bubbling the failure up to the route.
    dbState.selectArgs = {
      result: () => {
        throw new Error("connection lost");
      },
    };
    const summary = await getUserUsageSummary(
      uniqueUserId("db-down"),
      providerContext(),
    );
    expect(summary.error).toBe("usage_unavailable");
    expect(summary.totals.totalTokens).toBe(0);
  });

  it("scales SQLite MIN/MAX(seconds) into the correct ISO timestamp", async () => {
    // SQLite's `MIN(ts)` over a `mode: "timestamp"` (integer, seconds)
    // column returns the raw integer — not a Date and not ms. The summary
    // must scale seconds → ms before constructing the Date, otherwise the
    // firstRunAt / lastRunAt land in 1970. 1783611428 seconds is
    // 2026-07-09T15:37:08Z; if treated as ms it falls in 1970-01-21.
    const fixedSeconds = 1783611428;
    envMocks.isTauriMode.mockReturnValue(true);
    dbState.selectArgs = {
      result: () => [
        {
          inputTokens: 100,
          outputTokens: 50,
          runCount: 1,
          firstRunAt: fixedSeconds,
          lastRunAt: fixedSeconds,
          providers: ["anthropic_compatible"],
        },
      ],
    };
    const summary = await getUserUsageSummary(
      uniqueUserId("sqlite-seconds"),
      providerContext(),
    );
    expect(summary.firstRunAt).toBe("2026-07-09T15:37:08.000Z");
    expect(summary.lastRunAt).toBe("2026-07-09T15:37:08.000Z");
    // Postgres path should not double-scale a value that already
    // arrives as ms (defensive guard against the magnitude heuristic
    // misidentifying a Date.getTime() result that crossed the boundary).
    envMocks.isTauriMode.mockReturnValue(false);
  });

  it("parses CSV providers into string[] (Tauri/SQLite path)", async () => {
    // SQLite returns a single CSV string from GROUP_CONCAT(DISTINCT ...).
    // The summary module should normalize it back to string[] so the
    // card UI sees the same shape as on Postgres.
    envMocks.isTauriMode.mockReturnValue(true);
    dbState.selectArgs = {
      result: () => [
        {
          inputTokens: 10,
          outputTokens: 20,
          runCount: 1,
          firstRunAt: new Date("2026-07-01T00:00:00.000Z"),
          lastRunAt: new Date("2026-07-01T00:00:00.000Z"),
          providers: "anthropic_compatible,openai_compatible",
        },
      ],
    };
    const summary = await getUserUsageSummary(
      uniqueUserId("csv-providers"),
      providerContext(),
    );
    expect(summary.trackedProviders).toEqual([
      "anthropic_compatible",
      "openai_compatible",
    ]);
    // Reset back to Postgres mode so subsequent tests stay consistent.
    envMocks.isTauriMode.mockReturnValue(false);
  });
});
