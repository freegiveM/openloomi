// Phase 5 — re-export shim over `@melandlabs/cron/stream-response`. The
// leaf module owns the SSE response creator used by manual job
// executions. Pure dep-free helper (no DB / agent / integrations), so
// the runtime package and the UI can both import it without depending
// on the rest of `apps/web/lib/cron/*`.

export { createJobExecutionStreamResponse } from "@melandlabs/cron/stream-response";
// `JobAgentStreamEvent` lives in `@melandlabs/cron/types` (it represents
// the event protocol the stream emits, not anything specific to the
// stream-response constructor).
export type { JobAgentStreamEvent } from "@melandlabs/cron/types";
