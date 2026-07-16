/**
 * TUS-style chunked upload for images
 * Used for large images that exceed Vercel's 4.5MB request body limit
 *
 * The upload lands in the local `/api/ai/v1/upload` route, which stores
 * the bytes in the local backend's storage. No cloud hop.
 */
import { getAuthToken } from "@/lib/auth/token-manager";

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB - stays under Vercel's 4.5MB body limit

// Unified threshold: files larger than this use TUS chunked upload.
// 400KB stays well under Vercel's 4.5MB body limit and protects small images too.
export const TUS_SIZE_THRESHOLD = 400 * 1024;

export function isImageFile(mediaType?: string): boolean {
  return mediaType?.startsWith("image/") ?? false;
}

export interface TusUploadOptions {
  signal?: AbortSignal;
  onUploadCreated?: (uploadId: string) => void;
}

/**
 * Upload an image file using TUS-style chunked upload
 * Returns the blob URL that can be used to retrieve the uploaded file
 */
export async function uploadImageTUS(
  file: File,
  maxRetriesOrOptions: number | TusUploadOptions = 3,
  maybeOptions?: TusUploadOptions,
): Promise<string | null> {
  const maxRetries =
    typeof maxRetriesOrOptions === "number" ? maxRetriesOrOptions : 3;
  const options =
    typeof maxRetriesOrOptions === "number"
      ? maybeOptions
      : maxRetriesOrOptions;
  const signal = options?.signal;
  const onUploadCreated = options?.onUploadCreated;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 1. Create upload session
      const headers: HeadersInit = {
        "Upload-Length": String(file.size),
      };

      const cloudToken = getAuthToken();
      if (cloudToken) {
        headers.Authorization = `Bearer ${cloudToken}`;
      }

      const createRes = await fetch("/api/ai/v1/upload", {
        method: "POST",
        credentials: "include",
        headers,
      });
      if (!createRes.ok) {
        const errorBody = await createRes.text();
        console.error(
          "[TUS] Failed to create upload session:",
          createRes.status,
          errorBody,
        );
        if (attempt < maxRetries) continue;
        return null;
      }

      const location = createRes.headers.get("Location");
      if (!location) {
        console.error("[TUS] No Location header in upload session response");
        console.log(
          "[TUS] Response headers:",
          Array.from(createRes.headers.entries()),
        );
        if (attempt < maxRetries) continue;
        return null;
      }

      const uploadId = location.split("uploadId=")[1];
      if (!uploadId) {
        console.error(
          "[TUS] Could not extract uploadId from Location:",
          location,
        );
        if (attempt < maxRetries) continue;
        return null;
      }
      console.log(
        `[TUS] Created upload session: ${uploadId} (attempt ${attempt}/${maxRetries})`,
      );
      onUploadCreated?.(uploadId);

      // 2. Upload chunks
      let offset = 0;
      let chunkFailed = false;
      let chunkIndex = 0;
      while (offset < file.size) {
        const chunk = file.slice(offset, offset + CHUNK_SIZE);
        const chunkBuffer = await chunk.arrayBuffer();

        const chunkHeaders: HeadersInit = {
          "Upload-Offset": String(offset),
          "Content-Length": String(chunkBuffer.byteLength),
          "Content-Type": "application/offset+octet-stream",
        };

        const chunkToken = getAuthToken();
        if (chunkToken) {
          chunkHeaders.Authorization = `Bearer ${chunkToken}`;
        }

        const patchRes = await fetch(`/api/ai/v1/upload?uploadId=${uploadId}`, {
          method: "PATCH",
          credentials: "include",
          headers: chunkHeaders,
          body: chunkBuffer,
        });

        if (!patchRes.ok) {
          const errorBody = await patchRes.text();
          console.error(
            `[TUS] Chunk ${chunkIndex} upload failed: ${patchRes.status}, offset: ${offset}`,
            errorBody,
          );
          chunkFailed = true;
          break;
        }

        offset += chunkBuffer.byteLength;
        chunkIndex++;
      }

      if (chunkFailed) {
        if (attempt < maxRetries) continue;
        return null;
      }

      console.log(`[TUS] All chunks uploaded successfully: ${uploadId}`);

      // 3. Return a relative URL pointing at the local upload route so
      // upstream providers (e.g. OpenRouter) can fetch the uploaded
      // bytes via the same Tauri webview origin.
      return `/api/ai/v1/upload?uploadId=${uploadId}`;
    } catch (err) {
      console.error(
        `[TUS] Upload error (attempt ${attempt}/${maxRetries}):`,
        err,
      );
      if (attempt < maxRetries) continue;
      return null;
    }
  }
  return null;
}
