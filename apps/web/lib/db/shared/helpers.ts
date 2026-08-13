import { config } from "dotenv";

config({
  path: ".env",
});

// Import database adapters (supports dual mode)
import { initDb, type getDb } from "../adapters";
import { generateUUID } from "@melandlabs/shared";
import { isTauriMode } from "@/lib/env/constants";
import { createHash } from "node:crypto";
import { type SQL, like, ilike } from "drizzle-orm";

/**
 * Auto-add id field to data being inserted (SQLite requires explicit provision)
 * @param data Data to insert
 * @returns Data with id added
 */
export function addIdIfNeeded<T extends Record<string, unknown>>(
  data: T,
): T & { id: string } {
  // If already has id, return directly
  if ("id" in data && data.id) {
    return data as T & { id: string };
  }

  // SQLite mode requires explicit id provision
  if (isTauriMode()) {
    return { ...data, id: generateUUID() } as T & { id: string };
  }

  // PostgreSQL mode has default values, no need to add
  return data as T & { id: string };
}

/**
 * Database-compatible transaction executor
 * SQLite (better-sqlite3) does not support async transactions, requires special handling
 */
export async function executeTransaction<T>(
  callback: (tx: typeof db) => Promise<T>,
): Promise<T> {
  // SQLite/better-sqlite3 doesn't support async transaction callbacks
  // In SQLite mode, execute operation directly (relies on transaction isolation provided by WAL mode)
  if (isTauriMode()) {
    return await callback(db as typeof db);
  }

  // PostgreSQL supports full async transactions
  return await db.transaction(callback);
}

/**
 * Database-agnostic case-insensitive search helper function
 * Uses ILIKE in PostgreSQL, LIKE in SQLite (case-insensitive by default)
 */
export function caseInsensitiveSearch(column: unknown, pattern: string): SQL {
  // SQLite's LIKE is case-insensitive for ASCII characters by default
  return isTauriMode()
    ? like(column as never, pattern)
    : ilike(column as never, pattern);
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string) {
  return UUID_REGEX.test(value);
}

export function hashPasswordResetToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// Initialize database connection (using adapters)
let dbInstance: ReturnType<typeof getDb> | null = null;

export function getDbInstance() {
  if (!dbInstance) {
    dbInstance = initDb();
  }
  return dbInstance;
}

// Export db for backward compatibility
// Use getter for lazy initialization, avoid initializing database connection when module loads
// This way it won't error during build due to missing environment variables
let _cachedDb: ReturnType<typeof getDb> | null = null;

export const db: ReturnType<typeof getDb> = new Proxy({} as never, {
  get(_target, prop) {
    if (!_cachedDb) {
      console.log("[DB] Initializing database connection (first access)...");
      try {
        _cachedDb = getDbInstance();
        console.log("[DB] Database initialized successfully");
      } catch (error) {
        console.error("[DB] Failed to initialize database:", error);
        throw error;
      }
    }
    const db = _cachedDb;
    // @ts-ignore - proxy to db instance
    return db[prop];
  },
});
