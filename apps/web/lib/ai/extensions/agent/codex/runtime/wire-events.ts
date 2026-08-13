import type { AgentMessage } from "@openloomi/ai/agent/types";
import { stripGoalStepCompletionMarkers } from "@openloomi/ai/agent/runtime-instructions";

import type { CodexAppServerNotification } from "../app-server";
import type {
  CodexCompletedItem,
  CodexCompletedItemStatus,
  CodexNormalizedRuntimeEvent,
  CodexTurnUsage,
} from "./events";

export interface CodexWireEventProjection {
  events: CodexNormalizedRuntimeEvent[];
  messages: AgentMessage[];
  instructionAcks: CodexInstructionAck[];
}

export interface CodexInstructionAck {
  threadId: string;
  turnId: string;
  instructionId: string;
}

export interface CodexWireEventProjector {
  project(notification: CodexAppServerNotification): CodexWireEventProjection;
}

export interface CodexWireEventProjectorOptions {
  /**
   * A recovered app-server thread reports lifetime cumulative usage. Treat its
   * first snapshot as the process-local baseline so historical tokens are not
   * charged to the resumed turn again.
   */
  usageBaseline?: "zero" | "first_snapshot";
}

interface UsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Projects the deliberately small app-server surface used by a live Codex
 * runtime. Unknown or malformed notifications are ignored so protocol growth
 * does not make an otherwise healthy turn fail.
 */
export function createCodexWireEventProjector(
  options: CodexWireEventProjectorOptions = {},
): CodexWireEventProjector {
  const usage = new CodexThreadUsageTracker(options.usageBaseline);

  return {
    project(notification) {
      switch (notification.method) {
        case "thread/tokenUsage/updated":
          usage.observe(notification.params);
          return emptyProjection();
        case "item/completed":
          return projectCompletedItem(notification.params);
        case "item/started":
          return projectStartedItem(notification.params);
        case "turn/completed":
          return projectCompletedTurn(notification.params, usage);
        default:
          return emptyProjection();
      }
    },
  };
}

/** Converts cumulative per-thread usage snapshots into turn-local usage. */
export class CodexThreadUsageTracker {
  private readonly threadTotals = new Map<string, UsageBreakdown>();
  private readonly turnDeltas = new Map<string, UsageBreakdown>();

  constructor(private readonly baseline: "zero" | "first_snapshot" = "zero") {}

  observe(value: unknown): void {
    const params = asRecord(value);
    const tokenUsage = asRecord(params?.tokenUsage);
    const total = parseUsageBreakdown(asRecord(tokenUsage?.total));
    const threadId = readIdentifier(params?.threadId);
    const turnId = readIdentifier(params?.turnId);
    if (!threadId || !turnId || !total) return;

    const previous = this.threadTotals.get(threadId);
    if (previous === undefined && this.baseline === "first_snapshot") {
      this.threadTotals.set(threadId, total);
      return;
    }
    const delta = subtractMonotonic(total, previous ?? zeroUsage());
    if (!delta) return;

    this.threadTotals.set(threadId, total);
    const key = turnKey(threadId, turnId);
    this.turnDeltas.set(
      key,
      addUsage(this.turnDeltas.get(key) ?? zeroUsage(), delta),
    );
  }

  take(threadId: string, turnId: string): CodexTurnUsage | undefined {
    const key = turnKey(threadId, turnId);
    const value = this.turnDeltas.get(key);
    this.turnDeltas.delete(key);
    if (!value) return undefined;
    return {
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      cachedInputTokens: value.cachedInputTokens,
    };
  }
}

function projectCompletedItem(value: unknown): CodexWireEventProjection {
  const params = asRecord(value);
  const threadId = readIdentifier(params?.threadId);
  const turnId = readIdentifier(params?.turnId);
  const rawItem = asRecord(params?.item);
  const instructionId = readIdentifier(rawItem?.clientId);
  if (threadId && turnId && rawItem?.type === "userMessage" && instructionId) {
    return {
      events: [],
      messages: [],
      instructionAcks: [{ threadId, turnId, instructionId }],
    };
  }
  const item = parseCompletedItem(rawItem);
  if (!threadId || !turnId || !item) return emptyProjection();

  const event: CodexNormalizedRuntimeEvent = {
    kind: "item.completed",
    threadId,
    turnId,
    item,
    ...observedAtFromMilliseconds(params?.completedAtMs),
  };
  return {
    events: [event],
    messages: itemToMessages(threadId, turnId, item),
    instructionAcks: [],
  };
}

function projectStartedItem(value: unknown): CodexWireEventProjection {
  const params = asRecord(value);
  const threadId = readIdentifier(params?.threadId);
  const turnId = readIdentifier(params?.turnId);
  const item = asRecord(params?.item);
  if (!threadId || !turnId || !item) return emptyProjection();
  const instructionId = readIdentifier(item.clientId);
  if (item.type === "userMessage" && instructionId) {
    return {
      events: [],
      messages: [],
      instructionAcks: [{ threadId, turnId, instructionId }],
    };
  }
  const id = readIdentifier(item.id);
  if (!id) return emptyProjection();
  const messageId = stableMessageId(threadId, turnId, id);
  if (item.type === "commandExecution") {
    const command = readString(item.command);
    if (command === undefined) return emptyProjection();
    return {
      events: [],
      messages: [
        {
          type: "tool_use",
          id,
          name: "shell",
          input: {
            command,
            ...(readString(item.cwd) ? { cwd: readString(item.cwd) } : {}),
          },
          messageId: `${messageId}:use`,
        },
      ],
      instructionAcks: [],
    };
  }
  if (item.type === "fileChange") {
    return {
      events: [],
      messages: [
        {
          type: "tool_use",
          id,
          name: "file_change",
          input: {},
          messageId: `${messageId}:use`,
        },
      ],
      instructionAcks: [],
    };
  }
  return emptyProjection();
}

function projectCompletedTurn(
  value: unknown,
  usage: CodexThreadUsageTracker,
): CodexWireEventProjection {
  const params = asRecord(value);
  const threadId = readIdentifier(params?.threadId);
  const turn = asRecord(params?.turn);
  const turnId = readIdentifier(turn?.id);
  const status = parseTurnStatus(turn?.status);
  if (!threadId || !turnId || !status) return emptyProjection();

  const turnUsage = usage.take(threadId, turnId);
  const event: CodexNormalizedRuntimeEvent = {
    kind: "turn.completed",
    threadId,
    turnId,
    status,
    ...(turnUsage ? { usage: turnUsage } : {}),
    ...observedAtFromSeconds(turn?.completedAt),
  };
  // A Codex turn is not necessarily the end of the OpenLoomi run: the Goal
  // controller may enqueue another turn. The session emits the single final
  // `result` only after that decision has been made.
  return { events: [event], messages: [], instructionAcks: [] };
}

function parseCompletedItem(
  item: Record<string, unknown> | undefined,
): CodexCompletedItem | undefined {
  const id = readIdentifier(item?.id);
  if (!id) return undefined;

  switch (item?.type) {
    case "agentMessage": {
      const text = readString(item.text);
      if (text === undefined) return undefined;
      const phase =
        item.phase === "commentary" || item.phase === "final_answer"
          ? item.phase
          : undefined;
      return {
        id,
        type: "agent_message",
        text,
        ...(phase ? { phase } : {}),
      };
    }
    case "commandExecution": {
      const command = readString(item.command);
      const status = parseCompletedItemStatus(item.status);
      if (command === undefined || !status) return undefined;
      const cwd = readString(item.cwd);
      const aggregatedOutput = readString(item.aggregatedOutput);
      const exitCode = readSafeInteger(item.exitCode);
      const durationMs = readNonNegativeNumber(item.durationMs);
      return {
        id,
        type: "command_execution",
        command,
        status,
        ...(cwd === undefined ? {} : { cwd }),
        ...(aggregatedOutput === undefined ? {} : { aggregatedOutput }),
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(durationMs === undefined ? {} : { durationMs }),
      };
    }
    case "fileChange": {
      const status = parseCompletedItemStatus(item.status);
      if (!status || !Array.isArray(item.changes)) return undefined;
      const changes = item.changes.flatMap((value) => {
        const change = asRecord(value);
        const path = readString(change?.path);
        if (path === undefined) return [];
        const kind =
          readString(asRecord(change?.kind)?.type) ?? readString(change?.kind);
        return [
          {
            path,
            ...(kind === undefined ? {} : { kind }),
          },
        ];
      });
      return { id, type: "file_change", changes, status };
    }
    default:
      return undefined;
  }
}

function itemToMessages(
  threadId: string,
  turnId: string,
  item: CodexCompletedItem,
): AgentMessage[] {
  const messageId = stableMessageId(threadId, turnId, item.id);
  switch (item.type) {
    case "agent_message": {
      const content = stripGoalStepCompletionMarkers(item.text);
      return content
        ? [
            {
              type: "text",
              content,
              messageId,
            },
          ]
        : [];
    }
    case "command_execution":
      return [
        {
          type: "tool_result",
          toolUseId: item.id,
          output:
            item.aggregatedOutput ??
            (item.exitCode === undefined
              ? ""
              : `Command exited with code ${item.exitCode}`),
          isError:
            item.status !== "completed" ||
            (item.exitCode !== undefined && item.exitCode !== 0),
          messageId,
        },
      ];
    case "file_change":
      return [
        {
          type: "tool_result",
          toolUseId: item.id,
          output:
            item.changes.length === 0
              ? "file change"
              : item.changes
                  .map(({ kind, path }) => `${kind ?? "update"} ${path}`)
                  .join("\n"),
          isError: item.status !== "completed",
          messageId,
        },
      ];
  }
}

function parseCompletedItemStatus(
  value: unknown,
): CodexCompletedItemStatus | undefined {
  return value === "completed" || value === "failed" || value === "declined"
    ? value
    : undefined;
}

function parseTurnStatus(
  value: unknown,
): "completed" | "failed" | "interrupted" | undefined {
  return value === "completed" || value === "failed" || value === "interrupted"
    ? value
    : undefined;
}

function parseUsageBreakdown(
  value: Record<string, unknown> | undefined,
): UsageBreakdown | undefined {
  const inputTokens = readNonNegativeSafeInteger(value?.inputTokens);
  const cachedInputTokens = readNonNegativeSafeInteger(
    value?.cachedInputTokens,
  );
  const outputTokens = readNonNegativeSafeInteger(value?.outputTokens);
  return inputTokens === undefined ||
    cachedInputTokens === undefined ||
    outputTokens === undefined
    ? undefined
    : { inputTokens, cachedInputTokens, outputTokens };
}

function subtractMonotonic(
  current: UsageBreakdown,
  previous: UsageBreakdown,
): UsageBreakdown | undefined {
  if (
    current.inputTokens < previous.inputTokens ||
    current.cachedInputTokens < previous.cachedInputTokens ||
    current.outputTokens < previous.outputTokens
  ) {
    return undefined;
  }
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
  };
}

function addUsage(a: UsageBreakdown, b: UsageBreakdown): UsageBreakdown {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

function zeroUsage(): UsageBreakdown {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
}

function stableMessageId(
  threadId: string,
  turnId: string,
  itemId: string,
): string {
  return `codex:${threadId}:${turnId}:${itemId}`;
}

function emptyProjection(): CodexWireEventProjection {
  return { events: [], messages: [], instructionAcks: [] };
}

function turnKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

function observedAtFromMilliseconds(value: unknown): { observedAt?: string } {
  const milliseconds = readNonNegativeNumber(value);
  return optionalObservedAt(milliseconds);
}

function observedAtFromSeconds(value: unknown): { observedAt?: string } {
  const seconds = readNonNegativeNumber(value);
  return optionalObservedAt(
    seconds === undefined ? undefined : seconds * 1_000,
  );
}

function optionalObservedAt(value: number | undefined): {
  observedAt?: string;
} {
  if (value === undefined || !Number.isFinite(value)) return {};
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? {} : { observedAt: date.toISOString() };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function readNonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
