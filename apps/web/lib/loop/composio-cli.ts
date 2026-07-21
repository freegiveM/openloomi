/**
 * Composio CLI direct probe — fast-path for `/api/loop/connectors`.
 *
 * The agentic path in `composio-bridge.ts` dispatches a 100+ line prompt to
 * `/api/native/agent` and waits 60–120s (up to 10 min on cold first probe)
 * for the LLM to enumerate the user's Composio connections. For a pure
 * read-only "is gmail connected?" question, that's pure waste — the
 * `composio` CLI can answer it in ~200ms with two `execFile` calls.
 *
 * This module implements that fast-path:
 *
 *   1. `composio whoami` — verifies the CLI is on `$PATH` AND that the
 *      user's API key is valid. Cheap (~50ms). Distinguishes "CLI missing"
 *      (ENOENT) from "CLI installed but auth broken" (non-zero exit /
 *      stderr containing "not logged in" / "auth").
 *   2. `composio dev connected-accounts list --status ACTIVE` — returns
 *      the per-account JSON the bridge needs to build `ConnectorEntry[]`.
 *      Group by `toolkit_slug`, normalize slugs (CLI returns
 *      `googlecalendar`, the Loop uses `google_calendar`), and emit one
 *      entry per toolkit with the parsed `accounts[]`.
 *
 * Any failure here (CLI missing, auth broken, dev-project not initialized,
 * JSON malformed, unknown slug, network timeout) returns a structured
 * `ProbeOutcome` failure kind so `probeConnectorState` can fall through to
 * the agentic path without losing diagnostic context. The agentic path is
 * ALWAYS the fallback of last resort — when the CLI can answer, we never
 * spin up an agent runtime.
 *
 * CLI contract (pinned against `composio 0.2.32`):
 *   - `whoami` → exits 0 with a one-line JSON `{account_type, email, ...}`
 *   - `dev connected-accounts list --status ACTIVE` → JSON array of
 *     `{ id, toolkit_slug, status, user_id, ... }`. Requires `dev init`
 *     to have been run in the cwd; without it, the CLI returns a non-zero
 *     exit and a "No developer project configured" diagnostic — we map
 *     that to `cli_no_dev_project` (sub-kind of `cli_malformed`) so the
 *     agentic fallback can take over.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { writeConnectorSnapshot } from "./connectors";
import { log } from "./store";
import type { ConnectorAccount, ConnectorEntry } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Per-call timeout for a single `composio` invocation. The CLI's own
 * startup + a `whoami` round-trip rarely exceeds 5s; the list call adds
 * a network round-trip. 15s is a comfortable ceiling that still leaves
 * room for a slow first call after install (the dev project init).
 */
const CLI_CALL_TIMEOUT_MS = 15 * 1000;

/**
 * What `composio whoami` returns on success — a single line of JSON.
 * `account_type` is `"human"` for a logged-in user (the agentic prompt's
 * "skill" surface is keyed on this). We don't act on any other field.
 */
interface WhoamiResult {
  account_type?: string;
  email?: string;
  current_org_name?: string;
}

/**
 * Shape of one entry from `composio dev connected-accounts list
 * --status ACTIVE`. Pinned against `composio 0.2.32` — fields beyond
 * this set may appear in newer CLI versions and are ignored.
 */
interface ConnectedAccountRaw {
  id?: string;
  alias?: string | null;
  word_id?: string;
  toolkit_slug?: string;
  user_id?: string;
  status?: string;
  created_at?: string;
}

/**
 * Slug normalization: the `composio` CLI's `toolkit_slug` field doesn't
 * always match the Loop's internal connector ids. Today there's exactly
 * one mismatch we know about (`googlecalendar` vs `google_calendar`),
 * but this map is the right place to add more as they surface. Unknown
 * slugs are passed through unchanged so we don't silently drop data the
 * UI might already know how to render.
 */
const SLUG_TO_LOOP_ID: Record<string, string> = {
  googlecalendar: "google_calendar",
  // Add more as discovered. Don't remove entries without a sweep across
  // the connector UI / readiness surface — silently renaming an id
  // would orphan a `LoopMonitoredToolkit` flag on the persisted cache.
};

/**
 * Loop's canonical 6-entry catalog (#361) — see `composio-bridge.ts`.
 * Re-stated here so the CLI probe can backfill any toolkit the CLI
 * didn't report (zero matches for that toolkit → `connected: false`),
 * mirroring the agentic probe's "preserve catalog length" contract.
 */
const DEFAULT_TOOLKITS: Array<{
  id: string;
  label: string;
  localOnly?: boolean;
  localOnlyMessage?: string;
}> = [
  { id: "gmail", label: "Gmail" },
  { id: "google_calendar", label: "Google Calendar" },
  { id: "github", label: "GitHub" },
  { id: "slack", label: "Slack" },
  { id: "linear", label: "Linear" },
  {
    id: "obsidian",
    label: "Obsidian",
    localOnly: true,
    localOnlyMessage: "local-only",
  },
];

/**
 * Outcome of a CLI-direct probe. Mirrors `ProbeOutcome` in
 * `composio-bridge.ts` — kept structurally similar so the agentic
 * fallback can treat a CLI `kind === "ok"` exactly the same as an
 * agentic one. The new failure kinds (`cli_not_found`,
 * `cli_unauthorized`, `cli_no_dev_project`, `cli_malformed`) are
 * surfaced as `lastProbeError` diagnostics by the cache layer so the
 * UI can tell the user "CLI missing — falling back to agent" instead
 * of just "no sources connected".
 */
export type CliProbeOutcome =
  | { kind: "ok"; entries: ConnectorEntry[]; surfaces: string[] }
  | { kind: "cli_not_found"; error: string }
  | { kind: "cli_unauthorized"; error: string }
  | { kind: "cli_no_dev_project"; error: string }
  | { kind: "cli_malformed"; diagnostic: string }
  | { kind: "cli_timeout"; durationMs: number };

/**
 * Run a single `composio` CLI invocation. Catches `ENOENT` and other
 * spawn-level failures and returns `null` so callers can render a
 * structured `cli_not_found` outcome instead of an exception.
 *
 * `execImpl` is a test seam — production passes the real
 * `promisify(execFile)`. Tests pass a stub returning `{stdout, stderr}`
 * synchronously (the same shape `callComposioTool` uses in `watcher.ts`)
 * so we don't have to fight `util.promisify`'s callback arity against
 * `vi.fn()` mocks.
 */
interface ExecResult {
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  execImpl: (
    cmd: string,
    args: string[],
    opts: unknown,
  ) => Promise<ExecResult> = execFileAsync as unknown as (
    cmd: string,
    args: string[],
    opts: unknown,
  ) => Promise<ExecResult>,
): Promise<{ ok: true; result: ExecResult } | { ok: false; error: string }> {
  try {
    const result = await execImpl("composio", args, {
      timeout: CLI_CALL_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      // `whoami` and `dev connected-accounts list` both print JSON
      // to stdout. Don't ask for human-readable output — we want the
      // raw shape so the parser can stay stable across CLI versions.
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { ok: true, result };
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
      killed?: boolean;
      signal?: string;
    };
    // ENOENT = the `composio` binary isn't on `$PATH`. Surface it
    // distinctly so the agentic fallback isn't blamed for the gap.
    if (err?.code === "ENOENT") {
      return { ok: false, error: "composio CLI not on $PATH" };
    }
    // Spawn-level timeout — the CLI didn't return within
    // `CLI_CALL_TIMEOUT_MS`. The agentic fallback will retry.
    if (err?.killed || err?.signal === "SIGTERM") {
      return {
        ok: false,
        error: `composio CLI timed out after ${CLI_CALL_TIMEOUT_MS}ms`,
      };
    }
    // All other failures carry the CLI's own stderr — bubble it up
    // so the diagnostic stays actionable.
    const text =
      `${err?.stderr ?? ""}\n${err?.stdout ?? ""}\n${err?.message ?? ""}`.trim();
    return { ok: false, error: text || "composio CLI failed" };
  }
}

/**
 * `composio whoami` — verifies CLI + key. On non-zero exit, decide
 * between `cli_unauthorized` (auth broken) and `cli_malformed`
 * (something else went wrong, e.g. unexpected JSON shape).
 */
async function probeWhoami(
  execImpl?: (
    cmd: string,
    args: string[],
    opts: unknown,
  ) => Promise<ExecResult>,
): Promise<
  { ok: true; whoami: WhoamiResult } | { ok: false; outcome: CliProbeOutcome }
> {
  const r = await runCli(["whoami"], execImpl);
  if (!r.ok) {
    return {
      ok: false,
      outcome: { kind: "cli_not_found", error: r.error },
    };
  }
  const stdout = r.result.stdout.trim();
  // `whoami` exits non-zero on auth failure; success is a single JSON
  // object. We don't have access to the exit code via execFile's
  // resolved promise, so we infer "not logged in" from the stderr
  // shape (CLI prints "Not logged in" / "login required").
  if (!stdout) {
    const stderr = r.result.stderr.trim();
    if (/not logged in|login required|unauthor/i.test(stderr)) {
      return {
        ok: false,
        outcome: { kind: "cli_unauthorized", error: stderr },
      };
    }
    return {
      ok: false,
      outcome: {
        kind: "cli_malformed",
        diagnostic: `whoami returned empty stdout; stderr=${stderr.slice(0, 200)}`,
      },
    };
  }
  let parsed: WhoamiResult;
  try {
    parsed = JSON.parse(stdout) as WhoamiResult;
  } catch {
    return {
      ok: false,
      outcome: {
        kind: "cli_malformed",
        diagnostic: `whoami stdout not JSON: ${stdout.slice(0, 200)}`,
      },
    };
  }
  // `account_type === "human"` is the only "logged in" shape we care
  // about; `"agent"` accounts don't have user-owned connected accounts.
  if (parsed.account_type !== "human") {
    return {
      ok: false,
      outcome: {
        kind: "cli_unauthorized",
        error: `whoami account_type=${parsed.account_type ?? "unknown"}`,
      },
    };
  }
  return { ok: true, whoami: parsed };
}

/**
 * `composio dev connected-accounts list --status ACTIVE`. Returns the
 * raw account array on success, or a structured failure when:
 *   - the dev project isn't initialized (most common — `dev init` was
 *     never run in this cwd) → `cli_no_dev_project`
 *   - the JSON can't be parsed → `cli_malformed`
 *   - any other stderr → `cli_malformed` with the stderr text
 */
async function probeConnectedAccounts(
  execImpl?: (
    cmd: string,
    args: string[],
    opts: unknown,
  ) => Promise<ExecResult>,
): Promise<
  | { ok: true; accounts: ConnectedAccountRaw[] }
  | { ok: false; outcome: CliProbeOutcome }
> {
  const r = await runCli(
    [
      "dev",
      "connected-accounts",
      "list",
      "--status",
      "ACTIVE",
      "--limit",
      "1000",
    ],
    execImpl,
  );
  if (!r.ok) {
    return {
      ok: false,
      outcome: {
        kind: "cli_malformed",
        diagnostic: `connected-accounts list failed: ${r.error}`,
      },
    };
  }
  const stdout = r.result.stdout.trim();
  const stderr = r.result.stderr.trim();
  // The "No developer project configured" diagnostic prints to stdout
  // (not stderr) on this CLI version — intercept it before JSON.parse
  // blows up on the error banner.
  if (
    /no developer project/i.test(stdout) ||
    /no developer project/i.test(stderr)
  ) {
    return {
      ok: false,
      outcome: {
        kind: "cli_no_dev_project",
        error: "composio dev project not initialized — run `composio dev init`",
      },
    };
  }
  if (!stdout) {
    return {
      ok: false,
      outcome: {
        kind: "cli_malformed",
        diagnostic: `connected-accounts list returned empty stdout; stderr=${stderr.slice(0, 200)}`,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      outcome: {
        kind: "cli_malformed",
        diagnostic: `connected-accounts list stdout not JSON: ${stdout.slice(0, 200)}`,
      },
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      outcome: {
        kind: "cli_malformed",
        diagnostic: `connected-accounts list not an array: ${typeof parsed}`,
      },
    };
  }
  return { ok: true, accounts: parsed as ConnectedAccountRaw[] };
}

/**
 * Reduce the raw account list into a per-toolkit `ConnectorEntry[]`,
 * mirroring `composio-bridge.ts::probeConnectorState`'s output shape.
 * Catalog length is preserved via backfill — every toolkit the Loop
 * tracks gets a row, connected or not.
 */
function buildEntries(
  raw: ConnectedAccountRaw[],
  toolkits: typeof DEFAULT_TOOLKITS,
): ConnectorEntry[] {
  // Bucket accounts by their normalized toolkit id. Unknown slugs are
  // bucketed under their raw slug so the data isn't silently dropped
  // (the UI may already render them via custom channels).
  const buckets = new Map<string, ConnectorAccount[]>();
  const slugFor = (slug: string) => SLUG_TO_LOOP_ID[slug] ?? slug;
  for (const r of raw) {
    if (!r.id || typeof r.id !== "string") continue;
    const slug =
      typeof r.toolkit_slug === "string" && r.toolkit_slug
        ? r.toolkit_slug
        : null;
    if (!slug) continue;
    const id = slugFor(slug);
    if (!buckets.has(id)) buckets.set(id, []);
    const acc: ConnectorAccount = {
      id: r.id,
      // `alias` is the user's optional label for the account; fall back
      // to `word_id` (e.g. `outlook_apsis-quag`) so the UI always has
      // *something* to render. Never includes secrets.
      label:
        (typeof r.alias === "string" && r.alias) ||
        (typeof r.word_id === "string" && r.word_id) ||
        undefined,
      healthy: r.status === "ACTIVE",
    };
    buckets.get(id)!.push(acc);
  }

  const stamp = new Date().toISOString();
  const out: ConnectorEntry[] = [];
  for (const t of toolkits) {
    const accounts = buckets.get(t.id);
    if (t.localOnly) {
      // Mirror the agentic probe's contract — local-only toolkits
      // never come from the CLI; report them as offline with the
      // sentinel `lastError`.
      out.push({
        id: t.id,
        label: t.label,
        connected: false,
        accountCount: 0,
        lastError: t.localOnlyMessage ?? "local-only",
        probed: true,
        fetchedAt: stamp,
      });
      continue;
    }
    if (accounts && accounts.length > 0) {
      out.push({
        id: t.id,
        label: t.label,
        connected: true,
        accountCount: accounts.length,
        accounts,
        probed: true,
        fetchedAt: stamp,
      });
    } else {
      out.push({
        id: t.id,
        label: t.label,
        connected: false,
        accountCount: 0,
        lastError: "not connected",
        probed: true,
        fetchedAt: stamp,
      });
    }
  }
  return out;
}

/**
 * Probe the active Composio connections via the user's local `composio`
 * CLI. On any failure returns a structured outcome; on success persists
 * the snapshot via `writeConnectorSnapshot` and returns `kind: "ok"`.
 *
 * The two-step pipeline (`whoami` → `dev connected-accounts list`) is
 * deliberately short-circuited: if `whoami` fails we don't bother with
 * the list call — both depend on a working CLI + auth.
 *
 * Callers (`probeConnectorState` in `composio-bridge.ts`) should treat
 * every non-`ok` outcome as a fallback signal: "CLI couldn't answer,
 * hand off to the agentic path."
 */
export async function probeViaCli(
  opts: {
    toolkits?: typeof DEFAULT_TOOLKITS;
    execImpl?: (
      cmd: string,
      args: string[],
      opts: unknown,
    ) => Promise<ExecResult>;
  } = {},
): Promise<CliProbeOutcome> {
  const toolkits = opts.toolkits ?? DEFAULT_TOOLKITS;
  const t0 = Date.now();
  log(`composio-cli: probing via local composio CLI`);

  // Step 1 — verify CLI + auth. If this fails, the list call is
  // guaranteed to fail too, so we surface immediately. We deliberately
  // do NOT call `writeProbeError` here: `probeConnectorState` is going
  // to fall through to the agentic path, which either succeeds
  // (rewriting the cache via `writeConnectorSnapshot` and dropping any
  // stale diagnostic) or fails (writing its own agentic-kind
  // `lastProbeError`). A CLI diagnostic would only ever be visible if
  // the agentic path *also* failed AND for some reason didn't write
  // its own — which the agentic path is contractually obligated not to
  // do. So the CLI diagnostic is dead weight; the caller's
  // `probeConnectorState` gets the full picture and decides what to
  // persist.
  const whoami = await probeWhoami(opts.execImpl);
  if (!whoami.ok) {
    log(`composio-cli: whoami outcome=${whoami.outcome.kind}`);
    return whoami.outcome;
  }

  // Step 2 — fetch the active account list. Failure here means CLI is
  // installed and auth works, but we can't enumerate accounts (most
  // commonly because `dev init` was never run). Same persistence
  // rationale as above — caller decides.
  const list = await probeConnectedAccounts(opts.execImpl);
  if (!list.ok) {
    log(`composio-cli: list outcome=${list.outcome.kind}`);
    return list.outcome;
  }

  const entries = buildEntries(list.accounts, toolkits);
  try {
    writeConnectorSnapshot(entries);
    log(
      `composio-cli: ok — persisted ${entries.length} connector entries (${list.accounts.length} active account(s)) in ${Date.now() - t0}ms`,
    );
  } catch (e) {
    // Persistence is best-effort — return the entries anyway so the
    // caller can surface them in-memory and the next refresh retries.
    log(
      `composio-cli: snapshot persistence failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  return {
    kind: "ok",
    entries,
    surfaces: ["cli"],
  };
}
