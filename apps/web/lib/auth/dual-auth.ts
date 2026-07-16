/**
 * Dual auth utility functions
 * Supports both Session Cookie (Web) and Bearer Token (Tauri)
 *
 * OpenLoomi is open source and self-hosted, so user identity always comes
 * from the local token signature + local DB. No cloud round-trip.
 */

import { auth } from "@/app/(auth)/auth";
import { getUserIdFromToken, isTokenValid } from "./token-manager";

export interface AuthUser {
  id: string;
  email?: string | null;
  name?: string | null;
  type?: string | null;
}

/**
 * Check if is shadow user (legacy `cloud_` prefix carried over from the
 * Tauri guest identity). Kept for backward-compat reads; we no longer
 * derive identity from a remote service.
 */
function isShadowUser(userId: string): boolean {
  return userId.startsWith("cloud_");
}

/**
 * Get authenticated user from request
 * Priority:
 * 1. Bearer Token (Tauri local) - verify signature, hydrate from local DB
 * 2. Session Cookie (Web)
 */
export async function getAuthUser(request: Request): Promise<AuthUser | null> {
  // 1. Try to get Bearer token from Authorization header first (Tauri local)
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    if (isTokenValid(token)) {
      const userId = getUserIdFromToken(token);
      if (userId) {
        try {
          const { getUserById } = await import("@/lib/db/queries");
          const localUser = await getUserById(userId);
          if (localUser) {
            return {
              id: localUser.id,
              email: localUser.email,
              name: localUser.name,
            };
          }
        } catch (error) {
          console.error("[DualAuth] Failed to get user from local DB:", error);
        }
        // Token is valid but the local user row is missing — surface the
        // id so the caller can decide; never fall back to a remote service.
        return { id: userId };
      }
    }
  }

  // 2. If no Bearer token, try Session (Web)
  const session = await auth();
  if (session?.user?.id) {
    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      type: session.user.type,
    };
  }

  return null;
}

/**
 * Verify if request is authenticated
 */
export async function isAuthenticated(request: Request): Promise<boolean> {
  const user = await getAuthUser(request);
  return user !== null;
}

// Keep the helper exported for tests / external callers; it no longer
// affects getAuthUser behavior.
export { isShadowUser };
