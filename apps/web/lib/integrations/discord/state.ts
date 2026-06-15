/**
 * Discord Adapter - Pure Function State Layer
 *
 * Contains pure functions for:
 * - Connection state resolution
 * - Message deduplication
 * - Error classification
 * - Chunk boundary calculation
 */

// ============================================================================
// Types
// ============================================================================

/** Connection state enum */
export type DiscordConnectionState =
  | "connecting"
  | "connected"
  | "disconnected";

/** Error type classification */
export type DiscordErrorType = "network" | "auth" | "rate_limit" | "unknown";

/** Error classification result */
export interface DiscordErrorClassification {
  type: DiscordErrorType;
  retryable: boolean;
}

/** Chunk pagination boundary result */
export interface ChunkBoundary {
  shouldStop: boolean;
  remaining: number;
}

// ============================================================================
// F1: Connection State Resolution
// ============================================================================

/**
 * Resolves Discord connection state based on client ready status.
 *
 * @param isReady - Whether the Discord client is in ready state
 * @returns Connection state: "connecting" | "connected" | "disconnected"
 */
export function resolveDiscordConnectionState(
  isReady: boolean | null | undefined,
): DiscordConnectionState {
  // Treat null/undefined as "disconnected" (not ready, not attempting)
  if (!isReady) {
    return "disconnected";
  }
  // When client is ready, we are in connected state
  return "connected";
}

// ============================================================================
// F2: Message Deduplication
// ============================================================================

/**
 * Determines whether a message should be processed (idempotency check).
 *
 * @param messageId - The unique message ID to check
 * @param processedIds - Set of already processed message IDs
 * @returns true if message should be processed, false if already processed
 */
export function shouldProcessMessage(
  messageId: string,
  processedIds: Set<string>,
): boolean {
  // If messageId is already in processedIds, skip (already handled)
  // If not in processedIds, add to set and return true (process it)
  if (processedIds.has(messageId)) {
    return false;
  }
  processedIds.add(messageId);
  return true;
}

// ============================================================================
// F3: Error Classification
// ============================================================================

/**
 * Classifies Discord errors to determine retry strategy.
 *
 * @param error - Unknown error from Discord.js operations
 * @returns Classification result with error type and retryability
 */
export function classifyDiscordError(
  error: unknown,
): DiscordErrorClassification {
  // Handle non-Error inputs
  if (!(error instanceof Error)) {
    return { type: "unknown", retryable: false };
  }

  const message = error.message.toLowerCase();
  const name = error.name?.toLowerCase() ?? "";

  // Auth errors - non-retryable
  if (
    message.includes("401") ||
    message.includes("unauthorized") ||
    message.includes("invalid token") ||
    message.includes("authentication failed") ||
    name.includes("authenticationerror")
  ) {
    return { type: "auth", retryable: false };
  }

  // Rate limit errors - retryable with backoff
  if (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("rate limit")
  ) {
    return { type: "rate_limit", retryable: true };
  }

  // Network errors - retryable
  if (
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("enotfound") ||
    message.includes("socket hang up") ||
    message.includes("network error") ||
    message.includes("fetch failed") ||
    (name.includes("typeerror") && message.includes("fetch"))
  ) {
    return { type: "network", retryable: true };
  }

  // Gateway errors - potentially retryable
  if (
    message.includes("gateway") ||
    message.includes("discordapierror") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503")
  ) {
    return { type: "network", retryable: true };
  }

  // Default to unknown
  return { type: "unknown", retryable: false };
}

// ============================================================================
// F4: Chunk Boundary Calculation
// ============================================================================

/**
 * Calculates chunk pagination boundary for message extraction.
 *
 * @param extractedCount - Number of messages already extracted
 * @param maxChunkCount - Maximum messages allowed per chunk
 * @param channelMessageCount - Number of messages in current channel
 * @returns Boundary result with stop flag and remaining count
 */
export function calculateChunkBoundary(
  extractedCount: number,
  maxChunkCount: number,
  channelMessageCount: number,
): ChunkBoundary {
  const remaining = maxChunkCount - extractedCount;
  const shouldStop = extractedCount >= maxChunkCount;
  return { shouldStop, remaining: Math.max(0, remaining) };
}
