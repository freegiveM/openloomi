import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CloudEmbeddingProvider,
  getConfiguredEmbeddingModelName,
  getConfiguredEmbeddingProvider,
} from "@melandlabs/ai-rag/embedding-provider";

describe("embedding provider configuration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses an explicit local user configuration instead of environment defaults", () => {
    const provider = getConfiguredEmbeddingProvider({
      providerType: "local",
      local: {
        modelName: "local/custom-model",
        device: "cpu",
        localFilesOnly: true,
      },
    });

    // Phase 6 — npm `@melandlabs/ai-rag/embedding-provider` inlines its own
    // copy of the `LocalTransformersEmbeddingProvider` class instead of
    // importing it from `./local-transformers-embedding-provider`, so the
    // `instanceof` check across separate exports fails even though the
    // structural shape is identical. Assert via duck typing on the
    // public surface this contract guarantees.
    expect(provider).toBeDefined();
    expect(typeof provider.getModelName).toBe("function");
    expect(provider.getModelName()).toBe("local/custom-model");
    expect(
      getConfiguredEmbeddingModelName({
        providerType: "local",
        local: { modelName: "local/custom-model" },
      }),
    ).toBe("local/custom-model");
  });

  it("uses explicit cloud credentials, endpoint, and model", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = getConfiguredEmbeddingProvider({
      providerType: "cloud",
      cloud: {
        apiKey: "user-key",
        baseURL: "https://embedding.example.test/v1/",
        modelName: "embedding-user-model",
      },
    });

    expect(provider).toBeInstanceOf(CloudEmbeddingProvider);
    await expect(provider.embedQuery("hello")).resolves.toEqual([
      0.1, 0.2, 0.3,
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://embedding.example.test/v1/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer user-key",
        }),
        body: JSON.stringify({
          model: "embedding-user-model",
          input: ["hello"],
        }),
      }),
    );
  });
});
