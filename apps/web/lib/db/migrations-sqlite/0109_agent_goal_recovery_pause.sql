-- Convert only legacy rows written by the old restart-recovery failure path.
-- Ordinary evaluator-blocked Goals have no recovery_failed_at marker and are
-- intentionally left unchanged.
UPDATE `agent_goals` AS `goal`
SET
  `status` = 'paused',
  `goal_snapshot` = json_set(
    `goal_snapshot`,
    '$.status',
    'paused',
    '$.updatedAt',
    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      MAX(`updated_at`, unixepoch()),
      'unixepoch'
    )
  ),
  `updated_at` = MAX(`updated_at`, unixepoch())
WHERE `goal`.`slot` = 'primary'
  AND `goal`.`slot_state` = 'assigned'
  AND `goal`.`status` = 'blocked'
  AND EXISTS (
    SELECT 1
    FROM `agent_runtime_sessions` AS `session`
    WHERE `session`.`owner_id` = `goal`.`owner_id`
      AND `session`.`id` = `goal`.`runtime_session_id`
      AND `session`.`state` = 'failed'
      AND `session`.`recovery_failed_at` IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM `agent_goal_runs` AS `run`
        WHERE `run`.`owner_id` = `session`.`owner_id`
          AND `run`.`runtime_session_id` = `session`.`id`
          AND `run`.`goal_id` = `goal`.`id`
          AND `run`.`run_epoch` = `session`.`run_epoch`
          AND `run`.`status` IN ('blocked', 'failed')
      )
  );
--> statement-breakpoint

UPDATE `agent_goal_runs` AS `run`
SET
  `status` = 'paused',
  `completed_at` = NULL,
  `last_activity_at` = MAX(`last_activity_at`, unixepoch()),
  `updated_at` = MAX(`updated_at`, unixepoch())
WHERE `run`.`status` IN ('blocked', 'failed')
  AND EXISTS (
    SELECT 1
    FROM `agent_runtime_sessions` AS `session`
    WHERE `session`.`owner_id` = `run`.`owner_id`
      AND `session`.`id` = `run`.`runtime_session_id`
      AND `session`.`run_epoch` = `run`.`run_epoch`
      AND `session`.`state` = 'failed'
      AND `session`.`recovery_failed_at` IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM `agent_goals` AS `goal`
        WHERE `goal`.`owner_id` = `run`.`owner_id`
          AND `goal`.`runtime_session_id` = `run`.`runtime_session_id`
          AND `goal`.`id` = `run`.`goal_id`
          AND `goal`.`slot` = 'primary'
          AND `goal`.`slot_state` = 'assigned'
          AND `goal`.`status` = 'paused'
      )
  );
--> statement-breakpoint

UPDATE `agent_runtime_sessions` AS `session`
SET
  `state` = 'idle',
  `recovery_error_code` = NULL,
  `recovery_error_message` = NULL,
  `recovery_failed_at` = NULL,
  `recovery_lease_owner` = NULL,
  `recovery_lease_token` = NULL,
  `recovery_lease_expires_at` = NULL,
  `updated_at` = MAX(`updated_at`, unixepoch())
WHERE `session`.`state` = 'failed'
  AND `session`.`recovery_failed_at` IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM `agent_goals` AS `goal`
    WHERE `goal`.`owner_id` = `session`.`owner_id`
      AND `goal`.`runtime_session_id` = `session`.`id`
      AND `goal`.`slot` = 'primary'
      AND `goal`.`slot_state` = 'assigned'
      AND `goal`.`status` = 'paused'
      AND EXISTS (
        SELECT 1
        FROM `agent_goal_runs` AS `run`
        WHERE `run`.`owner_id` = `session`.`owner_id`
          AND `run`.`runtime_session_id` = `session`.`id`
          AND `run`.`goal_id` = `goal`.`id`
          AND `run`.`run_epoch` = `session`.`run_epoch`
          AND `run`.`status` = 'paused'
      )
  );
