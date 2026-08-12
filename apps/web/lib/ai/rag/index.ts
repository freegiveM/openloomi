/**
 * RAG module - thin re-export layer for @melandlabs/rag package.
 * DB-dependent files stay here; pure utilities are re-exported from the package.
 */

// Pure utilities from @melandlabs/rag - use named exports to avoid duplicate export errors
export {
  chunkText,
  countTokens,
  getOptimalChunkSize,
  estimateChunkCount,
} from "@melandlabs/rag/chunking";
export type { ChunkOptions, TextChunk } from "@melandlabs/rag/chunking";

export {
  generateEmbedding,
  generateEmbeddings,
  cosineSimilarity,
  getEmbeddingDimensions,
  getEmbeddingModel,
  getModelPricing,
} from "@melandlabs/rag/embeddings";
export type { EmbeddingResult } from "@melandlabs/rag/embeddings";

export {
  getVectorStore,
  addDocumentToVectorStore,
  searchVectorStore,
  deleteDocumentFromVectorStore,
  getVectorStoreStats,
  configureVectorService,
} from "@melandlabs/rag/vector-service";
export type {
  IVectorStore,
  SearchResult,
  VectorSearchResult,
  DocumentChunk,
} from "@melandlabs/rag/vector-service";

// Re-export parsers from package (configured in apps/web/lib/rag/parsers.ts)
export {
  TextLoader,
  AppleDocumentLoader,
  parseFile,
  parseFileToDocument,
  getPdfPageCount,
  shouldUseNativePdf,
  isSupportedContentType,
} from "./parsers";
export type { FileContent } from "./parsers";

// Re-export universal embeddings from package
export { UniversalEmbeddings } from "@melandlabs/rag/universal-embeddings";

// Re-export sqlite/pgvector from package (wired in app-specific files)
export {
  SQLiteVecStore,
  getSQLiteVecStore,
  resetSQLiteVecStore,
  type VectorSearchResult as SQLiteVectorSearchResult,
  type DocumentChunk as SQLiteDocumentChunk,
} from "./sqlite-vec-store";
export {
  getPGVectorStore,
  processDocumentWithPGVector,
  searchWithPGVector,
  deleteDocumentsFromPGVector,
  getDocumentCount,
  listUserDocuments,
} from "./pgvector-store";

// DB-dependent files stay local - lazy loaded to reduce initial memory footprint
export async function getLangChainService() {
  const module = await import("./langchain-service");
  return module;
}
