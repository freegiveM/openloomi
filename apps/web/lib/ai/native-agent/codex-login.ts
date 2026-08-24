import "server-only";

import type { ChildProcess } from "node:child_process";

import spawn from "cross-spawn";

import {
  buildAgentCliSearchPath,
  shouldDetachCliProcess,
  terminateCliProcessTree,
  trackCliProcess,
} from "@/lib/ai/extensions/agent/cli-process";
import { resolveCodexCommand } from "@/lib/ai/extensions/agent/codex/command-resolver";
import { buildCodexProcessEnvironment } from "./codex-process-environment";

const CODEX_LOGIN_TIMEOUT_MS = 9 * 60 * 1000;

export type CodexLoginResult =
  | { status: "completed" }
  | { status: "failed" }
  | { status: "timed_out" }
  | { status: "unavailable" };

const loginGlobal = globalThis as typeof globalThis & {
  __openLoomiCodexLogin?: Promise<CodexLoginResult>;
};

/** Run the CLI-owned browser sign-in flow once for this OS account. */
export function runCodexLogin(): Promise<CodexLoginResult> {
  const activeLogin = loginGlobal.__openLoomiCodexLogin;
  if (activeLogin) return activeLogin;

  const pending = launchCodexLogin();
  loginGlobal.__openLoomiCodexLogin = pending;
  const clearActiveLogin = () => {
    if (loginGlobal.__openLoomiCodexLogin === pending) {
      Reflect.deleteProperty(loginGlobal, "__openLoomiCodexLogin");
    }
  };
  void pending.then(clearActiveLogin, clearActiveLogin);
  return pending;
}

function launchCodexLogin(): Promise<CodexLoginResult> {
  const searchPath = buildAgentCliSearchPath();
  let command: string;
  try {
    command = resolveCodexCommand({
      configuredCommand: process.env.OPENLOOMI_AGENT_CODEX_COMMAND,
      searchPath,
    });
  } catch {
    return Promise.resolve({ status: "unavailable" });
  }

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, ["login"], {
        detached: shouldDetachCliProcess(),
        env: buildCodexProcessEnvironment(searchPath),
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve({ status: "failed" });
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      terminateCliProcessTree(child);
      settle({ status: "timed_out" });
    }, CODEX_LOGIN_TIMEOUT_MS);
    timer.unref?.();
    const settle = (result: CodexLoginResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    trackCliProcess(child);
    child.once("error", () => settle({ status: "failed" }));
    child.once("close", (code) => {
      settle({ status: code === 0 ? "completed" : "failed" });
    });
  });
}
