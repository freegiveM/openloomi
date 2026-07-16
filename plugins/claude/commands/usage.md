---
description: Show today's LLM usage summary as recorded by OpenLoomi
argument-hint: ""
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/loomi-bridge.mjs *)
---

# /openloomi:usage

Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/loomi-bridge.mjs usage
```

Print the resulting JSON to the user. Real response shape:

- `configured` (boolean) — provider is configured
- `providerSince` — ISO 8601 timestamp when the provider was first set
- `currentProvider` — `{ providerType, model, enabledSince }`
- `trackedEndpoints` — array of endpoint names being tracked
- `totals` — `{ inputTokens, outputTokens, totalTokens }` aggregated
  over the tracked period
- `runCount` — number of runs in the tracked period
- `firstRunAt` / `lastRunAt` — ISO 8601 timestamps
- `trackedProviders` — array of provider names included
- `asOf` — ISO 8601 timestamp of when the summary was computed

If the API is unreachable the bridge returns
`code: "API_UNREACHABLE"` — surface that and prompt the user to start
OpenLoomi Desktop.
