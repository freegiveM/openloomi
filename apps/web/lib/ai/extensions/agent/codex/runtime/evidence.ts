import type { GoalEvidenceType } from "@openloomi/ai/agent/runtime-instructions";

import type { RuntimeEvidenceDraft } from "@/lib/ai/runtime-instructions/runtime-observation";
import type {
  CodexCommandExecutionItem,
  CodexCompletedItem,
  CodexFileChangeItem,
} from "./events";

const MAX_SUMMARY_CHARACTERS = 1_000;
const MAX_DETAIL_CHARACTERS = 8_000;
const MAX_COMMAND_CHARACTERS = 4_000;
const MAX_OUTPUT_CHARACTERS = 3_000;
const MAX_PATH_CHARACTERS = 512;
const MAX_PATHS = 16;

const TEST_COMMAND_PATTERNS = [
  /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?=$|\s|:)/i,
  /(?:^|\s)(?:(?:npx|bunx|pnpm\s+exec|yarn\s+exec)\s+)?(?:ava|cypress|jest|mocha|playwright|pytest|vitest)(?=$|\s)/i,
  /(?:^|\s)python(?:3)?\s+-m\s+pytest(?=$|\s)/i,
  /(?:^|\s)(?:cargo|dotnet|go|mix|swift)\s+test(?=$|\s)/i,
  /(?:^|\s)(?:bundle\s+exec\s+)?rspec(?=$|\s)/i,
];

export function collectCodexItemEvidence(input: {
  providerEventId: string;
  item: CodexCompletedItem;
  observedAt: string;
}): RuntimeEvidenceDraft | undefined {
  switch (input.item.type) {
    case "agent_message":
      return collectAgentReport({ ...input, item: input.item });
    case "command_execution":
      return collectCommandResult({ ...input, item: input.item });
    case "file_change":
      return collectFileChange({ ...input, item: input.item });
  }
}

function collectAgentReport(input: {
  providerEventId: string;
  item: Extract<CodexCompletedItem, { type: "agent_message" }>;
  observedAt: string;
}): RuntimeEvidenceDraft | undefined {
  const report = truncate(input.item.text.trim(), MAX_DETAIL_CHARACTERS);
  if (!report) return undefined;
  return {
    type: "agent_report",
    sourceEventId: input.providerEventId,
    summary: truncate(
      `Codex assistant report: ${report}`,
      MAX_SUMMARY_CHARACTERS,
    ),
    payload: {
      outputPreview: report,
    },
    observedAt: input.observedAt,
  };
}

function collectCommandResult(input: {
  providerEventId: string;
  item: CodexCommandExecutionItem;
  observedAt: string;
}): RuntimeEvidenceDraft {
  const command = truncate(input.item.command.trim(), MAX_COMMAND_CHARACTERS);
  const type: GoalEvidenceType = TEST_COMMAND_PATTERNS.some((pattern) =>
    pattern.test(command),
  )
    ? "test_result"
    : "command_result";
  const success = commandSuccess(input.item);
  const outputPreview = input.item.aggregatedOutput?.trim()
    ? truncateEdges(input.item.aggregatedOutput.trim(), MAX_OUTPUT_CHARACTERS)
    : undefined;

  return {
    type,
    sourceEventId: input.providerEventId,
    summary: truncate(
      `${type === "test_result" ? "Test command" : "Command"} ${outcomeLabel(success)}${command ? `: ${command}` : ""}`,
      MAX_SUMMARY_CHARACTERS,
    ),
    ...(success === undefined ? {} : { success }),
    payload: {
      ...(command ? { command } : {}),
      ...(input.item.exitCode === undefined
        ? {}
        : { exitCode: input.item.exitCode }),
      ...(outputPreview === undefined ? {} : { outputPreview }),
    },
    observedAt: input.observedAt,
  };
}

function collectFileChange(input: {
  providerEventId: string;
  item: CodexFileChangeItem;
  observedAt: string;
}): RuntimeEvidenceDraft {
  const paths = [
    ...new Set(
      input.item.changes
        .map(({ path }) => path.trim())
        .filter(Boolean)
        .map((path) => truncate(path, MAX_PATH_CHARACTERS)),
    ),
  ].slice(0, MAX_PATHS);
  const success = input.item.status === "completed";
  return {
    type: success === true ? "file_change" : "tool_result",
    sourceEventId: input.providerEventId,
    summary: truncate(
      `File change ${outcomeLabel(success)}${paths.length ? `: ${paths.join(", ")}` : ""}`,
      MAX_SUMMARY_CHARACTERS,
    ),
    success,
    payload: {
      paths,
    },
    observedAt: input.observedAt,
  };
}

function commandSuccess(item: CodexCommandExecutionItem): boolean | undefined {
  if (item.status === "failed" || item.status === "declined") return false;
  const exitCode = item.exitCode;
  if (exitCode === undefined) return undefined;
  return exitCode === 0;
}

function outcomeLabel(success: boolean | undefined): string {
  if (success === true) return "succeeded";
  if (success === false) return "failed";
  return "completed with unknown outcome";
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 16))}\n...[truncated]`;
}

function truncateEdges(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const marker = "\n...[truncated]...\n";
  const retained = Math.max(0, maximum - marker.length);
  const head = Math.ceil(retained / 2);
  return `${value.slice(0, head)}${marker}${value.slice(-(retained - head))}`;
}
