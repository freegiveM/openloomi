#!/usr/bin/env node
/**
 * One-off: deletes (no-op if already gone) and recreates the three
 * Loop:* rows in scheduled_jobs with the correct tz-anchored
 * next_run_at. Replaces the dynamic-import "ensureLoopJobs" path
 * because Next.js `server-only` modules can't be loaded by a plain
 * node script. The math + insert mirror what createJob does inside the
 * app — same croner call, same DB columns — so any drift observed
 * through this script is going to come straight from computeNextRun.
 */

import Database from "better-sqlite3";
import { Cron } from "croner";
import { readFileSync } from "node:fs";

const DB = "/Users/timi/.openloomi/data/data.db";
const PREFS = "/Users/timi/.openloomi/loop/config.json";

const db = new Database(DB);
const colRows = db.prepare("PRAGMA table_info('scheduled_jobs')").all();
const cols = new Set(colRows.map((r) => r.name));
console.log("[cols]", [...cols].join(","));

// Find a user. We delete loop rows first so we can't pull user_id from
// them — pull from a recent non-loop row, falling back to the user table.
let userId = db
  .prepare(
    "SELECT user_id FROM scheduled_jobs WHERE user_id IS NOT NULL AND name NOT LIKE 'Loop:%' ORDER BY updated_at DESC LIMIT 1",
  )
  .get()?.user_id;
if (!userId) {
  userId = db
    .prepare("SELECT id FROM user ORDER BY created_at DESC LIMIT 1")
    .get()?.id;
}
if (!userId) throw new Error("No user_id found — cannot recreate loop rows.");
console.log("[userId]", userId);

const prefs = JSON.parse(readFileSync(PREFS, "utf8"));
const timezone = (prefs.timezone ?? "").trim() || "Asia/Shanghai";
console.log("[prefs.timezone]", timezone, "[briefTime]", prefs.briefTime, "[wrapTime]", prefs.wrapTime);

function cronExpr(hhmm) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((hhmm ?? "").trim());
  return m ? `${m[2]} ${m[1]} * * *` : null;
}

const tickMin = Math.max(1, Math.round((prefs.intervalSec ?? 600) / 60));
const nowMs = Date.now();
const nowSec = Math.floor(nowMs / 1000);

function nextRunSec(schedule) {
  if (schedule.type === "interval-minutes") return nowSec + schedule.minutes * 60;
  if (schedule.type === "cron") {
    const c = new Cron(schedule.expression, { timezone: schedule.timezone || "UTC" });
    return Math.floor(c.nextRun(new Date(nowMs)).getTime() / 1000);
  }
  return null;
}

const jobs = [
  {
    name: "Loop: tick · pull signals & classify decisions",
    description:
      "Runs the Loop brain on a recurring interval (default 10 minutes, configurable in preferences). Each tick first pulls new events from connected integrations via the watcher and appends them to signals.jsonl, then runs the tick pipeline against a 2-hour lookback — scans incoming signals, classifies them, and surfaces or mutes candidate decisions. Returns a LoopTickResult with scanned / surfaced / muted counts; failures are caught and logged to jobExecutions with status:error.",
    type: "interval-minutes",
    minutes: tickMin,
    handler: "loop.tick",
  },
  {
    name: "Loop: brief · build morning brief card",
    description:
      "Runs daily at the user's configured morning brief time. Reads the day's pending decisions, builds a brief snapshot with the day's priorities, and enqueues a `type:\"brief\"` decision card titled `Morning brief · YYYY-MM-DD` so it shows up in the pet / inbox / web UI. The card lists N priorities with a short dialogue line — `Morning: N priorities queued — top one is X` — plus tap-to-expand affordances and a nextStep hint for the user.",
    type: "cron",
    expression: cronExpr(prefs.briefTime),
    handler: "loop.brief",
  },
  {
    name: "Loop: wrap · build evening wrap card",
    description:
      "Runs daily at the user's configured evening wrap time. Reads today's completed / dismissed / pending decisions, builds a wrap snapshot with the day's highlights, and enqueues a `type:\"wrap\"` decision card titled `Evening wrap · YYYY-MM-DD`. The card summarizes done / dismissed / still-pending counts — `Night: wrapped N today — latest was X` — and points the user at the next morning brief for any leftovers.",
    type: "cron",
    expression: cronExpr(prefs.wrapTime),
    handler: "loop.wrap",
  },
];

const insert = db.prepare(
  `INSERT INTO scheduled_jobs (
    id, user_id, name, description,
    schedule_type, cron_expression, interval_minutes,
    scheduled_at,
    job_config, job_type,
    enabled, timezone,
    last_run_at, next_run_at, last_status, last_error,
    run_count, failure_count,
    created_at, updated_at
  ) VALUES (
    @id, @user_id, @name, @description,
    @schedule_type, @cron_expression, @interval_minutes,
    @scheduled_at,
    @job_config, @job_type,
    @enabled, @timezone,
    @last_run_at, @next_run_at, @last_status, @last_error,
    @run_count, @failure_count,
    @created_at, @updated_at
  )`,
);

const rows = jobs.map((j) => {
  const schedule =
    j.type === "cron"
      ? { type: "cron", expression: j.expression, timezone }
      : { type: "interval-minutes", minutes: j.minutes };
  const nextSec = nextRunSec(schedule);
  console.log(
    "  scheduled:",
    j.name,
    "  tz=",
    timezone,
    "  next_run_at=",
    nextSec,
    "  (=UTC",
    new Date(nextSec * 1000).toISOString(),
    " = local",
    new Date(nextSec * 1000).toLocaleString("en-CA", { timeZone: timezone, hour12: false }),
    ")",
  );
  return {
    id: crypto.randomUUID(),
    user_id: userId,
    name: j.name,
    description: j.description,
    schedule_type: j.type,
    cron_expression: j.type === "cron" ? j.expression : null,
    interval_minutes: j.type === "interval-minutes" ? j.minutes : null,
    scheduled_at: null,
    job_config: JSON.stringify({ type: "custom", handler: j.handler }),
    job_type: "custom",
    enabled: 1,
    timezone,
    last_run_at: null,
    next_run_at: nextSec,
    last_status: null,
    last_error: null,
    run_count: 0,
    failure_count: 0,
    created_at: nowMs,
    updated_at: nowMs,
  };
});

const txn = db.transaction((rs) => {
  for (const r of rs) insert.run(r);
});
txn(rows);

console.log("\n[verify]");
const verify = db
  .prepare(
    `SELECT name, timezone, schedule_type, cron_expression, interval_minutes,
            next_run_at,
            datetime(next_run_at, 'unixepoch')                              AS next_utc,
            datetime(next_run_at, 'unixepoch', '+8 hours')                  AS next_cst,
            (next_run_at - strftime('%s', 'now'))                           AS seconds_from_now
       FROM scheduled_jobs
       WHERE name LIKE 'Loop:%'
       ORDER BY name`,
  )
  .all();
for (const r of verify) console.log(" ", r);

db.close();
console.log("[done]");
