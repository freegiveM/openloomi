/**
 * Narrow Codex app-server protocol surface used by OpenLoomi's live runtime.
 *
 * The app-server protocol is experimental and much larger than this module.
 * Keep these types limited to the methods required for a live Goal session so
 * an OpenLoomi release does not vendor a generated snapshot of the full API.
 */

export type CodexAppServerRequestId = string | number;

export type CodexAppServerSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export interface CodexAppServerUserInput {
  type: "text";
  text: string;
  text_elements: [];
}

export function createCodexAppServerTextInput(
  text: string,
): CodexAppServerUserInput {
  return { type: "text", text, text_elements: [] };
}

export interface CodexAppServerThread {
  id: string;
}

export type CodexAppServerTurnStatus =
  | "completed"
  | "interrupted"
  | "failed"
  | "inProgress";

export interface CodexAppServerTurn {
  id: string;
  status: CodexAppServerTurnStatus;
}

/** Persisted item fields required to rebuild Goal causal observation context. */
export interface CodexAppServerPersistedItem {
  type: string;
  id: string;
  clientId?: string | null;
  [key: string]: unknown;
}

export interface CodexAppServerPersistedTurn extends CodexAppServerTurn {
  items: CodexAppServerPersistedItem[];
  startedAt: number | null;
  completedAt: number | null;
}

export interface CodexAppServerRecoveredThread extends CodexAppServerThread {
  turns: CodexAppServerPersistedTurn[];
}

export interface CodexAppServerThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  sandbox?: CodexAppServerSandboxMode | null;
}

export interface CodexAppServerThreadStartResult {
  thread: CodexAppServerThread;
}

export interface CodexAppServerThreadResumeParams {
  threadId: string;
}

export interface CodexAppServerThreadResumeResult {
  thread: CodexAppServerRecoveredThread;
}

export interface CodexAppServerTurnStartParams {
  threadId: string;
  input: CodexAppServerUserInput[];
  clientUserMessageId?: string | null;
}

export interface CodexAppServerTurnStartResult {
  turn: CodexAppServerTurn;
}

export interface CodexAppServerTurnSteerParams {
  threadId: string;
  expectedTurnId: string;
  input: CodexAppServerUserInput[];
  clientUserMessageId?: string | null;
}

export interface CodexAppServerTurnSteerResult {
  turnId: string;
}

export interface CodexAppServerTurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface CodexAppServerNotification<TParams = unknown> {
  method: string;
  params?: TParams;
}

export interface CodexAppServerExit {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stderr: string;
  expected: boolean;
}

export interface CodexAppServerRequestOptions {
  signal?: AbortSignal;
}
