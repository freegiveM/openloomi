import JSZip from "jszip";

/**
 * Extract iCloud preview PDF from Apple files (.pages, .numbers, .keynote)
 *
 * Apple files are actually ZIP format, with the preview PDF located at QuickLook/Preview.pdf
 *
 * @param arrayBuffer - ArrayBuffer of the file
 * @returns Preview PDF as Uint8Array, or null if not found
 */
export async function extractApplePreviewPdf(
  arrayBuffer: ArrayBufferLike,
): Promise<Uint8Array | null> {
  try {
    // Ensure a separate ArrayBuffer copy is created (JSZip does not support SharedArrayBuffer)
    const source = new Uint8Array(arrayBuffer);
    const buffer = new ArrayBuffer(source.byteLength);
    new Uint8Array(buffer).set(source);

    const zip = await JSZip.loadAsync(buffer);

    // Locate the preview PDF file path
    const previewPath = "QuickLook/Preview.pdf";
    const previewFile = zip.file(previewPath);

    if (!previewFile) {
      console.warn(
        "[ApplePreview] No preview PDF found in file. Paths:",
        Object.keys(zip.files),
      );
      return null;
    }

    const pdfData = await previewFile.async("uint8array");
    return pdfData;
  } catch (error) {
    console.error("[ApplePreview] Failed to extract preview PDF:", error);
    return null;
  }
}

/**
 * Check if a file is an Apple document format
 */
export function isAppleDocumentFile(filename: string): boolean {
  const ext = filename.toLowerCase().split(".").pop();
  return ["pages", "numbers", "keynote"].includes(ext || "");
}

/**
 * Map an Apple iWork filename to its canonical MIME type, or `null` if the
 * extension is not iWork.
 */
export function getAppleIWorkMime(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pages")) return "application/vnd.apple.pages";
  if (lower.endsWith(".numbers")) return "application/vnd.apple.numbers";
  if (lower.endsWith(".key") || lower.endsWith(".keynote")) {
    return "application/vnd.apple.keynote";
  }
  return null;
}

/**
 * Sniff whether the input starts with the standard ZIP local-file-header magic
 * (`PK\x03\x04`).
 */
export async function isLikelyZipFile(
  input: Blob | Uint8Array,
): Promise<boolean> {
  let head: Uint8Array;
  if (input instanceof Uint8Array) {
    if (input.byteLength < 4) return false;
    head = input.subarray(0, 4);
  } else {
    if (input.size < 4) return false;
    head = new Uint8Array(await input.slice(0, 4).arrayBuffer());
  }
  return (
    head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
  );
}
