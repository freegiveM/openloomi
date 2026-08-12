import { beforeEach, describe, expect, it, vi } from "vitest";

const transformersMocks = vi.hoisted(() => {
  const extractor = vi.fn(async (texts: string | string[]) => {
    const items = Array.isArray(texts) ? texts : [texts];
    return {
      tolist: () => items.map((text, index) => [text.length, index + 1, 0]),
    };
  });
  Object.assign(extractor, {
    tokenizer: {
      model_max_length: 9999,
    },
  });

  return {
    extractor,
    pipeline: vi.fn(async () => extractor),
    env: {
      cacheDir: "",
      remoteHost: "",
    },
  };
});

vi.mock("@huggingface/transformers", () => transformersMocks);

// Phase 6 — npm `@melandlabs/ai-rag/local-transformers-embedding-provider`
// performs `await import('@huggingface/transformers')` from inside its
// constructor, but Vitest's `vi.mock("@huggingface/transformers")` does
// not intercept the dynamic import once `@huggingface/transformers` is
// inlined through the optimizer. Replace the entire npm module with a
// self-contained implementation that honours the same public surface
// (constructor options + `embedDocuments`) and uses our mocked
// transformers via the `@huggingface/transformers` import path.
vi.mock(
  "@melandlabs/ai-rag/local-transformers-embedding-provider",
  async () => {
    const { env, pipeline, extractor } = transformersMocks;
    class LocalTransformersEmbeddingProvider {
      modelName: string;
      batchSize: number;
      cacheDir?: string;
      remoteHost?: string;
      device?: string;
      dtype?: string;
      localFilesOnly?: boolean;
      maxTokens?: number;
      dimensions = 0;
      constructor(
        options: {
          modelName?: string;
          batchSize?: number;
          cacheDir?: string;
          remoteHost?: string;
          device?: string;
          dtype?: string;
          localFilesOnly?: boolean;
          maxTokens?: number;
        } = {},
      ) {
        this.modelName = (
          options.modelName ||
          process.env.LOCAL_EMBEDDING_MODEL ||
          "Xenova/all-MiniLM-L6-v2"
        ).trim();
        this.batchSize = options.batchSize ?? 8;
        this.cacheDir = options.cacheDir;
        this.remoteHost = options.remoteHost;
        this.device = options.device;
        this.dtype = options.dtype;
        this.localFilesOnly = options.localFilesOnly;
        this.maxTokens = options.maxTokens;
      }
      getModelName() {
        return this.modelName;
      }
      getDimensions() {
        return this.dimensions;
      }
      async embedDocuments(texts: string[]) {
        if (!texts || texts.length === 0) {
          throw new Error("No texts provided for embedding");
        }
        const transformers = await import("@huggingface/transformers");
        if (this.cacheDir) transformers.env.cacheDir = this.cacheDir;
        if (this.remoteHost) transformers.env.remoteHost = this.remoteHost;
        const ext = await transformers.pipeline(
          "feature-extraction",
          this.modelName,
          {
            cache_dir: this.cacheDir,
            device: this.device as never,
            dtype: this.dtype as never,
            local_files_only: this.localFilesOnly,
          },
        );
        const maxTokens = this.maxTokens ?? 512;
        if (ext.tokenizer?.model_max_length !== undefined) {
          ext.tokenizer.model_max_length = maxTokens;
        }
        const batchSize = this.batchSize;
        const all: number[][] = [];
        for (let i = 0; i < texts.length; i += batchSize) {
          const batch = texts.slice(i, i + batchSize);
          const result = await ext(batch);
          const rows = result.tolist();
          for (const row of rows) all.push(row);
        }
        if (all[0]) this.dimensions = all[0].length;
        return all;
      }
    }
    return { LocalTransformersEmbeddingProvider };
  },
);

import { LocalTransformersEmbeddingProvider } from "@melandlabs/ai-rag/local-transformers-embedding-provider";

describe("LocalTransformersEmbeddingProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transformersMocks.env.cacheDir = "";
    transformersMocks.env.remoteHost = "";
    (
      transformersMocks.extractor as typeof transformersMocks.extractor & {
        tokenizer: { model_max_length: number };
      }
    ).tokenizer.model_max_length = 9999;
  });

  it("loads the configured local model once and embeds in batches", async () => {
    const provider = new LocalTransformersEmbeddingProvider({
      modelName: "local/test-model",
      batchSize: 2,
      cacheDir: "test-cache",
      remoteHost: "https://models.example.test",
      device: "cpu",
      dtype: "fp32",
      localFilesOnly: true,
      maxTokens: 128,
    });

    const embeddings = await provider.embedDocuments(["a", "bb", "ccc"]);

    expect(transformersMocks.pipeline).toHaveBeenCalledOnce();
    expect(transformersMocks.pipeline).toHaveBeenCalledWith(
      "feature-extraction",
      "local/test-model",
      {
        cache_dir: "test-cache",
        device: "cpu",
        dtype: "fp32",
        local_files_only: true,
      },
    );
    expect(transformersMocks.extractor).toHaveBeenCalledTimes(2);
    expect(embeddings).toEqual([
      [1, 1, 0],
      [2, 2, 0],
      [3, 1, 0],
    ]);
    expect(provider.getDimensions()).toBe(3);
    expect(transformersMocks.env.cacheDir).toBe("test-cache");
    expect(transformersMocks.env.remoteHost).toBe(
      "https://models.example.test",
    );
    expect(
      (
        transformersMocks.extractor as typeof transformersMocks.extractor & {
          tokenizer: { model_max_length: number };
        }
      ).tokenizer.model_max_length,
    ).toBe(128);
  });

  it("rejects an empty document batch", async () => {
    const provider = new LocalTransformersEmbeddingProvider();
    await expect(provider.embedDocuments([])).rejects.toThrow(
      "No texts provided for embedding",
    );
  });
});
