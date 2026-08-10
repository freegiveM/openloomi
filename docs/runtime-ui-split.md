# Runtime / UI Split — Phase Plan

Full 10-phase plan for splitting openloomi into `runtime/` and `ui/` sub-projects.

See [`split-runtime-ui.md`](./split-runtime-ui.md) for the boundary contract.

## Phase 0 — Boundary contract

**Goal**: Establish the type-ownership contract without changing runtime behavior.

**Creates**:
- `packages/contracts/` — `@openloomi/contracts` package
  - `src/user-type.ts` — canonical `UserType`
  - `src/integration-id.ts` — canonical `IntegrationId`
  - `src/errors.ts` — `AuthErrorCode` (moved from `apps/web/lib/auth/error-codes.ts` in Phase 2)
  - `src/schemas.ts` — zod schemas
  - `package.json`, `tsconfig.json`, `tsup.config.ts`, `README.md`
- `docs/split-runtime-ui.md` — boundary contract
- `docs/runtime-ui-split.md` — this phase plan

**Updates**:
- `apps/web/tsconfig.json` — add `@openloomi/contracts` path alias
- `apps/web/vitest.config.ts` — add `@openloomi/contracts` vitest alias
- `pnpm-workspace.yaml` — already covers `packages/*` glob, no change

**Verification**: `pnpm --filter @openloomi/contracts build` produces ESM + dts; no runtime files change.

## Phase 1 — Break `@openloomi/memory-store` ↔ `@openloomi/indexeddb`

**Goal**: Memory HTTP/MCP daemons must not pull in browser-only code at module evaluation.

**Touches**:
- `packages/memory-store/src/policies/memory-graph-write-policy.ts` — define `CHAT_MEMORY_EVIDENCE_ID_PREFIX` locally
- `packages/memory-store/src/storage/chroma-memory-index.ts` — local `RawMessage` type
- `packages/memory-store/package.json` — `@openloomi/indexeddb` → `peerDependenciesMeta.optional`

**Verification**: smoke `openloomi-memory-http` and `openloomi-memory-mcp` start without `window is not defined`.

## Phase 2 — Decouple `UserType` + `AuthErrorCode`

**Touches** (~30 files):
- `apps/web/app/(auth)/auth.ts:36` — re-export `UserType` from `@openloomi/contracts` (add `// canonical source: @openloomi/contracts` comment)
- `apps/web/lib/auth/error-codes.ts` — re-export `AuthErrorCode` from `@openloomi/contracts`
- 20+ lib files switch `import type { UserType } from "@/app/(auth)/auth"` → `from "@openloomi/contracts"`
- `packages/integrations/src/core/index.ts:42` — rename local `"user"|"guest"` `UserType` to `LocalUserType`
- `apps/web/.eslintrc` — add `@typescript-eslint/no-restricted-imports` rule for `lib/*` banning `@/app/(auth)/auth`

**Verification**: `git grep -l "from '@/app/(auth)/auth'" apps/web/lib` is empty; auth flow integration test passes; JWT/Session augmentation shape unchanged.

## Phase 3 — Decouple `IntegrationId`

**Touches** (~8 files):
- `apps/web/hooks/use-integrations.ts` — re-export `IntegrationId` from `@openloomi/contracts`
- 7 lib files switch `import type { IntegrationId } from "@/hooks/use-integrations"` → `from "@openloomi/contracts"`

**Verification**: `git grep -l "from '@/hooks/use-integrations'" apps/web/lib` is empty; hook still works.

## Phase 4 — `lib/db` → `@openloomi/db`

**Touches** (~35 files / ~13,000 LOC):
- New `packages/db/` containing `schema.pg.ts` (2,941 LOC), `schema-sqlite.ts` (3,566 LOC), `queries.ts` (9,488 LOC), `adapters/`, `migrations/`, `migrations-sqlite/`, `shared/`
- `apps/web/lib/db/*` becomes re-export shim
- `apps/web/drizzle.config.ts` + `apps/web/drizzle.config.sqlite.ts` point at new package
- `apps/web/tsconfig.json` + `vitest.config.ts` drop unused `@/lib/db` aliases
- **Critical**: `dotenv.config({ path: ".env" })` at `queries.ts:23-25` MUST move to daemon entry points

**Verification**: `pnpm --filter @openloomi/db build`; existing db tests pass; sign-in + chat history load in `apps/web`; migration scripts run.

## Phase 5 — cron + Loop → `@openloomi/cron` + `@openloomi/loop`

**Touches** (~50 files):
- `packages/cron/` — `executor.ts`, `local-scheduler.ts`, `service.ts`, `insight-maintenance.ts`, `notifications.ts`, `types.ts`
- `packages/loop/` — `server.ts`, `scheduler.ts`, `runner.ts`, `tick.ts`, `brief.ts`, `wrap.ts`, `handlers.ts`, `activation.ts`, `decisions.ts`, `outcomes.ts`, `store.ts`, `preferences.ts`, `types.ts`, `paths.ts`, `legacy-cleanup.ts`
- `apps/web/lib/env/tauri-paths.ts` moves with Loop
- `apps/web/instrumentation.ts` changes dynamic imports

**Verification**: `pnpm tauri:dev` boots loop scheduler, registers handlers, runs no-op tick.

## Phase 6 — `insights` → `@openloomi/insights-service`

**Touches** (38 files):
- New `packages/insights-service/` mirroring memory-store shape (SDK + optional HTTP)
- `embedding.ts`, `compaction.ts`, `compaction-runtime.ts`, `compaction-profile.ts`, `dream.ts`, `hebbian.ts`, `tier.ts`, `maintenance.ts`, `refresh.ts`, `search.ts`, `timeline.ts`, `transform.ts`, `weight-adjustment.ts`, `filter-schema.ts`, `platform-filter-config.ts`, `processor.ts`, `service.ts`, `types.ts`, ...

Sub-PR structure:
- 6a: read-only helpers (tier, transform, search, types, filter-schema) + shim re-exports
- 6b: service.ts + processor.ts + main consumers (embedding, compaction, refresh)
- 6c: HTTP daemon skeleton (matching memory-store shape)

## Phase 7 — integrations glue

**Touches** (~40 files):
- `apps/web/lib/integrations/{gmail,slack,discord,teams,weixin,feishu,dingtalk,qqbot,linear,notion,imessage,jira}/` → merge into `packages/integrations/{platform}/`
- New `packages/integrations-runtime/` for `client`, `oauth`, `connector-target`, `notification-channel-guard`, `pending-chat-resume`, `task-integration-inference`, `providers`, `authorization-errors`
- Each integration package gains `ws-listener.ts` entry; `apps/web/instrumentation.ts` updates imports

## Phase 8 — env/config + remove Tauri from shared

**Touches**:
- New `packages/env-config/` from `apps/web/lib/env/*`
- New `ui/packages/ui-runtime/` — owns `@tauri-apps/api` imports
- `packages/shared/src/platform/{env,filesystem}.ts` becomes lazy require or deleted

**Verification**: `git grep "@tauri-apps" packages/{memory-store,ai,rag,integrations,shared}/src` returns empty.

## Phase 9 — Top-level directory restructure

**Touches**:
- `git mv packages/{ai,api,audit,memory-store,rag,search,security,shared,sqlite,storage,contracts,config} runtime/packages/`
- `git mv packages/{cron,loop,insights-service,db,integrations-runtime,env-config} runtime/services/`
- `git mv apps/{web,marketing} ui/apps/`
- `git mv packages/{hooks,i18n} ui/packages/`
- `git mv packages/ui-runtime/ ui/packages/ui-runtime/`
- Rewrite `pnpm-workspace.yaml`
- Update all `--filter='./packages/*'` references in root `package.json` scripts and CI

## Phase 10 — Opt-in HTTP/MCP wiring

**Per-package, opt-in**:
- 10a: memory-store HTTP for cloud mode (already wired in Phase 1+; flip default)
- 10b: insights-service HTTP — benchmark before flip
- 10c: loop HTTP — benchmark before flip
- 10d: integrations-runtime HTTP — only for cloud multi-tenant

Each sub-phase: latency benchmark before/after, feature parity integration test, env-flag-graded rollout.

## Risks per phase

See plan output for the full risk register. Key callouts:
- **Phase 4** (db): highest LOC volume; `dotenv.config` must not stay in package
- **Phase 6** (insights): many internal coupling edges; sub-PR structure mandatory
- **Phase 9** (restructure): all `--filter` references and CI matrices need rewriting

## Things NOT in scope

- Renaming `@openloomi/*` scope
- Splitting the repo (single repo retained)
- Unifying Drizzle pg/sqlite schemas
- Migrating Biome ↔ ESLint
- Touching `apps/marketing`