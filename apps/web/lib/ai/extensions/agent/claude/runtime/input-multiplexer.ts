import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSupplementalInput, AgentSupplementalInputSource } from "@/lib/ai/agent/types-shim";

/**
 * Converts the initial request and the live OpenLoomi input channel into the
 * single ordered stream expected by the Claude Agent SDK.
 */
export class ClaudeInputMultiplexer {
  constructor(
    private readonly initialPrompt: string | AsyncIterable<SDKUserMessage>,
    private readonly sessionId: string,
    private readonly supplementalInput: AgentSupplementalInputSource,
  ) {}

  toSdkPrompt(): AsyncIterable<SDKUserMessage> {
    return this.stream();
  }

  private async *stream(): AsyncGenerator<SDKUserMessage> {
    if (typeof this.initialPrompt === "string") {
      yield toClaudeUserMessage(this.initialPrompt, this.sessionId);
    } else {
      yield* this.initialPrompt;
    }

    for await (const input of this.supplementalInput) {
      yield toClaudeSupplementalMessage(input, this.sessionId);
    }
  }
}

/**
 * Starts the resumed SDK process without querying the model. The SDK does not
 * emit its system/init message until an AsyncIterable prompt yields at least
 * one item, so an empty iterable deadlocks the recovery identity barrier. A
 * synthetic, non-querying, empty message is sufficient to initialize the
 * exact resumed session while leaving the first real turn to the durable Goal
 * instruction outbox.
 */
export function createClaudeRecoveryInitialPrompt(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      let emitted = false;
      return {
        next: async () => {
          if (emitted) return { value: undefined, done: true };
          emitted = true;
          return {
            value: {
              type: "user",
              message: { role: "user", content: "" },
              parent_tool_use_id: null,
              isSynthetic: true,
              shouldQuery: false,
            },
            done: false,
          };
        },
      };
    },
  };
}

function toClaudeSupplementalMessage(
  input: AgentSupplementalInput,
  sessionId: string,
): SDKUserMessage {
  return {
    ...toClaudeUserMessage(input.content, sessionId),
    priority: input.intent === "inform" ? "next" : "now",
    shouldQuery: true,
    timestamp: input.createdAt,
  };
}

function toClaudeUserMessage(
  content: string,
  sessionId: string,
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}
