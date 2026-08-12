// Phase 6 — re-export shim over `@melandlabs/insights/grouping`. The leaf
// module owns `normalizeMessagesInput`, `groupMessagesByChannel`,
// `filterInsightsByGroup`, `mergeIMessageMessagesBySender`, and
// `estimateTokensForMessages`. Type-only deps on
// `@melandlabs/integrations-channels/sources/types` and
// `@/lib/ai/subagents/insights` — no runtime imports.

export {
  normalizeMessagesInput,
  groupMessagesByChannel,
  filterInsightsByGroup,
  mergeIMessageMessagesBySender,
  estimateTokensForMessages,
} from "@melandlabs/insights";
