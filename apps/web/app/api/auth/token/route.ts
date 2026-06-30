/**
 * Issue Auth Token API
 *
 * Returns a freshly signed JWT for the currently authenticated NextAuth session.
 *
 * Used by the client-side `TokenSync` component to keep
 * `~/.openloomi/token` in sync without forcing the user to re-login.
 *
 * GET /api/auth/token -> { token: string }
 *   401 if no valid session
 *   500 if AUTH_SECRET is missing or token signing fails
 */

import { NextResponse } from "next/server";

import { auth } from "@/app/(auth)/auth";
import { generateToken } from "@/lib/auth/remote-auth-utils";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;
    const email = session.user.email ?? "";

    const token = generateToken(userId, email);
    return NextResponse.json({ token });
  } catch (error) {
    console.error("[AuthToken] Failed to issue token:", error);
    return NextResponse.json(
      { error: "failed_to_issue_token" },
      { status: 500 },
    );
  }
}
