/**
 * Integration account details API
 *
 * GET /api/integrations/[accountId] - Get account details
 * PATCH /api/integrations/[accountId] - Update account
 * DELETE /api/integrations/[accountId] - Delete account
 *
 * Local environment: Directly operate local database
 * Cloud environment: Directly operate local database
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteIntegrationAccount,
  getIntegrationAccountById,
  loadIntegrationCredentials,
  updateIntegrationAccount,
} from "@/lib/db/queries";
import { AppError } from "@openloomi/shared/errors";
import { WhatsAppAdapter } from "@/lib/integrations/whatsapp";
import { WhatsAppBaileysAuthState } from "@/lib/integrations/whatsapp/whatsapp-auth-state";
import { isTauriMode } from "@/lib/env/constants";
import { authenticateCloudRequest } from "@/lib/auth/cloud-auth";
import { withRateLimit, RateLimitPresets } from "@/lib/rate-limit/middleware";

const UpdateIntegrationSchema = z.object({
  metadata: z.record(z.string(), z.unknown()).optional(),
  status: z.string().optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
});

/**
 * GET /api/integrations/[accountId]
 * Get integration account details
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  // Tauri mode: query local database directly (no cloud call needed)
  if (isTauriMode()) {
    const user = await authenticateCloudRequest(request);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized", message: "You must be logged in" },
        { status: 401 },
      );
    }

    try {
      return await handleGetLocal(accountId, user.id);
    } catch (error) {
      if (error instanceof AppError) {
        return error.toResponse();
      }
      console.error("[Integrations] Failed to get account", error);
      return NextResponse.json(
        { error: "Failed to get integration account" },
        { status: 500 },
      );
    }
  }

  // Cloud mode: local authentication check required
  // Rate limit
  const rateLimitResult = await withRateLimit(request, RateLimitPresets.oauth);
  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: "Too many requests", message: "Please try again later" },
      { status: 429 },
    );
  }

  // Authentication check (supports Bearer Token and Session)
  const user = await authenticateCloudRequest(request);

  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized", message: "You must be logged in" },
      { status: 401 },
    );
  }

  try {
    // Cloud version: directly query local database
    return await handleGetLocal(accountId, user.id);
  } catch (error) {
    if (error instanceof AppError) {
      return error.toResponse();
    }
    console.error("[Integrations] Failed to get account", error);
    return NextResponse.json(
      { error: "Failed to get integration account" },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/integrations/[accountId]
 * Update integration account
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  // Tauri mode: update local database directly (no cloud call needed)
  if (isTauriMode()) {
    const user = await authenticateCloudRequest(request);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized", message: "You must be logged in" },
        { status: 401 },
      );
    }

    try {
      const body = await request.json();
      const payload = UpdateIntegrationSchema.parse(body);
      return await handlePatchLocal(accountId, user.id, payload);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return NextResponse.json(
          { error: error.issues.map((item) => item.message).join(", ") },
          { status: 400 },
        );
      }
      if (error instanceof AppError) {
        return error.toResponse();
      }
      console.error("[Integrations] Failed to update account", error);
      return NextResponse.json(
        { error: "Failed to update integration account" },
        { status: 500 },
      );
    }
  }

  // Cloud mode: local authentication check required
  // Rate limit
  const rateLimitResult = await withRateLimit(request, RateLimitPresets.oauth);
  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: "Too many requests", message: "Please try again later" },
      { status: 429 },
    );
  }

  // Authentication check (supports Bearer Token and Session)
  const user = await authenticateCloudRequest(request);

  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized", message: "You must be logged in" },
      { status: 401 },
    );
  }

  try {
    const body = await request.json();
    const payload = UpdateIntegrationSchema.parse(body);

    // Cloud version: directly update local database
    return await handlePatchLocal(accountId, user.id, payload);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues.map((item) => item.message).join(", ") },
        { status: 400 },
      );
    }
    if (error instanceof AppError) {
      return error.toResponse();
    }
    console.error("[Integrations] Failed to update account", error);
    return NextResponse.json(
      { error: "Failed to update integration account" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/integrations/[accountId]
 * Delete integration account
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  // Tauri mode: delete from local only (no cloud call needed)
  if (isTauriMode()) {
    // Authentication check (supports Bearer Token and Session)
    const user = await authenticateCloudRequest(request);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized", message: "You must be logged in" },
        { status: 401 },
      );
    }

    try {
      return await handleDeleteLocal(accountId, user.id);
    } catch (error) {
      if (error instanceof AppError) {
        return error.toResponse();
      }
      console.error(
        `[IntegrationAccounts] Failed to delete account ${accountId} in local mode`,
        error,
      );
      return NextResponse.json(
        { error: "Failed to delete integration account" },
        { status: 500 },
      );
    }
  }

  // Cloud mode: local authentication check required
  // Rate limit
  const rateLimitResult = await withRateLimit(request, RateLimitPresets.oauth);
  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: "Too many requests", message: "Please try again later" },
      { status: 429 },
    );
  }

  // Authentication check (supports Bearer Token and Session)
  const user = await authenticateCloudRequest(request);

  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized", message: "You must be logged in" },
      { status: 401 },
    );
  }

  try {
    // Cloud version: directly delete from local database
    return await handleDeleteLocal(accountId, user.id);
  } catch (error) {
    if (error instanceof AppError) {
      return error.toResponse();
    }
    console.error(
      `[IntegrationAccounts] Failed to delete account ${accountId}`,
      error,
    );
    return NextResponse.json(
      { error: "Failed to delete integration account" },
      { status: 500 },
    );
  }
}

// ============ Cloud mode handler functions (directly operate local database) ============

async function handleGetLocal(accountId: string, userId: string) {
  console.log(
    `[Integrations] Cloud mode: fetching account ${accountId} from local`,
  );

  const account = await getIntegrationAccountById({
    userId,
    platformAccountId: accountId,
  });

  if (!account) {
    return NextResponse.json(
      { error: "Integration account not found" },
      { status: 404 },
    );
  }

  const sanitized = {
    id: account.id,
    platform: account.platform,
    externalId: account.externalId,
    displayName: account.displayName,
    status: account.status,
    metadata: account.metadata ?? null,
    botId: account.bot?.id ?? null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };

  return NextResponse.json({ account: sanitized }, { status: 200 });
}

async function handlePatchLocal(
  accountId: string,
  userId: string,
  payload: z.infer<typeof UpdateIntegrationSchema>,
) {
  console.log(
    `[Integrations] Cloud mode: updating account ${accountId} in local`,
  );

  const account = await getIntegrationAccountById({
    userId,
    platformAccountId: accountId,
  });

  if (!account) {
    return NextResponse.json(
      { error: "Integration account not found" },
      { status: 404 },
    );
  }

  const updated = await updateIntegrationAccount({
    userId,
    platformAccountId: accountId,
    metadata: payload.metadata ?? account.metadata,
    status: payload.status ?? account.status,
    credentials: payload.credentials,
  });

  const sanitized = updated
    ? {
        id: updated.id,
        platform: updated.platform,
        externalId: updated.externalId,
        displayName: updated.displayName,
        status: updated.status,
        metadata: updated.metadata ?? null,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      }
    : null;

  return NextResponse.json({ account: sanitized }, { status: 200 });
}

async function handleDeleteLocal(accountId: string, userId: string) {
  console.log(
    `[Integrations] Local mode: deleting account ${accountId} from local DB`,
  );
  console.log(`[Integrations] Using userId: ${userId}`);

  const existingAccount = await getIntegrationAccountById({
    userId,
    platformAccountId: accountId,
  });

  if (!existingAccount) {
    console.warn(
      `[Integrations] Account not found in local DB: accountId=${accountId}, userId=${userId}`,
    );
    return NextResponse.json(
      { error: "Integration account not found" },
      { status: 404 },
    );
  }

  console.log(
    `[Integrations] Found account in local DB: ${existingAccount.id}, platform=${existingAccount.platform}`,
  );

  // Integration-specific cleanup
  try {
    if (existingAccount.platform === "whatsapp") {
      const credentials = loadIntegrationCredentials<{ sessionKey?: string }>(
        existingAccount,
      );
      const sessionKey =
        credentials?.sessionKey ??
        (credentials as Record<string, string> | undefined)?.WA_CLIENT_ID ??
        null;
      if (sessionKey) {
        // Delete Baileys session from Redis
        const authState = new WhatsAppBaileysAuthState(sessionKey);
        try {
          await authState.clear();
          console.log(
            `[IntegrationAccounts] Deleted WhatsApp session from Redis: ${sessionKey}`,
          );
        } catch (storeError) {
          console.warn(
            "[IntegrationAccounts] Failed to delete WhatsApp session from Redis:",
            storeError,
          );
        }

        // Logout and disconnect Baileys socket
        const adapter = new WhatsAppAdapter({ botId: sessionKey });
        try {
          await adapter.run();
        } catch {
          // Session may already be invalid
        } finally {
          await adapter.kill().catch(() => {});
        }
      }
    }
  } catch (cleanupError) {
    console.warn(
      `[IntegrationAccounts] Cleanup failed for account ${accountId}`,
      cleanupError,
    );
  }

  const result = await deleteIntegrationAccount({
    userId,
    platformAccountId: accountId,
  });

  return NextResponse.json(
    {
      success: Boolean(result.deletedAccountId),
      deletedAccountId: result.deletedAccountId,
      deletedBotIds: result.deletedBots,
    },
    { status: 200 },
  );
}
