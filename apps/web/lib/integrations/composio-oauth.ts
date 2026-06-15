import { randomUUID } from "node:crypto";

import { encryptToken } from "@openloomi/security/token-encryption";
import {
  COMPOSIO_GOOGLE_CALENDAR_TOOLKIT,
  COMPOSIO_GOOGLE_MEET_TOOLKIT,
  ComposioClient,
  type ComposioConnectLink,
} from "@openloomi/integrations/composio";

export const COMPOSIO_OAUTH_PROVIDER = "composio";
export type ComposioConnectorPlatform = "google_calendar" | "google_meet";

// "tauri": link minted for the desktop app; the OAuth popup opens in the
// system browser whose cookie session is unrelated to the app session, so the
// callback must take identity from this encrypted state instead of the
// browser session. "web": minted by a signed-in browser session; the callback
// must verify the session user matches the state user (CSRF defense).
export type ComposioOAuthFlow = "tauri" | "web";

export type ComposioOAuthStatePayload = {
  userId: string;
  ts: number;
  nonce: string;
  returnTo?: string;
  connectorPendingId?: string;
  provider?: typeof COMPOSIO_OAUTH_PROVIDER;
  platform?: ComposioConnectorPlatform;
  composioAuthConfigId?: string;
  flow?: ComposioOAuthFlow;
};

export type ComposioAuthorizationLink = {
  authorizationUrl: string;
  state: string;
  redirectUri: string;
  authConfigId: string;
  connectedAccountId?: string | null;
};

export function stripComposioCloudUserPrefix(userId: string) {
  return userId.replace(/^(cloud_)+/, "");
}

export function toTauriComposioUserId(userId: string) {
  return `cloud_${stripComposioCloudUserPrefix(userId)}`;
}

export function areComposioUserIdsEquivalent(left: string, right: string) {
  return (
    stripComposioCloudUserPrefix(left) === stripComposioCloudUserPrefix(right)
  );
}

// Tauri-minted states are exempt from the session-vs-state user comparison in
// callbacks; keep the flow check in one place so the exemption can't drift
// between connectors.
export function isTauriComposioFlow(
  statePayload: Pick<ComposioOAuthStatePayload, "flow">,
) {
  return statePayload.flow === "tauri";
}

// Resolve the user a Composio OAuth callback should bind to. Tauri-minted
// states complete in the system browser, whose cookie session is unrelated to
// the app session that started the flow (it may be signed out or signed into
// another account), so identity comes from the encrypted state itself,
// mirroring the HubSpot/Notion connectors. Web-minted states bind to the
// signed-in browser session; callers must still verify it matches the state
// user (CSRF defense). `isTauri` is the server's own mode: local Tauri
// servers store users with the cloud_ prefix, the cloud stores raw ids.
export function resolveComposioCallbackUserId({
  statePayload,
  sessionUserId,
  isTauri,
}: {
  statePayload: ComposioOAuthStatePayload;
  sessionUserId: string | null | undefined;
  isTauri: boolean;
}): string | null {
  if (isTauriComposioFlow(statePayload)) {
    return isTauri
      ? toTauriComposioUserId(statePayload.userId)
      : stripComposioCloudUserPrefix(statePayload.userId);
  }
  return (
    sessionUserId ??
    (isTauri ? toTauriComposioUserId(statePayload.userId) : null)
  );
}

type BuildComposioLinkInput = {
  userId: string;
  baseUrl: string;
  flow: ComposioOAuthFlow;
  connectorPendingId?: string;
  returnTo?: string;
  client?: ComposioClient;
};

export async function buildComposioCalendarAuthorizationLink(
  input: BuildComposioLinkInput,
): Promise<ComposioAuthorizationLink> {
  return buildComposioAuthorizationLink({
    ...input,
    platform: "google_calendar",
    toolkitSlug: COMPOSIO_GOOGLE_CALENDAR_TOOLKIT,
    callbackPath: "/api/google-calendar/callback",
  });
}

export async function buildComposioMeetAuthorizationLink(
  input: BuildComposioLinkInput,
): Promise<ComposioAuthorizationLink> {
  return buildComposioAuthorizationLink({
    ...input,
    platform: "google_meet",
    toolkitSlug: COMPOSIO_GOOGLE_MEET_TOOLKIT,
    callbackPath: "/api/google-meet/callback",
  });
}

async function buildComposioAuthorizationLink(
  input: BuildComposioLinkInput & {
    platform: ComposioConnectorPlatform;
    toolkitSlug:
      | typeof COMPOSIO_GOOGLE_CALENDAR_TOOLKIT
      | typeof COMPOSIO_GOOGLE_MEET_TOOLKIT;
    callbackPath: string;
  },
): Promise<ComposioAuthorizationLink> {
  const client = input.client ?? new ComposioClient();
  const authConfigId = await client.resolveAuthConfigId(input.toolkitSlug);

  const state = encryptToken(
    JSON.stringify({
      userId: input.userId,
      nonce: randomUUID(),
      ts: Date.now(),
      returnTo: input.returnTo ?? `${input.baseUrl}/?page=profile`,
      connectorPendingId: input.connectorPendingId,
      provider: COMPOSIO_OAUTH_PROVIDER,
      platform: input.platform,
      composioAuthConfigId: authConfigId,
      flow: input.flow,
    } satisfies ComposioOAuthStatePayload),
  );
  const redirectUri = buildCallbackUrl(
    input.baseUrl,
    input.callbackPath,
    state,
  );
  const link: ComposioConnectLink = await client.createConnectLink({
    toolkitSlug: input.toolkitSlug,
    userId: input.userId,
    callbackUrl: redirectUri,
    authConfigId,
  });

  return {
    authorizationUrl: link.redirectUrl,
    state,
    redirectUri,
    authConfigId,
    connectedAccountId: link.connectedAccountId,
  };
}

function buildCallbackUrl(
  baseUrl: string,
  callbackPath: string,
  state: string,
) {
  const url = new URL(`${baseUrl}${callbackPath}`);
  url.searchParams.set("state", state);
  return url.toString();
}
