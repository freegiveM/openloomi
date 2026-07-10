import type { AgentMessage } from "@openloomi/ai/agent/types";

/**
 * Parse a single NDJSON line from `codex exec --json` into one or more
 * OpenLoomi AgentMessage values.
 *
 * Reference event shape (OpenAI Codex CLI, exec --json):
 *   { "type": "thread.started", "thread_id": "…" }
 *   { "type": "turn.started" }
 *   { "type": "item.started",    "item": { "type": "reasoning",          "id": "…", "text": "…" } }
 *   { "type": "item.started",    "item": { "type": "command_execution", "id": "…", "command": "…", "aggregated_output": "…" } }
 *   { "type": "item.started",    "item": { "type": "agent_message",     "id": "…", "text": "…" } }
 *   { "type": "item.started",    "item": { "type": "file_change",       "id": "…", "changes": [ { "path": "…", "kind": "…" } ] } }
 *   { "type": "item.completed",  "item": { …same payload, plus status… } }
 *   { "type": "turn.completed",  "usage": { "input_tokens": N, "cached_input_tokens": N, "output_tokens": N } }
 *   { "type": "error",           "message": "…" }
 */
export function parseCodexJsonLine(line: string): AgentMessage[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return [];
  }

  return convertCodexEvent(event);
}

export function convertCodexEvent(event: unknown): AgentMessage[] {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return [];
  }

  const record = event as Record<string, unknown>;
  const type = readString(record.type);

  if (type === "thread.started") {
    const threadId = readString(record.thread_id);
    return threadId ? [{ type: "session", sessionId: threadId }] : [];
  }

  if (type === "turn.started") {
    return [];
  }

  // Permissive fallbacks: some CLI builds (and our own fake scripts) emit
  // bare { type: "text", text } / { type: "reasoning", text } lines without
  // an item wrapper. Treat them as already-completed text/reasoning items so
  // downstream planning code does not lose them.
  if (type === "text") {
    const text = extractText(record);
    return text ? [{ type: "text", content: text }] : [];
  }
  if (type === "reasoning") {
    const text = extractText(record);
    return text ? [{ type: "reasoning", content: text }] : [];
  }

  if (type === "item.started" || type === "item.updated") {
    const item = asRecord(record.item);
    if (!item) return [];
    return convertCodexItem(item, "running");
  }

  if (type === "item.completed") {
    const item = asRecord(record.item);
    if (!item) return [];
    return convertCodexItem(item, "completed");
  }

  if (type === "turn.completed") {
    return convertCodexTurnCompleted(record);
  }

  if (type === "error") {
    const message =
      readString(record.message) ||
      readString(record.error) ||
      "Codex CLI reported an error";
    return [{ type: "error", message }];
  }

  return [];
}

function convertCodexItem(
  item: Record<string, unknown>,
  status: "running" | "completed",
): AgentMessage[] {
  const itemType = readString(item.type);
  const itemId = readString(item.id);

  switch (itemType) {
    case "reasoning": {
      const text = extractText(item);
      return text ? [{ type: "reasoning", content: text }] : [];
    }

    case "agent_message": {
      const text = extractText(item);
      return text ? [{ type: "text", content: text }] : [];
    }

    case "command_execution": {
      const toolUseId = itemId ?? `cmd_${randomSuffix()}`;
      const command = readString(item.command) ?? "";
      const aggregatedOutput = readString(item.aggregated_output);
      const exitCode = readNumber(item.exit_code);
      const statusStr = readString(item.status);
      const isError =
        status === "completed" &&
        (statusStr === "failed" ||
          (typeof exitCode === "number" && exitCode !== 0));

      if (status === "running") {
        return [
          {
            type: "tool_use",
            id: toolUseId,
            name: "shell",
            input: { command },
          },
        ];
      }

      return [
        {
          type: "tool_result",
          toolUseId,
          output:
            aggregatedOutput ??
            (typeof exitCode === "number"
              ? `Command exited with code ${exitCode}`
              : ""),
          isError,
        },
      ];
    }

    case "file_change": {
      const toolUseId = itemId ?? `file_${randomSuffix()}`;
      const changes = Array.isArray(item.changes)
        ? item.changes
            .map(asRecord)
            .filter((change): change is Record<string, unknown> =>
              Boolean(change),
            )
            .map((change) => ({
              path: readString(change.path) ?? "",
              kind: readString(change.kind) ?? "update",
            }))
            .filter((change) => change.path.length > 0)
        : [];
      const summary =
        changes.length === 0
          ? "file change"
          : changes.map((change) => `${change.kind} ${change.path}`).join("\n");
      if (status === "running") {
        return [
          {
            type: "tool_use",
            id: toolUseId,
            name: "file_change",
            input: { changes },
          },
        ];
      }
      return [
        {
          type: "tool_result",
          toolUseId,
          output: summary,
          isError: false,
        },
      ];
    }

    case "todo_list": {
      const items = Array.isArray(item.items)
        ? item.items
            .map(asRecord)
            .filter((entry): entry is Record<string, unknown> => Boolean(entry))
            .map((entry) => ({
              content: readString(entry.content) ?? "",
              status: readString(entry.status) ?? "pending",
              activeForm: readString(entry.active_form) ?? undefined,
            }))
        : [];
      const toolUseId = itemId ?? `todo_${randomSuffix()}`;
      return [
        {
          type: "tool_use",
          id: toolUseId,
          name: "todo_list",
          input: { items },
        },
        {
          type: "tool_result",
          toolUseId,
          output: JSON.stringify({ items }),
          isError: false,
        },
      ];
    }

    case "error": {
      const message =
        readString(item.message) ||
        readString(item.error) ||
        "Codex tool error";
      const toolUseId = itemId ?? `err_${randomSuffix()}`;
      return [
        { type: "error", message },
        {
          type: "tool_result",
          toolUseId,
          output: message,
          isError: true,
        },
      ];
    }

    default:
      return [];
  }
}

function convertCodexTurnCompleted(
  record: Record<string, unknown>,
): AgentMessage[] {
  const usage = asRecord(record.usage);
  const inputTokens = readNumber(usage?.input_tokens);
  const outputTokens = readNumber(usage?.output_tokens);

  const result: AgentMessage = {
    type: "result",
    content: "turn.completed",
  };

  if (typeof inputTokens === "number" && typeof outputTokens === "number") {
    result.usage = { inputTokens, outputTokens };
  }

  return [result];
}

function extractText(record: Record<string, unknown>): string | undefined {
  for (const key of ["text", "content", "message", "delta"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
