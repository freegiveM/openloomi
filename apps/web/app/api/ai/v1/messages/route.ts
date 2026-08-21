/**
 * Anthropic Messages API proxy — `app/api/ai/v1/messages`.
 *
 * Mirrors `app/api/ai/v1/chat/completions/route.ts` (the OpenAI-compatible
 * proxy) but for the Anthropic Messages shape.
 *
 * Resolution uses {@link resolveLlmProvider}, so the call site automatically
 * maps the selected provider back to the Anthropic Messages response shape.
 *
 * Used by:
 *  - `app/api/chronicle/analyze/route.ts`           (vision analysis)
 *  - `app/api/chronicle/analyze-meeting/route.ts`   (meeting summarization)
 */
import { randomUUID } from "node:crypto";

import { auth } from "@/app/(auth)/auth";
import { isTauriMode } from "@/lib/env/constants";
import { resolveLlmProvider } from "@/lib/ai/provider-resolver";
import type { LlmImage, LlmUsage } from "@/lib/ai/provider";
import { AppError } from "@melandlabs/shared/errors";

export const runtime = "nodejs";

type MessagesBody = {
  model?: unknown;
  system?: unknown;
  messages?: unknown;
  max_tokens?: unknown;
  stream?: unknown;
  [key: string]: unknown;
};

// =============================================================================
// Agent runtime → Anthropic Messages translation
// =============================================================================

interface AnthropicMessage {
  role?: string;
  content?: unknown;
}

function flattenSystem(system: unknown): string | undefined {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const out: string[] = [];
    for (const block of system) {
      if (
        block &&
        typeof block === "object" &&
        "text" in block &&
        typeof (block as { text: unknown }).text === "string"
      ) {
        out.push((block as { text: string }).text);
      }
    }
    return out.length > 0 ? out.join("\n") : undefined;
  }
  return undefined;
}

function extractConversation(messages: unknown): {
  text: string;
  images: LlmImage[];
} {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { text: "", images: [] };
  }
  const turns: Array<{ role: string; text: string }> = [];
  const images: LlmImage[] = [];
  for (const item of messages) {
    const message = item as AnthropicMessage | undefined;
    if (!message || !["user", "assistant"].includes(message.role ?? "")) {
      continue;
    }
    const content = flattenMessageContent(message.content);
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
  return { text, images };
}

function flattenMessageContent(content: unknown): {
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
    const b = block as { type?: string; text?: unknown; source?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
    } else if (b.type === "image" && b.source && typeof b.source === "object") {
      const src = b.source as {
        type?: string;
        media_type?: unknown;
        data?: unknown;
      };
      if (
        src.type === "base64" &&
        typeof src.data === "string" &&
        typeof src.media_type === "string"
      ) {
        images.push({ base64: src.data, mediaType: src.media_type });
      }
    }
  }
  return { text: textParts.join("\n"), images };
}

function buildAnthropicMessagesResponse(
  text: string,
  model: string,
  usage: LlmUsage | undefined,
): Record<string, unknown> {
  return {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: usage
      ? {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
        }
      : { input_tokens: 0, output_tokens: 0 },
  };
}

function buildAnthropicMessagesStream(
  text: string,
  model: string,
  usage: LlmUsage | undefined,
): Response {
  const id = `msg_${randomUUID()}`;
  const events = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: usage?.inputTokens ?? 0, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: usage?.outputTokens ?? 0 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
  const payload = events
    .map(
      ({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
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
    console.error("[AI Proxy] Invalid messages payload", error);
    return null;
  })) as MessagesBody | null;

  if (!body) {
    return new AppError(
      "bad_request:api",
      "Invalid Anthropic messages payload",
    ).toResponse();
  }

  const provider = await resolveLlmProvider({
    userId: session?.user?.id,
    prefer: "anthropic_messages",
    endpoint: "messages",
  });

  if (!provider) {
    return new AppError(
      "bad_request:api",
      "No LLM provider or agent runtime is configured. Save one in Preferences → API Settings, or set LLM_PROVIDER.",
    ).toResponse();
  }

  const system = flattenSystem(body.system);
  const { text, images } = extractConversation(body.messages);
  // Only an Anthropic transport can safely interpret an Anthropic-shaped model
  // override. Cross-protocol adapters use the provider's configured model.
  const model =
    provider.flavor === "anthropic_http" &&
    typeof body.model === "string" &&
    body.model.trim()
      ? body.model
      : provider.model;
  const maxTokens =
    typeof body.max_tokens === "number" ? body.max_tokens : undefined;

  try {
    const response = await provider.complete({
      system,
      userContent: text,
      images: images.length > 0 ? images : undefined,
      model,
      maxTokens,
      timeoutMs: 120_000,
    });

    if (body.stream === true) {
      return buildAnthropicMessagesStream(
        response.text,
        response.model,
        response.usage,
      );
    }

    return new Response(
      JSON.stringify(
        buildAnthropicMessagesResponse(
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
    console.error("[AI Proxy] Messages request failed", error);
    return new AppError(
      "bad_request:api",
      error instanceof Error ? error.message : "Messages request failed",
    ).toResponse();
  }
}
