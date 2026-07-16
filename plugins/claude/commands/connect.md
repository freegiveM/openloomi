---
description: Walk the user through installing the optional composio skill and turning on screen memory
argument-hint: ""
allowed-tools: Bash(composio *), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/loomi-bridge.mjs status *)
---

# /openloomi:connect

Walk the user through three independent opt-in steps. Each step is gated by
an explicit y/N from the user. NOTHING happens silently.

## Step 1 — Verify `composio` skill readiness

Before asking the user anything, **detect** whether `composio` is already
in place. Two pieces must both exist for Step 1 to be a no-op:

```bash
# 1. CLI on PATH?
command -v composio >/dev/null 2>&1

# 2. Skill shipped in this plugin?
test -f "${CLAUDE_PLUGIN_ROOT}/skills/composio/SKILL.md"
```

Then branch on the combined result:

- **Both present** → print one line
  (`composio ready: CLI on PATH, skill loaded from plugins/claude/skills/composio/`)
  and continue straight to Step 2. **No y/N.**
- **CLI missing only** → ask:
  > Composio CLI not on PATH. Install it via the official installer?
  > (`curl -fsSL https://composio.dev/install | bash`) [y/N]
  > On y, run that command. **Never run `npm install -g` without consent.**
- **Skill missing only** → ask:
  > The composio skill isn't shipped in this plugin (`plugins/claude/skills/composio/SKILL.md` missing).
  > Restore it (e.g. `git pull` or reinstall the plugin)? [y/N]
  > On y, defer to whatever restore flow the user picks; do not regenerate
  > skill content here.
- **Both missing** → ask the CLI-missing question; the skill ships
  with the plugin and will come back when the plugin is restored, so
  one y/N is enough.

After Step 1 resolves (no-op or install), continue to Step 2.

## Step 2 — Enable screen memory

Tell the user:

> OpenLoomi Desktop's user profile / preferences page has a "Chronicle"
> section that controls Screen Memory. Turn it on to let Loomi
> summarize what you're looking at. Open the Preferences page now? [y/N]

Only on explicit y/N: print the navigation hint
`OpenLoomi Desktop → Preferences → Chronicle → Screen Memory`
and continue.

**Do NOT print any `openloomi://...` URL.** The plugin codebase does
not register a deep-link scheme for this entry — only the navigation
hint above is real.

## Step 3 — Connect at least one messaging connector

Suggest the `openloomi-connectors` skill, which ships **with this plugin**
at `plugins/claude/skills/openloomi-connectors/`. Defer to that skill's
own onboarding flow for OAuth and connector discovery; do not duplicate
OAuth logic here.

For accounts connected through **Composio** (a broader 1000+ apps
surface — X, LinkedIn, Notion, HubSpot, Linear, Jira, etc.), invoke the
`composio` skill in parallel per that skill's own guidance. When the
user asks "what am I connected to?" or "list my accounts", present the
union of both sources.

## Reminder

Never print or echo any tokens. Never pass `--api-key` flags. Never
download additional binaries. The plugin is intentionally read-mostly.
