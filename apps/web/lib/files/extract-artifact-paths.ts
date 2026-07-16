/**
 * Parses absolute paths of "previewable generated files" from Agent tool output or assistant messages.
 * Supports both macOS/Linux (/Users/...) and Windows (C:\Users\..., with / and \ intermixed in paths).
 *
 * The matcher is intentionally conservative (#354): we only treat a path as a generated
 * artifact when it lands in a location OpenLoomi itself manages (a session dir, the local
 * memory dir, or Desktop) AND it isn't a known read-only/internal location (plugin sources,
 * node_modules, .git, build output, …). Anything else is treated as a path the agent merely
 * referenced, not a file the user can preview.
 */

const ARTIFACT_EXT =
  "pptx|pdf|xlsx|docx|py|js|ts|tsx|jsx|html|htm|md|mmark|txt|json";

/**
 * Path boundary: lookahead match that excludes separators (including Markdown backticks `) from the match result,
 * preventing dirty characters like "MD" in subtitles.
 */
const PATH_BOUNDARY = "(?=\\s|\\)|$|\\'|\\\"|\\u0060|,|\\]|\\}|\\|)";

/**
 * Returns the last segment (filename) of a path (compatible with Windows and POSIX).
 */
export function artifactPathBasename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/**
 * Extracts a clean extension (lowercase, alphanumeric only) from filename or type field, for use in icons and subtitles.
 */
export function sanitizeArtifactFileExtension(raw: string): string {
  const base = (raw || "").replace(/^\./, "").toLowerCase();
  const letters = base.replace(/[^a-z0-9]/g, "");
  return letters.slice(0, 16);
}

/**
 * Removes erroneously captured trailing punctuation (double protection, compatible with legacy data).
 */
export function normalizeExtractedArtifactPath(raw: string): string {
  let s = raw.trim().replace(/[()\s]+$/g, "");
  s = s.replace(/[`'"\s|\\),}\]]+$/g, "");
  return s;
}

/**
 * Directories that are clearly read-only with respect to the chat session: plugin sources,
 * dependency trees, build output, VCS metadata. A path that lives inside one of these is a
 * reference, never a generated artifact — even if the regex would otherwise accept it
 * (e.g. /Users/me/codes/openloomi/plugins/claude/skills/foo/SKILL.md).
 */
const READ_ONLY_PATH_SEGMENTS = [
  // Plugin / skill sources — both the openloomi plugin tree and any user-installed skill.
  "/plugins/",
  "/skills/",
  "/.claude/",
  // Dependency + build output.
  "/node_modules/",
  "/.git/",
  "/.next/",
  "/dist/",
  "/build/",
  "/target/",
  "/out/",
  // Application source trees (reading source files for context shouldn't surface as artifacts).
  "/src/",
  "/source/",
  "/app/",
];

/**
 * Returns true when `path` lives inside a known read-only/internal location. Match is case
 * insensitive and uses forward slashes so Windows paths (`C:\...\plugins\...`) work.
 */
export function isReadOnlyArtifactPath(path: string): boolean {
  if (!path) return false;
  const norm = path.replace(/\\/g, "/").toLowerCase();
  return READ_ONLY_PATH_SEGMENTS.some((seg) => norm.includes(seg));
}

/**
 * Returns true when `candidate` appears on a line that looks like part of a stack trace
 * (JS `at …`, Python `File "…"`, or Ruby `…:in …`). Paths quoted inside tracebacks aren't
 * artifacts — they're incidental mentions of where an exception was raised.
 */
export function isInsideStackTrace(text: string, candidate: string): boolean {
  if (!text || !candidate) return false;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!line.includes(candidate)) continue;
    if (trimmed.startsWith("at ")) return true;
    if (trimmed.startsWith('File "')) return true;
    // Ruby / Perl: "<path>:<line>:in `<method>'"
    if (/^\S+\.\w+:\d+:.+in /.test(trimmed)) return true;
  }
  return false;
}

function buildArtifactPathPatterns(): RegExp[] {
  const ext = ARTIFACT_EXT;
  const b = PATH_BOUNDARY;
  return [
    new RegExp(`/Users/[^/\\\\]+/Desktop/.+?\\.(${ext})${b}`, "gi"),
    new RegExp(
      `/Users/[^/\\\\]+/\\.openloomi/data/memory/.+?\\.(${ext})${b}`,
      "gi",
    ),
    new RegExp(
      `/Users/[^/\\\\]+/\\.openloomi/sessions/[^/\\\\]+(?:/[^/\\\\]+)?/.+?\\.(${ext})${b}`,
      "gi",
    ),
    new RegExp(
      `[A-Za-z]:(?:\\\\|/)Users(?:\\\\|/)[^/\\\\\\n\\r]+(?:\\\\|/)Desktop(?:\\\\|/).+?\\.(${ext})${b}`,
      "gi",
    ),
    new RegExp(
      `[A-Za-z]:(?:\\\\|/)Users(?:\\\\|/)[^/\\\\\\n\\r]+(?:\\\\|/)\\.openloomi(?:\\\\|/)sessions(?:\\\\|/)[^/\\\\\\n\\r]+(?:\\\\|/)(?:[^/\\\\\\n\\r]+(?:\\\\|/))?.+?\\.(${ext})${b}`,
      "gi",
    ),
    new RegExp(
      `[A-Za-z]:(?:\\\\|/)Users(?:\\\\|/)[^/\\\\\\n\\r]+(?:\\\\|/)\\.openloomi(?:\\\\|/)data(?:\\\\|/)memory(?:\\\\|/).+?\\.(${ext})${b}`,
      "gi",
    ),
  ];
}

let cachedPatterns: RegExp[] | null = null;

/**
 * Extracts all matching artifact file absolute paths from text (deduplicated, with trailing
 * noise removed). The matcher only returns paths that:
 *   1. land inside a recognized OpenLoomi-managed drop location (sessions, memory, Desktop);
 *   2. do NOT live inside a read-only location like plugins/, node_modules/, .git/, build/;
 *   3. do NOT appear on a line that looks like a stack trace.
 *
 * Cross-session artifacts remain extractable — the session-rooted regex still matches
 * `~/.openloomi/sessions/<other-taskId>/foo.md`, and the preview resolver from PR #300
 * re-roots them to their owning session.
 */
export function extractArtifactPathsFromText(text: string): string[] {
  if (!text || typeof text !== "string") return [];

  if (cachedPatterns === null) {
    cachedPatterns = buildArtifactPathPatterns();
  }
  const patterns = cachedPatterns;
  const raw: string[] = [];

  for (const p of patterns) {
    const re = new RegExp(p.source, p.flags);
    const matches = text.match(re);
    if (matches?.length) raw.push(...matches);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of raw) {
    const cleaned = normalizeExtractedArtifactPath(m);
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    if (isReadOnlyArtifactPath(cleaned)) continue;
    if (isInsideStackTrace(text, cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/**
 * When multiple paths exist, prefer HTML (consistent with original chat-context behavior), otherwise return the first one.
 */
export function pickPreferredArtifactPath(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const html = paths.find((f) => /\.html?$/i.test(f));
  return html ?? paths[0];
}
