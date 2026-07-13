/**
 * Daily Focus Executor
 * Hybrid approach: DB query + single LLM call to generate structured focus reports.
 */

import type {
  DailyFocusSnapshot,
  DailyFocusEvent,
  FocusSource,
} from "../types/daily-focus";
import {
  buildDailyFocusHistorySummary,
  type FocusPriority,
} from "../types/daily-focus";
import { normalizeReasoningSourceType } from "../types/execution-result";
import {
  ACTIONABLE_SIGNAL_PATTERN,
  WAITING_EXTERNAL_SIGNAL_PATTERN,
  INFO_VALUE_SIGNAL_PATTERN,
  NOISE_SIGNAL_PATTERN,
  URGENT_WORDS,
  IMPORTANT_WORDS,
  DAILY_FOCUS_TITLE_MAX_LENGTH,
} from "./constants";

/**
 * System prompt for Daily Focus LLM analysis.
 * Instructs the model to produce a structured JSON snapshot.
 */
export const DAILY_FOCUS_SYSTEM_PROMPT = `You are an information analysis assistant responsible for generating a "Daily Focus" report.

## Task
Based on the provided atomic candidate events, analyze and generate a structured focus report.

## Event Granularity Rules
- Each output event should represent one independent user matter, not one aggregated Insight.
- If one Insight contains multiple tasks or deadlines, output separate events by candidateId.
- Do not merge unrelated matters such as credit card repayment, replying to an email, preparing a report, checking social security, and calling family.
- Each event.id should be the primary candidate id whenever possible; the system will normalize event identity after generation.
- Each event.candidateIds should include the exact candidate id(s) used; use multiple ids only when the candidates share the same goal, context, and recommended action.
- Do not invent candidate ids, event ids, or matter keys. Only use candidate ids from the provided input.
- Preserve event.insightId from the candidate so the UI can open the source Insight.

## Output Format Rules
- Return raw JSON only.
- Do not wrap the response in markdown fences such as \`\`\`json.
- Each event must use the field name "priority", never "classification".
- priority must be one of: "urgent", "high_priority", "potential".
- priority is only an initial hint for this analysis step. The system will make the final grouping after structured urgency and importance reasoning.

## Initial Priority Hint Rules
- **urgent**: Likely needs immediate attention — pending user action, very near deadline, or explicitly urgent
- **high_priority**: Likely important or actionable — needs follow-up, involves key decisions, or has meaningful impact
- **potential**: Worth noting — general information, reference material, long-term trends
- These are only hints. Final grouping is derived later from structured urgency and importance assessments.

## Reasoning Chain Rules
- Each event's reasoningChain shows how you derived the event from the raw data
- Ordered by time in descending order (most recent first)
- Each step must have time, summary, content, source, and confidence
- Confidence range 0-100, higher means the step conclusion is more reliable

## Source Object Format
- source must be an object with { type, label, id? }
- type must be one of: telegram, email, system, manual, insight, task, web, calendar, etc.
- label should be a human-readable description like "Telegram", "Email from John"
- Example: { "type": "telegram", "label": "Telegram" }
- Do NOT use a plain string like "telegram" — it must be an object

## Summary Rules
- Each event.summary is the event title shown in the UI; it must help the user decide what to do at a glance
- For task/reply/deadline/next_action events, write the title as an action-oriented next step, not a factual statement
- Prefer starting actionable titles with verbs such as "confirm", "review", "reply", "follow up", "complete", "submit", "prepare", "view", "handle", "decide"
- Include the action target and concrete object, e.g. "review Zhang San's project weekly report and provide feedback", "confirm customer A's delivery time change"
- Keep titles concise: Chinese 12-30 characters when possible; English 4-10 words
- Do not use a raw count as the summary, and do not simply copy or truncate the original insight title
- If an event is only general information, an already-read notice, or reference material with no useful next action, keep a neutral informational title instead of forcing an action

## Action Rules
- Analyze each event and suggest 1-3 meaningful actions the user can take based on the event content
- For urgent/high_priority events with pending tasks, deadlines, nextActions, waitingForMe, or actionRequired, you must include at least one suggested action
- Maximum 3 recommended actions per event
- Only suggest actions that are genuinely useful for that specific event
- Actions that need AI judgment should use execute_task with params.message containing the full instruction and necessary context
- Only use reply_email or send_message when recipients/contact/channel and platform can be inferred with confidence; otherwise use execute_task to let AI prepare the response
- If the event cannot continue because a supported platform/account is not connected, authorized, integrated, or bound, include add_integration with params.platform when the platform can be inferred
- Do not suggest add_integration for coming-soon / unsupported platforms such as GitHub, Jira, Linear, Asana, Google Drive, Google Calendar, LinkedIn, Instagram, Facebook Messenger, or Microsoft Teams.
- For reply_email, include recipients and subject when available, plus a concise message/draft in params.message
- For send_message, include platform, recipients/channel, and a concise message/draft in params.message
- If a direct action cannot be inferred safely, include view_insight as the fallback action
- type and usage:
  - send_message: Send a reply/message related to this event. params: { "recipients": ["name"], "platform": "slack", "message": "what to say" }. Use when the event involves a conversation or request that needs a response.
  - reply_email: Reply to an email related to this event. params: { "recipients": ["email"], "subject": "...", "message": "reply content" }. Use when the event involves an email that needs a reply.
  - open_link: Open a URL found in the event. params: { "url": "https://..." }
  - open_file: Open a file attachment from the event. params: { "path": "...", "name": "...", "type": "..." }
  - download_file: Download a file from the event. params: { "path": "..." }
  - add_integration: Connect/authorize a missing supported platform. params: { "platform": "slack" }. Do not use this for coming-soon / unsupported platforms.
  - view_insight: View the full detail of this insight. params: { "insightId": "..." }
  - execute_task: Send a task to AI for execution. params: { "message": "task description" }
  - custom: Fallback for actions not matching any specific type
- label should be concise, actionable, and in the user's language (e.g. "reply to Zhang San", "view details")`;

/**
 * Interface for insight input data
 */
export interface DailyFocusInsightInput {
  id: string;
  title?: string | null;
  description?: string | null;
  importance?: string | null;
  urgency?: string | null;
  platform?: string | null;
  groups?: string[] | null;
  people?: string[] | null;
  sources?: string[] | null;
  details?: string | null;
  timeline?: string | null;
  dueDate?: string | null;
  waitingForMe?: boolean | null;
  waitingForOthers?: boolean | null;
  nextActions?: string[] | null;
  actionRequired?: boolean | null;
  categories?: string[] | null;
  time?: string | null;
  isArchived?: boolean | null;
}

/**
 * Interface for building candidates from insights
 */
export interface DailyFocusCandidate {
  id: string;
  insightId: string;
  title: string;
  context: string;
  priorityHint: FocusPriority;
  deadlineAt?: string;
  sources: FocusSource[];
  sourceSnippets: string[];
  isActionable: boolean;
  isWaitingExternal: boolean;
  isInfo: boolean;
  isNoise: boolean;
  row: DailyFocusInsightInput;
}

/**
 * Analyze an insight and determine if it's actionable
 */
function analyzeInsightActionable(insight: DailyFocusInsightInput): {
  isActionable: boolean;
  isWaitingExternal: boolean;
  isInfo: boolean;
  isNoise: boolean;
  priorityHint: FocusPriority;
  deadlineAt?: string;
} {
  const combined = [
    insight.title,
    insight.description,
    insight.details,
    ...(insight.nextActions || []),
    ...(insight.categories || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  // Check for noise
  if (NOISE_SIGNAL_PATTERN.test(combined)) {
    return {
      isActionable: false,
      isWaitingExternal: false,
      isInfo: false,
      isNoise: true,
      priorityHint: "potential",
    };
  }

  // Check for actionable signals
  const hasActionable = ACTIONABLE_SIGNAL_PATTERN.test(combined);
  const hasWaitingExternal = WAITING_EXTERNAL_SIGNAL_PATTERN.test(combined);
  const hasInfoValue = INFO_VALUE_SIGNAL_PATTERN.test(combined);

  // Determine priority hint
  // Info-only content (newsletters, digests, FYI) should be deprioritized
  let priorityHint: FocusPriority = "potential";
  if (!hasInfoValue) {
    // Only elevate priority if it's NOT just informational content
    if (
      URGENT_WORDS.has(combined) ||
      insight.urgency === "high" ||
      insight.importance === "high"
    ) {
      priorityHint = "urgent";
    } else if (IMPORTANT_WORDS.has(combined) || hasActionable) {
      priorityHint = "high_priority";
    }
  }

  return {
    isActionable: hasActionable,
    isWaitingExternal: hasWaitingExternal,
    isInfo: hasInfoValue,
    isNoise: false,
    priorityHint,
    deadlineAt: insight.dueDate || undefined,
  };
}

/**
 * Build candidates from insights
 */
export function buildDailyFocusCandidates(
  insights: DailyFocusInsightInput[],
  options?: { maxPerInsight?: number },
): DailyFocusCandidate[] {
  const maxPerInsight = options?.maxPerInsight || 3;
  const candidates: DailyFocusCandidate[] = [];

  for (const insight of insights) {
    if (insight.isArchived) continue;

    const analysis = analyzeInsightActionable(insight);

    // Skip noise
    if (analysis.isNoise) continue;

    const title =
      insight.title || insight.description?.slice(0, 50) || "Untitled";
    const context = [
      insight.description,
      insight.details,
      ...(insight.nextActions || []).map((a) => `Action: ${a}`),
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 500);

    candidates.push({
      id: `candidate-${insight.id}`,
      insightId: insight.id,
      title: title.slice(0, DAILY_FOCUS_TITLE_MAX_LENGTH),
      context,
      priorityHint: analysis.priorityHint,
      deadlineAt: analysis.deadlineAt,
      sources: [
        {
          type: normalizeReasoningSourceType(insight.platform, "unknown"),
          label: insight.platform
            ? capitalizeFirst(insight.platform)
            : "Unknown",
        },
      ],
      sourceSnippets: [
        insight.title,
        insight.description?.slice(0, 200),
      ].filter(Boolean) as string[],
      isActionable: analysis.isActionable,
      isWaitingExternal: analysis.isWaitingExternal,
      isInfo: analysis.isInfo,
      isNoise: false,
      row: insight,
    });

    // Limit per insight
    if (candidates.length >= maxPerInsight * insights.length) break;
  }

  return candidates;
}

function capitalizeFirst(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Filter and rank candidates by priority
 */
export function rankCandidatesByPriority(
  candidates: DailyFocusCandidate[],
): DailyFocusCandidate[] {
  const priorityOrder: Record<FocusPriority, number> = {
    urgent: 0,
    high_priority: 1,
    potential: 2,
  };

  return [...candidates].sort((a, b) => {
    return priorityOrder[a.priorityHint] - priorityOrder[b.priorityHint];
  });
}

/**
 * Convert candidates to events for the snapshot
 */
export function candidatesToEvents(
  candidates: DailyFocusCandidate[],
): DailyFocusEvent[] {
  return candidates.map((candidate, index) => ({
    id: candidate.id,
    insightId: candidate.insightId,
    candidateIds: [candidate.id],
    priority: candidate.priorityHint,
    summary: candidate.title,
    overview: candidate.context.slice(0, 220),
    sources: candidate.sources,
    isDeadlineToday: false,
    suggestedActions:
      candidate.isActionable && candidate.priorityHint !== "potential"
        ? [
            {
              id: `action-${index}-view`,
              type: "view_insight" as const,
              label: "View details",
            },
          ]
        : [],
    reasoningChain: [
      {
        time: new Date().toISOString(),
        summary: `Analyzed from ${candidate.sources[0]?.label || "unknown source"}`,
        content: candidate.context,
        source: candidate.sources[0] || { type: "unknown", label: "Unknown" },
        confidence: 75,
      },
    ],
  }));
}

/**
 * Execute Daily Focus analysis on insights
 */
export function executeDailyFocusAnalysis(insights: DailyFocusInsightInput[]): {
  snapshot: DailyFocusSnapshot;
  candidates: DailyFocusCandidate[];
} {
  // Build candidates from insights
  const candidates = buildDailyFocusCandidates(insights);
  const rankedCandidates = rankCandidatesByPriority(candidates);
  const events = candidatesToEvents(rankedCandidates);

  // Build summary
  const summary = buildDailyFocusHistorySummary(events);

  const snapshot: DailyFocusSnapshot = {
    type: "daily-focus-snapshot",
    version: 2,
    generatedAt: new Date().toISOString(),
    summary,
    events,
    totalCount: events.length,
  };

  return { snapshot, candidates };
}
