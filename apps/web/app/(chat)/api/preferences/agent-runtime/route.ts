import { NextResponse } from "next/server";
import { z } from "zod";

import { SELECTABLE_AGENT_RUNTIMES } from "@/lib/ai/native-agent/runtime-contract";
import {
  clearAgentRuntimePreference,
  readAgentRuntimePreference,
  writeAgentRuntimePreference,
} from "@/lib/ai/native-agent/runtime-preference";
import { getAgentRuntimeSettings } from "@/lib/ai/native-agent/runtime-settings";
import { getUserLlmProviderConfig } from "@/lib/ai/user-llm-api-settings";
import { getAuthUser } from "@/lib/auth/dual-auth";
import { isTauriMode } from "@/lib/env/constants";

const runtimePreferenceSchema = z
  .object({
    provider: z.enum(SELECTABLE_AGENT_RUNTIMES),
  })
  .strict();

const noStoreHeaders = { "Cache-Control": "no-store" };

async function getRuntimeApiConfiguration(userId: string) {
  const anthropicApiConfigured = Boolean(
    await getUserLlmProviderConfig({
      userId,
      providerType: "anthropic_compatible",
    }),
  );
  return {
    claudeApiConfigured: anthropicApiConfigured,
    hermesApiConfigured: anthropicApiConfigured,
  };
}

export async function GET(request: Request) {
  const user = await getAuthUser(request).catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get("refresh") === "1";
    const apiConfiguration = await getRuntimeApiConfiguration(user.id);
    const settings = await getAgentRuntimeSettings({
      forceRefresh,
      ...apiConfiguration,
    });
    return NextResponse.json(settings, { headers: noStoreHeaders });
  } catch (error) {
    console.error("[Agent Runtime Preferences] Failed to load state", error);
    return NextResponse.json(
      { error: "runtime_state_unavailable" },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  const user = await getAuthUser(request).catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isTauriMode()) {
    return NextResponse.json(
      { error: "runtime_selection_not_editable" },
      { status: 403 },
    );
  }

  const payload = await request.json().catch(() => null);
  const parsed = runtimePreferenceSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_runtime_preference" },
      { status: 400 },
    );
  }

  try {
    let apiConfiguration = await getRuntimeApiConfiguration(user.id);
    let readiness = await getAgentRuntimeSettings({
      forceRefresh: true,
      ...apiConfiguration,
    });

    // The runtime probe can take several seconds. If the user saves or removes
    // the shared API configuration while it is running, remap readiness against
    // the latest setting before persisting the choice.
    if (parsed.data.provider === "claude" || parsed.data.provider === "hermes") {
      const latestApiConfiguration = await getRuntimeApiConfiguration(user.id);
      if (
        latestApiConfiguration.claudeApiConfigured !==
        apiConfiguration.claudeApiConfigured
      ) {
        apiConfiguration = latestApiConfiguration;
        readiness = await getAgentRuntimeSettings(apiConfiguration);
      }
    }

    if (!readiness.runtimes?.[parsed.data.provider].ready) {
      return NextResponse.json(
        { error: "runtime_not_ready", settings: readiness },
        { status: 409, headers: noStoreHeaders },
      );
    }

    writeAgentRuntimePreference(parsed.data.provider);
    const settings = {
      ...readiness,
      preference: parsed.data.provider,
      effective: {
        provider: parsed.data.provider,
        source: "preference" as const,
      },
    };
    return NextResponse.json(settings, { headers: noStoreHeaders });
  } catch (error) {
    console.error("[Agent Runtime Preferences] Failed to save state", error);
    return NextResponse.json(
      { error: "runtime_preference_save_failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  const user = await getAuthUser(request).catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isTauriMode()) {
    return NextResponse.json(
      { error: "runtime_selection_not_editable" },
      { status: 403 },
    );
  }

  try {
    const previousPreference = readAgentRuntimePreference();
    clearAgentRuntimePreference();
    try {
      const apiConfiguration = await getRuntimeApiConfiguration(user.id);
      const settings = await getAgentRuntimeSettings({
        forceRefresh: true,
        ...apiConfiguration,
      });
      return NextResponse.json(settings, { headers: noStoreHeaders });
    } catch (error) {
      // Keep the API result and the on-disk state consistent. A failed refresh
      // must not leave the preference cleared while the UI reports failure.
      if (previousPreference) {
        writeAgentRuntimePreference(previousPreference);
      }
      throw error;
    }
  } catch (error) {
    console.error(
      "[Agent Runtime Preferences] Failed to clear desktop preference",
      error,
    );
    return NextResponse.json(
      { error: "runtime_preference_clear_failed" },
      { status: 500 },
    );
  }
}
