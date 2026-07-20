# OpenLoomi × Codex CLI — End-to-End Tour Guide

This is the canonical, end-to-end walkthrough for the OpenLoomi Codex CLI
plugin. Every step is a single Codex turn or a single desktop-app
interaction; every screenshot is from a real run.

The full path: **install the plugin → land in a ready Codex session → see
the Loomi Pet pop on the desktop → flip the pet theme → call the
`openloomi` skill for the canonical JSON → use the bundled Codex hooks →
connect external apps via Composio → and finally watch OpenLoomi's Loop
surface decision cards in the desktop app** — all driven by prompts you
typed in Codex.

If you only want the commands, the [README](./README.md) is enough. This
document is for when you want to see _what the system actually looks like_
in motion.

---

## 1. Ask Codex to install the plugin

```text
> Install the plugin and setup https://github.com/melandlabs/openloomi/tree/main/plugins/codex
```

![Step 1](../../apps/marketing/public/img/openloomi/plugins/codex/01-install-in-codex.png)

## 2. Install the Plugin from the marketplace

```text
codex plugin marketplace add melandlabs/openloomi
codex plugin add openloomi@openloomi
```

Codex prompts for a source. Enter `melandlabs/openloomi` — it refreshes
the marketplace cache and you now see the `openloomi` plugin in the
marketplace list.

![Step 2](../../apps/marketing/public/img/openloomi/plugins/codex/02-install-from-marketplace.png)

## 3. Launch Codex pointing at the local plugin

For plugin contributors (or anyone running from a checkout):

```text
git clone https://github.com/melandlabs/openloomi.git
cd openloomi
codex plugin marketplace add .
codex plugin add openloomi@openloomi
```

The plugin is now loaded into the session; you can confirm by typing
`@OpenLoomi` (next step) and watching the skill resolve.

## 4. Discover the skills

Type `@o` (or `@OpenLoomi`) — Codex surfaces the skill namespace. The
thin `openloomi` skill is the entry point, with sub-skills for
`openloomi-install` (install / configure the desktop), `openloomi-api`
(local OpenLoomi from Codex), `openloomi-connectors` (native connector
readiness), `openloomi-feature-guide` (capability lookup),
`openloomi-handoff` (hand work off to the loop), plus `openloomi` itself
for the read-only runtime doorway.

![Step 4 — typing `@o` in Codex surfaces the full skill namespace: `openloomi`, `openloomi-api`, `openloomi-connectors`, `openloomi-feature-guide`, `openloomi-handoff`, `openloomi-install`, `openloomi-loop`, `openloomi-memory`, `openloomi-pet` …](../../apps/marketing/public/img/openloomi/plugins/codex/04-discover-skills.png)

From the in-chat skill descriptions:

- `openloomi` — Use your local OpenLoomi assistant from Codex (read-only
  doorway into the runtime).
- `openloomi-install` — OpenLoomi install & first-use setup helper for
  Codex.
- `openloomi-api` — Reference for the local HTTP API.
- `openloomi-connectors` — Connector readiness guidance for native
  installs.
- `openloomi-feature-guide` — Feature / capability lookup.
- `openloomi-handoff` — Hand the current task to Loomi for follow-up.

## 5. Run `@OpenLoomi install` — readiness table + Pet appears

The install skill auto-chains install → launch → wait API → guest login.
When it finishes, Codex prints the canonical `OpenLoomi Setup Status
(English)` block on the left, and the Loomi Pet pops onto your desktop
with a `Loomi is on watch` badge. Right-click the Pet and the context
menu exposes **Open Loomi / Settings / THEME (Fox ✓, Capybara) / Quit**
— visible in the same screenshot below.

The pet is a file-watcher-driven widget — it doesn't talk to the
bridge; it watches `~/.openloomi/pet-config.json` and the
`assets/{fox,capybara}/` folders.

In this run the install landed in `awaiting_user_action` with
`reason: AI_PROVIDER_REQUIRED` and `nextAction: configure_ai_provider`
— the runtime is reachable and the LaunchAgent is installed, but no AI
provider is configured yet (sign into the host's `claude` CLI or save
an Anthropic-compatible endpoint in Preferences → API Settings).

| Field                   | Value this run                                                 |
| ----------------------- | -------------------------------------------------------------- |
| `ok`                    | `true`                                                         |
| `setup`                 | `awaiting_user_action`                                         |
| `nextAction`            | `configure_ai_provider`                                        |
| `reason`                | `AI_PROVIDER_REQUIRED`                                         |
| `ready`                 | `false`                                                        |
| `mode`                  | `packaged`                                                     |
| `installed`             | `true` (`/Applications/OpenLoomi.app`)                         |
| `tokenPresent`          | `true` (session token via `~/.openloomi/token`)                |
| `apiReachable`          | `true` → `http://localhost:3414` (HTTP 200)                    |
| `codexRuntimeEnvSet`    | `true` → `OPENLOOMI_AGENT_PROVIDER=codex` (launchd-gui)        |
| `LaunchAgent installed` | `~/Library/LaunchAgents/com.openloomi.codex-runtime-env.plist` |
| `connectors available`  | `gmail, google_calendar, github, slack, linear, obsidian`      |
| `connectorSetupUrl`     | `http://localhost:3414/connectors`                             |

![Step 5 — setup prints the `OpenLoomi Setup Status (English)` block from Codex with the right-click Pet menu visible (Open Loomi / Settings / THEME: Fox ✓, Capybara / Quit)](../../apps/marketing/public/img/openloomi/plugins/codex/05-install-readiness.png)

## 6. Drive the Pet state from Codex with `@OpenLoomi pet happy`

The hot-reload pet also accepts manual state overrides from Codex. Have
Codex call the bridge directly:

```text
> @OpenLoomi pet happy
```

or, equivalently, run the bridge yourself:

```bash
node "${CODEX_PLUGIN_ROOT:-plugins/codex}/scripts/loomi-bridge.mjs" pet happy
```

The bridge writes the new state to
`~/.openloomi/pet/runtime_state.json`; the file watcher picks it up
and the sprite swaps within ~250 ms. The bridge returns
`code: PET_STATE_SET`, `state: happy`, `persisted_at`,
`path`, and `baseUrl` for confirmation.

![Step 6 — `@OpenLoomi pet happy` writes `PET_STATE_SET` to `~/.openloomi/pet/runtime_state.json` and the kawaii cat Pet flips to `happy`](../../apps/marketing/public/img/openloomi/plugins/codex/06-pet-status-happy.png)

Useful for "task done" beats where you want the pet to flip to
`happy` between turns, or any other state in the 9-state vocabulary
(`happy` / `idle` / `juggling` / `needsinput` / `presenting` /
`sleeping` / `sweeping` / `thinking` / `working`).

## 7. Pick **Capybara** — the theme hot-reloads immediately

The pet re-skins in place. The theme switch is hot-reload — the file
watcher picks up `activeTheme` in `pet-config.json` within ~250 ms, and
the bridge never writes these files.

### 7a. With Capybara active — the readiness table reflects the new theme

The Pet is rendered through `~/.openloomi/assets/capybara/{state}.png`;
the readiness table on the left is unchanged — only the artwork
swapped.

![Step 7a — Capybara theme is hot-reloaded; readiness table on the left unchanged, Pet on the right now wears the Capybara sprite in `thinking` pose](../../apps/marketing/public/img/openloomi/plugins/codex/07b-pet-capybara-theme.png)

### 7b. Drop in your own theme — `kawaii` cat via `pet-custom/`

The built-in themes are Fox and Capybara, but the pet watcher also
auto-discovers any folder under `~/.openloomi/pet-custom/<name>/` with
PNG state sprites. Drop a folder in, and the theme appears in the
right-click menu within ~250 ms — no bridge call, no restart. Below, a
`kawaii` cat pack is installed and active: the inline chat Pet in
OpenLoomi Desktop (shown `thinking` with a thought bubble while a tool
call is in flight) renders from the same pack.

![Step 7b — Custom `kawaii` theme via `~/.openloomi/pet-custom/kawaii/`; the inline chat Pet in OpenLoomi Desktop wears the kawaii cat sprite in `thinking` pose during a `bailian-cli` tool call](../../apps/marketing/public/img/openloomi/plugins/codex/07c-pet-kawaii-theme.png)

## 8. `@OpenLoomi status` returns the canonical JSON

For any triage / bug report, paste the JSON output verbatim. The shape
is stable: `mode / installed / version / tokenPresent /
nativeRuntime / apiReachable / hooksInstalled /
ready / nextAction / reason / source`

![Step 8 — Codex verifies the live runtime via `lsof -iTCP:3414` + `curl /api/native/providers` and the canonical `OpenLoomi Status` block confirms Running: Yes · PID 2320 · port 3414 · Healthy · Ready](../../apps/marketing/public/img/openloomi/plugins/codex/08-openloomi-status-runtime-healthy.png)

## 9. Codex hooks — bundled by default, no install step

Unlike the Claude plugin (where `/openloomi:hooks install` is opt-in),
the Codex plugin declares its lifecycle hooks in
`plugins/codex/hooks/hooks.json` and they are bundled into every
session automatically. The full event surface Codex maps to pet
states:

| Codex event         | Pet state set |
| ------------------- | ------------- |
| `SessionStart`      | `presenting`  |
| `UserPromptSubmit`  | `thinking`    |
| `PreToolUse`        | `working`     |
| `PermissionRequest` | `needsinput`  |
| `PostToolUse`       | `thinking`    |
| `SubagentStart`     | `juggling`    |
| `SubagentStop`      | `thinking`    |
| `Stop`              | `happy`       |

Each handler is a thin `node .../scripts/loomi-bridge.mjs state <name>
--event <event> --quiet` call with a 5s timeout. The bridge never
blocks the Codex turn; if the runtime API is unreachable it logs a
single line and exits 0.

## 10. Hooks status — confirm install

The Codex plugin's hooks are always-on, so the equivalent of "hooks
status" is just `@OpenLoomi status` — the JSON reports
`hooksInstalled: true` and `source: "codex-plugin"` whenever the
`hooks/hooks.json` block is present in the loaded plugin.

You should see:

- `hooksInstalled: true`
- Plugin path: `plugins/codex/hooks/hooks.json`
- `source: "codex-plugin"`
- `nativeRuntime: codex` (when OpenLoomi is configured to use Codex as
  its agent executor)

If `hooksInstalled` is `false`, check that you launched Codex with
`--plugin-dir plugins/codex` (or that the marketplace-installed copy
shipped the `hooks/` directory).

## 11. `@OpenLoomi handoff` — composio + screen memory + connector

The handoff skill walks you through three independent questions:
install the `composio` skill, enable Screen Memory (`Preferences →
Chronicle → Screen Memory` in the desktop app), and connect a
messaging connector (`openloomi-connectors` skill — native 7
platforms; or composio for the broader 1000+).

The screenshot below shows the connector step in the middle of the
wizard.

### 11b. Preflight — verify connector readiness before handoff

Before the handoff wizard runs, Codex preflights the `openloomi-
connectors` skill — loads its workflow guidance, calls `setup-status`,
and probes `GET /api/loop/connectors` to see what the runtime already
knows. The screenshot shows Codex asking `$openloomi:openloomi-
connectors` and the resulting `workflow-guidance` + `setup-status`
output plus the curl against `http://127.0.0.1:3414/api/loop/
connectors`.

![Step 11b — preflight check: `$openloomi:openloomi-connectors` loads `workflow-guidance` + `setup-status`, then `curl /api/loop/connectors` returns the live connector state](../../apps/marketing/public/img/openloomi/plugins/codex/11b-connectors-skill-preflight.png)

## 12. After Composio connects — 6 active apps

The next Codex turn can list what the user is actually wired up to. In
this run: Gmail, Google Calendar, Google Drive, GitHub, Linear, Slack
— all through Composio, with the workspace org and test user echoed
back.

```text
Connected via Composio (6 active): Gmail, Google Calendar, Google Drive, GitHub, Linear, Slack
Org: timi_workspace · Test user: pg-test-…
```

The probe at this point showed all six toolkits reachable, with a
happy Pet sprite reflecting the successful run.

![Step 12 — Composio Connections block after the auth probe: Gmail / Google Calendar / Google Drive / GitHub / Linear / Slack all reported Connected (6 active), with the happy Pet sprite reflecting the success](../../apps/marketing/public/img/openloomi/plugins/codex/12-composio-connections-five-active.png)

From this point on, Codex is a thin UI on top of OpenLoomi. Anything
that happens in your connected apps — emails, PRs, calendar RSVPs,
Linear issues, Slack messages — gets pulled into OpenLoomi's memory
and (if you opt in) into its proactive Loop.

> **Run note (real data, not a copy)**: the screenshots for **step 12**
> and **step 14** were captured in two different sessions. Step 12's
> probe landed cleanly with all six Composio apps connected. Step 14's
> probe was taken later, after the local Composio surface had gone
> unreachable (`composio backend unreachable (DNS / ConnectionRefused)`),
> so the Loop dashboard flipped every connector back to `needs_setup`.
> That isn't a regression — it's how the dashboard honestly reports a
> dead connector backend. The fix path is documented in step 14.

## 13. `@OpenLoomi memory` — see what's already in your local memory

### 13a. The memory skill is ready

The first time the memory skill is invoked in a session, OpenLoomi
prints a short welcome banner with example queries ("Search all my
memory for Project X" / "Show recent Gmail insights" / "What did I
know about John in January?" / "List my knowledge-base documents" /
"Remember that I prefer morning meetings" / "Find related insights
for insight_xxx"). Codex then re-invokes it a few times to prime the
search side before falling through to the digest.

![Step 13a — first invocation of `$openloomi:openloomi-memory`: the welcome banner lists example queries, and Codex hammers the skill a few times before the digest returns](../../apps/marketing/public/img/openloomi/plugins/codex/13a-memory-skill-welcome.png)

```text
> @OpenLoomi memory
```

The skill searches the local memory + knowledge base + insights and
returns a digest of what OpenLoomi already knows. In this run, the
digest is "**Today's OpenLoomi Insights (UTC 2026-07-19)**" pulled
via `list-insights --days=1`:

- **Volume** — 200+ items returned, all session-hook captures
  (platforms `codex` and `claude-code`, no Gmail / Telegram /
  WhatsApp / Lark entries yet).
- **Timeline (UTC, latest first)** — 17:06 / 17:05 Codex session
  `019f7b56` Stop hooks, 16:08 earlier Codex capture, 15:50 Claude Code
  session `e80da64c`, 15:28
  Claude Code session `aa64ea6f` (TypeScript type check passed), with
  more Codex captures spread across 14:xx–16:xx UTC.
- **Shape of every item** — `platform = codex | claude-code` matching
  groups; `importance / urgency = General`; `isFavorited /
isArchived = false`; `people / categories / topKeywords` all empty
  (no semantic extraction); `dedupeKey = null` (every Stop fires a new
  row); `description` only carries the hook event, not the transcript.

![Step 13 — `Today's OpenLoomi Insights (UTC 2026-07-19)` digest: Volume / Timeline (latest first) / Shape of every item / Takeaways](../../apps/marketing/public/img/openloomi/plugins/codex/13-memory-todays-insights.png)

This is the read-only doorway into OpenLoomi's local memory. For a
deeper search, pass a query: `@OpenLoomi memory <query>`.

### 13b. Write to memory from Codex with `add-memory`

Reading is half the story — you can also write. From any Codex turn,
invoke `openloomi-memory add-memory "<text>" --file=<path>` and the
entry lands in `~/.openloomi/data/memory/<path>`. The actual run
captured here used the lower-level `POST /api/insights` route to add
"`Tom is my boss (manager → direct report)`" with `type:
relationship` and `file: people/tom.md`. The runtime created
`~/.openloomi/data/memory/people/tom.md` containing "Tom is my boss.
Role: boss. Relationship: manager → direct report." and returned
insight ID `b5cde372-eb1b-4698-a4f0-bff6a26496f5`. The entry is
immediately searchable via `search-memory "boss"` or `search-all
"boss tom"`.

![Step 13b — `POST /api/insights` writes "Tom is my boss (manager → direct report)" to `people/tom.md`; runtime confirms `Insight created successfully` with ID `b5cde372-…` and the file `~/.openloomi/data/memory/people/tom.md` lands on disk](../../apps/marketing/public/img/openloomi/plugins/codex/13b-add-memory-tom-boss.png)

## 14. `@OpenLoomi loop` — see the Loop dashboard snapshot

```text
> @OpenLoomi loop
```

The command hits `GET /api/loop/state` and returns the Loop dashboard:

- **Header**: `enabled: true`, last tick timestamp (in this run,
  `2026-07-19T17:04:55.797Z`, ~24h ago — stale because the
  Composio backend was unreachable).
- **Counts**: pending decisions, done, dismissed, signals seen (with
  unsupported count).
- **Connector health**: per-connector status (`needs_setup` /
  `local-only` / linked) for every platform the Loop can pull from.
  In this run, **0 of 6 connected** — all six need setup; five fail
  with `composio backend unreachable (DNS / ConnectionRefused)`;
  Obsidian reports `local-only` (no remote error); zero are
  `loopMonitored` or `decisionCapable`, so the tick has nothing to
  pull.
- **Prefs in effect**: tick frequency, brief time, wrap time,
  quiet-when-empty, desktop notifications, promotion/no-reply skip,
  narrative mode (here `briefTime 09:00`, `wrapTime 21:00`,
  `intervalSec 600`, `noReplySkip` / `promotionSkip` / `narrative` /
  `quietWhenEmpty` all `on`; notifications off for both desktop and
  the cron-completion pet).
- **Notes / implication**: actionable observations — e.g. "No
  signals means no classifications, which is why the inbox is empty
  and `dismissed=1`" / "First fix is getting the Composio backend
  reachable so connectors can flip to `connected`" / "Then reconnect
  at least Gmail/Calendar/GitHub to start producing decisions".

![Step 14 — `Loop Dashboard`: `0 of 6 connected`, Composio backend unreachable (5/6), Obsidian `local-only`, stale `last tick ~24h ago`; prefs `briefTime 09:00 / wrapTime 21:00 / intervalSec 600`; implication = unblock the Composio backend first](../../apps/marketing/public/img/openloomi/plugins/codex/14-loop-dashboard.png)

This is purely a dashboard snapshot — the Loop never takes
destructive actions from this command. For actions, the Loop pops
cards in the desktop app (see step 15) and you decide there.

## 15. The Loop surfaces decision cards in OpenLoomi Desktop

This is what the system looks like when it's actually doing its job.
OpenLoomi's **Loop** is the proactive execution brain — it watches
your connected signals, classifies them into one of the decision
types, and pops a card into the desktop app with the `From Loomi`
reasoning trace and the action buttons you can hit.

Each card has the same shape: a `Signal` + `Type` + `Received` +
`Confidence` row at the top, the `From Loomi` explanation next, the
`Reason 1 / Reason 2` evidence trace, and the action buttons at the
bottom.

| Decision type           | What it does                                | Example                                                                                |
| ----------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `RSVP`                  | Reply Yes / No to a calendar invitation     | "Reverb Q3 review — Wed 10:00 PT, organizer Sarah, conflicts with standup"             |
| `IM_REPLY`              | Draft a reply to a known contact            | "Alice is bumping the Q3 deck timeline — Thursday is close, she wants it locked today" |
| `EMAIL_REPLY`           | Pre-draft an outbound email                 | "Sarah needs the Q3 OKR draft status by Friday to align with finance"                  |
| `LINEAR_REVIEW`         | Triage a Linear issue assigned to you       | "LIN-1234 (pet bubble drag-and-drop) is in In Review with you assigned"                |
| `REQUIREMENT_SYNTHESIS` | Cluster PRs/issues into a requirements doc  | "14 PRs/issues tagged loop/v0.9 — needs a single requirements doc"                     |
| `RELEASE_PLAN`          | Draft a release plan from merged PRs        | "12 PRs merged since v0.8.3 — time to draft the v0.8.3 release plan"                   |
| `CONTACT_UPDATE`        | Update a contact record when memory drifts  | "Sarah's signature says 'Head of Product' — memory still says PM"                      |
| `DOC_UPDATE`            | Refresh a stale doc for the next version    | "docs/getting-started.md is stale (42 days, pre-v0.8.3)"                               |
| `REVIEW_PR`             | Surface a PR waiting on your review         | "PR #220 (lifestyle image prompts) is waiting on your review"                          |
| `DEADLINE_REMINDER`     | Surface an upcoming due date                | "v0.8.3 release plan due Friday — 3 PRs blocking the cut"                              |
| `TODO`                  | Add a follow-up to your todo list           | "Bug: historical self-owned calendar events surface as fake RSVP decisions"            |
| `DIGEST` (QUIET)        | Consolidate a flood of low-priority signals | "8 GitHub notifications — none urgent individually, but here's the consolidated view"  |

A few of the cards in detail:

![Loop card — IM_REPLY for an Alice follow-up, with the From Loomi reasoning trace](../../apps/marketing/public/img/openloomi/plugins/codex/15-loop-im-reply.png)

![Loop card — IM_REPLY expanded into a full reply composer with To: and Body fields](../../apps/marketing/public/img/openloomi/plugins/codex/16-loop-im-reply-expanded.png)

![Loop card — LINEAR_REVIEW for LIN-1234 "pet bubble drag-and-drop" in In Review](../../apps/marketing/public/img/openloomi/plugins/codex/17-loop-linear-review.png)

![Loop card — REQUIREMENT_SYNTHESIS for 14 PRs/issues tagged loop/v0.9](../../apps/marketing/public/img/openloomi/plugins/codex/18-loop-requirement-synthesis.png)

![Loop card — RELEASE_PLAN for v0.8.3 "classifier-rules UX + custom channels"](../../apps/marketing/public/img/openloomi/plugins/codex/19-loop-release-plan.png)

![Loop card — CONTACT_UPDATE for Sarah Chen's new "Head of Product" role](../../apps/marketing/public/img/openloomi/plugins/codex/20-loop-contact-update.png)

![Loop card — DOC_UPDATE for docs/getting-started.md (42 days stale) with working pet sprite](../../apps/marketing/public/img/openloomi/plugins/codex/21-loop-doc-update.png)

![Loop card — DRAFT_REPLY for the Q3 OKR status email to Sarah Chen](../../apps/marketing/public/img/openloomi/plugins/codex/22-loop-draft-reply.png)

![Loop card — DRAFT_REPLY expanded with Subject and Body reply editor (happy pet sprite)](../../apps/marketing/public/img/openloomi/plugins/codex/23-loop-draft-reply-expanded.png)

![Loop card — REVIEW_PR for PR #220 "compose lifestyle image prompts"](../../apps/marketing/public/img/openloomi/plugins/codex/24-loop-review-pr.png)

![Loop card — TODO for issue #382 "historical RSVPs misclassified"](../../apps/marketing/public/img/openloomi/plugins/codex/25-loop-todo.png)

![Loop card — DIGEST (QUIET) consolidating 8 GitHub notifications, opened from the chat response](../../apps/marketing/public/img/openloomi/plugins/codex/26-loop-digest.png)

### 15b. From the card — Dry run / Edit / Run / Dismiss

The action row at the bottom of every card turns a recommendation into
a real outcome. The exact buttons depend on the card type:

- **`RSVP`** (calendar invitation): **Attend** (primary) · **Decline**
  (outline) · **View original** (ghost). Tap Attend or Decline and
  OpenLoomi fires your `Yes` / `No` straight back through the connected
  Google Calendar as a `calendar_rsvp` action — no opening the event
  yourself to click the RSVP buttons.
- **Reply / update cards** (`IM_REPLY`, `EMAIL_REPLY`, `REVIEW_PR`,
  `LINEAR_REVIEW`, `REQUIREMENT_SYNTHESIS`, `RELEASE_PLAN`,
  `CONTACT_UPDATE`, `DOC_UPDATE`, `DEADLINE_REMINDER`, `TODO`):
  **Dry run** (outline) · **Edit** · **Run** (primary when ready) ·
  **Dismiss** (ghost). `Dry run` previews the exact draft or plan
  without firing; `Run` schedules the action through the right
  connector — `email_reply` via Gmail, `im_reply` via Slack /
  iMessage, `github_review` via the GitHub Reviews API,
  `linear_review` via Linear, `requirement_synthesis` /
  `release_plan` / `doc_update` into the local knowledge base,
  `contact_update` into memory, `todo` into the local todo store.
- **Quiet digests** (`DIGEST` / `QUIET_DIGEST` /
  `github_notification`): **Mark as read** only — read-only
  aggregations, nothing to execute.

Two affordances live outside the action row so they never collide
with the decision itself:

- **Card-level Dismiss** sits in the header kebab (three-dot menu).
  Dismissing a card never accidentally declines a meeting. A mute
  rule is created for that signal scope, so the same hint won't
  resurface today.
- **Cancel scheduled action** appears for ~30 s after you tap Run /
  Attend / Decline. The action is queued as a cron job before it
  actually fires — `Cancel` stops it. A per-card audit history
  (under the technical details) records every attempt with its
  terminal state (`completed` / `skipped` / `blocked` / `failed` /
  `cancelled` / `superseded`), so contradictory responses (e.g. RSVP
  "No" then "Yes") appear side-by-side instead of overwriting each
  other.

If the underlying connector refuses (the runner returns `blocked` or
`failed`), the action row stays open with a one-tap retry — the card
never silently flips to `done` when nothing actually happened.

## 16. Register your own decision types

The Loop ships with the decision types above out of the box. You can
register your own — the contract is just a `PUT /api/loop/types`
against the local runtime. From a Bash block in Codex, paste and run:

```bash
TOKEN=$(cat ~/.openloomi/token | base64 -d)

# 1) Register the custom type
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:3414/api/loop/types \
  -d '{
    "id": "mom_imessage_alert",
    "label": "Mom iMessage",
    "icon": "👩",
    "actionKind": "todo",
    "description": "Triggers when mom sends an iMessage — surfaces as a high-priority todo so you never miss her"
  }' | python3 -m json.tool

# 2) Verify it landed in the type registry
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3414/api/loop/types | python3 -m json.tool
```

The runtime echoes the new type back with the icon, label, and
`actionKind` you registered, and the next `/api/loop/state` tick
already lists it under `supportedTypes`. (No screenshot for this step —
the curl output is the receipt; if you want to verify the type landed,
re-run step 2 above.)

## 17. The custom type fires on the next signal

When the next matching signal arrives, your custom card appears in
the desktop app with the icon and label you registered, the
`iMessage` signal + type metadata, and the standard action row.

![Step 17 — MOM_IMESSAGE_ALERT custom type fires and surfaces a high-priority todo card](../../apps/marketing/public/img/openloomi/plugins/codex/28-loop-mom-imessage-alert.png)

---

That's the full flow. Codex stays the surface you already know;
OpenLoomi becomes the memory, the connector layer, the proactive
brain, and the always-on desktop pet.
