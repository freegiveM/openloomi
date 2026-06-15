import type { GoogleCalendarStoredCredentials } from "@openloomi/integrations/calendar";
import type { ComposioCredentials } from "@openloomi/integrations/composio";

import {
  createBot,
  getIntegrationAccountByPlatform,
  getIntegrationAccountsByUserId,
  upsertIntegrationAccount,
  updateBot,
} from "@/lib/db/queries";
import {
  fetchGoogleCalendarUserEmailViaProxy,
  loadComposioConnectedAccountProfile,
  normalizeMetadata,
  readStringArray,
  stringOrNull,
  type ComposioConnectedAccountProfile,
} from "@/lib/integrations/composio-callback";

type FinalizeConnectionInput = {
  userId: string;
  connectedAccountId: string;
  authConfigId?: string;
};

type GoogleConnectionConfig<TMetadata extends Record<string, unknown>> = {
  platform: "google_calendar" | "google_meet";
  defaultDisplayName: string;
  botAdapter: "google_calendar" | "google_meet";
  botDescription: string;
  buildMetadata: (input: {
    previousMetadata: Record<string, unknown>;
    profile: ComposioConnectedAccountProfile;
    displayName: string;
    connectedAccountId: string;
    authConfigId?: string;
  }) => TMetadata;
  buildCredentials: (input: {
    userId: string;
    connectedAccountId: string;
    authConfigId?: string;
  }) => Record<string, unknown>;
  buildAdapterConfig: (metadata: TMetadata) => Record<string, unknown>;
};

export async function finalizeComposioCalendarConnection(
  input: FinalizeConnectionInput,
) {
  await finalizeComposioGoogleConnection({
    ...input,
    config: calendarConnectionConfig,
  });
}

export async function finalizeComposioMeetConnection(
  input: FinalizeConnectionInput,
) {
  await finalizeComposioGoogleConnection({
    ...input,
    config: meetConnectionConfig,
  });
}

async function finalizeComposioGoogleConnection<
  TMetadata extends Record<string, unknown>,
>({
  userId,
  connectedAccountId,
  authConfigId,
  config,
}: FinalizeConnectionInput & {
  config: GoogleConnectionConfig<TMetadata>;
}) {
  const existingAccount = await getIntegrationAccountByPlatform({
    userId,
    platform: config.platform,
  });
  const previousMetadata = normalizeMetadata(existingAccount?.metadata);
  let profile = await loadComposioConnectedAccountProfile({
    connectedAccountId,
    expectedUserId: userId,
    logContext: config.platform,
  });
  if (!profile.email) {
    const calendarUser = await fetchGoogleCalendarUserEmailViaProxy(
      connectedAccountId,
      config.platform,
    );
    if (calendarUser.email) {
      profile = {
        ...profile,
        email: calendarUser.email,
        displayName: profile.displayName ?? calendarUser.displayName,
      };
    }
  }
  const displayName =
    profile.displayName ??
    profile.email ??
    stringOrNull(previousMetadata.displayName) ??
    config.defaultDisplayName;
  const externalId =
    existingAccount?.externalId ??
    profile.externalId ??
    profile.email ??
    connectedAccountId;
  const metadata = config.buildMetadata({
    previousMetadata,
    profile,
    displayName,
    connectedAccountId,
    authConfigId,
  });

  const account = await upsertIntegrationAccount({
    userId,
    platform: config.platform,
    externalId,
    displayName,
    credentials: config.buildCredentials({
      userId,
      connectedAccountId,
      authConfigId,
    }),
    metadata,
    status: "active",
  });

  const existingAccounts = await getIntegrationAccountsByUserId({ userId });
  const associatedBot = existingAccounts.find(
    (item) => item.id === account.id,
  )?.bot;
  const adapterConfig = config.buildAdapterConfig(metadata);
  const botName = `${config.defaultDisplayName} · ${displayName}`;

  if (associatedBot) {
    await updateBot(associatedBot.id, {
      name: associatedBot.name ?? botName,
      description: associatedBot.description ?? config.botDescription,
      adapter: config.botAdapter,
      adapterConfig,
      enable: true,
    });
  } else {
    await createBot({
      name: botName,
      description: config.botDescription,
      adapter: config.botAdapter,
      adapterConfig,
      enable: true,
      userId,
      platformAccountId: account.id,
    });
  }
}

const calendarConnectionConfig: GoogleConnectionConfig<
  Record<string, unknown> & {
    calendarIds: string[];
    timeZone: string | null;
  }
> = {
  platform: "google_calendar",
  defaultDisplayName: "Google Calendar",
  botAdapter: "google_calendar",
  botDescription: "Automatically created through Google Calendar authorization",
  buildMetadata({
    previousMetadata,
    profile,
    displayName,
    connectedAccountId,
    authConfigId,
  }) {
    const calendarIds = readStringArray(previousMetadata.calendarIds);
    return {
      email: profile.email ?? stringOrNull(previousMetadata.email),
      picture: profile.picture ?? stringOrNull(previousMetadata.picture),
      displayName,
      calendarIds: calendarIds.length > 0 ? calendarIds : ["primary"],
      calendars: Array.isArray(previousMetadata.calendars)
        ? previousMetadata.calendars
        : [
            {
              id: "primary",
              summary: "Primary",
              primary: true,
              timeZone: null,
            },
          ],
      timeZone: stringOrNull(previousMetadata.timeZone),
      feedEnabled:
        typeof previousMetadata.feedEnabled === "boolean"
          ? previousMetadata.feedEnabled
          : true,
      authProvider: "composio",
      composio: {
        connectedAccountId,
        authConfigId: authConfigId ?? null,
      },
    };
  },
  buildCredentials({ userId, connectedAccountId, authConfigId }) {
    return {
      provider: "composio",
      composioConnectedAccountId: connectedAccountId,
      composioCalendarAuthConfigId: authConfigId ?? null,
      composioUserId: userId,
      accessToken: null,
      refreshToken: null,
      scope: null,
      tokenType: null,
      expiryDate: null,
    } satisfies GoogleCalendarStoredCredentials;
  },
  buildAdapterConfig(metadata) {
    return {
      calendarIds: metadata.calendarIds,
      timeZone: metadata.timeZone ?? null,
    };
  },
};

const meetConnectionConfig: GoogleConnectionConfig<Record<string, unknown>> = {
  platform: "google_meet",
  defaultDisplayName: "Google Meet",
  botAdapter: "google_meet",
  botDescription: "Automatically created through Google Meet authorization",
  buildMetadata({
    previousMetadata,
    profile,
    displayName,
    connectedAccountId,
    authConfigId,
  }) {
    return {
      email: profile.email ?? stringOrNull(previousMetadata.email),
      picture: profile.picture ?? stringOrNull(previousMetadata.picture),
      displayName,
      feedEnabled:
        typeof previousMetadata.feedEnabled === "boolean"
          ? previousMetadata.feedEnabled
          : true,
      authProvider: "composio",
      composio: {
        connectedAccountId,
        authConfigId: authConfigId ?? null,
      },
    };
  },
  buildCredentials({ userId, connectedAccountId, authConfigId }) {
    return {
      provider: "composio",
      composioConnectedAccountId: connectedAccountId,
      composioAuthConfigId: authConfigId ?? null,
      composioUserId: userId,
    } satisfies ComposioCredentials;
  },
  buildAdapterConfig() {
    return {};
  },
};
