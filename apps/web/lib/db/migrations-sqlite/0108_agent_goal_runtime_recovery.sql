ALTER TABLE `agent_runtime_sessions` ADD COLUMN `recovery_descriptor` text;
--> statement-breakpoint
ALTER TABLE `agent_runtime_sessions` ADD COLUMN `recovery_lease_owner` text;
--> statement-breakpoint
ALTER TABLE `agent_runtime_sessions` ADD COLUMN `recovery_lease_token` text;
--> statement-breakpoint
ALTER TABLE `agent_runtime_sessions` ADD COLUMN `recovery_lease_expires_at` integer;
--> statement-breakpoint
ALTER TABLE `agent_runtime_sessions` ADD COLUMN `recovery_error_code` text;
--> statement-breakpoint
ALTER TABLE `agent_runtime_sessions` ADD COLUMN `recovery_error_message` text;
--> statement-breakpoint
ALTER TABLE `agent_runtime_sessions` ADD COLUMN `recovery_failed_at` integer;
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
--> statement-breakpoint

DROP INDEX IF EXISTS `agent_runtime_sessions_recovery_idx`;
--> statement-breakpoint
CREATE INDEX `agent_runtime_sessions_recovery_idx`
  ON `agent_runtime_sessions` (`recovery_failed_at`, `recovery_lease_expires_at`, `updated_at`)
  WHERE `recovery_failed_at` IS NULL;
--> statement-breakpoint

CREATE TABLE `agent_runtime_provider_events` (
  `owner_id` text NOT NULL,
  `runtime_session_id` text NOT NULL,
  `run_epoch` integer NOT NULL,
  `event_key` text NOT NULL,
  `provider_event_id` text NOT NULL,
  `provider_session_id` text,
  `event_fingerprint` text NOT NULL,
  `observed_at` integer NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  CONSTRAINT `agent_runtime_provider_events_pkey`
    PRIMARY KEY (`owner_id`, `runtime_session_id`, `run_epoch`, `event_key`),
  CONSTRAINT `agent_runtime_provider_events_owner_session_fkey`
    FOREIGN KEY (`owner_id`, `runtime_session_id`)
    REFERENCES `agent_runtime_sessions`(`owner_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `agent_runtime_provider_events_epoch_check`
    CHECK (`run_epoch` >= 0),
  CONSTRAINT `agent_runtime_provider_events_identity_check`
    CHECK (
      length(trim(`event_key`)) BETWEEN 1 AND 256
      AND length(trim(`provider_event_id`)) BETWEEN 1 AND 256
      AND length(`event_fingerprint`) = 64
      AND (`provider_session_id` IS NULL OR length(trim(`provider_session_id`)) BETWEEN 1 AND 256)
    ),
  CONSTRAINT `agent_runtime_provider_events_timestamps_check`
    CHECK (`created_at` >= 0 AND `observed_at` >= 0)
);
--> statement-breakpoint
CREATE INDEX `agent_runtime_provider_events_provider_event_idx`
  ON `agent_runtime_provider_events` (`owner_id`, `runtime_session_id`, `provider_event_id`);
