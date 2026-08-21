/**
 * AI Request Context Helper
 *
 * Used to set AI Provider user context in API routes
 * Supports extracting cloud authentication token from request body or Authorization header.
 *
 * Re-exports core context functions from @melandlabs/ai and adds app-specific helpers.
 */

import type { UserType } from "@melandlabs/contracts/user-type";
import { NextRequest } from "next/server";
import { setAIUserContext } from "@melandlabs/ai";
import { setActiveLlmProviderConfig } from "@/lib/ai/provider-model";
import { getActiveUserLlmProviderConfig } from "@/lib/ai/user-llm-api-settings";

export {
  setAIUserContext,
  clearAIUserContext,
  getAIUserContext,
} from "@melandlabs/ai";
export type { AIUserContext } from "@melandlabs/ai";

/**
 * Extract cloud authentication token from request
 * Priority: body.cloudAuthToken > Authorization Bearer header
 */
export function extractCloudAuthToken(
  request: NextRequest | Request,
  body?: any,
): string | undefined {
  if (body?.cloudAuthToken) {
    return body.cloudAuthToken;
  }

  let authHeader: string | null;
  if (request instanceof NextRequest) {
    authHeader = request.headers.get("authorization");
  } else {
    authHeader = request.headers.get("Authorization");
  }

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    if (token) {
      return token;
    }
  }

  return undefined;
}

/**
 * Set AI user context (extract token from request)
 */
export async function setAIUserContextFromRequest({
  userId,
  email,
  name,
  userType,
  request,
  body,
}: {
  userId: string;
  email: string;
  name: string | null;
  userType: UserType;
  request: NextRequest | Request;
  body?: any;
}): Promise<void> {
  const token = extractCloudAuthToken(request, body);

  const activeProvider = await getActiveUserLlmProviderConfig(userId);
  setActiveLlmProviderConfig(activeProvider ?? null);

  // Keep the published package context populated for legacy consumers. The
  // app-local model factory above is authoritative for provider identities
  // added after the currently published @melandlabs/ai version.
  const openaiCompatible =
    activeProvider?.providerType === "openai_compatible" &&
    activeProvider.apiKey &&
    activeProvider.baseUrl
      ? {
          apiKey: activeProvider.apiKey,
          baseUrl: activeProvider.baseUrl,
          model: activeProvider.model,
        }
      : undefined;
  const anthropicCompatible =
    activeProvider?.providerType === "anthropic_compatible" &&
    activeProvider.apiKey &&
    activeProvider.baseUrl
      ? {
          apiKey: activeProvider.apiKey,
          baseUrl: activeProvider.baseUrl,
          model: activeProvider.model,
        }
      : undefined;

  setAIUserContext({
    id: userId,
    email: email || "",
    name: name || null,
    type: userType,
    token,
    llmApiSettings:
      openaiCompatible || anthropicCompatible
        ? {
            ...(openaiCompatible && { openaiCompatible }),
            ...(anthropicCompatible && { anthropicCompatible }),
          }
        : undefined,
  });
}
