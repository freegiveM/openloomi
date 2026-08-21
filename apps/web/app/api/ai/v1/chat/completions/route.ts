/**
 * OpenAI Chat Completions API proxy — `app/api/ai/v1/chat/completions`.
 *
 * Mirrors `app/api/ai/v1/messages/route.ts` (the Anthropic Messages proxy) but
 * for the OpenAI Chat Completions shape.
 *
 * Resolution uses {@link resolveLlmProvider}, so the call site automatically
 * maps the selected provider back to the Chat Completions response shape.
 */
import { randomUUID } from "node:crypto";

import { auth } from "@/app/(auth)/auth";
import { isTauriMode } from "@/lib/env/constants";
import { resolveLlmProvider } from "@/lib/ai/provider-resolver";
import type { LlmImage, LlmUsage } from "@/lib/ai/provider";
import { AppError } from "@melandlabs/shared/errors";

export const runtime = "nodejs";

type ChatCompletionsBody = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  [key: string]: unknown;
};

// =============================================================================
// Agent runtime → Chat Completions translation
// =============================================================================

interface ChatMessage {
  role?: string;
  content?: unknown;
}

function extractMessages(messages: unknown): {
  system: string | undefined;
  text: string;
  images: LlmImage[];
} {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { system: undefined, text: "", images: [] };
  }

  const systemParts: string[] = [];
  for (const m of messages) {
    const msg = m as ChatMessage | undefined;
    if (msg?.role === "system") {
      const flattened = flattenContentText(msg.content);
      if (flattened) systemParts.push(flattened);
    }
  }
  const system = systemParts.length > 0 ? systemParts.join("\n") : undefined;

  const turns: Array<{ role: string; text: string }> = [];
  const images: LlmImage[] = [];
  for (const item of messages) {
    const message = item as ChatMessage | undefined;
    if (!message || !["user", "assistant"].includes(message.role ?? "")) {
      continue;
    }
    const content = flattenContentWithImages(message.content);
    images.push(...content.images);
    if (content.text) {
      turns.push({ role: message.role as string, text: content.text });
    }
  }
  const text =
    turns.length === 1 && turns[0].role === "user"
      ? turns[0].text
      : turns
          .map(({ role, text: turnText }) => `${role}:\n${turnText}`)
          .join("\n\n");
  return { system, text, images };
}

function flattenContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      out.push((block as { text: string }).text);
    }
  }
  return out.join("\n");
}

function flattenContentWithImages(content: unknown): {
  text: string;
  images: LlmImage[];
} {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  if (!Array.isArray(content)) {
    return { text: "", images: [] };
  }
  const textParts: string[] = [];
  const images: LlmImage[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: unknown; image_url?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
    } else if (
      b.type === "image_url" &&
      b.image_url &&
      typeof b.image_url === "object"
    ) {
      const url = (b.image_url as { url?: unknown }).url;
      if (typeof url === "string") {
        const parsed = parseDataUrl(url);
        if (parsed) {
          images.push({ base64: parsed.data, mediaType: parsed.mediaType });
        }
      }
    }
  }
  return { text: textParts.join("\n"), images };
}

function parseDataUrl(
  url: string,
): { data: string; mediaType: string } | undefined {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return undefined;
  return { mediaType: match[1], data: match[2] };
}

function buildChatCompletionResponse(
  text: string,
  model: string,
  usage: LlmUsage | undefined,
): Record<string, unknown> {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: usage
      ? {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens: usage.inputTokens + usage.outputTokens,
        }
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function buildChatCompletionStream(
  text: string,
  model: string,
  usage: LlmUsage | undefined,
): Response {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: "chat.completion.chunk", created, model };
  const events = [
    {
      ...base,
      choices: [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: usage
        ? {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
          }
        : undefined,
    },
  ];
  const payload = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(payload, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

// =============================================================================
// POST handler
// =============================================================================

export async function POST(request: Request) {
  const session = await auth().catch(() => null);
  if (!session?.user?.id && !isTauriMode()) {
    return new AppError("unauthorized:auth").toResponse();
  }

  const body = (await request.json().catch((error) => {
    console.error("[AI Proxy] Invalid chat completions payload", error);
    return null;
  })) as ChatCompletionsBody | null;

  if (!body) {
    return new AppError(
      "bad_request:api",
      "Invalid chat completions payload",
    ).toResponse();
  }

  const provider = await resolveLlmProvider({
    userId: session?.user?.id,
    prefer: "chat_completions",
    endpoint: "chat-completions",
  });

  if (!provider) {
    return new AppError(
      "bad_request:api",
      "No LLM provider or agent runtime is configured. Save one in /api/preferences/ai, or set LLM_PROVIDER.",
    ).toResponse();
  }

  const { system, text, images } = extractMessages(body.messages);
  // Only an OpenAI transport can safely interpret an OpenAI-shaped model
  // override. Cross-protocol adapters use the provider's configured model.
  const model =
    provider.flavor === "openai_http" &&
    typeof body.model === "string" &&
    body.model.trim() &&
    body.model !== "default" &&
    body.model !== "chat-model"
      ? body.model
      : provider.model;

  try {
    const response = await provider.complete({
      system,
      userContent: text,
      images: images.length > 0 ? images : undefined,
      model,
      timeoutMs: 120_000,
    });

    if (body.stream === true) {
      return buildChatCompletionStream(
        response.text,
        response.model,
        response.usage,
      );
    }

    return new Response(
      JSON.stringify(
        buildChatCompletionResponse(
          response.text,
          response.model,
          response.usage,
        ),
      ),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("[AI Proxy] Chat completions request failed", error);
    return new AppError(
      "bad_request:api",
      error instanceof Error
        ? error.message
        : "Chat completions request failed",
    ).toResponse();
  }
}
