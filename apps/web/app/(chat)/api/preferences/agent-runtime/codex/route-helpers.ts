import { NextResponse } from "next/server";

import { getAuthUser } from "@/lib/auth/dual-auth";
import { verifyToken } from "@/lib/auth/remote-auth-utils";
import { isTauriMode } from "@/lib/env/constants";

export const codexNoStoreHeaders = { "Cache-Control": "no-store" };
const DESKTOP_REQUEST_HEADER = "OpenLoomiDesktop";

export async function authorizeCodexDesktopRequest(
  request: Request,
): Promise<
  | { authorized: true; userId: string }
  | { authorized: false; response: NextResponse }
> {
  const authorization = request.headers.get("authorization");
  let verifiedUserId: string | null = null;
  if (authorization !== null) {
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";
    const verifiedToken = token ? verifyToken(token) : null;
    if (!verifiedToken) {
      return {
        authorized: false,
        response: codexErrorResponse("unauthorized", 401),
      };
    }
    verifiedUserId = verifiedToken.id;
  }

  const user = await getAuthUser(request).catch(() => null);
  if (!user || (verifiedUserId && user.id !== verifiedUserId)) {
    return {
      authorized: false,
      response: codexErrorResponse("unauthorized", 401),
    };
  }
  if (!isTauriMode()) {
    return {
      authorized: false,
      response: codexErrorResponse("codex_setup_desktop_only", 403),
    };
  }
  if (request.headers.get("x-requested-with") !== DESKTOP_REQUEST_HEADER) {
    return {
      authorized: false,
      response: codexErrorResponse("invalid_desktop_request", 403),
    };
  }

  return { authorized: true, userId: user.id };
}

export function codexErrorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: codexNoStoreHeaders });
}
