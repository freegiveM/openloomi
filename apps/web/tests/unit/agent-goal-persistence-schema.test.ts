import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import * as sqliteSchema from "@/lib/db/schema-sqlite";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const RUNTIME_TABLES = [
  ["agentRuntimeSessions", "agent_runtime_sessions"],
  ["agentGoals", "agent_goals"],
  ["agentGoalRuns", "agent_goal_runs"],
  ["agentRuntimeInstructions", "agent_runtime_instructions"],
  ["agentRuntimeDeliveries", "agent_runtime_deliveries"],
  ["agentGoalEvidence", "agent_goal_evidence"],
] as const;

type RuntimeTableExport = (typeof RUNTIME_TABLES)[number][0];

const REQUIRED_COLUMNS: Record<RuntimeTableExport, readonly string[]> = {
  agentRuntimeSessions: [
    "run_epoch",
    "last_instruction_sequence",
    "pending_operation",
  ],
  agentGoals: [
    "runtime_session_id",
    "slot",
    "slot_state",
    "revision",
    "goal_snapshot",
  ],
  agentGoalRuns: ["goal_id", "goal_revision", "run_epoch", "status"],
  agentRuntimeInstructions: [
    "sequence",
    "idempotency_key",
    "request_fingerprint",
    "command_order",
    "instruction_snapshot",
  ],
  agentRuntimeDeliveries: ["instruction_id", "goal_run_id", "state", "attempt"],
  agentGoalEvidence: ["goal_id", "goal_run_id", "source_event_id", "payload"],
};

const CRITICAL_UNIQUE_COLUMN_SETS = {
  agentRuntimeSessions: [["provider", "provider_session_id"]],
  agentGoals: [
    ["owner_id", "runtime_session_id"],
    ["owner_id", "runtime_session_id"],
  ],
  agentGoalRuns: [
    ["owner_id", "goal_id", "run_epoch"],
    ["owner_id", "runtime_session_id", "id", "run_epoch"],
  ],
  agentRuntimeInstructions: [
    ["owner_id", "runtime_session_id", "id", "run_epoch"],
    ["owner_id", "runtime_session_id", "sequence"],
    ["owner_id", "runtime_session_id", "idempotency_key", "command_order"],
    ["owner_id", "runtime_session_id"],
  ],
  agentRuntimeDeliveries: [["instruction_id", "attempt"], ["instruction_id"]],
  agentGoalEvidence: [["goal_run_id", "source_event_id"]],
} as const;

const EXPECTED_SQLITE_FOREIGN_KEYS: Record<
  (typeof RUNTIME_TABLES)[number][1],
  readonly string[]
> = {
  agent_runtime_sessions: ["User"],
  agent_goals: ["agent_runtime_sessions"],
  agent_goal_runs: ["agent_runtime_sessions", "agent_goals"],
  agent_runtime_instructions: ["agent_runtime_sessions", "agent_goals"],
  agent_runtime_deliveries: [
    "agent_runtime_sessions",
    "agent_runtime_instructions",
    "agent_goal_runs",
  ],
  agent_goal_evidence: [
    "agent_goals",
    "agent_goal_runs",
    "agent_runtime_instructions",
  ],
};

const CRITICAL_SQLITE_INDEXES = [
  "agent_goals_assigned_primary_idx",
  "agent_goals_reserved_primary_idx",
  "agent_goal_runs_owner_session_id_epoch_key",
  "agent_runtime_instructions_owner_session_id_epoch_key",
  "agent_runtime_instructions_sequence_key",
  "agent_runtime_instructions_idempotency_key",
  "agent_runtime_instructions_pending_command_idx",
  "agent_runtime_deliveries_attempt_key",
  "agent_runtime_deliveries_active_attempt_idx",
  "agent_goal_evidence_run_source_event_key",
] as const;

const SQLITE_MIGRATION_TAG = "0107_agent_goal_runtime";
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

function readWebFile(path: string): string {
  return readFileSync(join(WEB_ROOT, path), "utf8");
}

function readJournal(path: string): MigrationJournal {
  return JSON.parse(readWebFile(path)) as MigrationJournal;
}

interface MigrationJournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface MigrationJournal {
  entries: MigrationJournalEntry[];
}

interface TableConstraintMetadata {
  indexes: Array<{
    config: { name: string; unique: boolean; columns: unknown[] };
  }>;
  uniqueConstraints: Array<{ name: string; columns: unknown[] }>;
}

function columnName(column: unknown): string {
  if (
    typeof column === "object" &&
    column !== null &&
    "name" in column &&
    typeof column.name === "string"
  ) {
    return column.name;
  }
  throw new Error("Expected an index or constraint to use physical columns");
}

function uniqueColumnSets(config: unknown): string[][] {
  const { indexes, uniqueConstraints } = config as TableConstraintMetadata;
  return [
    ...indexes
      .filter((index) => index.config.unique)
      .map((index) => index.config.columns.map(columnName)),
    ...uniqueConstraints.map((constraint) =>
      constraint.columns.map(columnName),
    ),
  ];
}

function expectUniqueColumnSets(
  actual: string[][],
  expected: readonly (readonly string[])[],
): void {
  const remaining = actual.map((columns) => [...columns]);
  for (const expectedColumns of expected) {
    const match = remaining.findIndex(
      (columns) => JSON.stringify(columns) === JSON.stringify(expectedColumns),
    );
    expect(
      match,
      `Missing unique key on ${expectedColumns.join(", ")}`,
    ).toBeGreaterThanOrEqual(0);
    remaining.splice(match, 1);
  }
}

describe("Agent Goal persistence schema", () => {
  it("defines the required SQLite tables and columns", () => {
    for (const [exportName, physicalName] of RUNTIME_TABLES) {
      const sqlite = getSqliteTableConfig(sqliteSchema[exportName]);
      const sqliteColumns = sqlite.columns.map((column) => column.name).sort();

      expect(sqlite.name).toBe(physicalName);
      expect(sqliteColumns).toContain("id");
      expect(sqliteColumns).toContain("owner_id");
      expect(sqliteColumns).toEqual(
        expect.arrayContaining([...REQUIRED_COLUMNS[exportName]]),
      );
      expect(
        sqliteColumns.every((column) => /^[a-z][a-z0-9_]*$/.test(column)),
      ).toBe(true);
    }
  });

  it("defines the critical SQLite concurrency and deduplication keys", () => {
    for (const [exportName, expectedKeys] of Object.entries(
      CRITICAL_UNIQUE_COLUMN_SETS,
    ) as Array<
      [keyof typeof CRITICAL_UNIQUE_COLUMN_SETS, readonly (readonly string[])[]]
    >) {
      expectUniqueColumnSets(
        uniqueColumnSets(getSqliteTableConfig(sqliteSchema[exportName])),
        expectedKeys,
      );
    }
  });

  it("registers the SQLite migration in journal order", () => {
    const sqliteJournal = readJournal(
      "lib/db/migrations-sqlite/meta/_journal.json",
    );
    const sqliteIndex = sqliteJournal.entries.findIndex(
      ({ tag }) => tag === SQLITE_MIGRATION_TAG,
    );
    const sqliteEntry = sqliteJournal.entries[sqliteIndex];

    expect(sqliteIndex).toBeGreaterThan(0);
    expect(sqliteEntry).toMatchObject({
      idx: 35,
      version: "7",
      tag: SQLITE_MIGRATION_TAG,
      breakpoints: true,
    });
    expect(sqliteEntry?.when).toBeGreaterThan(
      sqliteJournal.entries[sqliteIndex - 1]?.when ?? Number.NEGATIVE_INFINITY,
    );

    const migration = readMigrationFiles({
      migrationsFolder: join(WEB_ROOT, "lib/db/migrations-sqlite"),
    })[sqliteIndex];
    expect(migration?.folderMillis).toBe(sqliteEntry?.when);
    expect(migration?.bps).toBe(true);
    expect(migration?.sql.length).toBeGreaterThan(1);
  });

  it("applies the SQLite migration idempotently with its foreign keys", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec('CREATE TABLE "User" ("id" text PRIMARY KEY NOT NULL)');
    const migration = readWebFile(
      `lib/db/migrations-sqlite/${SQLITE_MIGRATION_TAG}.sql`,
    );

    try {
      expect(migration).toContain(STATEMENT_BREAKPOINT);
      database.exec(migration);
      database.exec(migration);

      const tables = (
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map(({ name }) => name);

      expect(tables).toEqual(
        expect.arrayContaining(RUNTIME_TABLES.map(([, name]) => name)),
      );

      for (const [, tableName] of RUNTIME_TABLES) {
        const foreignKeys = database
          .prepare(`PRAGMA foreign_key_list('${tableName}')`)
          .all() as Array<{ table: string }>;
        expect([...new Set(foreignKeys.map(({ table }) => table))]).toEqual(
          expect.arrayContaining([...EXPECTED_SQLITE_FOREIGN_KEYS[tableName]]),
        );
      }

      const indexes = (
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map(({ name }) => name);
      expect(indexes).toEqual(
        expect.arrayContaining([...CRITICAL_SQLITE_INDEXES]),
      );

      const insertSession = database.prepare(
        "INSERT INTO agent_runtime_sessions (id, owner_id) VALUES (?, ?)",
      );
      database.prepare('INSERT INTO "User" (id) VALUES (?)').run("owner-1");
      insertSession.run("session-1", "owner-1");
      expect(() =>
        insertSession.run("session-orphan", "missing-owner"),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            "INSERT INTO agent_runtime_sessions (id, owner_id, run_epoch) VALUES (?, ?, ?)",
          )
          .run("session-invalid", "owner-1", -1),
      ).toThrow();

      database.pragma("foreign_keys = OFF");
      expect(() =>
        database
          .prepare(
            `INSERT INTO agent_goal_evidence (
              id, owner_id, runtime_session_id, goal_id, goal_run_id,
              goal_revision, run_epoch, type, source_event_id, summary,
              success, payload, observed_at
            ) VALUES ('evidence-invalid', 'owner-1', 'session-1', 'goal-1',
              'run-1', 1, 0, 'tool_result', 'event-1', 'Observed', 2, '{}', 1)`,
          )
          .run(),
      ).toThrow();
      database.pragma("foreign_keys = ON");
    } finally {
      database.close();
    }
  });
});
