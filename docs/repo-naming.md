# Repo naming — runtime split

> **Decision (Aug 2026):** the runtime sub-project will be split out into
> a standalone repo at **`melandlabs/opencontext`**, with packages re-namespaced
> from `@openloomi/*` to **`@opencontext/*`**.

## Why opencontext

The runtime sub-project (`runtime/packages/*` in the current monorepo) is
the "context-providing" backend — it owns memory, search, scheduling, env,
integrations glue, and the daemons that any UI host (openloomi web,
third-party MCP client, headless cron) calls into. "opencontext" captures
that in one word.

Names considered:

| Name | Verdict |
|---|---|
| `loomicontext` | Rejected — distinctive but the portmanteau is awkward; loses the npm namespace if packages stay `@openloomi/*`. |
| `opencontext` | **Chosen** — clean, reads as "open + context", matches the spirit of the existing `openloomi` brand without being a portmanteau. |
| `loomicore` | Rejected — "core" is too vague; what's the core? |
| `loomkernel` | Rejected — "kernel" implies OS-level primitives, but this is high-level SDK + daemons. |
| `loomos` | Rejected — "OS" is overclaim. |

## Migration plan

### 1. Create the new repo

```bash
gh repo create melandlabs/opencontext --public \
  --description "OpenLoomi runtime — context-providing backend SDK + HTTP/MCP daemons." \
  --homepage https://github.com/melandlabs/openloomi
```

### 2. Move the runtime sub-trees

Each `runtime/packages/*` package moves to `packages/*` in the new repo
(strip the `runtime/` prefix; the new repo IS the runtime, so the deeper
directory is redundant).

Likewise `runtime/apps/*` and `runtime/services/*` move to `apps/*` and
`services/*`.

`packages/*` packages that survive the split (DB, contracts, ai, audit,
config, indexeddb, integrations, memory-store, rag, search, security,
shared, sqlite, storage, voice-*, ...) all move over.

### 3. Re-namespace packages

Mechanical sed + manual review:

```bash
# In package.json:
"@openloomi/memory-store" → "@opencontext/memory-store"
"@openloomi/cron"        → "@opencontext/cron"
# ... etc

# In source:
from "@openloomi/memory-store" → from "@opencontext/memory-store"
```

Edge cases:

- **`@openloomi/shared`** — stays in the new repo (runtime-only primitives),
  but the **UI-side** (`hooks/`, `i18n/`, `components/`, `ui-runtime/`) re-implements
  the small subset it needs (or publishes a thin `@opencontext/shared` for the
  UI to depend on with a clear deprecation policy).
- **`@openloomi/contracts`** — also runtime. UI depends on it for `UserType`
  and `IntegrationId`, so it stays published from the new repo.
- **`@openloomi/ui-runtime`** — STAYS in the openloomi monorepo (now under
  `ui/packages/ui-runtime/`). It depends on `@tauri-apps/api` and is UI-side.

### 4. Re-namespace internal imports

Within the new repo, internal imports become `@opencontext/<pkg>` (matching
the package field). The `pnpm-workspace.yaml` stays the same shape but only
encompasses runtime packages.

### 5. CI

Two-repo coordinated CI:

- **opencontext** CI builds + tests + publishes `@opencontext/*` to npm on
  tagged releases.
- **openloomi** CI pulls the pinned `@opencontext/*` versions from npm and
  builds the Next.js + Tauri bundle.

A `Renovate` (or `pnpm update --latest --filter ...`) bot keeps the UI's
`@opencontext/*` versions synced.

### 6. Coordinate the cut

Both repos must land on the same commit hash for the moved files in the
openloomi repo (drop a `git mv` PR), then opencontext gets its first commit
importing those files. A `git filter-branch` or `git subtree split` is the
cleanest way to preserve history.

## Out of scope for this doc

- CI rollout sequencing.
- npm publish credentials / token scope.
- Migrating tests that live in `apps/web/tests/` and exercise runtime
  packages side-by-side with UI code.
- Versioning policy (semver? lockstep?).

These are tracked in the `Planned: standalone repos` section of the
master runtime/UI split plan.