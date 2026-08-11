/**
 * Native Agent API Routes
 *
 * Provides API endpoints for agent execution over HTTP/SSE.
 */

import type { NativeAgentMemoryContextDiagnostic } from "@openloomi/ai/agent/native-runner";
import type { AgentMessage } from "@openloomi/ai/agent/types";
import type { MemoryApplicabilityContext } from "@openloomi/memory-consolidation/graph-contracts";
import type { Session } from "next-auth";
import type { NextRequest } from "next/server";

import { appendFileSync as _appendFileSync } from "node:fs";
import { auth } from "@/app/(auth)/auth";
import { resolveNativeAgentProviderRequest } from "@/lib/ai/native-agent/provider-env";
import {
  type AuthenticatedNativeAgentSession,
  type NativeAgentRequest,
  NativeAgentRequestError,
  runNativeAgentRequest,
} from "@/lib/ai/native-agent/runner";
import { type AuthUser, getAuthUser } from "@/lib/auth/dual-auth";
import { getChatById } from "@/lib/db/queries";
import { recordUsage } from "@/lib/llm-usage/recorder";

// Set max duration for long-running agent tasks.
// This prevents "TypeError: Load failed" when tool calls take a long time.
// NOTE: Vercel has hard limits (Hobby: 10s, Pro: 800s).
export const maxDuration = 800;

// Server-only probe: writes lines into a fixed file so we can inspect SSE
// behaviour even when the OpenLoomi tauri:dev console isn't reachable.
// Path is hard-coded (matches HANDOVER_2026-08-07.md §3.2) so it's
// greppable on every host. Remove this block once the SSE flushing bug
// is fixed.
const PROBE_PATH = "D:/openloomi3/openloomi/agent_api_probe.log";
const probeLog = (line: string) => {
  try {
    _appendFileSync(PROBE_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* best-effort */
  }
};
// Touch the file at import time so the user can see we have write access.
try {
  _appendFileSync(
    PROBE_PATH,
    `[${new Date().toISOString()}] [AgentAPI_PROBE] route.ts module loaded\n`,
  );
} catch {
  /* ignore */
}

// Always run as a Node.js route handler and disable any caching layer. SSE
// must stream frame-by-frame; Next.js's default route handler can otherwise
// buffer the entire response before flushing (especially under the turbopack
// dev server used by `pnpm tauri:dev`). Forcing runtime + dynamic is the
// minimal change that lets `controller.enqueue(...)` push each SSE frame to
// the client as soon as the OpenLoomi EventBus yields a message.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolves a stable providerType slug from the request body. Today the only
 * tracking-eligible provider is the Anthropic-compatible path ("claude"),
 * but `body.provider` is the contract — anything else becomes "unknown"
 * so the recorder still writes the row with provider metadata intact.
 */
function resolveProviderType(body: NativeAgentRequest): string {
  if (body.provider === "claude") {
    return "anthropic_compatible";
  }
  return typeof body.provider === "string" && body.provider.trim().length > 0
    ? body.provider
    : "unknown";
}

// Helper to create SSE stream with heartbeat to keep connection alive.
// SSE heartbeat sends a comment every 30 seconds to prevent idle timeouts
// from proxies, load balancers, and browsers.
function createSSEStream(
  generator: AsyncGenerator<AgentMessage>,
  options?: {
    onClose?: () => void;
    onUsage?: (message: AgentMessage) => void;
  },
) {
  const encoder = new TextEncoder();
  const HEARTBEAT_INTERVAL_MS = 30000;
  const { onClose, onUsage } = options ?? {};
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let finalized = false;

  const clearHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    clearHeartbeat();
    onClose?.();
    console.log("[AgentAPI] ===== CHAT COMPLETE =====");
  };

  return new ReadableStream({
    start(controller) {
      let controllerClosed = false;
      let probeEventCount = 0;
      probeLog(
        `SSE start(controller) entered; generatorSymbol=${typeof generator[Symbol.asyncIterator] === "function" ? "fn" : "?"}`,
      );

      heartbeatTimer = setInterval(() => {
        if (controllerClosed) {
          clearHeartbeat();
          return;
        }
        try {
          probeLog(`heartbeat-tick`);
          // SSE comments are ignored by clients but keep the connection hot.
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          clearHeartbeat();
        }
      }, HEARTBEAT_INTERVAL_MS);

      void (async () => {
        try {
          probeLog(`for-await loop entered`);
          for await (const message of generator) {
            probeEventCount += 1;
            probeLog(
              `for-await got message #${probeEventCount} type=${message?.type ?? "?"} keys=${message ? Object.keys(message).join(",") : "null"}`,
            );
            if (controllerClosed) break;
            const data = `data: ${JSON.stringify(message)}\n\n`;
            try {
              probeLog(
                `#${probeEventCount} calling controller.enqueue(${data.length}B)`,
              );
              controller.enqueue(encoder.encode(data));
              probeLog(
                `#${probeEventCount} controller.enqueue returned`,
              );
            } catch (enqueueError) {
              probeLog(
                `#${probeEventCount} controller.enqueue THREW: ${enqueueError}`,
              );
              // Controller already closed, stop processing
              break;
            }
            // Fire usage instrumentation AFTER the byte is enqueued so a slow
            // disk write can never push the SSE frame out.
            onUsage?.(message);

            // Close stream after result message to signal completion
            if (message.type === "result") {
              probeLog("Result message received, closing stream...");
              break;
            }
          }
          probeLog(
            `for-await loop exited; total messages seen=${probeEventCount}`,
          );
        } catch (error) {
          probeLog(
            `for-await THREW: name=${error instanceof Error ? error.name : "?"} msg=${error instanceof Error ? error.message : String(error)} stack=${error instanceof Error ? (error.stack ?? "").split("\n").slice(0,3).join(" | ") : "n/a"}`,
          );
          console.error("[AgentAPI] Generator error:", {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            name: error instanceof Error ? error.name : String(error),
          });
          const errorData = `data: ${JSON.stringify({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          })}\n\n`;
          try {
            if (!controllerClosed) {
              controller.enqueue(encoder.encode(errorData));
            }
          } catch {}
        } finally {
          controllerClosed = true;
          clearHeartbeat();
          try {
            controller.close();
          } catch {}
          finalize();
        }
      })();
    },
    async cancel() {
      clearHeartbeat();
      // Abort the provider before awaiting generator.return(); an async
      // generator blocked in a child process cannot process return otherwise.
      finalize();
      await generator.return(undefined);
    },
  });
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function createSseHeaders(
  memoryContext: NativeAgentMemoryContextDiagnostic,
): Headers {
  const headers = new Headers(SSE_HEADERS);
  headers.set("X-OpenLoomi-Memory-Context-Status", memoryContext.status);
  headers.set(
    "X-OpenLoomi-Memory-Context-Reasons",
    memoryContext.reasonCodes.join(",").slice(0, 512),
  );
  headers.set(
    "X-OpenLoomi-Memory-Context-Source-Count",
    String(memoryContext.sourceCount),
  );
  if (memoryContext.requestedMode) {
    headers.set(
      "X-OpenLoomi-Memory-Retrieval-Mode",
      memoryContext.requestedMode,
    );
  }
  if (memoryContext.appliedMode) {
    headers.set(
      "X-OpenLoomi-Memory-Retrieval-Applied-Mode",
      memoryContext.appliedMode,
    );
  }
  headers.set(
    "X-OpenLoomi-Memory-Context-Materialized-Node-Count",
    String(memoryContext.materializedNodeIds?.length ?? 0),
  );
  headers.set(
    "X-OpenLoomi-Memory-Context-Provenance-Count",
    String(memoryContext.provenance?.length ?? 0),
  );
  return headers;
}

// Bearer-token callers, such as the one-shot CLI, do not have a full NextAuth
// session object. Business tools still expect session.user.id/type, so provide
// the smallest compatible shape here.
function createSessionFromAuthUser(
  authUser: AuthUser,
): AuthenticatedNativeAgentSession {
  return {
    user: {
      id: authUser.id,
      email: authUser.email ?? undefined,
      name: authUser.name ?? undefined,
      type: (authUser.type ?? "regular") as Session["user"]["type"],
    },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  } as AuthenticatedNativeAgentSession;
}

async function resolveTrustedApplicabilityContexts(input: {
  sessionId: unknown;
  userId: string;
}): Promise<MemoryApplicabilityContext[]> {
  const sessionId =
    typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  if (!sessionId) return [];

  try {
    const selectedChat = await getChatById({ id: sessionId });
    if (!selectedChat || selectedChat.userId !== input.userId) return [];
    return [
      { scope: "conversation", key: selectedChat.id },
      { scope: "task", key: selectedChat.id },
    ];
  } catch {
    // The authenticated owner relationship could not be established.
    return [];
  }
}

async function rejectsForeignClaudeSession(input: {
  sessionId: unknown;
  userId: string;
}): Promise<boolean> {
  const sessionId =
    typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  if (!sessionId) return false;
  const selectedChat = await getChatById({ id: sessionId });
  // A newly-created chat can race its asynchronous initial save. Missing is
  // therefore allowed, but an existing chat owned by somebody else is not.
  return selectedChat !== undefined && selectedChat.userId !== input.userId;
}

// POST /api/native/agent - Run agent.
export async function POST(req: NextRequest) {
  const abortController = new AbortController();

  try {
    const rawBodyText = await req.text();
    let body: NativeAgentRequest;
    try {
      body = JSON.parse(rawBodyText) as NativeAgentRequest;
    } catch (parseError) {
      console.error(
        "[AgentAPI] ERROR: Failed to parse request body:",
        parseError,
        rawBodyText,
      );
      return Response.json(
        { error: "Invalid JSON in request body" },
        { status: 400 },
      );
    }

    // Authenticate with Bearer token first, then fall back to session cookies.
    const authUser = await getAuthUser(req);
    if (!authUser?.id) {
      console.error("[AgentAPI] ERROR: Unauthorized access attempt");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Preserve the full NextAuth session for web requests; Bearer-token
    // requests get a minimal compatible session for business tools.
    const webSession = await auth();
    const session: AuthenticatedNativeAgentSession =
      webSession?.user?.id === authUser.id
        ? (webSession as AuthenticatedNativeAgentSession)
        : createSessionFromAuthUser(authUser);
    const requestPlatform = body.platform?.trim();
    if (requestPlatform) {
      // Let CLI and other scripted callers identify their source to downstream
      // business tools without changing the web session contract.
      session.platform = requestPlatform;
    }

    const resolvedProviderBody = resolveNativeAgentProviderRequest(body);
    if (
      resolvedProviderBody.provider === "claude" &&
      (await rejectsForeignClaudeSession({
        sessionId: body.sessionId,
        userId: authUser.id,
      }))
    ) {
      return Response.json({ error: "Runtime Session not found" }, { status: 404 });
    }
    const applicabilityContexts = await resolveTrustedApplicabilityContexts({
      sessionId: body.sessionId,
      userId: authUser.id,
    });
    const run = await runNativeAgentRequest(resolvedProviderBody, {
      session,
      userId: authUser.id,
      abortController,
      applicabilityContexts,
    });
    const abortFromRequest = () => {
      if (!abortController.signal.aborted) {
        abortController.abort(req.signal.reason);
      }
    };
    req.signal.addEventListener("abort", abortFromRequest, { once: true });
    if (req.signal.aborted) {
      abortFromRequest();
    }

    // Usage metadata captured once per request — derived from the parsed
    // body so we don't need to re-resolve provider settings here. The
    // recorder is the source of truth; the SSE loop never blocks on it.
    const usageContext = {
      userId: authUser.id,
      providerType: resolveProviderType(resolvedProviderBody),
      model:
        typeof resolvedProviderBody.modelConfig?.model === "string" &&
        resolvedProviderBody.modelConfig.model.trim().length > 0
          ? resolvedProviderBody.modelConfig.model.trim()
          : null,
      endpoint: "native-agent",
      runId: body.sessionId ?? null,
    } as const;

    const readable = createSSEStream(run.generator, {
      onClose: () => {
        req.signal.removeEventListener("abort", abortFromRequest);
        if (run.shouldAbortOnClose()) {
          abortController.abort();
        }
      },
      onUsage: (message) => {
        if (message.type !== "result") return;
        const usage = message.usage;
        if (
          !usage ||
          typeof usage.inputTokens !== "number" ||
          typeof usage.outputTokens !== "number"
        ) {
          return;
        }
        // Fire and forget — recordUsage has its own try/catch and per-
        // user serialization, and the SSE stream must not be affected.
        void recordUsage({
          ...usageContext,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      },
    });

    return new Response(readable, {
      headers: createSseHeaders(run.memoryContext),
    });
  } catch (error) {
    console.error("[AgentAPI] Error:", error);

    if (error instanceof NativeAgentRequestError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 },
    );
  }
}
