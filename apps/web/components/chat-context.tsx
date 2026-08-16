"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import type { ChatMessage } from "@melandlabs/shared";
import { generateUUID, getTextFromMessage } from "@/lib/utils";
import { mutate } from "swr";
import { dismissToast, toast } from "@/components/toast";
import { streamNativeAgentResponse } from "@/lib/ai/router/index";
import { isTauri } from "@/lib/tauri";
import { useTranslation } from "react-i18next";
import { saveMessagesToDatabase } from "@/lib/ai/chat/save-messages";
import {
  attachChatSessionAbort,
  finishChatSession,
  getChatSessionState as readChatSessionState,
  prepareRetryConversation,
  setChatSessionRunning,
  type ChatSessionState,
} from "@/lib/ai/chat/runtime-state";
import { getAuthToken } from "@/lib/auth/token-manager";
import { uploadImageTUS } from "@/lib/files/tus-upload";
import type { ImageAttachment as AgentImageAttachment } from "@melandlabs/ai/agent";
import { DEFAULT_AI_MODEL, AI_PROXY_BASE_URL } from "@/lib/env/constants";
import {
  artifactPathBasename,
  extractArtifactPathsFromText,
  pickPreferredArtifactPath,
} from "@/lib/files/extract-artifact-paths";
import { formatAgentStreamErrorForUser } from "@/lib/ai/runtime/format-error";
import { parseCodexInterruptedError } from "@/lib/ai/extensions/agent/codex/interrupt-marker";
import { createCodexTransportStatusController } from "@/lib/ai/extensions/agent/codex/transport-status";
import {
  createLifestyleImageSkillFallbackRoute,
  isLifestyleImageSkillRouteResult,
  shouldGenerateLifestyleImageFromClassifierFallback,
  type LifestyleImageSkillRouteResult,
} from "@/lib/ai/image-generation/lifestyle-skill-router";
import {
  buildLifestyleReferenceImages,
  type LifestyleReferenceImagePayload,
} from "@/lib/ai/image-generation/lifestyle-reference-images";

// Max retry attempts for stream errors
const MAX_STREAM_RETRY_ATTEMPTS = 3;
const LIFESTYLE_IMAGE_CONSENT_STORAGE_KEY =
  "openloomi:lifestyle-image-consent:v1";

type LifestyleImageGenerationApiResponse = {
  success: boolean;
  prompt?: string;
  sourceSummary?: unknown;
  warnings?: unknown[];
  usage?: {
    provider?: string;
    model?: string;
    imageCount?: number;
    creditsUsed?: number;
    costMode?: string;
    quotaMode?: string;
  };
  images?: Array<{
    imageUrl?: string;
    dataUrl?: string;
    b64Json?: string;
    mimeType?: string;
    revisedPrompt?: string;
  }>;
  imageUrl?: string;
  dataUrl?: string;
  b64Json?: string;
  mimeType?: string;
  error?: string;
  errorType?: string;
  imageGeneration?: {
    provider?: string;
    model?: string;
    imageCount?: number;
    creditsUsed?: number;
  };
};

type ChatHistoryCache = {
  chats?: Array<{
    id: string;
    title?: string;
    createdAt?: Date | string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export interface ChatContextValue {
  // Current chat ID
  activeChatId: string | null;
  setActiveChatId: (id: string | null) => void;

  // Messages
  messages: ChatMessage[];
  setMessages: (
    updater: React.SetStateAction<ChatMessage[]>,
    chatId?: string | null,
  ) => void;
  sendMessage: (
    content: any,
    options?: { chatId?: string; [key: string]: unknown },
  ) => Promise<void>;
  setSendMessage: (fn: (content: any, options?: any) => Promise<void>) => void;
  confirmLifestyleImageGeneration: (input: {
    chatId: string;
    assistantMessageId: string;
    prompt: string;
    referenceImages?: LifestyleReferenceImagePayload[];
  }) => Promise<void>;
  declineLifestyleImageGeneration: (input: {
    chatId: string;
    assistantMessageId: string;
  }) => void;
  stop: () => void;
  stopChat: (chatId: string) => void;

  // Per-chat session states
  isAgentRunning: boolean;
  setIsAgentRunning: (running: boolean, chatId?: string) => void;

  // File preview state
  previewFile: {
    path: string;
    name: string;
    type: string;
    taskId?: string;
  } | null;
  openFilePreviewPanel: (file: {
    path: string;
    name: string;
    type: string;
    taskId?: string;
  }) => void;
  closeFilePreviewPanel: () => void;

  // Vault state
  isVaultOpen: boolean;
  setVaultOpen: (open: boolean) => void;

  // Switch chatId
  switchChatId: (chatId: string | null, forceRefresh?: boolean) => void;

  // Aggregate compatibility flag; navigation and runtime ownership are per chat.
  isSending: boolean;

  // Get all chat session states (used to display running status of each chat in header)
  getChatSessionStates: () => Map<string, ChatSessionState>;
  // Get isAgentRunning for a specific chatId (not necessarily the activeChatId)
  getIsAgentRunningByChatId: (chatId: string) => boolean;
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

export function useChatContext() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return context;
}

export function useChatContextOptional(): ChatContextValue | null {
  const context = useContext(ChatContext);
  return context || null;
}

function hasAcceptedLifestyleImageConsent(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.localStorage.getItem(LIFESTYLE_IMAGE_CONSENT_STORAGE_KEY) ===
    "accepted"
  );
}

function acceptLifestyleImageConsent(): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LIFESTYLE_IMAGE_CONSENT_STORAGE_KEY, "accepted");
}

function getLifestyleImageUrl(
  response: LifestyleImageGenerationApiResponse,
): { url: string; mediaType: string } | null {
  const image = response.images?.[0];
  const mimeType = image?.mimeType || response.mimeType || "image/png";
  const url =
    image?.dataUrl ||
    image?.imageUrl ||
    response.dataUrl ||
    response.imageUrl ||
    (image?.b64Json ? `data:${mimeType};base64,${image.b64Json}` : null) ||
    (response.b64Json ? `data:${mimeType};base64,${response.b64Json}` : null);

  return url ? { url, mediaType: mimeType } : null;
}

function messageHasImageAttachment(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return false;

  return parts.some((part) => {
    if (!part || typeof part !== "object") return false;
    const mediaType = (part as { mediaType?: unknown }).mediaType;
    return typeof mediaType === "string" && mediaType.startsWith("image/");
  });
}

async function requestLifestyleImageSkillRoute(input: {
  message: string;
  hasReferenceImage: boolean;
  model: string;
}): Promise<LifestyleImageSkillRouteResult> {
  try {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    let authToken: string | null = null;
    try {
      authToken = getAuthToken();
    } catch (error) {
      console.error("[LifestyleImageIntent] Failed to read auth token", error);
    }
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    const response = await fetch("/api/ai/v1/images/lifestyle/intent", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      return createLifestyleImageSkillFallbackRoute("classifier_error");
    }

    const data = (await response.json().catch(() => null)) as {
      route?: unknown;
    } | null;
    if (!isLifestyleImageSkillRouteResult(data?.route)) {
      return createLifestyleImageSkillFallbackRoute("invalid_schema");
    }

    return data.route;
  } catch (error) {
    console.error(
      "[LifestyleImageIntent] Failed to resolve skill route",
      error,
    );
    return createLifestyleImageSkillFallbackRoute("classifier_error");
  }
}

export function ChatContextProvider({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();

  // =====================================================================
  // Chat state management
  // =====================================================================

  // Client-side selected chat ID
  const [activeChatId, setActiveChatId] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("activeChatId");
        if (saved) return saved;
      } catch (e) {
        console.error("[ChatContext] Failed to load activeChatId:", e);
      }
    }
    return generateUUID();
  });

  // Persist activeChatId - use debounced async write to avoid blocking main thread
  useEffect(() => {
    if (activeChatId) {
      const timeoutId = setTimeout(() => {
        localStorage.setItem("activeChatId", activeChatId);
      }, 100);
      return () => clearTimeout(timeoutId);
    }
  }, [activeChatId]);

  // Max messages per chat to prevent memory issues from unbounded growth
  const MAX_MESSAGES_PER_CHAT = 1000;

  // Messages state - isolated per chatId
  const [messagesMap, setMessagesMap] = useState<Map<string, ChatMessage[]>>(
    new Map(),
  );

  // Get messages for a specific chat
  const getMessages = useCallback(
    (chatId: string | null): ChatMessage[] => {
      if (!chatId) return [];
      return messagesMap.get(chatId) || [];
    },
    [messagesMap],
  );

  // Get messages for current activeChatId
  const messages = activeChatId ? messagesMap.get(activeChatId) || [] : [];

  // Set messages for a specific chat
  const setMessagesForChat = useCallback(
    (chatId: string, updater: (prev: ChatMessage[]) => ChatMessage[]) => {
      setMessagesMap((prev) => {
        const newMap = new Map(prev);
        const chatMessages = newMap.get(chatId) || [];
        const updated = updater(chatMessages);
        // Enforce max messages per chat to prevent memory overflow
        newMap.set(
          chatId,
          updated.length > MAX_MESSAGES_PER_CHAT
            ? updated.slice(-MAX_MESSAGES_PER_CHAT)
            : updated,
        );
        return newMap;
      });
    },
    [],
  );

  // Compatibility with old setMessages interface
  // Supports passing chatId parameter to lock to a specific chat (used in streaming callbacks)
  const setMessages = useCallback(
    (
      updater: React.SetStateAction<ChatMessage[]>,
      chatIdOverride?: string | null,
    ) => {
      const targetChatId = chatIdOverride || activeChatId;
      if (!targetChatId) return;
      setMessagesForChat(targetChatId, (prev) => {
        if (typeof updater === "function") {
          return (updater as (prev: ChatMessage[]) => ChatMessage[])(prev);
        }
        return updater;
      });
    },
    [activeChatId, setMessagesForChat],
  );

  // messagesMap ref, used to access latest map in callbacks
  const messagesMapRef = useRef(messagesMap);
  useEffect(() => {
    messagesMapRef.current = messagesMap;
  }, [messagesMap]);
  // A recovery-active chat is refreshed in the background. Fence overlapping
  // reads so a slower, older response cannot replace a newer/final snapshot.
  const chatLoadSequenceRef = useRef(new Map<string, number>());
  // Fence every stream callback by chat and run generation. A stopped stream
  // may still deliver a late callback after the user starts a newer run in the
  // same conversation; those callbacks must not mutate or finish the new run.
  const chatRunGenerationRef = useRef(new Map<string, number>());
  const abortFnsByChatRef = useRef(new Map<string, () => void>());

  // =====================================================================
  // sendMessage implementation
  // =====================================================================

  // Unified threshold: files larger than this use TUS chunked upload.
  // 400KB stays well under Vercel's 4.5MB body limit and protects small images too.
  const TUS_SIZE_THRESHOLD = 400 * 1024;

  function isImageFile(mediaType?: unknown): boolean {
    return typeof mediaType === "string" && mediaType.startsWith("image/");
  }

  type ImageMessagePart = {
    type?: unknown;
    name?: unknown;
    mediaType?: unknown;
    file?: unknown;
    downloadUrl?: unknown;
    url?: unknown;
    blobPath?: unknown;
  };

  type AgentImageDataInput = Pick<AgentImageAttachment, "mimeType"> & {
    data: string;
    url?: never;
  };

  function isBrowserFile(value: unknown): value is File {
    return typeof File !== "undefined" && value instanceof File;
  }

  function normalizeImageMimeType(
    value: unknown,
    fallback = "image/png",
  ): string {
    return typeof value === "string" && value.startsWith("image/")
      ? value
      : fallback;
  }

  function base64FromDataUrl(dataUrl: string): string | undefined {
    const commaIndex = dataUrl.indexOf(",");
    if (commaIndex === -1) return undefined;
    const data = dataUrl.slice(commaIndex + 1);
    return data.length > 0 ? data : undefined;
  }

  function mimeTypeFromDataUrl(dataUrl: string): string | undefined {
    const match = dataUrl.match(/^data:([^;,]+)[;,]/);
    return match?.[1]?.startsWith("image/") ? match[1] : undefined;
  }

  async function readBlobAsBase64(blob: Blob): Promise<string | undefined> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }
        reject(new Error("Failed to read image data"));
      };
      reader.onerror = () =>
        reject(reader.error ?? new Error("Failed to read image data"));
      reader.readAsDataURL(blob);
    });

    return base64FromDataUrl(dataUrl);
  }

  function localDownloadUrlFromBlobPath(blobPath: unknown): string | undefined {
    if (typeof blobPath !== "string") return undefined;
    const trimmed = blobPath.trim();
    if (!trimmed) return undefined;
    if (
      trimmed.startsWith("http://") ||
      trimmed.startsWith("https://") ||
      trimmed.startsWith("/")
    ) {
      return trimmed;
    }
    return `/api/files/download?path=${encodeURIComponent(trimmed)}`;
  }

  function stringSource(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  async function fetchImageSourceAsBase64(
    source: string,
    fallbackMimeType: string,
  ): Promise<AgentImageDataInput | undefined> {
    if (source.startsWith("data:image/")) {
      const data = base64FromDataUrl(source);
      if (!data) return undefined;
      return {
        data,
        mimeType: mimeTypeFromDataUrl(source) ?? fallbackMimeType,
      };
    }

    try {
      const response = await fetch(source);
      if (!response.ok) {
        console.error("[safeSendMessage] image fetch failed:", {
          source,
          status: response.status,
        });
        return undefined;
      }

      const contentType = response.headers.get("content-type");
      if (contentType && !contentType.startsWith("image/")) {
        console.error("[safeSendMessage] source did not return image:", {
          source,
          contentType,
        });
        return undefined;
      }

      const blob = await response.blob();
      const data = await readBlobAsBase64(blob);
      if (!data) return undefined;

      return {
        data,
        mimeType: contentType?.startsWith("image/")
          ? contentType
          : fallbackMimeType,
      };
    } catch (error) {
      console.error("[safeSendMessage] image fetch error:", {
        source,
        error,
      });
      return undefined;
    }
  }

  async function resolveImagePartToBase64(
    part: ImageMessagePart,
    messageObject: unknown,
  ): Promise<AgentImageDataInput | undefined> {
    const fallbackMimeType = normalizeImageMimeType(part.mediaType);

    if (isBrowserFile(part.file)) {
      const data = await readBlobAsBase64(part.file);
      if (data) {
        return {
          data,
          mimeType: normalizeImageMimeType(part.file.type, fallbackMimeType),
        };
      }
    }

    const messageFiles =
      messageObject &&
      typeof messageObject === "object" &&
      Array.isArray((messageObject as { files?: unknown }).files)
        ? ((messageObject as { files: unknown[] }).files ?? [])
        : [];
    const matchingFile = messageFiles.find(
      (file) =>
        isBrowserFile(file) &&
        (typeof part.name !== "string" || file.name === part.name),
    );
    if (isBrowserFile(matchingFile)) {
      const data = await readBlobAsBase64(matchingFile);
      if (data) {
        return {
          data,
          mimeType: normalizeImageMimeType(matchingFile.type, fallbackMimeType),
        };
      }
    }

    const candidates = [
      stringSource(part.downloadUrl),
      stringSource(part.url),
      localDownloadUrlFromBlobPath(part.blobPath),
    ].filter((value): value is string => Boolean(value));

    for (const source of [...new Set(candidates)]) {
      const resolved = await fetchImageSourceAsBase64(source, fallbackMimeType);
      if (resolved) return resolved;
    }

    return undefined;
  }

  async function collectLifestyleReferenceImages(
    messageObject: unknown,
  ): Promise<LifestyleReferenceImagePayload[]> {
    const parts =
      messageObject &&
      typeof messageObject === "object" &&
      Array.isArray((messageObject as { parts?: unknown }).parts)
        ? ((messageObject as { parts: unknown[] }).parts ?? [])
        : [];
    if (parts.length === 0) return [];

    const sources: Array<{ data: string; mimeType: string; role: "style" }> =
      [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const imagePart = part as ImageMessagePart;
      if (imagePart.type !== "file" || !isImageFile(imagePart.mediaType)) {
        continue;
      }

      try {
        const image = await resolveImagePartToBase64(imagePart, messageObject);
        if (image) {
          sources.push({
            data: image.data,
            mimeType: image.mimeType,
            role: "style",
          });
        }
      } catch (error) {
        console.error(
          "[LifestyleImage] Failed to resolve reference image:",
          imagePart.name,
          error,
        );
      }
    }

    return buildLifestyleReferenceImages(sources);
  }

  const finishNativeAgentRun = useCallback(
    (chatId: string, runGeneration: number) => {
      if (chatRunGenerationRef.current.get(chatId) !== runGeneration) return;
      abortFnsByChatRef.current.delete(chatId);
      setChatSessionStates((prev) =>
        finishChatSession(prev, chatId, runGeneration),
      );
    },
    [],
  );

  const saveChatMessageImmediately = useCallback(
    (message: ChatMessage, chatId: string) => {
      saveMessagesToDatabase([message], chatId, {
        immediate: true,
        skipSync: false,
      });
      mutate(
        (key) => typeof key === "string" && key.startsWith("/api/history"),
        undefined,
        { revalidate: true },
      );
    },
    [],
  );

  const saveUserMessageAndUpdateHistory = useCallback(
    async (message: ChatMessage, chatId: string) => {
      const result = await saveMessagesToDatabase([message], chatId, {
        immediate: true,
        skipSync: false,
      });
      if (!result?.chat) return;

      const chat = result.chat;
      mutate(
        (key) => typeof key === "string" && key.startsWith("/api/history"),
        (data: ChatHistoryCache | undefined) => {
          if (!data || !data.chats) return data;
          const existingIndex = data.chats.findIndex(
            (item) => item.id === chat.id,
          );
          if (existingIndex >= 0) {
            const newChats = [...data.chats];
            newChats[existingIndex] = {
              ...newChats[existingIndex],
              title: chat.title,
            };
            return { ...data, chats: newChats };
          }
          return {
            ...data,
            chats: [
              ...data.chats,
              {
                id: chat.id,
                title: chat.title,
                createdAt: chat.createdAt,
                latestMessageContent: null,
                latestMessageTime: chat.createdAt,
                messageCount: 1,
              },
            ],
          };
        },
        false,
      );
    },
    [],
  );

  const generateLifestyleImageReply = useCallback(
    async ({
      chatId,
      prompt,
      assistantMessageId,
      sourceUserMessageId,
      referenceImages,
      runGeneration,
    }: {
      chatId: string;
      prompt: string;
      assistantMessageId?: string;
      sourceUserMessageId?: string;
      referenceImages?: LifestyleReferenceImagePayload[];
      runGeneration?: number;
    }) => {
      const replyId = assistantMessageId || generateUUID();
      const replyCreatedAt = new Date();
      const loadingText = "Creating your lifestyle image...";
      const loadingMessage = {
        role: "assistant" as const,
        content: loadingText,
        id: replyId,
        createdAt: replyCreatedAt,
        parts: [
          { type: "text" as const, text: loadingText },
          {
            type: "data-lifestyleImageStatus" as const,
            data: {
              id: replyId,
              status: "loading" as const,
            },
          },
        ],
        metadata: {
          createdAt: replyCreatedAt.toISOString(),
          lifestyleImage: {
            status: "loading",
            sourceUserMessageId,
          },
        },
      } as ChatMessage;
      const isCurrentGeneration = () =>
        runGeneration === undefined ||
        chatRunGenerationRef.current.get(chatId) === runGeneration;

      setChatSessionStates((prev) =>
        setChatSessionRunning(prev, chatId, true, runGeneration),
      );
      setMessages((prev) => {
        const index = prev.findIndex((message) => message.id === replyId);
        if (index === -1) return [...prev, loadingMessage];
        const next = [...prev];
        next[index] = loadingMessage;
        return next;
      }, chatId);

      try {
        const headers: HeadersInit = {
          "Content-Type": "application/json",
        };
        let cloudAuthToken: string | null = null;
        try {
          cloudAuthToken = getAuthToken();
        } catch (error) {
          console.error("[LifestyleImage] Failed to read auth token:", error);
        }
        if (cloudAuthToken) {
          headers.Authorization = `Bearer ${cloudAuthToken}`;
        }

        const response = await fetch("/api/ai/v1/images/lifestyle/generate", {
          method: "POST",
          headers,
          body: JSON.stringify({
            chatId,
            triggerPrompt: prompt,
            outputFormat: "png",
            responseFormat: "data_url",
            imageCount: 1,
            ...(referenceImages?.length
              ? {
                  referenceImages,
                  passReferenceImagesToProvider: true,
                }
              : {}),
          }),
        });
        const data = (await response
          .json()
          .catch(() => null)) as LifestyleImageGenerationApiResponse | null;
        if (!isCurrentGeneration()) return;

        if (!response.ok || !data?.success) {
          throw new Error(
            data?.error ||
              `Lifestyle image generation failed (${response.status})`,
          );
        }

        const image = getLifestyleImageUrl(data);
        if (!image) {
          throw new Error("Image provider returned no displayable image");
        }

        const successText = "Here is your lifestyle image.";
        const provider =
          data.usage?.provider || data.imageGeneration?.provider || "unknown";
        const model =
          data.usage?.model || data.imageGeneration?.model || "unknown";
        const imageCount =
          data.usage?.imageCount || data.imageGeneration?.imageCount || 1;
        const creditsUsed =
          data.usage?.creditsUsed ?? data.imageGeneration?.creditsUsed ?? 0;
        const successMessage = {
          role: "assistant" as const,
          content: successText,
          id: replyId,
          createdAt: replyCreatedAt,
          parts: [
            { type: "text" as const, text: successText },
            {
              type: "file" as const,
              url: image.url,
              name: "lifestyle-image.png",
              mediaType: image.mediaType,
              source: "lifestyle-image-generation",
            },
            {
              type: "data-lifestyleImageStatus" as const,
              data: {
                id: replyId,
                status: "success" as const,
                provider,
                model,
                imageCount,
                creditsUsed,
              },
            },
          ],
          metadata: {
            createdAt: replyCreatedAt.toISOString(),
            lifestyleImage: {
              status: "success",
              provider,
              model,
              imageCount,
              creditsUsed,
              costMode: data.usage?.costMode ?? "estimated",
              quotaMode: data.usage?.quotaMode ?? "record_only",
              prompt: data.prompt,
              sourceSummary: data.sourceSummary,
              warnings: data.warnings,
              sourceUserMessageId,
            },
          },
        } as ChatMessage;

        setMessages((prev) => {
          const index = prev.findIndex((message) => message.id === replyId);
          if (index === -1) return [...prev, successMessage];
          const next = [...prev];
          next[index] = successMessage;
          return next;
        }, chatId);
        saveChatMessageImmediately(successMessage, chatId);
      } catch (error) {
        if (!isCurrentGeneration()) return;
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Lifestyle image generation failed";
        const failedMessage = {
          role: "assistant" as const,
          content: errorMessage,
          id: replyId,
          createdAt: replyCreatedAt,
          parts: [
            {
              type: "error" as const,
              content: errorMessage,
            },
            {
              type: "data-lifestyleImageStatus" as const,
              data: {
                id: replyId,
                status: "error" as const,
                error: errorMessage,
              },
            },
          ],
          metadata: {
            createdAt: replyCreatedAt.toISOString(),
            lifestyleImage: {
              status: "error",
              error: errorMessage,
              sourceUserMessageId,
            },
          },
        } as ChatMessage;

        setMessages((prev) => {
          const index = prev.findIndex((message) => message.id === replyId);
          if (index === -1) return [...prev, failedMessage];
          const next = [...prev];
          next[index] = failedMessage;
          return next;
        }, chatId);
        saveChatMessageImmediately(failedMessage, chatId);
        toast({
          type: "error",
          description: errorMessage,
        });
      } finally {
        setChatSessionStates((prev) =>
          runGeneration === undefined
            ? setChatSessionRunning(prev, chatId, false)
            : finishChatSession(prev, chatId, runGeneration),
        );
      }
    },
    [saveChatMessageImmediately, setMessages],
  );

  const confirmLifestyleImageGeneration = useCallback<
    ChatContextValue["confirmLifestyleImageGeneration"]
  >(
    async ({ chatId, assistantMessageId, prompt, referenceImages }) => {
      acceptLifestyleImageConsent();
      await generateLifestyleImageReply({
        chatId,
        prompt,
        assistantMessageId,
        referenceImages,
      });
    },
    [generateLifestyleImageReply],
  );

  const declineLifestyleImageGeneration = useCallback<
    ChatContextValue["declineLifestyleImageGeneration"]
  >(
    ({ chatId, assistantMessageId }) => {
      const declinedText = "Lifestyle image generation canceled.";
      const declinedCreatedAt = new Date();
      const declinedMessage = {
        role: "assistant" as const,
        content: declinedText,
        id: assistantMessageId,
        createdAt: declinedCreatedAt,
        parts: [{ type: "text" as const, text: declinedText }],
        metadata: {
          createdAt: declinedCreatedAt.toISOString(),
          lifestyleImage: {
            status: "declined",
          },
        },
      } as ChatMessage;

      setMessages((prev) => {
        const index = prev.findIndex(
          (message) => message.id === assistantMessageId,
        );
        if (index === -1) return prev;
        const next = [...prev];
        next[index] = declinedMessage;
        return next;
      }, chatId);
      saveChatMessageImmediately(declinedMessage, chatId);
    },
    [saveChatMessageImmediately, setMessages],
  );

  // Create safe sendMessage wrapper, integrating intelligent routing
  const sendMessage: ChatContextValue["sendMessage"] = useCallback(
    async (message, options) => {
      const chatIdForMessages =
        typeof options?.chatId === "string" ? options.chatId : activeChatId;

      if (!chatIdForMessages || chatIdForMessages.length === 0) {
        return Promise.reject(new Error("Chat is not properly initialized"));
      }

      const chatMessagesAtStart =
        messagesMapRef.current.get(chatIdForMessages) ?? [];
      const retryAttempt =
        typeof options?.retryAttempt === "number" ? options.retryAttempt : 0;
      const isRetryAttempt = options?.isRetry === true;
      const retryUserMessageIds = Array.isArray(options?.retryUserMessageIds)
        ? options.retryUserMessageIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const requestedRetryGeneration =
        typeof options?.retryGeneration === "number"
          ? options.retryGeneration
          : null;
      let runGeneration: number;
      if (isRetryAttempt && requestedRetryGeneration !== null) {
        if (
          chatRunGenerationRef.current.get(chatIdForMessages) !==
          requestedRetryGeneration
        ) {
          return;
        }
        runGeneration = requestedRetryGeneration;
      } else {
        runGeneration =
          (chatRunGenerationRef.current.get(chatIdForMessages) ?? 0) + 1;
        chatRunGenerationRef.current.set(chatIdForMessages, runGeneration);
      }
      const isCurrentRun = () =>
        chatRunGenerationRef.current.get(chatIdForMessages) === runGeneration;
      setChatSessionStates((prev) =>
        setChatSessionRunning(prev, chatIdForMessages, true, runGeneration),
      );

      // Extract message content (handle different message types)
      let messageContent: string;
      if (typeof message === "string") {
        messageContent = message;
      } else if (message && typeof message === "object") {
        // Handle complex message types
        // Prefer extracting text from parts
        if ((message as any).parts && Array.isArray((message as any).parts)) {
          const textPart = (message as any).parts.find(
            (p: any) => p.type === "text" && p.text,
          );
          if (textPart) {
            messageContent = textPart.text;
          } else {
            // If no text part found, check if there are image attachments
            const hasImages = (message as any).parts.some(
              (p: any) =>
                p.type === "file" && p.mediaType?.startsWith("image/"),
            );
            // If images present but no text, use default prompt
            if (hasImages) {
              messageContent = t("auth.errors.streamError.analyzeImages");
            } else {
              // Try other fields
              messageContent =
                (message as any).content ||
                (message as any).text ||
                t("auth.errors.streamError.analyzeContent");
            }
          }
        } else {
          // No parts array, try to get fields directly
          messageContent =
            (message as any).content ||
            (message as any).text ||
            t("auth.errors.streamError.analyzeContent");
        }
      } else {
        messageContent = String(message);
      }

      // Ensure messageContent is not empty
      if (!messageContent || messageContent.trim() === "") {
        messageContent = t("auth.errors.streamError.analyzeContent");
      }

      const triggerMessageObject =
        message && typeof message === "object"
          ? (message as {
              parts?: ChatMessage["parts"];
              metadata?: Record<string, unknown>;
            })
          : null;
      const hasLifestyleReferenceImage =
        messageHasImageAttachment(triggerMessageObject);
      const shouldSkipLifestyleImageSkill =
        triggerMessageObject?.metadata?.skipLifestyleImageTrigger === true;
      const lifestyleSkillRoute = shouldSkipLifestyleImageSkill
        ? createLifestyleImageSkillFallbackRoute("intent_not_matched")
        : await requestLifestyleImageSkillRoute({
            message: messageContent,
            hasReferenceImage: hasLifestyleReferenceImage,
            model: DEFAULT_AI_MODEL,
          });
      if (!isCurrentRun()) return;
      const lifestyleSkillDecision = lifestyleSkillRoute.decision;
      const shouldGenerateFromClassifierFallback =
        shouldGenerateLifestyleImageFromClassifierFallback({
          route: lifestyleSkillRoute,
          message: messageContent,
          hasReferenceImage: hasLifestyleReferenceImage,
        });
      if (
        (lifestyleSkillRoute.shouldGenerate && lifestyleSkillDecision) ||
        shouldGenerateFromClassifierFallback
      ) {
        const generationPrompt =
          lifestyleSkillDecision?.refinedPrompt || messageContent;
        const userMessageCreatedAt = new Date();
        const userMessage = {
          role: "user" as const,
          content: messageContent,
          createdAt: userMessageCreatedAt,
          parts: triggerMessageObject?.parts || [
            { type: "text" as const, text: messageContent },
          ],
          metadata: {
            ...triggerMessageObject?.metadata,
            createdAt: userMessageCreatedAt.toISOString(),
            lifestyleImageTrigger: {
              kind: lifestyleSkillDecision
                ? "skill_lifestyle_image_request"
                : "classifier_fallback_lifestyle_image_request",
              reason:
                lifestyleSkillDecision?.reason ||
                lifestyleSkillRoute.fallbackReason,
              confidence: lifestyleSkillDecision?.confidence || "low",
              hasReferenceImage: hasLifestyleReferenceImage,
            },
          },
          id: generateUUID(),
        } as ChatMessage;
        setMessages((prev) => [...prev, userMessage], chatIdForMessages);
        try {
          await saveUserMessageAndUpdateHistory(userMessage, chatIdForMessages);
        } catch (error) {
          if (!isCurrentRun()) return;
          finishNativeAgentRun(chatIdForMessages, runGeneration);
          throw error;
        }
        if (!isCurrentRun()) return;

        const referenceImages = hasLifestyleReferenceImage
          ? await collectLifestyleReferenceImages(triggerMessageObject)
          : [];
        if (!isCurrentRun()) return;
        if (!hasAcceptedLifestyleImageConsent()) {
          const consentMessageId = generateUUID();
          const consentCreatedAt = new Date(userMessageCreatedAt.getTime() + 1);
          const consentMessage = {
            role: "assistant" as const,
            content: "",
            id: consentMessageId,
            createdAt: consentCreatedAt,
            parts: [
              {
                type: "data-lifestyleImageConsent" as const,
                data: {
                  id: consentMessageId,
                  prompt: generationPrompt,
                  reason:
                    lifestyleSkillDecision?.reason ||
                    lifestyleSkillRoute.fallbackReason,
                  createdAt: new Date().toISOString(),
                  ...(referenceImages.length ? { referenceImages } : {}),
                },
              },
            ],
            metadata: {
              createdAt: consentCreatedAt.toISOString(),
              lifestyleImage: {
                status: "consent_required",
                sourceUserMessageId: userMessage.id,
              },
            },
          } as ChatMessage;
          setMessages((prev) => [...prev, consentMessage], chatIdForMessages);
          saveChatMessageImmediately(consentMessage, chatIdForMessages);
          finishNativeAgentRun(chatIdForMessages, runGeneration);
          return Promise.resolve();
        }

        await generateLifestyleImageReply({
          chatId: chatIdForMessages,
          prompt: generationPrompt,
          sourceUserMessageId: userMessage.id,
          referenceImages,
          runGeneration,
        });
        return Promise.resolve();
      }

      // Extract image attachments, file attachments, RAG documents from message
      const images: AgentImageDataInput[] = [];
      const fileAttachments: Array<{
        name: string;
        data: string;
        mimeType: string;
      }> = [];
      let ragDocuments: Array<{ id: string; name: string }> = [];

      if (message && typeof message === "object") {
        // Extract image attachments as base64-only agent inputs. URLs remain
        // UI/download references and are resolved before crossing this boundary.
        if ((message as any).parts && Array.isArray((message as any).parts)) {
          for (const part of (message as any).parts) {
            if (part.type === "file" && part.mediaType?.startsWith("image/")) {
              // Image attachment - check if there is an original file object
              try {
                const image = await resolveImagePartToBase64(part, message);
                if (!isCurrentRun()) return;
                if (image) images.push(image);
              } catch (error) {
                console.error(
                  "[safeSendMessage] Exception loading image:",
                  part.name,
                  error,
                );
              }
            }
          }
        }

        // Handle all file attachments (including non-image files) - used to save to workspace
        if ((message as any).parts && Array.isArray((message as any).parts)) {
          for (const part of (message as any).parts) {
            if (part.type === "file") {
              // Skip images: they are already handled in the images loop above
              if (isImageFile(part.mediaType)) continue;

              // All file types (including images) can be saved to workspace
              try {
                let base64Data: string | undefined;

                // Method 1: Prefer checking if part has original file object
                if (part.file && part.file instanceof File) {
                  const file = part.file as File;
                  // Use TUS for large non-image files
                  if (file.size > TUS_SIZE_THRESHOLD) {
                    const blobUrl = await uploadImageTUS(file);
                    if (!isCurrentRun()) return;
                    if (blobUrl) {
                      // Fetch back from our TUS endpoint as base64 for the agent
                      const headers: HeadersInit = { credentials: "include" };
                      const cloudToken = getAuthToken();
                      if (cloudToken) {
                        headers.Authorization = `Bearer ${cloudToken}`;
                      }
                      const resp = await fetch(blobUrl, headers);
                      if (!isCurrentRun()) return;
                      const buffer = await resp.arrayBuffer();
                      if (!isCurrentRun()) return;
                      const base64 = Buffer.from(buffer).toString("base64");
                      const mimeType =
                        part.mediaType || "application/octet-stream";
                      base64Data = `data:${mimeType};base64,${base64}`;
                    } else {
                      toast({
                        type: "error",
                        description: `File "${part.name}" upload failed`,
                      });
                      finishNativeAgentRun(chatIdForMessages, runGeneration);
                      return;
                    }
                  } else {
                    // Read directly from original File object
                    const base64 = await new Promise<string>(
                      (resolve, reject) => {
                        const reader = new FileReader();
                        reader.onloadend = () =>
                          resolve(reader.result as string);
                        reader.onerror = reject;
                        reader.readAsDataURL(part.file);
                      },
                    );
                    if (!isCurrentRun()) return;
                    base64Data = base64;
                  }
                }
                // Method 2: Check message.files array
                else if (
                  (message as any).files &&
                  Array.isArray((message as any).files)
                ) {
                  const file = (message as any).files.find(
                    (f: any) => f.name === part.name,
                  );
                  if (file && file instanceof File) {
                    // Use TUS for large non-image files
                    if (file.size > TUS_SIZE_THRESHOLD) {
                      const blobUrl = await uploadImageTUS(file);
                      if (!isCurrentRun()) return;
                      if (blobUrl) {
                        const headers: HeadersInit = { credentials: "include" };
                        const cloudToken = getAuthToken();
                        if (cloudToken) {
                          headers.Authorization = `Bearer ${cloudToken}`;
                        }
                        const resp = await fetch(blobUrl, headers);
                        if (!isCurrentRun()) return;
                        const buffer = await resp.arrayBuffer();
                        if (!isCurrentRun()) return;
                        const base64 = Buffer.from(buffer).toString("base64");
                        const mimeType =
                          part.mediaType || "application/octet-stream";
                        base64Data = `data:${mimeType};base64,${base64}`;
                      } else {
                        toast({
                          type: "error",
                          description: `File "${part.name}" upload failed`,
                        });
                        finishNativeAgentRun(chatIdForMessages, runGeneration);
                        return;
                      }
                    } else {
                      const base64 = await new Promise<string>(
                        (resolve, reject) => {
                          const reader = new FileReader();
                          reader.onloadend = () =>
                            resolve(reader.result as string);
                          reader.onerror = reject;
                          reader.readAsDataURL(file);
                        },
                      );
                      if (!isCurrentRun()) return;
                      base64Data = base64;
                    }
                  }
                }
                // Method 3: Get via downloadUrl
                else if (part.downloadUrl) {
                  const response = await fetch(part.downloadUrl);
                  if (!isCurrentRun()) return;
                  const blob = await response.blob();
                  if (!isCurrentRun()) return;
                  const base64 = await new Promise<string>((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result as string);
                    reader.readAsDataURL(blob);
                  });
                  if (!isCurrentRun()) return;
                  base64Data = base64;
                }
                // Method 4: Try normal URL
                else if (part.url) {
                  const response = await fetch(part.url);
                  if (!isCurrentRun()) return;
                  const blob = await response.blob();
                  if (!isCurrentRun()) return;
                  const base64 = await new Promise<string>((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result as string);
                    reader.readAsDataURL(blob);
                  });
                  if (!isCurrentRun()) return;
                  base64Data = base64;
                }

                if (base64Data) {
                  fileAttachments.push({
                    name: part.name,
                    data: base64Data,
                    mimeType: part.mediaType || "application/octet-stream",
                  });
                }
              } catch (error) {
                console.error(
                  "[safeSendMessage] 閴?Exception loading file attachment:",
                  part.name,
                  error,
                );
              }
            }
          }
        }

        // Extract RAG documents
        if ((message as any).metadata?.ragDocuments) {
          ragDocuments = (message as any).metadata.ragDocuments;
        }
      }
      if (!isCurrentRun()) return;

      // Add user message to conversation history (preserve original parts and metadata)
      const userMessage = {
        role: "user" as const,
        content: messageContent,
        parts: (message as any).parts || [
          { type: "text" as const, text: messageContent },
        ],
        metadata: (message as any).metadata, // Preserve metadata (includes ragDocuments)
        id: generateUUID(),
      } as ChatMessage;
      setMessages((prev) => [...prev, userMessage], chatIdForMessages);

      // Immediately save user message to database and update history cache
      saveMessagesToDatabase([userMessage], chatIdForMessages).then(
        (result) => {
          if (!result?.chat) return;

          const chat = result.chat;
          // Directly update SWR cache so chat header shows title immediately
          mutate(
            (key) => typeof key === "string" && key.startsWith("/api/history"),
            (data: any) => {
              if (!data || !data.chats) return data;
              // Check if this chat already exists, update title if it does, add to front if it doesn't
              const existingIndex = data.chats.findIndex(
                (c: any) => c.id === chat.id,
              );
              if (existingIndex >= 0) {
                // Update existing chat title
                const newChats = [...data.chats];
                newChats[existingIndex] = {
                  ...newChats[existingIndex],
                  title: chat.title,
                };
                return { ...data, chats: newChats };
              }
              // Add new chat to end of list (rightmost)
              return {
                ...data,
                chats: [
                  ...data.chats,
                  {
                    id: chat.id,
                    title: chat.title,
                    createdAt: chat.createdAt,
                    latestMessageContent: null,
                    latestMessageTime: chat.createdAt,
                    messageCount: 1,
                  },
                ],
              };
            },
            false,
          );
        },
      );

      // Create a temporary assistant message for streaming updates
      // Add an empty text part to avoid isPendingAssistant filtering in messages.tsx
      // Refer to hasVisibleAssistantContent logic: messages with empty parts will not render
      const assistantMessageId = generateUUID();
      const assistantMessage = {
        role: "assistant" as const,
        content: "",
        parts: [{ type: "text" as const, text: "" }],
        id: assistantMessageId,
      } as ChatMessage;
      setMessages((prev) => [...prev, assistantMessage], chatIdForMessages);

      const codexTransportToastId = `codex-transport-${assistantMessageId}`;
      const codexTransportStatus = createCodexTransportStatusController({
        show: (status) => {
          const description =
            status.phase === "fallback"
              ? t("chat.codexTransport.fallback")
              : typeof status.attempt === "number" &&
                  typeof status.maxAttempts === "number"
                ? t("chat.codexTransport.retryingWithAttempt", {
                    attempt: status.attempt,
                    maxAttempts: status.maxAttempts,
                  })
                : t("chat.codexTransport.retrying");
          toast({
            id: codexTransportToastId,
            type: "info",
            description,
            duration: Number.POSITIVE_INFINITY,
          });
        },
        clear: () => dismissToast(codexTransportToastId),
      });

      // Used to manage message stream order
      let parts: any[] = [];
      let textContent = "";
      // Used for message deduplication - track received messageIds
      const receivedMessageIds = new Set<string>();

      try {
        // Call Native Agent API
        // Note: Billing is now handled in the backend API, no need to pass userId and userType here

        // Build conversation history
        // During retry, need to remove incomplete last round of conversation
        let conversationMessages = chatMessagesAtStart.filter(
          (m) => m.role !== "system",
        );

        if (isRetryAttempt && retryUserMessageIds.length > 0) {
          conversationMessages = prepareRetryConversation(
            conversationMessages,
            retryUserMessageIds,
          );
        }

        const conversation = conversationMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: getTextFromMessage(m),
        }));

        // Get user auth token for native agent in Tauri mode
        let cloudAuthToken: string | undefined;
        if (isTauri()) {
          try {
            cloudAuthToken = getAuthToken() || undefined;
          } catch (error) {
            console.error(
              "[NativeAgent] Failed to read cloud_auth_token:",
              error,
            );
          }
        }

        // Configure to use local API endpoint in Tauri mode
        const effectiveModel = DEFAULT_AI_MODEL;
        const modelConfig = cloudAuthToken
          ? {
              baseUrl: AI_PROXY_BASE_URL, // SDK will automatically add /v1/messages
              apiKey: cloudAuthToken, // User's auth token
              model: effectiveModel, // Use user-selected model
              thinkingLevel: undefined,
            }
          : undefined;

        // Directly save AI message parts during streaming updates
        // Avoid AI message parts being lost to database when switching chats
        const saveAssistantMessage = () => {
          // Directly use local parts variable and assistantMessageId to construct message
          // Build from this run's local stream state so chat switches cannot
          // redirect persistence to whichever conversation is now active.
          if (parts.length === 0) return;

          const messageToSave = {
            role: "assistant" as const,
            content: textContent,
            parts: [...parts], // Copy current parts
            id: assistantMessageId,
          } as ChatMessage;
          saveMessagesToDatabase([messageToSave], chatIdForMessages);
        };

        await streamNativeAgentResponse(messageContent, {
          chatId: chatIdForMessages,
          conversation,
          taskId: chatIdForMessages,
          // Pass complete workDir path to ensure files are created in the correct directory.
          workDir: `~/.openloomi/sessions/${chatIdForMessages}`,
          images,
          fileAttachments:
            fileAttachments.length > 0 ? fileAttachments : undefined,
          ragDocuments,
          authToken: cloudAuthToken,
          // Immediately save abortFn to ref and state, reduce race conditions
          onAbortFnReady: (abortFn) => {
            if (
              chatRunGenerationRef.current.get(chatIdForMessages) !==
              runGeneration
            ) {
              abortFn();
              return;
            }
            abortFnsByChatRef.current.set(chatIdForMessages, abortFn);
            setChatSessionStates((prev) =>
              attachChatSessionAbort(
                prev,
                chatIdForMessages,
                abortFn,
                runGeneration,
              ),
            );
          },
          onUpdate: async (data) => {
            if (!isCurrentRun()) return;
            // Deduplicate based on messageId - avoid duplicate messages
            const messageId = (data as { messageId?: string }).messageId;
            if (messageId) {
              if (receivedMessageIds.has(messageId)) {
                // Skip duplicate messages
                return;
              }
              receivedMessageIds.add(messageId);
            }

            // Codex WebSocket reconnect and HTTPS fallback notices are one
            // temporary status for this turn. Terminal result/error messages
            // clear it before their normal chat handling continues.
            const handledCodexTransportStatus =
              codexTransportStatus.handle(data);

            // Handle streaming updates
            if (data.type === "text") {
              // Text content - accumulate incremental text sent by backend
              // Backend sends incremental text chunks each time, frontend needs to accumulate
              const newContent: string = data.content || "";

              // Check if content increment would cause duplication (e.g. "Hello Hello")
              // If new content already exists in textContent, skip it
              // Use indexOf check because "Hello " + "Hello" = "Hello Hello" can occur
              if (
                typeof newContent === "string" &&
                newContent.length >= 10 &&
                textContent.startsWith(newContent)
              ) {
                // Content already exists, skip this increment
                return;
              }

              textContent += newContent;

              // Update or create text part
              const lastPart = parts[parts.length - 1];
              if (lastPart && lastPart.type === "text") {
                // Update last text part
                parts[parts.length - 1] = {
                  type: "text" as const,
                  text: textContent,
                };
              } else {
                // Create new text part
                parts.push({
                  type: "text" as const,
                  text: textContent,
                });
              }

              setMessages((prev) => {
                const updated = [...prev];
                const lastIndex = updated.length - 1;
                if (lastIndex >= 0 && updated[lastIndex].role === "assistant") {
                  updated[lastIndex] = {
                    ...updated[lastIndex],
                    content: textContent,
                    parts: [...parts],
                  } as ChatMessage;
                }
                return updated;
              }, chatIdForMessages);
            } else if (data.type === "tool_use") {
              // Tool call - add or update the existing part.
              // Some providers stream the tool call before the full input is available,
              // then send the same toolUseId again with parameters.
              const toolUseId = data.toolUseId || data.id;
              const toolPart = {
                type: "tool-native" as const,
                toolName: data.name || "unknown",
                toolInput: data.input,
                status: "executing",
                toolUseId,
              };

              const existingIndex = parts.findIndex(
                (part: any) =>
                  part?.type === "tool-native" &&
                  toolUseId &&
                  part?.toolUseId === toolUseId,
              );
              if (existingIndex >= 0) {
                parts[existingIndex] = {
                  ...parts[existingIndex],
                  ...toolPart,
                  toolInput: data.input ?? parts[existingIndex].toolInput,
                };
              } else {
                parts.push(toolPart);
              }
              // Reset textContent so subsequent new text chunks start accumulating from empty
              textContent = "";

              setMessages((prev) => {
                const updated = [...prev];
                const lastIndex = updated.length - 1;
                if (lastIndex >= 0 && updated[lastIndex].role === "assistant") {
                  updated[lastIndex] = {
                    ...updated[lastIndex],
                    parts: [...parts],
                  } as ChatMessage;
                }
                return updated;
              }, chatIdForMessages);
            } else if (data.type === "tool_result") {
              // Tool execution result - update corresponding tool use part
              // Check if it is a raw-message query tool result.
              if (data.output && typeof data.output === "string") {
                try {
                  const outputObj = JSON.parse(data.output);
                  if (outputObj.method === "indexeddb_query") {
                    const {
                      queryRawMessages,
                      queryRawMessagesGrouped,
                      formatRawMessagesForAI,
                    } = await import("@melandlabs/indexeddb");
                    if (!isCurrentRun()) return;

                    const params = outputObj.params;
                    let messages: any[];
                    let resultText: string;

                    // Use grouped query if groupBy is specified
                    if (params.groupBy && params.groupBy !== "none") {
                      const grouped = await queryRawMessagesGrouped(params);
                      if (!isCurrentRun()) return;
                      const groupKeys = Object.keys(grouped).sort((a, b) => {
                        if (a === "Today") return -1;
                        if (b === "Today") return 1;
                        if (a === "Yesterday") return -1;
                        if (b === "Yesterday") return 1;
                        return b.localeCompare(a);
                      });

                      const totalMessages =
                        Object.values(grouped).flat().length;
                      resultText = `Found ${totalMessages} messages grouped by ${params.groupBy}:\n\n`;

                      for (const key of groupKeys) {
                        const groupMessages = grouped[key];
                        resultText += `## ${key} (${groupMessages.length} messages)\n`;
                        resultText += formatRawMessagesForAI(groupMessages);
                        resultText += "\n\n";
                      }

                      messages = Object.values(grouped).flat();
                    } else {
                      messages = await queryRawMessages(params);
                      if (!isCurrentRun()) return;
                      resultText = formatRawMessagesForAI(messages);
                    }

                    // Send result back to Agent as user message
                    if (messages.length > 0) {
                      const title = `Query Results (${messages.length} messages)`;
                      const fullText = `${title}\n\n${resultText}`;

                      // Add a new text part
                      parts.push({
                        type: "text" as const,
                        text: fullText,
                      });

                      setMessages((prev) => {
                        const updated = [...prev];
                        const lastIndex = updated.length - 1;
                        if (
                          lastIndex >= 0 &&
                          updated[lastIndex].role === "assistant"
                        ) {
                          updated[lastIndex] = {
                            ...updated[lastIndex],
                            parts: [...parts],
                          } as ChatMessage;
                        }
                        return updated;
                      }, chatIdForMessages);
                    } else {
                      // No messages found, update tool output
                      data.output = "No messages found matching your criteria.";
                    }
                  }
                } catch (e) {
                  // Not a JSON or not an indexeddb_query, continue normal processing
                }
              }

              // Find corresponding tool use part and update
              const updatedParts = parts.map((part) => {
                if (
                  part.type === "tool-native" &&
                  part.toolUseId === data.toolUseId
                ) {
                  const updatedPart = {
                    ...part,
                    status: data.isError
                      ? ("error" as const)
                      : ("completed" as const),
                    toolOutput: data.output,
                    isError: data.isError,
                  };

                  // Check if files were generated (supports .pptx, .pdf, .xlsx, .md etc.)
                  if (data.output && typeof data.output === "string") {
                    const foundFiles = extractArtifactPathsFromText(
                      data.output,
                    );

                    if (foundFiles.length > 0) {
                      const filePathRaw = pickPreferredArtifactPath(foundFiles);
                      if (filePathRaw) {
                        // Clean path: remove trailing whitespace and parentheses
                        const filePath = filePathRaw
                          .trim()
                          .replace(/[()\s]+$/g, "");

                        const fileName = artifactPathBasename(filePath);
                        const fileExt = fileName
                          .split(".")
                          .pop()
                          ?.toLowerCase();

                        updatedPart.generatedFile = {
                          path: filePath,
                          name: fileName,
                          type: fileExt || "unknown",
                        };

                        // For code or text files, add code preview
                        if (
                          [
                            "py",
                            "js",
                            "ts",
                            "tsx",
                            "jsx",
                            "md",
                            "txt",
                          ].includes(fileExt || "")
                        ) {
                          // Try to extract code content from output
                          const codeMatch = data.output.match(
                            /File created successfully at: (.+)/,
                          );
                          if (codeMatch) {
                            updatedPart.codeFile = {
                              path: filePath,
                              name: fileName,
                              language: fileExt,
                            };
                          }
                        }
                      }
                    }
                  }

                  return updatedPart;
                }
                return part;
              });

              parts = updatedParts;

              setMessages((prev) => {
                const updated = [...prev];
                const lastIndex = updated.length - 1;
                if (lastIndex >= 0 && updated[lastIndex].role === "assistant") {
                  updated[lastIndex] = {
                    ...updated[lastIndex],
                    parts: [...parts],
                  } as ChatMessage;
                }
                return updated;
              }, chatIdForMessages);
            } else if (data.type === "reasoning") {
              // Reasoning content - accumulate incremental reasoning text
              const newReasoning: string = data.content || data.text || "";

              if (!newReasoning) return; // Skip empty reasoning

              // Find if there's already a reasoning part at the end of the current parts
              const lastPart = parts[parts.length - 1];

              if (lastPart && lastPart.type === "reasoning") {
                // Append to existing reasoning part (streaming accumulation)
                const existingText = (lastPart as any).text || "";
                (lastPart as any).text = existingText + newReasoning;
              } else {
                // Create new reasoning part
                parts.push({
                  type: "reasoning" as const,
                  text: newReasoning,
                });
              }
            } else if (data.type === "permission_request") {
              // Permission request from SDK - needs user confirmation
              const permissionPart = {
                type: "data-permission-request" as const,
                data: {
                  permissionRequest: data.permissionRequest,
                },
              };

              parts.push(permissionPart);

              setMessages((prev) => {
                const updated = [...prev];
                const lastIndex = updated.length - 1;
                if (lastIndex >= 0 && updated[lastIndex].role === "assistant") {
                  updated[lastIndex] = {
                    ...updated[lastIndex],
                    parts: [...parts],
                  } as ChatMessage;
                }
                return updated;
              }, chatIdForMessages);
            } else if (data.type === "retry") {
              // Other providers may also emit retry messages without Codex's
              // structured transport phase. Preserve their existing brief
              // informational notice.
              if (!handledCodexTransportStatus) {
                const retryMessage =
                  data.content || data.message || "Agent is retrying...";
                toast({
                  type: "info",
                  description: retryMessage,
                });
              }
            } else if (data.type === "error") {
              console.error("[NativeAgent] Error:", data.message);
              const errorMessage = data.message || "Unknown error";
              const userFriendlyMessage = formatAgentStreamErrorForUser(
                "chat",
                errorMessage,
              );
              toast({
                type: "error",
                description: userFriendlyMessage,
              });
              // Add error to message
              const errorPart = {
                type: "error" as const,
                content: userFriendlyMessage,
              };
              parts.push(errorPart);

              // Provider-timeout interruption: surface a structured data part
              // so the chat UI can render an explicit Continue action that
              // reuses the preserved workspace. We deliberately skip the
              // stream-level auto-retry path (handled in onError) by tagging
              // the part with an interruption payload — see issue #356.
              const interruption = parseCodexInterruptedError(errorMessage);
              if (interruption?.canResume) {
                parts.push({
                  type: "data-interruption",
                  data: {
                    reason: "timeout",
                    timeoutMs: interruption.timeoutMs,
                    workspacePath: interruption.workspacePath,
                    completedArtifacts: interruption.completedArtifacts,
                    canResume: true,
                  },
                } as ChatMessage["parts"][number]);
              }

              setMessages((prev) => {
                const updated = [...prev];
                const lastIndex = updated.length - 1;
                if (lastIndex >= 0 && updated[lastIndex].role === "assistant") {
                  updated[lastIndex] = {
                    ...updated[lastIndex],
                    parts: [...parts],
                  } as ChatMessage;
                }
                return updated;
              }, chatIdForMessages);
            } else if (data.type === "result") {
              // Handle error result types
              if (data.content === "error_during_execution") {
                toast({
                  type: "error",
                  description: "Agent execution failed. Please try again.",
                });
                // Add error to message
                const errorPart = {
                  type: "error" as const,
                  content: "Agent execution failed. Please try again.",
                };
                parts.push(errorPart);

                setMessages((prev) => {
                  const updated = [...prev];
                  const lastIndex = updated.length - 1;
                  if (
                    lastIndex >= 0 &&
                    updated[lastIndex].role === "assistant"
                  ) {
                    updated[lastIndex] = {
                      ...updated[lastIndex],
                      parts: [...parts],
                    } as ChatMessage;
                  }
                  return updated;
                }, chatIdForMessages);
              } else if (data.content === "error_max_turns") {
                toast({
                  type: "error",
                  description: "Agent reached maximum turn limit.",
                });
                // Add error to message for consistency with error_during_execution
                const errorPart = {
                  type: "error" as const,
                  content: "Agent reached maximum turn limit.",
                };
                parts.push(errorPart);
                setMessages((prev) => {
                  const updated = [...prev];
                  const lastIndex = updated.length - 1;
                  if (
                    lastIndex >= 0 &&
                    updated[lastIndex].role === "assistant"
                  ) {
                    updated[lastIndex] = {
                      ...updated[lastIndex],
                      parts: [...parts],
                    } as ChatMessage;
                  }
                  return updated;
                }, chatIdForMessages);
              } else if (data.content === "error_max_budget_usd") {
                toast({
                  type: "error",
                  description: "Agent reached maximum budget.",
                });
                // Add error to message for consistency with error_during_execution
                const errorPart = {
                  type: "error" as const,
                  content: "Agent reached maximum budget.",
                };
                parts.push(errorPart);
                setMessages((prev) => {
                  const updated = [...prev];
                  const lastIndex = updated.length - 1;
                  if (
                    lastIndex >= 0 &&
                    updated[lastIndex].role === "assistant"
                  ) {
                    updated[lastIndex] = {
                      ...updated[lastIndex],
                      parts: [...parts],
                    } as ChatMessage;
                  }
                  return updated;
                }, chatIdForMessages);
              } else if (
                data.content === "error_max_structured_output_retries"
              ) {
                toast({
                  type: "error",
                  description:
                    "Agent failed to produce valid structured output.",
                });
                // Add error to message for consistency
                const errorPart = {
                  type: "error" as const,
                  content: "Agent failed to produce valid structured output.",
                };
                parts.push(errorPart);
                setMessages((prev) => {
                  const updated = [...prev];
                  const lastIndex = updated.length - 1;
                  if (
                    lastIndex >= 0 &&
                    updated[lastIndex].role === "assistant"
                  ) {
                    updated[lastIndex] = {
                      ...updated[lastIndex],
                      parts: [...parts],
                    } as ChatMessage;
                  }
                  return updated;
                }, chatIdForMessages);
              }
              finishNativeAgentRun(chatIdForMessages, runGeneration);
            }

            // Save AI message parts on every update
            // Ensure AI message parts already generated won't be lost to database when switching chats
            // Backend uses onConflictDoUpdate to handle duplicate saves
            saveAssistantMessage();
          },
          modelConfig,
          onDone: async () => {
            codexTransportStatus.clear();
            if (!isCurrentRun()) return;
            finishNativeAgentRun(chatIdForMessages, runGeneration);

            // Persist the locally accumulated assistant response to the chat
            // that started this run, even if the user has since switched.
            if (parts.length > 0) {
              saveMessagesToDatabase(
                [
                  {
                    role: "assistant" as const,
                    content: textContent,
                    parts: [...parts],
                    id: assistantMessageId,
                  } as ChatMessage,
                ],
                chatIdForMessages,
                { immediate: true, skipSync: false },
              );
            }

            mutate(
              (key) =>
                typeof key === "string" && key.startsWith("/api/history"),
              undefined,
              { revalidate: true },
            );
          },
          onError: (error) => {
            codexTransportStatus.clear();
            if (!isCurrentRun()) return;
            console.error("[NativeAgent] Stream error:", error);
            finishNativeAgentRun(chatIdForMessages, runGeneration);

            // Safely extract error properties
            const errorName =
              error instanceof Error
                ? error.name
                : typeof error === "string"
                  ? "String Error"
                  : "Unknown Error";
            const errorMessage =
              error instanceof Error ? error.message : String(error);

            // Detect if it is a stream connection error (network issues or service timeout)
            const lowerErrorMessage = errorMessage.toLowerCase();
            const isRetryable = (error as any)?.isRetryable;
            const isStreamConnectionError =
              isRetryable === true ||
              lowerErrorMessage.includes("stream") ||
              lowerErrorMessage.includes("network") ||
              lowerErrorMessage.includes("connection") ||
              lowerErrorMessage.includes("timeout") ||
              lowerErrorMessage.includes("fetch") ||
              lowerErrorMessage.includes("cloud") ||
              lowerErrorMessage.includes("502") ||
              lowerErrorMessage.includes("503") ||
              lowerErrorMessage.includes("504") ||
              lowerErrorMessage.includes("bad gateway") ||
              lowerErrorMessage.includes("upstream") ||
              (errorName === "TypeError" &&
                lowerErrorMessage.includes("fetch"));

            // Display error message
            const errorContent = isStreamConnectionError
              ? `Stream Error: ${errorMessage}`
              : `Stream Error: ${errorMessage}\n\nError Type: ${errorName}`;

            // Add error part to message for friendly display
            setMessages((prev) => {
              const updated = [...prev];
              const lastIndex = updated.length - 1;
              if (lastIndex >= 0 && updated[lastIndex].role === "assistant") {
                // Safely get existing parts, use empty array if not available
                const existingParts = Array.isArray(updated[lastIndex].parts)
                  ? updated[lastIndex].parts
                  : [];

                updated[lastIndex] = {
                  ...updated[lastIndex],
                  content: errorContent,
                  parts: [
                    ...existingParts,
                    {
                      type: "error" as const,
                      content: errorContent,
                    },
                  ],
                } as ChatMessage;
              }
              return updated;
            }, chatIdForMessages);

            // If it is a stream connection error and max retry count not reached, auto retry
            if (
              isStreamConnectionError &&
              retryAttempt < MAX_STREAM_RETRY_ATTEMPTS
            ) {
              toast({
                type: "info",
                description: t("auth.errors.streamError.retrying", {
                  current: retryAttempt + 1,
                  max: MAX_STREAM_RETRY_ATTEMPTS,
                }),
              });

              // Retry after delay
              setTimeout(() => {
                if (!isCurrentRun()) return;
                if (message) {
                  // Remove assistant message by ID instead of position (bug fix: avoid deleting wrong message if user sent new message during delay)
                  setMessages((prev) => {
                    const updated = prev.filter(
                      (m) => m.id !== assistantMessageId,
                    );
                    return updated;
                  }, chatIdForMessages);

                  // Build retry message, tell AI to continue previous task
                  // Create a new message object without mutating this attempt's
                  // input. The retry stays bound to the originating chat even
                  // if the user has navigated elsewhere during the delay.
                  const retryPromptText = t(
                    "auth.errors.streamError.retryPrompt",
                  );
                  let retryMessage: any;
                  if (typeof message === "object" && message.parts) {
                    // If object format (with parts), add continue instruction
                    const textPart = message.parts.find(
                      (p: any) => p.type === "text",
                    );
                    if (textPart) {
                      // Create new parts array, prepend "Please continue:" to original text
                      const updatedParts = message.parts.map((part: any) =>
                        part.type === "text"
                          ? {
                              ...part,
                              text: `${retryPromptText}${part.text}`,
                            }
                          : part,
                      );
                      retryMessage = {
                        ...message,
                        parts: updatedParts,
                      };
                    } else {
                      // If no text part, create one
                      retryMessage = {
                        ...message,
                        parts: [
                          { type: "text", text: retryPromptText },
                          ...message.parts,
                        ],
                      };
                    }
                  } else if (typeof message === "string") {
                    // If string format, prepend continue prefix
                    retryMessage = `${retryPromptText}${message}`;
                  } else {
                    // Other cases, use original message directly
                    retryMessage = message;
                  }

                  // Resend message
                  sendMessage(retryMessage, {
                    chatId: chatIdForMessages,
                    isRetry: true,
                    retryAttempt: retryAttempt + 1,
                    retryGeneration: runGeneration,
                    retryUserMessageIds: [
                      ...retryUserMessageIds,
                      userMessage.id,
                    ],
                  }).catch((err) => {
                    console.error("[NativeAgent] Retry failed:", err);
                  });
                }
              }, 2000); // Retry after 2 seconds

              // Keep native mode, do not interrupt execution
              return;
            }

            // Max retry count reached or not a stream connection error
            if (isStreamConnectionError) {
              toast({
                type: "error",
                description: t("auth.errors.streamError.maxRetriesReached", {
                  max: MAX_STREAM_RETRY_ATTEMPTS,
                }),
              });
            } else {
              toast({
                type: "error",
                description: `${t("auth.errors.streamError.description")}: ${errorMessage}`,
              });
            }
          },
        });

        return Promise.resolve();
      } catch (error) {
        codexTransportStatus.clear();
        if (!isCurrentRun()) {
          return Promise.resolve();
        }
        console.error("[NativeAgent] API call failed:", error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorContent = `API Error: ${errorMessage}`;

        // Show toast with error details
        toast({
          type: "error",
          description: `Call failed: ${errorMessage}`,
        });

        setMessages((prev) => {
          const updated = [...prev];
          const lastIndex = updated.length - 1;
          if (lastIndex >= 0 && updated[lastIndex].role === "assistant") {
            // Safely get existing parts, use empty array if not available
            const existingParts = Array.isArray(updated[lastIndex].parts)
              ? updated[lastIndex].parts
              : [];

            updated[lastIndex] = {
              ...updated[lastIndex],
              content: errorContent,
              parts: [
                ...existingParts,
                {
                  type: "error" as const,
                  content: errorContent,
                },
              ],
            } as ChatMessage;
          }
          return updated;
        }, chatIdForMessages);
        finishNativeAgentRun(chatIdForMessages, runGeneration);
        return Promise.reject(error);
      }
    },
    [
      activeChatId,
      setMessages,
      t,
      finishNativeAgentRun,
      saveUserMessageAndUpdateHistory,
      saveChatMessageImmediately,
      generateLifestyleImageReply,
    ],
  );

  // setSendMessage - no longer needed because sendMessage is implemented in context
  const setSendMessage = useCallback((fn: any) => {}, []);

  // =====================================================================
  // UI state
  // =====================================================================

  // Vault state
  const [isVaultOpen, setIsVaultOpen] = useState(false);

  // File preview state
  const [previewFile, setPreviewFile] = useState<{
    path: string;
    name: string;
    type: string;
    taskId?: string;
  } | null>(null);

  const closeFilePreviewPanel = useCallback(() => {
    setPreviewFile(null);
  }, []);

  // =====================================================================
  // Per-chat transient runtime state
  // =====================================================================

  const [chatSessionStates, setChatSessionStates] = useState<
    Map<string, ChatSessionState>
  >(() => new Map());

  // Runtime state cannot survive a reload because abort functions are not
  // serializable. Remove legacy persisted flags so a stale `true` value cannot
  // resurrect a stop button without a live request.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.removeItem("chatSessionStates");
    } catch (error) {
      console.warn(
        "[ChatContext] Failed to remove legacy chat runtime state:",
        error,
      );
    }
  }, []);

  const getChatSessionState = useCallback(
    (chatId: string): ChatSessionState => {
      return readChatSessionState(chatSessionStates, chatId);
    },
    [chatSessionStates],
  );

  // Get isAgentRunning for a specific chatId (not necessarily the activeChatId)
  const getIsAgentRunningByChatId = useCallback(
    (chatId: string): boolean => {
      return getChatSessionState(chatId).isAgentRunning;
    },
    [getChatSessionState],
  );

  const currentSessionState = activeChatId
    ? getChatSessionState(activeChatId)
    : { isAgentRunning: false, abortFn: null };

  // Compatibility stop: cancel every local run without allowing a late
  // callback to match a generation that gets reused by the next run.
  const stop = useCallback(() => {
    const chatIds = new Set([
      ...chatSessionStates.keys(),
      ...abortFnsByChatRef.current.keys(),
    ]);
    for (const chatId of chatIds) {
      chatRunGenerationRef.current.set(
        chatId,
        (chatRunGenerationRef.current.get(chatId) ?? 0) + 1,
      );
    }

    const abortFns = [...abortFnsByChatRef.current.values()];
    abortFnsByChatRef.current.clear();
    for (const abortFn of abortFns) {
      try {
        abortFn();
      } catch (error) {
        console.error("[stop] Error aborting native agent:", error);
      }
    }

    setChatSessionStates((prev) => {
      const next = new Map(prev);
      for (const [chatId, state] of next) {
        if (state.abortFn || state.isAgentRunning) {
          next.set(chatId, {
            ...state,
            abortFn: null,
            isAgentRunning: false,
          });
        }
      }
      return next;
    });
    return Promise.resolve();
  }, [chatSessionStates]);

  // Abort only the requested chat. Goal pause uses this after the durable
  // pause boundary so unrelated conversations keep running.
  const stopChat = useCallback(
    (chatId: string) => {
      chatRunGenerationRef.current.set(
        chatId,
        (chatRunGenerationRef.current.get(chatId) ?? 0) + 1,
      );
      const abortFn =
        abortFnsByChatRef.current.get(chatId) ??
        chatSessionStates.get(chatId)?.abortFn ??
        null;
      abortFnsByChatRef.current.delete(chatId);

      setChatSessionStates((prev) => {
        const state = prev.get(chatId);
        if (!state?.abortFn && !state?.isAgentRunning) return prev;
        const next = new Map(prev);
        next.set(chatId, {
          ...state,
          abortFn: null,
          isAgentRunning: false,
        });
        return next;
      });

      try {
        abortFn?.();
      } catch (error) {
        console.error("[stopChat] Error aborting native agent:", error);
      }
    },
    [chatSessionStates],
  );

  const setIsAgentRunningFn = useCallback(
    (running: boolean, chatId?: string) => {
      const targetChatId = chatId ?? activeChatId;
      if (!targetChatId) return;
      setChatSessionStates((prev) =>
        setChatSessionRunning(prev, targetChatId, running),
      );
    },
    [activeChatId],
  );

  const openFilePreviewPanel = useCallback(
    (file: { path: string; name: string; type: string; taskId?: string }) => {
      setPreviewFile(file);
    },
    [],
  );

  // =====================================================================
  // Switch Chat
  // =====================================================================

  const switchChatId = useCallback(
    async (newChatId: string | null, forceRefresh?: boolean) => {
      if (!newChatId) {
        const newUuid = generateUUID();
        setActiveChatId(newUuid);
        // No need to manually clear, will get empty array from map when switching to new chat
        return;
      }

      // Switch activeChatId first, messages will automatically be fetched from messagesMap
      // If the chat already has cached messages, use them directly; otherwise will fetch from API later
      const existingMessages = messagesMapRef.current.get(newChatId) || [];
      setActiveChatId(newChatId);

      // If already has cached messages and not forcing refresh, use cache
      if (existingMessages.length > 0 && !forceRefresh) {
        return;
      }

      const loadSequence =
        (chatLoadSequenceRef.current.get(newChatId) ?? 0) + 1;
      chatLoadSequenceRef.current.set(newChatId, loadSequence);

      // Load messages asynchronously without blocking UI
      (async () => {
        try {
          const response = await fetch(`/api/chat/${newChatId}`, {
            cache: "no-store",
          });
          // 404 means new conversation has no history, this is normal
          if (response.status === 404) {
            // Keep empty, do not store in map
            return;
          }
          if (!response.ok) {
            console.error(
              "[switchChatId] Failed to fetch messages:",
              response.status,
            );
            return;
          }
          const data = await response.json();
          if (chatLoadSequenceRef.current.get(newChatId) !== loadSequence) {
            return;
          }
          const uiMessages = data.messages || [];
          // Store fetched messages in map
          setMessagesMap((prev) => {
            const newMap = new Map(prev);
            newMap.set(newChatId, uiMessages);
            return newMap;
          });
        } catch (error) {
          console.error("[switchChatId] Failed to switch chat:", error);
        }
      })();
    },
    [],
  );

  const contextValue = useMemo<ChatContextValue>(() => {
    return {
      activeChatId,
      setActiveChatId,
      messages,
      setMessages,
      sendMessage,
      setSendMessage,
      confirmLifestyleImageGeneration,
      declineLifestyleImageGeneration,
      stop,
      stopChat,
      // Per-chat states
      isAgentRunning: currentSessionState.isAgentRunning,
      setIsAgentRunning: setIsAgentRunningFn,
      // File preview
      previewFile,
      openFilePreviewPanel,
      closeFilePreviewPanel,
      // Vault
      isVaultOpen,
      setVaultOpen: setIsVaultOpen,
      // Switch chat
      switchChatId,
      // Aggregate runtime activity (kept for the pet bridge). A terminal event
      // from one chat must not hide another chat that is still running.
      isSending: [...chatSessionStates.values()].some(
        (state) => state.isAgentRunning,
      ),
      // Get all chat session states
      getChatSessionStates: () => chatSessionStates,
      // Get isAgentRunning for a specific chatId
      getIsAgentRunningByChatId,
    };
  }, [
    activeChatId,
    messages,
    currentSessionState,
    chatSessionStates,
    setIsAgentRunningFn,
    previewFile,
    openFilePreviewPanel,
    closeFilePreviewPanel,
    isVaultOpen,
    switchChatId,
    getIsAgentRunningByChatId,
    confirmLifestyleImageGeneration,
    declineLifestyleImageGeneration,
    stopChat,
  ]);

  return (
    <ChatContext.Provider value={contextValue}>{children}</ChatContext.Provider>
  );
}
