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
  appendFileSync,
  existsSync,
  readdirSync,
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

/** Suffix appended to the v2 system prompt before sending to OpenLoomi.
 *  Tells the model to use the `<<<FINISH>>>` / `<<<ABANDON>>>` text protocol
 *  instead of the missing `finish` / `abandon_task_finish` tools.
 *  Pure additive override; the verbatim v2 system prompt remains untouched
 *  above the suffix. */
export const OPENLOOMI_FINISH_PROTOCOL_SUFFIX = `

[OpenLoomi harness adapter]
This environment does not expose a \`finish\` or \`abandon_task_finish\` tool. To signal completion, end your final assistant message with a text block in this exact form:

<<<FINISH>>>
<one-line summary of what you produced>
<absolute path to deliverable 1>
<absolute path to deliverable 2>

If you cannot complete the task, end with:

<<<ABANDON>>>
<one-line reason>

Use absolute paths only (e.g. \`C:\\\\...\` or \`/home/...\`). Place the marker inline, no extra prose after the path list.`;

/** Default tool set trimmed to v2's six (we treat the missing `finish` and
 *  `abandon_task_finish` as text-protocols and don't list them in
 *  `allowedTools`). */

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
  /**
   * If true (default), fall back to fs polling when the OpenLoomi SSE stream
   * stalls: i.e. fetch() returns a body but no mid-stream frames arrive for
   * `sseStallMs`. In that case we wait for the model to finish by polling
   * `workDir`'s top-level files (mtime) instead of trusting the SSE pipe.
   * Used to work around a Next.js 16 + Turbopack dev bug where the SSE
   * ReadableStream never flushes to the HTTP socket. See
   * HANDOVER_2026-08-07.md §4.3.
   */
  useFsPollingFallback?: boolean;
  /**
   * When the SSE pipe stalls (no new bytes for this long), switch to fs
   * polling. Defaults to 60 s.
   */
  sseStallMs?: number;
  /**
   * When fs polling, declare the task done if no new top-level file appears
   * for this long. Defaults to 120 s.
   */
  fsIdleDoneMs?: number;
  /** Path to the server-only probe log (D:/.../agent_api_probe.log). When
   *  provided, fs polling reads this log to reconstruct approximate
   *  `text / tool_calls / turn_count` from the actual mid-stream events
   *  that the OpenLoomi SSE writer produced but the dev server failed to
   *  forward. Optional. */
  probeLogPath?: string;
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
// ---------------------------------------------------------------------------
// fs polling fallback (HANDOVER_2026-08-07 §4.3)
// ---------------------------------------------------------------------------

/** Files we should never treat as deliverables even when they appear in
 *  the workDir top-level. These are framework / harness artefacts, not the
 *  model's output. The names MUST match the actual on-disk filename
 *  exactly (including the `.log` suffix on the SSE debug log) —
 *  `topLevelSignature` does an exact-string `includes` match. */
const FS_POLLING_IGNORE = [
  ".claude",
  // The Runner itself appends to this debug log every fs-polling
  // iteration, which would otherwise keep changing the top-level
  // signature forever and prevent idle detection from ever firing.
  "_openloomi_sse_debug.log",
  // Reference files the harness pre-staged into workDir; they're inputs,
  // not deliverables. The runner snapshots them separately via
  // `fileAttachments`. Both the un-encoded and percent-encoded forms are
  // listed because OpenLoomi's file-attachment layer normalises names
  // inconsistently across runs.
  "Population_v2.xlsx",
  "Population%20v2.xlsx",
  "Population v2.xlsx",
];

/** Subdirectories we should NOT recurse into when collecting
 *  deliverables. `.claude` is the OpenLoomi internal session state.
 *  `node_modules` / `.next` could appear if a build tool ran locally. */
const FS_POLLING_IGNORE_DIRS = [".claude", "node_modules", ".next"];

/** Return the top-level mtime signature of `workDir` (sorted list of
 *  `<mtimeMs>::<name>`). Used to detect "no new file" by comparing two
 *  consecutive signatures. The `ignoreNames` list lets callers filter out
 *  harness artefacts (e.g. the SSE debug log that this very module is
 *  appending to on every iteration — without filtering, the signature
 *  changes every poll and idle detection never fires). */
export function topLevelSignature(
  workDir: string,
  ignoreNames: ReadonlyArray<string> = [],
): string {
  let entries: { name: string; mtimeMs: number }[];
  try {
    entries = readdirSync(workDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .filter((e) => !ignoreNames.includes(e.name))
      .map((e) => {
        const full = join(workDir, e.name);
        try {
          return { name: e.name, mtimeMs: statSync(full).mtimeMs };
        } catch {
          return { name: e.name, mtimeMs: 0 };
        }
      });
  } catch {
    entries = [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries.map((e) => `${e.mtimeMs.toFixed(0)}::${e.name}`).join("\n");
}

/** Recursive signature: walks every subdirectory (except `ignoreDirs`) and
 *  emits one line per file: `<mtimeMs>::<relativePath>`. Relative paths use
 *  forward slashes so the signature is identical on Windows + POSIX.
 *  Files matching `ignoreFiles` are skipped so harness artefacts (notably
 *  the SSE debug log this very module is appending to on every poll) don't
 *  keep the idle-detection clock from ever firing.
 *  Used by the fs-polling idle-detection loop, which previously only
 *  watched the workDir top-level and therefore missed deliverables the
 *  model wrote into e.g. `temp/`, `assets/footage/`, `output/`. See
 *  HANDOVER §12 finding #1. */
export function recursiveSignature(
  workDir: string,
  ignoreDirs: ReadonlyArray<string> = FS_POLLING_IGNORE_DIRS,
  ignoreFiles: ReadonlyArray<string> = FS_POLLING_IGNORE,
): string {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string) => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of dirents) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ignoreDirs.includes(ent.name)) continue;
        walk(join(dir, ent.name), rel);
        continue;
      }
      if (!ent.isFile()) continue;
      if (ignoreFiles.includes(ent.name)) continue;
      const full = join(dir, ent.name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      lines.push(`${mtimeMs.toFixed(0)}::${rel}`);
    }
  };
  walk(workDir, "");
  lines.sort();
  return lines.join("\n");
}

/** Pull approximate `text` / `tool_calls` / `turn_count` / `usage` out of
 *  the server-side probe log written by `apps/web/.../route.ts`. The probe
 *  captures every mid-stream message OpenLoomi enqueued, even ones Next.js
 *  dev failed to flush to the HTTP socket, so we can recover a useful
 *  approximation of the model's output without relying on SSE. */
export function enrichHandleFromProbeLog(
  handle: AgentStreamHandle,
  probeLogPath: string | undefined,
  debugPath: string | null,
  debugSse: boolean,
): void {
  if (!probeLogPath || !existsSync(probeLogPath)) return;
  let raw: string;
  try {
    raw = readFileSync(probeLogPath, "utf-8");
  } catch {
    return;
  }
  // The probe log records message *type* and *keys* but not full payloads
  // (text content, tool name, usage, etc.). So in practice we can only
  // recover `turn_count` from this stream — the rest of the handle is
  // filled in by `runFsPollingFallback` from the workDir filesystem.
  const lines = raw.split(/\r?\n/);
  let toolUseCount = 0;
  const typePattern = /^.*for-await got message #\d+ type=(\S+) /;

  for (const line of lines) {
    const typeMatch = line.match(typePattern);
    if (typeMatch && typeMatch[1] === "tool_use") {
      toolUseCount += 1;
    }
  }
  if (handle.turn_count === 0 && toolUseCount > 0) {
    handle.turn_count = toolUseCount;
  }
  if (debugSse && debugPath) {
    try {
      appendFileSync(
        debugPath,
        `[${new Date().toISOString()}] fs-polling: probe-derived turn_count=${handle.turn_count}\n`,
      );
    } catch {
      /* best-effort */
    }
  }
}

export async function runFsPollingFallback(args: {
  workDir: string;
  handle: AgentStreamHandle;
  timeoutMs: number;
  fsIdleDoneMs: number;
  probeLogPath?: string;
  debugPath: string | null;
  debugSse: boolean;
}): Promise<void> {
  const {
    workDir,
    handle,
    timeoutMs,
    fsIdleDoneMs,
    probeLogPath,
    debugPath,
    debugSse,
  } = args;
  const startedAt = Date.now();
  // First enrich the handle from the probe log (cheap, instant).
  enrichHandleFromProbeLog(handle, probeLogPath, debugPath, debugSse);

  const fsLog = (s: string) => {
    if (debugSse && debugPath) {
      try {
        appendFileSync(debugPath, `[${new Date().toISOString()}] ${s}\n`);
      } catch {
        /* best-effort */
      }
    }
  };
  fsLog(`fs-polling: start workDir=${workDir} timeoutMs=${timeoutMs}`);

  // Names that should not affect the idle-detection signature. The
  // SSE debug log is the one this Runner appends to on every
  // iteration; without this filter, its mtime changes every poll
  // and the loop never reaches idle.
  const signatureIgnore = FS_POLLING_IGNORE.filter((n) => !n.startsWith("."));

  // Use the recursive signature so files written into subdirectories
  // (`temp/`, `assets/footage/`, `output/`, etc.) are also observed. The
  // previous top-level-only version missed ~60 of the 206 0-deliverable
  // tasks because the model wrote into a subdirectory.
  let lastSig = recursiveSignature(workDir, FS_POLLING_IGNORE_DIRS);
  // Initialise lastChangeMs *now* — not from Date.now() — so a signature
  // that's already populated (files written before fs-polling started)
  // doesn't reset the idle clock backwards. Without this the previous
  // version exited 120 s later declaring 0 deliverables even though the
  // workdir already contained the file. The first iteration will compare
  // against `lastSig` (snapshot at fs-polling start) and detect the next
  // real change.
  let lastChangeMs = Date.now();
  fsLog(
    `fs-polling: initial recursive signature has ${lastSig.split("\n").filter(Boolean).length} file(s)`,
  );
  const POLL_INTERVAL_MS = 5_000;
  while (true) {
    if (Date.now() - startedAt > timeoutMs) {
      fsLog(
        `fs-polling: timeout after ${Date.now() - startedAt}ms; declaring done with current files`,
      );
      break;
    }
    // Re-poll the probe log on every iteration so the recovered
    // `turn_count` tracks the real-time count of tool_use events the
    // OpenLoomi SSE writer enqueued (which is *all* of them, even ones
    // the dev server never forwarded to us).
    enrichHandleFromProbeLog(handle, probeLogPath, debugPath, debugSse);
    const sig = recursiveSignature(workDir, FS_POLLING_IGNORE_DIRS);
    if (sig !== lastSig) {
      lastSig = sig;
      lastChangeMs = Date.now();
      fsLog(`fs-polling: recursive signature changed`);
    } else if (Date.now() - lastChangeMs >= fsIdleDoneMs) {
      fsLog(
        `fs-polling: no signature change for ${fsIdleDoneMs}ms; declaring done`,
      );
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Collect every file we recognise as a deliverable. Relative paths
  // (`temp/foo.py`, `Stage_Plot.pdf`, etc.) become `workdir_path`.
  const allRelative = lastSig
    .split("\n")
    .map((line) => line.split("::", 2)[1])
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .filter(
      (n) => !FS_POLLING_IGNORE.some((p) => n === p || n.startsWith(p + "/")),
    );

  for (const rel of allRelative) {
    // Avoid duplicating anything the SSE stream already captured (e.g. from
    // a tool_result that did arrive before the stall).
    if (
      handle.deliverables.some(
        (d) => d.workdir_path === rel || d.workdir_path === `./${rel}`,
      )
    ) {
      continue;
    }
    const absolute = join(workDir, rel);
    if (!existsSync(absolute)) continue;
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    handle.deliverables.push({
      workdir_path: rel,
      size_bytes: stat.size,
      sha256: sha256File(absolute),
      mime_type: guessMimeType(extname(absolute)),
    });
  }
  fsLog(
    `fs-polling: collected ${handle.deliverables.length} deliverable(s) (recursive scan of workDir)`,
  );
  // Mark the handle as finished so summariseHandle writes the prediction.
  handle.result_event_seen = true;
  handle.truncated = false;
}

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
    requestBody.aiSoulPrompt =
      options.systemPrompt + OPENLOOMI_FINISH_PROTOCOL_SUFFIX;
  }
  // Only inject `allowedTools` when the caller explicitly opts in via
  // `--allowed-tools`. Empirically, OpenLoomi's Bundled Bun CLI crashes
  // with a stack overflow whenever this field is sent (regardless of the
  // model, prompt size, or tool list contents). See DIAGNOSIS_2026-08-06.md
  // for the full probe matrix; omitting the field lets the agent run with
  // OpenLoomi's own default tool set.
  if (options.allowedTools && options.allowedTools.length > 0) {
    requestBody.allowedTools = options.allowedTools;
  }
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
  const useFsPolling = options.useFsPollingFallback !== false;
  const sseStallMs = options.sseStallMs ?? 5_000;
  const fsIdleDoneMs = options.fsIdleDoneMs ?? 300_000;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let idleAt = Date.now();
  // Optional SSE-level diagnostics. Enable with OPENLOOMI_DEBUG_SSE=1.
  const debugSse =
    process.env.OPENLOOMI_DEBUG_SSE === "1" ||
    process.env.OPENLOOMI_DEBUG_SSE === "true";
  const debugPath = debugSse
    ? join(options.workDir, `_openloomi_sse_debug.log`)
    : null;
  let streamExitReason = "unknown";
  if (debugSse && debugPath) {
    try {
      writeFileSync(
        debugPath,
        `[${new Date().toISOString()}] SSE stream opened; host=${host}:${options.port}\n` +
          `[${new Date().toISOString()}] request body keys: ${Object.keys(requestBody).join(",")}\n` +
          `[${new Date().toISOString()}] response status: ${response.status}\n`,
      );
    } catch {
      /* best-effort */
    }
  }

  try {
    let chunkIdx = 0;
    let loopIter = 0;
    while (true) {
      loopIter += 1;
      console.log(
        `[GDPval-AA v2] SSE loop iter=${loopIter} chunkIdx=${chunkIdx} enter`,
      );
      // Non-blocking read so we can detect SSE stalls within `sseStallMs`
      // and fall back to fs polling if enabled.
      const readPromise = reader.read();
      const stallTimer = new Promise<{ stalled: true }>((resolve) =>
        setTimeout(() => {
          console.log(
            `[GDPval-AA v2] SSE loop iter=${loopIter} stallTimer fired (${sseStallMs}ms)`,
          );
          resolve({ stalled: true });
        }, sseStallMs),
      );
      const outcome = await Promise.race([
        readPromise,
        stallTimer,
      ]);
      console.log(
        `[GDPval-AA v2] SSE loop iter=${loopIter} race resolved: stalled=${"stalled" in outcome} chunkIdx=${chunkIdx}`,
      );
      if ("stalled" in outcome) {
        // SSE pipe went silent for sseStallMs. Decide whether to bail out
        // or hand off to fs polling.
        if (
          useFsPolling &&
          // Only worth trying if at least the first session frame arrived.
          chunkIdx >= 1 &&
          !handle.result_event_seen
        ) {
          streamExitReason = "sse-stall-fs-polling";
          console.log(
            `[GDPval-AA v2] SSE stalled ${sseStallMs}ms after ${chunkIdx} chunk(s); entering fs polling fallback`,
          );
          if (debugSse && debugPath) {
            try {
              appendFileSync(
                debugPath,
                `[${new Date().toISOString()}] SSE stalled for ${sseStallMs}ms after ${chunkIdx} chunk(s); switching to fs polling fallback (probeLogPath=${options.probeLogPath ?? "(none)"})\n`,
              );
            } catch {
              /* best-effort */
            }
          }
          await runFsPollingFallback({
            workDir: options.workDir,
            handle,
            timeoutMs: options.timeoutMs ?? 30 * 60_000,
            fsIdleDoneMs,
            probeLogPath: options.probeLogPath,
            debugPath,
            debugSse,
          });
          streamExitReason = "fs-polling-done";
          break;
        }
        // Either fs polling disabled, or no first frame at all — give up.
        streamExitReason = "sse-stall-no-fallback";
        break;
      }
      const { done, value } = outcome;
      if (done) {
        streamExitReason = "reader-done";
        break;
      }
      idleAt = Date.now();
      chunkIdx += 1;
      console.log(
        `[GDPval-AA v2] SSE loop iter=${loopIter} got chunk #${chunkIdx}: ${value?.byteLength ?? 0} bytes`,
      );
      if (debugSse && debugPath) {
        try {
          appendFileSync(
            debugPath,
            `[${new Date().toISOString()}] raw read #${chunkIdx}: ${value?.byteLength ?? 0} bytes idleMs=${Date.now() - idleAt}\n`,
          );
        } catch {
          /* best-effort */
        }
      }
      buffer += decoder.decode(value, { stream: true });
      console.log(
        `[GDPval-AA v2] SSE loop iter=${loopIter} decoded chunk, buffer.length=${buffer.length}, has_nn=${buffer.includes("\n\n")}`,
      );

      // Split on SSE record boundaries. Find every "\n\n" in the (growing)
      // buffer and dispatch one SSE record at a time. The previous version
      // captured `sep` in a `const` outside the loop, which meant the loop
      // condition never refreshed after the slice — a guaranteed infinite
      // loop the moment any chunk landed a complete SSE record. See
      // HANDOVER_2026-08-08 for the regression history.
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const record = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const events = parseSSERecord(record);
        for (const ev of events) {
          if (debugSse && debugPath) {
            try {
              const preview = JSON.stringify(ev).slice(0, 600);
              appendFileSync(
                debugPath,
                `[${new Date().toISOString()}] event type=${ev.type ?? "?"} preview=${preview}\n`,
              );
            } catch {
              /* best-effort */
            }
          }
          handleEvent(ev, options.workDir, handle, maxTurns);
          if (handle.result_event_seen || handle.truncated) {
            streamExitReason = "result-event";
            break;
          }
        }
        if (handle.result_event_seen || handle.truncated) {
          if (streamExitReason === "unknown") streamExitReason = "result-event";
          break;
        }
        sep = buffer.indexOf("\n\n");
      }
      if (handle.result_event_seen || handle.truncated) break;
    }
  } catch (error) {
    streamExitReason = `error: ${(error as Error)?.name ?? "unknown"}: ${(error as Error)?.message ?? ""}`;
    if ((error as { name?: string })?.name === "AbortError") {
      // Fallthrough; treat as finished.
      streamExitReason = "abort-signal";
    } else if (debugSse && debugPath) {
      try {
        appendFileSync(
          debugPath,
          `[${new Date().toISOString()}] EXCEPTION: ${(error as Error)?.stack ?? String(error)}\n`,
        );
      } catch {
        /* best-effort */
      }
      throw error;
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
    if (debugSse && debugPath) {
      try {
        appendFileSync(
          debugPath,
          `[${new Date().toISOString()}] SSE stream closed: reason=${streamExitReason} turns=${handle.turn_count} textLen=${handle.text.length} deliverables=${handle.deliverables.length}\n`,
        );
      } catch {
        /* best-effort */
      }
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
