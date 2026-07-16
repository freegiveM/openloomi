/**
 * Integration accounts API
 *
 * GET /api/integrations/accounts
 *
 * Local environment: Fetch accounts from cloud and sync to local database
 * Cloud environment: Return account list from cloud database
 */

import type { NextRequest } from "next/server";
import { isTauriMode } from "@/lib/env/constants";
import { authenticateCloudRequest } from "@/lib/auth/cloud-auth";
import { withRateLimit, RateLimitPresets } from "@/lib/rate-limit/middleware";
import { db, weixinBotHasValidContextToken } from "@/lib/db/queries";
import { integrationAccounts, bot } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const DEBUG = process.env.NODE_ENV === "development";

export async function GET(request: NextRequest) {
  // Tauri mode: Forward directly to cloud, let cloud verify Bearer token
  if (isTauriMode()) {
    return handleLocalMode(request);
  }

  // Rate limiting: OAuth preset (20 requests/minute)
  const rateLimitResult = await withRateLimit(request, RateLimitPresets.oauth);

  if (!rateLimitResult.success) {
    return new Response(
      JSON.stringify({
        error: "Too many requests",
        message: "Please try again later",
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Cloud mode: Requires local authentication check
  const user = await authenticateCloudRequest(request);

  if (!user) {
    return new Response(
      JSON.stringify({
        error: "Unauthorized",
        message: "You must be logged in",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Cloud environment: Return account list from cloud database directly
  return handleCloudMode(user);
}

/**
 * Local mode handling: Return account list from local database directly
 */
async function handleLocalMode(request: NextRequest) {
  try {
    const user = await authenticateCloudRequest(request);

    if (!user) {
      return new Response(
        JSON.stringify({
          error: "Unauthorized",
          message: "You must be logged in",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const localUserId = user.id;

    // Return account list from local database (with bot ID via JOIN)
    const localAccounts = await db
      .select({
        id: integrationAccounts.id,
        platform: integrationAccounts.platform,
        externalId: integrationAccounts.externalId,
        displayName: integrationAccounts.displayName,
        status: integrationAccounts.status,
        metadata: integrationAccounts.metadata,
        createdAt: integrationAccounts.createdAt,
        updatedAt: integrationAccounts.updatedAt,
        botId: bot.id,
      })
      .from(integrationAccounts)
      .leftJoin(bot, eq(bot.platformAccountId, integrationAccounts.id))
      .where(eq(integrationAccounts.userId, localUserId));

    // Enhance accounts with hasValidContextToken for WeChat
    const enhancedAccounts = await Promise.all(
      localAccounts.map(
        async (acc: {
          id: string;
          platform: string;
          externalId: string;
          displayName: string;
          status: string;
          metadata: string | null;
          createdAt: Date;
          updatedAt: Date;
          botId: string | null;
        }) => {
          const account: {
            id: string;
            platform: string;
            externalId: string;
            displayName: string;
            status: string;
            metadata: Record<string, unknown> | null;
            createdAt: Date;
            updatedAt: Date;
            botId: string | null;
            hasValidContextToken?: boolean;
          } = {
            ...acc,
            metadata: acc.metadata
              ? typeof acc.metadata === "string"
                ? JSON.parse(acc.metadata)
                : acc.metadata
              : null,
          };

          // For WeChat, check if bot has valid context token
          if (account.platform === "weixin") {
            const hasValidContextToken = await checkWeixinContextToken(
              localUserId,
              acc.id,
            );
            account.hasValidContextToken = hasValidContextToken;
          }

          return account;
        },
      ),
    );

    if (DEBUG) {
      console.log(
        "[Integrations Accounts] Returning local accounts:",
        enhancedAccounts.length,
        [
          ...new Set(
            enhancedAccounts.map((a: { platform: string }) => a.platform),
          ),
        ],
      );
    }

    return new Response(
      JSON.stringify({
        accounts: enhancedAccounts,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("[Integrations Accounts] Failed to fetch accounts:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch accounts" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Check if WeChat account has valid context token
 */
async function checkWeixinContextToken(
  userId: string,
  platformAccountId: string,
): Promise<boolean> {
  try {
    // Find the bot associated with this platform account
    const botRecord = await db
      .select({ id: bot.id })
      .from(bot)
      .where(eq(bot.platformAccountId, platformAccountId))
      .limit(1);

    if (botRecord.length === 0) {
      return false;
    }

    const botId = botRecord[0].id;
    const hasValidToken = await weixinBotHasValidContextToken(userId, botId);
    return hasValidToken;
  } catch (error) {
    console.error(
      "[Integrations Accounts] Failed to check WeChat context token:",
      error,
    );
    return false;
  }
}

/**
 * Cloud mode handling: Return account list from cloud database directly
 */
async function handleCloudMode(user: { id: string }) {
  try {
    // Strip cloud_ prefix if present (authenticateCloudRequest may return prefixed userId)
    const userId = user.id.startsWith("cloud_")
      ? user.id.substring(6)
      : user.id;

    const accounts = await db
      .select({
        id: integrationAccounts.id,
        userId: integrationAccounts.userId,
        platform: integrationAccounts.platform,
        externalId: integrationAccounts.externalId,
        displayName: integrationAccounts.displayName,
        status: integrationAccounts.status,
        metadata: integrationAccounts.metadata,
        credentialsEncrypted: integrationAccounts.credentialsEncrypted,
        createdAt: integrationAccounts.createdAt,
        updatedAt: integrationAccounts.updatedAt,
      })
      .from(integrationAccounts)
      .where(eq(integrationAccounts.userId, userId));

    // Enhance accounts with hasValidContextToken for WeChat
    const enhancedAccounts = await Promise.all(
      accounts.map(
        async (acc: {
          id: string;
          userId: string;
          platform: string;
          externalId: string;
          displayName: string;
          status: string;
          metadata: string | null;
          credentialsEncrypted: string;
          createdAt: Date;
          updatedAt: Date;
        }) => {
          const account = {
            ...acc,
            metadata: acc.metadata
              ? typeof acc.metadata === "string"
                ? JSON.parse(acc.metadata)
                : acc.metadata
              : null,
          };

          // For WeChat, check if bot has valid context token
          if (account.platform === "weixin") {
            const hasValidContextToken = await checkWeixinContextToken(
              userId,
              acc.id,
            );
            (account as any).hasValidContextToken = hasValidContextToken;
          }

          return account;
        },
      ),
    );

    return new Response(
      JSON.stringify({
        accounts: enhancedAccounts,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("[Integrations Accounts] Failed to fetch accounts:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch integration accounts" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
