/**
 * Local user information API
 *
 * Reads/writes the user from the local database. Used by the desktop
 * runtime and plugin bridges as a local auth-handshake probe.
 *
 * Both methods authenticate via `authenticateCloudRequest`, which
 * transparently handles Bearer tokens (local / Tauri bridges) and
 * NextAuth session cookies (Web GUI) — same model as the cloud sync
 * surface. GET returns a stub user with `authenticated: false` when
 * no credentials are present so unauthenticated probes (the bridge's
 * port-discovery ping, health checks, etc.) get a clean 200. PUT still
 * requires authentication because updating a user profile is
 * destructive.
 *
 * The legacy "remote-auth" prefix is historical — these routes are now
 * the canonical local endpoints.
 */

import type { NextRequest } from "next/server";
import { authenticateCloudRequest } from "@/lib/auth/cloud-auth";
import { updateUserProfile } from "@/lib/db/queries";
import {
  withErrorHandler,
  createSuccessResponse,
  createErrorResponse,
} from "@/lib/auth/remote-auth-utils";

export async function GET(request: NextRequest) {
  return withErrorHandler(async () => {
    // `authenticateCloudRequest` tries Bearer token first (local / Tauri
    // bridges) and falls back to NextAuth session cookie (Web GUI). When
    // neither is present, return a stub user so unauthenticated probes
    // (e.g. the bridge's port-discovery ping) get 200 instead of a
    // misleading 401. The `authenticated: false` flag lets real consumers
    // still tell "no user" apart from "logged in".
    const user = await authenticateCloudRequest(request);

    if (!user) {
      return createSuccessResponse({
        id: null,
        email: null,
        name: null,
        avatarUrl: null,
        authenticated: false,
      });
    }

    return createSuccessResponse({
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      authenticated: true,
    });
  });
}

export async function PUT(request: NextRequest) {
  return withErrorHandler(async () => {
    // PUT still requires authentication (destructive op) but accepts
    // either Bearer token or session cookie via the shared helper.
    const user = await authenticateCloudRequest(request);

    if (!user) {
      return createErrorResponse("Unauthorized", 401);
    }

    const body = await request.json();
    const { name, avatarUrl } = body;

    const updatedUser = await updateUserProfile(user.id, { name, avatarUrl });

    if (!updatedUser) {
      return createErrorResponse("User not found", 404);
    }

    return createSuccessResponse({
      id: updatedUser.id,
      email: updatedUser.email,
      name: updatedUser.name,
      avatarUrl: updatedUser.avatarUrl,
      authenticated: true,
    });
  });
}
