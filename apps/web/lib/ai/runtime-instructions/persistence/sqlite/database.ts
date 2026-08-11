import { SqliteGoalRuntimeStore } from "./store";
import {
  SqliteImmediateTransactionDriver,
  type BetterSqlite3ClientSource,
} from "./transaction";

/**
 * Owns the native SQLite transaction boundary and the single row-store
 * instance used inside it. Keeping this boundary synchronous is essential:
 * better-sqlite3 closes a transaction as soon as its callback returns.
 */
export class SqliteGoalRuntimeDatabase {
  readonly store: SqliteGoalRuntimeStore;
  private readonly transactions: SqliteImmediateTransactionDriver;

  constructor(source: BetterSqlite3ClientSource) {
    this.transactions = new SqliteImmediateTransactionDriver(source);
    this.store = new SqliteGoalRuntimeStore(this.transactions.client);
  }

  immediate<T>(work: (store: SqliteGoalRuntimeStore) => T): T {
    return this.transactions.immediate(() => work(this.store));
  }
}

export type SqliteGoalRuntimeDatabaseSource =
  | BetterSqlite3ClientSource
  | SqliteGoalRuntimeDatabase;

export function resolveSqliteGoalRuntimeDatabase(
  source: SqliteGoalRuntimeDatabaseSource,
): SqliteGoalRuntimeDatabase {
  return source instanceof SqliteGoalRuntimeDatabase
    ? source
    : new SqliteGoalRuntimeDatabase(source);
}
