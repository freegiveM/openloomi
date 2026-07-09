/**
 * Token usage record + summary types.
 *
 * The recorder writes one row to the `llm_usage` table per usage-bearing
 * message emitted by an LLM endpoint (`/api/native/agent` today; future
 * endpoints like the AI API will reuse the same table and pick their
 * own `endpoint` value). The summary module aggregates those rows into
 * a stable shape consumed by the LOOMI Online card and the
 * `/api/llm/usage/summary` endpoint.
 *
 * Only token counts and provider/model metadata are stored. Prompt text,
 * tool inputs/outputs, and other response bodies must never be added here.
 */

/**
 * Result type accepted by {@link recordUsage}. The recorder only stores
 * numbers and metadata, never prompt/response content.
 */
export interface LlmUsageRecordInput {
  userId: string;
  providerType: string;
  model: string | null;
  endpoint: string;
  inputTokens: number;
  outputTokens: number;
  runId?: string | null;
  phase?: string;
}

/**
 * The public summary shape returned by `/api/llm/usage/summary`.
 *
 * `configured` separates "user has no enabled provider" from
 * "user has a provider but no recorded usage yet" — the card renders
 * different copy in each case.
 */
export interface LlmUsageSummary {
  configured: boolean;
  providerSince: string | null;
  currentProvider?: {
    providerType: string;
    model: string | null;
    enabledSince: string;
  };
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  runCount: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
  trackedEndpoints: string[];
  trackedProviders: string[];
  /** ISO-8601 timestamp of when the summary was computed. */
  asOf: string;
  /** Populated only when the usage query could not be served. */
  error?: string;
}

export const LLM_USAGE_TRACKED_ENDPOINTS = ["native-agent"] as const;
export const LLM_USAGE_SUMMARY_TTL_MS = 30_000;
