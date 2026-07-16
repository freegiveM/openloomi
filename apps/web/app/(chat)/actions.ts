"use server";

import type { UIMessage } from "ai";
import { cookies } from "next/headers";
import { cache } from "react";
import {
  deleteMessagesByChatIdAfterTimestamp,
  getMessageById,
} from "@/lib/db/queries";
import { auth } from "@/app/(auth)/auth";
import { resolveLlmProvider } from "@/lib/ai/provider-resolver";
import {
  parseRawEmail,
  type ParsedEmailResult,
} from "@/lib/integrations/email/parser";

const COOKIE_CONFIRMATION_MAX_AGE = 60 * 24 * 60 * 60; // 60 days

export async function setCookiePreference(value: string) {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized");
  }

  const cookieStore = await cookies();
  cookieStore.set("user-cookie:confirm", value, {
    path: "/",
    maxAge: COOKIE_CONFIRMATION_MAX_AGE,
    sameSite: "lax",
    secure: true,
  });
}

/**
 * Cached title generation function using React.cache()
 * This prevents duplicate AI calls for the same message within a request.
 *
 * Uses {@link resolveLlmProvider} to dispatch through the user's configured
 * LLM provider (saved settings, agent runtime, or built-in default). No HTTP
 * round-trip to any external service — title generation stays local.
 */
const generateTitleCached = cache(
  async (userId: string, message: UIMessage) => {
    // Extract message text
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = message as any;
    const userContent =
      typeof msg.content === "string"
        ? msg.content
        : typeof msg.content === "object" && msg.content !== null
          ? JSON.stringify(msg.content)
          : "";

    const provider = await resolveLlmProvider({
      userId,
      prefer: "chat_completions",
    });

    if (!provider) {
      throw new Error(
        "No LLM provider configured. Save an OpenAI-compatible API key in AI provider settings, or set OPENLOOMI_AGENT_PROVIDER to a local runtime.",
      );
    }

    const result = await provider.complete({
      system:
        "You will generate a short title based on the first message a user begins a conversation with. Ensure it is not more than 80 characters long. The title should be a summary of the user's message. Do not use quotes or colons. Return only the title text, no extra explanation.",
      userContent,
      maxTokens: 80,
      timeoutMs: 60_000,
    });

    const title = result.text?.trim();
    if (!title) {
      throw new Error("Invalid AI response: no title in result");
    }
    return title;
  },
);

export async function generateTitleFromUserMessage({
  message,
}: {
  message: UIMessage;
}) {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized");
  }
  return generateTitleCached(session.user.id, message);
}

export async function deleteTrailingMessages({ id }: { id: string }) {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized");
  }

  const [message] = await getMessageById({ id });

  await deleteMessagesByChatIdAfterTimestamp({
    chatId: message.chatId,
    timestamp: message.createdAt,
  });
}

export async function parseEmailAction(
  rawContent: string,
): Promise<ParsedEmailResult> {
  return parseRawEmail(rawContent);
}
