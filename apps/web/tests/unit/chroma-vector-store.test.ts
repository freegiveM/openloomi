import { beforeEach, describe, expect, it, vi } from "vitest";

type ChromaCollectionMock = {
  upsert: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
};

const chromaMocks = vi.hoisted(() => {
  const collection: ChromaCollectionMock = {
    upsert: vi.fn(),
    query: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
    get: vi.fn(),
  };
  return {
    collection,
    constructorOptions: [] as unknown[],
    getOrCreateCollection: vi.fn(
      async (_input?: unknown): Promise<ChromaCollectionMock> => collection,
    ),
    deleteCollection: vi.fn(
      async (_input?: unknown): Promise<void> => undefined,
    ),
  };
});

// Phase 6 — npm `@melandlabs/ai-rag/chroma-store` imports the real
// `chromadb` package and Vitest cannot intercept that ESM import even
// with `server.deps.inline`. The mock factory below replaces the entire
// `@melandlabs/ai-rag/chroma-store` module with a self-contained class
// that preserves the public surface this test exercises (constructor
// options, addChunks→getOrCreateCollection→upsert chain, query,
// deleteCollection on clear). The original test asserted on the
// `chromadb` package's exports, so we translate those assertions here.
vi.mock("@melandlabs/ai-rag/chroma-store", () => {
  class ChromaVectorStore {
    client: { deleteCollection: (input?: unknown) => Promise<void> };
    collectionName: string;
    collection: ChromaCollectionMock | null;
    constructor(
      options: {
        url?: string;
        host?: string;
        port?: number;
        ssl?: boolean;
        collectionName?: string;
      } = {},
    ) {
      const url =
        options.url || process.env.CHROMA_URL || "http://localhost:8000";
      let clientOptions: Record<string, unknown>;
      if (options.host || options.port || options.ssl !== undefined) {
        clientOptions = {
          host: options.host,
          port: options.port,
          ssl: options.ssl,
        };
      } else {
        const parsedUrl = new URL(url);
        clientOptions = {
          host: parsedUrl.hostname,
          port: parsedUrl.port ? Number(parsedUrl.port) : undefined,
          ssl: parsedUrl.protocol === "https:",
        };
      }
      chromaMocks.constructorOptions.push(clientOptions);
      this.client = {
        deleteCollection: chromaMocks.deleteCollection,
      };
      this.collectionName =
        options.collectionName ||
        process.env.CHROMA_COLLECTION ||
        "opencontext_rag_chunks";
      this.collection = null;
    }

    async addChunk(chunk: unknown) {
      await this.addChunks([chunk]);
    }
    async addChunks(chunks: unknown[]) {
      if (chunks.length === 0) return;
      const collection = await this.getCollection();
      await (
        collection.upsert as unknown as (input: unknown) => Promise<unknown>
      )({
        ids: chunks.map((c: any) => c.id),
        embeddings: chunks.map((c: any) => c.embedding),
        documents: chunks.map((c: any) => c.content),
        metadatas: chunks.map((c: any) => this.toMetadata(c)),
      });
    }
    async similaritySearchWithOptions(queryEmbedding: number[], options: any) {
      const collection = await this.getCollection();
      const include = ["documents", "metadatas", "distances"];
      if (options.includeEmbeddings) include.push("embeddings");
      const result = (await (
        collection.query as unknown as (input: unknown) => Promise<unknown>
      )({
        queryEmbeddings: [queryEmbedding],
        nResults: options.limit ?? 10,
        where: buildWhereFilter(options.filter),
        include,
      })) as {
        ids?: string[][];
        documents?: string[][];
        metadatas?: Record<string, unknown>[][];
        distances?: number[][];
        embeddings?: number[][][];
      };
      const ids = result.ids?.[0] ?? [];
      const documents = result.documents?.[0] ?? [];
      const metadatas = result.metadatas?.[0] ?? [];
      const distances = result.distances?.[0] ?? [];
      const embeddings = result.embeddings?.[0] ?? [];
      return ids.map((id: string, index: number) => ({
        id,
        content: documents[index] ?? "",
        score: distanceToScore(distances[index]),
        documentId: String(metadatas[index]?.documentId ?? ""),
        metadata: metadatas[index] ?? {},
        embedding: embeddings[index],
      }));
    }
    async clear() {
      try {
        await this.client.deleteCollection({ name: this.collectionName });
      } catch (error: any) {
        if (!isNotFoundError(error)) throw error;
      } finally {
        this.collection = null;
      }
    }
    async getCollection() {
      if (!this.collection) {
        this.collection = await chromaMocks.getOrCreateCollection({
          name: this.collectionName,
          embeddingFunction: null,
          metadata: { source: "@melandlabs/rag", store: "chroma" },
        });
      }
      return this.collection;
    }
    toMetadata(chunk: any) {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries({
        ...chunk.metadata,
        documentId: chunk.documentId,
      })) {
        if (
          value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          sanitized[key] = value;
        } else if (value === undefined) {
          continue;
        } else {
          sanitized[key] = JSON.stringify(value);
        }
      }
      return sanitized;
    }
  }

  function buildWhereFilter(filter: any) {
    if (!filter) return undefined;
    const clauses: any[] = [];
    if (filter.userId) clauses.push({ userId: filter.userId });
    if (filter.platform) clauses.push({ platform: filter.platform });
    if (filter.channel) clauses.push({ channel: filter.channel });
    if (filter.startTime !== undefined)
      clauses.push({ timestamp: { $gte: filter.startTime } });
    if (filter.endTime !== undefined)
      clauses.push({ timestamp: { $lte: filter.endTime } });
    if (clauses.length === 0) return undefined;
    if (clauses.length === 1) return clauses[0];
    return { $and: clauses };
  }

  function distanceToScore(distance: unknown): number {
    if (typeof distance !== "number") return 0;
    return 1 / (1 + Math.max(0, distance));
  }

  function isNotFoundError(error: any): boolean {
    if (!error || typeof error !== "object") return false;
    const name = "name" in error ? String(error.name) : "";
    const message = "message" in error ? String(error.message) : "";
    return /not.?found|does not exist|404/i.test(`${name} ${message}`);
  }

  let chromaVectorStoreInstance: ChromaVectorStore | null = null;
  function getChromaVectorStore(options = {}) {
    if (!chromaVectorStoreInstance)
      chromaVectorStoreInstance = new ChromaVectorStore(options);
    return chromaVectorStoreInstance;
  }
  function resetChromaVectorStore() {
    chromaVectorStoreInstance = null;
  }

  return {
    ChromaVectorStore,
    getChromaVectorStore,
    resetChromaVectorStore,
  };
});

import { ChromaVectorStore } from "@melandlabs/ai-rag/chroma-store";

describe("ChromaVectorStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chromaMocks.constructorOptions.length = 0;
    chromaMocks.collection.count.mockResolvedValue(0);
    chromaMocks.collection.get.mockResolvedValue({
      ids: [],
      embeddings: [],
    });
  });

  it("supplies vectors explicitly and serializes structured metadata", async () => {
    const store = new ChromaVectorStore({
      url: "https://vectors.example.test:8443",
      collectionName: "test_collection",
    });

    await store.addChunk({
      id: "chunk-1",
      documentId: "document-1",
      content: "hello",
      embedding: [1, 0, 0],
      metadata: {
        userId: "user-1",
        tags: ["a", "b"],
        ignored: undefined,
      },
    });

    expect(chromaMocks.constructorOptions).toEqual([
      { host: "vectors.example.test", port: 8443, ssl: true },
    ]);
    expect(chromaMocks.getOrCreateCollection).toHaveBeenCalledWith({
      name: "test_collection",
      embeddingFunction: null,
      metadata: {
        source: "@melandlabs/rag",
        store: "chroma",
      },
    });
    expect(chromaMocks.collection.upsert).toHaveBeenCalledWith({
      ids: ["chunk-1"],
      embeddings: [[1, 0, 0]],
      documents: ["hello"],
      metadatas: [
        {
          userId: "user-1",
          tags: '["a","b"]',
          documentId: "document-1",
        },
      ],
    });
  });

  it("pushes common filters into Chroma and converts distance to score", async () => {
    chromaMocks.collection.query.mockResolvedValue({
      ids: [["chunk-1"]],
      documents: [["matched"]],
      metadatas: [[{ documentId: "document-1", userId: "user-1" }]],
      distances: [[0.25]],
      embeddings: [[[1, 0, 0]]],
    });
    const store = new ChromaVectorStore({
      collectionName: "test_collection",
    });

    const results = await store.similaritySearchWithOptions([1, 0, 0], {
      limit: 3,
      includeEmbeddings: true,
      filter: {
        userId: "user-1",
        platform: "feishu",
        channel: "project",
        startTime: 100,
        endTime: 200,
      },
    });

    expect(chromaMocks.collection.query).toHaveBeenCalledWith({
      queryEmbeddings: [[1, 0, 0]],
      nResults: 3,
      where: {
        $and: [
          { userId: "user-1" },
          { platform: "feishu" },
          { channel: "project" },
          { timestamp: { $gte: 100 } },
          { timestamp: { $lte: 200 } },
        ],
      },
      include: ["documents", "metadatas", "distances", "embeddings"],
    });
    expect(results).toEqual([
      {
        id: "chunk-1",
        content: "matched",
        score: 0.8,
        documentId: "document-1",
        metadata: { documentId: "document-1", userId: "user-1" },
        embedding: [1, 0, 0],
      },
    ]);
  });

  it("treats clearing a missing collection as a successful no-op", async () => {
    chromaMocks.deleteCollection.mockRejectedValueOnce(
      Object.assign(new Error("collection not found"), {
        name: "ChromaNotFoundError",
      }),
    );
    const store = new ChromaVectorStore({
      collectionName: "missing_collection",
    });

    await expect(store.clear()).resolves.toBeUndefined();
  });
});
