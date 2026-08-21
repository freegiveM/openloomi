/**
 * LLM provider resolver + three concrete provider implementations.
 *
 * The resolver is the single entry point every "AI API" call site should go
 * through: chat, Chronicle analyze, embeddings, anything that currently
 * fetches `/api/ai/v1/messages` or `/api/ai/v1/chat/completions` directly.
 *
 * Resolution order (see {@link resolveLlmProvider}):
 *   1. The user's enabled provider, or the environment-selected provider.
 *      Provider identity chooses its HTTP or Bedrock adapter.
 *   2. The configured agent runtime (`OPENLOOMI_AGENT_PROVIDER`) — returns
 *      an {@link AgentRuntimeProvider} that shells out to the matching CLI.
 *   3. `undefined` — caller surfaces a config error to the user.
 */

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAgentRegistry } from "@melandlabs/ai/agent";
import type { NativeAgentRequest } from "@melandlabs/ai/agent/native-runner";
import type {
  AgentConfig,
  AgentMessage,
  AgentOptions,
  AgentProvider,
} from "@melandlabs/ai/agent";
import { generateText, type UserContent } from "ai";

import { nativeAgentHost } from "./native-agent/host";
import {
  buildAnthropicMessagesUrl,
  buildOpenAiChatCompletionsUrl,
} from "./llm-providers";
import { createLlmLanguageModel } from "./provider-model";
import { resolveNativeAgentProviderRequest } from "./native-agent/provider-env";
import type {
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmImage,
  LlmProvider,
  ProviderKind,
} from "./provider";
import { recordUsage } from "../llm-usage/recorder";
import {
  getActiveUserLlmProviderConfig,
  type UserLlmProviderConfig,
} from "./user-llm-api-settings";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Resolve the LLM provider for a call site.
 *
 * `prefer` documents the caller's external API shape. The active provider is
 * not changed by that shape; adapters normalize the request and response.
 */
export async function resolveLlmProvider({
  userId,
  prefer: _prefer,
  endpoint,
}: {
  userId?: string;
  prefer: ProviderKind;
  endpoint?: string;
}): Promise<LlmProvider | undefined> {
  // Step 1: the user's single enabled provider, then environment config.
  // Provider identity selects the adapter; the incoming API shape is mapped
  // to the unified completion request and does not override that choice.
  const config = await getActiveUserLlmProviderConfig(userId);
  if (config) {
    let provider: LlmProvider;
    if (config.providerType === "bedrock") {
      provider = new BedrockConverseProvider(config);
    } else if (config.providerType === "anthropic_compatible") {
      provider = new AnthropicMessagesHttpProvider(config);
    } else {
      provider = new OpenAIChatHttpProvider(config);
    }
    return withUsageRecording(provider, userId, endpoint);
  }

  // Step 2: agent runtime. We use the same resolution function the Loop's
  // tick prompt uses (`resolveNativeAgentProviderRequest`) so the call site
  // stays in sync with whatever runtime the user picked for the Loop.
  const stub: NativeAgentRequest = { prompt: "", provider: undefined };
  const resolved = resolveNativeAgentProviderRequest(stub);
  const runtime = resolved?.provider;

  if (runtime && runtime !== "claude") {
    // Non-Claude runtimes are almost certainly the user's deliberate choice
    // (codex, opencode, hermes, openclaw). Honor it.
    return withUsageRecording(
      new AgentRuntimeProvider({ runtime }),
      userId,
      endpoint,
    );
  }

  // Claude runtime: the default. The user has not opted into anything
  // specific, so we don't reach for `claude` CLI here — that would shell
  // out on every chat call when the user might be expecting the API
  // defaults. Callers that want `claude` CLI explicitly can wire that up
  // later via a UI toggle.
  return undefined;
}

// =============================================================================
// HTTP providers — wrap the existing fetch() calls.
// =============================================================================

class AnthropicMessagesHttpProvider implements LlmProvider {
  readonly providerId: string;
  readonly flavor = "anthropic_http" as const;
  readonly model: string;

  constructor(private readonly config: UserLlmProviderConfig) {
    this.providerId = config.providerId;
    this.model = config.model;
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const userContent: Array<Record<string, unknown>> = [];
    for (const img of request.images ?? []) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType,
          data: img.base64,
        },
      });
    }
    const text = flattenUserText(request.userContent);
    if (text) {
      userContent.push({ type: "text", text });
    }

    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      max_tokens: request.maxTokens ?? 4096,
      stream: false,
      system: request.system,
      messages: [{ role: "user", content: userContent }],
    };

    if (!this.config.baseUrl || !this.config.apiKey) {
      throw new Error(
        "Anthropic-compatible provider requires a base URL and API key",
      );
    }
    const targetUrl = buildAnthropicMessagesUrl(this.config.baseUrl);
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        Authorization: `Bearer ${this.config.apiKey}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal:
        request.signal ??
        AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Anthropic Messages API ${response.status}: ${errText.slice(0, 300)}`,
      );
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const textOut = (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return {
      text: textOut,
      model: request.model ?? this.model,
      usage: data.usage
        ? {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
          }
        : undefined,
    };
  }
}

class OpenAIChatHttpProvider implements LlmProvider {
  readonly providerId: string;
  readonly flavor = "openai_http" as const;
  readonly model: string;

  constructor(private readonly config: UserLlmProviderConfig) {
    this.providerId = config.providerId;
    this.model = config.model;
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const contentParts: Array<Record<string, unknown>> = [];
    for (const img of request.images ?? []) {
      contentParts.push({
        type: "image_url",
        image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
      });
    }
    const text = flattenUserText(request.userContent);
    if (text) {
      contentParts.push({ type: "text", text });
    }

    const messages: Array<{ role: string; content: unknown }> = [];
    if (request.system) {
      messages.push({ role: "system", content: request.system });
    }
    messages.push({ role: "user", content: contentParts });

    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      max_tokens: request.maxTokens ?? 4096,
      stream: false,
      messages,
    };

    if (!this.config.baseUrl) {
      throw new Error("OpenAI-compatible provider requires a base URL");
    }
    const targetUrl = buildOpenAiChatCompletionsUrl(this.config.baseUrl);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    if (this.config.providerId === "openrouter") {
      headers["HTTP-Referer"] =
        process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3515";
      headers["X-Title"] = "OpenLoomi";
    }
    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal:
        request.signal ??
        AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Chat Completions API ${response.status}: ${errText.slice(0, 300)}`,
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const textOut = data.choices?.[0]?.message?.content?.trim() ?? "";
    return {
      text: textOut,
      model: request.model ?? this.model,
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }
}

class BedrockConverseProvider implements LlmProvider {
  readonly providerId: string;
  readonly flavor = "bedrock" as const;
  readonly model: string;

  constructor(private readonly config: UserLlmProviderConfig) {
    this.providerId = config.providerId;
    this.model = config.model;
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const text = flattenUserText(request.userContent);
    const content: UserContent = [
      ...((request.images ?? []).map((image) => ({
        type: "image" as const,
        image: Buffer.from(image.base64, "base64"),
        mediaType: image.mediaType,
      })) as Exclude<UserContent, string>),
      { type: "text", text },
    ];
    const result = await generateText({
      model: createLlmLanguageModel(this.config, request.model ?? this.model),
      system: request.system,
      messages: [{ role: "user", content }],
      maxOutputTokens: request.maxTokens ?? 4096,
      abortSignal:
        request.signal ??
        AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    return {
      text: result.text.trim(),
      model: request.model ?? this.model,
      usage: result.usage
        ? {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
          }
        : undefined,
    };
  }
}

// =============================================================================
// Agent runtime provider — invoke the configured CLI
// =============================================================================

/**
 * Wraps a registered agent runtime (Codex / Claude / OpenCode / Hermes /
 * Openclaw) as a single-shot completion provider.
 *
 * The agent's `run(prompt, options)` returns an `AsyncGenerator<AgentMessage>`;
 * this provider collects the `text` events and assembles a single response.
 * Image inputs are written to a temp directory and the path is included in
 * the prompt, because not every CLI accepts image bytes directly — Codex
 * doesn't, for example. Claude's SDK path additionally receives the image
 * via `options.images` and can short-circuit the file-read step.
 */
class AgentRuntimeProvider implements LlmProvider {
  readonly providerId: string;
  readonly flavor = "agent_runtime" as const;
  readonly model: string;

  constructor(private readonly options: { runtime: string }) {
    this.providerId = options.runtime;
    this.model = "agent-runtime";
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    // Resolve the runtime's providerConfig + model from env (same source the
    // Loop tick uses, via `resolveNativeAgentProviderRequest`).
    const stub: NativeAgentRequest = {
      prompt: "",
      provider: this.options.runtime as AgentProvider,
    };
    const resolved = resolveNativeAgentProviderRequest(stub);
    const provider = (resolved.provider ??
      this.options.runtime) as AgentProvider;

    if (nativeAgentHost.registerProvider) {
      await nativeAgentHost.registerProvider(provider);
    } else {
      await nativeAgentHost.registerProviders?.();
    }

    const config: AgentConfig = {
      provider,
      model: request.model ?? resolved.modelConfig?.model,
      providerConfig: resolved.providerConfig,
      workDir: tmpdir(),
    };

    const registry = getAgentRegistry();
    const agent = registry.create(config);

    // Image handling: materialize to disk and embed the path in the prompt.
    // The Claude path additionally receives the bytes via `options.images`,
    // so it can use the SDK's native vision path; other CLIs (Codex, etc.)
    // fall back to reading the file from disk.
    const imagePaths = await materializeImages(request.images ?? []);

    const userText = flattenUserText(request.userContent);
    const promptParts: string[] = [];
    if (request.system) {
      promptParts.push(request.system);
    }
    if (imagePaths.length > 0) {
      promptParts.push(
        `[System Note: ${imagePaths.length} image(s) have been saved to disk; read them and incorporate into your response:\n${imagePaths
          .map((p) => `- ${p}`)
          .join(
            "\n",
          )}]\n\nIf you cannot read images directly, describe what you would do with them and ask the user to provide the image text.`,
      );
    }
    if (userText) {
      promptParts.push(userText);
    }
    const finalPrompt = promptParts.join("\n\n");

    // Set up abort + timeout.
    const abortController = new AbortController();
    if (request.signal) {
      if (request.signal.aborted) {
        abortController.abort();
      } else {
        request.signal.addEventListener(
          "abort",
          () => abortController.abort(),
          {
            once: true,
          },
        );
      }
    }
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => abortController.abort(), timeoutMs);

    const agentOptions: AgentOptions = {
      cwd: config.workDir,
      permissionMode: "acceptEdits",
      // Disable state-mutating tools; the agent should just read the image
      // and return text. Tools that are pure-read (Read, Glob, Grep) stay
      // available so the agent can resolve the file path.
      disallowedTools: [
        "Bash",
        "Write",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "WebFetch",
        "WebSearch",
        "Skill",
        "Task",
        "TodoWrite",
        "LSP",
      ],
      abortController,
      stream: true,
      images: (request.images ?? []).map((img) => ({
        data: img.base64,
        mimeType: img.mediaType,
      })),
    };

    let text = "";
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let sawError: string | undefined;

    try {
      for await (const message of agent.run(finalPrompt, agentOptions)) {
        accumulateAgentMessage(message, {
          onText: (chunk) => {
            text += chunk;
          },
          onUsage: (u) => {
            usage = u;
          },
          onError: (msg) => {
            sawError = msg;
          },
        });
        if (sawError) break;
      }
    } finally {
      clearTimeout(timer);
    }

    if (sawError) {
      throw new Error(
        `Agent runtime ${this.options.runtime} error: ${sawError}`,
      );
    }

    return {
      text: text.trim(),
      model: request.model ?? config.model ?? this.model,
      usage,
    };
  }
}

// =============================================================================
// Shared helpers
// =============================================================================

function flattenUserText(
  userContent: string | Array<{ type: "text"; text: string }>,
): string {
  if (typeof userContent === "string") return userContent;
  return userContent
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function withUsageRecording(
  provider: LlmProvider,
  userId: string | undefined,
  endpoint: string | undefined,
): LlmProvider {
  if (!userId || !endpoint) return provider;

  return {
    providerId: provider.providerId,
    flavor: provider.flavor,
    model: provider.model,
    async complete(request) {
      const response = await provider.complete(request);
      if (response.usage) {
        await recordUsage({
          userId,
          providerType: provider.providerId,
          model: response.model,
          endpoint,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        });
      }
      return response;
    },
  };
}

async function materializeImages(images: LlmImage[]): Promise<string[]> {
  if (images.length === 0) return [];
  const dir = tmpdir();
  const paths: string[] = [];
  for (const img of images) {
    const ext = mediaTypeToExt(img.mediaType);
    const filename = `openloomi-img-${randomUUID()}.${ext}`;
    const path = join(dir, filename);
    await writeFile(path, Buffer.from(img.base64, "base64"));
    paths.push(path);
  }
  return paths;
}

function mediaTypeToExt(mediaType: string): string {
  switch (mediaType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

function accumulateAgentMessage(
  message: AgentMessage,
  sinks: {
    onText: (chunk: string) => void;
    onUsage: (usage: { inputTokens: number; outputTokens: number }) => void;
    onError: (msg: string) => void;
  },
): void {
  if (message.type === "text" && message.content) {
    sinks.onText(message.content);
  } else if (message.type === "result" && message.usage) {
    sinks.onUsage(message.usage);
  } else if (message.type === "error" && message.message) {
    sinks.onError(message.message);
  }
}
