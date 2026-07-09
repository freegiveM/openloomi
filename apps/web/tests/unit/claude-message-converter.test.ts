/**
 * Unit tests for Claude adapter → AgentMessage usage extraction.
 *
 * The Claude Code CLI emits `result` events with a snake_case `usage`
 * payload (input_tokens / output_tokens). The adapter's job is to lift that
 * into the camelCase `{ inputTokens, outputTokens }` shape the LLM-usage
 * recorder consumes. Without this forwarding, every Claude-adapter call
 * shows up as `usage=0` in the LOOMI Online card even though Claude Code
 * reported the numbers.
 */

import { describe, expect, it } from "vitest";

import {
  convertClaudeSdkMessage,
  extractClaudeResultUsage,
} from "@/lib/ai/extensions/agent/claude/message-converter";

describe("extractClaudeResultUsage", () => {
  it("maps input_tokens / output_tokens to the camelCase AgentMessage shape", () => {
    expect(
      extractClaudeResultUsage({
        input_tokens: 32663,
        output_tokens: 43,
      }),
    ).toEqual({ inputTokens: 32663, outputTokens: 43 });
  });

  it("returns undefined when the usage block is missing", () => {
    expect(extractClaudeResultUsage(undefined)).toBeUndefined();
    expect(extractClaudeResultUsage(null)).toBeUndefined();
    expect(extractClaudeResultUsage("nope")).toBeUndefined();
  });

  it("returns undefined when token counts are not finite numbers", () => {
    expect(
      extractClaudeResultUsage({ input_tokens: "32663", output_tokens: 43 }),
    ).toBeUndefined();
    expect(
      extractClaudeResultUsage({ input_tokens: 32663, output_tokens: null }),
    ).toBeUndefined();
    expect(
      extractClaudeResultUsage({ input_tokens: Number.NaN, output_tokens: 1 }),
    ).toBeUndefined();
  });

  it("ignores extra Claude Code usage keys (cache_*, server_tool_use, etc.)", () => {
    expect(
      extractClaudeResultUsage({
        input_tokens: 32663,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 128,
        output_tokens: 43,
        server_tool_use: { web_search_requests: 0 },
      }),
    ).toEqual({ inputTokens: 32663, outputTokens: 43 });
  });
});

describe("convertClaudeSdkMessage — result events", () => {
  const makeOpts = () => ({
    sentTextHashes: new Set<string>(),
    sentToolIds: new Set<string>(),
    hasStreamedText: false,
    createMessageId: () => `msg-${Math.random()}`,
  });

  it("forwards Claude Code usage onto the result AgentMessage", () => {
    const messages = Array.from(
      convertClaudeSdkMessage({
        message: {
          type: "result",
          subtype: "success",
          total_cost_usd: 0.032,
          duration_ms: 6028,
          usage: { input_tokens: 32663, output_tokens: 43 },
        },
        ...makeOpts(),
      }),
    );
    expect(messages).toEqual([
      {
        type: "result",
        content: "success",
        cost: 0.032,
        duration: 6028,
        usage: { inputTokens: 32663, outputTokens: 43 },
      },
    ]);
  });

  it("omits the usage key when Claude Code reports none", () => {
    const messages = Array.from(
      convertClaudeSdkMessage({
        message: {
          type: "result",
          subtype: "success",
          total_cost_usd: 0.032,
          duration_ms: 6028,
        },
        ...makeOpts(),
      }),
    );
    expect(messages).toEqual([
      {
        type: "result",
        content: "success",
        cost: 0.032,
        duration: 6028,
      },
    ]);
  });

  it("omits the usage key when the usage block is malformed", () => {
    const messages = Array.from(
      convertClaudeSdkMessage({
        message: {
          type: "result",
          subtype: "success",
          usage: { input_tokens: "32663" },
        },
        ...makeOpts(),
      }),
    );
    expect(messages[0]).toEqual({
      type: "result",
      content: "success",
    });
    expect("usage" in (messages[0] as object)).toBe(false);
  });
});
