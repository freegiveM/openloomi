---
description: Walk a brand-new OpenLoomi user through the entire pipeline in one guided session — thin doorway into the openloomi-tour sub-skill
argument-hint: ""
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/loomi-bridge.mjs *), Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/openloomi-connectors/scripts/openloomi-connectors.cjs *), Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/openloomi-memory/scripts/openloomi-memory.cjs *), Bash(composio *), Bash(curl *), Bash(jq *), Bash(cat ~/.openloomi/token *), Bash(base64 -d *)
---

# /openloomi:tour

Thin doorway into the [`openloomi-tour`](../skills/openloomi-tour/SKILL.md)
sub-skill. The skill runs the full first-run pipeline live with
checkpoints between phases:

1. Pre-flight (`setup-status`, `run-host-probe`, native Claude runtime probe)
2. Pet reaction (4 sprite states cycled)
3. Connector onboarding (native bot vs Composio OAuth — user picks)
4. Run one Loop tick + inspect & approve a decision card
5. Seed Memory (`add-memory` × 3 + `search-all`)
6. Optional extensions: custom Loop channel / classifier rule / decision type

The skill is the source of truth — read it first for the exact shell
snippets per phase. This doorway just confirms the entry point.

## Steps

1. Confirm `setup: ready` (or run `/openloomi:setup` first if not).
2. Load the [`openloomi-tour`](../skills/openloomi-tour/SKILL.md) skill
   and execute its phases in order. Stop between phases for the user
   to react (`next` / `skip` / `back`).
3. On exit (`done`, `exit`, or all five phases complete), print the
   quick-reference card from the `/openloomi:setup` post-ready
   walkthrough.

## When to suggest

- "I just installed OpenLoomi, what now?" → `/openloomi:tour`
- "Show me everything OpenLoomi can do" → `/openloomi:tour`
- "Walk me through the pipeline" → `/openloomi:tour`
- "带我看一下" / "体验一下" / "一条龙" → `/openloomi:tour`

For everything _inside_ the tour (specific commands, decision card
shapes, channel registration payloads), say the trigger phrase from
the [`openloomi-tour`](../skills/openloomi-tour/SKILL.md) frontmatter
and Claude will pick the right subcommand.
