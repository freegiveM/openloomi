/**
 * Local user information API
 *
 * Reads/writes the user from the local database. Used by the desktop
 * runtime and plugin bridges as a local auth-handshake probe.
 *
 * The legacy "remote-auth" prefix is historical — these routes are now
 * the canonical local endpoints.
 */

import type { NextRequest } from "next/server";
import { getUserById, updateUserProfile } from "@/lib/db/queries";
import {
  verifyToken,
  extractToken,
  withErrorHandler,
  createSuccessResponse,
  createErrorResponse,
} from "@/lib/auth/remote-auth-utils";

export async function GET(request: NextRequest) {
  return withErrorHandler(async () => {
    const token = extractToken(request);

    if (!token) {
      return createErrorResponse("Unauthorized", 401);
    }

    const result = verifyToken(token);

    if (!result) {
      return createErrorResponse("Invalid token", 401);
    }

    const user = await getUserById(result.id);

    if (!user) {
      return createErrorResponse("User not found", 404);
    }

    return createSuccessResponse({
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    });
  });
}

export async function PUT(request: NextRequest) {
  return withErrorHandler(async () => {
    const token = extractToken(request);

    if (!token) {
      return createErrorResponse("Unauthorized", 401);
    }

    const result = verifyToken(token);

    if (!result) {
      return createErrorResponse("Invalid token", 401);
    }

    const body = await request.json();
    const { name, avatarUrl } = body;

    const updatedUser = await updateUserProfile(result.id, { name, avatarUrl });

    if (!updatedUser) {
      return createErrorResponse("User not found", 404);
    }

    return createSuccessResponse({
      id: updatedUser.id,
      email: updatedUser.email,
      name: updatedUser.name,
      avatarUrl: updatedUser.avatarUrl,
    });
  });
}
