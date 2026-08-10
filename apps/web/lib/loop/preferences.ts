// Phase 5 — re-export shim over `@openloomi/loop/preferences`. The leaf
// module owns the Loop config.json reader/writer (`readPreferences` /
// `writePreferences`) plus the `LoopPreferences` shape and
// `DEFAULT_LOOP_PREFERENCES` constant. Defining the interface here
// (instead of leaving it inside the 843-line `apps/web/lib/loop/types.ts`)
// makes the new `@openloomi/loop` package truly self-contained.
//
// The old `apps/web/lib/loop/types.ts` re-exports `LoopPreferences` from
// here so existing call sites that import the type via `./types` keep
// working without any change.

export {
  readPreferences,
  writePreferences,
  DEFAULT_LOOP_PREFERENCES,
} from "@openloomi/loop/preferences";
export type {
  LoopPreferences,
  QuietDayFillerId,
} from "@openloomi/loop/preferences";
