import { canonicalJson } from "@melandlabs/ai/agent/runtime-instructions";

import { invalidPersistenceRecord } from "./errors";
import type { PersistedInstantPrecision } from "./instant-precision";

export type PersistenceRecord = Readonly<Record<string, unknown>>;

export function asPersistenceRecord(
  value: unknown,
  entity: string,
): PersistenceRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidPersistenceRecord(entity, "expected an object row");
  }
  return value as PersistenceRecord;
}

export function readRequiredString(
  row: PersistenceRecord,
  field: string,
  entity: string,
  maxCharacters = 256,
): string {
  const value = row[field];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxCharacters ||
    value.trim() !== value
  ) {
    invalidPersistenceRecord(entity, `${field} is not a valid identifier`);
  }
  return value;
}

export function readOptionalString(
  row: PersistenceRecord,
  field: string,
  entity: string,
  maxCharacters = 256,
): string | undefined {
  const value = row[field];
  if (value === undefined || value === null) return undefined;
  return readRequiredString({ [field]: value }, field, entity, maxCharacters);
}

export function readOptionalText(
  row: PersistenceRecord,
  field: string,
  entity: string,
): string | undefined {
  const value = row[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    invalidPersistenceRecord(entity, `${field} must be a string or null`);
  }
  return value;
}

export function readRequiredUuid(
  row: PersistenceRecord,
  field: string,
  entity: string,
): string {
  const value = readRequiredString(row, field, entity);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    invalidPersistenceRecord(entity, `${field} must be a UUID`);
  }
  return value;
}

export function readOptionalUuid(
  row: PersistenceRecord,
  field: string,
  entity: string,
): string | undefined {
  const value = row[field];
  if (value === undefined || value === null) return undefined;
  return readRequiredUuid({ [field]: value }, field, entity);
}

export function readRequiredInteger(
  row: PersistenceRecord,
  field: string,
  entity: string,
  minimum: number,
): number {
  const value = row[field];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalidPersistenceRecord(
      entity,
      `${field} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
  return value as number;
}

export function readOptionalBoolean(
  row: PersistenceRecord,
  field: string,
  entity: string,
): boolean | undefined {
  const value = row[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    invalidPersistenceRecord(entity, `${field} must be a boolean or null`);
  }
  return value;
}

export function normalizePersistedDate(
  value: unknown,
  field: string,
  entity: string,
): string {
  if (!(value instanceof Date) && typeof value !== "string") {
    invalidPersistenceRecord(entity, `${field} must be a Date or ISO string`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    invalidPersistenceRecord(entity, `${field} is not a valid date`);
  }
  return date.toISOString();
}

export function normalizeOptionalPersistedDate(
  value: unknown,
  field: string,
  entity: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizePersistedDate(value, field, entity);
}

export function parsePersistedJson(
  value: unknown,
  field: string,
  entity: string,
): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (cause) {
    invalidPersistenceRecord(entity, `${field} is not valid JSON`, cause);
  }
}

export function parsePersistedSchema<T>(
  // Schema type is intentionally `any` here: the published
  // `@melandlabs/ai/agent/runtime-instructions` schemas ship against the npm
  // package's nested zod v4 build, which differs from the workspace copy. The
  // structural shape (`safeParse` returning `{ success, data | error }`) is
  // identical, so callers still get a fully-typed `T` at the call site.
  schema: any,
  value: unknown,
  field: string,
  entity: string,
): T {
  let parsed = schema.safeParse(value);
  if (!parsed.success && typeof value === "string") {
    try {
      parsed = schema.safeParse(JSON.parse(value));
    } catch {
      // Scalar text columns are valid inputs for enum/string schemas. Keep the
      // direct validation error when the value is not serialized JSON.
    }
  }
  if (!parsed.success) {
    invalidPersistenceRecord(
      entity,
      `${field} failed validation`,
      parsed.error,
    );
  }
  return parsed.data as T;
}

export function assertPersistedEqual(
  entity: string,
  field: string,
  actual: unknown,
  expected: unknown,
): void {
  // `canonicalJson` intentionally accepts JSON values, while optional
  // snapshot fields are represented as `undefined` in the domain model.
  if (actual === undefined || expected === undefined) {
    if (actual === expected) return;
    invalidPersistenceRecord(
      entity,
      `${field} does not match its authoritative snapshot`,
    );
  }
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    invalidPersistenceRecord(
      entity,
      `${field} does not match its authoritative snapshot`,
    );
  }
}

export function assertPersistedInstantMatchesSnapshot(
  entity: string,
  field: string,
  persisted: string | undefined,
  snapshot: string | undefined,
  precision: PersistedInstantPrecision,
): void {
  if (persisted === undefined || snapshot === undefined) {
    assertPersistedEqual(entity, field, persisted, snapshot);
    return;
  }
  const persistedMillis = Date.parse(persisted);
  const snapshotMillis = Date.parse(snapshot);
  const matches =
    precision === "exact"
      ? persistedMillis === snapshotMillis
      : Math.floor(persistedMillis / 1_000) ===
        Math.floor(snapshotMillis / 1_000);
  if (
    !Number.isFinite(persistedMillis) ||
    !Number.isFinite(snapshotMillis) ||
    !matches
  ) {
    invalidPersistenceRecord(
      entity,
      `${field} does not match its authoritative snapshot`,
    );
  }
}

export function persistedInstantIsStrictlyAfter(
  later: Date,
  earlier: Date,
  precision: PersistedInstantPrecision,
): boolean {
  return precision === "exact"
    ? later.getTime() > earlier.getTime()
    : Math.floor(later.getTime() / 1_000) >
        Math.floor(earlier.getTime() / 1_000);
}

export function assertChronological(
  entity: string,
  earlierField: string,
  earlier: string,
  laterField: string,
  later: string,
): void {
  if (Date.parse(later) < Date.parse(earlier)) {
    invalidPersistenceRecord(
      entity,
      `${laterField} cannot be earlier than ${earlierField}`,
    );
  }
}

export function toDatabaseDate(
  value: string,
  field: string,
  entity: string,
): Date {
  return new Date(normalizePersistedDate(value, field, entity));
}
