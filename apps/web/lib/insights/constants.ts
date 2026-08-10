// Phase 6 — re-export shim over `@openloomi/insights/constants`. The leaf
// module owns the `DEBUG` / `EMAIL_TASK_LABEL` / `MAX_EMAIL_INSIGHTS` /
// `CALENDAR_*` / `DEFAULT_CATEGORIES` / `INSIGHT_TYPE_TAGS` / `CONTENT_TAGS`
// constants plus the `InsightTypeTag` / `ContentTag` type aliases. Pure
// `process.env` + inline literals — no DB / agent / integration deps.

export {
  DEBUG,
  EMAIL_TASK_LABEL,
  MAX_EMAIL_INSIGHTS,
  CALENDAR_TASK_LABEL,
  CALENDAR_UPCOMING_WINDOW_MS,
  DEFAULT_GROUP_CONCURRENCY,
  MAX_GROUP_CONCURRENCY,
  MIN_GROUP_CONCURRENCY,
  DEFAULT_CATEGORIES,
  INSIGHT_TYPE_TAGS,
  CONTENT_TAGS,
} from "@openloomi/insights/constants";
export type { InsightTypeTag, ContentTag } from "@openloomi/insights/constants";
