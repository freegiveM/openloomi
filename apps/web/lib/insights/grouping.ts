// Phase 6 — re-export shim over `@openloomi/insights/grouping`. The leaf
// module owns `normalizeMessagesInput`, `groupMessagesByChannel`,
// `filterInsightsByGroup`, `mergeIMessageMessagesBySender`, and
// `estimateTokensForMessages`. Type-only deps on
// `@openloomi/integrations/channels/sources/types` and
// `@/lib/ai/subagents/insights` — no runtime imports.

export {
  normalizeMessagesInput,
  groupMessagesByChannel,
  filterInsightsByGroup,
  mergeIMessageMessagesBySender,
  estimateTokensForMessages,
} from "@openloomi/insights/grouping";
