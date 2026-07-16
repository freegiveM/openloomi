import type { ChatMessage } from "@openloomi/shared";
import {
  artifactPathBasename,
  extractArtifactPathsFromText,
  normalizeExtractedArtifactPath,
  sanitizeArtifactFileExtension,
} from "@/lib/files/extract-artifact-paths";

/**
 * Checks if a file path is under the temp/ subdirectory (temporary file)
 */
export function isTemporaryFile(path: string): boolean {
  // Check if path contains /temp/ subdirectory
  // Matches: xxx/temp/xxx or xxx/temp/xxx.ext
  const normalizedPath = path.replace(/\\/g, "/");
  return /\/temp\//i.test(normalizedPath);
}

/**
 * Lifecycle fidelity of a tool output file as observed in the most recent
 * tool-native part that referenced its canonical path. A part whose `status`
 * is `"error"` (or whose `isError` is true) surfaces the file as
 * `"incomplete"` so timed-out / failed runs render an "Incomplete" pill rather
 * than pretending the artifact is final.
 */
export type ToolOutputFileReadiness = "completed" | "incomplete";

/**
 * Classification of a tool output file by purpose:
 *   - `"deliverable"` — final user-facing artifact the assistant was trying to
 *     produce (e.g. a generated report or document).
 *   - `"work"` — intermediate script, scratch file, or anything living under
 *     a `temp/` directory. Visually distinguished via the existing temp badge.
 */
export type ToolOutputFileRole = "deliverable" | "work";

/** Single tool output file display reference (consistent with LibraryItemRow / preview panel) */
export type ToolOutputFileRef = {
  name: string;
  path: string;
  type: string;
  isTemporary?: boolean;
  modifiedTime?: string;
  readiness?: ToolOutputFileReadiness;
  role?: ToolOutputFileRole;
};

type ToolNativePart = {
  type?: string;
  status?: "executing" | "completed" | "error";
  isError?: boolean;
  generatedFile?: { name?: string; path?: string; type?: string };
  codeFile?: { name?: string; path?: string; language?: string };
};

/**
 * Collects previewable generated files from message parts (deduplicated by path):
 * tool-native's generatedFile/codeFile, plus session paths parsed from the body text.
 *
 * Dedup semantics:
 *   - Tool-native parts are processed first, in chronological order (parts
 *     arrive in order from agent-stream-events / chat-context). Because later
 *     parts represent the latest state of the file, we **unconditionally
 *     overwrite** the entry for that path on each occurrence — first-wins
 *     would render stale metadata for Write → Edit → Write sequences.
 *   - The text-blob loop runs second and uses **insert-if-absent**: a plain
 *     text mention of a path must not clobber a structured entry whose
 *     `status` / `isError` fidelity the text blob cannot provide.
 *   - The map key is always the full canonical normalized path, never the
 *     basename, so `…/chat-1/report.md` and `…/chat-2/report.md` stay
 *     distinct.
 */
export function collectToolOutputFilesFromParts(
  parts: ChatMessage["parts"] | undefined,
): ToolOutputFileRef[] {
  if (!parts?.length) return [];
  const byPath = new Map<string, ToolOutputFileRef>();

  for (const part of parts) {
    if ((part as { type?: string }).type !== "tool-native") continue;
    const p = part as ToolNativePart;
    const candidates: Array<{
      name?: string;
      path?: string;
      type?: string;
      language?: string;
      cameFromCodeFile: boolean;
    }> = [];
    if (p.generatedFile) {
      candidates.push({ ...p.generatedFile, cameFromCodeFile: false });
    }
    if (p.codeFile) {
      candidates.push({ ...p.codeFile, cameFromCodeFile: true });
    }

    const readiness: ToolOutputFileReadiness =
      p.status === "completed" && p.isError !== true
        ? "completed"
        : "incomplete";

    for (const f of candidates) {
      const nameRaw = f.name?.trim();
      const pathRaw = f.path?.trim();
      if (!nameRaw || !pathRaw) continue;
      const path = normalizeExtractedArtifactPath(pathRaw);
      const name = nameRaw.replace(/[`'"\s)]+$/, "");
      const type =
        sanitizeArtifactFileExtension(
          f.type || f.language || name.split(".").pop() || "",
        ) || "unknown";
      const isTemp = isTemporaryFile(path);
      // A codeFile that accompanies a generatedFile on the same part is just
      // preview metadata (see chat-context.tsx — generatedFile is the
      // authoritative artifact, codeFile signals "render an inline code
      // preview"). In that case the deliverable classification wins so the
      // latest-wins overwrite for same-path candidates is a no-op.
      const isIntermediateScript = f.cameFromCodeFile && !p.generatedFile;
      const role: ToolOutputFileRole =
        isTemp || isIntermediateScript ? "work" : "deliverable";
      // Latest-wins overwrite: chronological ordering of parts means the most
      // recent metadata for this path is the correct one.
      byPath.set(path, {
        name,
        path,
        type,
        isTemporary: isTemp,
        readiness,
        role,
      });
    }
  }

  const textBlob = parts
    .filter((p) => (p as { type?: string }).type === "text")
    .map((p) => {
      const t = p as { text?: string; content?: string };
      return String(t.text ?? t.content ?? "");
    })
    .join("\n");

  for (const raw of extractArtifactPathsFromText(textBlob)) {
    const path = normalizeExtractedArtifactPath(raw);
    if (!path) continue;
    const name = artifactPathBasename(path).replace(/[`'"\s)]+$/, "");
    const ext =
      sanitizeArtifactFileExtension(name.split(".").pop() || "") || "unknown";
    if (!byPath.has(path)) {
      const isTemp = isTemporaryFile(path);
      byPath.set(path, {
        name,
        path,
        type: ext,
        isTemporary: isTemp,
        readiness: "completed",
        role: isTemp ? "work" : "deliverable",
      });
    }
  }

  return Array.from(byPath.values());
}
