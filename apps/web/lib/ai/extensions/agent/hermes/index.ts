import { defineAgentPlugin } from "@melandlabs/ai/agent";
import type { AgentPlugin } from "@melandlabs/ai/agent";
import type { AgentConfig } from "@melandlabs/ai/agent";

import { AcpAgent, type AcpRuntimeDefinition } from "../acp/agent";
import {
  buildHermesAcpCommand,
  normalizeHermesProviderConfig,
} from "./command";
import { HERMES_METADATA } from "./metadata";

const HERMES_ACP_RUNTIME: AcpRuntimeDefinition = {
  provider: "hermes",
  displayName: "Hermes",
  buildCommand: buildHermesAcpCommand,
  normalizeProviderConfig: normalizeHermesProviderConfig,
  supportsSetModel: true,
};

export class HermesAgent extends AcpAgent {
  constructor(config: AgentConfig) {
    super(config, HERMES_ACP_RUNTIME);
  }
}

export function createHermesAgent(config: AgentConfig): HermesAgent {
  return new HermesAgent(config);
}

export const hermesPlugin: AgentPlugin = defineAgentPlugin({
  metadata: HERMES_METADATA,
  factory: createHermesAgent,
});
