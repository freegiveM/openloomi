import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeProviderFailureSessionStoreOptions {
  /** Exact provider session expected during durable recovery. */
  expectedSessionId?: string;
  onProviderFailure: () => void;
}

/**
 * Mirror-only SessionStore that observes the CLI's authoritative transcript
 * entry before compatibility layers strip `isApiErrorMessage`.
 *
 * Returning null from load leaves explicit SDK resume on the existing local
 * transcript. The store never retains prompt or response content.
 */
export function createClaudeProviderFailureSessionStore(
  options: ClaudeProviderFailureSessionStoreOptions,
): SessionStore {
  return {
    async append(key, entries) {
      if (!isExpectedMainTranscript(key, options.expectedSessionId)) return;
      if (entries.some(isProviderFailureEntry)) options.onProviderFailure();
    },
    async load() {
      return null;
    },
  };
}

/**
 * Match the Claude CLI's terminal request diagnostic, while excluding its
 * retry diagnostics (`API error (attempt n/m)`). The text is used only as a
 * boolean signal and must not cross the runtime boundary.
 */
export function isFatalClaudeProviderDiagnostic(line: string): boolean {
  return /^(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+\[ERROR\]\s+)?Error in API request:\s*\S/i.test(
    line.trim(),
  );
}

function isExpectedMainTranscript(
  key: SessionKey,
  expectedSessionId?: string,
): boolean {
  return (
    key.subpath === undefined &&
    (expectedSessionId === undefined || key.sessionId === expectedSessionId)
  );
}

function isProviderFailureEntry(entry: SessionStoreEntry): boolean {
  return entry.type === "assistant" && entry.isApiErrorMessage === true;
}
