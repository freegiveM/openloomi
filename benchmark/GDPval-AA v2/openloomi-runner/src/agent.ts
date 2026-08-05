/**
 * OpenLoomi native-agent SSE client for GDPval-AA v2.
 *
 * Strictly aligned with the official v2 submission spec:
 *   - 6 tools in the harness (WebFetch, WebSearch, ViewImage, Bash) — but
 *     OpenLoomi has no first-class "finish" / "abandon_task_finish" tools,
 *     so we emulate them via a text protocol: the model emits a final
 *     assistant message containing the magic tokens `<<<FINISH>>>` /
 *     `<<<ABANDON>>>` followed by an absolute-path list. We parse that out
 *     of the SSE stream and copy the listed files into the deliverable
 *     archive.
 *   - System prompt + task prompt come from
 *     `scripts/prompts/prompt_builder.py` (a verbatim copy of the official
 *     AA methodology-page text).
 *   - Reference files for the task are pre-staged under the workDir by
 *     `index.ts` and forwarded to `/api/native/agent` as `fileAttachments`
 *     so they land in the workDir the same way Stirrup injects them into
 *     the E2B sandbox.
 *   - Turn cap = 250 (matches v2). The client counts `tool_use` events and
 *     aborts the request when the cap is hit.
 */

import {
  existsSync,
  readFile,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import net from "node:net";

import type { GDPvalAADeliverable, GDPvalAAPrediction } from "./types";

export const DEFAULT_PORTS = [3515];
export const DEFAULT_HOST = "127.0.0.1";

/** Official v2 turn cap. */
export const OFFICIAL_TURN_CAP = 250;

/** Magic tokens we ask the model to emit in place of real `finish` /
 * `abandon_task_finish` tool calls (OpenLoomi doesn't expose either). */
export const FINISH_TOKEN = "<<<FINISH>>>";
export const ABANDON_TOKEN = "<<<ABANDON>>>";

/** Default tool set trimmed to v2's six (we treat the missing `finish` and
 *  `abandon_task_finish` as text-protocols and don't list them in
 *  `allowedTools`). */
export const V2_TOOL_SET = [
  "WebFetch",
  "WebSearch",
  "ViewImage",
  "Bash",
] as const;

export interface AgentStreamHandle {
  text: string;
  tool_calls: string[];
  /** Deliverables from the v2 finish text-protocol (absolute paths). */
  submitted_paths: string[];
  /** True if the model emitted ABANDON_TOKEN instead of FINISH. */
  abandoned: boolean;
  abandon_reason: string | null;
  /** All deliverable files (with hash + size) that the harness reported. */
  deliverables: GDPvalAADeliverable[];
  usage?: { input_tokens: number; output_tokens: number };
  session_id?: string;
  turn_count: number;
  result_event_seen: boolean;
  truncated: boolean;
}

export interface CallAgentOptions {
  port: number;
  host?: string;
  authToken?: string;
  prompt: string;
  systemPrompt?: string;
  workDir: string;
  provider: string;
  model: string;
  permissionMode?:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
    | "dontAsk";
  allowedTools?: string[];
  /** Reference files pre-staged into the workDir before the agent starts. */
  fileAttachments?: Array<{
    name: string;
    data: string;
    mimeType: string;
  }>;
  /** v2 spec: 250 turns. */
  maxTurns?: number;
  /** Per-task wall-clock budget including network + finish parsing. */
  timeoutMs?: number;
}

export async function findAvailablePort(
  ports: number[] = DEFAULT_PORTS,
): Promise<number> {
  for (const port of ports) {
    const taken = await checkPortInUse(port);
    if (taken) return port;
  }
  throw new Error(
    `No OpenLoomi API server found on ports ${ports.join(", ")}. Start \`pnpm tauri:dev\` (or the web dev server) first.`,
  );
}

function checkPortInUse(port: number): Promise<boolean> {
  return new Promise((resolveP) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => {
      socket.destroy();
      resolveP(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolveP(false);
    });
    socket.on("error", () => resolveP(false));
    socket.connect(port, "127.0.0.1");
  });
}

export function readAuthToken(tokenPath?: string): string | undefined {
  const filePath = tokenPath ?? join(homedir(), ".openloomi", "token");
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

function guessMimeType(extension: string): string {
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".html": "text/html",
    ".py": "text/x-python",
    ".ts": "text/typescript",
    ".js": "text/javascript",
  };
  return map[extension.toLowerCase()] ?? "application/octet-stream";
}

function sha256File(path: string): string {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

function buildDeliverable(
  workdir: string,
  workdirRelative: string,
): GDPvalAADeliverable | null {
  const absolute = isAbsolute(workdirRelative)
    ? workdirRelative
    : resolve(workdir, workdirRelative);
  if (!existsSync(absolute)) return null;
  const stat = statSync(absolute);
  if (!stat.isFile()) return null;
  return {
    workdir_path: toWorkdirRelative(workdir, absolute),
    size_bytes: stat.size,
    sha256: sha256File(absolute),
    mime_type: guessMimeType(extname(absolute)),
  };
}

function toWorkdirRelative(workdir: string, absolute: string): string {
  const abs = resolve(absolute);
  const wd = resolve(workdir);
  if (abs === wd) return ".";
  const prefix = wd.endsWith(sep) ? wd : wd + sep;
  if (abs.startsWith(prefix)) return abs.slice(prefix.length);
  // Different drives on Windows: fall back to basename.
  return abs.split(/[\\/]/).pop() ?? abs;
}

interface AgentMessageEvent {
  type?: string;
  content?: string;
  text?: string;
  name?: string;
  id?: string;
  sessionId?: string;
  runEpoch?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  tool_result?: { fileSnapshots?: Record<string, string> };
  fileSnapshots?: Record<string, string>;
  message?: string;
}

/**
 * Drain a single SSE stream from `/api/native/agent` into structured data.
 *
 * The OpenLoomi server emits `data: {…}\n\n` frames for every AgentMessage
 * (see apps/web/app/api/native/agent/route.ts). The `result` event signals
 * end-of-stream. Tool results carry an optional `fileSnapshots` object
 * mapping generated file paths → snapshot paths.
 */
export async function callOpenLoomiAgent(
  options: CallAgentOptions,
): Promise<AgentStreamHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (options.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }

  const requestBody: Record<string, unknown> = {
    prompt: options.prompt,
    provider: options.provider,
    permissionMode: options.permissionMode ?? "bypassPermissions",
    platform: "benchmark-gdpval-aa-v2",
    workDir: options.workDir,
    // Don't let OpenLoomi wrap workDir in a session sub-folder; we manage
    // the per-task workDir ourselves so file paths stay predictable and
    // match the v2 spec ("absolute paths under /home/user").
    useProvidedWorkDir: true,
    taskId: options.workDir,
    modelConfig: { model: options.model },
  };
  if (options.systemPrompt) {
    requestBody.aiSoulPrompt = options.systemPrompt;
  }
  const allowed = options.allowedTools ?? [...V2_TOOL_SET];
  requestBody.allowedTools = allowed;
  if (options.fileAttachments && options.fileAttachments.length > 0) {
    requestBody.fileAttachments = options.fileAttachments;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("OpenLoomi agent timeout")),
    options.timeoutMs ?? 30 * 60_000,
  );

  let response: Response;
  try {
    response = await fetch(`http://${host}:${options.port}/api/native/agent`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw error instanceof Error ? error : new Error(String(error));
  }

  if (!response.ok) {
    clearTimeout(timer);
    const errText = await response.text();
    throw new Error(
      `OpenLoomi agent API returned ${response.status} ${response.statusText}: ${errText}`,
    );
  }
  if (!response.body) {
    clearTimeout(timer);
    throw new Error("OpenLoomi agent API response had no body");
  }

  const handle: AgentStreamHandle = {
    text: "",
    tool_calls: [],
    submitted_paths: [],
    abandoned: false,
    abandon_reason: null,
    deliverables: [],
    turn_count: 0,
    result_event_seen: false,
    truncated: false,
  };

  const maxTurns = options.maxTurns ?? OFFICIAL_TURN_CAP;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let idleAt = Date.now();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      idleAt = Date.now();
      buffer += decoder.decode(value, { stream: true });

      // Split on SSE record boundaries.
      const sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const record = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const events = parseSSERecord(record);
        for (const ev of events) {
          handleEvent(ev, options.workDir, handle, maxTurns);
          if (handle.result_event_seen || handle.truncated) {
            break;
          }
        }
        if (handle.result_event_seen || handle.truncated) break;
      }
      if (handle.result_event_seen || handle.truncated) break;

      // Defensive idle watchdog: 10 minutes with no chunks = assume stuck.
      if (Date.now() - idleAt > 10 * 60_000) {
        break;
      }
    }
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      // Fallthrough; treat as finished.
    } else {
      throw error;
    }
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  // After the stream is done, parse the v2 finish text protocol.
  parseFinishProtocol(handle);

  // Dedupe deliverables (multiple tool results may reference the same file).
  handle.deliverables = dedupeDeliverables(handle.deliverables);
  return handle;
}

function parseSSERecord(record: string): AgentMessageEvent[] {
  const events: AgentMessageEvent[] = [];
  for (const rawLine of record.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const jsonStr = line.slice(5).trim();
    if (!jsonStr || jsonStr === "[DONE]") continue;
    try {
      events.push(JSON.parse(jsonStr) as AgentMessageEvent);
    } catch {
      // ignore malformed lines
    }
  }
  return events;
}

function handleEvent(
  event: AgentMessageEvent,
  workDir: string,
  handle: AgentStreamHandle,
  maxTurns: number,
): void {
  if (event.sessionId) {
    handle.session_id = event.sessionId;
  }
  switch (event.type) {
    case "text":
    case "direct_answer":
      if (typeof event.content === "string") handle.text += event.content;
      break;
    case "tool_use":
      if (typeof event.name === "string") handle.tool_calls.push(event.name);
      handle.turn_count += 1;
      if (handle.turn_count > maxTurns) {
        handle.truncated = true;
        handle.result_event_seen = true;
      }
      break;
    case "tool_result": {
      const snapshots =
        event.fileSnapshots ?? event.tool_result?.fileSnapshots ?? {};
      for (const [filePath, snapshotPath] of Object.entries(snapshots)) {
        const deliverable = buildDeliverable(workDir, filePath);
        if (deliverable) {
          deliverable.snapshot_path = snapshotPath;
          handle.deliverables.push(deliverable);
        }
      }
      break;
    }
    case "result": {
      handle.result_event_seen = true;
      if (event.usage) {
        handle.usage = {
          input_tokens: event.usage.inputTokens ?? 0,
          output_tokens: event.usage.outputTokens ?? 0,
        };
      }
      if (typeof event.content === "string" && event.content) {
        handle.text += event.content;
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Parse the official v2 `finish` / `abandon_task_finish` text protocol from
 * the accumulated assistant text.
 *
 * The model emits a final assistant message that contains:
 *
 *     <<<FINISH>>>
 *     <one-line summary>
 *     <abs path 1>
 *     <abs path 2>
 *     ...
 *
 * or
 *
 *     <<<ABANDON>>>
 *     <reason>
 *
 * Because OpenLoomi has no native finish tool, this is the only reliable way
 * to recover v2's "absolute file paths in the finish call" contract.
 */
export function parseFinishProtocol(handle: AgentStreamHandle): void {
  const text = handle.text;
  const finishIdx = text.lastIndexOf(FINISH_TOKEN);
  const abandonIdx = text.lastIndexOf(ABANDON_TOKEN);

  if (abandonIdx !== -1 && (finishIdx === -1 || abandonIdx > finishIdx)) {
    handle.abandoned = true;
    const tail = text
      .slice(abandonIdx + ABANDON_TOKEN.length)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    handle.abandon_reason = tail[0] ?? "(no reason given)";
    return;
  }
  if (finishIdx === -1) return;

  const tail = text
    .slice(finishIdx + FINISH_TOKEN.length)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // First non-empty line is the summary; everything after is paths.
  for (let i = 1; i < tail.length; i++) {
    const line = tail[i];
    // Accept both POSIX and Windows absolute paths.
    if (/^([/\\]|[A-Za-z]:[/\\])/.test(line)) {
      handle.submitted_paths.push(line);
    }
  }
}

function dedupeDeliverables(
  items: GDPvalAADeliverable[],
): GDPvalAADeliverable[] {
  const seen = new Map<string, GDPvalAADeliverable>();
  for (const item of items) {
    const key = `${item.workdir_path}::${item.sha256}`;
    const existing = seen.get(key);
    if (existing) {
      if (!existing.snapshot_path && item.snapshot_path) {
        existing.snapshot_path = item.snapshot_path;
      }
      continue;
    }
    seen.set(key, item);
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// v2 prompt assembly
// ---------------------------------------------------------------------------

export interface OfficialPrompts {
  system_prompt: string;
  task_prompt: string;
}

// Resolve from this file: src/agent.ts -> ../scripts/prompts/prompt_builder.py
// `import.meta.url` is `file:///D:/.../src/agent.ts`; we want a real
// filesystem path. The simplest portable way that works on Windows + POSIX
// is to take `import.meta.url` (which is always an absolute file:// URL)
// and run the standard `fileURLToPath` shim — implemented inline so we
// don't pull in a `node:url` import that `tsc --noEmit` may not see in a
// sandbox `lib: ["ES2022"]` config.
function _fileURLToPathShim(url: string): string {
  if (!url.startsWith("file://")) return url;
  // `import.meta.url` may contain percent-encoded characters (e.g. a
  // folder named "GDPval-AA v2" becomes "GDPval-AA%20v2"); decode them
  // before the path is passed to anything that needs a real filesystem
  // path.
  const rest = (() => {
    try {
      return decodeURIComponent(url.slice("file://".length));
    } catch {
      return url.slice("file://".length);
    }
  })();
  // UNC paths: file://server/share -> \\server\share
  if (rest.startsWith("//")) {
    return rest.replace(/\//g, "\\");
  }
  // Windows: file:///D:/foo -> D:/foo (and the leading slash is dropped).
  if (/^\/[A-Za-z]:/.test(rest)) {
    return rest.slice(1);
  }
  return rest;
}

// We `dirname` first to drop the file portion, then walk `..` up one
// directory. `resolve` (not `join`) normalises `..` segments, and we
// explicitly split on both `/` and `\` so the path is always in the
// platform-native form before passing it to `path.dirname`.
const PROMPT_BUILDER_SCRIPT = resolve(
  dirname(_fileURLToPathShim(import.meta.url)),
  "..",
  "scripts",
  "prompts",
  "prompt_builder.py",
);

/**
 * Invoke the official Python prompt builder and return the v2 system +
 * task prompts. We use Python (not an in-process re-implementation) so the
 * text matches the official AA methodology-page copy verbatim — when AA
 * updates the prompts upstream, just edit `prompt_builder.py`.
 */
export function buildOfficialPrompts(
  taskPrompt: string,
  referenceFiles: string[],
): OfficialPrompts {
  const args = [
    PROMPT_BUILDER_SCRIPT,
    "--task-prompt",
    taskPrompt,
    ...(referenceFiles.length > 0
      ? ["--reference-files", ...referenceFiles]
      : []),
  ];
  const result = spawnSync("python", args, {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(
      `Failed to launch prompt_builder.py: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `prompt_builder.py exited ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  const stdout = (result.stdout || "").trim();
  if (!stdout.startsWith("{")) {
    throw new Error(
      `prompt_builder.py produced unexpected output: ${stdout.slice(0, 200)}`,
    );
  }
  return JSON.parse(stdout) as OfficialPrompts;
}

// ---------------------------------------------------------------------------
// Reference file injection
// ---------------------------------------------------------------------------

/** Pre-staged reference file paths inside the workDir (forward-slashed
 *  relative paths, as required by `fileAttachments.name`). */
export interface ReferenceFileAttachment {
  name: string;
  dataBase64: string;
  mimeType: string;
  /** Absolute on-disk path so we can later verify it landed. */
  absolutePath: string;
}

/**
 * Read every reference file from disk and base64-encode it for
 * `fileAttachments`. The file *contents* are sent in the request body so
 * the OpenLoomi server can write them to workDir; we never trust the model
 * to fetch them itself.
 */
export function loadReferenceAttachments(
  paths: string[],
): ReferenceFileAttachment[] {
  const out: ReferenceFileAttachment[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const buf = readFileSync(p);
    const name = p.split(/[\\/]/).pop() || "file";
    out.push({
      name,
      dataBase64: buf.toString("base64"),
      mimeType: guessMimeType(extname(p)),
      absolutePath: resolve(p),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Finish-protocol post-processing
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute paths the model declared in the finish protocol into
 * `GDPvalAADeliverable` records. Paths that don't exist on disk are
 * dropped; paths inside the workDir are stored relative to it; paths
 * outside are stored as absolute.
 */
export function buildFinishDeliverables(
  workDir: string,
  submitted: string[],
): GDPvalAADeliverable[] {
  const out: GDPvalAADeliverable[] = [];
  for (const p of submitted) {
    const abs = isAbsolute(p) ? p : resolve(workDir, p);
    if (!existsSync(abs)) continue;
    const stat = statSync(abs);
    if (!stat.isFile()) continue;
    out.push({
      workdir_path: toWorkdirRelative(workDir, abs),
      size_bytes: stat.size,
      sha256: sha256File(abs),
      mime_type: guessMimeType(extname(abs)),
    });
  }
  return dedupeDeliverables(out);
}

export function summariseHandle(
  taskId: string,
  taskPrompt: string,
  metadata: Record<string, unknown> | undefined,
  workDir: string,
  startMs: number,
  handle: AgentStreamHandle,
  archive: (rel: string) => string | undefined,
): GDPvalAAPrediction {
  const duration = Date.now() - startMs;
  return {
    task_id: taskId,
    prompt: taskPrompt,
    response: handle.text,
    metadata,
    work_dir: workDir,
    deliverables: handle.deliverables.map((d) => ({
      ...d,
      archive_path: archive(d.workdir_path),
    })),
    tool_calls: handle.tool_calls,
    turn_count: handle.turn_count,
    session_id: handle.session_id,
    duration_ms: duration,
    usage: handle.usage,
  };
}

/** Helper to dump a finish-protocol example to a tmp file for debugging. */
export function dumpDebugArtifact(path: string, payload: unknown): void {
  try {
    writeFileSync(path, JSON.stringify(payload, null, 2));
  } catch {
    // best-effort
  }
}

export { readFile };
