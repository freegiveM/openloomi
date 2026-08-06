export type PersistedInstantPrecision = "exact" | "whole-second";

export const EXACT_PERSISTED_INSTANT_PRECISION =
  "exact" as const satisfies PersistedInstantPrecision;

export const WHOLE_SECOND_PERSISTED_INSTANT_PRECISION =
  "whole-second" as const satisfies PersistedInstantPrecision;
