# Splitting OpenLoomi into Runtime + UI Sub-Projects

This document defines the boundary contract for splitting the openloomi
monorepo into two logical sub-projects:

- **runtime** — memory / context / environment / agent / cron / loop / integrations / db
- **ui** — Next.js apps, Tauri shell, components, hooks

The two sub-projects live in the same repo and share `pnpm-workspace.yaml`,
but have clearly delineated ownership, dependency rules, and CI matrices.

## Target structure (end of Phase 9)

```
openloomi/
├─ runtime/
│  ├─ packages/
│  │  ├─ ai/, ai/mcp/, ai/memory-consolidation/, ai/rag/
│  │  ├─ memory-store/, rag/, sqlite/, search/, security/,
│  │  │  storage/, audit/, config/
│  │  ├─ integrations/  (umbrella + 21 sub-packages)
│  │  └─ contracts/     ← this package
│  ├─ services/
│  │  ├─ db/            (Drizzle schema + queries)
│  │  ├─ cron/
│  │  ├─ loop/
│  │  ├─ insights-service/
│  │  ├─ integrations-runtime/
│  │  └─ env-config/
│  └─ apps/
│     ├─ memory-http/
│     └─ mcp-gateway/
├─ ui/
│  ├─ apps/
│  │  ├─ web/   (Next.js + Tauri shell + cli-bundle)
│  │  └─ marketing/
│  └─ packages/
│     ├─ ui-runtime/  (Tauri-aware platform/env detection)
│     ├─ hooks/, components/, i18n/
│     └─ shared-ui/
├─ benchmark/  (unchanged)
└─ pnpm-workspace.yaml
```

## Boundary contract

### Type ownership

| Type | Owner | Re-exported for backward compat |
|---|---|---|
| `UserType` | `@openloomi/contracts/user-type` | `apps/web/app/(auth)/auth.ts` (Phase 2) |
| `IntegrationId` | `@openloomi/contracts/integration-id` | `apps/web/hooks/use-integrations.ts` (Phase 3) |
| `AuthErrorCode` | `@openloomi/contracts/errors` | `apps/web/lib/auth/error-codes.ts` (Phase 2) |
| JWT / Session augmentation | `apps/web/app/(auth)/auth.ts` | — (NextAuth-specific, stays in UI) |
| Domain types (memory graph, etc.) | owning runtime package | — |

### Runtime / UI dependency rules

| Layer | May import from | Must NOT import from |
|---|---|---|
| `runtime/packages/*` (SDK only) | other `runtime/packages/*`, `zod`, Node stdlib | `react`, `next`, `@tauri-apps/api`, `apps/web/**` |
| `runtime/services/*` | `runtime/packages/*`, `@openloomi/contracts`, Node stdlib | same as above |
| `runtime/apps/*` (daemons) | everything in `runtime/` | `apps/web/**` |
| `ui/packages/*` | `@openloomi/contracts`, peer UI deps | `runtime/services/**` (use SDK or HTTP/MCP) |
| `ui/apps/web/**` | everything except `runtime/services/**` (use SDK or HTTP/MCP) | — |
| `ui/apps/web/instrumentation.ts` | `runtime/services/{loop,cron}` | — |

A lint rule in `apps/web/.eslintrc` enforces `lib/*` does NOT import
`@/app/(auth)/auth`. The reverse (`runtime/*` importing `ui/*`) is structurally
prevented by the workspace boundaries once Phase 9 is done.

### Tauri detection

Only `ui/packages/ui-runtime/` statically imports `@tauri-apps/api`.
Other packages use one of:

- `import { isTauri } from "@openloomi/ui-runtime/platform/env"` (UI-side code)
- a lazy `try { require("@tauri-apps/api/core").isTauri } catch { return false }`
  pattern (server-side code that needs to detect Tauri at runtime)

`@openloomi/shared` MUST NOT statically import `@tauri-apps/api` after Phase 8.
A grep check in CI enforces this:

```bash
! git grep -l "@tauri-apps" packages/{memory-store,ai,rag,integrations,shared}/src
```

### `@openloomi/indexeddb` coupling

`@openloomi/memory-store` historically pulled in `@openloomi/indexeddb` at module
evaluation time, breaking the standalone HTTP / MCP daemons. After Phase 1:

- `packages/memory-store/package.json` makes `@openloomi/indexeddb` an
  **optional** peer dependency.
- Constants/types that came from `@openloomi/indexeddb` are now defined
  locally in `@openloomi/memory-store`.
- A deprecated re-export shim preserves backward compat for the legacy
  in-process consumer (`apps/web`).

### Daemon pattern (memory-store as the template)

Every runtime service that benefits from cross-process consumption ships with:

1. **SDK entry** (`<package>`) — direct in-process import, used by tests and Tauri mode
2. **Hono HTTP entry** (`<package>/http`) — standalone daemon, used by external hosts
3. **MCP stdio entry** (`<package>/mcp`) — standalone daemon, used by Claude Desktop / Cursor
4. **npm bins** — `<package>-http` and `<package>-mcp` for direct CLI invocation

This is the pattern `@openloomi/memory-store` already ships with; every future
runtime service follows the same shape.

### Cross-process wiring (Phase 10)

For each runtime package, decide based on actual consumption patterns:

| Package | Recommended mode | Reason |
|---|---|---|
| `@openloomi/memory-store` | HTTP daemon in cloud mode, in-process in Tauri | already supports both; default to in-process for Tauri |
| `@openloomi/insights-service` | TBD after extraction | needs latency benchmark |
| `@openloomi/loop` | TBD | same |
| `@openloomi/integrations-runtime` | in-process for Tauri, HTTP for cloud multi-tenant | only the cloud deployment benefits |

Gating per-package via env vars (e.g. `MEMORY_STORE_HTTP_URL`). Tauri mode
defaults to in-process; cloud mode defaults to HTTP. Roll-forward only after
benchmark parity is proven.

## Phases

See [`plans/runtime-ui-split.md`](./runtime-ui-split.md) for the full phased plan,
or the recent git history for in-flight PRs. Each phase is independently
shippable and does NOT break the running apps/web.

| Phase | Scope | Risk | Status |
|---|---|---|---|
| 0 | Contracts package skeleton, path aliases, this doc | none | in progress |
| 1 | Break memory-store ↔ indexeddb (optional peer dep) | low | pending |
| 2 | Move UserType + AuthErrorCode to contracts | medium | pending |
| 3 | Move IntegrationId to contracts | very low | pending |
| 4 | Move lib/db → @openloomi/db | high | pending |
| 5 | Move cron + Loop → @openloomi/{cron,loop} | medium | pending |
| 6 | Move insights → @openloomi/insights-service | high | pending |
| 7 | Move integrations glue → packages + integrations-runtime | medium | pending |
| 8 | Move env/config + remove Tauri from shared | low | pending |
| 9 | Top-level directory restructure | high mechanical | pending |
| 10 | Opt-in HTTP/MCP wiring per-package | medium | pending |

## Out of scope

- Renaming `@openloomi/*` package scope.
- Splitting the repo (stays single-repo).
- Unifying Drizzle Postgres + SQLite schemas.
- Migrating between Biome and ESLint.
- Touching `apps/marketing` (zero `@openloomi/*` deps).