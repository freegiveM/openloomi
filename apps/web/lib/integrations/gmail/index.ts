import { google, type people_v1, type gmail_v1 } from "googleapis";
import type { GaxiosResponseWithHTTP2 } from "googleapis-common";
import type { OAuth2Client } from "google-auth-library";
import { AppError } from "@openloomi/shared/errors";
import {
  updateIntegrationAccount,
  type BotWithAccount,
} from "@/lib/db/queries";
import { getApplicationBaseUrl } from "@/lib/env";
import type { ExtractEmailInfo } from "../email";
import type { Attachment } from "@openloomi/shared";
import { ingestAttachmentForUser } from "@/lib/integrations/utils/attachments";
import { cleanEmailForLLM, buildSnippet } from "@openloomi/integrations/utils";
import type { UserType } from "@openloomi/contracts/user-type";

const GMAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DEFAULT_GMAIL_INSIGHT_SYNC_MAX_RESULTS = 100;
const DEFAULT_GMAIL_INSIGHT_BOOTSTRAP_WINDOW_HOURS = 24;
const GMAIL_API_LIST_PAGE_SIZE = 500;
const GMAIL_API_FETCH_CONCURRENCY = 5;

export const GMAIL_INSIGHT_SYNC_CONFIG_KEY = "gmailSync";

type GmailInsightSyncMode =
  | "bootstrap"
  | "history"
  | "bounded_resync"
  | "pending";

export type GmailInsightSyncState = {
  historyId?: string;
  pendingMessageIds?: string[];
  bootstrapCompletedAt?: string;
  lastSyncedAt?: string;
  lastSyncMode?: GmailInsightSyncMode;
  lastHistoryExpiredAt?: string;
  lastFetchedMessageCount?: number;
  lastListedMessageCount?: number;
  lastSkippedMessageCount?: number;
};

export type GmailInsightSyncTimingEvent = {
  phase: string;
  status: "start" | "success" | "failure";
  durationMs?: number;
  details?: Record<string, unknown>;
  error?: unknown;
};

type GmailInsightSyncTimingLogger = (
  event: GmailInsightSyncTimingEvent,
) => void;

export type GmailInsightSyncResult = {
  emails: ExtractEmailInfo[];
  syncMode: GmailInsightSyncMode;
  historyId?: string;
  previousHistoryId?: string;
  nextSyncState: GmailInsightSyncState;
  listedMessageCount: number;
  fetchedMessageCount: number;
  skippedMessageCount: number;
  pendingMessageCount: number;
  resultSizeEstimate?: number;
  historyExpired?: boolean;
};

type GmailMessageFetchResult = {
  emails: ExtractEmailInfo[];
  skippedMessageCount: number;
};

function parseString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function parseGmailInsightSyncState(
  value: unknown,
): GmailInsightSyncState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const pendingMessageIds = Array.isArray(raw.pendingMessageIds)
    ? raw.pendingMessageIds.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : undefined;

  return {
    historyId: parseString(raw.historyId),
    pendingMessageIds:
      pendingMessageIds && pendingMessageIds.length > 0
        ? [...new Set(pendingMessageIds)]
        : undefined,
    bootstrapCompletedAt: parseString(raw.bootstrapCompletedAt),
    lastSyncedAt: parseString(raw.lastSyncedAt),
    lastSyncMode: parseString(raw.lastSyncMode) as
      | GmailInsightSyncMode
      | undefined,
    lastHistoryExpiredAt: parseString(raw.lastHistoryExpiredAt),
    lastFetchedMessageCount: parseNumber(raw.lastFetchedMessageCount),
    lastListedMessageCount: parseNumber(raw.lastListedMessageCount),
    lastSkippedMessageCount: parseNumber(raw.lastSkippedMessageCount),
  };
}

function formatGmailSearchDate(timestampSeconds: number): string {
  const date = new Date(timestampSeconds * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function isGmailHistoryExpiredError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as {
    code?: number;
    status?: number;
    response?: { status?: number };
  };
  return (
    maybeError.code === 404 ||
    maybeError.status === 404 ||
    maybeError.response?.status === 404
  );
}

function isSkippableGmailMessageFetchError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as {
    code?: number;
    status?: number;
    response?: { status?: number };
  };
  const status =
    maybeError.code ?? maybeError.status ?? maybeError.response?.status;
  return status === 404 || status === 410;
}

function shouldSkipGmailLabelIds(labelIds?: string[] | null): boolean {
  if (!Array.isArray(labelIds)) return false;
  const labels = new Set(labelIds);
  return (
    labels.has("CATEGORY_PROMOTIONS") ||
    labels.has("SPAM") ||
    labels.has("TRASH")
  );
}

async function timeGmailSyncStep<T>(
  onTiming: GmailInsightSyncTimingLogger | undefined,
  phase: string,
  details: Record<string, unknown> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  onTiming?.({
    phase,
    status: "start",
    details,
  });

  try {
    const result = await fn();
    onTiming?.({
      phase,
      status: "success",
      durationMs: Date.now() - startedAt,
      details,
    });
    return result;
  } catch (error) {
    onTiming?.({
      phase,
      status: "failure",
      durationMs: Date.now() - startedAt,
      details,
      error,
    });
    throw error;
  }
}

/**
 * Raw attachment format (before ingestion)
 */
interface RawAttachment {
  filename: string;
  size: number;
  mimeType: string;
  contentId?: string | undefined;
  base64Data?: string;
}

/**
 * Base email info without attachments
 */
interface BaseEmailFields {
  uid: string;
  subject: string;
  from: { name: string; email: string };
  /** Cleaned HTML */
  html?: string;
  /** Uncleaned original HTML, for info source to display email original content */
  rawHtml?: string;
  cc?: Array<{ name: string; email: string }>;
  bcc?: Array<{ name: string; email: string }>;
  timestamp: number;
  text: string;
  snippet: string;
}

/**
 * Formatted email with raw attachments (before ingestion)
 */
interface FormattedGmailEmail extends BaseEmailFields {
  attachments: RawAttachment[];
  labelIds?: string[];
  gmailCategory?: string;
  priority?: string;
}

// Scopes for Gmail OAuth integration
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

/**
 * Stored credentials for Gmail OAuth integration
 */
export type GmailStoredCredentials = {
  accessToken?: string | null;
  refreshToken?: string | null;
  scope?: string | null;
  tokenType?: string | null;
  expiryDate?: number | null;
};

/**
 * Gmail OAuth Adapter for API-based email sending
 * Handles OAuth credentials refresh automatically
 */
export class GmailOAuthAdapter {
  private oauth2Client: OAuth2Client;
  private gmailService: gmail_v1.Gmail;
  private peopleService: people_v1.People;
  private botId: string;
  private userId: string;
  private platformAccountId: string | null;
  private storedCredentials: GmailStoredCredentials;
  ownerUserId: string | undefined;
  ownerUserType: UserType | undefined;

  constructor(options: {
    bot: BotWithAccount;
    credentials: GmailStoredCredentials;
    ownerUserId?: string;
    ownerUserType?: UserType;
  }) {
    const clientId =
      process.env.GMAIL_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID;
    const clientSecret =
      process.env.GMAIL_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new AppError(
        "bad_request:api",
        "Gmail integration is not configured. Please set GOOGLE_CLIENT_ID/SECRET.",
      );
    }

    const redirectUri =
      process.env.GMAIL_REDIRECT_URI ??
      `${getApplicationBaseUrl()}/api/gmail/callback`;

    this.oauth2Client = new google.auth.OAuth2({
      clientId,
      clientSecret,
      redirectUri,
    });

    this.botId = options.bot.id;
    this.userId = options.bot.userId;
    this.platformAccountId = options.bot.platformAccount?.id ?? null;
    this.storedCredentials = options.credentials ?? {};
    this.ownerUserId = options.ownerUserId;
    this.ownerUserType = options.ownerUserType;

    this.oauth2Client.setCredentials({
      access_token: this.storedCredentials.accessToken ?? undefined,
      refresh_token: this.storedCredentials.refreshToken ?? undefined,
      expiry_date: this.storedCredentials.expiryDate ?? undefined,
      scope: this.storedCredentials.scope ?? undefined,
      token_type: this.storedCredentials.tokenType ?? undefined,
    });

    this.gmailService = google.gmail({
      version: "v1",
      auth: this.oauth2Client,
    });

    this.peopleService = google.people({
      version: "v1",
      auth: this.oauth2Client,
    });
  }

  private async persistCredentialsIfChanged() {
    const nextCredentials: GmailStoredCredentials = {
      accessToken: this.oauth2Client.credentials.access_token ?? null,
      refreshToken: this.oauth2Client.credentials.refresh_token ?? null,
      scope: this.oauth2Client.credentials.scope ?? null,
      tokenType: this.oauth2Client.credentials.token_type ?? null,
      expiryDate: this.oauth2Client.credentials.expiry_date ?? null,
    };

    const changed =
      nextCredentials.accessToken !== this.storedCredentials.accessToken ||
      nextCredentials.refreshToken !== this.storedCredentials.refreshToken ||
      nextCredentials.scope !== this.storedCredentials.scope ||
      nextCredentials.tokenType !== this.storedCredentials.tokenType ||
      nextCredentials.expiryDate !== this.storedCredentials.expiryDate;

    if (!changed || !this.platformAccountId) {
      this.storedCredentials = nextCredentials;
      return;
    }

    await updateIntegrationAccount({
      userId: this.userId,
      platformAccountId: this.platformAccountId,
      credentials: nextCredentials,
    });
    this.storedCredentials = nextCredentials;
  }

  private async withGmail<T>(
    callback: (gmail: gmail_v1.Gmail) => Promise<T>,
  ): Promise<T> {
    const result = await callback(this.gmailService);
    await this.persistCredentialsIfChanged();
    return result;
  }

  /**
   * Send email via Gmail API
   */
  async sendEmail({
    to,
    subject,
    body,
    html,
  }: {
    to: string;
    subject: string;
    body: string;
    html?: string;
  }): Promise<{ id: string }> {
    return this.withGmail(async (gmail) => {
      let emailContent: string;

      if (html) {
        // HTML email with multipart
        const htmlBody = html.replace(/\n/g, "<br>");
        emailContent = [
          `To: ${to}`,
          `Subject: ${subject}`,
          "MIME-Version: 1.0",
          'Content-Type: multipart/alternative; boundary="boundary"',
          "",
          "--boundary",
          "Content-Type: text/plain; charset=utf-8",
          "",
          body.replace(/<[^>]+>/g, ""), // Plain text fallback
          "",
          "--boundary",
          "Content-Type: text/html; charset=utf-8",
          "",
          htmlBody,
          "",
          "--boundary--",
        ].join("\r\n");
      } else {
        // Plain text email
        emailContent = [
          `To: ${to}`,
          `Subject: ${subject}`,
          "Content-Type: text/plain; charset=utf-8",
          "MIME-Version: 1.0",
          "",
          body,
        ].join("\r\n");
      }

      // Base64URL encode
      const encodedMessage = Buffer.from(emailContent).toString("base64url");

      // Send email
      const sendResponse = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: encodedMessage },
      });

      const messageId = sendResponse.data.id;
      if (!messageId) {
        throw new Error("Gmail API did not return a message ID");
      }
      return { id: messageId };
    });
  }

  /**
   * Find contact by name via Google People API
   */
  async findContactEmail(name: string): Promise<
    Array<{
      name: string;
      email: string;
    }>
  > {
    const searchResponse = await this.peopleService.people.searchContacts({
      query: name,
      readMask: "names,emailAddresses,nicknames",
    });

    const contacts = searchResponse.data.results ?? [];

    if (contacts.length === 0) {
      const otherContactsResponse =
        await this.peopleService.otherContacts.search({
          query: `${name}*`,
          readMask: "names,emailAddresses,nicknames",
        });
      contacts.push(...(otherContactsResponse.data.results ?? []));
    }

    return contacts.map((result: any) => {
      const person = result.person ?? {};
      const names = person.names ?? [{}];
      const emails = person.emailAddresses ?? [{}];

      return {
        name: names[0].displayName ?? "N/A",
        email: emails[0].value ?? "N/A",
      };
    });
  }

  /**
   * Get user's Gmail address
   */
  async getUserEmailAddress(): Promise<string> {
    return this.withGmail(async (gmail) => {
      const profile = await gmail.users.getProfile({
        userId: "me",
      });
      return profile.data.emailAddress ?? "";
    });
  }

  async getEmailsForInsightSync({
    since,
    maxResults = DEFAULT_GMAIL_INSIGHT_SYNC_MAX_RESULTS,
    bootstrapWindowHours = DEFAULT_GMAIL_INSIGHT_BOOTSTRAP_WINDOW_HOURS,
    syncState,
    onTiming,
  }: {
    since: number;
    maxResults?: number;
    bootstrapWindowHours?: number;
    syncState?: GmailInsightSyncState | null;
    onTiming?: GmailInsightSyncTimingLogger;
  }): Promise<GmailInsightSyncResult> {
    return this.withGmail(async (gmail) => {
      const normalizedMaxResults = Math.max(1, Math.floor(maxResults));
      const previousState = parseGmailInsightSyncState(syncState) ?? {};
      const pendingMessageIds = previousState.pendingMessageIds ?? [];

      if (pendingMessageIds.length > 0) {
        return this.fetchPendingInsightMessages({
          gmail,
          pendingMessageIds,
          maxResults: normalizedMaxResults,
          syncState: previousState,
          onTiming,
        });
      }

      if (previousState.historyId) {
        try {
          return await this.fetchHistoryInsightMessages({
            gmail,
            startHistoryId: previousState.historyId,
            maxResults: normalizedMaxResults,
            syncState: previousState,
            onTiming,
          });
        } catch (error) {
          if (!isGmailHistoryExpiredError(error)) {
            throw error;
          }
          return this.fetchBoundedBootstrapInsightMessages({
            gmail,
            since,
            maxResults: normalizedMaxResults,
            bootstrapWindowHours,
            syncState: {
              ...previousState,
              lastHistoryExpiredAt: new Date().toISOString(),
            },
            syncMode: "bounded_resync",
            historyExpired: true,
            onTiming,
          });
        }
      }

      return this.fetchBoundedBootstrapInsightMessages({
        gmail,
        since,
        maxResults: normalizedMaxResults,
        bootstrapWindowHours,
        syncState: previousState,
        syncMode: "bootstrap",
        onTiming,
      });
    });
  }

  private async fetchPendingInsightMessages({
    gmail,
    pendingMessageIds,
    maxResults,
    syncState,
    onTiming,
  }: {
    gmail: gmail_v1.Gmail;
    pendingMessageIds: string[];
    maxResults: number;
    syncState: GmailInsightSyncState;
    onTiming?: GmailInsightSyncTimingLogger;
  }): Promise<GmailInsightSyncResult> {
    const messageIds = pendingMessageIds.slice(0, maxResults);
    const remainingPendingIds = pendingMessageIds.slice(messageIds.length);
    const fetchResult = await this.fetchMessagesByIds(gmail, messageIds, {
      syncMode: "pending",
      onTiming,
    });
    const emails = fetchResult.emails;
    const now = new Date().toISOString();

    return {
      emails,
      syncMode: "pending",
      historyId: syncState.historyId,
      nextSyncState: {
        ...syncState,
        pendingMessageIds:
          remainingPendingIds.length > 0 ? remainingPendingIds : undefined,
        lastSyncedAt: now,
        lastSyncMode: "pending",
        lastFetchedMessageCount: emails.length,
        lastListedMessageCount: pendingMessageIds.length,
        lastSkippedMessageCount: fetchResult.skippedMessageCount,
      },
      listedMessageCount: pendingMessageIds.length,
      fetchedMessageCount: emails.length,
      skippedMessageCount: fetchResult.skippedMessageCount,
      pendingMessageCount: remainingPendingIds.length,
    };
  }

  private async fetchHistoryInsightMessages({
    gmail,
    startHistoryId,
    maxResults,
    syncState,
    onTiming,
  }: {
    gmail: gmail_v1.Gmail;
    startHistoryId: string;
    maxResults: number;
    syncState: GmailInsightSyncState;
    onTiming?: GmailInsightSyncTimingLogger;
  }): Promise<GmailInsightSyncResult> {
    const historyResult = await timeGmailSyncStep(
      onTiming,
      "gmail_api_history_list",
      { startHistoryId },
      () => this.listMessageIdsByHistory(gmail, startHistoryId),
    );
    const messageIds = historyResult.messageIds.slice(0, maxResults);
    const pendingMessageIds = historyResult.messageIds.slice(messageIds.length);
    const fetchResult = await this.fetchMessagesByIds(gmail, messageIds, {
      syncMode: "history",
      onTiming,
    });
    const emails = fetchResult.emails;
    const now = new Date().toISOString();

    return {
      emails,
      syncMode: "history",
      historyId: historyResult.historyId,
      previousHistoryId: startHistoryId,
      nextSyncState: {
        ...syncState,
        historyId: historyResult.historyId ?? syncState.historyId,
        pendingMessageIds:
          pendingMessageIds.length > 0 ? pendingMessageIds : undefined,
        lastSyncedAt: now,
        lastSyncMode: "history",
        lastFetchedMessageCount: emails.length,
        lastListedMessageCount: historyResult.messageIds.length,
        lastSkippedMessageCount: fetchResult.skippedMessageCount,
      },
      listedMessageCount: historyResult.messageIds.length,
      fetchedMessageCount: emails.length,
      skippedMessageCount: fetchResult.skippedMessageCount,
      pendingMessageCount: pendingMessageIds.length,
    };
  }

  private async fetchBoundedBootstrapInsightMessages({
    gmail,
    since,
    maxResults,
    bootstrapWindowHours,
    syncState,
    syncMode,
    historyExpired = false,
    onTiming,
  }: {
    gmail: gmail_v1.Gmail;
    since: number;
    maxResults: number;
    bootstrapWindowHours: number;
    syncState: GmailInsightSyncState;
    syncMode: "bootstrap" | "bounded_resync";
    historyExpired?: boolean;
    onTiming?: GmailInsightSyncTimingLogger;
  }): Promise<GmailInsightSyncResult> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const boundedSince = Math.max(
      since,
      nowSeconds - Math.max(1, bootstrapWindowHours) * 60 * 60,
    );
    const query = `after:${formatGmailSearchDate(boundedSince)} -category:promotions`;
    const listResult = await timeGmailSyncStep(
      onTiming,
      "gmail_api_messages_list",
      {
        query,
        since: boundedSince,
        sinceIso: new Date(boundedSince * 1000).toISOString(),
        maxResults,
        syncMode,
      },
      () => this.listMessageIdsByQuery(gmail, query, maxResults),
    );
    const fetchResult = await this.fetchMessagesByIds(
      gmail,
      listResult.messageIds,
      {
        syncMode,
        since: boundedSince,
        onTiming,
      },
    );
    const emails = fetchResult.emails;
    const historyId = await this.getCurrentHistoryId(gmail, onTiming, syncMode);
    const now = new Date().toISOString();

    return {
      emails,
      syncMode,
      historyId,
      previousHistoryId: syncState.historyId,
      nextSyncState: {
        ...syncState,
        historyId: historyId ?? syncState.historyId,
        pendingMessageIds: undefined,
        bootstrapCompletedAt: syncState.bootstrapCompletedAt ?? now,
        lastSyncedAt: now,
        lastSyncMode: syncMode,
        lastFetchedMessageCount: emails.length,
        lastListedMessageCount: listResult.messageIds.length,
        lastSkippedMessageCount: fetchResult.skippedMessageCount,
      },
      listedMessageCount: listResult.messageIds.length,
      fetchedMessageCount: emails.length,
      skippedMessageCount: fetchResult.skippedMessageCount,
      pendingMessageCount: 0,
      resultSizeEstimate: listResult.resultSizeEstimate,
      historyExpired,
    };
  }

  private async listMessageIdsByQuery(
    gmail: gmail_v1.Gmail,
    query: string,
    maxResults: number,
  ): Promise<{
    messageIds: string[];
    resultSizeEstimate?: number;
  }> {
    const messageIds: string[] = [];
    let pageToken: string | undefined;
    let resultSizeEstimate: number | undefined;

    do {
      const remaining = maxResults - messageIds.length;
      const response = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: Math.min(GMAIL_API_LIST_PAGE_SIZE, remaining),
        pageToken,
        includeSpamTrash: false,
      });
      resultSizeEstimate =
        response.data.resultSizeEstimate ?? resultSizeEstimate;
      const pageMessageIds = (response.data.messages ?? [])
        .map((message: gmail_v1.Schema$Message) => message.id)
        .filter((id: string | null | undefined): id is string => Boolean(id));
      messageIds.push(...pageMessageIds);
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken && messageIds.length < maxResults);

    return {
      messageIds: [...new Set(messageIds)].slice(0, maxResults),
      resultSizeEstimate,
    };
  }

  private async listMessageIdsByHistory(
    gmail: gmail_v1.Gmail,
    startHistoryId: string,
  ): Promise<{
    messageIds: string[];
    historyId?: string;
  }> {
    const messageIds: string[] = [];
    let pageToken: string | undefined;
    let historyId: string | undefined;

    do {
      const response = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
        maxResults: GMAIL_API_LIST_PAGE_SIZE,
        pageToken,
      });
      historyId = response.data.historyId ?? historyId;

      for (const history of response.data.history ?? []) {
        for (const added of history.messagesAdded ?? []) {
          const message = added.message;
          if (!message?.id || shouldSkipGmailLabelIds(message.labelIds)) {
            continue;
          }
          messageIds.push(message.id);
        }
      }

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return {
      messageIds: [...new Set(messageIds)],
      historyId: historyId ?? (await this.getCurrentHistoryId(gmail)),
    };
  }

  private async getCurrentHistoryId(
    gmail: gmail_v1.Gmail,
    onTiming?: GmailInsightSyncTimingLogger,
    reason?: string,
  ): Promise<string | undefined> {
    const profile = (await timeGmailSyncStep(
      onTiming,
      "gmail_api_get_profile",
      { reason },
      () =>
        gmail.users.getProfile({
          userId: "me",
        }),
    )) as GaxiosResponseWithHTTP2<{ historyId?: string | null }>;
    return profile.data.historyId ?? undefined;
  }

  private async fetchMessagesByIds(
    gmail: gmail_v1.Gmail,
    messageIds: string[],
    {
      syncMode,
      since,
      onTiming,
    }: {
      syncMode: GmailInsightSyncMode;
      since?: number;
      onTiming?: GmailInsightSyncTimingLogger;
    },
  ): Promise<GmailMessageFetchResult> {
    if (messageIds.length === 0) {
      return {
        emails: [],
        skippedMessageCount: 0,
      };
    }

    return timeGmailSyncStep(
      onTiming,
      "gmail_api_fetch_message_details",
      {
        messageCount: messageIds.length,
        concurrency: GMAIL_API_FETCH_CONCURRENCY,
        syncMode,
        since,
        sinceIso: since ? new Date(since * 1000).toISOString() : undefined,
      },
      async () => {
        const results: Array<ExtractEmailInfo | null> = new Array(
          messageIds.length,
        ).fill(null);
        let nextIndex = 0;
        let skippedMessageCount = 0;

        const worker = async () => {
          while (nextIndex < messageIds.length) {
            const currentIndex = nextIndex;
            nextIndex++;
            const messageId = messageIds[currentIndex];
            if (!messageId) continue;

            let msgDetail: GaxiosResponseWithHTTP2<gmail_v1.Schema$Message>;
            try {
              msgDetail = await gmail.users.messages.get({
                userId: "me",
                id: messageId,
                format: "full",
              });
            } catch (error) {
              if (isSkippableGmailMessageFetchError(error)) {
                skippedMessageCount++;
                continue;
              }
              throw error;
            }
            const formattedMessage = await this.formatGmailMessage(msgDetail);
            if (since && formattedMessage.timestamp < since) {
              continue;
            }
            const attachments =
              await this.ingestEmailAttachments(formattedMessage);
            results[currentIndex] = {
              ...formattedMessage,
              attachments,
            };
          }
        };

        const concurrency = Math.min(
          GMAIL_API_FETCH_CONCURRENCY,
          messageIds.length,
        );
        await Promise.all(Array.from({ length: concurrency }, () => worker()));

        return {
          emails: results.filter(
            (email): email is ExtractEmailInfo => email !== null,
          ),
          skippedMessageCount,
        };
      },
    );
  }

  /**
   * Get emails since a specific timestamp
   * @param since - Unix timestamp in seconds
   * @param maxLimits - Maximum number of emails to retrieve
   */
  async getEmailsByTime(
    since: number,
    maxLimits = 100,
  ): Promise<ExtractEmailInfo[]> {
    return this.withGmail(async (gmail) => {
      const res = await gmail.users.messages.list({
        userId: "me",
        q: `after:${Math.floor(since)} -category:promotions`,
      });

      const messages = res.data.messages || [];
      const detailedMessages: ExtractEmailInfo[] = [];

      for (let i = 0; i < messages.length && i < maxLimits; i++) {
        const message = messages[i];
        if (message.id) {
          const msgDetail = await gmail.users.messages.get({
            userId: "me",
            id: message.id,
            format: "full",
          });
          const formattedMessage = await this.formatGmailMessage(msgDetail);
          const attachments =
            await this.ingestEmailAttachments(formattedMessage);
          detailedMessages.push({
            ...formattedMessage,
            attachments,
          });
        }
      }
      return detailedMessages;
    });
  }

  /**
   * Format Gmail API message to FormattedGmailEmail format (with raw attachments)
   */
  private async formatGmailMessage(
    message: GaxiosResponseWithHTTP2<gmail_v1.Schema$Message>,
  ): Promise<FormattedGmailEmail> {
    const payload = message.data.payload;
    const headers = payload?.headers || [];

    const getHeader = (name: string): string => {
      const header = headers.find(
        (h: any) => h.name?.toLowerCase() === name.toLowerCase(),
      );
      return header?.value || "";
    };

    const subject = getHeader("Subject");
    const fromHeader = getHeader("From");
    const ccHeader = getHeader("Cc");

    // Parse from address
    const from = this.parseEmailAddress(fromHeader);
    // Parse cc addresses
    const cc = this.parseEmailAddresses(ccHeader);

    // Extract original email body
    const { text: rawText, html: rawHtml } = this.extractEmailBody(payload);
    const timestamp = message.data.internalDate
      ? Math.floor(Number(message.data.internalDate) / 1000)
      : Math.floor(Date.now() / 1000);

    // Clean content through unified pipeline
    const cleaned = cleanEmailForLLM({ html: rawHtml, text: rawText });
    const cleanedText =
      cleaned.markdown.length > 0 ? cleaned.markdown : rawText;
    const cleanedPlain = cleaned.plain.length > 0 ? cleaned.plain : cleanedText;

    const attachments = this.extractAttachments(payload);

    const labelIds = message.data.labelIds || [];
    const gmailCategory = this.extractGmailCategory(labelIds);
    const priority = this.extractPriority(headers);

    return {
      uid: message.data.id || "",
      subject,
      from,
      cc,
      bcc: [],
      timestamp,
      text: cleanedText,
      html: cleaned.cleanHtml || undefined,
      rawHtml: rawHtml?.trim() || undefined,
      snippet: buildSnippet(cleanedPlain),
      attachments,
      labelIds,
      gmailCategory,
      priority,
    };
  }

  /**
   * Extract Gmail category from label IDs
   */
  private extractGmailCategory(labelIds: string[]): string | undefined {
    const categoryMap: Record<string, string> = {
      CATEGORY_PROMOTIONS: "promotions",
      CATEGORY_SOCIAL: "social",
      CATEGORY_UPDATES: "updates",
      CATEGORY_FORUMS: "forums",
      CATEGORY_PERSONAL: "personal",
    };

    for (const labelId of labelIds) {
      if (categoryMap[labelId]) {
        return categoryMap[labelId];
      }
    }
    return undefined;
  }

  /**
   * Extract priority from email headers
   */
  private extractPriority(
    headers: Array<{ name?: string | null; value?: string | null }>,
  ): string | undefined {
    // Check for X-Priority header (1 = High, 3 = Normal, 5 = Low)
    const xPriorityHeader = headers.find(
      (h) => h.name?.toLowerCase() === "x-priority",
    );
    const xPriority = xPriorityHeader?.value;
    if (xPriority) {
      const match = xPriority.match(/\d/);
      if (match) {
        const priority = Number.parseInt(match[0]);
        if (priority <= 2) return "high";
        if (priority >= 4) return "low";
      }
    }

    // Check for Importance header
    const importanceHeader = headers.find(
      (h) => h.name?.toLowerCase() === "importance",
    );
    const importance = importanceHeader?.value?.toLowerCase();
    if (importance === "high") return "high";
    if (importance === "low") return "low";

    // Check for Priority header
    const priorityHeader = headers.find(
      (h) => h.name?.toLowerCase() === "priority",
    );
    const priority = priorityHeader?.value?.toLowerCase();
    if (priority === "urgent" || priority === "high") return "high";
    if (priority === "non-urgent" || priority === "low") return "low";

    return undefined;
  }

  /**
   * Parse a single email address
   */
  private parseEmailAddress(addressStr: string): {
    name: string;
    email: string;
  } {
    const emailRegex = /(?:"?([^"]*)"?\s)?(?:<)?([^>]+@[^>]+)(?:>)?/;
    const match = addressStr.match(emailRegex);

    if (match) {
      return {
        name: (match[1] || "").trim(),
        email: match[2]?.trim() || "",
      };
    }

    return { name: "", email: addressStr.trim() };
  }

  /**
   * Parse multiple email addresses
   */
  private parseEmailAddresses(
    addressesStr: string,
  ): Array<{ name: string; email: string }> {
    if (!addressesStr) return [];

    return addressesStr
      .split(",")
      .map((addr) => this.parseEmailAddress(addr.trim()))
      .filter((addr) => addr.email.length > 0);
  }

  /**
   * Extract email body (text and HTML) from Gmail message payload
   */
  private extractEmailBody(payload?: gmail_v1.Schema$MessagePart): {
    text: string;
    html: string;
  } {
    if (!payload) {
      return { text: "", html: "" };
    }

    let text = "";
    let html = "";

    const decodeBase64URL = (data?: string | null): string => {
      if (!data) return "";
      try {
        const padded = data + "=".repeat((4 - (data.length % 4)) % 4);
        const buffer = Buffer.from(padded, "base64");
        return buffer.toString("utf-8");
      } catch {
        return "";
      }
    };

    const extractBody = (part: gmail_v1.Schema$MessagePart): void => {
      const mimeType = part.mimeType?.toLowerCase() || "";

      if (part.body?.data) {
        const decoded = decodeBase64URL(part.body.data);
        if (mimeType === "text/plain") {
          text = decoded;
        } else if (mimeType === "text/html") {
          html = decoded;
        }
      }

      if (part.parts) {
        for (const subPart of part.parts) {
          if (!text || !html) {
            extractBody(subPart);
          }
        }
      }
    };

    extractBody(payload);

    return { text, html };
  }

  /**
   * Extract attachments from Gmail message payload
   */
  private extractAttachments(
    payload?: gmail_v1.Schema$MessagePart,
  ): RawAttachment[] {
    if (!payload) return [];

    const attachments: RawAttachment[] = [];

    const extractFromPart = (part: gmail_v1.Schema$MessagePart): void => {
      const mimeType = part.mimeType?.toLowerCase() || "";

      // Check if this part is an attachment
      if (
        part.body?.attachmentId &&
        part.filename &&
        mimeType !== "text/plain" &&
        mimeType !== "text/html"
      ) {
        const contentIdHeader = part.headers?.find(
          (h: any) => h.name?.toLowerCase() === "content-id",
        )?.value;
        attachments.push({
          filename: part.filename,
          size: part.body.size || 0,
          mimeType: mimeType,
          contentId: contentIdHeader ?? undefined,
          base64Data: undefined, // Will be fetched separately if needed
        });
      }

      // Recursively process child parts
      if (part.parts) {
        for (const subPart of part.parts) {
          extractFromPart(subPart);
        }
      }
    };

    extractFromPart(payload);
    return attachments;
  }

  /**
   * Ingest email attachments for a user
   */
  private async ingestEmailAttachments(
    email: FormattedGmailEmail,
  ): Promise<Attachment[]> {
    if (!this.ownerUserId || !this.ownerUserType) {
      return [];
    }

    if (!Array.isArray(email.attachments) || email.attachments.length === 0) {
      return [];
    }

    const collected: Attachment[] = [];

    for (const attachment of email.attachments) {
      if (!attachment.base64Data) {
        console.warn(
          `[gmail ${this.botId}] Attachment ${attachment.filename} has no data, skipping`,
        );
        continue;
      }

      let buffer: Buffer;
      try {
        buffer = Buffer.from(attachment.base64Data, "base64");
      } catch (error) {
        console.warn(
          `[gmail ${this.botId}] Failed to decode attachment ${attachment.filename}`,
          error,
        );
        continue;
      }

      const ingested = await ingestAttachmentForUser({
        source: "gmail",
        ownerUserId: this.ownerUserId,
        ownerUserType: this.ownerUserType,
        maxSizeBytes: GMAIL_MAX_ATTACHMENT_BYTES,
        originalFileName: attachment.filename ?? null,
        mimeTypeHint: attachment.mimeType ?? null,
        sizeHintBytes: attachment.size ?? null,
        contentId: attachment.contentId ?? null,
        downloadAttachment: async () => ({
          data: buffer,
          contentType: attachment.mimeType ?? undefined,
          sizeBytes: buffer.length,
        }),
        logContext: `[gmail ${this.botId}]`,
      });

      if (ingested) {
        collected.push(ingested);
      }
    }

    return collected;
  }

  /**
   * Get attachments from Gmail message by ID
   * TODO: Implement fetching attachment data from Gmail API
   * Currently attachments are extracted but data is not fetched
   */
  private async getAttachmentData(
    messageId: string,
    attachmentId: string,
  ): Promise<string> {
    return this.withGmail(async (gmail) => {
      const response = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachmentId,
      });

      const data = response.data.data;
      if (!data) return "";

      try {
        const padded = data + "=".repeat((4 - (data.length % 4)) % 4);
        return Buffer.from(padded, "base64").toString("base64");
      } catch {
        return "";
      }
    });
  }
}
