"use client";

import { useTranslation } from "react-i18next";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatMessage } from "@openloomi/shared";
import { useMemo, memo } from "react";
import {
  getAllDefaultSuggestions,
  type SuggestedPrompt,
} from "./suggested-actions";
import { useChatContextOptional } from "./chat-context";

interface GreetingProps {
  /** Send message when a suggestion card is clicked */
  sendMessage?: UseChatHelpers<ChatMessage>["sendMessage"];
  isAgentRunning?: boolean;
}

// CSS-based fade-in replacement for `motion.div` so we don't pull
// framer-motion's animation runtime into the empty-chat first paint.
// Keyframes are defined in `app/globals.css` (`@keyframes greeting-fade-in`).

/**
 * Greeting component, displays welcome message and suggested actions.
 * Shows 6 suggested topic cards in a responsive grid layout.
 */
export const Greeting = memo(function Greeting({
  sendMessage,
  isAgentRunning = false,
}: GreetingProps) {
  const { t } = useTranslation();

  // Show all 6 suggestions
  const allSuggestions = useMemo(() => getAllDefaultSuggestions(t), [t]);

  return (
    <div
      key="overview"
      className="max-w-3xl mx-auto mt-6 sm:mt-12 size-full w-full px-0 flex flex-col justify-center gap-4"
    >
      {/* Greeting text */}
      <div className="w-full mb-0 greeting-anim greeting-anim--head">
        <h2 className="text-3xl font-serif font-semibold text-center text-foreground tracking-normal mb-2">
          {t("common.chatSubTitle")}
        </h2>
      </div>
      {/* Suggested topic list (shown when there are no messages) */}
      <div className="greeting-anim greeting-anim--grid">
        <div data-testid="suggested-actions" className="w-full">
          {/* 6 suggestion options - responsive grid layout */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pl-3 pr-3">
            {allSuggestions.map((item) => (
              <SuggestionCard
                key={item.id}
                item={item}
                sendMessage={sendMessage}
                isAgentRunning={isAgentRunning}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * Single suggested topic card component.
 */
function SuggestionCard({
  item,
  sendMessage,
  isAgentRunning = false,
}: {
  item: SuggestedPrompt;
  sendMessage?: UseChatHelpers<ChatMessage>["sendMessage"];
  isAgentRunning?: boolean;
}) {
  // Read activeChatId and sendMessage from ChatContext to ensure using the latest context
  const chatContext = useChatContextOptional();
  const activeChatId = chatContext?.activeChatId;
  const contextSendMessage = chatContext?.sendMessage;
  const { t } = useTranslation();

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (isAgentRunning) return;

    // If activeChatId is missing, the chat hasn't been initialized yet.
    if (!activeChatId) {
      console.warn(
        "[SuggestionCard] Chat not initialized yet, activeChatId is missing",
      );
      return;
    }

    // Prefer sendMessage from context (more reliable), fallback to props
    const sendFn = contextSendMessage || sendMessage;
    if (sendFn) {
      try {
        await sendFn({
          role: "user",
          parts: [{ type: "text", text: item.title }],
        });
      } catch (error) {
        console.error("[SuggestionCard] Failed to send message:", error);
      }
    }
  };

  return (
    <button
      type="button"
      className="group relative flex h-full flex-col items-start justify-between gap-0 rounded-xl border border-border/60 bg-white px-4 py-4 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
      disabled={isAgentRunning || !activeChatId}
      onClick={handleClick}
    >
      <h3 className="text-sm font-medium font-serif text-foreground text-left pb-3">
        {item.title}
      </h3>
      <div className="flex size-12 shrink-0 items-center justify-center text-2xl bg-muted/30 rounded-full transition-colors">
        <span>{item.emoji}</span>
      </div>
      {/* Show "Try it" link style hint on hover at bottom right */}
      <span
        className="absolute bottom-4 right-4 text-xs font-medium font-serif text-primary opacity-0 transition-opacity group-hover:opacity-100 pointer-events-none"
        aria-hidden
      >
        {t("common.tryIt")}
      </span>
    </button>
  );
}
