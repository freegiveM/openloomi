// Phase 6 — re-export shim over `@openloomi/insights/refresh-telemetry`.
// The leaf module owns `formatTimingError` and `shouldLogTimingEvent`,
// plus the `TimingEvent` and `ShouldLogTimingEventOptions` interfaces.
// Pure utility — no external imports.

export {
  formatTimingError,
  shouldLogTimingEvent,
} from "@openloomi/insights/refresh-telemetry";
export type {
  TimingEvent,
  ShouldLogTimingEventOptions,
} from "@openloomi/insights/refresh-telemetry";
