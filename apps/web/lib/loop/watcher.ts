/**
 * Loop watcher — kept as a public entry point for backward compatibility
 * with `handlers.ts` (which calls `runWatcher()` before each `tick.run()`).
 *
 * **The watcher is mostly a no-op in agentic mode**: the agent at
 * `/api/native/agent` has the `composio` skill and `composio` CLI
 * available and pulls signals for the 4 built-in toolkits itself
 * (see `tick-prompt.ts` §1–2). Legacy pullers (per-bot Gmail OAuth,
 * per-channel REST polling) were intentionally removed in the agentic
 * refactor.
 *
 * Connector-status probing (which is what the watcher used to gate its
 * pullers) now lives in `composio-bridge.getActiveIntegrations()` and is
 * exposed via `/api/loop/connectors` — see `connectors.ts`.
 *
 * **One exception: user-defined custom channels.** When the user
 * registers a channel via `PUT /api/loop/channels`, the watcher takes
 * over for that channel — the agent's tick prompt is not designed to
 * pull arbitrary Composio tools on arbitrary intervals, and we'd rather
 * not have the user write a tick prompt. Each registered channel polls
 * its `toolSlug` via the `composio` CLI on its own `pollIntervalSec`
 * cadence, applies its `eventFilter`, and appends one `LoopSignal` per
 * matching record to `signals.jsonl`. The agent sees those signals on
 * the next tick and maps them to a typed decision (see
 * `tick-prompt.ts` §2.3 + §5).
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

import { ensureDirs, LOOP_PATHS } from "./paths";
import { customChannels } from "./custom-channels";
import type { CustomChannel } from "./custom-channels";
import { signals, log } from "./store";
import type { LoopSignal } from "./types";

const execFileAsync = promisify(execFile);

/** Hard ceiling for a single composio CLI call (10 minutes). */
const COMPOSIO_CLI_TIMEOUT_MS = 10 * 60 * 1000;
/** Per-channel cap to avoid pathologically large responses. */
const MAX_RECORDS_PER_PULL = 100;

export interface WatcherRunResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Always `{}` in agentic mode — preserved for backward compat. */
  bySource: Record<string, never>;
  /** Signals appended across all custom channels. */
  totalAppended: number;
}

export interface WatcherOptions {
  userId?: string;
  /**
   * When true, force a poll on every custom channel regardless of
   * `pollIntervalSec`. Used by tests and the manual "force refresh"
   * button. Default false.
   */
  force?: boolean;
  /**
   * Test seam — override the child-process executor so unit tests can
   * inject a vi.fn() / fake promise without going through promisify
   * (which has callback-vs-Promise shape quirks when called against
   * vi.fn() mocks). Production code leaves this `undefined`.
   */
  execImpl?: typeof execFileAsync;
}

// ---------------------------------------------------------------------------
// sync-state — per-channel lastPolledAt
// ---------------------------------------------------------------------------
//
// A small JSON sidecar at `~/.openloomi/loop/sync-state.json` records
// each custom channel's last poll timestamp. The watcher consults it
// on every pass to throttle to the user's `pollIntervalSec` cadence.
// The existing `LOOP_PATHS.syncState` is the home for this — same
// place the future per-connector lastSyncAt entries are planned to
// live (tick-prompt.ts:304), so we're reusing the same field name.

interface ChannelSyncState {
  lastPolledAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

type SyncStateFile = Record<string, ChannelSyncState>;

function readSyncState(): SyncStateFile {
  try {
    if (!existsSync(LOOP_PATHS.syncState)) return {};
    const raw = JSON.parse(
      readFileSync(LOOP_PATHS.syncState, "utf8"),
    ) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as SyncStateFile;
    }
  } catch {
    /* corrupted — start fresh */
  }
  return {};
}

function writeSyncState(s: SyncStateFile): void {
  ensureDirs();
  try {
    writeFileSync(LOOP_PATHS.syncState, JSON.stringify(s, null, 2));
  } catch (e) {
    log(`[watcher.custom] failed to write sync-state: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Filter evaluation
// ---------------------------------------------------------------------------

function resolveField(record: unknown, path: string): unknown {
  if (record == null) return undefined;
  const parts = path.split(".").filter(Boolean);
  let cur: unknown = record;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function applyFilter(
  record: unknown,
  filter: CustomChannel["eventFilter"],
): boolean {
  if (!filter || filter.length === 0) return true;
  for (const f of filter) {
    const actual = resolveField(record, f.field);
    let pass = false;
    switch (f.op) {
      case "eq":
        pass = actual === f.value;
        break;
      case "neq":
        pass = actual !== f.value;
        break;
      case "gt":
        pass =
          typeof actual === "number" && typeof f.value === "number"
            ? actual > f.value
            : typeof actual === "string" && typeof f.value === "string"
              ? actual > f.value
              : false;
        break;
      case "lt":
        pass =
          typeof actual === "number" && typeof f.value === "number"
            ? actual < f.value
            : typeof actual === "string" && typeof f.value === "string"
              ? actual < f.value
              : false;
        break;
      case "contains":
        pass =
          typeof actual === "string" && typeof f.value === "string"
            ? actual.includes(f.value)
            : Array.isArray(actual)
              ? actual.includes(f.value)
              : false;
        break;
    }
    if (!pass) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

interface CliCallResult {
  ok: boolean;
  records: unknown[];
  error?: string;
}

/**
 * Invoke the user's `composio` CLI to fetch records for one custom
 * channel. We deliberately use the CLI (not the REST API) because it
 * carries the user's auth context — no parallel API key, no
 * double-management. The CLI prints the tool's return value to stdout
 * (already a JSON shape on success), which we parse and return.
 *
 * Contract — current Composio CLI (>=0.2.0):
 *   composio execute <TOOL_SLUG> -d '<args-json>'
 *
 * Pre-0.2.0 (legacy) shape, kept as a fallback so the watcher still
 * works on older CLI installs:
 *   composio <toolkit> <action> --json '<args-json>'
 *
 * The two branches run sequentially. The current shape is tried first;
 * we only fall back to legacy when the current shape returns a
 * well-known "unknown command" / "usage" error. Any other failure
 * surfaces immediately so the channel's `lastError` is accurate.
 *
 * The `execImpl` parameter is a test seam — production code passes
 * `undefined` to use the real `promisify(execFile)`. Tests pass a stub
 * that returns `{stdout, stderr}` objects to avoid the callback/Promise
 * shape mismatch that `util.promisify` triggers against vi.fn() mocks.
 */
export async function callComposioTool(
  channel: CustomChannel,
  args: Record<string, unknown> = {},
  execImpl: typeof execFileAsync = execFileAsync,
): Promise<CliCallResult> {
  const tryCurrent = async (): Promise<CliCallResult> => {
    try {
      const { stdout, stderr } = await execImpl(
        "composio",
        ["execute", channel.toolSlug, "-d", JSON.stringify(args)],
        { timeout: COMPOSIO_CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      );
      const trimmed = stdout.trim();
      if (!trimmed) {
        return {
          ok: false,
          records: [],
          error: stderr.trim() || "empty stdout",
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        return {
          ok: false,
          records: [],
          error: `non-json response: ${
            e instanceof Error ? e.message : String(e)
          }`,
        };
      }
      return { ok: true, records: extractRecords(parsed) };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & {
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };
      if (err.killed) return { ok: false, records: [], error: "timeout" };
      if (err.code === "ENOENT") {
        return { ok: false, records: [], error: "composio CLI not on $PATH" };
      }
      const text =
        `${err.stderr ?? ""}\n${err.stdout ?? ""}\n${err.message ?? ""}`.toLowerCase();
      // The legacy `<toolkit> <action>` shape on a current CLI surfaces
      // either "unknown command" or, for legacy subcommands, the CLI's
      // usage banner. Both signal "you're on the new shape" — fall back.
      if (
        text.includes("unknown command") ||
        text.includes("usage:") ||
        text.includes("execute <slug>")
      ) {
        return { ok: false, records: [], error: "__FALLBACK_LEGACY__" };
      }
      const msg =
        err.stderr?.trim() ||
        err.stdout?.trim() ||
        err.message ||
        "composio CLI failed";
      return { ok: false, records: [], error: msg };
    }
  };
  const tryLegacy = async (): Promise<CliCallResult> => {
    try {
      const { stdout, stderr } = await execImpl(
        "composio",
        [
          channel.toolkit,
          channel.toolSlug.replace(/^[A-Z]+_/, "").toLowerCase(),
          "--json",
          JSON.stringify(args),
        ],
        { timeout: COMPOSIO_CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      );
      const trimmed = stdout.trim();
      if (!trimmed) {
        return {
          ok: false,
          records: [],
          error: stderr.trim() || "empty stdout",
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        return {
          ok: false,
          records: [],
          error: `non-json response: ${
            e instanceof Error ? e.message : String(e)
          }`,
        };
      }
      return { ok: true, records: extractRecords(parsed) };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & {
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };
      if (err.killed) return { ok: false, records: [], error: "timeout" };
      const msg =
        err.code === "ENOENT"
          ? "composio CLI not on $PATH"
          : err.stderr?.trim() ||
            err.stdout?.trim() ||
            err.message ||
            "composio CLI failed";
      return { ok: false, records: [], error: msg };
    }
  };
  const primary = await tryCurrent();
  if (primary.ok) return primary;
  if (primary.error === "__FALLBACK_LEGACY__") {
    return await tryLegacy();
  }
  return primary;
}

/**
 * Normalize a Composio CLI response into a flat record array.
 *
 * Current tools (Gmail, Google Calendar, GitHub, ...) wrap the array
 * under tool-specific keys:
 *   - Gmail:        data.messages
 *   - Google Calendar: data.items
 *   - GitHub:       data.notifications
 *
 * Some tools double-wrap under `data.data.<key>`; some return the raw
 * array (older envelopes) or a single record object. Walk the
 * envelope in priority order, then fall back to a broad sweep so a
 * new tool whose envelope we haven't seen yet still surfaces records
 * instead of returning 0.
 *
 * Exported (as `__testExtractRecords`) so unit tests can pin the
 * envelope-walk order without spinning up the full watcher pass.
 */
export function extractRecords(parsed: unknown): unknown[] {
  // Walk a path of dotted keys through `parsed`, returning the first
  // array we land on. Empty / non-object intermediate nodes short-circuit.
  const dig = (keys: string[]): unknown[] | null => {
    if (!parsed || typeof parsed !== "object") return null;
    let cur: unknown = parsed;
    for (const k of keys) {
      if (!cur || typeof cur !== "object") return null;
      cur = (cur as Record<string, unknown>)[k];
    }
    return Array.isArray(cur) ? (cur as unknown[]) : null;
  };
  // Tool-specific known envelopes (current contract).
  for (const path of [
    ["data", "messages"],
    ["data", "items"],
    ["data", "notifications"],
    ["data", "records"],
    ["data", "results"],
    ["data", "events"],
    ["data", "data", "messages"],
    ["data", "data", "items"],
    ["data", "data", "notifications"],
  ]) {
    const got = dig(path);
    if (got) return got;
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    // Liberal top-level fallback — covers older envelopes and tools
    // we haven't catalogued yet. `data` must be an array, not a
    // wrapper object (i.e. NOT { messages: [...] } — those go through
    // the tool-specific table above).
    if (Array.isArray(obj.data)) return obj.data;
    for (const k of ["records", "items", "results", "output", "response"]) {
      const v = obj[k];
      if (Array.isArray(v)) return v;
    }
    // Some Composio tools return a single record — wrap it.
    if ("id" in obj || "type" in obj) return [obj];
  }
  return [];
}

// ---------------------------------------------------------------------------
// One-channel pull
// ---------------------------------------------------------------------------

/**
 * Pull one custom channel. Returns the number of signals appended
 * (0 on throttle / error). Never throws — failures are logged and
 * persisted in sync-state so the user can see them in
 * `connectors.json` later.
 */
/**
 * Pull one custom channel. Returns the number of signals appended
 * (0 on throttle / error). Never throws — failures are logged and
 * persisted in sync-state so the user can see them in
 * `connectors.json` later. Exported for unit tests.
 */
export async function pullChannel(
  channel: CustomChannel,
  sync: SyncStateFile,
  opts: { force?: boolean; execImpl?: typeof execFileAsync } = {},
): Promise<number> {
  const cur = sync[channel.id] ?? {};
  // Throttle: skip if the channel polled within pollIntervalSec.
  if (!opts.force && cur.lastPolledAt) {
    const last = new Date(cur.lastPolledAt).getTime();
    if (Number.isFinite(last)) {
      const elapsed = Date.now() - last;
      if (elapsed < channel.pollIntervalSec * 1000) {
        return 0;
      }
    }
  }
  let result: CliCallResult;
  try {
    result = await callComposioTool(channel, {}, opts.execImpl);
  } catch (e) {
    result = {
      ok: false,
      records: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (!result.ok) {
    log(
      `[watcher.custom] channel ${channel.id} error: ${result.error ?? "unknown"}`,
    );
    sync[channel.id] = {
      ...cur,
      lastError: result.error ?? "unknown",
      lastErrorAt: new Date().toISOString(),
    };
    return 0;
  }
  const filtered = result.records
    .filter((r) => applyFilter(r, channel.eventFilter))
    .slice(0, MAX_RECORDS_PER_PULL);
  let appended = 0;
  for (const record of filtered) {
    // Best-effort dedupe by stable key: try the tool's natural id, then
    // fall back to a hash of the JSON. We append even on dedupe misses
    // — the tick's classifier skips signals with no decision history.
    const payload =
      record && typeof record === "object"
        ? (record as Record<string, unknown>)
        : { value: record };
    const sig: LoopSignal = signals.append(
      channel.id,
      channel.signalType as LoopSignal["type"],
      payload,
      { _origin: "composio" },
    );
    if (sig) appended++;
  }
  sync[channel.id] = {
    lastPolledAt: new Date().toISOString(),
    ...(cur.lastError
      ? { lastError: cur.lastError, lastErrorAt: cur.lastErrorAt }
      : {}),
  };
  log(
    `[watcher.custom] channel ${channel.id} ok — ${appended} signal(s) appended (${result.records.length} record(s) returned)`,
  );
  return appended;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Run one watcher pass. In agentic mode, the only signals it produces
 * are from user-defined custom channels (registered via
 * `PUT /api/loop/channels`). Built-in toolkits are pulled by the agent
 * at `/api/native/agent` — see `tick-prompt.ts` §1–2.
 *
 * Kept as the public entry so `handlers.ts::handleTick` and any future
 * caller can keep calling it without branching on mode. The legacy
 * `bySource: Record<string, never>` shape is preserved for backward
 * compatibility — custom channels are summarised in
 * `totalAppended` / `loop.log` instead.
 */
export async function runOnce(
  _opts: WatcherOptions = {},
): Promise<WatcherRunResult> {
  const startedAt = new Date();
  const result: WatcherRunResult = {
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    bySource: {},
    totalAppended: 0,
  };
  const channels = customChannels.list();
  if (channels.length === 0) {
    const finishedAt = new Date();
    result.finishedAt = finishedAt.toISOString();
    result.durationMs = finishedAt.getTime() - startedAt.getTime();
    log(
      "[watcher] agentic mode — no custom channels registered (signals come from /api/native/agent)",
    );
    return result;
  }
  const sync = readSyncState();
  let total = 0;
  for (const ch of channels) {
    try {
      total += await pullChannel(ch, sync, {
        force: _opts.force,
        ...(_opts.execImpl ? { execImpl: _opts.execImpl } : {}),
      });
    } catch (e) {
      log(
        `[watcher.custom] channel ${ch.id} threw: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  writeSyncState(sync);
  result.totalAppended = total;
  const finishedAt = new Date();
  result.finishedAt = finishedAt.toISOString();
  result.durationMs = finishedAt.getTime() - startedAt.getTime();
  log(
    `[watcher] agentic mode — custom channels pass complete, ${total} signal(s) appended across ${channels.length} channel(s)`,
  );
  return result;
}
