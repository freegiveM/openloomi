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
  contexts: RuntimeObservationContext[];
}

export type ClaudeInstructionTurnHandoff = "current_turn" | "next_turn";

export interface ClaudeRuntimeEventObserverPort {
  instructionWritten(input: {
    instructionId: string;
    runEpoch: number;
    turnHandoff: ClaudeInstructionTurnHandoff;
    recordedAt?: string;
  }): Promise<void>;

  captureTurnContexts(
    runEpoch: number,
  ): Promise<RuntimeObservationContext[]>;

  observeSdkMessage(message: SDKMessage, runEpoch: number): Promise<void>;

  observeStopAssistantReport(input: ClaudeRuntimeStopReport): Promise<void>;

  captureToolStart(input: ClaudeRuntimeToolStart): Promise<void>;

  observeToolOutcome(input: ClaudeRuntimeToolOutcome): Promise<void>;

  flush(): Promise<void>;
}

interface CapturedToolContext {
  runEpoch: number;
  contexts: RuntimeObservationContext[];
}

interface ClaudeTurnContexts {
  active: RuntimeObservationContext[];
  pending: RuntimeObservationContext[][];
}

/**
 * Converts Claude-specific SDK messages and tool hooks into the provider-
 * neutral observation boundary. All callbacks share one async tail so
 * synchronous SDK input handoff cannot race ahead of later provider output.
 */
export class ClaudeRuntimeEventObserver implements ClaudeRuntimeEventObserverPort {
  private readonly toolContexts = new Map<string, CapturedToolContext>();
  private readonly turnContexts = new Map<number, ClaudeTurnContexts>();
  private readonly terminalEventKeys = new Set<string>();
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
    turnHandoff: ClaudeInstructionTurnHandoff;
    recordedAt?: string;
  }): Promise<void> {
    return this.enqueue(async () => {
      const recorded = await this.observations.recordInstructionHandoff({
        ownerId: this.ownerId,
        runtimeSessionId: this.runtimeSessionId,
        instructionId: input.instructionId,
        runEpoch: input.runEpoch,
        recordedAt: input.recordedAt ?? this.now().toISOString(),
      });
      if (!recorded) {
        throw new Error(
          `Runtime rejected the handoff for instruction ${input.instructionId}`,
        );
      }
      const context = await this.observations.captureContext({
        ownerId: this.ownerId,
        runtimeSessionId: this.runtimeSessionId,
        runEpoch: input.runEpoch,
      });
      if (!context || context.instructionId !== input.instructionId) {
        throw new Error(
          `Runtime did not expose the handoff context for instruction ${input.instructionId}`,
        );
      }
      const existing = this.turnContexts.get(input.runEpoch);
      if (!existing) {
        this.turnContexts.set(input.runEpoch, {
          active:
            input.turnHandoff === "current_turn"
              ? [structuredClone(context)]
              : [],
          pending:
            input.turnHandoff === "next_turn"
              ? [[structuredClone(context)]]
              : [],
        });
        return;
      }
      if (hasInstructionContext(existing, context.instructionId)) return;
      if (input.turnHandoff === "current_turn") {
        existing.active.push(structuredClone(context));
      } else {
        existing.pending.push([structuredClone(context)]);
      }
    });
  }

  captureTurnContexts(runEpoch: number): Promise<RuntimeObservationContext[]> {
    return this.enqueue(async () => this.activeContexts(runEpoch));
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
      const terminal = message.type === "result";
      if (terminal && this.terminalEventKeys.has(identity.eventKey)) return;

      const observedAt = sdkTimestamp(message) ?? this.now().toISOString();
      const assistantMessage = message.type === "assistant";
      const contexts = this.activeContexts(runEpoch);
      const context = contexts.at(-1);
      if (!context) {
        if (terminal) this.finishTerminalEvent(runEpoch, identity.eventKey);
        return;
      }
      const assistantEvidence = assistantMessage
        ? collectClaudeAssistantEvidence({
            providerEventId: identity.providerEventId,
            text: assistantMessageText(message),
            observedAt,
          })
        : undefined;
      const assistantUsage = extractClaudeAssistantUsage(message);
      const usage =
        assistantUsage ??
        (terminal && !this.epochsWithAssistantUsage.has(runEpoch)
          ? extractClaudeResultUsage(message)
          : undefined);
      let accepted: boolean;
      try {
        accepted = await this.observations.observeProviderEvent({
          ownerId: this.ownerId,
          runtimeSessionId: this.runtimeSessionId,
          runEpoch,
          eventKey: identity.eventKey,
          providerEventId: identity.providerEventId,
          ...(identity.providerSessionId === undefined
            ? {}
            : { providerSessionId: identity.providerSessionId }),
          observedAt,
          terminal,
          context,
          acknowledgedContexts: contexts,
          ...(assistantEvidence === undefined
            ? {}
            : { evidence: [assistantEvidence] }),
          ...(usage === undefined ? {} : { usage }),
        });
      } finally {
        if (terminal) this.finishTerminalEvent(runEpoch, identity.eventKey);
      }
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

      const context = input.contexts.at(-1);
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
        acknowledgedContexts: input.contexts,
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
      const contexts = this.activeContexts(input.runEpoch);
      this.toolContexts.set(key, { runEpoch: input.runEpoch, contexts });
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
      const context = captured.contexts.at(-1);
      if (!context) return;

      const providerEventId = boundedProviderEventId(
        `claude-tool:${input.providerSessionId ?? this.providerSessionId ?? "unknown"}:${input.toolUseId}`,
      );
      const providerSessionId =
        input.providerSessionId ?? this.providerSessionId;
      const observedAt = this.now().toISOString();
      const evidence = [
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
      ];

      await this.observations.observeProviderEvent({
        ownerId: this.ownerId,
        runtimeSessionId: this.runtimeSessionId,
        runEpoch: captured.runEpoch,
        eventKey: providerEventId,
        providerEventId,
        ...(providerSessionId === undefined ? {} : { providerSessionId }),
        observedAt,
        context,
        acknowledgedContexts: captured.contexts,
        evidence,
      });
    });
  }

  flush(): Promise<void> {
    return this.tail;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.then(
      () => undefined,
      () => undefined,
    );
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

  private activeContexts(runEpoch: number): RuntimeObservationContext[] {
    return structuredClone(this.turnContexts.get(runEpoch)?.active ?? []);
  }

  private advanceTurnContext(runEpoch: number): void {
    const contexts = this.turnContexts.get(runEpoch);
    if (!contexts) return;
    const next = contexts.pending.shift();
    if (!next) {
      this.turnContexts.delete(runEpoch);
      return;
    }
    contexts.active = next;
  }

  private finishTerminalEvent(runEpoch: number, eventKey: string): void {
    this.terminalEventKeys.add(eventKey);
    this.advanceTurnContext(runEpoch);
  }
}

function hasInstructionContext(
  contexts: ClaudeTurnContexts,
  instructionId: string,
): boolean {
  return [contexts.active, ...contexts.pending].some((turn) =>
    turn.some((context) => context.instructionId === instructionId),
  );
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
