/**
 * Known error classification for agent responses.
 *
 * This module provides error classification utilities used to detect
 * and handle specific error conditions in agent responses.
 */

/**
 * Error environment types detected by classifyAgentError
 */
export type AgentErrorEnvironment =
  | "INSUFFICIENT_CONTEXT"
  | "AUTH_FAILURE"
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "UNKNOWN";

export interface ClassifyAgentErrorOptions {
  /** When true, uses stricter matching criteria */
  strict?: boolean;
}

/**
 * Classify an agent error response into a known error environment.
 * Returns the error environment string if classified, or null if not an error.
 */
export function classifyAgentError(
  answer: string,
  options?: ClassifyAgentErrorOptions,
): string | null {
  if (!answer || typeof answer !== "string") return null;

  const strict = options?.strict ?? false;

  // Error prefix patterns
  if (/^Error:\s*/i.test(answer.trim())) {
    if (strict) {
      // In strict mode, also check for specific error messages
      const lowerAnswer = answer.toLowerCase();
      if (
        lowerAnswer.includes("authentication") ||
        lowerAnswer.includes("auth")
      ) {
        return "AUTH_FAILURE";
      }
      if (
        lowerAnswer.includes("timeout") ||
        lowerAnswer.includes("timed out")
      ) {
        return "TIMEOUT";
      }
      if (
        lowerAnswer.includes("rate limit") ||
        lowerAnswer.includes("too many requests")
      ) {
        return "RATE_LIMIT";
      }
    }
    return "UNKNOWN";
  }

  // Common insufficient context patterns
  const insufficientPatterns = strict
    ? [
        /I don'?t have enough information/i,
        /cannot answer with current context/i,
        /insufficient context/i,
        /not enough context/i,
      ]
    : [
        /I don'?t know/i,
        /I can'?t answer/i,
        /cannot provide/i,
        /don'?t have enough/i,
        /insufficient information/i,
      ];

  for (const pattern of insufficientPatterns) {
    if (pattern.test(answer)) {
      return "INSUFFICIENT_CONTEXT";
    }
  }

  // Apology patterns indicating failure to answer
  const apologyPatterns = [
    /抱歉|对不起|很抱歉/i,
    /sorry,? I (couldn\'t|can\'t|was unable to)/i,
  ];

  for (const pattern of apologyPatterns) {
    if (pattern.test(answer)) {
      return "INSUFFICIENT_CONTEXT";
    }
  }

  return null;
}

/**
 * Check if an error environment indicates a retryable error.
 */
export function isRetryableError(environment: string | null): boolean {
  if (!environment) return false;
  return ["TIMEOUT", "RATE_LIMIT"].includes(environment);
}

/**
 * Check if an error environment indicates an authentication error.
 */
export function isAuthError(environment: string | null): boolean {
  if (!environment) return false;
  return environment === "AUTH_FAILURE";
}
