import { NextResponse } from "next/server";
import { z } from "zod";

import { writeAgentRuntimePreference } from "@/lib/ai/native-agent/runtime-preference";
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
    const claudeApiConfigured = await hasUsableClaudeApiConfiguration(user.id);
    const readiness = await getAgentRuntimeSettings({
      forceRefresh: true,
      claudeApiConfigured,
    });
    if (!readiness.runtimes?.[parsed.data.provider].ready) {
      return NextResponse.json(
        { error: "runtime_not_ready", settings: readiness },
        { status: 409, headers: noStoreHeaders },
      );
    }

    writeAgentRuntimePreference(parsed.data.provider);
    const settings = await getAgentRuntimeSettings({ claudeApiConfigured });
    return NextResponse.json(settings, { headers: noStoreHeaders });
  } catch (error) {
    console.error("[Agent Runtime Preferences] Failed to save state", error);
    return NextResponse.json(
      { error: "runtime_preference_save_failed" },
      { status: 500 },
    );
  }
}
