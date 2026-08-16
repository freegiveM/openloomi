import { after, NextResponse } from "next/server";

import type { AgentGoalRecoverySessionsResponse } from "@/lib/ai/runtime-instructions/api/contracts";
import { readAgentGoalRecoveryPresentations } from "@/lib/ai/runtime-instructions/recovery/presentation-read-model";
import type { BetterSqlite3ClientSource } from "@/lib/ai/runtime-instructions/persistence/sqlite/transaction";
import { getDbInstance } from "@/lib/db/shared/helpers";
import { isTauriMode } from "@/lib/env/constants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

type RecoveryStartupGlobal = typeof globalThis & {
  __openLoomiGoalRecoveryScheduled?: boolean;
};

function scheduleGoalRuntimeRecovery(): void {
  const processGlobal = globalThis as RecoveryStartupGlobal;
  if (processGlobal.__openLoomiGoalRecoveryScheduled) return;
  processGlobal.__openLoomiGoalRecoveryScheduled = true;

  after(async () => {
    try {
      const { startAgentGoalRuntimeRecovery } =
        await import("@/lib/ai/runtime-instructions/recovery/startup");
      const report = await startAgentGoalRuntimeRecovery();
      if (report.scanned > 0) {
        const resumed = report.outcomes.filter(
          (entry) => entry.status === "resumed",
        ).length;
        const failed = report.outcomes.filter(
          (entry) => entry.status === "failed",
        ).length;
        console.log(
          `[Agent Goal Recovery] scanned=${report.scanned} resumed=${resumed} failed=${failed}`,
        );
      }
    } catch (error) {
      processGlobal.__openLoomiGoalRecoveryScheduled = false;
      console.warn("[Agent Goal Recovery] Startup failed:", error);
    }
  });
}

/**
 * Minimal, owner-scoped read model used to reconnect the desktop chat UI to a
 * Goal Runtime that the server is recovering after process restart.
 */
export async function GET(request: Request) {
  const ownerId = await authenticatedOwnerId(request);
  if (!ownerId) return apiError("unauthorized", 401);
  if (!isTauriMode()) return apiError("goal_runtime_unavailable", 503);

  scheduleGoalRuntimeRecovery();

  try {
    const sessions = readAgentGoalRecoveryPresentations(
      getDbInstance() as unknown as BetterSqlite3ClientSource,
      ownerId,
    );
    return NextResponse.json<AgentGoalRecoverySessionsResponse>(
      { sessions },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[Agent Goal Recovery] Presentation read failed", error);
    return apiError("goal_runtime_error", 500);
  }
}

async function authenticatedOwnerId(request: Request): Promise<string | null> {
  // Authentication is intentionally lazy: the normal Goal auth module also
  // serves web routes and imports the broad legacy DB query facade. Keeping it
  // out of this route's synchronous graph lets the desktop read model compile
  // independently while preserving the existing cookie/Bearer semantics.
  const { getAuthUser } = await import("@/lib/auth/dual-auth");
  const user = await getAuthUser(request).catch(() => null);
  return user?.id ?? null;
}

function apiError(code: string, status: number): NextResponse {
  return NextResponse.json(
    { error: code, code },
    { status, headers: NO_STORE_HEADERS },
  );
}
