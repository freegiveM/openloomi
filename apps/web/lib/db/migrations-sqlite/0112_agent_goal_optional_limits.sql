CREATE TABLE `__drizzle_new_agent_goals` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL,
  `runtime_session_id` text NOT NULL,
  `slot` text DEFAULT 'primary' NOT NULL,
  `slot_state` text DEFAULT 'assigned' NOT NULL,
  `revision` integer NOT NULL,
  `objective` text NOT NULL,
  `priority` integer NOT NULL,
  `status` text NOT NULL,
  `deadline` integer,
  `max_turns` integer,
  `max_tokens` integer,
  `max_duration_seconds` integer,
  `completion_policy` text NOT NULL,
  `source_type` text NOT NULL,
  `source_id` text,
  `goal_snapshot` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `agent_goals_owner_session_fkey`
    FOREIGN KEY (`owner_id`, `runtime_session_id`)
    REFERENCES `agent_runtime_sessions`(`owner_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `agent_goals_slot_check`
    CHECK (`slot` = 'primary'),
  CONSTRAINT `agent_goals_slot_state_check`
    CHECK (`slot_state` IN ('assigned', 'reserved', 'released')),
  CONSTRAINT `agent_goals_revision_check`
    CHECK (`revision` > 0),
  CONSTRAINT `agent_goals_priority_check`
    CHECK (`priority` BETWEEN 0 AND 100),
  CONSTRAINT `agent_goals_objective_check`
    CHECK (length(trim(`objective`)) BETWEEN 1 AND 8000),
  CONSTRAINT `agent_goals_status_check`
    CHECK (`status` IN ('active', 'paused', 'blocked', 'completed', 'cancelled', 'expired', 'budget_limited', 'failed')),
  CONSTRAINT `agent_goals_budgets_check`
    CHECK (
      (`max_turns` IS NULL OR `max_turns` > 0)
      AND (`max_tokens` IS NULL OR `max_tokens` > 0)
      AND (`max_duration_seconds` IS NULL OR `max_duration_seconds` > 0)
    ),
  CONSTRAINT `agent_goals_completion_policy_check`
    CHECK (`completion_policy` IN ('model_evaluator', 'tool_evidence', 'manual')),
  CONSTRAINT `agent_goals_source_check`
    CHECK (`source_type` IN ('user', 'loop', 'scheduled_job', 'insight', 'connector') AND (`source_type` = 'user' OR `source_id` IS NOT NULL)),
  CONSTRAINT `agent_goals_snapshot_check`
    CHECK (json_valid(`goal_snapshot`) AND json_type(`goal_snapshot`) = 'object'),
  CONSTRAINT `agent_goals_timestamps_check`
    CHECK (`updated_at` >= `created_at`)
);
--> statement-breakpoint
INSERT INTO `__drizzle_new_agent_goals` (
  `id`, `owner_id`, `runtime_session_id`, `slot`, `slot_state`, `revision`,
  `objective`, `priority`, `status`, `deadline`, `max_turns`, `max_tokens`,
  `max_duration_seconds`, `completion_policy`, `source_type`, `source_id`,
  `goal_snapshot`, `created_at`, `updated_at`
)
SELECT
  `id`, `owner_id`, `runtime_session_id`, `slot`, `slot_state`, `revision`,
  `objective`, `priority`, `status`, `deadline`, `max_turns`, `max_tokens`,
  `max_duration_seconds`, `completion_policy`, `source_type`, `source_id`,
  `goal_snapshot`, `created_at`, `updated_at`
FROM `agent_goals`;
--> statement-breakpoint
DROP TABLE `agent_goals`;
--> statement-breakpoint
ALTER TABLE `__drizzle_new_agent_goals` RENAME TO `agent_goals`;
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_goals_owner_session_id_key`
  ON `agent_goals` (`owner_id`, `runtime_session_id`, `id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_goals_assigned_primary_idx`
  ON `agent_goals` (`owner_id`, `runtime_session_id`)
  WHERE `slot` = 'primary' AND `slot_state` = 'assigned';
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_goals_reserved_primary_idx`
  ON `agent_goals` (`owner_id`, `runtime_session_id`)
  WHERE `slot` = 'primary' AND `slot_state` = 'reserved';
--> statement-breakpoint
CREATE INDEX `agent_goals_session_status_idx`
  ON `agent_goals` (`owner_id`, `runtime_session_id`, `status`);
