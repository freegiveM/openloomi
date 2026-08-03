import { createHash } from "node:crypto";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  RuntimeObservationContext,
  RuntimeProviderObservationPort,
} from "@/lib/ai/runtime-instructions/runtime-observation";
import {
  collectClaudeAssistantEvidence,
  collectClaudeToolEvidence,
} from "./evidence-collector";
import { extractClaudeAssistantUsage, extractClaudeResultUsage } from "./usage";

export interface ClaudeRuntimeToolStart {
  toolUseId: string;
  toolName: string;
  providerSessionId?: string;
  runEpoch: number;
}

export interface ClaudeRuntimeToolOutcome extends ClaudeRuntimeToolStart {
  outcome: "succeeded" | "failed";
  toolInput: unknown;
  toolResponse?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ClaudeRuntimeStopReport {
  assistantTurnId: string;
  text: string;
  providerSessionId?: string;
  runEpoch: number;
}

export interface ClaudeRuntimeEventObserverPort {
  instructionWritten(input: {
    instructionId: string;
    runEpoch: number;
    recordedAt?: string;
  }): Promise<void>;

  observeSdkMessage(message: SDKMessage, runEpoch: number): Promise<void>;

  observeStopAssistantReport(input: ClaudeRuntimeStopReport): Promise<void>;

  captureToolStart(input: ClaudeRuntimeToolStart): Promise<void>;

  observeToolOutcome(input: ClaudeRuntimeToolOutcome): Promise<void>;

  flush(): Promise<void>;
}

interface CapturedToolContext {
  runEpoch: number;
  context: RuntimeObservationContext | null;
}

/**
 * Converts Claude-specific SDK messages and tool hooks into the provider-
 * neutral observation boundary. All callbacks share one async tail so
 * synchronous SDK input handoff cannot race ahead of later provider output.
 */
export class ClaudeRuntimeEventObserver implements ClaudeRuntimeEventObserverPort {
  private readonly toolContexts = new Map<string, CapturedToolContext>();
  private tail: Promise<void> = Promise.resolve();
  private providerSessionId?: string;
  private readonly epochsWithAssistantUsage = new Set<number>();

  constructor(
    private readonly ownerId: string,
    private readonly runtimeSessionId: string,
    private readonly observations: RuntimeProviderObservationPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  instructionWritten(input: {
    instructionId: string;
    runEpoch: number;
    recordedAt?: string;
  }): Promise<void> {
    return this.enqueue(async () => {
      await this.observations.recordInstructionHandoff({
        ownerId: this.ownerId,
        runtimeSessionId: this.runtimeSessionId,
        instructionId: input.instructionId,
        runEpoch: input.runEpoch,
        recordedAt: input.recordedAt ?? this.now().toISOString(),
      });
    });
  }

  observeSdkMessage(message: SDKMessage, runEpoch: number): Promise<void> {
    return this.enqueue(async () => {
      const identity = sdkMessageIdentity(message);
      if (identity?.providerSessionId) {
        this.assertProviderSession(identity.providerSessionId);
      }
      if (message.type === "system" && message.subtype === "init") {
        if (identity?.providerSessionId) {
          await this.observations.setProviderSession({
            ownerId: this.ownerId,
            runtimeSessionId: this.runtimeSessionId,
            providerSessionId: identity.providerSessionId,
          });
        }
        return;
      }
      if (!identity || !isCausalProviderMessage(message)) return;

      const observedAt = sdkTimestamp(message) ?? this.now().toISOString();
      const assistantMessage = message.type === "assistant";
      const context = assistantMessage
        ? await this.observations.captureContext({
            ownerId: this.ownerId,
            runtimeSessionId: this.runtimeSessionId,
            runEpoch,
          })
        : null;
      const assistantEvidence = assistantMessage
        ? collectClaudeAssistantEvidence({
            providerEventId: identity.providerEventId,
            text: assistantMessageText(message),
            observedAt,
          })
        : undefined;
      const assistantUsage =
        context === null ? undefined : extractClaudeAssistantUsage(message);
      const usage =
        assistantUsage ??
        (message.type === "result" &&
        !this.epochsWithAssistantUsage.has(runEpoch)
          ? extractClaudeResultUsage(message)
          : undefined);
      const accepted = await this.observations.observeProviderEvent({
        ownerId: this.ownerId,
        runtimeSessionId: this.runtimeSessionId,
        runEpoch,
        eventKey: identity.eventKey,
        providerEventId: identity.providerEventId,
        ...(identity.providerSessionId === undefined
          ? {}
          : { providerSessionId: identity.providerSessionId }),
        observedAt,
        terminal: message.type === "result",
        ...(context === null ? {} : { context }),
        ...(assistantEvidence === undefined
          ? {}
          : { evidence: [assistantEvidence] }),
        ...(usage === undefined ? {} : { usage }),
      });
      if (accepted && assistantUsage !== undefined) {
        this.epochsWithAssistantUsage.add(runEpoch);
      }
    });
  }

  observeStopAssistantReport(input: ClaudeRuntimeStopReport): Promise<void> {
    return this.enqueue(async () => {
      if (input.providerSessionId) {
        this.assertProviderSession(input.providerSessionId);
      }
      const providerSessionId =
        input.providerSessionId ?? this.providerSessionId;
      const observedAt = this.now().toISOString();
      const evidence = collectClaudeAssistantEvidence({
        providerEventId: input.assistantTurnId,
        text: input.text,
        observedAt,
      });
      if (!evidence) return;

      const context = await this.observations.captureContext({
        ownerId: this.ownerId,
        runtimeSessionId: this.runtimeSessionId,
        runEpoch: input.runEpoch,
      });
      if (!context) return;

      await this.observations.observeProviderEvent({
        ownerId: this.ownerId,
        runtimeSessionId: this.runtimeSessionId,
        runEpoch: input.runEpoch,
        eventKey: boundedProviderEventId(
          [
            "claude-stop-report",
            providerSessionId ?? "unknown",
            input.assistantTurnId,
          ].join(":"),
        ),
        providerEventId: input.assistantTurnId,
        ...(providerSessionId === undefined ? {} : { providerSessionId }),
        observedAt,
        context,
        evidence: [evidence],
      });
    });
  }

  captureToolStart(input: ClaudeRuntimeToolStart): Promise<void> {
    return this.enqueue(async () => {
      if (input.providerSessionId) {
        this.assertProviderSession(input.providerSessionId);
      }
      const key = toolKey(input.providerSessionId, input.toolUseId);
      if (this.toolContexts.has(key)) return;
      const context = await this.observations.captureContext({
        ownerId: this.ownerId,
        runtimeSessionId: this.runtimeSessionId,
        runEpoch: input.runEpoch,
      });
      this.toolContexts.set(key, { runEpoch: input.runEpoch, context });
    });
  }

  observeToolOutcome(input: ClaudeRuntimeToolOutcome): Promise<void> {
    return this.enqueue(async () => {
      if (input.providerSessionId) {
        this.assertProviderSession(input.providerSessionId);
      }
      const key = toolKey(input.providerSessionId, input.toolUseId);
      const captured = this.toolContexts.get(key);
      if (!captured) return;
      this.toolContexts.delete(key);

      const providerEventId = boundedProviderEventId(
        `claude-tool:${input.providerSessionId ?? this.providerSessionId ?? "unknown"}:${input.toolUseId}`,
      );
      const providerSessionId =
        input.providerSessionId ?? this.providerSessionId;
      const observedAt = this.now().toISOString();
      const evidence = captured.context
        ? [
            collectClaudeToolEvidence({
              providerEventId,
              toolUseId: input.toolUseId,
              toolName: input.toolName,
              outcome: input.outcome,
              toolInput: input.toolInput,
              ...(input.toolResponse === undefined
                ? {}
                : { toolResponse: input.toolResponse }),
              ...(input.error === undefined ? {} : { error: input.error }),
              ...(input.durationMs === undefined
                ? {}
                : { durationMs: input.durationMs }),
              observedAt,
            }),
          ]
        : undefined;

      await this.observations.observeProviderEvent({
        ownerId: this.ownerId,
        runtimeSessionId: this.runtimeSessionId,
        runEpoch: captured.runEpoch,
        eventKey: providerEventId,
        providerEventId,
        ...(providerSessionId === undefined ? {} : { providerSessionId }),
        observedAt,
        ...(captured.context === null ? {} : { context: captured.context }),
        ...(evidence === undefined ? {} : { evidence }),
      });
    });
  }

  flush(): Promise<void> {
    return this.tail;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => {});
    return pending;
  }

  private assertProviderSession(providerSessionId: string): void {
    if (
      this.providerSessionId !== undefined &&
      this.providerSessionId !== providerSessionId
    ) {
      throw new Error(
        `Claude event belongs to provider session ${providerSessionId}, not ${this.providerSessionId}`,
      );
    }
    this.providerSessionId = providerSessionId;
  }
}

interface ClaudeSdkMessageIdentity {
  eventKey: string;
  providerEventId: string;
  providerSessionId?: string;
}

function sdkMessageIdentity(
  message: SDKMessage,
): ClaudeSdkMessageIdentity | null {
  const candidate = message as SDKMessage & {
    uuid?: unknown;
    session_id?: unknown;
  };
  if (
    typeof candidate.uuid !== "string" ||
    candidate.uuid.length === 0 ||
    candidate.uuid.length > 256
  ) {
    return null;
  }
  const providerSessionId =
    typeof candidate.session_id === "string" &&
    candidate.session_id.length > 0 &&
    candidate.session_id.length <= 256
      ? candidate.session_id
      : undefined;
  return {
    // Claude UUIDs are the provider's event identity. Do not include mutable
    // wrapper fields such as subtype, or a replay could apply usage twice.
    eventKey: [
      "claude-sdk",
      providerSessionId ?? "unknown",
      candidate.uuid,
    ].join(":"),
    providerEventId: candidate.uuid,
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
  };
}

function isCausalProviderMessage(message: SDKMessage): boolean {
  if (
    message.type === "user" &&
    (message as SDKMessage & { isReplay?: unknown }).isReplay === true
  ) {
    return false;
  }
  return (
    message.type === "assistant" ||
    message.type === "user" ||
    message.type === "result"
  );
}

function assistantMessageText(message: SDKMessage): string {
  if (message.type !== "assistant") return "";
  const content = (
    message as SDKMessage & {
      message?: { content?: unknown };
    }
  ).message?.content;
  if (!Array.isArray(content)) return "";

  return content
    .flatMap((block) => {
      if (
        block !== null &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return [(block as { text: string }).text];
      }
      return [];
    })
    .join("\n")
    .trim();
}

function sdkTimestamp(message: SDKMessage): string | undefined {
  const timestamp = (message as SDKMessage & { timestamp?: unknown }).timestamp;
  return typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))
    ? timestamp
    : undefined;
}

function toolKey(
  providerSessionId: string | undefined,
  toolUseId: string,
): string {
  return JSON.stringify([providerSessionId ?? "unknown", toolUseId]);
}

function boundedProviderEventId(value: string): string {
  if (value.length <= 256) return value;
  const digest = createHash("sha256").update(value).digest("hex");
  return `${value.slice(0, 180)}:${digest}`.slice(0, 256);
}
