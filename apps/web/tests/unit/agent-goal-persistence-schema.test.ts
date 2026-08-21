import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import * as sqliteSchema from "@/lib/db/schema-sqlite";
import { runSqliteMigrationWithForeignKeysDisabled } from "@/lib/db/sqlite-migration-foreign-keys";

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
const CODEX_PROVIDER_MIGRATION_TAG = "0111_agent_runtime_codex_provider";
const OPTIONAL_GOAL_LIMITS_MIGRATION_TAG = "0112_agent_goal_optional_limits";
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

function readWebFile(path: string): string {
  return readFileSync(join(WEB_ROOT, path), "utf8");
}

function applyMigration(database: Database.Database, tag: string): void {
  runSqliteMigrationWithForeignKeysDisabled(database, () =>
    database.transaction(() =>
      database.exec(readWebFile(`lib/db/migrations-sqlite/${tag}.sql`)),
    )(),
  );
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

  it("registers the Codex provider migration after the recovery migrations", () => {
    const sqliteJournal = readJournal(
      "lib/db/migrations-sqlite/meta/_journal.json",
    );
    const sqliteIndex = sqliteJournal.entries.findIndex(
      ({ tag }) => tag === CODEX_PROVIDER_MIGRATION_TAG,
    );
    const sqliteEntry = sqliteJournal.entries[sqliteIndex];

    expect(sqliteEntry).toMatchObject({
      idx: 39,
      version: "7",
      tag: CODEX_PROVIDER_MIGRATION_TAG,
      breakpoints: true,
    });
    expect(sqliteEntry?.when).toBeGreaterThan(
      sqliteJournal.entries[sqliteIndex - 1]?.when ?? Number.NEGATIVE_INFINITY,
    );
    expect(
      readMigrationFiles({
        migrationsFolder: join(WEB_ROOT, "lib/db/migrations-sqlite"),
      })[sqliteIndex]?.sql.length,
    ).toBeGreaterThan(1);
  });

  it("registers the optional Goal limits migration after the provider migration", () => {
    const entries = readJournal(
      "lib/db/migrations-sqlite/meta/_journal.json",
    ).entries;
    expect(
      entries.find(({ tag }) => tag === OPTIONAL_GOAL_LIMITS_MIGRATION_TAG),
    ).toMatchObject({
      idx: 40,
      version: "7",
      tag: OPTIONAL_GOAL_LIMITS_MIGRATION_TAG,
      breakpoints: true,
    });
  });

  it("preserves the Goal graph and accepts a Goal with every limit omitted", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec('CREATE TABLE "User" ("id" text PRIMARY KEY NOT NULL)');
    for (const tag of [
      "0107_agent_goal_runtime",
      "0108_agent_goal_runtime_recovery",
      "0109_agent_goal_recovery_pause",
      "0110_agent_goal_evaluation_pause",
    ]) {
      database.exec(readWebFile(`lib/db/migrations-sqlite/${tag}.sql`));
    }
    applyMigration(database, CODEX_PROVIDER_MIGRATION_TAG);

    database.prepare('INSERT INTO "User" (id) VALUES (?)').run("owner-1");
    database
      .prepare(
        `INSERT INTO agent_runtime_sessions (id, owner_id, provider)
         VALUES ('legacy-session', 'owner-1', 'claude'),
                ('unlimited-session', 'owner-1', 'codex')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO agent_goals (
          id, owner_id, runtime_session_id, revision, objective, priority,
          status, max_turns, completion_policy, source_type, goal_snapshot,
          created_at, updated_at
        ) VALUES (
          'legacy-goal', 'owner-1', 'legacy-session', 1,
          'Preserve this Goal', 50, 'active', 8, 'model_evaluator', 'user',
          '{}', 10, 20
        )`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO agent_goal_runs (
          id, owner_id, runtime_session_id, goal_id, goal_revision, run_epoch,
          status, started_at, last_activity_at, created_at, updated_at
        ) VALUES (
          'legacy-run', 'owner-1', 'legacy-session', 'legacy-goal', 1, 0,
          'running', 10, 20, 10, 20
        )`,
      )
      .run();
    applyMigration(database, OPTIONAL_GOAL_LIMITS_MIGRATION_TAG);

    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(
      database
        .prepare(
          "SELECT objective, max_turns AS maxTurns FROM agent_goals WHERE id = 'legacy-goal'",
        )
        .get(),
    ).toEqual({ objective: "Preserve this Goal", maxTurns: 8 });
    expect(
      database
        .prepare(
          "SELECT goal_id AS goalId, status FROM agent_goal_runs WHERE id = 'legacy-run'",
        )
        .get(),
    ).toEqual({ goalId: "legacy-goal", status: "running" });

    database
      .prepare(
        `INSERT INTO agent_goals (
          id, owner_id, runtime_session_id, revision, objective, priority,
          status, completion_policy, source_type, goal_snapshot,
          created_at, updated_at
        ) VALUES (
          'unlimited-goal', 'owner-1', 'unlimited-session', 1,
          'Finish the objective', 50, 'active', 'model_evaluator', 'user',
          '{}', 30, 30
        )`,
      )
      .run();
    expect(
      database
        .prepare(
          `SELECT deadline, max_turns AS maxTurns, max_tokens AS maxTokens,
                  max_duration_seconds AS maxDurationSeconds
             FROM agent_goals WHERE id = 'unlimited-goal'`,
        )
        .get(),
    ).toEqual({
      deadline: null,
      maxTurns: null,
      maxTokens: null,
      maxDurationSeconds: null,
    });

    database.close();
  });

  it("migrates existing Claude sessions without losing provider ownership or recovery state", () => {
    const database = new Database(":memory:");
    database.exec('CREATE TABLE "User" ("id" text PRIMARY KEY NOT NULL)');
    for (const tag of [
      "0107_agent_goal_runtime",
      "0108_agent_goal_runtime_recovery",
      "0109_agent_goal_recovery_pause",
      "0110_agent_goal_evaluation_pause",
    ]) {
      database.exec(readWebFile(`lib/db/migrations-sqlite/${tag}.sql`));
    }
    database.prepare('INSERT INTO "User" (id) VALUES (?)').run("owner-1");
    database
      .prepare(
        `INSERT INTO agent_runtime_sessions (
          id, owner_id, provider, provider_session_id, recovery_descriptor,
          recovery_lease_owner, recovery_lease_token,
          recovery_lease_expires_at, state, run_epoch,
          last_instruction_sequence, created_at, updated_at
        ) VALUES (?, ?, 'claude', ?, '{}', ?, ?, ?, 'running', 4, 9, 10, 20)`,
      )
      .run(
        "legacy-session",
        "owner-1",
        "shared-provider-id",
        "host-1",
        "token-1",
        30,
      );
    database
      .prepare(
        `INSERT INTO agent_runtime_provider_events (
          owner_id, runtime_session_id, run_epoch, event_key,
          provider_event_id, event_fingerprint, observed_at, created_at
        ) VALUES (?, ?, 4, 'event-key', 'event-id', ?, 21, 21)`,
      )
      .run("owner-1", "legacy-session", "a".repeat(64));

    applyMigration(database, CODEX_PROVIDER_MIGRATION_TAG);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);

    expect(
      database
        .prepare(
          `SELECT provider, provider_session_id AS providerSessionId,
                  recovery_lease_owner AS recoveryLeaseOwner,
                  recovery_lease_token AS recoveryLeaseToken,
                  recovery_lease_expires_at AS recoveryLeaseExpiresAt,
                  state, run_epoch AS runEpoch,
                  last_instruction_sequence AS lastInstructionSequence,
                  created_at AS createdAt, updated_at AS updatedAt
             FROM agent_runtime_sessions WHERE id = 'legacy-session'`,
        )
        .get(),
    ).toEqual({
      provider: "claude",
      providerSessionId: "shared-provider-id",
      recoveryLeaseOwner: "host-1",
      recoveryLeaseToken: "token-1",
      recoveryLeaseExpiresAt: 30,
      state: "running",
      runEpoch: 4,
      lastInstructionSequence: 9,
      createdAt: 10,
      updatedAt: 20,
    });
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM agent_runtime_provider_events WHERE runtime_session_id = 'legacy-session'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(database.pragma("foreign_key_check")).toEqual([]);

    const insertProvider = database.prepare(
      `INSERT INTO agent_runtime_sessions
        (id, owner_id, provider, provider_session_id)
       VALUES (?, 'owner-1', ?, 'shared-provider-id')`,
    );
    insertProvider.run("codex-session", "codex");
    expect(() => insertProvider.run("duplicate-codex", "codex")).toThrow();
    expect(() => insertProvider.run("unknown-session", "unknown")).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO agent_runtime_sessions
            (id, owner_id, provider, recovery_lease_owner)
           VALUES ('invalid-recovery', 'owner-1', 'codex', 'host-only')`,
        )
        .run(),
    ).toThrow("invalid agent runtime recovery state");

    database.close();
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
