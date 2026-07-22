---
description: List all /openloomi:* commands
argument-hint: ""
---

# /openloomi:help

Static reference. Lists all slash commands in the `openloomi:` namespace.

| Command                                         | Purpose                                                         |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `/openloomi:setup`                              | One-time setup wizard (discover → install → ready)              |
| `/openloomi:status`                             | Stable JSON status                                              |
| `/openloomi:pet <state>`                        | Set the Loomi Pet state                                         |
| `/openloomi:usage`                              | Today's LLM usage summary                                       |
| `/openloomi:connect`                            | Walk through composio + screen memory (opt-in)                  |
| `/openloomi:hooks [install\|uninstall\|status]` | Manage the optional hook bundle                                 |
| `/openloomi:loop`                               | Loop dashboard snapshot (doorway into `openloomi-loop`)         |
| `/openloomi:memory <query>`                     | Search memory + KB + insights (doorway into `openloomi-memory`) |
| `/openloomi:tour`                               | Guided first-run walkthrough (doorway into `openloomi-tour`)    |
| `/openloomi:help`                               | This help                                                       |

None of these commands handle AI provider API keys. AI provider
configuration lives in the OpenLoomi runtime itself — the runtime
detects the user's local `claude` CLI auth, and never shares keys with
Claude Code.
