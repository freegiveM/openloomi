/**
 * Local re-implementation of two small message-bridge helpers that the
 * previously-local @openloomi/integrations/telegram used to export but the
 * published @melandlabs/integrations-telegram@0.1.5 dropped. They are
 * referenced only by telegram-adapter.test.ts and are pure structural
 * transforms; no runtime behaviour diverges.
 */
import { Api } from "telegram/tl";
import { markdownToTelegramHtml } from "@melandlabs/integrations-telegram";

// Inline structural aliases that mirror the locally-consumed shape only.
// We don't import these names from the published package because
// @melandlabs/integrations-telegram@0.1.5 does not re-export them.
type At = { target: string };

type TextMessage = { text: string };
type Mention = { target: string };
type ForwardMessageNode = { nodes: Message[] };
type Message = string | TextMessage | Mention | ForwardMessageNode | { unknown?: unknown };

type Messages = Array<string | At>;

export { markdownToTelegramHtml };

export function openloomiMessageToTgText(message: Message): string {
  if (typeof message === "string") {
    return message;
  }
  if ("text" in message) {
    return message.text;
  }
  if ("target" in message) {
    return `@${message.target}`;
  }
  if ("nodes" in message) {
    return message.nodes
      .map((node: Message) => openloomiMessageToTgText(node))
      .join("");
  }
  return "";
}

export function tgMessageToopenloomiMessage(message: Api.Message): Messages {
  const messages: Messages = [];

  if (!message.message) {
    if (message.media) {
      messages.push("[Media content]");
    }
    return messages;
  }

  messages.push(message.message);

  if (message.entities) {
    for (const entity of message.entities) {
      if (entity instanceof Api.MessageEntityMention) {
        const mentionText = message.message.substr(
          entity.offset,
          entity.length,
        );
        messages.push({ target: mentionText.replace("@", "") } as At);
      }
    }
  }

  return messages;
}
