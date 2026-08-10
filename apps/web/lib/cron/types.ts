// Phase 5 — `apps/web/lib/cron/types.ts` is now a re-export shim over
// `@openloomi/cron/types`. The original Drizzle `ScheduledJob` import
// was replaced in the new package with a structural `ScheduledJobLike`
// interface so the cron leaf doesn't drag the entire Drizzle schema
// along. The Drizzle type is still imported directly by
// `local-scheduler.ts` (from `@/lib/db/schema`) — that file stays in
// `apps/web/lib/cron/` for now and will move in a later phase.

export type {
  CronJob,
  ExecuteJobOptions,
  JobAgentStreamEvent,
  JobConfig,
  JobExecutionContext,
  JobExecutionResult,
  JobTimezoneSource,
  ScheduleConfig,
  ScheduledJobLike,
  SchedulerConfig,
  SchedulerEvent,
} from "@openloomi/cron/types";
