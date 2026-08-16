"use client";

import { useTranslation } from "react-i18next";
import "../../i18n";
import {
  useChatContext,
  useChatContextOptional,
  type ChatContextValue,
} from "@/components/chat-context";
import { Badge, Button } from "@openloomi/ui";
import { HorizontalScrollContainer, hasDragged } from "@openloomi/ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "@openloomi/ui";
import type { ChatHistoryResponse } from "@/lib/ai/chat/api";
import type { AgentGoalRecoverySession } from "@/lib/ai/runtime-instructions/api";
import { buildNavigationUrl } from "@/lib/utils";
import { fetcher } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { RemixIcon } from "@/components/remix-icon";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useRef } from "react";
import useSWR from "swr";
import { AgentSectionHeader } from "./section-header";

interface ChatHeaderPanelProps {
  chatId?: string | null; // Current chat ID
  onChatIdChange?: (chatId: string | null) => void; // Callback when chatId changes
  /**
   * Right-side action buttons like close (passed from layout.tsx)
   */
  children?: React.ReactNode;
  /**
   * Whether to show right history panel in current chat page (controls button selected state)
   */
  isHistoryPanelOpen?: boolean;
  /**
   * Toggle right history panel (controlled by parent whether to show)
   */
  onToggleHistoryPanel?: () => void;
  /** Server-owned Goal sessions still running after a desktop restart. */
  recoverySessions?: readonly AgentGoalRecoverySession[];
}

interface HeaderChat {
  id: string;
  title: string;
  createdAt: Date;
  latestMessageContent: string | null;
  latestMessageTime: Date | null;
  messageCount: number;
}

/**
 * Header component for chat panel
 * Replaces the default header in layout.tsx [Chat] panel.
 * Convention: All Agent section headers except this one (Chat) use shared AgentSectionHeader styles;
 * This component uses className="h-auto pl-4 pr-2 py-2" to override default px-6 / py-6, keeping Chat independent style.
 *
 * Layout structure:
 * - First row: chat title, history dropdown, new chat button, and close button (children)
 */
export function ChatHeaderPanel({
  chatId: externalChatId,
  onChatIdChange,
  children,
  isHistoryPanelOpen,
  onToggleHistoryPanel,
  recoverySessions = [],
}: ChatHeaderPanelProps = {}) {
  const { t } = useTranslation();

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Get ChatContext (optional), used to clear context when creating new chat
  const chatContextOptional = useChatContextOptional();

  // Try to get full ChatContext (for accessing session states)
  let chatContext: ChatContextValue | null = null;
  let getChatSessionStates:
    | (() => Map<string, { isAgentRunning: boolean }>)
    | null = null;
  try {
    chatContext = useChatContext();
    getChatSessionStates = chatContext.getChatSessionStates;
  } catch {
    // If not in ChatProvider, use optional context
    chatContext = chatContextOptional;
  }

  // Check if agent for the specified chatId is running
  const isChatRunning = useCallback(
    (chatId: string): boolean => {
      if (
        recoverySessions.some((session) => session.runtimeSessionId === chatId)
      ) {
        return true;
      }
      if (!getChatSessionStates) return false;
      return getChatSessionStates().get(chatId)?.isAgentRunning ?? false;
    },
    [getChatSessionStates, recoverySessions],
  );

  // The URL/effective chat is authoritative. Context can lag briefly while
  // message hydration starts, especially when another chat runs in background.
  const currentChatId = useMemo(() => {
    const result = externalChatId ?? chatContext?.activeChatId ?? null;
    return result;
  }, [chatContext?.activeChatId, externalChatId]);

  const historyUrl = "/api/history?limit=100";
  const { data: chatHistory } = useSWR<ChatHistoryResponse>(
    historyUrl,
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      dedupingInterval: 5000,
    },
  );

  const recoveryChats = useMemo<HeaderChat[]>(
    () =>
      recoverySessions.map((session) => ({
        id: session.runtimeSessionId,
        title: session.chat.title,
        createdAt: new Date(session.chat.createdAt),
        latestMessageContent: null,
        latestMessageTime: new Date(session.chat.createdAt),
        messageCount: 1,
      })),
    [recoverySessions],
  );

  // Find current chat from history or the server recovery read model.
  const currentChat = useMemo(() => {
    if (!currentChatId) return null;
    return (
      chatHistory?.chats.find((chat) => chat.id === currentChatId) ??
      recoveryChats.find((chat) => chat.id === currentChatId) ??
      null
    );
  }, [chatHistory, currentChatId, recoveryChats]);

  // Sort all chats by time (newest first)
  const sortedChats = useMemo(() => {
    if (!chatHistory?.chats) return [];
    return [...chatHistory.chats].sort((a, b) => {
      const dateA = a.latestMessageTime
        ? new Date(a.latestMessageTime)
        : new Date(a.createdAt);
      const dateB = b.latestMessageTime
        ? new Date(b.latestMessageTime)
        : new Date(b.createdAt);
      const timeA = Number.isNaN(dateA.getTime()) ? 0 : dateA.getTime();
      const timeB = Number.isNaN(dateB.getTime()) ? 0 : dateB.getTime();
      return timeB - timeA; // Descending: newest first
    });
  }, [chatHistory]);

  // Get chat list for display title (up to 5)
  const displayChats = useMemo(() => {
    // Recovery sessions take priority even when the corresponding Chat is too
    // old to be present in the first history page.
    const display: HeaderChat[] = recoveryChats.slice(0, 5);
    const seen = new Set(display.map((chat) => chat.id));
    for (const chat of sortedChats) {
      if (display.length >= 5) break;
      if (!seen.has(chat.id)) {
        display.push(chat);
        seen.add(chat.id);
      }
    }

    const currentChatIsDisplayed = currentChatId
      ? display.some((chat) => chat.id === currentChatId)
      : false;

    // If current chat is not in the first five, keep it visible at the end.
    if (currentChatId && !currentChatIsDisplayed) {
      if (currentChat) {
        return [...display, currentChat];
      }
      const newChatPlaceholder = {
        id: currentChatId,
        title: t("common.newChat"),
        createdAt: new Date(),
        latestMessageContent: null,
        latestMessageTime: new Date(),
        messageCount: 0,
      };
      return [...display, newChatPlaceholder];
    }

    return display;
  }, [sortedChats, recoveryChats, currentChatId, currentChat, t]);

  // Stable display list reference to avoid flicker during data loading
  const prevDisplayChatsRef = useRef<typeof displayChats>([]);
  const stableDisplayChats = useMemo(() => {
    if (displayChats.length > 0) {
      prevDisplayChatsRef.current = displayChats;
      return displayChats;
    }
    if (!currentChatId) {
      return [];
    }
    return prevDisplayChatsRef.current;
  }, [displayChats, currentChatId]);

  /**
   * Scroll to the right to show latest chat
   */
  const scrollToRight = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      const maxScroll = container.scrollWidth - container.clientWidth;
      if (maxScroll > 0) {
        container.scrollTo({
          left: maxScroll,
          behavior: "smooth",
        });
      }
    }
  }, []);

  /**
   * Handle new chat
   */
  const handleNewChat = () => {
    if (onChatIdChange) {
      onChatIdChange(null);
      setTimeout(scrollToRight, 150);
    } else {
      const newPath = buildNavigationUrl({
        pathname,
        searchParams,
        chatId: null,
        paramsToUpdate: { rightPanel: "chat" },
      });
      router.push(newPath);
    }
  };

  /**
   * Handle chat selection
   */
  const handleChatSelect = (selectedChatId: string) => {
    if (currentChatId === selectedChatId) return;
    if (onChatIdChange) {
      onChatIdChange(selectedChatId);
      return;
    }
    const newPath = buildNavigationUrl({
      pathname,
      searchParams,
      paramsToUpdate: { page: "chat", chatId: selectedChatId },
    });
    router.replace(newPath);
  };

  return (
    <AgentSectionHeader
      className="h-auto pl-4 pr-2 py-2"
      title={
        isHistoryPanelOpen ? (
          /* When right history panel is open: show only current chat name, 14px font; new chat (no currentChat or no messages) shows "New Chat" */
          <span className="truncate text-sm font-semibold text-foreground">
            {currentChat?.title ??
              (currentChatId && currentChat && currentChat.messageCount > 0
                ? t("common.chatHistory")
                : t("common.newChat"))}
          </span>
        ) : (
          <HorizontalScrollContainer
            scrollRef={scrollContainerRef}
            autoScrollToEnd
            autoScrollDeps={[stableDisplayChats.length, currentChatId]}
            className="gap-2"
          >
            {stableDisplayChats.map((chat) => {
              const isActive = currentChatId === chat.id;
              const isRunning = isChatRunning(chat.id);
              const hasMessages = chat.messageCount > 0;
              const isCompleted = hasMessages && !isRunning;

              return (
                <Badge
                  key={chat.id}
                  variant={isActive ? "default" : "outline"}
                  className={cn(
                    "cursor-pointer transition-colors rounded-[10px] max-w-[200px] min-w-0 truncate shrink-0 px-3 py-1.5",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-secondary",
                  )}
                  onClick={(e) => {
                    if (hasDragged(scrollContainerRef)) {
                      e.preventDefault();
                      e.stopPropagation();
                      return;
                    }
                    handleChatSelect(chat.id);
                  }}
                  title={chat.title || t("common.chatHistory")}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    {/* Status indicator */}
                    {isRunning && (
                      <RemixIcon
                        name="loader_icon"
                        size="size-3.5"
                        className="animate-spin shrink-0"
                      />
                    )}
                    {isCompleted && !isActive && (
                      <RemixIcon
                        name="check"
                        size="size-3.5"
                        className="shrink-0 text-green-500"
                      />
                    )}
                    <span className="truncate">
                      {chat.title || t("common.chatHistory")}
                    </span>
                  </span>
                </Badge>
              );
            })}
            {!currentChatId && (
              <Badge
                variant="default"
                className="cursor-pointer transition-colors rounded-[10px] max-w-[160px] min-w-0 truncate shrink-0 bg-primary text-primary-foreground px-3 py-1.5"
                onClick={(e) => {
                  if (hasDragged(scrollContainerRef)) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                  }
                  handleNewChat();
                }}
                title={t("common.newChat")}
              >
                {t("common.newChat")}
              </Badge>
            )}
          </HorizontalScrollContainer>
        )
      }
    >
      <div className="flex items-center gap-2">
        {/* New chat button: hidden when right history panel is open (new chat entry is inside history panel) */}
        {!isHistoryPanelOpen && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleNewChat}
                className="h-8 w-8"
                aria-label={t("common.newChat")}
              >
                <RemixIcon name="add" size="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("common.newChat")}</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Chat history button: controlled by parent whether to show right panel (only shown when callback provided) */}
        {onToggleHistoryPanel && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={isHistoryPanelOpen ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8"
                aria-label={t("common.chatHistory")}
                aria-haspopup="menu"
                aria-expanded={isHistoryPanelOpen ?? false}
                onClick={onToggleHistoryPanel}
              >
                <RemixIcon name="history" size="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("common.chatHistory")}</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Vault (Chat Vault) button */}
        {chatContextOptional?.setVaultOpen != null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() =>
                  chatContextOptional.setVaultOpen(
                    !chatContextOptional.isVaultOpen,
                  )
                }
                aria-label={t("agent.workspaceFloat.title", "Chat Vault")}
              >
                <RemixIcon name="folder_4_line" size="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("agent.workspaceFloat.title", "Chat Vault")}</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Right-side action buttons like close */}
        {children}
      </div>
    </AgentSectionHeader>
  );
}
