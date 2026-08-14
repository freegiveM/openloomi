import type Database from "better-sqlite3";

/**
 * SQLite table rebuilds must run with FK actions disabled so dropping the old
 * table cannot cascade into preserved child rows. The migration transaction is
 * still owned by the caller.
 */
export function runSqliteMigrationWithForeignKeysDisabled<T>(
  sqlite: Database.Database,
  migrate: () => T,
): T {
  if (sqlite.inTransaction) {
    throw new Error(
      "SQLite foreign keys must be disabled before the migration transaction starts",
    );
  }
  const foreignKeysWereEnabled = sqlite.pragma("foreign_keys", {
    simple: true,
  }) as number;
  sqlite.pragma("foreign_keys = OFF");

  try {
    const result = migrate();
    restoreForeignKeys(sqlite, foreignKeysWereEnabled);
    const violations = sqlite.pragma("foreign_key_check") as Array<{
      table: string;
      rowid: number | null;
      parent: string;
      fkid: number;
    }>;
    if (violations.length > 0) {
      const first = violations[0];
      throw new Error(
        `SQLite migration violated ${first?.table ?? "unknown"} foreign key ${first?.fkid ?? "unknown"}`,
      );
    }
    return result;
  } finally {
    if (!sqlite.inTransaction) {
      restoreForeignKeys(sqlite, foreignKeysWereEnabled);
    }
  }
}

function restoreForeignKeys(
  sqlite: Database.Database,
  foreignKeysWereEnabled: number,
): void {
  sqlite.pragma(
    `foreign_keys = ${foreignKeysWereEnabled === 0 ? "OFF" : "ON"}`,
  );
}
