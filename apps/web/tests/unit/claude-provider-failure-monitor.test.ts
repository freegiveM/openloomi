import { describe, expect, it, vi } from "vitest";

import {
  createClaudeProviderFailureSessionStore,
  isFatalClaudeProviderDiagnostic,
} from "@/lib/ai/extensions/agent/claude/runtime";

describe("Claude provider failure monitor", () => {
  it("reports only authoritative API-error entries from the expected main transcript", async () => {
    const onProviderFailure = vi.fn();
    const store = createClaudeProviderFailureSessionStore({
      expectedSessionId: "expected-session",
      onProviderFailure,
    });

    await store.append(
      { projectKey: "project", sessionId: "expected-session" },
      [
        { type: "assistant", isApiErrorMessage: false },
        { type: "assistant", isApiErrorMessage: true },
      ],
    );
    await store.append(
      {
        projectKey: "project",
        sessionId: "expected-session",
        subpath: "agent-a.jsonl",
      },
      [{ type: "assistant", isApiErrorMessage: true }],
    );
    await store.append(
      { projectKey: "project", sessionId: "different-session" },
      [{ type: "assistant", isApiErrorMessage: true }],
    );

    expect(onProviderFailure).toHaveBeenCalledOnce();
    await expect(
      store.load({ projectKey: "project", sessionId: "expected-session" }),
    ).resolves.toBeNull();
  });

  it("recognizes terminal request diagnostics but not retry or arbitrary stderr", () => {
    expect(
      isFatalClaudeProviderDiagnostic(
        "2026-08-12T02:57:36.340Z [ERROR] Error in API request: Content block not found",
      ),
    ).toBe(true);
    expect(
      isFatalClaudeProviderDiagnostic(
        "2026-08-12T02:57:35.340Z [ERROR] API error (attempt 1/11): 429",
      ),
    ).toBe(false);
    expect(
      isFatalClaudeProviderDiagnostic(
        "tool stderr: Error in API request: user-controlled text",
      ),
    ).toBe(false);
  });
});
