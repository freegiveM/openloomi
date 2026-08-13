import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import { getAppDataDir, joinPath } from "@/lib/utils/path";
import { runSqliteMigrationWithForeignKeysDisabled } from "./sqlite-migration-foreign-keys";

const DB_PATH =
  process.env.TAURI_DB_PATH || joinPath(getAppDataDir(), "data.db");

const runMigrate = async () => {
  const sqlite = new Database(DB_PATH);
  const db = drizzle(sqlite);

  console.log("⏳ Running SQLite migrations...");

  const start = Date.now();
  runSqliteMigrationWithForeignKeysDisabled(sqlite, () =>
    migrate(db, { migrationsFolder: "./lib/db/migrations-sqlite" }),
  );
  const end = Date.now();

  console.log(`✅ SQLite migrations completed in ${end - start} ms`);

  sqlite.close();
  process.exit(0);
};

runMigrate().catch((err) => {
  console.error("❌ SQLite migration failed");
  console.error(err);
  process.exit(1);
});
