// Phase 5 — re-export shim over `@melandlabs/loop/paths`. The leaf module
// owns the on-disk Loop filesystem layout (`LOOP_HOME`, `LOOP_PATHS`,
// `ensureDirs`, `migrate`, `ensureParent`). Pure `node:fs` / `node:path`
// only — no DB / agent / integrations — so the runtime package and the
// UI can both import the same constants without dragging the rest of
// `apps/web/lib/loop/*` along.

export {
  LOOP_HOME,
  LOOP_PATHS,
  ensureDirs,
  ensureParent,
  migrate,
} from "@melandlabs/loop/paths";
