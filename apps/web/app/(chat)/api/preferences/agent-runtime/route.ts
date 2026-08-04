import { NextResponse } from "next/server";
import { z } from "zod";

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
    provider: z.enum(["claude", "codex"]),
  })
  .strict();

const noStoreHeaders = { "Cache-Control": "no-store" };

async function hasUsableClaudeApiConfiguration(userId: string) {
  return Boolean(
    await getUserLlmProviderConfig({
      userId,
      providerType: "anthropic_compatible",
    }),
  );
}

export async function GET(request: Request) {
  const user = await getAuthUser(request).catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get("refresh") === "1";
    const claudeApiConfigured = await hasUsableClaudeApiConfiguration(user.id);
    const settings = await getAgentRuntimeSettings({
      forceRefresh,
      claudeApiConfigured,
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
    let claudeApiConfigured = await hasUsableClaudeApiConfiguration(user.id);
    let readiness = await getAgentRuntimeSettings({
      forceRefresh: true,
      claudeApiConfigured,
    });

    // The runtime probe can take several seconds. If the user saves or removes
    // the Claude API configuration while it is running, remap readiness against
    // the latest setting before persisting the choice.
    if (parsed.data.provider === "claude") {
      const latestClaudeApiConfigured = await hasUsableClaudeApiConfiguration(
        user.id,
      );
      if (latestClaudeApiConfigured !== claudeApiConfigured) {
        claudeApiConfigured = latestClaudeApiConfigured;
        readiness = await getAgentRuntimeSettings({ claudeApiConfigured });
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
      const claudeApiConfigured = await hasUsableClaudeApiConfiguration(
        user.id,
      );
      const settings = await getAgentRuntimeSettings({
        forceRefresh: true,
        claudeApiConfigured,
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
