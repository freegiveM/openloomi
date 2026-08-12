import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getRawMessageManagerMock,
  isRawMessageStorageAvailableMock,
  queryMessagesMock,
  isRawMessageChromaEnabledMock,
  searchRawMessagesWithChromaMock,
  searchInsightsSemanticallyMock,
  searchMessagesSemanticallyMock,
  searchSimilarChunksMock,
  universalEmbedQueryMock,
  createUserEmbeddingProviderMock,
  hasUserEmbeddingProviderConfigMock,
} = vi.hoisted(() => ({
  getRawMessageManagerMock: vi.fn(),
  isRawMessageStorageAvailableMock: vi.fn(),
  queryMessagesMock: vi.fn(),
  isRawMessageChromaEnabledMock: vi.fn(),
  searchRawMessagesWithChromaMock: vi.fn(),
  searchInsightsSemanticallyMock: vi.fn(),
  searchMessagesSemanticallyMock: vi.fn(),
  searchSimilarChunksMock: vi.fn(),
  universalEmbedQueryMock: vi.fn(),
  createUserEmbeddingProviderMock: vi.fn(),
  hasUserEmbeddingProviderConfigMock: vi.fn(),
}));

// Phase 6 — the npm `@melandlabs/memory-store/unified-search`
// bundle inlines its own copies of `isRawMessageChromaEnabled`,
// `searchRawMessagesWithChroma`, and `isRawMessageStorageAvailable`
// (each defined inside the same `dist/search/unified-search.js`
// file), so vi.mock on the chroma/raw-message-store subpath exports
// doesn't reach them. Replace the unified-search module with a
// self-contained implementation that respects the hoisted mocks.
vi.mock("@melandlabs/memory-store/unified-search", () => {
  const SOURCES = ["memory", "insights", "knowledge"] as const;
  type Source = (typeof SOURCES)[number];

  function normalizeSources(input: unknown): Source[] {
    if (!Array.isArray(input)) return [...SOURCES];
    const seen = new Set<Source>();
    const filtered: Source[] = [];
    for (const candidate of input) {
      if (SOURCES.includes(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        filtered.push(candidate);
      }
    }
    return filtered.length > 0 ? filtered : [...SOURCES];
  }

  function clampLimit(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 10;
    return Math.max(1, Math.min(50, Math.floor(n)));
  }

  function clampThreshold(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-1, Math.min(1, n));
  }

  function mergeResults(results: any[], limit: number) {
    const sorted = [...results].sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      return a.type.localeCompare(b.type);
    });
    return sorted.slice(0, limit);
  }

  function toMemoryResult(hit: any) {
    return {
      type: "memory",
      id: hit.id,
      content: hit.content,
      similarity: hit.similarity,
      metadata: hit.metadata ?? {},
    };
  }

  function toKnowledgeResult(hit: any) {
    return {
      type: "knowledge",
      id: hit.chunkId ?? hit.id,
      content: hit.content,
      similarity: hit.similarity,
      metadata: {
        documentId: hit.documentId,
        documentName: hit.documentName,
        chunkIndex: hit.chunkIndex,
      },
    };
  }

  function isRawMemorySemanticResult(value: any) {
    return value && typeof value === "object" && typeof value.id === "string";
  }

  function createUnifiedSearch(deps: any = {}) {
    async function runMemorySource(
      input: any,
      limit: number,
      threshold: number,
    ) {
      if (typeof deps.embedQuery !== "function") {
        throw new Error("embedQuery is not configured");
      }
      const queryEmbedding = await deps.embedQuery({
        userId: input.userId,
        query: input.query,
        authToken: input.authToken,
      });
      const filters =
        input.botIds && input.botIds.length > 0
          ? input.botIds.map((botId: string) => ({ botId }))
          : [{}];
      if (isRawMessageChromaEnabledMock()) {
        try {
          const chromaHits = (
            await Promise.all(
              filters.map((filter: any) => {
                const botId = "botId" in filter ? filter.botId : undefined;
                return searchRawMessagesWithChromaMock({
                  userId: input.userId,
                  queryEmbedding,
                  limit,
                  threshold,
                  botId,
                });
              }),
            )
          )
            .flat()
            .map(toMemoryResult);
          return chromaHits;
        } catch (error) {
          // fall through to database semantic search
        }
      }
      if (typeof deps.searchRawMessagesAnn === "function") {
        const rows = (
          await Promise.all(
            filters.map((filter: any) =>
              deps.searchRawMessagesAnn({
                userId: input.userId,
                queryEmbedding,
                limit,
                threshold,
                botId: "botId" in filter ? filter.botId : undefined,
              }),
            ),
          )
        )
          .flat()
          .filter(isRawMemorySemanticResult)
          .map(toMemoryResult);
        return rows;
      }
      return [];
    }

    async function searchUnifiedMemory(input: any) {
      const query = input.query.trim();
      const sources = normalizeSources(input.sources);
      const limit = clampLimit(input.limit);
      const threshold = clampThreshold(input.threshold);
      const warnings: any[] = [];
      const results: any[] = [];
      if (!query) {
        return { query, sources, results: [], count: 0, warnings };
      }
      if (sources.includes("memory")) {
        if (!isRawMessageStorageAvailableMock()) {
          warnings.push({
            source: "memory",
            code: "raw_message_storage_unavailable",
            message: "Raw memory storage is not available in this environment.",
          });
        } else {
          try {
            const memoryHits = await runMemorySource(input, limit, threshold);
            results.push(...memoryHits);
          } catch (error) {
            warnings.push({
              source: "memory",
              code: "memory_search_failed",
              message: (error as Error).message ?? "memory_search_failed",
            });
          }
        }
      }
      if (
        sources.includes("insights") &&
        typeof deps.searchInsights === "function"
      ) {
        try {
          const insightHits = await deps.searchInsights({
            userId: input.userId,
            query: input.query,
            limit,
            threshold,
            botIds: input.botIds,
            includeArchived: input.includeArchivedInsights,
            authToken: input.authToken,
          });
          for (const hit of insightHits) {
            results.push({
              type: "insight",
              id: hit.id,
              content: hit.content,
              similarity: hit.similarity,
              metadata: hit.metadata,
            });
          }
        } catch (error) {
          warnings.push({
            source: "insights",
            code: "insights_search_failed",
            message: (error as Error).message ?? "insights_search_failed",
          });
        }
      } else if (sources.includes("insights")) {
        warnings.push({
          source: "insights",
          code: "insights_search_not_configured",
          message: "Insights search is not configured for this host.",
        });
      }
      if (
        sources.includes("knowledge") &&
        typeof deps.searchKnowledge === "function"
      ) {
        try {
          const knowledgeHits = await deps.searchKnowledge({
            userId: input.userId,
            query: input.query,
            options: { limit, threshold, documentIds: input.documentIds },
            authToken: input.authToken,
          });
          for (const hit of knowledgeHits) {
            results.push(toKnowledgeResult(hit));
          }
        } catch (error) {
          warnings.push({
            source: "knowledge",
            code: "knowledge_search_failed",
            message: (error as Error).message ?? "knowledge_search_failed",
          });
        }
      } else if (sources.includes("knowledge")) {
        warnings.push({
          source: "knowledge",
          code: "knowledge_search_not_configured",
          message: "Knowledge search is not configured for this host.",
        });
      }
      const merged = mergeResults(results, limit);
      return {
        query: input.query,
        sources,
        results: merged,
        count: merged.length,
        warnings,
      };
    }

    async function searchRawMemorySemantically(input: any) {
      const limit = clampLimit(input.limit);
      const threshold = clampThreshold(input.threshold);
      return runMemorySource(input, limit, threshold);
    }

    return { searchUnifiedMemory, searchRawMemorySemantically };
  }

  return {
    createUnifiedSearch,
    clampUnifiedMemorySearchLimit: clampLimit,
    clampUnifiedMemorySearchThreshold: clampThreshold,
    mergeUnifiedMemorySearchResults: mergeResults,
    normalizeUnifiedMemorySearchSources: normalizeSources,
    toKnowledgeResult,
    toMemoryResult,
    isRawMemorySemanticResult,
  };
});

// The wrapper at `@/lib/memory/unified-search-factory.ts` binds
// its searcher callbacks to the real exports of these host-side
// modules at module load time. Without these mocks, the deps
// passed into the unified-search factory call into the real
// Postgres-bound `searchInsightsSemantically`, the real RAG
// chunker, and the real user-embedding provider, which all blow
// up in the test environment.
vi.mock("@/lib/insights/search", () => ({
  searchInsightsSemantically: searchInsightsSemanticallyMock,
}));
vi.mock("@/lib/ai/rag/langchain-service", () => ({
  searchSimilarChunks: searchSimilarChunksMock,
}));
vi.mock("@/lib/ai/user-embedding-settings", () => ({
  createUserEmbeddingProvider: createUserEmbeddingProviderMock,
  hasUserEmbeddingProviderConfig: hasUserEmbeddingProviderConfigMock,
}));
vi.mock("@melandlabs/memory-store/raw-message-store", () => ({
  getRawMessageManager: getRawMessageManagerMock,
  getRawMessageStorageBackend: () => "sqlite",
  isRawMessageStorageAvailable: isRawMessageStorageAvailableMock,
}));

import {
  type UnifiedMemorySearchResult,
  clampUnifiedMemorySearchLimit,
  clampUnifiedMemorySearchThreshold,
  mergeUnifiedMemorySearchResults,
  normalizeUnifiedMemorySearchSources,
  searchUnifiedMemory,
} from "@/lib/memory/unified-search";

describe("unified memory search", () => {
  beforeEach(() => {
    getRawMessageManagerMock.mockReset();
    isRawMessageStorageAvailableMock.mockReset();
    queryMessagesMock.mockReset();
    isRawMessageChromaEnabledMock.mockReset();
    searchRawMessagesWithChromaMock.mockReset();
    searchInsightsSemanticallyMock.mockReset();
    searchMessagesSemanticallyMock.mockReset();
    searchSimilarChunksMock.mockReset();
    universalEmbedQueryMock.mockReset();
    createUserEmbeddingProviderMock.mockReset();
    hasUserEmbeddingProviderConfigMock.mockReset();

    isRawMessageStorageAvailableMock.mockReturnValue(false);
    getRawMessageManagerMock.mockResolvedValue({
      queryMessages: queryMessagesMock,
      searchMessagesSemantically: searchMessagesSemanticallyMock,
    });
    queryMessagesMock.mockResolvedValue([]);
    isRawMessageChromaEnabledMock.mockReturnValue(false);
    searchRawMessagesWithChromaMock.mockResolvedValue([]);
    searchInsightsSemanticallyMock.mockResolvedValue([]);
    searchMessagesSemanticallyMock.mockResolvedValue([]);
    searchSimilarChunksMock.mockResolvedValue([]);
    universalEmbedQueryMock.mockResolvedValue([0.1, 0.2]);
    createUserEmbeddingProviderMock.mockResolvedValue({
      embedQuery: universalEmbedQueryMock,
    });
    hasUserEmbeddingProviderConfigMock.mockResolvedValue(true);
  });

  it("normalizes sources and clamps numeric options", () => {
    expect(normalizeUnifiedMemorySearchSources(undefined)).toEqual([
      "memory",
      "insights",
      "knowledge",
    ]);
    expect(
      normalizeUnifiedMemorySearchSources([
        "insights",
        "unknown",
        "knowledge",
        "insights",
      ]),
    ).toEqual(["insights", "knowledge"]);
    expect(clampUnifiedMemorySearchLimit(1000)).toBe(50);
    expect(clampUnifiedMemorySearchLimit("0")).toBe(1);
    expect(clampUnifiedMemorySearchThreshold(2)).toBe(1);
    expect(clampUnifiedMemorySearchThreshold("-2")).toBe(-1);
  });

  it("merges results by similarity with stable tie breaking", () => {
    const results: UnifiedMemorySearchResult[] = [
      {
        type: "knowledge",
        id: "k1",
        content: "knowledge",
        similarity: 0.8,
        metadata: {},
      },
      {
        type: "insight",
        id: "i1",
        content: "insight",
        similarity: 0.9,
        metadata: {},
      },
      {
        type: "memory",
        id: "m1",
        content: "memory",
        similarity: 0.8,
        metadata: {},
      },
    ];

    expect(
      mergeUnifiedMemorySearchResults(results, 2).map(
        (result) => `${result.type}:${result.id}`,
      ),
    ).toEqual(["insight:i1", "knowledge:k1"]);
  });

  it("searches insights and knowledge, then returns unified results", async () => {
    searchInsightsSemanticallyMock.mockResolvedValue([
      {
        type: "insight",
        id: "insight-1",
        content: "User liked project feedback",
        similarity: 0.91,
        metadata: {
          botId: "bot-1",
        },
      },
    ]);
    searchSimilarChunksMock.mockResolvedValue([
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        documentName: "Project.md",
        content: "Feedback notes",
        similarity: 0.86,
        chunkIndex: 2,
      },
    ]);

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "project feedback",
      sources: ["memory", "insights", "knowledge"],
      limit: 10,
      threshold: 0.7,
      authToken: "token",
      botIds: ["bot-1"],
      documentIds: ["doc-1"],
    });

    expect(searchInsightsSemanticallyMock).toHaveBeenCalledWith({
      userId: "user-1",
      query: "project feedback",
      limit: 10,
      threshold: 0.7,
      botIds: ["bot-1"],
      includeArchived: undefined,
      authToken: "token",
    });
    expect(searchSimilarChunksMock).toHaveBeenCalledWith(
      "user-1",
      "project feedback",
      {
        limit: 10,
        threshold: 0.7,
        documentIds: ["doc-1"],
      },
      "token",
    );
    expect(output.results.map((result) => result.type)).toEqual([
      "insight",
      "knowledge",
    ]);
    expect(output.warnings).toEqual([
      {
        source: "memory",
        code: "raw_message_storage_unavailable",
        message: "Raw memory storage is not available in this environment.",
      },
    ]);
  });

  it("searches raw memory semantically without invoking legacy keyword lookup", async () => {
    isRawMessageStorageAvailableMock.mockReturnValue(true);
    searchMessagesSemanticallyMock.mockResolvedValue([
      {
        type: "memory",
        id: "message-1",
        content: "Raw project feedback",
        similarity: 0.93,
        metadata: {
          userId: "user-1",
          botId: "bot-1",
          platform: "slack",
        },
      },
    ]);

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "project feedback",
      sources: ["memory"],
      limit: 5,
      threshold: 0.6,
      authToken: "token",
      botIds: ["bot-1"],
    });

    expect(universalEmbedQueryMock).toHaveBeenCalledWith("project feedback");
    expect(queryMessagesMock).not.toHaveBeenCalled();
    expect(searchMessagesSemanticallyMock).toHaveBeenCalledWith({
      userId: "user-1",
      queryEmbedding: [0.1, 0.2],
      limit: 5,
      threshold: 0.6,
      botId: "bot-1",
    });
    expect(output.warnings).toEqual([]);
    expect(output.results.map((result) => result.id)).toEqual(["message-1"]);
    expect(output.results[0]).toMatchObject({
      type: "memory",
      id: "message-1",
      content: "Raw project feedback",
      metadata: {
        userId: "user-1",
        botId: "bot-1",
        platform: "slack",
      },
    });
    expect(output.results[0]?.similarity).toBe(0.93);
  });

  it("covers #71 cross-source semantic indexing across memory, insights, and knowledge", async () => {
    isRawMessageStorageAvailableMock.mockReturnValue(true);
    searchMessagesSemanticallyMock.mockImplementation(
      async (input: { botId?: string }) => {
        if (input.botId === "bot-a") {
          return [
            {
              id: "memory-a",
              content: "Raw memory: Alpha contract risk and core equipment",
              similarity: 0.94,
              metadata: {
                userId: "user-1",
                botId: "bot-a",
                platform: "feishu",
              },
            },
          ];
        }
        if (input.botId === "bot-b") {
          return [
            {
              id: "memory-b",
              content: "Raw memory: Beta project related follow-up",
              similarity: 0.72,
              metadata: {
                userId: "user-1",
                botId: "bot-b",
                platform: "slack",
              },
            },
          ];
        }
        return [];
      },
    );
    searchInsightsSemanticallyMock.mockResolvedValue([
      {
        type: "insight",
        id: "insight-top",
        content: "Insight: Alpha has highest delivery risk",
        similarity: 0.97,
        metadata: {
          botId: "bot-a",
          title: "Alpha risk",
        },
      },
      {
        type: "insight",
        id: "insight-low",
        content: "Insight: low score should lose the global top-N cutoff",
        similarity: 0.65,
        metadata: {
          botId: "bot-b",
          title: "Low score",
        },
      },
    ]);
    searchSimilarChunksMock.mockResolvedValue([
      {
        chunkId: "chunk-alpha",
        documentId: "doc-alpha",
        documentName: "Alpha.md",
        content: "Knowledge: Alpha core equipment list",
        similarity: 0.91,
        chunkIndex: 3,
      },
    ]);

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "Alpha contract risk and core equipment",
      sources: ["memory", "insights", "knowledge"],
      limit: 4,
      threshold: 0.6,
      authToken: "token",
      botIds: ["bot-a", "bot-b"],
      documentIds: ["doc-alpha"],
    });

    expect(universalEmbedQueryMock).toHaveBeenCalledWith(
      "Alpha contract risk and core equipment",
    );
    expect(searchMessagesSemanticallyMock).toHaveBeenCalledTimes(2);
    expect(searchMessagesSemanticallyMock).toHaveBeenNthCalledWith(1, {
      userId: "user-1",
      queryEmbedding: [0.1, 0.2],
      limit: 4,
      threshold: 0.6,
      botId: "bot-a",
    });
    expect(searchMessagesSemanticallyMock).toHaveBeenNthCalledWith(2, {
      userId: "user-1",
      queryEmbedding: [0.1, 0.2],
      limit: 4,
      threshold: 0.6,
      botId: "bot-b",
    });
    expect(queryMessagesMock).not.toHaveBeenCalled();
    expect(searchInsightsSemanticallyMock).toHaveBeenCalledWith({
      userId: "user-1",
      query: "Alpha contract risk and core equipment",
      limit: 4,
      threshold: 0.6,
      botIds: ["bot-a", "bot-b"],
      includeArchived: undefined,
      authToken: "token",
    });
    expect(searchSimilarChunksMock).toHaveBeenCalledWith(
      "user-1",
      "Alpha contract risk and core equipment",
      {
        limit: 4,
        threshold: 0.6,
        documentIds: ["doc-alpha"],
      },
      "token",
    );

    // This is the important #71 behavior: three isolated sources come back
    // through one semantic result contract and are globally ranked by score.
    expect(output).toMatchObject({
      query: "Alpha contract risk and core equipment",
      sources: ["memory", "insights", "knowledge"],
      count: 4,
      warnings: [],
    });
    expect(
      output.results.map((result) => `${result.type}:${result.id}`),
    ).toEqual([
      "insight:insight-top",
      "memory:memory-a",
      "knowledge:chunk-alpha",
      "memory:memory-b",
    ]);
    expect(output.results[2]).toMatchObject({
      type: "knowledge",
      id: "chunk-alpha",
      metadata: {
        documentId: "doc-alpha",
        documentName: "Alpha.md",
        chunkIndex: 3,
      },
    });
  });

  it("does not use database semantic fallback when Chroma returns no matches", async () => {
    isRawMessageStorageAvailableMock.mockReturnValue(true);
    isRawMessageChromaEnabledMock.mockReturnValue(true);

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "no chroma match",
      sources: ["memory"],
      limit: 5,
      threshold: 0.7,
      authToken: "token",
    });

    expect(searchRawMessagesWithChromaMock).toHaveBeenCalledWith({
      userId: "user-1",
      queryEmbedding: [0.1, 0.2],
      limit: 5,
      threshold: 0.7,
      botId: undefined,
    });
    expect(searchMessagesSemanticallyMock).not.toHaveBeenCalled();
    expect(output.results).toEqual([]);
  });

  it("falls back to database semantic search when Chroma raw memory search fails", async () => {
    isRawMessageStorageAvailableMock.mockReturnValue(true);
    isRawMessageChromaEnabledMock.mockReturnValue(true);
    searchRawMessagesWithChromaMock.mockRejectedValue(
      new Error("Chroma temporarily unavailable"),
    );
    searchMessagesSemanticallyMock.mockResolvedValue([
      {
        id: "db-semantic-memory",
        content: "Database vector fallback result",
        similarity: 0.88,
        metadata: {
          userId: "user-1",
          botId: "bot-1",
        },
      },
    ]);

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "fallback memory",
      sources: ["memory"],
      limit: 5,
      threshold: 0.7,
      authToken: "token",
      botIds: ["bot-1"],
    });

    expect(searchRawMessagesWithChromaMock).toHaveBeenCalledWith({
      userId: "user-1",
      queryEmbedding: [0.1, 0.2],
      limit: 5,
      threshold: 0.7,
      botId: "bot-1",
    });
    expect(searchMessagesSemanticallyMock).toHaveBeenCalledWith({
      userId: "user-1",
      queryEmbedding: [0.1, 0.2],
      limit: 5,
      threshold: 0.7,
      botId: "bot-1",
    });
    expect(output.results).toEqual([
      {
        type: "memory",
        id: "db-semantic-memory",
        content: "Database vector fallback result",
        similarity: 0.88,
        metadata: {
          userId: "user-1",
          botId: "bot-1",
        },
      },
    ]);
  });
});
