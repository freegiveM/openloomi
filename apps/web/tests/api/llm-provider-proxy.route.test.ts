import { beforeEach, describe, expect, it, vi } from "vitest";

const complete = vi.fn();
const resolveLlmProvider = vi.fn();

vi.mock("@/app/(auth)/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "user-1" } })),
}));
vi.mock("@/lib/env/constants", () => ({ isTauriMode: () => false }));
vi.mock("@/lib/ai/provider-resolver", () => ({ resolveLlmProvider }));

describe("provider-neutral LLM proxy routes", () => {
  beforeEach(() => {
    complete.mockReset();
    resolveLlmProvider.mockReset();
  });

  it("maps a Chat Completions stream onto a cross-protocol provider", async () => {
    resolveLlmProvider.mockResolvedValue({
      providerId: "anthropic_compatible",
      flavor: "anthropic_http",
      model: "claude-sonnet-4-6",
      complete,
    });
    complete.mockResolvedValue({
      text: "Hello from Claude",
      model: "claude-sonnet-4-6",
      usage: { inputTokens: 12, outputTokens: 4 },
    });

    const { POST } = await import("@/app/api/ai/v1/chat/completions/route");
    const response = await POST(
      new Request("http://localhost/api/ai/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4o-mini",
          stream: true,
          messages: [
            { role: "user", content: "First question" },
            { role: "assistant", content: "First answer" },
            { role: "user", content: "Follow-up" },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("data: [DONE]");
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        userContent:
          "user:\nFirst question\n\nassistant:\nFirst answer\n\nuser:\nFollow-up",
      }),
    );
  });

  it("maps an Anthropic Messages request onto an OpenAI-compatible provider", async () => {
    resolveLlmProvider.mockResolvedValue({
      providerId: "deepseek",
      flavor: "openai_http",
      model: "deepseek-chat",
      complete,
    });
    complete.mockResolvedValue({
      text: "Hello from DeepSeek",
      model: "deepseek-chat",
      usage: { inputTokens: 9, outputTokens: 3 },
    });

    const { POST } = await import("@/app/api/ai/v1/messages/route");
    const response = await POST(
      new Request("http://localhost/api/ai/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 128,
          messages: [{ role: "user", content: "Hello" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: "message",
      model: "deepseek-chat",
      content: [{ type: "text", text: "Hello from DeepSeek" }],
      usage: { input_tokens: 9, output_tokens: 3 },
    });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-chat",
        userContent: "Hello",
        maxTokens: 128,
      }),
    );
  });
});
