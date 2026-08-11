// Phase 6 — re-export shim over `@openloomi/insights/platform-filter-config`.
// The leaf module owns `PLATFORM_FILTER_SUPPORT`,
// `getSupportedFilterFields`, `isFieldSupportedByAllPlatforms`,
// `getFilterFieldLabel`, `getFilterFieldDescription`. Type-only deps on
// `@/hooks/use-integrations` (for `IntegrationId`) and
// `@/lib/insights/filter-schema` (for `InsightFilterCondition`).

export {
  PLATFORM_FILTER_SUPPORT,
  getSupportedFilterFields,
  isFieldSupportedByAllPlatforms,
  getFilterFieldLabel,
  getFilterFieldDescription,
} from "@openloomi/insights/platform-filter-config";
