import { auth } from "@/app/(auth)/auth";
import {
  deleteChatById,
  getChatById,
  getMessagesByChatId,
} from "@/lib/db/queries";
import { convertToUIMessages } from "@/lib/utils";
import type { ChatMessage } from "@melandlabs/shared";
import { AppError } from "@melandlabs/shared/errors";

export const dynamic = "force-dynamic";

/** Get the persisted messages for a chat. */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const result = await authorizeChat(params);
  if (result instanceof Response) return noStore(result);

  const messages = await getMessagesByChatId({ id: result.id });
  const uiMessages: ChatMessage[] = convertToUIMessages(messages);
  return Response.json(
    { messages: uiMessages },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Delete specified chat (only owner can delete)
 */
export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const result = await authorizeChat(params);
  if (result instanceof Response) return result;

  await deleteChatById({ id: result.id });

  return Response.json({ id: result.id });
}

async function authorizeChat(params: Promise<{ id: string }>) {
  const { id: chatId } = await params;

  if (!chatId) {
    return new AppError("bad_request:api", "Chat id is missing").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new AppError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id: chatId });

  if (!chat) {
    return new AppError("not_found:chat").toResponse();
  }

  if (chat.userId !== session.user.id) {
    return new AppError("forbidden:chat").toResponse();
  }

  return chat;
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
