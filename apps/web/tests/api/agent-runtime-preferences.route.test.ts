import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authState = vi.hoisted(() => ({
  user: { id: "user-1" } as object | null,
}));
const modeState = vi.hoisted(() => ({ tauri: true }));
const runtimeState = vi.hoisted(() => ({
  response: {
    editable: true,
    preference: null,
    effective: { provider: "claude", source: "default" },
    platform: "windows",
    runtimes: {
      claude: { ready: true },
      codex: { ready: true },
      opencode: { ready: true },
      hermes: { ready: true },
      openclaw: { ready: true },
    },
  },
  get: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
}));
const llmSettingsState = vi.hoisted(() => ({
  config: undefined as
    | { apiKey: string; baseUrl: string; model: string }
    | undefined,
  get: vi.fn(),
}));

vi.mock("@/lib/auth/dual-auth", () => ({
  getAuthUser: vi.fn(async () => authState.user),
}));

vi.mock("@/lib/env/constants", () => ({
  isTauriMode: vi.fn(() => modeState.tauri),
}));

vi.mock("@/lib/ai/native-agent/runtime-settings", () => ({
  getAgentRuntimeSettings: runtimeState.get,
}));

vi.mock("@/lib/ai/native-agent/runtime-preference", () => ({
  clearAgentRuntimePreference: runtimeState.clear,
  readAgentRuntimePreference: runtimeState.read,
  writeAgentRuntimePreference: runtimeState.write,
}));

vi.mock("@/lib/ai/user-llm-api-settings", () => ({
  getUserLlmProviderConfig: llmSettingsState.get,
}));

const { DELETE, GET, PUT } =
  await import("@/app/(chat)/api/preferences/agent-runtime/route");

function request(method = "GET", body?: unknown, query = "") {
  return new Request(`http://localhost/api/preferences/agent-runtime${query}`, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  authState.user = { id: "user-1" };
  modeState.tauri = true;
  runtimeState.get.mockReset();
  runtimeState.get.mockResolvedValue(runtimeState.response);
  runtimeState.read.mockReset();
  runtimeState.read.mockReturnValue(undefined);
  runtimeState.write.mockReset();
  runtimeState.clear.mockReset();
  llmSettingsState.config = undefined;
  llmSettingsState.get.mockReset();
  llmSettingsState.get.mockImplementation(async () => llmSettingsState.config);
});

describe("agent runtime preferences route", () => {
  test("requires authentication before reading device runtime state", async () => {
    authState.user = null;

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(runtimeState.get).not.toHaveBeenCalled();
  });

  test("loads a safe no-store state and supports an explicit refresh", async () => {
    const response = await GET(request("GET", undefined, "?refresh=1"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(runtimeState.get).toHaveBeenCalledWith({
      forceRefresh: true,
      claudeApiConfigured: false,
      hermesApiConfigured: false,
    });
    expect(await response.json()).toEqual(runtimeState.response);
  });

  test("rejects runtime writes outside the desktop app", async () => {
    modeState.tauri = false;

    const response = await PUT(request("PUT", { provider: "codex" }));

    expect(response.status).toBe(403);
    expect(runtimeState.write).not.toHaveBeenCalled();
  });

  test("strictly accepts only the five supported runtimes", async () => {
    for (const provider of ["opencode", "hermes", "openclaw"]) {
      const response = await PUT(request("PUT", { provider }));
      expect(response.status).toBe(200);
    }
    const unsupported = await PUT(request("PUT", { provider: "unknown" }));
    const extraField = await PUT(
      request("PUT", { provider: "codex", command: "custom" }),
    );

    expect(unsupported.status).toBe(400);
    expect(extraField.status).toBe(400);
    expect(runtimeState.write).toHaveBeenCalledTimes(3);
  });

  test("persists the choice and returns the selected effective state", async () => {
    const savedResponse = {
      ...runtimeState.response,
      preference: "codex",
      effective: { provider: "codex", source: "preference" },
    };
    const response = await PUT(request("PUT", { provider: "codex" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(savedResponse);
    expect(runtimeState.write).toHaveBeenCalledWith("codex");
    expect(runtimeState.get).toHaveBeenCalledOnce();
  });

  test("rechecks Claude API readiness when configuration changes during the probe", async () => {
    const configured = {
      apiKey: "decrypted-key",
      baseUrl: "https://api.example.test",
      model: "claude-test",
    };
    llmSettingsState.get
      .mockResolvedValueOnce(configured)
      .mockResolvedValueOnce(undefined);
    runtimeState.get
      .mockResolvedValueOnce(runtimeState.response)
      .mockResolvedValueOnce({
        ...runtimeState.response,
        runtimes: {
          claude: { ready: false },
          codex: { ready: true },
        },
      });

    const response = await PUT(request("PUT", { provider: "claude" }));

    expect(response.status).toBe(409);
    expect(runtimeState.get).toHaveBeenNthCalledWith(2, {
      claudeApiConfigured: false,
      hermesApiConfigured: false,
    });
    expect(runtimeState.write).not.toHaveBeenCalled();
  });

  test("clears the desktop preference and returns environment/default state", async () => {
    const restoredResponse = {
      ...runtimeState.response,
      preference: null,
      effective: { provider: "opencode", source: "environment" },
    };
    runtimeState.get.mockResolvedValueOnce(restoredResponse);

    const response = await DELETE(request("DELETE"));

    expect(response.status).toBe(200);
    expect(runtimeState.clear).toHaveBeenCalledOnce();
    expect(runtimeState.get).toHaveBeenCalledWith({
      forceRefresh: true,
      claudeApiConfigured: false,
      hermesApiConfigured: false,
    });
    expect(await response.json()).toEqual(restoredResponse);
  });

  test("rejects clearing the desktop preference outside the desktop app", async () => {
    modeState.tauri = false;

    const response = await DELETE(request("DELETE"));

    expect(response.status).toBe(403);
    expect(runtimeState.clear).not.toHaveBeenCalled();
  });

  test("restores the previous preference when reset state cannot be loaded", async () => {
    runtimeState.read.mockReturnValue("codex");
    runtimeState.get.mockRejectedValueOnce(new Error("invalid environment"));

    const response = await DELETE(request("DELETE"));

    expect(response.status).toBe(500);
    expect(runtimeState.clear).toHaveBeenCalledOnce();
    expect(runtimeState.write).toHaveBeenCalledWith("codex");
  });

  test("passes a complete saved API configuration into runtime readiness", async () => {
    llmSettingsState.config = {
      apiKey: "decrypted-key",
      baseUrl: "https://api.example.test",
      model: "claude-test",
    };

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(runtimeState.get).toHaveBeenCalledWith({
      forceRefresh: false,
      claudeApiConfigured: true,
      hermesApiConfigured: true,
    });
  });

  test("does not persist a runtime that fails the server readiness check", async () => {
    runtimeState.get.mockResolvedValueOnce({
      ...runtimeState.response,
      runtimes: {
        claude: { ready: true },
        codex: { ready: false },
      },
    });

    const response = await PUT(request("PUT", { provider: "codex" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "runtime_not_ready" });
    expect(runtimeState.write).not.toHaveBeenCalled();
  });

  test("does not claim success when the atomic preference write fails", async () => {
    runtimeState.write.mockImplementation(() => {
      throw new Error("disk full");
    });

    const response = await PUT(request("PUT", { provider: "claude" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "runtime_preference_save_failed",
    });
    expect(runtimeState.get).toHaveBeenCalledTimes(1);
  });
});
