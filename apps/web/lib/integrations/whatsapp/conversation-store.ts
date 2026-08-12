/**
 * WhatsApp Self-Message Conversation Store
 *
 * File-backed per-day in-memory store for conversation history with AI.
 * Data persists to ~/.openloomi/memory/{userId}/whatsapp/YYYY-MM-DD.json
 *
 * Token trimming is handled by handleAgentRuntime (40K budget) — not here.
 */

import { WhatsAppConversationStore } from "@melandlabs/integrations-whatsapp/conversation-store";
import { getUserMemoryPath } from "@/lib/utils/path";

export { WhatsAppConversationStore };

/**
 * Create a WhatsAppConversationStore instance for a specific user.
 * This ensures user data isolation at the filesystem level.
 */
export function createWhatsAppConversationStore(
  userId: string,
): WhatsAppConversationStore {
  return new WhatsAppConversationStore(userId, getUserMemoryPath(userId));
}
