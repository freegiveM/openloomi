import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authState = vi.hoisted(() => ({
  session: { user: { id: "user-1" } } as { user: { id: string } } | null,
}));

vi.mock("@/app/(auth)/auth", () => ({
  auth: vi.fn(async () => authState.session),
}));

vi.mock("@/lib/env/constants", () => ({
  isTauriMode: vi.fn(() => true),
}));

const providerState = vi.hoisted(() => ({
  defaultAgent: "claude",
}));

vi.mock("@/lib/ai/native-agent/provider-env", () => ({
  getConfiguredDefaultAgentProvider: vi.fn(() => providerState.defaultAgent),
}));

const nativeProbe = vi.hoisted(() => ({
  probe: vi.fn(),
}));

vi.mock("@/lib/ai/native-agent/runtime-probe", () => ({
  probeNativeClaudeRuntime: nativeProbe.probe,
}));

const dbState = vi.hoisted(() => ({
  settings: [] as unknown[],
  getWithKey: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({
  getUserLlmApiSettings: vi.fn(async () => dbState.settings),
  getUserLlmApiSettingWithApiKey: dbState.getWithKey,
  upsertUserLlmApiSetting: dbState.upsert,
  deleteUserLlmApiSetting: dbState.remove,
}));

vi.mock("@/lib/loop/connectors", () => ({
  clearProbeCooldown: vi.fn(),
  refreshConnectors: vi.fn(async () => undefined),
}));

const { GET, PUT, POST } =
  await import("@/app/(chat)/api/preferences/ai/route");

beforeEach(() => {
  authState.session = { user: { id: "user-1" } };
  providerState.defaultAgent = "claude";
  dbState.settings = [
    {
      providerId: "openai_compatible",
      providerType: "openai_compatible",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      enabled: true,
    },
  ];
  nativeProbe.probe.mockReset();
  dbState.getWithKey.mockReset().mockResolvedValue(null);
  dbState.upsert.mockReset();
  dbState.remove.mockReset();
  nativeProbe.probe.mockResolvedValue({
    checked: true,
    available: true,
    authenticated: true,
    active: true,
    ready: true,
    reason: "CLAUDE_CLI_AUTHENTICATED",
    defaultAgent: "claude",
    cliPathPresent: true,
    cliPathSource: "PATH",
    versionPresent: true,
    probes: {},
  });
});

describe("provider settings writes and tests", () => {
  test("persists provider identity separately from its transport", async () => {
    dbState.upsert.mockResolvedValue({
      providerId: "gemini",
      providerType: "openai_compatible",
      enabled: true,
      hasApiKey: true,
    });

    const response = await PUT(
      new Request("http://localhost/api/preferences/ai", {
        method: "PUT",
        body: JSON.stringify({
          providerId: "gemini",
          apiKey: "gemini-key",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          model: "gemini-2.5-flash",
          enabled: true,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(dbState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        providerId: "gemini",
        providerType: "openai_compatible",
      }),
    );
  });

  test("tests Gemini without inserting an extra /v1 path segment", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const response = await POST(
      new Request("http://localhost/api/preferences/ai", {
        method: "POST",
        body: JSON.stringify({
          providerId: "gemini",
          apiKey: "gemini-key",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          model: "gemini-2.5-flash",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      expect.any(Object),
    );
    fetchMock.mockRestore();
  });

  test("allows keyless Ollama provider tests", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const response = await POST(
      new Request("http://localhost/api/preferences/ai", {
        method: "POST",
        body: JSON.stringify({
          providerId: "ollama",
          baseUrl: "http://localhost:11434/v1",
          model: "llama3.2",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    fetchMock.mockRestore();
  });

  test("fills omitted test fields from provider environment and defaults", async () => {
    const previousApiKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "environment-key";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    try {
      const response = await POST(
        new Request("http://localhost/api/preferences/ai", {
          method: "POST",
          body: JSON.stringify({ providerId: "deepseek" }),
        }),
      );

      expect(response.status).toBe(200);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.deepseek.com/chat/completions");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer environment-key",
      );
      expect(JSON.parse(init?.body as string).model).toBe("deepseek-chat");
    } finally {
      fetchMock.mockRestore();
      if (previousApiKey === undefined) {
        // biome-ignore lint/performance/noDelete: process.env must be restored, not assigned the string "undefined"
        delete process.env.DEEPSEEK_API_KEY;
      } else process.env.DEEPSEEK_API_KEY = previousApiKey;
    }
  });
});

describe("GET /api/preferences/ai", () => {
  test("returns saved settings when the default Claude runtime probe fails", async () => {
    nativeProbe.probe.mockRejectedValue(new Error("probe failed"));

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.defaultAgent).toBe("claude");
    expect(body.nativeRuntime).toBeNull();
    expect(body.settings).toEqual(dbState.settings);
  });

  test("keeps Claude as the default preferred runtime when probe succeeds", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.defaultAgent).toBe("claude");
    expect(body.nativeRuntime.ready).toBe(true);
    expect(nativeProbe.probe).toHaveBeenCalledTimes(1);
  });

  test("does not probe Claude when an alternate native agent is configured", async () => {
    providerState.defaultAgent = "codex";

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.defaultAgent).toBe("codex");
    expect(body.nativeRuntime).toBeNull();
    expect(nativeProbe.probe).not.toHaveBeenCalled();
  });
});
