import { runCodexInstall } from "@/lib/ai/native-agent/codex-install";
import {
  authorizeCodexDesktopRequest,
  codexErrorResponse,
  codexNoStoreHeaders,
} from "../route-helpers";

export async function POST(request: Request) {
  const authorization = await authorizeCodexDesktopRequest(request);
  if (!authorization.authorized) return authorization.response;

  const result = await runCodexInstall().catch(() => ({
    status: "failed" as const,
  }));
  switch (result.status) {
    case "completed":
      return new Response(null, { status: 204, headers: codexNoStoreHeaders });
    case "unsupported":
      return codexErrorResponse("codex_install_unsupported_platform", 400);
    case "powershell_unavailable":
      return codexErrorResponse("codex_install_powershell_unavailable", 409);
    case "verification_failed":
      return codexErrorResponse("codex_install_verification_failed", 409);
    case "timed_out":
      return codexErrorResponse("codex_install_timed_out", 408);
    case "failed":
      return codexErrorResponse("codex_install_failed", 500);
  }
}
