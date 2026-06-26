import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createUser, getUser } from "@/lib/db/queries";
import { signIn } from "@/app/(auth)/auth";
import { DUMMY_PASSWORD } from "@/lib/env/constants";

/**
 * Create a guest account and sign in automatically.
 * GET /api/auth/guest?redirectUrl=/ -> creates guest, signs in, redirects to redirectUrl
 * POST /api/auth/guest -> same, but uses default redirectUrl
 */
export async function GET(request: Request) {
  return handleGuestAuth(request);
}

export async function POST(request: Request) {
  return handleGuestAuth(request);
}

async function handleGuestAuth(request: Request) {
  try {
    let callbackUrl = "/";

    // GET requests can pass redirectUrl as query param
    if (request.method === "GET") {
      const { searchParams } = new URL(request.url);
      callbackUrl = searchParams.get("redirectUrl") || "/";
    }

    // Only allow same-origin callback URLs to prevent open-redirect attacks.
    try {
      const target = new URL(callbackUrl, request.url);
      const origin = new URL(request.url);
      if (target.origin !== origin.origin) {
        callbackUrl = "/";
      }
    } catch {
      callbackUrl = "/";
    }

    // Generate a unique guest email
    const guestId = `guest-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const guestEmail = `${guestId}@guest.local`;

    // Check if user already exists (shouldn't happen for new guests)
    const existingUsers = await getUser(guestEmail);
    if (existingUsers.length === 0) {
      // Create the guest user
      await createUser(guestEmail, DUMMY_PASSWORD);
    }

    // Sign in as the guest user using credentials provider.
    // With `redirect: false`, signIn writes the session cookies to the
    // `next/headers` cookie store but does NOT attach them to a Response,
    // so we have to forward them onto our redirect response below.
    await signIn("credentials", {
      email: guestEmail,
      password: DUMMY_PASSWORD,
      redirect: false,
    });

    const cookieStore = await cookies();
    const response = NextResponse.redirect(new URL(callbackUrl, request.url));
    // RequestCookie only exposes `name` and `value`, so we can't preserve
    // every attribute from the source cookie. NextAuth's session/CSRF cookies
    // are HttpOnly + SameSite=Lax with path "/" — applying those defaults
    // here is sufficient to keep the session valid after the redirect.
    for (const cookie of cookieStore.getAll()) {
      response.cookies.set({
        name: cookie.name,
        value: cookie.value,
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      });
    }
    return response;
  } catch (error) {
    console.error("[GuestAuth] Error:", error);
    // On error, redirect to home
    return NextResponse.redirect(new URL("/", request.url));
  }
}
