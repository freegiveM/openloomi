# Phase 10 — HTTP/MCP cross-process wiring per package

> **Status (Aug 2026):** memory-store ships the canonical pattern. Other runtime
> packages (cron, loop, insights, integrations-runtime) are intentionally
> in-process for now and will get HTTP/MCP daemons on demand.

## Daemon pattern (memory-store as the template)

Every runtime service that benefits from cross-process consumption ships with:

1. **SDK entry** (`<package>`) — direct in-process import, used by tests and Tauri mode
2. **Hono HTTP entry** (`<package>/http`) — standalone daemon, used by external hosts
3. **MCP stdio entry** (`<package>/mcp`) — standalone daemon, used by Claude Desktop / Cursor
4. **npm bins** — `<package>-http` and `<package>-mcp` for direct CLI invocation

## Per-package status

| Package | SDK | HTTP | MCP | npm bins | Notes |
|---|---|---|---|---|---|
| `@openloomi/memory-store` | yes | yes (`memory-store/http`) | yes (`memory-store/mcp`) | `openloomi-memory-http`, `openloomi-memory-mcp` | Reference implementation |
| `@openloomi/cron` | yes | — | — | — | In-process scheduler; HTTP/MCP deferred until multi-tenant need |
| `@openloomi/loop` | yes | — | — | — | In-process loop; HTTP/MCP deferred until multi-tenant need |
| `@openloomi/insights` | yes | — | — | — | In-process insights; HTTP/MCP deferred until latency benchmark justifies |
| `@openloomi/integrations-runtime` | yes | — | — | — | Pure UI glue (visuals, patterns); no state, no daemon needed |
| `@openloomi/env-config` | yes | n/a | n/a | — | Constants only, no daemon |
| `@openloomi/ui-runtime` | yes | n/a | n/a | — | UI-side platform detection only |
| `@openloomi/shared` | yes | n/a | n/a | — | Pure primitives |
| `@openloomi/contracts` | yes | n/a | n/a | — | Pure types |
| `@openloomi/db` | yes | n/a | n/a | — | Used by HTTP daemons, not a daemon itself |

## Gating

Cross-process consumption is gated per-package via env vars. Defaults:

| Variable | Default | Effect |
|---|---|---|
| `MEMORY_STORE_HTTP_URL` | unset | When set, in-process memory-store calls proxy to this URL. Unset means direct in-process. |
| `INSIGHTS_SERVICE_HTTP_URL` | unset | Same pattern, when Phase 10 wires insights-service. |
| `LOOP_HTTP_URL` | unset | Same pattern, when Phase 10 wires loop. |
| `INTEGRATIONS_RUNTIME_HTTP_URL` | unset | Not planned — pure UI glue. |

**Tauri mode** defaults to in-process (no HTTP daemon started).
**Cloud mode** can opt in by setting the URL. Roll-forward only after benchmark
parity is proven.

## Adding a daemon to a new package

To add HTTP/MCP support to a runtime package, mirror memory-store:

1. Add `src/http.ts` exporting `startHttpServer(options)` that wires a Hono app
   against the package's existing in-process API.
2. Add `src/mcp.ts` exporting `startMcpServer(options)` that registers tools
   against an `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`.
3. Add `src/server/cli-http.ts` and `src/server/cli-mcp.ts` thin wrappers that
   invoke the start functions, parse process env, and exit cleanly on SIGINT.
4. Update `tsup.config.ts` to emit `http` and `mcp` entries.
5. Update `package.json` `exports` and `bin` fields.
6. Add a smoke test (`tests/smoke.ts`) that spins the daemon up on a random
   port, hits it, and tears it down.

This is exactly what memory-store does; copy-paste the structure when wiring
cron, loop, or insights.