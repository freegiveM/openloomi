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
  formatModelId: (model, providerConfig) => {
    const provider = normalizeHermesProviderConfig(providerConfig).env
      ?.HERMES_INFERENCE_PROVIDER;
    return provider && !model.startsWith(`${provider}:`)
      ? `${provider}:${model}`
      : model;
  },
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
