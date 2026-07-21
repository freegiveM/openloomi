import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authState = vi.hoisted(() => ({
  user: { id: "user-1", type: "regular" } as {
    id: string;
    type: string;
  } | null,
}));

vi.mock("@/app/(auth)/auth", () => ({
  auth: async () => (authState.user ? { user: authState.user } : null),
}));

const queryMocks = vi.hoisted(() => ({
  getUserEmbeddingSetting: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => queryMocks);

import { GET } from "@/app/(chat)/api/preferences/embeddings/route";

const ENV_KEYS = [
  "EMBEDDING_PROVIDER",
  "OPENROUTER_API_KEY",
  "LOCAL_EMBEDDING_MODEL",
  "LOCAL_EMBEDDING_DEVICE",
  "LOCAL_EMBEDDING_LOCAL_ONLY",
];

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
}

describe("GET /api/preferences/embeddings — systemDefaults shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEnv();
    authState.user = { id: "user-1", type: "regular" };
    queryMocks.getUserEmbeddingSetting.mockResolvedValue(null);
  });

  afterEach(() => {
    clearEnv();
  });

  it("returns configuredProvider=null and cloud.ready=false when no env and no setting", async () => {
    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.setting).toBeNull();
    expect(body.systemDefaults).toMatchObject({
      configuredProvider: null,
      cloud: {
        hasApiKey: false,
        ready: false,
        baseUrl: "https://openrouter.ai/api/v1",
        model: "text-embedding-3-small",
      },
      local: {
        model: "Xenova/all-MiniLM-L6-v2",
        device: "cpu",
        localFilesOnly: false,
        ready: true,
      },
    });
  });

  it("returns configuredProvider='cloud' and cloud.ready=true when OPENROUTER_API_KEY is set", async () => {
    process.env.OPENROUTER_API_KEY = "sk-system-key";

    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.systemDefaults.configuredProvider).toBe("cloud");
    expect(body.systemDefaults.cloud.ready).toBe(true);
    expect(body.systemDefaults.cloud.hasApiKey).toBe(true);
    // Local provider is still considered ready (no credentials required).
    expect(body.systemDefaults.local.ready).toBe(true);
  });

  it("returns configuredProvider='local' when EMBEDDING_PROVIDER=local", async () => {
    process.env.EMBEDDING_PROVIDER = "local";

    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.systemDefaults.configuredProvider).toBe("local");
    expect(body.systemDefaults.cloud.ready).toBe(false);
    expect(body.systemDefaults.cloud.hasApiKey).toBe(false);
    expect(body.systemDefaults.local.ready).toBe(true);
  });

  it("returns 401 when no session", async () => {
    authState.user = null;
    const response = await GET();
    expect(response.status).toBe(401);
  });
});
