import { describe, expect, test } from "vitest";

import {
  CODEX_LOGIN_COMMAND,
  getCodexInstallCommand,
} from "@/lib/ai/native-agent/runtime-installation";

describe("native agent runtime installation", () => {
  test("provides the official standalone installer for each platform", () => {
    expect(getCodexInstallCommand("windows")).toBe(
      'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
    );
    expect(getCodexInstallCommand("macos")).toBe(
      "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    );
    expect(getCodexInstallCommand("linux")).toBe(
      "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    );
  });

  test("uses the browser-login command after installation", () => {
    expect(CODEX_LOGIN_COMMAND).toBe("codex login");
  });
});
