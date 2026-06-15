import { ComposioClient } from "@openloomi/integrations/composio";

import { areComposioUserIdsEquivalent } from "@/lib/integrations/composio-oauth";

export type ComposioCallbackStatus = "success" | "error" | "cancelled";

export type ComposioConnectedAccountProfile = {
  externalId: string;
  email: string | null;
  displayName: string | null;
  picture: string | null;
};

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function jsonForInlineScript(value: unknown) {
  const json = JSON.stringify(value);
  if (json === undefined) return "undefined";
  return json.replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return char;
    }
  });
}

export function readComposioCallbackStatus(
  url: URL,
): ComposioCallbackStatus | null {
  const status = (url.searchParams.get("status") ?? "").toLowerCase();
  if (!status) return null;
  if (["success", "active", "connected"].includes(status)) return "success";
  if (["cancelled", "canceled", "access_denied"].includes(status)) {
    return "cancelled";
  }
  return "error";
}

export function readComposioCallbackError(url: URL) {
  return (
    url.searchParams.get("error_description") ??
    url.searchParams.get("error") ??
    url.searchParams.get("message") ??
    null
  );
}

export function readComposioConnectedAccountId(url: URL) {
  const keys = [
    "connected_account_id",
    "connectedAccountId",
    "connection_id",
    "connectionId",
    "account_id",
    "accountId",
  ];
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value) return value;
  }
  return null;
}

export function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function stringFromRecords(
  records: Record<string, unknown>[],
  keys: string[],
) {
  for (const record of records) {
    for (const key of keys) {
      const value = stringOrNull(record[key]);
      if (value) return value;
    }
  }
  return null;
}

export function stringOrNull(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function fetchGoogleCalendarUserEmailViaProxy(
  connectedAccountId: string,
  logContext: string,
): Promise<{ email: string | null; displayName: string | null }> {
  try {
    const data = await new ComposioClient().proxy<{
      items?: Array<{
        id?: string;
        summary?: string;
        primary?: boolean;
      }>;
    }>({
      connectedAccountId,
      method: "GET",
      endpoint:
        "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=5&minAccessRole=reader",
    });
    const primary = data.items?.find((c) => c.primary) ?? data.items?.[0];
    return {
      email: stringOrNull(primary?.id),
      displayName: stringOrNull(primary?.summary),
    };
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to fetch Google Calendar user email via proxy`,
      error,
    );
    return { email: null, displayName: null };
  }
}

export async function loadComposioConnectedAccountProfile({
  connectedAccountId,
  expectedUserId,
  logContext,
}: {
  connectedAccountId: string;
  expectedUserId: string;
  logContext: string;
}): Promise<ComposioConnectedAccountProfile> {
  try {
    const account = await new ComposioClient().getConnectedAccount(
      connectedAccountId,
    );
    const accountUserId =
      stringOrNull(account.client_unique_user_id) ??
      stringOrNull(account.user_id);

    if (
      accountUserId &&
      !areComposioUserIdsEquivalent(accountUserId, expectedUserId)
    ) {
      throw new Error(
        "Composio connected account does not belong to this user.",
      );
    }

    const candidates = [
      account.connection_data,
      account.data,
      account.account,
      account.profile,
    ].filter(Boolean) as Record<string, unknown>[];
    return {
      externalId:
        stringFromRecords(candidates, ["id", "sub", "external_id"]) ??
        account.client_unique_user_id ??
        account.user_id ??
        account.id ??
        connectedAccountId,
      email: stringFromRecords(candidates, ["email", "mail", "user_email"]),
      displayName: stringFromRecords(candidates, [
        "name",
        "display_name",
        "displayName",
      ]),
      picture: stringFromRecords(candidates, ["picture", "avatar_url"]),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "Composio connected account does not belong to this user."
    ) {
      throw error;
    }

    console.warn(
      `[${logContext}] Failed to load Composio account profile`,
      error,
    );
    return {
      externalId: connectedAccountId,
      email: null,
      displayName: null,
      picture: null,
    };
  }
}
