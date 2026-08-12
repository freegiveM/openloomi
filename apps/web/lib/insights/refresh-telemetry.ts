// Phase 6 — re-export shim over `@melandlabs/insights/refresh-telemetry`.
// The leaf module owns `formatTimingError` and `shouldLogTimingEvent`,
// plus the `TimingEvent` and `ShouldLogTimingEventOptions` interfaces.
// Pure utility — no external imports.

export {
  formatTimingError,
  shouldLogTimingEvent,
} from "@melandlabs/insights";
export type {
  TimingEvent,
  ShouldLogTimingEventOptions,
} from "@melandlabs/insights";
