export interface AgentChatRuntimePresentation {
  effectiveRunning: boolean;
  composerLocked: boolean;
  canStartRun: boolean;
  canStopFromBrowser: boolean;
}

/**
 * A recovered run is live in the server process but has no abort handle in the
 * reloaded browser. Keep it visibly busy and reject a second run, without
 * rendering a stop control that cannot reach the owning Query.
 */
export function resolveAgentChatRuntimePresentation(input: {
  browserRunActive: boolean;
  serverRecoveryActive: boolean;
  serverRecoveryPending?: boolean;
}): AgentChatRuntimePresentation {
  const recoveryOwnsOrMayOwnRun =
    input.serverRecoveryActive || input.serverRecoveryPending === true;
  return {
    effectiveRunning: input.browserRunActive || input.serverRecoveryActive,
    // A browser-owned run already has its normal submit guard and a real stop
    // handle. Do not make its composer look like a server-owned recovery merely
    // because the persistence read model observes the same live session.
    composerLocked: !input.browserRunActive && recoveryOwnsOrMayOwnRun,
    canStartRun: !input.browserRunActive && !recoveryOwnsOrMayOwnRun,
    // If the browser has a real abort handle, keep its functional stop even
    // while the server read model also observes the ordinary live lease.
    canStopFromBrowser: input.browserRunActive,
  };
}
