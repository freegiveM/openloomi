---
description: Search OpenLoomi memory (files + knowledge base + insights) — thin doorway into the openloomi-memory sub-skill
argument-hint: "<query>"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/openloomi-memory/scripts/openloomi-memory.cjs *)
---

# /openloomi:memory <query>

Thin doorway into the
[`openloomi-memory`](../skills/openloomi-memory/SKILL.md) sub-skill.

- With a `<query>` argument → runs `search-all` across local memory
  files, the knowledge base (RAG), and recent insights.
- With no argument → lists the most recent 7 days of insights
  (`list-insights --days=7`) so the user can see what's already been
  captured.

For everything else (filter by channel, get a single document / insight,
create / update / delete, time-travel queries, living connections,
entity registry) say "memory search", "knowledge base", "insights" —
the sub-skill's frontmatter triggers on those phrases and walks Claude
through the right subcommand.

The CLI lives at
`${CLAUDE_PLUGIN_ROOT}/skills/openloomi-memory/scripts/openloomi-memory.cjs`
and auto-reads the bearer token from `~/.openloomi/token`.

## Steps

1. **With query** — run a comprehensive search:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/skills/openloomi-memory/scripts/openloomi-memory.cjs \
     search-all "<query>"
   ```

   Aggregate results from `memory` (local files), `knowledge` (RAG), and
   `insights`. Print top 5 from each source with file path / doc id /
   insight id and a short preview. If the user wants more, run the same
   with `--limit` raised, or fall through to a specific source via the
   sub-skill's `search-memory` / `search-knowledge` / `list-insights`
   commands.

2. **Without query** — list recent insights:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/skills/openloomi-memory/scripts/openloomi-memory.cjs \
     list-insights --days=7
   ```

   Print the most recent 10 (or all if fewer than 10) with their `type`,
   `groups`, `time`, and a short `content` preview.

3. If the user asks for a specific source after seeing results, dispatch
   to the matching subcommand:

   | Source         | Subcommand                                                                       |
   | -------------- | -------------------------------------------------------------------------------- |
   | Local files    | `search-memory "<query>" [--directory=<subdir>]`                                 |
   | Knowledge base | `search-knowledge "<query>"` or `list-documents` / `get-document <id>`           |
   | Insights       | `list-insights [--days=N] [--channel=<gmail\|telegram\|...>] [--keyword=<k>...]` |

## Failure modes

| Symptom                                    | What to surface                                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.openloomi/token` missing or unreadable | Run `/openloomi:setup` first to mint a guest bearer.                                                                                          |
| CLI exits with `AUTH_FAILED`               | Same as above — token is stale or invalid.                                                                                                    |
| `search-knowledge` returns empty           | Likely no documents uploaded yet. Tell the user the knowledge base is empty and they can upload via OpenLoomi Desktop → Knowledge Base.       |
| `search-memory` returns empty              | Local `~/.openloomi/data/memory/` has no matches for the query. That's a legitimate result, not an error — surface the empty `results` array. |

## Constraints

- **Never** delete memory files or insights without explicit user
  confirmation of the target path / id. The CLI's `delete-memory` /
  `delete-insight` commands are irreversible.
- **Never** write to `~/.openloomi/data/memory/` directly from this
  command. Use `add-memory` (with `--file` and `--directory`) so the
  filename and placement are deterministic and audit-able.
- The skill is a **doorway** — don't duplicate the sub-skill's full
  API reference here. If the user asks for something this doc doesn't
  cover, route to the sub-skill via natural-language triggers.
