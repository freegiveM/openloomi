/**
 * Back-compat re-export of the unified semantic search façade.
 *
 * The implementation now lives in `@melandlabs/memory-store`. This
 * file is kept as the import path that the rest of the web app uses
 * (`@/lib/memory/unified-search`) so existing route handlers,
 * MCP tools, and tests don't need to change their imports.
 *
 * The factory in `apps/web/lib/memory/unified-search-factory.ts`
 * wires up the host-specific embedder + RAG + insights searchers.
 */

import { isRawMessageStorageAvailable } from "@melandlabs/memory-store/raw-message-store";

export {
  searchUnifiedMemory,
  searchRawMemorySemantically,
} from "./unified-search-factory";
export {
  clampUnifiedMemorySearchLimit,
  clampUnifiedMemorySearchThreshold,
  mergeUnifiedMemorySearchResults,
  normalizeUnifiedMemorySearchSources,
  toKnowledgeResult,
  toMemoryResult,
  isRawMemorySemanticResult,
} from "@melandlabs/memory-store/unified-search";
export type {
  UnifiedMemorySearchInput,
  UnifiedMemorySearchOutput,
  UnifiedMemorySearchResult,
  UnifiedMemorySearchSource,
  UnifiedMemorySearchWarning,
} from "@melandlabs/memory-store/unified-search";

// Keep `isRawMessageStorageAvailable` available via the old path so
// callers like the API routes keep working.
export { isRawMessageStorageAvailable };