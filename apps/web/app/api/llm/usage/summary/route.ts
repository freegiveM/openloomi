/**
 * GET /api/llm/usage/summary
 *
 * Returns the cumulative native-agent token usage for the authenticated
 * user since they first configured an LLM provider. Designed for the
 * LOOMI Online card.
 *
 * Status semantics:
 * - 401 when no authenticated user (mirrors `/api/native/agent`).
 * - 200 with `configured: false` when the user has no enabled provider.
 * - 200 with `configured: true` and zero totals when the user has a
 *   provider but no usage has been recorded yet.
 * - 200 with `error: "usage_unavailable"` when the usage file could not
 *   be read; the card renders its error state without breaking other
 *   functionality.
 */

import { NextResponse } from "next/server";

import { auth } from "@/app/(auth)/auth";
import { getAuthUser } from "@/lib/auth/dual-auth";
import { getUserLlmProviderEarliestEnabledSince } from "@/lib/db/queries";
import { getUserUsageSummary } from "@/lib/llm-usage/summary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const authUser = await getAuthUser(req);
  if (!authUser?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Mirror the `webSession` path used by `/api/native/agent` so the
  // summary endpoint reports the same identity as the SSE caller.
  await auth().catch(() => null);

  try {
    const providerContext = await getUserLlmProviderEarliestEnabledSince(
      authUser.id,
    );

    const summary = await getUserUsageSummary(authUser.id, providerContext);
    return NextResponse.json(summary);
  } catch (error) {
    console.error("[llm-usage/summary] unexpected error:", error);
    return NextResponse.json(
      {
        error: "usage_unavailable",
        message:
          error instanceof Error ? error.message : "Unexpected server error",
      },
      { status: 200 },
    );
  }
}
