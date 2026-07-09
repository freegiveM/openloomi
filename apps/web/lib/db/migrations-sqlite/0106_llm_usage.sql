-- Native-agent (and future LLM-endpoint) token usage records (SQLite).
-- Replaces the previous JSONL file store. The table name `llm_usage`
-- is intentionally endpoint-agnostic so future plug-in points
-- (/api/ai/v1/messages, generate-reply, insights processor) can write
-- to the same table with their own `endpoint` value.
--
-- `ts` and `created_at` store Unix epoch SECONDS to match the
-- `mode: "timestamp"` Drizzle column definitions in
-- `lib/db/schema-sqlite.ts`. Filtering / aggregation code in
-- `lib/llm-usage/summary.ts` converts seconds → ms at the boundary
-- when constructing JS Date objects.

CREATE TABLE IF NOT EXISTS `llm_usage` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `ts` integer DEFAULT (unixepoch()) NOT NULL,
  `provider_type` text NOT NULL,
  `model` text,
  `endpoint` text DEFAULT 'native-agent' NOT NULL,
  `input_tokens` integer NOT NULL,
  `output_tokens` integer NOT NULL,
  `run_id` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `User`(`id`) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS `llm_usage_user_ts_idx`
  ON `llm_usage` (`user_id`, `ts`);