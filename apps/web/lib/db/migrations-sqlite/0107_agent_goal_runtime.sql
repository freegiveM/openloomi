CREATE TABLE IF NOT EXISTS `agent_runtime_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL,
  `provider` text DEFAULT 'claude' NOT NULL,
  `provider_session_id` text,
  `working_directory` text,
  `state` text DEFAULT 'starting' NOT NULL,
  `run_epoch` integer DEFAULT 0 NOT NULL,
  `last_instruction_sequence` integer DEFAULT 0 NOT NULL,
  `pending_operation` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`owner_id`) REFERENCES `User`(`id`) ON DELETE CASCADE,
  CONSTRAINT `agent_runtime_sessions_provider_check`
    CHECK (`provider` IN ('claude')),
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
CREATE UNIQUE INDEX IF NOT EXISTS `agent_runtime_sessions_owner_id_id_key`
  ON `agent_runtime_sessions` (`owner_id`, `id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_runtime_sessions_provider_session_idx`
  ON `agent_runtime_sessions` (`provider`, `provider_session_id`)
  WHERE `provider_session_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_runtime_sessions_recovery_idx`
  ON `agent_runtime_sessions` (`owner_id`, `state`, `updated_at`)
  WHERE `state` NOT IN ('closed', 'failed');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `agent_goals` (
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
      (`deadline` IS NOT NULL OR `max_turns` IS NOT NULL OR `max_tokens` IS NOT NULL OR `max_duration_seconds` IS NOT NULL)
      AND (`max_turns` IS NULL OR `max_turns` > 0)
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
CREATE UNIQUE INDEX IF NOT EXISTS `agent_goals_owner_session_id_key`
  ON `agent_goals` (`owner_id`, `runtime_session_id`, `id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_goals_assigned_primary_idx`
  ON `agent_goals` (`owner_id`, `runtime_session_id`)
  WHERE `slot` = 'primary' AND `slot_state` = 'assigned';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_goals_reserved_primary_idx`
  ON `agent_goals` (`owner_id`, `runtime_session_id`)
  WHERE `slot` = 'primary' AND `slot_state` = 'reserved';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_goals_session_status_idx`
  ON `agent_goals` (`owner_id`, `runtime_session_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_goals_active_deadline_idx`
  ON `agent_goals` (`owner_id`, `deadline`)
  WHERE `slot_state` = 'assigned' AND `status` = 'active' AND `deadline` IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `agent_goal_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL,
  `runtime_session_id` text NOT NULL,
  `goal_id` text NOT NULL,
  `goal_revision` integer NOT NULL,
  `run_epoch` integer NOT NULL,
  `provider_session_id` text,
  `status` text NOT NULL,
  `turns_used` integer DEFAULT 0 NOT NULL,
  `tokens_used` integer DEFAULT 0 NOT NULL,
  `started_at` integer NOT NULL,
  `last_activity_at` integer NOT NULL,
  `completed_at` integer,
  `last_evaluation` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  CONSTRAINT `agent_goal_runs_owner_session_fkey`
    FOREIGN KEY (`owner_id`, `runtime_session_id`)
    REFERENCES `agent_runtime_sessions`(`owner_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `agent_goal_runs_owner_session_goal_fkey`
    FOREIGN KEY (`owner_id`, `runtime_session_id`, `goal_id`)
    REFERENCES `agent_goals`(`owner_id`, `runtime_session_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `agent_goal_runs_goal_revision_check`
    CHECK (`goal_revision` > 0),
  CONSTRAINT `agent_goal_runs_run_epoch_check`
    CHECK (`run_epoch` >= 0),
  CONSTRAINT `agent_goal_runs_status_check`
    CHECK (`status` IN ('queued', 'running', 'evaluating', 'continuing', 'paused', 'blocked', 'completed', 'cancelled', 'budget_limited', 'failed')),
  CONSTRAINT `agent_goal_runs_completion_check`
    CHECK ((`status` IN ('completed', 'cancelled', 'budget_limited', 'failed') AND `completed_at` IS NOT NULL) OR (`status` NOT IN ('completed', 'cancelled', 'budget_limited', 'failed') AND `completed_at` IS NULL)),
  CONSTRAINT `agent_goal_runs_usage_check`
    CHECK (`turns_used` >= 0 AND `tokens_used` >= 0),
  CONSTRAINT `agent_goal_runs_evaluation_check`
    CHECK (`last_evaluation` IS NULL OR (json_valid(`last_evaluation`) AND json_type(`last_evaluation`) = 'object')),
  CONSTRAINT `agent_goal_runs_activity_check`
    CHECK (`last_activity_at` >= `started_at` AND (`completed_at` IS NULL OR `completed_at` >= `last_activity_at`)),
  CONSTRAINT `agent_goal_runs_timestamps_check`
    CHECK (`updated_at` >= `created_at`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_goal_runs_owner_session_id_key`
  ON `agent_goal_runs` (`owner_id`, `runtime_session_id`, `id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_goal_runs_owner_session_id_epoch_key`
  ON `agent_goal_runs` (`owner_id`, `runtime_session_id`, `id`, `run_epoch`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_goal_runs_goal_epoch_key`
  ON `agent_goal_runs` (`owner_id`, `goal_id`, `run_epoch`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_goal_runs_session_status_idx`
  ON `agent_goal_runs` (`owner_id`, `runtime_session_id`, `status`, `last_activity_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_goal_runs_recovery_idx`
  ON `agent_goal_runs` (`owner_id`, `status`, `last_activity_at`)
  WHERE `status` NOT IN ('completed', 'cancelled', 'budget_limited', 'failed');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `agent_runtime_instructions` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL,
  `runtime_session_id` text NOT NULL,
  `schema_version` text DEFAULT '2' NOT NULL,
  `sequence` integer NOT NULL,
  `run_epoch` integer NOT NULL,
  `goal_id` text,
  `goal_revision` integer,
  `kind` text NOT NULL,
  `delivery_mode` text NOT NULL,
  `payload` text NOT NULL,
  `source_type` text NOT NULL,
  `source_authority` text NOT NULL,
  `source_ref` text,
  `idempotency_key` text NOT NULL,
  `request_fingerprint` text NOT NULL,
  `command_order` integer DEFAULT 0 NOT NULL,
  `command_type` text,
  `command_phase` text,
  `command_checkpoint` text,
  `instruction_snapshot` text NOT NULL,
  `issued_at` integer NOT NULL,
  `expires_at` integer,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  CONSTRAINT `agent_runtime_instructions_owner_session_fkey`
    FOREIGN KEY (`owner_id`, `runtime_session_id`)
    REFERENCES `agent_runtime_sessions`(`owner_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `agent_runtime_instructions_owner_session_goal_fkey`
    FOREIGN KEY (`owner_id`, `runtime_session_id`, `goal_id`)
    REFERENCES `agent_goals`(`owner_id`, `runtime_session_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `agent_runtime_instructions_schema_version_check`
    CHECK (`schema_version` = '2'),
  CONSTRAINT `agent_runtime_instructions_sequence_check`
    CHECK (`sequence` > 0 AND `run_epoch` >= 0),
  CONSTRAINT `agent_runtime_instructions_goal_revision_check`
    CHECK ((`goal_id` IS NULL AND `goal_revision` IS NULL) OR (`goal_id` IS NOT NULL AND `goal_revision` IS NOT NULL AND `goal_revision` > 0)),
  CONSTRAINT `agent_runtime_instructions_kind_check`
    CHECK (`kind` IN ('goal.activate', 'goal.update', 'goal.pause', 'goal.resume', 'goal.cancel', 'goal.continue', 'context.upsert', 'context.remove', 'constraint.upsert', 'constraint.remove', 'control.interrupt')),
  CONSTRAINT `agent_runtime_instructions_delivery_mode_check`
    CHECK (`delivery_mode` IN ('steer', 'next_boundary', 'interrupt_replace') AND (`kind` NOT IN ('goal.pause', 'goal.cancel', 'control.interrupt') OR `delivery_mode` = 'interrupt_replace')),
  CONSTRAINT `agent_runtime_instructions_payload_check`
    CHECK (json_valid(`payload`) AND json_type(`payload`) = 'object'),
  CONSTRAINT `agent_runtime_instructions_source_check`
    CHECK (
      ((`source_type` = 'user' AND `source_authority` = 'user')
        OR (`source_type` = 'automation' AND `source_authority` = 'automation')
        OR (`source_type` = 'connector' AND `source_authority` = 'untrusted_data')
        OR (`source_type` = 'policy' AND `source_authority` = 'organization_policy'))
      AND (`source_type` NOT IN ('connector', 'policy') OR `source_ref` IS NOT NULL)
      AND (`source_authority` <> 'untrusted_data' OR `kind` IN ('context.upsert', 'context.remove'))
    ),
  CONSTRAINT `agent_runtime_instructions_fingerprint_check`
    CHECK (length(`request_fingerprint`) = 64 AND `request_fingerprint` NOT GLOB '*[^0-9A-Fa-f]*'),
  CONSTRAINT `agent_runtime_instructions_command_root_check`
    CHECK (
      (`command_order` = 0 AND `command_type` IS NOT NULL AND `command_phase` IS NOT NULL AND `command_checkpoint` IS NOT NULL)
      OR (`command_order` > 0 AND `command_type` IS NULL AND `command_phase` IS NULL AND `command_checkpoint` IS NULL)
    ),
  CONSTRAINT `agent_runtime_instructions_command_phase_check`
    CHECK (
      (`command_type` IS NULL AND `command_phase` IS NULL)
      OR (`command_type` = 'goal_instruction' AND `command_phase` = 'committed')
      OR (`command_type` = 'lifecycle' AND `command_phase` IN ('prepared', 'boundary_observed', 'finalized'))
      OR (`command_type` = 'replacement' AND `command_phase` IN ('prepared', 'boundary_observed', 'activated'))
    ),
  CONSTRAINT `agent_runtime_instructions_checkpoint_check`
    CHECK (`command_checkpoint` IS NULL OR (json_valid(`command_checkpoint`) AND json_type(`command_checkpoint`) = 'object')),
  CONSTRAINT `agent_runtime_instructions_snapshot_check`
    CHECK (json_valid(`instruction_snapshot`) AND json_type(`instruction_snapshot`) = 'object'),
  CONSTRAINT `agent_runtime_instructions_expiry_check`
    CHECK (`expires_at` IS NULL OR `expires_at` >= `issued_at`),
  CONSTRAINT `agent_runtime_instructions_timestamps_check`
    CHECK (`updated_at` >= `created_at`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_runtime_instructions_owner_session_id_key`
  ON `agent_runtime_instructions` (`owner_id`, `runtime_session_id`, `id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_runtime_instructions_owner_session_id_epoch_key`
  ON `agent_runtime_instructions` (`owner_id`, `runtime_session_id`, `id`, `run_epoch`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_runtime_instructions_sequence_key`
  ON `agent_runtime_instructions` (`owner_id`, `runtime_session_id`, `sequence`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_runtime_instructions_idempotency_key`
  ON `agent_runtime_instructions` (`owner_id`, `runtime_session_id`, `idempotency_key`, `command_order`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_runtime_instructions_pending_command_idx`
  ON `agent_runtime_instructions` (`owner_id`, `runtime_session_id`)
  WHERE `command_phase` IN ('prepared', 'boundary_observed');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_runtime_instructions_goal_revision_idx`
  ON `agent_runtime_instructions` (`owner_id`, `goal_id`, `goal_revision`, `sequence`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_runtime_instructions_expiry_idx`
  ON `agent_runtime_instructions` (`expires_at`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `agent_runtime_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL,
  `runtime_session_id` text NOT NULL,
  `instruction_id` text NOT NULL,
  `goal_run_id` text,
  `run_epoch` integer NOT NULL,
  `state` text DEFAULT 'pending' NOT NULL,
  `attempt` integer NOT NULL,
  `available_at` integer DEFAULT (unixepoch()) NOT NULL,
  `lease_token` text,
  `lease_owner` text,
  `lease_expires_at` integer,
  `provider_event_id` text,
  `error_code` text,
  `error_message` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  CONSTRAINT `agent_runtime_deliveries_owner_session_fkey`
    FOREIGN KEY (`owner_id`, `runtime_session_id`)
    REFERENCES `agent_runtime_sessions`(`owner_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `agent_runtime_deliveries_instruction_fkey`
    FOREIGN KEY (`owner_id`, `runtime_session_id`, `instruction_id`, `run_epoch`)
    REFERENCES `agent_runtime_instructions`(`owner_id`, `runtime_session_id`, `id`, `run_epoch`) ON DELETE CASCADE,
  CONSTRAINT `agent_runtime_deliveries_goal_run_fkey`
    FOREIGN KEY (`owner_id`, `runtime_session_id`, `goal_run_id`, `run_epoch`)
    REFERENCES `agent_goal_runs`(`owner_id`, `runtime_session_id`, `id`, `run_epoch`) ON DELETE CASCADE,
  CONSTRAINT `agent_runtime_deliveries_state_check`
    CHECK (`state` IN ('pending', 'leased', 'queued', 'written_to_sdk', 'observed', 'applied', 'completed', 'rejected', 'expired', 'superseded', 'cancelled', 'failed')),
  CONSTRAINT `agent_runtime_deliveries_attempt_check`
    CHECK (`attempt` > 0 AND `run_epoch` >= 0),
  CONSTRAINT `agent_runtime_deliveries_lease_check`
    CHECK (
      (`state` = 'leased' AND `lease_token` IS NOT NULL AND `lease_owner` IS NOT NULL AND `lease_expires_at` IS NOT NULL)
      OR (`state` <> 'leased' AND `lease_token` IS NULL AND `lease_owner` IS NULL AND `lease_expires_at` IS NULL)
    ),
  CONSTRAINT `agent_runtime_deliveries_timestamps_check`
    CHECK (`updated_at` >= `created_at`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_runtime_deliveries_attempt_key`
  ON `agent_runtime_deliveries` (`instruction_id`, `attempt`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_runtime_deliveries_active_attempt_idx`
  ON `agent_runtime_deliveries` (`instruction_id`)
  WHERE `state` IN ('pending', 'leased', 'queued', 'written_to_sdk', 'observed', 'applied');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_runtime_deliveries_lease_idx`
  ON `agent_runtime_deliveries` (`state`, `available_at`, `lease_expires_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_runtime_deliveries_session_state_idx`
  ON `agent_runtime_deliveries` (`owner_id`, `runtime_session_id`, `state`, `updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_runtime_deliveries_goal_run_idx`
  ON `agent_runtime_deliveries` (`goal_run_id`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `agent_goal_evidence` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL,
  `runtime_session_id` text NOT NULL,
  `goal_id` text NOT NULL,
  `goal_run_id` text NOT NULL,
  `instruction_id` text,
  `goal_revision` integer NOT NULL,
  `run_epoch` integer NOT NULL,
  `criterion_id` text,
  `type` text NOT NULL,
  `source_event_id` text NOT NULL,
  `summary` text NOT NULL,
  `success` integer,
  `payload` text NOT NULL,
  `observed_at` integer NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  CONSTRAINT `agent_goal_evidence_owner_session_goal_fkey`
    FOREIGN KEY (`owner_id`, `runtime_session_id`, `goal_id`)
    REFERENCES `agent_goals`(`owner_id`, `runtime_session_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `agent_goal_evidence_owner_session_run_fkey`
    FOREIGN KEY (`owner_id`, `runtime_session_id`, `goal_run_id`, `run_epoch`)
    REFERENCES `agent_goal_runs`(`owner_id`, `runtime_session_id`, `id`, `run_epoch`) ON DELETE CASCADE,
  CONSTRAINT `agent_goal_evidence_owner_session_instruction_fkey`
    FOREIGN KEY (`owner_id`, `runtime_session_id`, `instruction_id`, `run_epoch`)
    REFERENCES `agent_runtime_instructions`(`owner_id`, `runtime_session_id`, `id`, `run_epoch`) ON DELETE CASCADE,
  CONSTRAINT `agent_goal_evidence_revision_check`
    CHECK (`goal_revision` > 0 AND `run_epoch` >= 0),
  CONSTRAINT `agent_goal_evidence_type_check`
    CHECK (`type` IN ('command_result', 'tool_result', 'test_result', 'file_change', 'agent_report', 'hook_result', 'manual_attestation', 'evaluation')),
  CONSTRAINT `agent_goal_evidence_payload_check`
    CHECK (json_valid(`payload`)),
  CONSTRAINT `agent_goal_evidence_success_check`
    CHECK (`success` IS NULL OR `success` IN (0, 1)),
  CONSTRAINT `agent_goal_evidence_source_event_check`
    CHECK (length(trim(`source_event_id`)) BETWEEN 1 AND 256),
  CONSTRAINT `agent_goal_evidence_summary_check`
    CHECK (length(trim(`summary`)) BETWEEN 1 AND 8000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_goal_evidence_run_source_event_key`
  ON `agent_goal_evidence` (`goal_run_id`, `source_event_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_goal_evidence_goal_revision_idx`
  ON `agent_goal_evidence` (`owner_id`, `goal_id`, `goal_revision`, `observed_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_goal_evidence_criterion_idx`
  ON `agent_goal_evidence` (`goal_run_id`, `criterion_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_goal_evidence_instruction_idx`
  ON `agent_goal_evidence` (`instruction_id`);
