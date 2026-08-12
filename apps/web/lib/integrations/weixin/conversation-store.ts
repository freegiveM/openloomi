/**
 * WeChat iLink Conversation Store
 *
 * File-backed per-day in-memory store for conversation history with AI.
 * Data persists to ~/.openloomi/memory/{userId}/weixin/YYYY-MM-DD.json
 *
 * Token trimming is handled by handleAgentRuntime (40K budget) — not here.
 */

import { WeixinConversationStore } from "@melandlabs/integrations-weixin/conversation-store";
import { getUserMemoryPath } from "@/lib/utils/path";

export { WeixinConversationStore };

/**
 * Create a WeixinConversationStore instance for a specific user.
 * This ensures user data isolation at the filesystem level.
 */
export function createWeixinConversationStore(
  userId: string,
): WeixinConversationStore {
  return new WeixinConversationStore(userId, getUserMemoryPath(userId));
}
