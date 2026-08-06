import { useState, useCallback, useEffect } from "react";
import {
  uploadRagFileChunked,
  shouldUseChunkedUpload,
} from "@/lib/files/chunked-upload";
import { convertPDFToImages, isPDF } from "@/lib/files/pdf-ocr";
import { uploadRagFile, handleScannedPDFUpload } from "@/lib/files/upload";
import { getAuthToken } from "@/lib/auth/token-manager";

/**
 * Knowledge base document interface
 */
export interface KnowledgeFile {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  totalChunks: number;
  uploadedAt: string;
}

/**
 * Knowledge base document details (including content blocks)
 */
export interface KnowledgeFileDetail extends KnowledgeFile {
  chunks: Array<{
    id: string;
    chunkIndex: number;
    content: string;
    createdAt: string;
  }>;
}

/**
 * API response type
 */
interface DocumentsResponse {
  documents?: KnowledgeFile[];
  error?: string;
}

interface DocumentDetailResponse {
  document?: KnowledgeFileDetail;
  error?: string;
}

interface UploadResponse {
  success?: boolean;
  message?: string;
  documentId?: string;
  fileName?: string;
  contentType?: string;
  chunksCount?: number;
  billing?: {
    tokensUsed: number;
    creditCost: number;
  };
  error?: string;
  code?: string;
}

interface DeleteResponse {
  success?: boolean;
  message?: string;
  error?: string;
}

/**
 * Knowledge base file management hook
 */
export function useKnowledgeFiles() {
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    fileName: string;
    progress: number;
  } | null>(null);

  /**
   * Get all documents
   */
  const fetchFiles = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/rag/documents");

      if (!response.ok) {
        const data: DocumentsResponse = await response.json();
        throw new Error(data.error || "Failed to fetch documents");
      }

      const data: DocumentsResponse = await response.json();

      if (data.documents) {
        setFiles(data.documents);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch documents";
      setError(message);
      console.error("Failed to fetch knowledge files:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Upload file - automatically choose normal upload or chunked upload
   */
  const uploadFile = useCallback(
    async (
      file: File,
    ): Promise<{ success: boolean; documentId?: string; error?: string }> => {
      setIsUploading(true);
      setUploadProgress({ fileName: file.name, progress: 0 });
      setError(null);

      try {
        // Get cloudAuthToken
        let cloudAuthToken: string | undefined;
        try {
          cloudAuthToken = getAuthToken() || undefined;
        } catch (error) {
          console.error("[uploadFile] Failed to read cloud_auth_token:", error);
        }

        // Determine if chunked upload is needed
        const useChunkedUpload = shouldUseChunkedUpload(file);

        if (useChunkedUpload) {
          console.log(
            `[uploadFile] Using chunked upload for ${file.name} (${file.size} bytes)`,
          );

          // Use chunked upload
          const result = await uploadRagFileChunked(file, {
            chunkSize: 5 * 1024 * 1024, // 5MB
            maxRetries: 3,
            onProgress: (fileName, progress, uploadedBytes, totalBytes) => {
              setUploadProgress({ fileName, progress });
              console.log(
                `[uploadFile] Progress: ${progress.toFixed(1)}% (${uploadedBytes}/${totalBytes} bytes)`,
              );
            },
            cloudAuthToken,
          });

          if (result.success && result.documentId) {
            await fetchFiles();
            return { success: true, documentId: result.documentId };
          }

          // If it's a scanned PDF, try OCR - check for both error messages
          const isScannedPDF =
            isPDF(file) &&
            (result.error?.includes("No text content") ||
              result.error?.includes("scanned document"));
          console.log(
            "[uploadFile] Chunked upload result:",
            JSON.stringify(result),
          );
          console.log("[uploadFile] isPDF:", isPDF(file), "file:", file.name);
          console.log("[uploadFile] isScannedPDF:", isScannedPDF);
          if (isScannedPDF) {
            console.log(
              "[uploadFile] Chunked upload failed for PDF, trying image conversion...",
            );

            // Convert PDF to images and upload via image RAG (parallel batch upload)
            try {
              setUploadProgress({ fileName: file.name, progress: 10 });

              // Use batch parallel upload - handles PDF conversion and parallel upload internally
              const result = await handleScannedPDFUpload(file, {
                cloudAuthToken,
                onProgress: (fileName: string, progress: number) => {
                  setUploadProgress({
                    fileName: fileName || file.name,
                    progress: 10 + Math.floor(progress * 0.9),
                  });
                },
              });

              setUploadProgress({ fileName: file.name, progress: 100 });

              if (result.success) {
                await fetchFiles();
                return { success: true, documentId: result.documentId };
              }
              return {
                success: false,
                error: result.message || "Failed to upload PDF pages as images",
              };
            } catch (err) {
              return {
                success: false,
                error: `PDF OCR failed: ${err instanceof Error ? err.message : "Unknown error"}`,
              };
            }
          }

          return {
            success: false,
            error: result.error || "Chunked upload failed",
          };
        }

        // Normal upload (small files)
        console.log(
          `[uploadFile] Using normal upload for ${file.name} (${file.size} bytes)`,
        );

        const formData = new FormData();
        formData.append("file", file);

        if (cloudAuthToken) {
          formData.append("cloudAuthToken", cloudAuthToken);
          console.log("[uploadFile] Using cloudAuthToken for authentication");
        }

        setUploadProgress({ fileName: file.name, progress: 50 });

        const response = await fetch("/api/rag/upload", {
          method: "POST",
          body: formData,
        });

        setUploadProgress({ fileName: file.name, progress: 100 });

        if (!response.ok) {
          const data: UploadResponse = await response.json();

          // If it's a scanned PDF (no text extracted), try OCR
          if (
            isPDF(file) &&
            (data.error?.includes("No text content could be extracted") ||
              data.error?.includes("scanned document"))
          ) {
            console.log("[uploadFile] PDF has no text layer, trying OCR...");

            try {
              setUploadProgress({ fileName: file.name, progress: 10 });

              // Convert PDF pages to images
              const { images } = await convertPDFToImages(file, {
                onProgress: (current: number, total: number) => {
                  setUploadProgress({
                    fileName: file.name,
                    progress: 10 + Math.floor((current / total) * 60),
                  });
                },
              });

              console.log(
                "[uploadFile] Converted PDF to",
                images.length,
                "images, uploading via image RAG pipeline...",
              );

              // Upload each page as an image via existing image RAG pipeline
              const documentIds: string[] = [];
              for (let i = 0; i < images.length; i++) {
                const image = images[i];

                setUploadProgress({
                  fileName: file.name,
                  progress: 70 + Math.floor(((i + 1) / images.length) * 30),
                });

                // Use existing image upload RAG pipeline
                const result = await uploadRagFile(image, { cloudAuthToken });

                if (result.success && result.documentId) {
                  documentIds.push(result.documentId);
                } else {
                  console.error(
                    "[uploadFile] Failed to upload page",
                    i + 1,
                    result,
                  );
                }
              }

              setUploadProgress({ fileName: file.name, progress: 100 });

              if (documentIds.length > 0) {
                await fetchFiles();
                return {
                  success: true,
                  documentId: documentIds[0], // Return first document ID
                };
              }

              return {
                success: false,
                error: "Failed to upload PDF pages as images",
              };
            } catch (ocrError) {
              console.error(
                "[uploadFile] PDF to image conversion failed:",
                ocrError,
              );
              return {
                success: false,
                error:
                  "PDF is a scanned document and image conversion failed. Please convert it to a text-based PDF or extract text manually.",
              };
            }
          }

          return {
            success: false,
            error: data.error || "Failed to upload file",
          };
        }

        const data: UploadResponse = await response.json();

        if (data.success && data.documentId) {
          await fetchFiles();
          return { success: true, documentId: data.documentId };
        }

        return { success: false, error: data.error || "Upload failed" };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to upload file";
        setError(message);
        console.error("Failed to upload file:", err);
        return { success: false, error: message };
      } finally {
        setIsUploading(false);
        setUploadProgress(null);
      }
    },
    [fetchFiles],
  );

  /**
   * Get document details (including content)
   */
  const fetchFileDetail = useCallback(
    async (documentId: string): Promise<KnowledgeFileDetail | null> => {
      try {
        const response = await fetch(`/api/rag/documents/${documentId}`);

        if (!response.ok) {
          const data: DocumentDetailResponse = await response.json();
          throw new Error(data.error || "Failed to fetch document");
        }

        const data: DocumentDetailResponse = await response.json();

        return data.document || null;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fetch document";
        setError(message);
        console.error("Failed to fetch file detail:", err);
        return null;
      }
    },
    [],
  );

  /**
   * Delete document
   */
  const deleteFile = useCallback(
    async (documentId: string): Promise<boolean> => {
      setError(null);

      try {
        const response = await fetch(`/api/rag/documents/${documentId}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          const data: DeleteResponse = await response.json();
          throw new Error(data.error || "Failed to delete document");
        }

        // Remove from local state
        setFiles((prev) => prev.filter((file) => file.id !== documentId));

        return true;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to delete document";
        setError(message);
        console.error("Failed to delete file:", err);
        return false;
      }
    },
    [],
  );

  /**
   * Fetch file list when component mounts
   */
  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  return {
    files,
    isLoading,
    error,
    isUploading,
    uploadProgress,
    fetchFiles,
    uploadFile,
    fetchFileDetail,
    deleteFile,
    clearError: () => setError(null),
  };
}
