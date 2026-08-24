import { NextResponse } from "next/server";

import { runCodexLogin } from "@/lib/ai/native-agent/codex-login";
import { selectReadyAgentRuntime } from "@/lib/ai/native-agent/runtime-selection";
import {
  authorizeCodexDesktopRequest,
  codexErrorResponse,
  codexNoStoreHeaders,
} from "../route-helpers";

export async function POST(request: Request) {
  const authorization = await authorizeCodexDesktopRequest(request);
  if (!authorization.authorized) return authorization.response;

  const result = await runCodexLogin().catch(() => ({
    status: "failed" as const,
  }));
  switch (result.status) {
    case "completed": {
      try {
        const selection = await selectReadyAgentRuntime(
          authorization.userId,
          "codex",
        );
        if (!selection.selected) {
          return NextResponse.json(
            { error: "runtime_not_ready", settings: selection.settings },
            { status: 409, headers: codexNoStoreHeaders },
          );
        }
        return NextResponse.json(selection.settings, {
          headers: codexNoStoreHeaders,
        });
      } catch {
        return codexErrorResponse("codex_runtime_enable_failed", 500);
      }
    }
    case "unavailable":
      return codexErrorResponse("codex_cli_unavailable", 409);
    case "timed_out":
      return codexErrorResponse("codex_login_timed_out", 408);
    case "failed":
      return codexErrorResponse("codex_login_failed", 500);
  }
}
