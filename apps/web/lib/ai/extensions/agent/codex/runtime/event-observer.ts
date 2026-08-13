import { createHash } from "node:crypto";

import type {
  RuntimeObservationContext,
  RuntimeProviderObservationPort,
  RuntimeUsageDelta,
} from "@/lib/ai/runtime-instructions/runtime-observation";
import type { CodexNormalizedRuntimeEvent, CodexTurnUsage } from "./events";
import { collectCodexItemEvidence } from "./evidence";

export interface CodexRuntimeEventObserverPort {
  providerSessionInitialized(input: {
    threadId: string;
    runEpoch: number;
  }): Promise<void>;

  instructionWritten(input: {
    instructionId: string;
    threadId: string;
    turnId: string;
    runEpoch: number;
    recordedAt?: string;
    /** Stable userMessage acknowledgement proving provider visibility. */
    providerEventId?: string;
    /** Lifecycle controls are provider-visible but do not create evidence context. */
    bindContext?: boolean;
  }): Promise<void>;

  observeEvent(
    event: CodexNormalizedRuntimeEvent,
    runEpoch: number,
  ): Promise<boolean>;

  captureTurnContext(input: {
    threadId: string;
    turnId: string;
    runEpoch: number;
  }): RuntimeObservationContext | null;

  flush(): Promise<void>;
}

interface BoundTurn {
  contexts: RuntimeObservationContext[];
}

/**
 * Serializes Codex app-server observations onto the provider-neutral Goal
 * journal. A provider item is causal only when it matches an instruction's
 * exact thread, turn, and Runtime epoch.
 */
export class CodexRuntimeEventObserver implements CodexRuntimeEventObserverPort {
  private readonly turns = new Map<string, BoundTurn>();
  private readonly instructionTurns = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();
  private providerSessionId?: string;

  constructor(
    private readonly ownerId: string,
    private readonly runtimeSessionId: string,
    private readonly observations: RuntimeProviderObservationPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  providerSessionInitialized(input: {
    threadId: string;
    runEpoch: number;
  }): Promise<void> {
    return this.enqueue(async () => {
      const { threadId, runEpoch } = input;
      this.assertProviderSession(threadId);
      await this.observations.setProviderSession({
        ownerId: this.ownerId,
        runtimeSessionId: this.runtimeSessionId,
        providerSessionId: threadId,
        runEpoch,
      });
    });
  }

  instructionWritten(input: {
    instructionId: string;
    threadId: string;
    turnId: string;
    runEpoch: number;
    recordedAt?: string;
    providerEventId?: string;
    bindContext?: boolean;
  }): Promise<void> {
    return this.enqueue(async () => {
      const { instructionId, threadId, turnId, runEpoch } = input;
      const key = turnKey(runEpoch, threadId, turnId);
      const previousTurn = this.instructionTurns.get(instructionId);
      if (previousTurn !== undefined) {
        if (previousTurn !== key) {
          throw new Error(
            `Codex instruction ${instructionId} was already bound to another turn`,
          );
        }
        return;
      }

      this.assertProviderSession(threadId);
      await this.observations.setProviderSession({
        ownerId: this.ownerId,
        runtimeSessionId: this.runtimeSessionId,
        providerSessionId: threadId,
        runEpoch,
      });
      const recorded = await this.observations.recordInstructionHandoff({
        ownerId: this.ownerId,
        runtimeSessionId: this.runtimeSessionId,
        instructionId,
        runEpoch,
        recordedAt: input.recordedAt ?? this.now().toISOString(),
      });
      if (!recorded) {
        throw new Error(
          `Runtime rejected the handoff for instruction ${instructionId}`,
        );
      }
      if (input.bindContext === false) {
        this.instructionTurns.set(instructionId, key);
        return;
      }
      const context = await this.observations.captureContext({
        ownerId: this.ownerId,
        runtimeSessionId: this.runtimeSessionId,
        runEpoch,
        instructionId,
      });
      if (!context || context.instructionId !== instructionId) {
        throw new Error(
          `Runtime did not expose the handoff context for instruction ${instructionId}`,
        );
      }

      const existing = this.turns.get(key);
      if (existing) {
        if (
          !existing.contexts.some(
            (candidate) => candidate.instructionId === instructionId,
          )
        ) {
          existing.contexts.push(structuredClone(context));
        }
      } else {
        this.turns.set(key, {
          contexts: [structuredClone(context)],
        });
      }
      this.instructionTurns.set(instructionId, key);
      if (input.providerEventId) {
        const providerEventId = input.providerEventId;
        await this.observations.observeProviderEvent({
          ownerId: this.ownerId,
          runtimeSessionId: this.runtimeSessionId,
          runEpoch,
          eventKey: providerEventId,
          providerEventId,
          providerSessionId: threadId,
          observedAt: input.recordedAt ?? this.now().toISOString(),
          terminal: false,
          context: structuredClone(context),
          acknowledgedContexts: [structuredClone(context)],
        });
      }
    });
  }

  observeEvent(
    event: CodexNormalizedRuntimeEvent,
    runEpoch: number,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const { threadId, turnId } = event;
      this.assertProviderSession(threadId);
      const key = turnKey(runEpoch, threadId, turnId);
      const bound = this.turns.get(key);
      if (!bound) return false;
      const providerEventId = stableProviderEventId(event);

      const observedAt = event.observedAt ?? this.now().toISOString();
      const terminal = event.kind === "turn.completed";
      const context = bound.contexts.at(-1);
      if (!context) {
        if (terminal) this.releaseTurn(key);
        return false;
      }
      const evidence =
        event.kind === "item.completed"
          ? collectCodexItemEvidence({
              providerEventId,
              item: event.item,
              observedAt,
            })
          : undefined;

      const accepted = await this.observations.observeProviderEvent({
        ownerId: this.ownerId,
        runtimeSessionId: this.runtimeSessionId,
        runEpoch,
        eventKey: providerEventId,
        providerEventId,
        providerSessionId: threadId,
        observedAt,
        terminal,
        context,
        acknowledgedContexts: structuredClone(bound.contexts),
        ...(evidence === undefined ? {} : { evidence: [evidence] }),
        ...(terminal ? { usage: terminalUsage(event.usage) } : {}),
      });
      if (terminal) this.releaseTurn(key);
      return accepted;
    });
  }

  captureTurnContext(input: {
    threadId: string;
    turnId: string;
    runEpoch: number;
  }): RuntimeObservationContext | null {
    const bound = this.turns.get(
      turnKey(input.runEpoch, input.threadId, input.turnId),
    );
    const context = bound?.contexts.at(-1);
    return context ? structuredClone(context) : null;
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

  private assertProviderSession(threadId: string): void {
    if (
      this.providerSessionId !== undefined &&
      this.providerSessionId !== threadId
    ) {
      throw new Error(
        `Codex event belongs to provider thread ${threadId}, not ${this.providerSessionId}`,
      );
    }
    this.providerSessionId = threadId;
  }

  private releaseTurn(key: string): void {
    this.turns.delete(key);
  }
}

function stableProviderEventId(event: CodexNormalizedRuntimeEvent): string {
  const parts =
    event.kind === "item.completed"
      ? ["codex", event.threadId, event.turnId, event.item.id, event.kind]
      : ["codex", event.threadId, event.turnId, event.kind];
  const raw = parts.join(":");
  if (raw.length <= 256) return raw;
  const digest = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
  return `${raw.slice(0, 180)}:${digest}`.slice(0, 256);
}

function terminalUsage(usage: CodexTurnUsage | undefined): RuntimeUsageDelta {
  if (!usage) return { tokensUsed: 0, turnsUsed: 1 };
  return {
    tokensUsed: usage.inputTokens + usage.outputTokens,
    turnsUsed: 1,
  };
}

function turnKey(runEpoch: number, threadId: string, turnId: string): string {
  return JSON.stringify([runEpoch, threadId, turnId]);
}
