CREATE TABLE `__new_user_llm_api_settings` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `provider_type` text NOT NULL,
  `api_key_encrypted` text,
  `encryption_key_id` text,
  `base_url` text,
  `model` text,
  `region` text,
  `enabled` integer DEFAULT 0 NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  CONSTRAINT `user_llm_api_settings_provider_id_check`
    CHECK (`provider_id` IN (
      'openai_compatible',
      'anthropic_compatible',
      'openrouter',
      'bedrock',
      'gemini',
      'ollama',
      'deepseek',
      'xai'
    )),
  CONSTRAINT `user_llm_api_settings_provider_type_check`
    CHECK (`provider_type` IN ('openai_compatible', 'anthropic_compatible', 'bedrock')),
  FOREIGN KEY (`user_id`) REFERENCES `User`(`id`) ON DELETE CASCADE
);

INSERT INTO `__new_user_llm_api_settings` (
  `id`,
  `user_id`,
  `provider_id`,
  `provider_type`,
  `api_key_encrypted`,
  `encryption_key_id`,
  `base_url`,
  `model`,
  `enabled`,
  `created_at`,
  `updated_at`
)
SELECT
  `id`,
  `user_id`,
  `provider_type`,
  `provider_type`,
  `api_key_encrypted`,
  `encryption_key_id`,
  CASE
    WHEN `base_url` IS NOT NULL
      AND rtrim(`base_url`, '/') NOT LIKE '%/v1'
      THEN rtrim(`base_url`, '/') || '/v1'
    ELSE `base_url`
  END,
  `model`,
  `enabled`,
  `created_at`,
  `updated_at`
FROM `user_llm_api_settings`;

DROP TABLE `user_llm_api_settings`;
ALTER TABLE `__new_user_llm_api_settings` RENAME TO `user_llm_api_settings`;

UPDATE `user_llm_api_settings`
SET `enabled` = 0
WHERE `enabled` = 1
  AND `id` NOT IN (
    SELECT `id`
    FROM (
      SELECT
        `id`,
        row_number() OVER (
          PARTITION BY `user_id`
          ORDER BY `updated_at` DESC, `id` DESC
        ) AS `provider_rank`
      FROM `user_llm_api_settings`
      WHERE `enabled` = 1
    ) AS `ranked_enabled`
    WHERE `provider_rank` = 1
  );

CREATE UNIQUE INDEX `user_llm_api_settings_user_provider_idx`
  ON `user_llm_api_settings` (`user_id`, `provider_id`);

CREATE UNIQUE INDEX `user_llm_api_settings_user_enabled_idx`
  ON `user_llm_api_settings` (`user_id`)
  WHERE `enabled` = 1;

CREATE INDEX `user_llm_api_settings_user_idx`
  ON `user_llm_api_settings` (`user_id`);
