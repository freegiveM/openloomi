-- Native-agent (and future LLM-endpoint) token usage records.
-- Replaces the previous JSONL file store. The table name `llm_usage` is
-- intentionally endpoint-agnostic so future plug-in points
-- (/api/ai/v1/messages, generate-reply, insights processor) can write to
-- the same table with their own `endpoint` value.
--
-- Postgres stores `ts` / `created_at` as native `timestamp with time zone`,
-- matching the Drizzle column definitions in `lib/db/schema.pg.ts`. The
-- summary module consumes `MIN/MAX(ts)` as Date values directly — Drizzle's
-- Postgres driver returns them as JS Date instances, so no ms-scaling
-- conversion is needed at the boundary (unlike the SQLite path).

CREATE TABLE IF NOT EXISTS "llm_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "ts" timestamp with time zone DEFAULT now() NOT NULL,
  "provider_type" varchar(64) NOT NULL,
  "model" text,
  "endpoint" varchar(64) DEFAULT 'native-agent' NOT NULL,
  "input_tokens" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "run_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "llm_usage_user_ts_idx"
  ON "llm_usage" ("user_id", "ts");

DO $$ BEGIN
  ALTER TABLE "llm_usage"
    ADD CONSTRAINT "llm_usage_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;