import type Database from "better-sqlite3";

export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  get(...parameters: readonly unknown[]): unknown;
  all(...parameters: readonly unknown[]): unknown[];
  run(...parameters: readonly unknown[]): SqliteRunResult;
}

export interface BetterSqlite3Client {
  prepare(sql: string): SqliteStatement;
  transaction<T>(callback: () => T): {
    (): T;
    immediate(): T;
  };
}

export type BetterSqlite3ClientSource =
  | Database.Database
  | BetterSqlite3Client
  | { readonly $client: Database.Database | BetterSqlite3Client };

/**
 * Native synchronous transaction boundary required by better-sqlite3.
 *
 * Drizzle's async transaction callback cannot keep a better-sqlite3
 * transaction open across awaited work, so durable Goal mutations execute a
 * fully synchronous unit of work under BEGIN IMMEDIATE and only wrap the
 * result in the async application port at the outer edge.
 */
export class SqliteImmediateTransactionDriver {
  readonly client: BetterSqlite3Client;

  constructor(source: BetterSqlite3ClientSource) {
    const client = "$client" in source ? source.$client : source;
    if (
      typeof client.prepare !== "function" ||
      typeof client.transaction !== "function"
    ) {
      throw new TypeError("A better-sqlite3 client is required");
    }
    this.client = client as unknown as BetterSqlite3Client;
  }

  immediate<T>(work: () => T): T {
    return this.client.transaction(work).immediate();
  }
}
