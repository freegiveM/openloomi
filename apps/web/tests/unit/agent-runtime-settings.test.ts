import { describe, expect, test } from "vitest";

import { toPublicProbe } from "@/lib/ai/native-agent/runtime-settings";
import type {
  CodexRuntimeProbe,
  NativeRuntimeProbe,
} from "@/lib/ai/native-agent/runtime-probe";

function codexProbe(overrides: Partial<CodexRuntimeProbe>): CodexRuntimeProbe {
  return {
    checked: true,
    provider: "codex",
    available: true,
    authenticated: false,
    active: false,
    ready: false,
    reason: "CODEX_CLI_AUTH_REQUIRED",
    cliPathPresent: true,
    cliPathSource: "PATH",
    versionPresent: true,
    version: "1.2.0",
    probes: {},
    ...overrides,
  };
}

describe("agent runtime public probe", () => {
  test("exposes a stable ready summary without command details", () => {
    const result = toPublicProbe(
      "codex",
      codexProbe({
        authenticated: true,
        active: true,
        ready: true,
        reason: "CODEX_CLI_AUTHENTICATED",
        probes: {
          auth: {
            ok: true,
            stdout: "account@example.test",
            stderr: "",
            exitCode: 0,
            error: null,
            elapsedMs: 5,
            timedOut: false,
          },
        },
      }),
    );

    expect(result).toEqual({
      provider: "codex",
      installed: true,
      authenticated: true,
      ready: true,
      status: "ready",
      version: "1.2.0",
      reason: "READY",
    });
    expect(JSON.stringify(result)).not.toContain("account@example.test");
  });

  test("separates missing, login-required, and failed probes", () => {
    const unavailable = toPublicProbe(
      "codex",
      codexProbe({
        available: false,
        cliPathPresent: false,
        cliPathSource: null,
        versionPresent: false,
        version: null,
        reason: "CODEX_CLI_UNAVAILABLE",
      }),
    );
    const loginRequired = toPublicProbe("codex", codexProbe({}));
    const failed = toPublicProbe(
      "codex",
      codexProbe({
        reason: "CODEX_CLI_VERSION_TIMEOUT",
        versionPresent: false,
        version: null,
      }),
    );

    expect(unavailable.status).toBe("not_installed");
    expect(unavailable.authenticated).toBeNull();
    expect(loginRequired.status).toBe("login_required");
    expect(loginRequired.authenticated).toBe(false);
    expect(failed.status).toBe("unverified");
    expect(failed.reason).toBe("VERSION_TIMEOUT");
  });

  test("treats a missing probe as unverified instead of not installed", () => {
    expect(toPublicProbe("claude", null)).toEqual({
      provider: "claude",
      installed: false,
      authenticated: null,
      ready: false,
      status: "unverified",
      version: null,
      reason: "PROBE_FAILED",
    });
  });

  test("accepts the existing Claude compatibility probe shape", () => {
    const probe: NativeRuntimeProbe = {
      checked: true,
      provider: "claude",
      defaultAgent: "claude",
      available: true,
      authenticated: false,
      active: false,
      ready: false,
      reason: "CLAUDE_CLI_AUTH_STATUS_UNAVAILABLE",
      cliPathPresent: true,
      cliPathSource: "BUNDLED",
      versionPresent: true,
      version: "2.1.3",
      probes: {},
    };

    expect(toPublicProbe("claude", probe)).toMatchObject({
      status: "unverified",
      reason: "AUTH_UNAVAILABLE",
      version: "2.1.3",
    });
  });
});
