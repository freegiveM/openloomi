import "server-only";

import type { ChildProcess } from "node:child_process";
import { homedir, platform } from "node:os";
import { win32 } from "node:path";

import spawn from "cross-spawn";

import {
  buildAgentCliSearchPath,
  shouldDetachCliProcess,
  terminateCliProcessTree,
  trackCliProcess,
} from "@/lib/ai/extensions/agent/cli-process";
import { resolveCodexCommand } from "@/lib/ai/extensions/agent/codex/command-resolver";
import {
  buildCodexProcessEnvironment,
  readProcessEnvironmentValue,
} from "./codex-process-environment";
import { CODEX_WINDOWS_INSTALLER_URL } from "./runtime-installation";

const CODEX_INSTALL_TIMEOUT_MS = 8 * 60 * 1000;
const CODEX_INSTALL_SCRIPT = `Invoke-RestMethod -Uri '${CODEX_WINDOWS_INSTALLER_URL}' | Invoke-Expression`;

export type CodexInstallResult =
  | { status: "completed" }
  | { status: "failed" }
  | { status: "powershell_unavailable" }
  | { status: "timed_out" }
  | { status: "unsupported" }
  | { status: "verification_failed" };

const installGlobal = globalThis as typeof globalThis & {
  __openLoomiCodexInstall?: Promise<CodexInstallResult>;
};

/** Install the official standalone Windows bundle once for this OS account. */
export function runCodexInstall(): Promise<CodexInstallResult> {
  if (platform() !== "win32") {
    return Promise.resolve({ status: "unsupported" });
  }

  const activeInstall = installGlobal.__openLoomiCodexInstall;
  if (activeInstall) return activeInstall;

  const pending = launchCodexInstall();
  installGlobal.__openLoomiCodexInstall = pending;
  const clearActiveInstall = () => {
    if (installGlobal.__openLoomiCodexInstall === pending) {
      Reflect.deleteProperty(installGlobal, "__openLoomiCodexInstall");
    }
  };
  void pending.then(clearActiveInstall, clearActiveInstall);
  return pending;
}

function launchCodexInstall(): Promise<CodexInstallResult> {
  const searchPath = buildAgentCliSearchPath();
  try {
    resolveCodexCommand({ searchPath });
    return Promise.resolve({ status: "completed" });
  } catch {
    // The setup button is idempotent: only install when no complete Codex
    // bundle is currently discoverable.
  }
  const configuredLocalAppData =
    readProcessEnvironmentValue("LOCALAPPDATA")?.trim();
  const defaultLocalAppData = win32.join(homedir(), "AppData", "Local");
  const localAppData =
    configuredLocalAppData && win32.isAbsolute(configuredLocalAppData)
      ? configuredLocalAppData
      : defaultLocalAppData;
  const configuredWindowsRoot =
    readProcessEnvironmentValue("SYSTEMROOT")?.trim() ||
    readProcessEnvironmentValue("WINDIR")?.trim();
  const windowsRoot =
    configuredWindowsRoot && win32.isAbsolute(configuredWindowsRoot)
      ? configuredWindowsRoot
      : "C:\\Windows";
  const powershell = win32.join(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const environment = buildCodexProcessEnvironment(searchPath, {
    omit: ["CODEX_INSTALL_DIR"],
    overrides: {
      CODEX_INSTALLER_USE_RELEASES_OPENAI_COM: "1",
      CODEX_NON_INTERACTIVE: "1",
      CODEX_RELEASE: "latest",
      LOCALAPPDATA: localAppData,
      OS: "Windows_NT",
    },
  });

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(
        powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          CODEX_INSTALL_SCRIPT,
        ],
        {
          detached: shouldDetachCliProcess(),
          env: environment,
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      );
    } catch {
      resolve({ status: "powershell_unavailable" });
      return;
    }

    let settled = false;
    const settle = (result: CodexInstallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      terminateCliProcessTree(child);
      settle({ status: "timed_out" });
    }, CODEX_INSTALL_TIMEOUT_MS);
    timer.unref?.();

    trackCliProcess(child);
    child.once("error", () => settle({ status: "powershell_unavailable" }));
    child.once("close", (code) => {
      if (code !== 0) {
        settle({ status: "failed" });
        return;
      }
      try {
        // The installer updates the persisted user PATH, not this Node process.
        // Rebuild the desktop search path and require a complete Codex bundle.
        resolveCodexCommand({ searchPath: buildAgentCliSearchPath() });
        settle({ status: "completed" });
      } catch {
        settle({ status: "verification_failed" });
      }
    });
  });
}
