import { createHash } from "node:crypto";

import type { AgentMessage } from "@openloomi/ai/agent/types";

import {
  MESSAGE_ID_SCOPE_CONFLICT,
  getChatById,
  getMessageById,
  saveMessages,
} from "@/lib/db/queries";

const DEFAULT_FLUSH_DELAY_MS = 250;
const MAX_CAS_REBASE_ATTEMPTS = 3;

type RecoveryMessagePart = Record<string, unknown> & { type: string };

type RecoveryMessageMutation =
  | {
      kind: "append-text";
      partType: "text" | "reasoning";
      text: string;
    }
  | {
      kind: "tool-use";
      toolUseId: string;
      toolName: string;
      toolInput: unknown;
    }
  | {
      kind: "tool-result";
      toolUseId: string;
      toolOutput: unknown;
      isError: boolean;
    }
  | { kind: "provider-error" }
  | { kind: "fail-executing-tools" };

interface StoredMessageLike {
  id: string;
  chatId: string;
  role: string;
  parts: unknown;
  attachments?: unknown;
  createdAt: Date | string | number;
  metadata?: unknown;
}

export interface RuntimeRecoveryChatRecorder {
  record(message: AgentMessage): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeRecoveryChatRecorderInput {
  ownerId: string;
  runtimeSessionId: string;
  providerSessionId: string;
  runEpoch: number;
}

interface RuntimeRecoveryChatRecorderDependencies {
  getChatById: typeof getChatById;
  getMessageById: typeof getMessageById;
  saveMessages: typeof saveMessages;
  now(): Date;
  flushDelayMs: number;
  logger: Pick<Console, "warn">;
}

export function recoveryAssistantMessageId(
  input: RuntimeRecoveryChatRecorderInput,
): string {
  const hex = createHash("sha256")
    .update("openloomi:goal-recovery-message:v1\0")
    .update(input.ownerId)
    .update("\0")
    .update(input.runtimeSessionId)
    .update("\0")
    .update(input.providerSessionId)
    .update("\0")
    .update(String(input.runEpoch))
    .digest("hex")
    .slice(0, 32);
  // UUID-shaped deterministic ID keeps the existing Message_v2 conventions.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export async function createRuntimeRecoveryChatRecorder(
  input: RuntimeRecoveryChatRecorderInput,
  overrides: Partial<RuntimeRecoveryChatRecorderDependencies> = {},
): Promise<RuntimeRecoveryChatRecorder> {
  const deps: RuntimeRecoveryChatRecorderDependencies = {
    getChatById,
    getMessageById,
    saveMessages,
    now: () => new Date(),
    flushDelayMs: DEFAULT_FLUSH_DELAY_MS,
    logger: console,
    ...overrides,
  };
  const chat = await deps.getChatById({ id: input.runtimeSessionId });
  if (!chat || chat.userId !== input.ownerId) {
    throw new Error(
      `Recovery chat ${input.runtimeSessionId} is not owned by ${input.ownerId}`,
    );
  }

  const messageId = recoveryAssistantMessageId(input);
  const existing = (await deps.getMessageById({ id: messageId }))[0] as
    | StoredMessageLike
    | undefined;
  if (
    existing &&
    (existing.chatId !== input.runtimeSessionId ||
      existing.role !== "assistant")
  ) {
    throw new Error(`Recovery message ${messageId} has an invalid scope`);
  }

  return new BufferedRuntimeRecoveryChatRecorder(
    input,
    messageId,
    existing,
    deps,
  );
}

class BufferedRuntimeRecoveryChatRecorder implements RuntimeRecoveryChatRecorder {
  private parts: RecoveryMessagePart[];
  private attachments: unknown;
  private metadata: unknown;
  private createdAt: Date;
  private readonly seenMessageIds = new Set<string>();
  private readonly pendingMutations: RecoveryMessageMutation[] = [];
  private persistedParts: RecoveryMessagePart[] | null;
  private dirty = false;
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saveInFlight: Promise<void> | undefined;

  constructor(
    private readonly input: RuntimeRecoveryChatRecorderInput,
    private readonly messageId: string,
    existing: StoredMessageLike | undefined,
    private readonly deps: RuntimeRecoveryChatRecorderDependencies,
  ) {
    const existingParts = Array.isArray(existing?.parts)
      ? (structuredClone(existing.parts) as RecoveryMessagePart[])
      : [];
    this.parts = existingParts;
    this.persistedParts = existing ? structuredClone(existingParts) : null;
    this.attachments = existing?.attachments ?? [];
    this.metadata = existing?.metadata;
    this.createdAt = existing ? new Date(existing.createdAt) : this.deps.now();
  }

  async record(message: AgentMessage): Promise<void> {
    if (message.messageId) {
      if (this.seenMessageIds.has(message.messageId)) return;
      this.seenMessageIds.add(message.messageId);
    }

    if (message.type === "text" || message.type === "direct_answer") {
      this.recordMutation({
        kind: "append-text",
        partType: "text",
        text: message.content ?? "",
      });
      this.scheduleFlush();
      return;
    }
    if (message.type === "reasoning") {
      this.recordMutation({
        kind: "append-text",
        partType: "reasoning",
        text: message.content ?? "",
      });
      this.scheduleFlush();
      return;
    }
    if (message.type === "tool_use") {
      const toolUseId = message.id ?? message.toolUseId;
      if (!toolUseId) return;
      this.recordMutation({
        kind: "tool-use",
        toolUseId,
        toolName: message.name ?? "unknown",
        toolInput: message.input,
      });
      await this.flush();
      return;
    }
    if (message.type === "tool_result" && message.toolUseId) {
      this.recordMutation({
        kind: "tool-result",
        toolUseId: message.toolUseId,
        toolOutput: message.output,
        isError: message.isError === true,
      });
      await this.flush();
      return;
    }
    if (message.type === "error") {
      this.recordMutation({ kind: "provider-error" });
      await this.flush();
      return;
    }
    if (message.type === "done") {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    this.clearTimer();
    if (this.saveInFlight) {
      await this.saveInFlight;
      if (this.dirty) await this.flush();
      return;
    }
    if (!this.dirty || this.parts.length === 0) return;

    const save = this.persistWithCasRebase()
      .finally(() => {
        this.saveInFlight = undefined;
      });
    this.saveInFlight = save;
    await save;
  }

  async close(): Promise<void> {
    this.clearTimer();
    if (this.parts.some(isExecutingToolPart)) {
      this.recordMutation({ kind: "fail-executing-tools" });
    }
    await this.flush();
  }

  private recordMutation(mutation: RecoveryMessageMutation): void {
    if (
      mutation.kind === "append-text" &&
      mutation.text.length === 0
    ) {
      return;
    }
    this.pendingMutations.push(mutation);
    this.applyMutation(mutation);
    this.dirty = true;
    this.revision += 1;
  }

  private applyMutation(mutation: RecoveryMessageMutation): void {
    if (mutation.kind === "append-text") {
      const last = this.parts.at(-1);
      if (last?.type === mutation.partType) {
        last.text = `${typeof last.text === "string" ? last.text : ""}${mutation.text}`;
      } else {
        this.parts.push({ type: mutation.partType, text: mutation.text });
      }
      return;
    }
    if (mutation.kind === "tool-use") {
      const index = this.parts.findIndex(
        (part) =>
          part.type === "tool-native" &&
          part.toolUseId === mutation.toolUseId,
      );
      const next = {
        type: "tool-native",
        toolName: mutation.toolName,
        toolUseId: mutation.toolUseId,
        toolInput: mutation.toolInput,
        status: "executing",
      } satisfies RecoveryMessagePart;
      if (index >= 0) {
        this.parts[index] = { ...this.parts[index], ...next };
      } else {
        this.parts.push(next);
      }
      return;
    }
    if (mutation.kind === "tool-result") {
      const index = this.parts.findIndex(
        (part) =>
          part.type === "tool-native" &&
          part.toolUseId === mutation.toolUseId,
      );
      const result = {
        status: mutation.isError ? "error" : "completed",
        toolOutput: mutation.toolOutput,
        isError: mutation.isError,
      };
      if (index >= 0) {
        this.parts[index] = { ...this.parts[index], ...result };
      } else {
        this.parts.push({
          type: "tool-native",
          toolName: "unknown",
          toolUseId: mutation.toolUseId,
          toolInput: undefined,
          ...result,
        });
      }
      return;
    }
    if (mutation.kind === "provider-error") {
      this.failExecutingTools();
      this.appendTextPart(
        "text",
        "\n\n**Error:** The recovered assistant run stopped unexpectedly. Check the Goal status for details.",
      );
      return;
    }
    this.failExecutingTools();
  }

  private appendTextPart(type: "text" | "reasoning", text: string): void {
    const last = this.parts.at(-1);
    if (last?.type === type) {
      last.text = `${typeof last.text === "string" ? last.text : ""}${text}`;
    } else {
      this.parts.push({ type, text });
    }
  }

  private failExecutingTools(): void {
    for (let index = 0; index < this.parts.length; index += 1) {
      const part = this.parts[index];
      if (!isExecutingToolPart(part)) continue;
      this.parts[index] = {
        ...part,
        status: "error",
        toolOutput: "The recovered assistant run ended before this tool completed.",
        isError: true,
      };
    }
  }

  private async persistWithCasRebase(): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      const revision = this.revision;
      const includedMutationCount = this.pendingMutations.length;
      const parts = structuredClone(this.parts);
      const expectedParts = this.persistedParts
        ? structuredClone(this.persistedParts)
        : null;
      try {
        await this.deps.saveMessages({
          messages: [
            {
              id: this.messageId,
              chatId: this.input.runtimeSessionId,
              role: "assistant",
              parts,
              attachments: this.attachments,
              createdAt: this.createdAt,
              metadata: this.metadata,
            },
          ],
          expectedUserId: this.input.ownerId,
          expectedMessages: expectedParts
            ? [
                {
                  id: this.messageId,
                  chatId: this.input.runtimeSessionId,
                  parts: expectedParts,
                },
              ]
            : [],
        });
        this.persistedParts = parts;
        this.pendingMutations.splice(0, includedMutationCount);
        this.dirty = this.pendingMutations.length > 0 || this.revision !== revision;
        return;
      } catch (error) {
        if (
          !isMessageCasConflict(error) ||
          attempt >= MAX_CAS_REBASE_ATTEMPTS
        ) {
          throw error;
        }
        await this.rebaseOntoLatestPersistedMessage();
      }
    }
  }

  private async rebaseOntoLatestPersistedMessage(): Promise<void> {
    const chat = await this.deps.getChatById({
      id: this.input.runtimeSessionId,
    });
    if (!chat || chat.userId !== this.input.ownerId) {
      throw new Error(
        `Recovery chat ${this.input.runtimeSessionId} is not owned by ${this.input.ownerId}`,
      );
    }
    const latest = (await this.deps.getMessageById({ id: this.messageId }))[0] as
      | StoredMessageLike
      | undefined;
    if (!latest) {
      throw new Error(`Recovery message ${this.messageId} disappeared during rebase`);
    }
    if (
      latest.chatId !== this.input.runtimeSessionId ||
      latest.role !== "assistant"
    ) {
      throw new Error(`Recovery message ${this.messageId} has an invalid scope`);
    }

    const latestParts = Array.isArray(latest.parts)
      ? (structuredClone(latest.parts) as RecoveryMessagePart[])
      : [];
    this.parts = structuredClone(latestParts);
    this.persistedParts = latestParts;
    this.attachments = latest.attachments ?? [];
    this.metadata = latest.metadata;
    this.createdAt = new Date(latest.createdAt);
    for (const mutation of this.pendingMutations) this.applyMutation(mutation);
  }

  private scheduleFlush(): void {
    if (!this.dirty || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch((error) => {
        this.deps.logger.warn(
          `[Agent Goal Recovery] Failed to persist chat output for ${this.input.runtimeSessionId}`,
          error,
        );
      });
    }, this.deps.flushDelayMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function isExecutingToolPart(part: RecoveryMessagePart): boolean {
  return part.type === "tool-native" && part.status === "executing";
}

function isMessageCasConflict(error: unknown): boolean {
  return (
    error instanceof Error && error.message === MESSAGE_ID_SCOPE_CONFLICT
  );
}
