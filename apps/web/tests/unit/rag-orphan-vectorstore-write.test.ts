/**
 * Regression test for issue #535: processDocument() committed the document
 * and chunk rows to SQL before the vector-store write, and never rolled
 * them back if that write failed, leaving a document that is fully visible
 * in getUserDocuments()/getUserRAGStats() but permanently unreachable via
 * searchSimilarChunks().
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { addChunksMock, insertedDocumentIds, deleteCalls } = vi.hoisted(() => ({
  addChunksMock: vi.fn(),
  insertedDocumentIds: [] as string[],
  deleteCalls: [] as string[],
}));

vi.mock("@/lib/env", () => ({
  isTauriMode: () => false,
  TAURI_DB_PATH: "/tmp/openloomi-test.db",
}));

vi.mock("@/lib/ai", () => ({
  estimateTokens: (text: string) => text.length,
}));

vi.mock("@/lib/ai/user-embedding-settings", () => ({
  createUserEmbeddingProvider: () => ({
    embedDocuments: async (texts: string[]) =>
      texts.map(() => [0.1, 0.2, 0.3]),
  }),
  getUserEmbeddingModelName: async () => "openai/text-embedding-3-small",
  hasUserEmbeddingProviderConfig: () => true,
}));

vi.mock("@melandlabs/ai-rag/chroma-store", () => ({
  getChromaVectorStore: () => ({ addChunks: addChunksMock }),
}));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  return {
    db: {
      insert: (table: unknown) => ({
        values: (data: any) => {
          if (table === schema.ragDocuments) {
            insertedDocumentIds.push(data.id);
            // Only the document insert is followed by .returning(); the
            // chunk batch insert below is awaited directly.
            return { returning: async () => [{ ...data }] };
          }
          return Promise.resolve(undefined);
        },
      }),
      delete: (table: unknown) => ({
        where: async () => {
          deleteCalls.push(table === schema.ragDocuments ? "documents" : "chunks");
        },
      }),
    },
  };
});

describe("processDocument vector-store write failure (issue #535)", () => {
  beforeEach(() => {
    addChunksMock.mockReset();
    insertedDocumentIds.length = 0;
    deleteCalls.length = 0;
    process.env.RAG_VECTOR_STORE_BACKEND = "chroma";
  });

  it("VS-01: rolls back the document and its chunks when the vector-store write fails", async () => {
    addChunksMock.mockRejectedValueOnce(new Error("vector store unavailable"));
    const { processDocument } = await import("@/lib/ai/rag/langchain-service");

    await expect(
      processDocument("user-1", "free", "notes.txt", "text/plain", "hello world"),
    ).rejects.toThrow("vector store unavailable");

    expect(addChunksMock).toHaveBeenCalledTimes(1);
    expect(insertedDocumentIds).toHaveLength(1);
    // Final state: both the chunk rows and the document row were removed,
    // chunks first (they carry the documentId foreign key).
    expect(deleteCalls).toEqual(["chunks", "documents"]);
  });

  it("VS-02: leaves the document and its chunks committed when the vector-store write succeeds", async () => {
    addChunksMock.mockResolvedValueOnce(undefined);
    const { processDocument } = await import("@/lib/ai/rag/langchain-service");

    const result = await processDocument(
      "user-1",
      "free",
      "notes.txt",
      "text/plain",
      "hello world",
    );

    expect(addChunksMock).toHaveBeenCalledTimes(1);
    expect(result.documentId).toBe(insertedDocumentIds[0]);
    expect(deleteCalls).toEqual([]);
  });
});
