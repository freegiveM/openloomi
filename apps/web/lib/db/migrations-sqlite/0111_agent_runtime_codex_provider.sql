CREATE TABLE `__drizzle_new_agent_runtime_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL,
  `provider` text DEFAULT 'claude' NOT NULL,
  `provider_session_id` text,
  `working_directory` text,
  `recovery_descriptor` text,
  `recovery_lease_owner` text,
  `recovery_lease_token` text,
  `recovery_lease_expires_at` integer,
  `recovery_error_code` text,
  `recovery_error_message` text,
  `recovery_failed_at` integer,
  `state` text DEFAULT 'starting' NOT NULL,
  `run_epoch` integer DEFAULT 0 NOT NULL,
  `last_instruction_sequence` integer DEFAULT 0 NOT NULL,
  `pending_operation` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`owner_id`) REFERENCES `User`(`id`) ON DELETE CASCADE,
  CONSTRAINT `agent_runtime_sessions_provider_check`
    CHECK (`provider` IN ('claude', 'codex')),
  CONSTRAINT `agent_runtime_sessions_state_check`
    CHECK (`state` IN ('starting', 'idle', 'running', 'evaluating', 'interrupted', 'closed', 'failed')),
  CONSTRAINT `agent_runtime_sessions_run_epoch_check`
    CHECK (`run_epoch` >= 0),
  CONSTRAINT `agent_runtime_sessions_instruction_sequence_check`
    CHECK (`last_instruction_sequence` >= 0),
  CONSTRAINT `agent_runtime_sessions_pending_operation_check`
    CHECK (`pending_operation` IS NULL OR (json_valid(`pending_operation`) AND json_type(`pending_operation`) = 'object')),
  CONSTRAINT `agent_runtime_sessions_timestamps_check`
    CHECK (`updated_at` >= `created_at`)
);
--> statement-breakpoint
INSERT INTO `__drizzle_new_agent_runtime_sessions` (
  `id`, `owner_id`, `provider`, `provider_session_id`, `working_directory`,
  `recovery_descriptor`, `recovery_lease_owner`, `recovery_lease_token`,
  `recovery_lease_expires_at`, `recovery_error_code`,
  `recovery_error_message`, `recovery_failed_at`, `state`, `run_epoch`,
  `last_instruction_sequence`, `pending_operation`, `created_at`, `updated_at`
)
SELECT
  `id`, `owner_id`, `provider`, `provider_session_id`, `working_directory`,
  `recovery_descriptor`, `recovery_lease_owner`, `recovery_lease_token`,
  `recovery_lease_expires_at`, `recovery_error_code`,
  `recovery_error_message`, `recovery_failed_at`, `state`, `run_epoch`,
  `last_instruction_sequence`, `pending_operation`, `created_at`, `updated_at`
FROM `agent_runtime_sessions`;
--> statement-breakpoint
DROP TABLE `agent_runtime_sessions`;
--> statement-breakpoint
ALTER TABLE `__drizzle_new_agent_runtime_sessions` RENAME TO `agent_runtime_sessions`;
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runtime_sessions_owner_id_id_key`
  ON `agent_runtime_sessions` (`owner_id`, `id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runtime_sessions_provider_session_idx`
  ON `agent_runtime_sessions` (`provider`, `provider_session_id`)
  WHERE `provider_session_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `agent_runtime_sessions_recovery_idx`
  ON `agent_runtime_sessions` (`recovery_failed_at`, `recovery_lease_expires_at`, `updated_at`)
  WHERE `recovery_failed_at` IS NULL;
--> statement-breakpoint

CREATE TRIGGER `agent_runtime_sessions_recovery_insert_check`
BEFORE INSERT ON `agent_runtime_sessions`
WHEN NOT (
  (NEW.`recovery_descriptor` IS NULL OR
    (json_valid(NEW.`recovery_descriptor`) AND json_type(NEW.`recovery_descriptor`) = 'object'))
  AND (
    (NEW.`recovery_lease_owner` IS NULL AND NEW.`recovery_lease_token` IS NULL AND NEW.`recovery_lease_expires_at` IS NULL)
    OR
    (length(trim(NEW.`recovery_lease_owner`)) BETWEEN 1 AND 256
      AND length(trim(NEW.`recovery_lease_token`)) BETWEEN 1 AND 256
      AND NEW.`recovery_lease_expires_at` IS NOT NULL)
  )
  AND (
    (NEW.`recovery_error_code` IS NULL AND NEW.`recovery_error_message` IS NULL AND NEW.`recovery_failed_at` IS NULL)
    OR
    (length(trim(NEW.`recovery_error_code`)) BETWEEN 1 AND 128
      AND length(trim(NEW.`recovery_error_message`)) BETWEEN 1 AND 8000
      AND NEW.`recovery_failed_at` IS NOT NULL)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid agent runtime recovery state');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runtime_sessions_recovery_update_check`
BEFORE UPDATE OF
  `recovery_descriptor`, `recovery_lease_owner`, `recovery_lease_token`,
  `recovery_lease_expires_at`, `recovery_error_code`,
  `recovery_error_message`, `recovery_failed_at`
ON `agent_runtime_sessions`
WHEN NOT (
  (NEW.`recovery_descriptor` IS NULL OR
    (json_valid(NEW.`recovery_descriptor`) AND json_type(NEW.`recovery_descriptor`) = 'object'))
  AND (
    (NEW.`recovery_lease_owner` IS NULL AND NEW.`recovery_lease_token` IS NULL AND NEW.`recovery_lease_expires_at` IS NULL)
    OR
    (length(trim(NEW.`recovery_lease_owner`)) BETWEEN 1 AND 256
      AND length(trim(NEW.`recovery_lease_token`)) BETWEEN 1 AND 256
      AND NEW.`recovery_lease_expires_at` IS NOT NULL)
  )
  AND (
    (NEW.`recovery_error_code` IS NULL AND NEW.`recovery_error_message` IS NULL AND NEW.`recovery_failed_at` IS NULL)
    OR
    (length(trim(NEW.`recovery_error_code`)) BETWEEN 1 AND 128
      AND length(trim(NEW.`recovery_error_message`)) BETWEEN 1 AND 8000
      AND NEW.`recovery_failed_at` IS NOT NULL)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid agent runtime recovery state');
END;
