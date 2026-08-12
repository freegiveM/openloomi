-- GoalController historically used `blocked` for recoverable evaluation
-- boundaries (evaluator errors, manual review, and no-progress guards).
-- Normalize only the currently assigned primary Goal and its current Run;
-- terminal and historical Goal Runs remain untouched.
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
    JOIN `agent_goal_runs` AS `run`
      ON `run`.`owner_id` = `session`.`owner_id`
     AND `run`.`runtime_session_id` = `session`.`id`
     AND `run`.`run_epoch` = `session`.`run_epoch`
    WHERE `session`.`owner_id` = `goal`.`owner_id`
      AND `session`.`id` = `goal`.`runtime_session_id`
      AND `run`.`goal_id` = `goal`.`id`
      AND `run`.`status` = 'blocked'
  );
--> statement-breakpoint

UPDATE `agent_goal_runs` AS `run`
SET
  `status` = 'paused',
  `completed_at` = NULL,
  `last_activity_at` = MAX(`last_activity_at`, unixepoch()),
  `updated_at` = MAX(`updated_at`, unixepoch())
WHERE `run`.`status` = 'blocked'
  AND EXISTS (
    SELECT 1
    FROM `agent_runtime_sessions` AS `session`
    JOIN `agent_goals` AS `goal`
      ON `goal`.`owner_id` = `session`.`owner_id`
     AND `goal`.`runtime_session_id` = `session`.`id`
     AND `goal`.`slot` = 'primary'
     AND `goal`.`slot_state` = 'assigned'
    WHERE `session`.`owner_id` = `run`.`owner_id`
      AND `session`.`id` = `run`.`runtime_session_id`
      AND `session`.`run_epoch` = `run`.`run_epoch`
      AND `goal`.`id` = `run`.`goal_id`
      AND `goal`.`status` = 'paused'
  );
