import { isAbsolute } from "node:path";

import type { AgentRuntimeRecovery } from "@openloomi/ai/agent/types";

/** Validates the trusted recovery envelope before a provider starts. */
export function validateAgentRuntimeRecovery(
  recovery: AgentRuntimeRecovery | undefined,
): AgentRuntimeRecovery | undefined {
  if (!recovery) return undefined;

  for (const [field, value] of [
    ["runtimeSessionId", recovery.runtimeSessionId],
    ["providerSessionId", recovery.providerSessionId],
  ] as const) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 256 ||
      value !== value.trim()
    ) {
      throw new TypeError(`${field} must be a non-empty identifier`);
    }
  }
  if (
    typeof recovery.workingDirectory !== "string" ||
    recovery.workingDirectory.length === 0 ||
    recovery.workingDirectory !== recovery.workingDirectory.trim() ||
    !isAbsolute(recovery.workingDirectory)
  ) {
    throw new TypeError("workingDirectory must be an absolute path");
  }
  if (!Number.isInteger(recovery.runEpoch) || recovery.runEpoch < 0) {
    throw new TypeError("runEpoch must be a non-negative integer");
  }
  if (
    recovery.recoveryLeaseToken !== undefined &&
    (recovery.recoveryLeaseToken.length === 0 ||
      recovery.recoveryLeaseToken.length > 512 ||
      recovery.recoveryLeaseToken !== recovery.recoveryLeaseToken.trim())
  ) {
    throw new TypeError("recoveryLeaseToken must be a non-empty token");
  }
  return recovery;
}
