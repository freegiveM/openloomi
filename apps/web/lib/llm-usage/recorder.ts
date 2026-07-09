/**
 * Recorder for native-agent (and other tracked LLM endpoint) token usage.
 *
 * Writes a single row to the `llm_usage` table per usage-bearing message
 * emitted by an LLM endpoint. The SSE loop in `/api/native/agent` calls
 * {@link recordUsage} for every `result` message that carries a `usage`
 * field; future endpoints (AI API, generate-reply, insights processor)
 * can call the same recorder with a different `endpoint` value and the
 * data lands in the same table.
 *
 * Storage design (replaces the prior per-user JSONL files):
 *   - PostgreSQL in server mode, SQLite in Tauri mode. Selection is
 *     delegated to {@link getDb} which dispatches based on `isTauriMode`.
 *   - Schema lives in `lib/db/schema*.ts` as `llmUsage`; migrations are
 *     `0106_llm_usage.sql` (SQLite) and `0108_llm_usage.sql` (Postgres).
 *     Both create the SQL table `llm_usage`.
 *   - Concurrent appends are handled by the DB engine, so we no longer
 *     keep an in-process serialization chain per userId. The summary
 *     module still subscribes via {@link onUsageRecorded} to invalidate
 *     its in-memory cache after a successful insert.
 *
 * Privacy: only token counts and provider/model metadata are stored.
 * Prompt text, response bodies, and tool inputs/outputs are never
 * written here.
 */

import { getDb } from "@/lib/db/adapters";
import { llmUsage } from "@/lib/db/schema";

import type { LlmUsageRecordInput } from "./types";

/**
 * Best-effort cache invalidation hook. The summary module subscribes so
 * it can drop a cached entry right after a successful insert without
 * creating a circular import (summary.ts already imports recorder).
 */
type InvalidateFn = (userId: string) => void;
const invalidators = new Set<InvalidateFn>();

export function onUsageRecorded(fn: InvalidateFn): () => void {
  invalidators.add(fn);
  return () => {
    invalidators.delete(fn);
  };
}

function notifyInvalidate(userId: string): void {
  for (const fn of invalidators) {
    try {
      fn(userId);
    } catch (error) {
      console.warn("[llm-usage] cache invalidator threw:", error);
    }
  }
}

/**
 * Insert a single usage record. Failures are swallowed (with a warning)
 * so a recorder error never propagates back into the SSE loop in
 * `/api/native/agent`. Returns `true` on success, `false` on failure.
 */
export async function recordUsage(
  input: LlmUsageRecordInput,
): Promise<boolean> {
  const { userId } = input;
  if (!userId) {
    console.warn("[llm-usage] recordUsage called without userId");
    return false;
  }

  const inputTokens = sanitizeNumber(input.inputTokens);
  const outputTokens = sanitizeNumber(input.outputTokens);
  if (inputTokens === null || outputTokens === null) {
    console.warn("[llm-usage] recordUsage got non-numeric tokens; skipping", {
      userId,
      inputTokens,
      outputTokens,
    });
    return false;
  }

  const providerType = sanitizeString(input.providerType) ?? "unknown";
  const endpoint = sanitizeString(input.endpoint) ?? "native-agent";
  const model = sanitizeNullableString(input.model);
  const runId = sanitizeNullableString(input.runId ?? null);

  try {
    const db = getDb();
    await db.insert(llmUsage).values({
      userId,
      ts: new Date(),
      providerType,
      model,
      endpoint,
      inputTokens,
      outputTokens,
      runId,
    });
    notifyInvalidate(userId);
    return true;
  } catch (error) {
    console.warn("[llm-usage] recordUsage insert failed:", error);
    return false;
  }
}

function sanitizeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function sanitizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function sanitizeNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return sanitizeString(value);
}

/**
 * Test-only helper. The DB now owns write serialization, so there's no
 * in-process state to clear here. Subscribers (e.g. the summary cache
 * invalidator) are intentionally preserved across calls so the
 * recorder → summary invalidation chain still works between `it` blocks
 * in the same test file.
 *
 * Not part of the public API.
 */
export function __resetRecorderForTests(): void {
  // intentional no-op; kept for backwards compatibility with the
  // previous JSONL recorder's test API.
}
