"use client";

// ============================================================================
// Imports
// ============================================================================

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useLocalStorage } from "usehooks-ts";
import { AgentLayout } from "@/components/agent/layout";
import { AgentChatPanel } from "@/components/agent/chat-panel";
import { ChatHeaderPanel } from "@/components/agent/chat-header-panel";
import {
  Button,
  PageSectionHeader,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@openloomi/ui";
import { useTranslation } from "react-i18next";
import "../../i18n";
import type { ChatMessage } from "@melandlabs/shared";
import dynamic from "next/dynamic";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { buildNavigationUrl, generateUUID, fetcher } from "@/lib/utils";
import { UserProfileSettings } from "@/components/user-profile-settings";
import { AiApiSettings } from "@/components/ai-api-settings";
import { StorageManagementPanel } from "@/components/storage-management-panel";
import { useChatContext } from "@/components/chat-context";
import { FilePreviewOverlay } from "@/components/file-preview-overlay";
import { ChatHistorySidePanel } from "@/components/agent/chat-history-side-panel";
import { AgentGoalSidePanel } from "@/components/agent/goal-side-panel";
import type { ChatHistoryResponse } from "@/lib/ai/chat/api";
import { selectStartupChat } from "@/lib/ai/chat/startup-selection";
import type {
  AgentGoalCommandResponse,
  AgentGoalRecoverySessionsResponse,
} from "@/lib/ai/runtime-instructions/api";
import {
  activateAgentGoal,
  agentGoalSessionUrl,
} from "@/lib/ai/runtime-instructions/api/client";
import {
  activateGoalWithChatFallback,
  createGoalCommandIdempotencyKeys,
  createGoalStartSingleFlight,
} from "@/lib/ai/runtime-instructions/goal-ui-model";
import { toast } from "@/components/toast";
import { decodeSearchParamText } from "@/lib/chat/query-text";
import useSWR, { mutate } from "swr";
import useSWRInfinite from "swr/infinite";
import { AddPlatformDialog } from "@/components/add-platform-dialog";
import { useIntegrations } from "@/hooks/use-integrations";
import { ChatSkeleton } from "@/components/agent/panel-skeleton";
import { RemixIcon } from "@/components/remix-icon";
import { useIsMobile } from "@melandlabs/hooks/use-is-mobile";

const HISTORY_PAGE_SIZE = 20;

/**
 * Keyed page fetcher for the chat history used by the right-side
 * ChatHistorySidePanel. Uses `starting_after` for forward pagination
 * (newest page first), matching the underlying `/api/history` route.
 */
function getHomeHistoryKey(
  pageIndex: number,
  previousPageData: ChatHistoryResponse | null,
) {
  if (previousPageData && previousPageData.hasMore === false) {
    return null;
  }
  if (pageIndex === 0) {
    return `/api/history?limit=${HISTORY_PAGE_SIZE}`;
  }
  const last = previousPageData?.chats?.at(-1);
  if (!last) return null;
  return `/api/history?limit=${HISTORY_PAGE_SIZE}&starting_after=${last.id}`;
}

// Lazy load motion components to reduce bundle size
const MotionSection = dynamic(
  () =>
    import("framer-motion").then((mod) => {
      const { motion } = mod;
      return {
        default: motion.section as typeof motion.section,
      };
    }),
  { ssr: true },
);

export function Home() {
  // ============================================================================
  // Hooks & Initialization
  // ============================================================================

  const { t } = useTranslation();

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const page = searchParams.get("page");
  /** Chat page (page=chat) reads chatId from URL, used to correctly open corresponding chat after jumping from Library/Chat Vault "Open chat" */
  const urlChatId = searchParams.get("chatId") ?? undefined;
  /** Chat page reads send parameter from URL, automatically sends that message after mounting (e.g., onboarding "Talk with openloomi") */
  const urlSendMessage = searchParams.get("send");
  const initialMessageToSend = decodeSearchParamText(urlSendMessage);
  /** Chat page reads input parameter from URL, pre-fills the composer, and waits for user confirmation */
  const urlInitialInput = searchParams.get("input");
  const initialInput = decodeSearchParamText(urlInitialInput);
  const prefillToken = searchParams.get("prefillToken") ?? undefined;

  // Chat page right sidebar history switch (only used when page=chat)
  // Default collapsed, use localStorage to persist user preference
  const [isChatHistoryOpen, setIsChatHistoryOpen] = useLocalStorage(
    "chatHistoryPanelOpen",
    false,
  );
  const [isGoalPanelOpen, setIsGoalPanelOpen] = useState(false);
  const [goalPanelFocusRequest, setGoalPanelFocusRequest] = useState(0);
  const [goalCommandKeys] = useState(createGoalCommandIdempotencyKeys);
  const [goalStartSingleFlight] = useState(() =>
    createGoalStartSingleFlight<AgentGoalCommandResponse>(),
  );
  const [goalPlanningBySession, setGoalPlanningBySession] = useState<
    Record<string, string>
  >({});
  const [claimedStartupChatId, setClaimedStartupChatId] = useState<
    string | null
  >(null);
  const isMobile = useIsMobile();

  // Get state from ChatContext
  const {
    setMessages,
    activeChatId,
    switchChatId,
    previewFile,
    closeFilePreviewPanel,
    sendMessage,
    stopChat,
    getIsAgentRunningByChatId,
  } = useChatContext();

  // Progressive authorization state
  const [isAddPlatformDialogOpen, setIsAddPlatformDialogOpen] = useState(false);
  const [linkingPlatform, setLinkingPlatform] = useState<
    import("@/hooks/use-integrations").IntegrationId | null
  >(null);
  const { mutate: mutateIntegrations } = useIntegrations();

  // Callbacks for AddPlatformDialog (required by interface, not used in chat flow)
  const [, setIsGoogleAuthFormOpen] = useState(false);
  const [, setIsOutlookAuthFormOpen] = useState(false);
  const [, setIsWhatsAppAuthFormOpen] = useState(false);
  const [, setIsMessengerAuthFormOpen] = useState(false);
  const showTelegramTokenForm = useState(false)[1]; // no-op in chat flow

  // "Connect Account" from tool failures → Connectors page with add-platform flow
  useEffect(() => {
    const handler = () => {
      router.push("/connectors?addPlatform=true");
    };
    window.addEventListener("openloomi:request-integration", handler);
    return () =>
      window.removeEventListener("openloomi:request-integration", handler);
  }, [router]);

  // Pet right-click "Settings" → open the General settings panel via
  // client-side navigation. Mirrors the openloomi:request-integration
  // pattern; the Rust host dispatches this DOM event after showing the
  // main window (see main.rs `pet:open-settings` listener).
  useEffect(() => {
    const handler = () => {
      router.push("/?page=account-settings");
    };
    window.addEventListener("openloomi:navigate-settings", handler);
    return () =>
      window.removeEventListener("openloomi:navigate-settings", handler);
  }, [router]);

  // Pet card "Open AI settings" CTA (no-api-key layout) → land the
  // user on the AI settings page with the missing-key banner and
  // "Required for chat" badge pre-armed. The Rust host dispatches
  // `openloomi:navigate-ai-settings` after showing the main window
  // (see main.rs `pet:open-ai-settings` listener). Reuses the
  // existing banner / auto-redirect-on-save flow in
  // `components/ai-api-settings.tsx` — no changes there.
  useEffect(() => {
    const handler = () => {
      router.push("/?page=ai-api-settings&reason=missing-api-key");
    };
    window.addEventListener("openloomi:navigate-ai-settings", handler);
    return () =>
      window.removeEventListener("openloomi:navigate-ai-settings", handler);
  }, [router]);

  // The pet card's "Open brief / Open wrap / Open plan / ↗ Edit" buttons
  // route through `openloomi:navigate-decision` and are handled by
  // <LoopNavBridge /> in the (chat) layout — that listener resolves the
  // decision to its most recent ScheduledJob and pushes to
  // /scheduled-jobs/<id> (or the filtered list if no job yet). Mounting
  // it at the layout level keeps the navigation working from any (chat)
  // route, not only the home page.

  const shouldReadRecoverySessions =
    pathname === "/" && (page === null || page === "chat");
  const { data: recoverySessions, error: recoverySessionsError } =
    useSWR<AgentGoalRecoverySessionsResponse>(
      shouldReadRecoverySessions ? "/api/agent-goals/runtime-sessions" : null,
      fetcher,
      {
        refreshInterval: (data) => (data?.sessions.length ? 2_000 : 0),
        revalidateOnFocus: true,
        dedupingInterval: 1000,
      },
    );
  const newChatIdRef = useRef(generateUUID());
  const startupSelection = useMemo(
    () =>
      selectStartupChat({
        pathname,
        page,
        urlChatId,
        claimedChatId: claimedStartupChatId ?? undefined,
        forceNewChat:
          !urlChatId && Boolean(initialMessageToSend || initialInput),
        recoveryLoaded:
          !shouldReadRecoverySessions ||
          recoverySessions !== undefined ||
          recoverySessionsError !== undefined,
        recoveryChatId: recoverySessions?.sessions[0]?.runtimeSessionId,
        restoredChatId: activeChatId,
        newChatId: newChatIdRef.current,
      }),
    [
      activeChatId,
      claimedStartupChatId,
      initialInput,
      initialMessageToSend,
      page,
      pathname,
      recoverySessions,
      recoverySessionsError,
      shouldReadRecoverySessions,
      urlChatId,
    ],
  );
  const effectiveChatId = startupSelection.chatId;
  const isChatPage =
    page === "chat" || (pathname === "/" && page === null);
  const claimStartupChat = useCallback(
    (chatId: string) => {
      if (pathname === "/" && page === null) {
        setClaimedStartupChatId(chatId);
      }
    },
    [page, pathname],
  );
  const claimEffectiveChat = useCallback(() => {
    if (effectiveChatId) claimStartupChat(effectiveChatId);
  }, [claimStartupChat, effectiveChatId]);
  const selectedRecoverySession = recoverySessions?.sessions.find(
    (session) => session.runtimeSessionId === effectiveChatId,
  );
  const isSelectedRecoveryActive = selectedRecoverySession !== undefined;
  // Recovery discovery must not lock unrelated chats while the read model is
  // compiling or loading. The server-side runtime lease rejects a conflicting
  // provider start for the one session that is actually being recovered.
  const recoverySessionsLoaded = recoverySessions !== undefined;
  const isEffectiveChatRunning = effectiveChatId
    ? getIsAgentRunningByChatId(effectiveChatId)
    : false;
  const goalChatBusy = isEffectiveChatRunning || isSelectedRecoveryActive;

  // Retrying an authorized integration starts a new provider turn directly
  // through ChatContext. Apply the same recovery ownership gate as the
  // composer so a browser turn cannot race the server-owned resumed Query.
  useEffect(() => {
    const handler = () => {
      mutateIntegrations();
      if (isSelectedRecoveryActive) return;
      sendMessage(
        { parts: [{ type: "text", text: "continue" }] },
        { chatId: effectiveChatId },
      );
    };
    window.addEventListener("integration:accountAuthorized", handler);
    return () =>
      window.removeEventListener("integration:accountAuthorized", handler);
  }, [
    isSelectedRecoveryActive,
    mutateIntegrations,
    effectiveChatId,
    sendMessage,
  ]);

  // Data for Chat page right sidebar history (independent of Header, avoid
  // dependency on internal implementation). SWR Infinite handles dedup,
  // abort-on-unmount, and shares the cache with the Header's `/api/history`
  // key so the two views stay in sync.
  const {
    data: historyPages,
    size: historySize,
    setSize: setHistorySize,
    isValidating: isHistoryValidating,
    mutate: mutateHistoryPages,
  } = useSWRInfinite<ChatHistoryResponse>(
    (pageIndex, previousPageData) =>
      page === "chat" ? getHomeHistoryKey(pageIndex, previousPageData) : null,
    fetcher,
    { revalidateFirstPage: false, parallel: false },
  );

  const chatsList = useMemo<ChatHistoryResponse["chats"]>(
    () => historyPages?.flatMap((p) => p.chats) ?? [],
    [historyPages],
  );
  const hasMore = historyPages?.at(-1)?.hasMore ?? true;
  const isLoadingMore = isHistoryValidating && historySize > 1;

  // Load more
  const loadMoreChats = useCallback(() => {
    if (!hasMore || isLoadingMore) return;
    setHistorySize((s) => s + 1);
  }, [hasMore, isLoadingMore, setHistorySize]);

  const sortedChatsForChatPage = useMemo(() => {
    if (!chatsList.length) return [];
    // Deduplicate
    const seen = new Set<string>();
    const unique = chatsList.filter((chat) => {
      if (seen.has(chat.id)) return false;
      seen.add(chat.id);
      return true;
    });
    return [...unique].sort((a, b) => {
      const dateA = a.latestMessageTime
        ? new Date(a.latestMessageTime)
        : new Date(a.createdAt);
      const dateB = b.latestMessageTime
        ? new Date(b.latestMessageTime)
        : new Date(b.createdAt);
      return dateB.getTime() - dateA.getTime();
    });
  }, [chatsList]);

  // Every startup source goes through switchChatId. Merely setting the ID leaves
  // messagesMap empty after a process restart, which makes the restored chat
  // look like a new conversation even though its messages are durable.
  useEffect(() => {
    if (!effectiveChatId) return;
    switchChatId(effectiveChatId);
  }, [effectiveChatId, switchChatId]);

  // A recovered Runtime has no browser SSE connection. Refresh only the chat
  // that the server explicitly reports as recovery-active, and never replace
  // local optimistic state while an ordinary browser send is in progress.
  const lastRecoveryChatRef = useRef<string | null>(null);
  useEffect(() => {
    if (!effectiveChatId || !recoverySessionsLoaded) return;

    if (isSelectedRecoveryActive) {
      lastRecoveryChatRef.current = effectiveChatId;
      if (isEffectiveChatRunning) return;
      const interval = window.setInterval(() => {
        switchChatId(effectiveChatId, true);
      }, 2000);
      return () => window.clearInterval(interval);
    }

    if (lastRecoveryChatRef.current !== effectiveChatId) {
      lastRecoveryChatRef.current = null;
      return;
    }
    if (isEffectiveChatRunning) return;

    // The session just left the recovery read model (normally completion).
    // Pull its final message once and refresh history so the recovered tab
    // seamlessly becomes an ordinary completed chat.
    switchChatId(effectiveChatId, true);
    void mutate(
      (key) => typeof key === "string" && key.startsWith("/api/history"),
    );
    lastRecoveryChatRef.current = null;
  }, [
    effectiveChatId,
    isEffectiveChatRunning,
    isSelectedRecoveryActive,
    recoverySessionsLoaded,
    switchChatId,
  ]);

  // When the selected ID has no URL representation yet, add it without
  // overriding a chat explicitly supplied by navigation.
  // This can avoid effectiveChatId still using old value due to URL update delay
  // Note: Only need to sync when there's no chatId in URL (avoid overwriting existing chatId, e.g., when jumped from scheduled job)
  useEffect(() => {
    // Skip initial render
    if (!effectiveChatId) return;
    // Only synchronously update URL on chat page
    if (page !== "chat") return;
    // If chatId already exists in URL, no need to update (possibly jumped from scheduled job etc.)
    if (urlChatId) return;

    const newPath = buildNavigationUrl({
      pathname: "/",
      searchParams,
      paramsToUpdate: {
        page: "chat",
        chatId: effectiveChatId,
      },
    });
    router.replace(newPath, { scroll: false });
  }, [effectiveChatId, page, searchParams, router, urlChatId]);

  // Initial redirect: when page is null (first load), redirect to chat page
  useEffect(() => {
    // Wait for the recovery read before deciding between a recovered, restored,
    // or brand-new chat.
    if (page !== null || startupSelection.pending || !effectiveChatId) return;

    if (pathname !== "/") return;

    const newPath = buildNavigationUrl({
      pathname: "/",
      searchParams,
      paramsToUpdate: {
        page: "chat",
        chatId: effectiveChatId,
      },
    });
    router.replace(newPath, { scroll: false });
  }, [
    page,
    effectiveChatId,
    pathname,
    searchParams,
    router,
    startupSelection.pending,
  ]);

  // ============================================================================
  // Chat Hook & Refs
  // ============================================================================

  const previousRunningByChatRef = useRef(new Map<string, boolean>());

  // When isAgentRunning becomes false, automatically update all "executing" status tool parts to "completed"
  // This prevents some tools from not receiving tool_result event causing status to remain "executing"
  useEffect(() => {
    if (!effectiveChatId) return;
    const wasRunning =
      previousRunningByChatRef.current.get(effectiveChatId) ?? false;
    if (wasRunning && !isEffectiveChatRunning) {
      setMessages((prev) => {
        const updated = prev.map((message) => {
          if (message.role !== "assistant" || !Array.isArray(message.parts)) {
            return message;
          }

          const hasExecutingTools = message.parts.some(
            (part: any) =>
              part.type === "tool-native" && part.status === "executing",
          );

          if (!hasExecutingTools) {
            return message;
          }

          // Update all executing status tools to completed
          const updatedParts = message.parts.map((part: any) => {
            if (part.type === "tool-native" && part.status === "executing") {
              return {
                ...part,
                status: "completed" as const,
              };
            }
            return part;
          });

          return {
            ...message,
            parts: updatedParts,
          } as ChatMessage;
        });
        return updated;
      }, effectiveChatId);
    }
    previousRunningByChatRef.current.set(
      effectiveChatId,
      isEffectiveChatRunning,
    );
  }, [effectiveChatId, isEffectiveChatRunning, setMessages]);

  // Extracted inline handlers to useCallback for better performance
  const handleChatIdChange = useCallback(
    (newChatId: string | null) => {
      // If newChatId is null (new conversation), generate a new UUID
      const targetChatId = newChatId ?? generateUUID();
      claimStartupChat(targetChatId);
      // When page=chat, use query parameters instead of /chat/[id] route
      // Because app doesn't have /chat/[id] dynamic route, using /chat/${chatId} will cause 404
      const newPath = buildNavigationUrl({
        pathname: isChatPage ? "/" : pathname,
        searchParams,
        chatId: isChatPage ? undefined : targetChatId,
        paramsToUpdate: {
          ...(isChatPage
            ? { page: "chat", chatId: targetChatId }
            : { rightPanel: "chat" }),
        },
      });

      console.debug("handleChatIdChange New path:", newPath);
      router.push(newPath);
    },
    [claimStartupChat, router, pathname, searchParams, isChatPage],
  );

  /** Delete chat: call API then remove from local list, switch to new chat if deleted current chat */
  const handleDeleteChat = useCallback(
    async (chatId: string) => {
      const res = await fetch(`/api/chat/${chatId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) return;
      // Remove from the SWR cache so the side panel updates immediately,
      // then revalidate the matching key to keep the header in sync.
      mutateHistoryPages(
        (pages) =>
          pages?.map((page) => ({
            ...page,
            chats: page.chats.filter((c) => c.id !== chatId),
          })) ?? pages,
        { revalidate: false },
      );
      mutate(
        (key) => typeof key === "string" && key.startsWith("/api/history"),
      );
      if (effectiveChatId === chatId) {
        handleChatIdChange(null);
      }
    },
    [effectiveChatId, handleChatIdChange, mutateHistoryPages],
  );

  const openGoalPanel = useCallback(() => {
    claimEffectiveChat();
    setIsChatHistoryOpen(false);
    setIsGoalPanelOpen(true);
    setGoalPanelFocusRequest((request) => request + 1);
  }, [claimEffectiveChat, setIsChatHistoryOpen]);

  const startGoal = useCallback(
    (rawObjective: string): Promise<AgentGoalCommandResponse> => {
      const objective = rawObjective.trim();
      if (!objective || !effectiveChatId) {
        return Promise.reject(
          new Error(t("agentGoals.errors.requestFailed")),
        );
      }
      openGoalPanel();
      const runtimeSessionId = effectiveChatId;

      return goalStartSingleFlight.run({
        runtimeSessionId,
        objective,
        conflictError: () =>
          new Error(t("agentGoals.errors.planningInProgress")),
        onPendingChange: (pendingObjective) => {
          setGoalPlanningBySession((current) => {
            if (pendingObjective) {
              if (current[runtimeSessionId] === pendingObjective) return current;
              return { ...current, [runtimeSessionId]: pendingObjective };
            }
            if (!(runtimeSessionId in current)) return current;
            const next = { ...current };
            delete next[runtimeSessionId];
            return next;
          });
        },
        start: async () => {
          const request = { runtimeSessionId, objective };
          const commandKey = goalCommandKeys.keyFor("activate", request);
          return activateGoalWithChatFallback({
            activate: async () => {
              const response = await activateAgentGoal(request, commandKey);
              goalCommandKeys.clear("activate", request);
              return response;
            },
            refresh: () => mutate(agentGoalSessionUrl(runtimeSessionId)),
            startFallback: () =>
              sendMessage(
                {
                  role: "user",
                  parts: [{ type: "text", text: objective }],
                },
                { chatId: runtimeSessionId },
              ),
            onRefreshError: (error) => {
              console.error("[Goal] Failed to refresh activated Goal", error);
            },
            onFallbackError: (error) => {
              console.error("[Goal] Failed to start activated Goal", error);
              toast({
                type: "error",
                description: t("agentGoals.errors.startFailed"),
              });
            },
          });
        },
      });
    },
    [
      effectiveChatId,
      goalCommandKeys,
      goalStartSingleFlight,
      openGoalPanel,
      sendMessage,
      t,
    ],
  );

  /** Utility page title mapping (single source of truth: only maintain here, PageSectionHeader reuses) */
  function getUtilityPageTitle(pageParam: string | null): string {
    switch (pageParam) {
      case "profile":
        return t("settings.profileOverviewTitle", "Personal Settings");
      case "account-settings":
        return t("settings.general", "General");
      case "profile-edit":
        return t("settings.general", "General");
      case "ai-api-settings":
        return t("settings.aiSettingsTitle", "AI Settings");
      case "openloomi-soul":
        return t("settings.general", "General");
      case "storage-management":
        return t("settings.storageManagementTitle", "Storage management");
      case "coupons":
        return t("nav.coupons", "Coupons");
      default:
        return t("nav.myAccount", "My Account");
    }
  }

  /**
   * Controls whether utility pages should hide the top header section.
   */
  function shouldHideUtilityHeader(pageParam: string | null): boolean {
    return [
      "profile",
      "account-settings",
      "profile-edit",
      "ai-api-settings",
      "openloomi-soul",
      "storage-management",
    ].includes(pageParam ?? "");
  }

  // ============================================================================
  // Render Functions
  // ============================================================================

  function getPageContent() {
    // Don't use PageContentCard, avoid double-layer border with SidePanelShell's content-area-card
    const renderUtilityPanel = (
      content: ReactNode,
      pageParam: string | null,
      headerRight?: ReactNode,
      titleOverride?: ReactNode,
      headerDescription?: ReactNode,
    ) => (
      <div className="flex flex-col flex-1 min-h-0 h-full max-h-screen overflow-visible">
        {!shouldHideUtilityHeader(pageParam) && (
          <PageSectionHeader
            title={titleOverride ?? getUtilityPageTitle(pageParam)}
            description={headerDescription}
          >
            {headerRight}
          </PageSectionHeader>
        )}
        <MotionSection
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: "easeOut" }}
          className="flex h-full min-h-0 flex-1 flex-col"
        >
          <div className="flex flex-1 min-h-0 flex-col gap-8 overflow-y-auto px-4 pb-6 pt-6 sm:px-6 sm:pb-6 sm:pt-6">
            {content}
          </div>
        </MotionSection>
      </div>
    );

    if (
      page === "account-settings" ||
      page === "profile-edit" ||
      page === "openloomi-soul"
    ) {
      return renderUtilityPanel(<UserProfileSettings />, "account-settings");
    }

    if (page === "ai-api-settings") {
      return renderUtilityPanel(<AiApiSettings />, "ai-api-settings");
    }

    if (page === "storage-management") {
      return renderUtilityPanel(
        <StorageManagementPanel />,
        "storage-management",
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          onClick={() => {
            router.refresh();
          }}
        >
          <RemixIcon name="refresh" size="size-4" />
          {t("common.refresh", "Refresh")}
        </Button>,
      );
    }

    // Chat page (entered from left menu "New chat" or Library/Chat Vault "Open chat"): full-screen display chat, no left Focus/Tracking panel; use effectiveChatId to support chatId in URL
    if (isChatPage) {
      return (
        <>
          <AgentLayout centerTitle={t("nav.newChat")} hideCenterHeader={true}>
            <div className="flex h-full min-h-0 w-full gap-0">
              {/* Left: chat content */}
              <div className="flex min-w-0 flex-1 flex-col">
                <ChatHeaderPanel
                  chatId={effectiveChatId}
                  recoverySessions={recoverySessions?.sessions}
                  onChatIdChange={handleChatIdChange}
                  isHistoryPanelOpen={isChatHistoryOpen}
                  onToggleHistoryPanel={() => {
                    setIsGoalPanelOpen(false);
                    setIsChatHistoryOpen((open) => !open);
                  }}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={isGoalPanelOpen ? "secondary" : "ghost"}
                        size="icon"
                        className="h-8 w-8"
                        aria-label={t("agentGoals.open")}
                        aria-expanded={isGoalPanelOpen}
                        onClick={() => {
                          if (isGoalPanelOpen) setIsGoalPanelOpen(false);
                          else openGoalPanel();
                        }}
                      >
                        <RemixIcon name="target" size="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t("agentGoals.title")}</p>
                    </TooltipContent>
                  </Tooltip>
                </ChatHeaderPanel>
                <div className="flex-1 min-h-0 overflow-hidden">
                  <AgentChatPanel
                    key={effectiveChatId}
                    chatId={effectiveChatId}
                    initialInput={initialInput}
                    prefillToken={prefillToken}
                    initialMessageToSend={initialMessageToSend}
                    serverRecoveryActive={isSelectedRecoveryActive}
                    onUserIntent={claimEffectiveChat}
                    onStartGoal={startGoal}
                    onOpenGoal={openGoalPanel}
                    goalStartPending={Boolean(
                      goalPlanningBySession[effectiveChatId],
                    )}
                  />
                </div>
              </div>

              {/* Right: history sidebar embedded inside Chat page (display on desktop) */}
              {isChatHistoryOpen && (
                <div className="hidden md:flex h-full max-h-screen min-w-[260px] max-w-[360px] w-[320px] flex-col overflow-hidden content-area-card rounded-none border-0 border-l border-border">
                  <ChatHistorySidePanel
                    sortedChats={sortedChatsForChatPage}
                    currentChatId={effectiveChatId ?? null}
                    onSelectChat={(chatId) => handleChatIdChange(chatId)}
                    onNewChat={() => handleChatIdChange(null)}
                    onDeleteChat={handleDeleteChat}
                    hasMore={hasMore}
                    onLoadMore={loadMoreChats}
                    isLoading={isLoadingMore}
                  />
                </div>
              )}
              {isGoalPanelOpen && !isMobile && effectiveChatId && (
                <div className="hidden h-full max-h-screen w-[360px] min-w-[320px] max-w-[420px] flex-col overflow-hidden border-l border-border md:flex">
                  <AgentGoalSidePanel
                    key={effectiveChatId}
                    runtimeSessionId={effectiveChatId}
                    chatBusy={goalChatBusy}
                    planningObjective={
                      goalPlanningBySession[effectiveChatId]
                    }
                    focusRequest={goalPanelFocusRequest}
                    onStartGoal={startGoal}
                    onGoalPaused={() => stopChat(effectiveChatId)}
                    onClose={() => setIsGoalPanelOpen(false)}
                  />
                </div>
              )}
            </div>
          </AgentLayout>
          {isMobile && effectiveChatId && (
            <Sheet open={isGoalPanelOpen} onOpenChange={setIsGoalPanelOpen}>
              <SheetContent side="right" className="w-full max-w-none p-0">
                <SheetHeader className="sr-only">
                  <SheetTitle>{t("agentGoals.title")}</SheetTitle>
                  <SheetDescription>
                    {t("agentGoals.description")}
                  </SheetDescription>
                </SheetHeader>
                <AgentGoalSidePanel
                  key={effectiveChatId}
                  runtimeSessionId={effectiveChatId}
                  chatBusy={goalChatBusy}
                  planningObjective={goalPlanningBySession[effectiveChatId]}
                  focusRequest={goalPanelFocusRequest}
                  onStartGoal={startGoal}
                  onGoalPaused={() => stopChat(effectiveChatId)}
                />
              </SheetContent>
            </Sheet>
          )}
        </>
      );
    }

    return (
      <AgentLayout
        centerTitle={t("nav.newChat")}
        hideCenterHeader={true}
        centerOverlay={undefined}
      >
        <ChatSkeleton key="chat-skeleton" />
      </AgentLayout>
    );
  }

  return (
    <>
      {getPageContent()}

      {/* File preview overlay and drawer */}
      {previewFile && (
        <FilePreviewOverlay
          file={previewFile}
          onClose={closeFilePreviewPanel}
        />
      )}

      {/* Progressive authorization dialog */}
      <AddPlatformDialog
        isOpen={isAddPlatformDialogOpen}
        onOpenChange={(open) => {
          setIsAddPlatformDialogOpen(open);
          if (!open) setLinkingPlatform(null);
        }}
        linkingPlatform={linkingPlatform}
        showTelegramTokenForm={showTelegramTokenForm as () => void}
        setIsGoogleAuthFormOpen={setIsGoogleAuthFormOpen}
        setIsOutlookAuthFormOpen={setIsOutlookAuthFormOpen}
        setIsWhatsAppAuthFormOpen={setIsWhatsAppAuthFormOpen}
        setIsMessengerAuthFormOpen={setIsMessengerAuthFormOpen}
      />
    </>
  );
}
