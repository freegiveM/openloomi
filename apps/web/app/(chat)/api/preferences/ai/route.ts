import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import {
  deleteUserLlmApiSetting,
  getUserLlmApiSettingWithApiKey,
  getUserLlmApiSettings,
  upsertUserLlmApiSetting,
} from "@/lib/db/queries";
import { isTauriMode } from "@/lib/env/constants";
import { getConfiguredDefaultAgentProvider } from "@/lib/ai/native-agent/provider-env";
import {
  probeNativeClaudeRuntime,
  type NativeRuntimeProbe,
} from "@/lib/ai/native-agent/runtime-probe";
import { AppError } from "@melandlabs/shared/errors";
import { generateText } from "ai";
import {
  buildAnthropicMessagesUrl,
  buildOpenAiChatCompletionsUrl,
  getLlmProviderDefinition,
  LLM_PROVIDER_CATALOG,
  LLM_PROVIDER_IDS,
  resolveEnvironmentLlmProviderConfig,
} from "@/lib/ai/llm-providers";
import { createLlmLanguageModel } from "@/lib/ai/provider-model";

const providerIdSchema = z.enum(LLM_PROVIDER_IDS);

const llmApiSettingSchema = z.object({
  providerId: providerIdSchema,
  apiKey: z.string().max(4096).nullable().optional(),
  baseUrl: z.string().max(2048).nullable().optional(),
  model: z.string().max(256).nullable().optional(),
  region: z.string().max(128).nullable().optional(),
  enabled: z.boolean().optional(),
});

const llmApiTestSchema = llmApiSettingSchema.pick({
  providerId: true,
  apiKey: true,
  baseUrl: true,
  model: true,
  region: true,
});

// Settings are primary, while provider-specific environment variables remain
// available for headless deployments and can fill fields omitted by a saved
// row. Native agent runtime readiness is reported separately below.
const environmentProvider = (() => {
  try {
    return resolveEnvironmentLlmProviderConfig();
  } catch {
    return undefined;
  }
})();

const systemDefaults = Object.fromEntries(
  LLM_PROVIDER_IDS.map((providerId) => {
    const definition = LLM_PROVIDER_CATALOG[providerId];
    return [
      providerId,
      {
        baseUrl: definition.defaultBaseUrl,
        model: definition.defaultModel,
        region: definition.defaultRegion,
        hasApiKey: Boolean(
          definition.apiKeyEnv && process.env[definition.apiKeyEnv],
        ),
        configured: environmentProvider?.providerId === providerId,
      },
    ];
  }),
);

function normalizeOptionalString(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function readProviderError(response: Response) {
  const text = await response.text().catch(() => "");
  return text.trim().slice(0, 400);
}

async function testOpenAiCompatibleProvider({
  baseUrl,
  apiKey,
  model,
}: {
  baseUrl: string;
  apiKey?: string;
  model: string;
}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(buildOpenAiChatCompletionsUrl(baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const detail = await readProviderError(response);
    throw new Error(
      detail || `Provider returned HTTP ${response.status.toString()}`,
    );
  }
}

async function testAnthropicCompatibleProvider({
  baseUrl,
  apiKey,
  model,
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
}) {
  const response = await fetch(buildAnthropicMessagesUrl(baseUrl), {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const detail = await readProviderError(response);
    throw new Error(
      detail || `Provider returned HTTP ${response.status.toString()}`,
    );
  }
}

async function testBedrockProvider({
  providerId,
  apiKey,
  model,
  region,
}: {
  providerId: "bedrock";
  apiKey?: string;
  model: string;
  region: string;
}) {
  await generateText({
    model: createLlmLanguageModel({
      providerId,
      providerType: "bedrock",
      apiKey,
      model,
      region,
    }),
    prompt: "ping",
    maxOutputTokens: 1,
    abortSignal: AbortSignal.timeout(15_000),
  });
}

function invalidPayloadResponse() {
  return new AppError(
    "bad_request:api",
    "Invalid AI API settings payload",
  ).toResponse();
}

async function probeDefaultNativeRuntime(
  defaultAgent: string,
): Promise<NativeRuntimeProbe | null> {
  if (defaultAgent !== "claude") {
    return null;
  }

  try {
    return await probeNativeClaudeRuntime();
  } catch (error) {
    console.warn("[AI Preferences] Native Claude runtime probe failed", error);
    return null;
  }
}

export async function GET() {
  const session = await auth().catch(() => null);
  if (!session?.user?.id && !isTauriMode()) {
    return new AppError("unauthorized:chat").toResponse();
  }

  // `nativeRuntime` is the runtime's source of truth for "can the user talk
  // to Claude right now" — derived from a server-side probe of the user's
  // local `claude` CLI auth, not from `process.env.ANTHROPIC_*`. The plugin
  // and the GUI use this field to decide whether the user needs to run
  // `claude auth login` or configure a custom endpoint.
  const defaultAgent = getConfiguredDefaultAgentProvider();
  const nativeRuntime = await probeDefaultNativeRuntime(defaultAgent);

  // Tauri mode may reach this handler before the user has finished guest
  // login (the pet card webview is a separate origin from the main webview
  // and shares no cookie jar). `defaultAgent` is the server's resolved agent
  // runtime (e.g. `claude`, `codex`); clients skip the anthropic-key gate
  // entirely when it isn't `claude`, since providers like codex/opencode/
  // hermes/openclaw bring their own auth.
  if (!session?.user?.id) {
    return NextResponse.json({
      settings: [],
      systemDefaults,
      defaultAgent,
      nativeRuntime,
    });
  }

  try {
    const settings = await getUserLlmApiSettings(session.user.id);
    return NextResponse.json({
      settings,
      systemDefaults,
      defaultAgent,
      nativeRuntime,
    });
  } catch (error) {
    console.error("[AI Preferences] Failed to load settings", error);
    if (error instanceof AppError) {
      return error.toResponse();
    }
    return new AppError(
      "bad_request:database",
      "Unable to load AI API settings",
    ).toResponse();
  }
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return new AppError("unauthorized:chat").toResponse();
  }

  const rawPayload = await request.json().catch((error) => {
    console.error("[AI Preferences] Invalid JSON", error);
    return null;
  });

  if (!rawPayload) {
    return invalidPayloadResponse();
  }

  const parsed = llmApiSettingSchema.safeParse(rawPayload);
  if (!parsed.success) {
    console.error("[AI Preferences] Invalid payload", parsed.error.flatten());
    return invalidPayloadResponse();
  }

  try {
    const setting = await upsertUserLlmApiSetting({
      userId: session.user.id,
      providerType: getLlmProviderDefinition(parsed.data.providerId).transport,
      ...parsed.data,
    });

    // Save was the moment the user expressed intent: "I want Loomi to
    // start working with this provider". Kick off a *real* connector
    // probe in the background (non-silent → 6-minute budget) so the
    // next Loomi Online card open sees a populated cache instead of
    // the FALLBACK sentinel. The `silent` path the card auto-uses on
    // open is bounded to 6s, which is too tight for a cold first
    // probe (composio surface discovery + 5 toolkits; real tail is
    // 60–90s, can stretch past 2 min on a fresh install). Without
    // this fire-and-forget the user lands on the card and sees
    // "Awaiting first probe" gray pills until the 30s cooldown
    // window expires AND they reopen the card. Fire-and-forget so
    // the PUT response stays snappy; the user already saw the
    // success toast and can navigate to the card whenever.
    //
    // We also clear any stale `probeCooldownUntil` marker on the
    // disk cache so the card's next silent probe (if it fires
    // before the background one lands) isn't short-circuited by a
    // cooldown from a prior timeout.
    try {
      const { clearProbeCooldown, refreshConnectors } =
        await import("@/lib/loop/connectors");
      clearProbeCooldown();
      void refreshConnectors().catch((probeErr) => {
        console.warn(
          "[AI Preferences] background connector probe failed:",
          probeErr,
        );
      });
    } catch (importErr) {
      // If the dynamic import fails (loop module not available in this
      // route's runtime — shouldn't happen, but defensively swallow)
      // we still want the save to succeed; the user can trigger a
      // manual refresh from the card.
      console.warn(
        "[AI Preferences] could not import loop/connectors for background probe:",
        importErr,
      );
    }

    return NextResponse.json({ setting });
  } catch (error) {
    console.error("[AI Preferences] Failed to save settings", error);
    if (error instanceof AppError) {
      return error.toResponse();
    }
    return new AppError(
      "bad_request:database",
      "Unable to save AI API settings",
    ).toResponse();
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return new AppError("unauthorized:chat").toResponse();
  }

  const rawPayload = await request.json().catch((error) => {
    console.error("[AI Preferences] Invalid test JSON", error);
    return null;
  });

  if (!rawPayload) {
    return invalidPayloadResponse();
  }

  const parsed = llmApiTestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    console.error(
      "[AI Preferences] Invalid test payload",
      parsed.error.flatten(),
    );
    return invalidPayloadResponse();
  }

  try {
    const { providerId } = parsed.data;
    const definition = getLlmProviderDefinition(providerId);
    const saved = await getUserLlmApiSettingWithApiKey({
      userId: session.user.id,
      providerId,
    });
    const apiKey =
      normalizeOptionalString(parsed.data.apiKey) ??
      saved?.apiKey ??
      (definition.apiKeyEnv
        ? process.env[definition.apiKeyEnv]?.trim()
        : undefined);
    const baseUrl =
      normalizeOptionalString(parsed.data.baseUrl) ??
      saved?.baseUrl ??
      (definition.baseUrlEnv
        ? process.env[definition.baseUrlEnv]?.trim()
        : undefined) ??
      definition.defaultBaseUrl;
    const model =
      normalizeOptionalString(parsed.data.model) ??
      saved?.model ??
      process.env[definition.modelEnv]?.trim() ??
      definition.defaultModel;
    const region =
      normalizeOptionalString(parsed.data.region) ??
      saved?.region ??
      (definition.regionEnv
        ? process.env[definition.regionEnv]?.trim()
        : undefined) ??
      (providerId === "bedrock"
        ? process.env.AWS_DEFAULT_REGION?.trim()
        : undefined) ??
      definition.defaultRegion;

    if (
      !model ||
      (definition.apiKeyRequired && !apiKey) ||
      (definition.transport !== "bedrock" && !baseUrl) ||
      (definition.transport === "bedrock" && !region)
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "Missing required provider configuration.",
        },
        { status: 400 },
      );
    }

    if (definition.transport === "bedrock") {
      await testBedrockProvider({
        providerId: "bedrock",
        apiKey: apiKey ?? undefined,
        model,
        region: region as string,
      });
    } else if (definition.transport === "anthropic_compatible") {
      await testAnthropicCompatibleProvider({
        baseUrl: baseUrl as string,
        apiKey: apiKey as string,
        model,
      });
    } else {
      await testOpenAiCompatibleProvider({
        baseUrl: baseUrl as string,
        apiKey: apiKey ?? undefined,
        model,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[AI Preferences] Provider test failed", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Provider test failed.",
      },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return new AppError("unauthorized:chat").toResponse();
  }

  const { searchParams } = new URL(request.url);
  const parsedProviderId = providerIdSchema.safeParse(
    searchParams.get("providerId") ?? searchParams.get("providerType"),
  );

  if (!parsedProviderId.success) {
    return invalidPayloadResponse();
  }

  try {
    await deleteUserLlmApiSetting({
      userId: session.user.id,
      providerId: parsedProviderId.data,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[AI Preferences] Failed to delete settings", error);
    if (error instanceof AppError) {
      return error.toResponse();
    }
    return new AppError(
      "bad_request:database",
      "Unable to delete AI API settings",
    ).toResponse();
  }
}
