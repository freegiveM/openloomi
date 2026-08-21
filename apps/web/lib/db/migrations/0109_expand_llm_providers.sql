ALTER TABLE "user_llm_api_settings"
  ADD COLUMN "provider_id" varchar(32);

UPDATE "user_llm_api_settings"
SET "provider_id" = "provider_type"
WHERE "provider_id" IS NULL;

UPDATE "user_llm_api_settings"
SET "base_url" = regexp_replace("base_url", '/+$', '') || '/v1'
WHERE "provider_id" IN ('openai_compatible', 'anthropic_compatible')
  AND "base_url" IS NOT NULL
  AND regexp_replace("base_url", '/+$', '') NOT LIKE '%/v1';

ALTER TABLE "user_llm_api_settings"
  ALTER COLUMN "provider_id" SET NOT NULL;

ALTER TABLE "user_llm_api_settings"
  ADD COLUMN "region" text;

ALTER TABLE "user_llm_api_settings"
  DROP CONSTRAINT IF EXISTS "user_llm_api_settings_provider_type_check";

ALTER TABLE "user_llm_api_settings"
  ADD CONSTRAINT "user_llm_api_settings_provider_type_check"
  CHECK ("provider_type" IN ('openai_compatible', 'anthropic_compatible', 'bedrock'));

ALTER TABLE "user_llm_api_settings"
  ADD CONSTRAINT "user_llm_api_settings_provider_id_check"
  CHECK (
    "provider_id" IN (
      'openai_compatible',
      'anthropic_compatible',
      'openrouter',
      'bedrock',
      'gemini',
      'ollama',
      'deepseek',
      'xai'
    )
  );

WITH ranked_enabled AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "user_id"
      ORDER BY "updated_at" DESC, "id" DESC
    ) AS "provider_rank"
  FROM "user_llm_api_settings"
  WHERE "enabled" = true
)
UPDATE "user_llm_api_settings"
SET "enabled" = false
WHERE "id" IN (
  SELECT "id" FROM ranked_enabled WHERE "provider_rank" > 1
);

DROP INDEX IF EXISTS "user_llm_api_settings_user_provider_idx";

CREATE UNIQUE INDEX "user_llm_api_settings_user_provider_idx"
  ON "user_llm_api_settings" ("user_id", "provider_id");

CREATE UNIQUE INDEX "user_llm_api_settings_user_enabled_idx"
  ON "user_llm_api_settings" ("user_id")
  WHERE "enabled" = true;
