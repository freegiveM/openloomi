// Phase 5 — re-export shim over `@openloomi/loop/cli-path`. The leaf
// module owns the `loop-cli.mjs` path resolver used by the tick prompt
// and the `loop doctor` CLI. Pure `node:fs` / `node:path` / `node:url`
// only — no DB / agent / integrations.

export {
  LOOP_CLI_FILENAME,
  resolveLoopCli,
  listLoopCliCandidates,
} from "@openloomi/loop/cli-path";
