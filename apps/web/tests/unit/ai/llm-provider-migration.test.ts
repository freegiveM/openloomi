import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("SQLite LLM provider expansion migration", () => {
  let database: Database.Database;

  beforeEach(() => {
    database = new Database(":memory:");
    database.pragma("foreign_keys = OFF");
    database.exec('CREATE TABLE "User" ("id" text PRIMARY KEY NOT NULL)');
    database.exec('INSERT INTO "User" ("id") VALUES (\'user-1\')');
    database.exec(
      readFileSync(
        join(
          process.cwd(),
          "lib/db/migrations-sqlite/0102_user_llm_api_settings.sql",
        ),
        "utf8",
      ),
    );
  });

  afterEach(() => database.close());

  it("registers the provider expansion after the existing migrations", () => {
    const journal = JSON.parse(
      readFileSync(
        join(process.cwd(), "lib/db/migrations-sqlite/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: Array<Record<string, unknown>> };

    expect(journal.entries.at(-1)).toMatchObject({
      idx: 41,
      version: "7",
      tag: "0113_expand_llm_providers",
      breakpoints: true,
    });
  });

  it("preserves legacy rows and separates provider identity from transport", () => {
    database
      .prepare(
        `INSERT INTO user_llm_api_settings
          (id, user_id, provider_type, base_url, model, enabled)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "setting-1",
        "user-1",
        "anthropic_compatible",
        "https://api.anthropic.com",
        "claude-sonnet-4-6",
        1,
      );

    database.exec(
      readFileSync(
        join(
          process.cwd(),
          "lib/db/migrations-sqlite/0113_expand_llm_providers.sql",
        ),
        "utf8",
      ),
    );

    const migrated = database
      .prepare(
        "SELECT provider_id, provider_type, base_url, region FROM user_llm_api_settings WHERE id = ?",
      )
      .get("setting-1") as Record<string, unknown>;
    expect(migrated).toEqual({
      provider_id: "anthropic_compatible",
      provider_type: "anthropic_compatible",
      base_url: "https://api.anthropic.com/v1",
      region: null,
    });

    expect(() =>
      database
        .prepare(
          `INSERT INTO user_llm_api_settings
            (id, user_id, provider_id, provider_type, base_url, model)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "setting-2",
          "user-1",
          "gemini",
          "openai_compatible",
          "https://generativelanguage.googleapis.com/v1beta/openai",
          "gemini-2.5-flash",
        ),
    ).not.toThrow();
  });

  it("keeps only the most recently updated legacy provider enabled", () => {
    const insert = database.prepare(
      `INSERT INTO user_llm_api_settings
        (id, user_id, provider_type, model, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "older-provider",
      "user-1",
      "openai_compatible",
      "gpt-4o-mini",
      1,
      1000,
      1000,
    );
    insert.run(
      "newer-provider",
      "user-1",
      "anthropic_compatible",
      "claude-sonnet-4-6",
      1,
      2000,
      2000,
    );

    database.exec(
      readFileSync(
        join(
          process.cwd(),
          "lib/db/migrations-sqlite/0113_expand_llm_providers.sql",
        ),
        "utf8",
      ),
    );

    expect(
      database
        .prepare(
          "SELECT provider_id FROM user_llm_api_settings WHERE enabled = 1",
        )
        .all(),
    ).toEqual([{ provider_id: "anthropic_compatible" }]);

    expect(() =>
      database
        .prepare("UPDATE user_llm_api_settings SET enabled = 1 WHERE id = ?")
        .run("older-provider"),
    ).toThrow(/UNIQUE constraint failed/);
  });
});
