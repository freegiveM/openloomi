/**
 * Provider-neutral subset of Codex app-server events consumed by the Goal
 * Runtime. The app-server client owns wire-format validation and converts its
 * JSON-RPC notifications into these deliberately small, stable shapes.
 */

export type CodexCompletedItemStatus = "completed" | "failed" | "declined";

export interface CodexAgentMessageItem {
  id: string;
  type: "agent_message";
  text: string;
  phase?: "commentary" | "final_answer";
}

export interface CodexCommandExecutionItem {
  id: string;
  type: "command_execution";
  command: string;
  cwd?: string;
  status: CodexCompletedItemStatus;
  aggregatedOutput?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface CodexFileChange {
  path: string;
  kind?: string;
}

export interface CodexFileChangeItem {
  id: string;
  type: "file_change";
  changes: readonly CodexFileChange[];
  status: CodexCompletedItemStatus;
}

export type CodexCompletedItem =
  | CodexAgentMessageItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem;

export interface CodexTurnUsage {
  /** Turn-local count. Cached input is already included by Codex. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface CodexItemCompletedEvent {
  kind: "item.completed";
  threadId: string;
  turnId: string;
  item: CodexCompletedItem;
  observedAt?: string;
}

export interface CodexTurnCompletedEvent {
  kind: "turn.completed";
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  /**
   * Final turn-local usage. A wire adapter receiving cumulative thread usage
   * must calculate the turn delta before constructing this event.
   */
  usage?: CodexTurnUsage;
  observedAt?: string;
}

export type CodexNormalizedRuntimeEvent =
  | CodexItemCompletedEvent
  | CodexTurnCompletedEvent;
