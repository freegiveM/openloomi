/**
 * Bridge: wire the web app's cross-domain searchers (RAG, insights,
 * embedding provider) into the standalone `@openloomi/memory-store`
 * unified-search facade.
 *
 * This keeps the existing `searchUnifiedMemory()` callers in
 * `apps/web/app/api/memory/search/route.ts` and
 * `apps/web/lib/ai/mcp/tools/unified-memory.ts` working unchanged —
 * they continue to import `searchUnifiedMemory` from `@/lib/memory/unified-search`,
 * which now re-exports the wired-up version from this file.
 */

import { createUnifiedSearch } from "@openloomi/memory-store/unified-search";
import { searchInsightsSemantically } from "@/lib/insights/search";
import { searchSimilarChunks } from "@/lib/ai/rag/langchain-service";
import {
  createUserEmbeddingProvider,
  hasUserEmbeddingProviderConfig,
} from "@/lib/ai/user-embedding-settings";

import type {
  UnifiedMemorySearchInput,
  UnifiedMemorySearchOutput,
} from "@openloomi/memory-store/unified-search";
import type {
  RawMessageStorageManagerWithSearch,
} from "@openloomi/memory-store/raw-message-store";
import { getRawMessageManager } from "@openloomi/memory-store/raw-message-store";

export const search = createUnifiedSearch({
  embedQuery: async ({ userId, query, authToken }) => {
    if (!(await hasUserEmbeddingProviderConfig({ userId, authToken }))) {
      throw new Error("Embedding provider API key is not configured");
    }
    const embeddings = await createUserEmbeddingProvider({ userId, authToken });
    return embeddings.embedQuery(query);
  },
  searchKnowledge: ({ userId, query, options, authToken }) =>
    searchSimilarChunks(userId, query, options, authToken),
  searchInsights: ({ userId, query, limit, threshold, botIds, includeArchived, authToken }) =>
    searchInsightsSemantically({
      userId,
      query,
      limit,
      threshold,
      botIds,
      includeArchived,
      authToken,
    }),
  searchRawMessagesAnn: async ({
    userId,
    queryEmbedding,
    limit,
    threshold,
    botId,
  }) => {
    const manager = (await getRawMessageManager()) as unknown as RawMessageStorageManagerWithSearch & {
      searchMessagesSemantically?: (input: unknown) => Promise<unknown[]>;
    };
    if (typeof manager.searchMessagesSemantically !== "function") {
      return [];
    }
    const rows = (await manager.searchMessagesSemantically({
      userId,
      queryEmbedding,
      limit,
      threshold,
      botId,
    })) as Array<{
      id: string;
      content: string;
      similarity: number;
      metadata: Record<string, unknown>;
    }>;
    return rows;
  },
});

export const searchUnifiedMemory = search.searchUnifiedMemory;
export const searchRawMemorySemantically = search.searchRawMemorySemantically;

export type {
  UnifiedMemorySearchInput,
  UnifiedMemorySearchOutput,
} from "@openloomi/memory-store/unified-search";