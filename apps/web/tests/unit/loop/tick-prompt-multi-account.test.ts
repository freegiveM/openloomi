/**
 * #360 — the tick prompt must instruct the agent to enumerate EVERY active
 * connected account per toolkit and pull signals once per account, rather
 * than relying on a single implicit/default account. These assertions pin
 * that contract so a future prompt edit can't silently regress multi-account
 * coverage (the "two Google Calendar accounts, only one pulled" bug).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let LOOP_HOME = "";

vi.mock("@/lib/loop/paths", async () => {
  const { join } = await import("node:path");
  const buildPaths = () => ({
    home: LOOP_HOME,
    signals: join(LOOP_HOME, "signals.jsonl"),
    decisions: join(LOOP_HOME, "decisions.json"),
    status: join(LOOP_HOME, "status.json"),
    brief: join(LOOP_HOME, "brief.json"),
    wrap: join(LOOP_HOME, "wrap.json"),
    connectors: join(LOOP_HOME, "connectors.json"),
    config: join(LOOP_HOME, "config.json"),
    mutes: join(LOOP_HOME, "mutes.json"),
    migrated: join(LOOP_HOME, "migrated.json"),
    log: join(LOOP_HOME, "loop.log"),
    inbox: join(LOOP_HOME, "inbox"),
    syncState: join(LOOP_HOME, "sync-state.json"),
    customTypes: join(LOOP_HOME, "custom-types.json"),
    customChannels: join(LOOP_HOME, "custom-channels.json"),
  });
  const pathsProxy = new Proxy(
    {},
    {
      get: (_t, prop: string) => (buildPaths() as Record<string, string>)[prop],
    },
  );
  return {
    get LOOP_HOME() {
      return LOOP_HOME;
    },
    LOOP_PATHS: pathsProxy,
    ensureDirs: () => {
      mkdirSync(LOOP_HOME, { recursive: true });
    },
  };
});

const { buildTickPrompt } = await import("@/lib/loop/tick-prompt");
const { customTypes } = await import("@/lib/loop/custom-types");
const { customChannels } = await import("@/lib/loop/custom-channels");

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loomi-prompt-ma-"));
  LOOP_HOME = join(tmp, ".openloomi", "loop");
  mkdirSync(LOOP_HOME, { recursive: true });
  customTypes.invalidate();
  customChannels.invalidate();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("buildTickPrompt multi-account enumeration (#360)", () => {
  it("instructs the agent to enumerate every active connected account", () => {
    const prompt = buildTickPrompt();
    expect(prompt).toContain("connected-accounts list --status ACTIVE");
    expect(prompt).toMatch(/enumerate the active accounts/i);
    // The fan-out section must exist and reference issue #360.
    expect(prompt).toContain("Fan out over every connected account");
  });

  it("requires one pull per account, not a single default account", () => {
    const prompt = buildTickPrompt();
    expect(prompt).toMatch(/once per active\s*\n?\s*connected account/i);
    // Explicit account selection on the CLI execute call.
    expect(prompt).toContain("--connected-account-id");
    expect(prompt).toMatch(/do NOT rely on the implicit default/i);
  });

  it("requires merge-before-dedupe across accounts", () => {
    const prompt = buildTickPrompt();
    expect(prompt).toMatch(/Merge, then dedupe/i);
    expect(prompt).toContain("cross-account dedupe");
  });

  it("tags each signal with a non-secret source account", () => {
    const prompt = buildTickPrompt();
    expect(prompt).toContain("_sourceAccount");
    expect(prompt).toContain("sourceAccount");
    // The persisted signal shape carries the account id + label.
    expect(prompt).toMatch(/"sourceAccount":\{"id":/);
  });

  it("isolates per-account failures so one bad account keeps the rest", () => {
    const prompt = buildTickPrompt();
    expect(prompt).toMatch(/Isolate failures/i);
    expect(prompt).toMatch(
      /keep the\s*\n?\s*successful\s*\n?\s*results from the other accounts/i,
    );
  });

  it("emits a per-account accounts array in the connectors result block", () => {
    const prompt = buildTickPrompt();
    // Every built-in connector row now carries an `accounts` array.
    expect(prompt).toMatch(
      /"id": "google_calendar"[\s\S]*?"accounts": \[\{ "id":/,
    );
    expect(prompt).toContain('"healthy": <bool>');
    expect(prompt).toMatch(
      /accountCount[\s\S]*?MUST equal[\s\S]*?accounts\.length/i,
    );
  });
});
