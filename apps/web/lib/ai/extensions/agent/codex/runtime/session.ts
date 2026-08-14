import { AgentOutputEventBus } from "@melandlabs/ai/agent/runtime";
import type { AgentMessage } from "@melandlabs/ai/agent";
import {
  type RuntimeDeliveryReceipt,
  type RuntimeInstruction,
  RuntimeInstructionSchema,
  type RuntimeSessionLifecycleControlPort,
  type RuntimeSessionState,
  type RuntimeTerminalInputHold,
  type RuntimeTurnBoundary,
  type RuntimeTurnBoundaryInputHold,
  type RuntimeTurnTerminal,
  formatRuntimeInstruction,
} from "@openloomi/ai/agent/runtime-instructions";
import type { AgentRuntimeInstructionSettlement } from "@/lib/ai/agent/types-shim";

import type {
  GoalStopDecision,
  RuntimeGoalStopControllerPort,
} from "@/lib/ai/runtime-instructions/goal-controller";
import type { RuntimeObservationContext } from "@/lib/ai/runtime-instructions/runtime-observation";
import type {
  CodexAppServerClient,
  CodexAppServerNotification,
  CodexAppServerPersistedTurn,
  CodexAppServerSandboxMode,
  CodexAppServerTurnStartResult,
} from "../app-server";
import {
  CodexAppServerRpcError,
  createCodexAppServerTextInput,
} from "../app-server";
import type { CodexRuntimeEventObserverPort } from "./event-observer";
import type { CodexNormalizedRuntimeEvent } from "./events";
import {
  type CodexWireEventProjector,
  createCodexWireEventProjector,
} from "./wire-events";

export type CodexAppServerRuntimeClient = Pick<
  CodexAppServerClient,
  | "initialize"
  | "resumeThread"
  | "startThread"
  | "startTurn"
  | "steerTurn"
  | "interruptTurn"
  | "onNotification"
  | "waitForExit"
  | "shutdown"
>;

export interface CodexRuntimeSessionStartInput {
  initialPrompt: string;
  cwd: string;
  model?: string;
  sandbox?: CodexAppServerSandboxMode;
  recovery?: {
    /** Exact durable app-server thread; recovery must never fork it. */
    providerSessionId: string;
    /** Instructions reset to pending by the durable recovery claim. */
    replayableInstructionIds: readonly string[];
    /** Already-settled inputs needed only to rebind an in-progress turn. */
    contextInstructionIds?: readonly string[];
    /** Exact bindings recovered from Codex provider input event identities. */
    contextBindings?: readonly {
      instructionId: string;
      turnId: string;
      providerEventId: string;
      recordedAt: string;
    }[];
  };
}

interface PendingInstruction {
  instruction: RuntimeInstruction;
  content: string;
}

interface TerminalWaiter {
  expectedRunEpoch: number;
  afterTerminalSequence: number;
  resolve: (terminal: RuntimeTurnTerminal) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class CodexRuntimeSessionError extends Error {
  constructor(
    readonly code:
      | "already_started"
      | "closed"
      | "invalid_run_epoch"
      | "not_started"
      | "provider_failed",
    message: string,
  ) {
    super(message);
    this.name = "CodexRuntimeSessionError";
  }
}

/**
 * One live Codex app-server thread. OpenLoomi remains the Goal source of truth;
 * Codex only receives formatted instructions and reports turn/item events.
 */
export class CodexRuntimeSession implements RuntimeSessionLifecycleControlPort {
  readonly runtimeSessionId: string;

  private readonly output = new AgentOutputEventBus<AgentMessage>();
  private readonly pendingBoundary: PendingInstruction[] = [];
  private readonly receipts = new Map<string, RuntimeDeliveryReceipt>();
  private readonly terminalHistory: RuntimeTurnTerminal[] = [];
  private readonly terminalWaiters = new Set<TerminalWaiter>();
  private projector: CodexWireEventProjector;
  private readonly usesDefaultProjector: boolean;
  private eventTail: Promise<void> = Promise.resolve();
  private deliveryTail: Promise<void> = Promise.resolve();
  private eventObserver?: CodexRuntimeEventObserverPort;
  private goalController?: RuntimeGoalStopControllerPort;
  private unsubscribe?: () => void;
  private startupNotifications: CodexAppServerNotification[] = [];
  private notificationMode: "buffering" | "live" | "discard" = "buffering";
  private threadId?: string;
  private currentTurnId?: string;
  private currentState: RuntimeSessionState = "starting";
  private terminalSequence = 0;
  private pendingInputHolds = 0;
  private closeAfterInputRelease = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly expectedInterruptedTurns = new Set<string>();
  private readonly arrivedTerminalTurns = new Set<string>();
  private readonly arrivedInstructionAcks = new Map<
    string,
    { threadId: string; turnId: string }
  >();
  private readonly pendingHandoffs = new Map<
    string,
    { turnId?: string; pending: PendingInstruction[] }
  >();
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private resultPublished = false;
  private lastAssistantByTurn = new Map<string, string>();
  private initialPrompt?: string;
  private recoveryOwned = false;
  private readonly recoveredSettlements: AgentRuntimeInstructionSettlement[] =
    [];
  runEpoch: number;

  constructor(
    runtimeSessionId: string,
    private readonly client: CodexAppServerRuntimeClient,
    options: {
      runEpoch?: number;
      projector?: CodexWireEventProjector;
    } = {},
  ) {
    this.runtimeSessionId = identifier(runtimeSessionId, "runtimeSessionId");
    this.runEpoch = nonNegativeInteger(options.runEpoch ?? 0, "runEpoch");
    this.usesDefaultProjector = options.projector === undefined;
    this.projector = options.projector ?? createCodexWireEventProjector();
  }

  attachEventObserver(observer: CodexRuntimeEventObserverPort): void {
    if (this.currentState !== "starting" || this.eventObserver) {
      throw new CodexRuntimeSessionError(
        "already_started",
        "Codex event observer must be attached before start",
      );
    }
    this.eventObserver = observer;
  }

  attachGoalStopController(controller: RuntimeGoalStopControllerPort): void {
    if (this.currentState !== "starting" || this.goalController) {
      throw new CodexRuntimeSessionError(
        "already_started",
        "Codex Goal controller must be attached before start",
      );
    }
    this.goalController = controller;
  }

  initializeRunEpoch(runEpoch: number): void {
    if (this.threadId || this.currentState !== "starting") {
      throw new CodexRuntimeSessionError(
        "already_started",
        "Codex runEpoch must be initialized before the provider thread starts",
      );
    }
    this.runEpoch = nonNegativeInteger(runEpoch, "runEpoch");
  }

  async start(input: CodexRuntimeSessionStartInput): Promise<void> {
    if (this.currentState !== "starting" || this.threadId) {
      throw new CodexRuntimeSessionError(
        "already_started",
        "Codex Runtime Session can only be started once",
      );
    }
    this.recoveryOwned = input.recovery !== undefined;
    if (input.recovery && this.usesDefaultProjector) {
      this.projector = createCodexWireEventProjector({
        usageBaseline: "first_snapshot",
      });
    }
    this.unsubscribe = this.client.onNotification((notification) => {
      if (this.notificationMode === "buffering") {
        this.startupNotifications.push(notification);
        return;
      }
      if (this.notificationMode === "live") {
        this.enqueueNotification(notification);
      }
    });

    try {
      await this.client.initialize();
      const resumed = input.recovery
        ? await this.client.resumeThread({
            threadId: identifier(
              input.recovery.providerSessionId,
              "recovery.providerSessionId",
            ),
          })
        : undefined;
      const started = resumed
        ? undefined
        : await this.client.startThread({
            cwd: input.cwd,
            model: input.model ?? null,
            sandbox: input.sandbox ?? null,
          });
      this.threadId = identifier(
        resumed?.thread.id ?? started?.thread.id,
        "thread.id",
      );
      if (
        input.recovery &&
        this.threadId !== input.recovery.providerSessionId
      ) {
        throw new CodexRuntimeSessionError(
          "provider_failed",
          `Codex resumed thread ${this.threadId}, expected ${input.recovery.providerSessionId}`,
        );
      }
      await this.eventObserver?.providerSessionInitialized({
        threadId: this.threadId,
        runEpoch: this.runEpoch,
      });
      if (resumed && input.recovery) {
        await this.rebuildRecoveredObservationContext(
          resumed.thread.turns,
          new Set(input.recovery.replayableInstructionIds),
          new Set(input.recovery.contextInstructionIds ?? []),
          input.recovery.contextBindings ?? [],
        );
        const activeTurn = [...resumed.thread.turns]
          .reverse()
          .find((turn) => turn.status === "inProgress");
        this.currentTurnId = activeTurn?.id;
        this.currentState = activeTurn ? "running" : "idle";
      } else {
        this.currentState = "idle";
        this.initialPrompt = input.initialPrompt;
      }
      // Recovery remains buffered until registration hydrates durable progress
      // and replays pending input. A fresh thread has no such external state.
      if (!input.recovery) this.releaseStartupNotifications();
      void this.watchExit().catch((error) =>
        this.fail(error).catch(() => undefined),
      );
    } catch (error) {
      this.discardStartupNotifications();
      await this.fail(error);
      throw error;
    }
  }

  subscribe(): AsyncIterable<AgentMessage> {
    return this.output.subscribe();
  }

  recoveredInstructionSettlements(): readonly AgentRuntimeInstructionSettlement[] {
    return this.recoveredSettlements.map((settlement) => ({ ...settlement }));
  }

  hasActiveTurn(): boolean {
    return this.currentTurnId !== undefined;
  }

  async activateRecoveredNotifications(): Promise<void> {
    if (!this.recoveryOwned || !this.threadId) {
      throw new CodexRuntimeSessionError(
        "already_started",
        "Codex recovery notifications can only be activated after recovery starts",
      );
    }
    await this.releaseStartupNotifications();
  }

  async beginInitialTurn(): Promise<void> {
    await this.serializeDelivery(async () => {
      if (this.currentTurnId || this.initialPrompt === undefined) return;
      await this.startTurn(this.takeInitialPrompt(), []);
    });
  }

  deliver(
    instructionValue: RuntimeInstruction,
  ): Promise<RuntimeDeliveryReceipt> {
    const instruction = RuntimeInstructionSchema.parse(instructionValue);
    return this.serializeDelivery(async () => {
      const existing = this.receipts.get(instruction.id);
      if (existing) return structuredClone(existing);
      this.assertOpen();

      if (isInterruptInstruction(instruction)) {
        const expectedRunEpoch = instruction.payload.expectedRunEpoch;
        this.assertRunEpoch(expectedRunEpoch);
        if (
          instruction.kind === "goal.pause" ||
          instruction.kind === "goal.cancel"
        ) {
          this.closeAfterInputRelease = true;
        }
        const turnId = this.currentTurnId;
        if (turnId) {
          this.expectedInterruptedTurns.add(turnId);
          try {
            await this.client.interruptTurn({
              threadId: this.requireThreadId(),
              turnId,
            });
          } catch (error) {
            this.expectedInterruptedTurns.delete(turnId);
            throw error;
          }
          await this.eventObserver?.instructionWritten({
            instructionId: instruction.id,
            threadId: this.requireThreadId(),
            turnId,
            runEpoch: this.runEpoch,
            bindContext: false,
          });
          // Codex 0.146 acknowledges turn/interrupt but does not reliably emit
          // a turn/completed notification afterwards. The successful RPC is
          // the authoritative interruption boundary; a late notification is
          // harmless because this turn is no longer current.
          this.completeInterruptedTurn(turnId);
        }
        return this.rememberReceipt(instruction.id, "written_to_sdk", turnId);
      }

      const pending = {
        instruction,
        content: formatRuntimeInstruction(instruction),
      };
      if (
        this.pendingInputHolds > 0 ||
        instruction.deliveryMode === "next_boundary" ||
        this.pendingBoundary.length > 0
      ) {
        this.pendingBoundary.push(pending);
        if (!this.currentTurnId && this.pendingInputHolds === 0) {
          await this.flushPendingBoundary();
          return structuredClone(
            this.receipts.get(instruction.id) ??
              this.rememberReceipt(instruction.id, "queued"),
          );
        }
        return this.rememberReceipt(instruction.id, "queued");
      }

      const activeTurnId = this.currentTurnId;
      if (activeTurnId) {
        if (this.arrivedTerminalTurns.has(activeTurnId)) {
          this.enqueuePendingBoundary(pending);
          return this.rememberReceipt(instruction.id, "queued");
        }
        this.pendingHandoffs.set(instruction.id, {
          turnId: activeTurnId,
          pending: [pending],
        });
        try {
          const steered = await this.client.steerTurn({
            threadId: this.requireThreadId(),
            expectedTurnId: activeTurnId,
            input: [createCodexAppServerTextInput(pending.content)],
            clientUserMessageId: instruction.id,
          });
          if (steered.turnId !== activeTurnId) {
            throw new Error("Codex steered a different active turn");
          }
          if (
            this.arrivedTerminalTurns.has(activeTurnId) &&
            !this.matchesArrivedInstructionAck(instruction.id, activeTurnId)
          ) {
            this.pendingHandoffs.delete(instruction.id);
            this.enqueuePendingBoundary(pending);
            return this.rememberReceipt(instruction.id, "queued");
          }
          // The RPC response confirms that Codex accepted the steer request,
          // while the echoed userMessage.clientId is the causal handoff. Keep
          // the durable Delivery queued until that acknowledgement arrives.
          return this.rememberReceipt(instruction.id, "queued", activeTurnId);
        } catch (error) {
          this.pendingHandoffs.delete(instruction.id);
          if (
            !this.arrivedTerminalTurns.has(activeTurnId) &&
            !isTurnNoLongerSteerable(error)
          ) {
            throw error;
          }
          this.enqueuePendingBoundary(pending);
          return this.rememberReceipt(instruction.id, "queued");
        }
      }

      await this.startTurn(this.withInitialPrompt(pending.content), [pending]);
      return structuredClone(
        this.receipts.get(instruction.id) ??
          this.rememberReceipt(instruction.id, "queued", this.currentTurnId),
      );
    });
  }

  async interrupt(input: {
    reason: string;
    expectedRunEpoch: number;
  }): Promise<void> {
    return this.serializeDelivery(async () => {
      this.assertRunEpoch(input.expectedRunEpoch);
      const turnId = this.currentTurnId;
      if (!turnId) return;
      this.expectedInterruptedTurns.add(turnId);
      try {
        await this.client.interruptTurn({
          threadId: this.requireThreadId(),
          turnId,
        });
      } catch (error) {
        this.expectedInterruptedTurns.delete(turnId);
        throw error;
      }
      this.completeInterruptedTurn(turnId);
    });
  }

  captureTurnBoundary(): RuntimeTurnBoundary {
    return {
      runtimeSessionId: this.runtimeSessionId,
      runEpoch: this.runEpoch,
      terminalSequence: this.terminalSequence,
      state: this.currentState,
    };
  }

  captureTurnBoundaryAndHoldPendingInput(
    expectedRunEpoch: number,
  ): RuntimeTurnBoundaryInputHold {
    this.assertRunEpoch(expectedRunEpoch);
    this.pendingInputHolds++;
    let released = false;
    const hold: RuntimeTerminalInputHold = {
      runEpoch: expectedRunEpoch,
      release: (options = {}) => {
        if (released) return;
        released = true;
        this.pendingInputHolds = Math.max(0, this.pendingInputHolds - 1);
        if (
          this.closeAfterInputRelease &&
          this.pendingInputHolds === 0 &&
          this.currentState === "idle"
        ) {
          this.closeAfterInputRelease = false;
          this.currentState = "closed";
          this.output.close();
          void this.client.shutdown();
          return;
        }
        if (
          options.releasePendingIfIdle === true &&
          this.pendingInputHolds === 0 &&
          this.currentState === "idle"
        ) {
          void this.serializeDelivery(() => this.flushPendingBoundary()).catch(
            (error) => this.fail(error),
          );
        }
      },
    };
    return { boundary: this.captureTurnBoundary(), hold };
  }

  waitForTurnTerminal(input: {
    expectedRunEpoch: number;
    afterTerminalSequence: number;
    signal?: AbortSignal;
  }): Promise<RuntimeTurnTerminal> {
    this.assertRunEpoch(input.expectedRunEpoch);
    const existing = this.terminalHistory.find(
      (terminal) =>
        terminal.runEpoch === input.expectedRunEpoch &&
        terminal.terminalSequence > input.afterTerminalSequence,
    );
    if (existing) return Promise.resolve(structuredClone(existing));
    if (this.currentState === "closed" || this.currentState === "failed") {
      return Promise.reject(
        new CodexRuntimeSessionError(
          "closed",
          "Codex Runtime Session cannot reach another terminal boundary",
        ),
      );
    }
    if (input.signal?.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      const waiter: TerminalWaiter = {
        expectedRunEpoch: input.expectedRunEpoch,
        afterTerminalSequence: input.afterTerminalSequence,
        resolve,
        reject,
        ...(input.signal ? { signal: input.signal } : {}),
      };
      if (input.signal) {
        waiter.onAbort = () => {
          if (!this.terminalWaiters.delete(waiter)) return;
          reject(abortError());
        };
        input.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.terminalWaiters.add(waiter);
    });
  }

  advanceRunEpoch(input: { expectedRunEpoch: number; nextRunEpoch: number }): {
    previousRunEpoch: number;
    runEpoch: number;
    discardedInputIds: string[];
  } {
    this.assertRunEpoch(input.expectedRunEpoch);
    if (this.currentTurnId) {
      throw new CodexRuntimeSessionError(
        "invalid_run_epoch",
        "Codex runEpoch can only advance at a turn boundary",
      );
    }
    const next = nonNegativeInteger(input.nextRunEpoch, "nextRunEpoch");
    if (next <= this.runEpoch) {
      throw new CodexRuntimeSessionError(
        "invalid_run_epoch",
        "nextRunEpoch must advance the Runtime Session",
      );
    }
    const previousRunEpoch = this.runEpoch;
    const discardedInputIds = this.pendingBoundary
      .splice(0)
      .map(({ instruction }) => instruction.id);
    this.runEpoch = next;
    return { previousRunEpoch, runEpoch: next, discardedInputIds };
  }

  async close(options: { finalizeBoundGoal?: boolean } = {}): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const turnId =
      options.finalizeBoundGoal === true ? this.currentTurnId : undefined;
    this.closing = true;
    this.closePromise = (async () => {
      this.discardStartupNotifications();
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      try {
        await this.client.shutdown();
        await Promise.allSettled([this.deliveryTail, this.eventTail]);
        await this.eventObserver?.flush();
        const turnContext =
          turnId && this.currentTurnId === turnId
            ? this.captureContext(turnId)
            : null;
        if (turnId && turnContext) {
          await this.goalController?.finalizeWithoutContinuation({
            runEpoch: this.runEpoch,
            evaluationId: `codex-runtime-close:${turnId}`,
            turnContext,
          });
        }
      } finally {
        this.currentTurnId = undefined;
        this.currentState = "closed";
        this.rejectTerminalWaiters(
          new CodexRuntimeSessionError(
            "closed",
            "Codex Runtime Session closed",
          ),
        );
        this.output.close();
      }
    })();
    return this.closePromise;
  }

  private async startTurn(
    content: string,
    pendingInstructions: readonly PendingInstruction[],
  ): Promise<string> {
    if (this.pendingInputHolds > 0 && pendingInstructions.length > 0) {
      throw new Error("Codex pending input is held at a lifecycle boundary");
    }
    const clientUserMessageId = pendingInstructions[0]?.instruction.id;
    if (clientUserMessageId) {
      this.pendingHandoffs.set(clientUserMessageId, {
        pending: pendingInstructions.map((pending) => ({
          instruction: structuredClone(pending.instruction),
          content: pending.content,
        })),
      });
    }
    let started: CodexAppServerTurnStartResult;
    try {
      started = await this.client.startTurn({
        threadId: this.requireThreadId(),
        input: [createCodexAppServerTextInput(content)],
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
      });
    } catch (error) {
      if (clientUserMessageId) this.pendingHandoffs.delete(clientUserMessageId);
      throw error;
    }
    const turnId = identifier(started.turn.id, "turn.id");
    if (clientUserMessageId) {
      const handoff = this.pendingHandoffs.get(clientUserMessageId);
      if (handoff) handoff.turnId = turnId;
    }
    this.currentTurnId = turnId;
    this.currentState = "running";
    for (const { instruction } of pendingInstructions) {
      this.rememberReceipt(instruction.id, "queued", turnId);
    }
    return turnId;
  }

  private withInitialPrompt(content: string): string {
    const initial = this.initialPrompt;
    if (initial === undefined) return content;
    this.initialPrompt = undefined;
    return `${initial}\n\n${content}`;
  }

  private takeInitialPrompt(): string {
    const initial = this.initialPrompt;
    if (initial === undefined) {
      throw new CodexRuntimeSessionError(
        "already_started",
        "Codex initial prompt was already started",
      );
    }
    this.initialPrompt = undefined;
    return initial;
  }

  private async flushPendingBoundary(): Promise<void> {
    if (
      this.pendingInputHolds > 0 ||
      this.currentTurnId ||
      this.pendingBoundary.length === 0 ||
      this.closing
    ) {
      return;
    }
    const pending = this.pendingBoundary.splice(0);
    try {
      const turnId = await this.startTurn(
        pending.map(({ content }) => content).join("\n\n"),
        pending,
      );
      for (const { instruction } of pending) {
        this.rememberReceipt(instruction.id, "queued", turnId);
      }
    } catch (error) {
      this.pendingBoundary.unshift(...pending);
      throw error;
    }
  }

  private async handleNotification(
    notification: CodexAppServerNotification,
  ): Promise<void> {
    if (this.currentState === "closed") return;
    const projection = this.projector.project(notification);
    for (const ack of projection.instructionAcks) {
      await this.acknowledgeInstruction(ack);
    }
    for (const message of projection.messages) {
      if (message.type === "text" && message.content) {
        const turnId = eventTurnId(projection.events);
        if (turnId) this.lastAssistantByTurn.set(turnId, message.content);
      }
      await this.output.publish({ ...message, runEpoch: this.runEpoch });
    }
    for (const event of projection.events) {
      await this.handleProjectedEvent(event);
    }
  }

  private enqueueNotification(notification: CodexAppServerNotification): void {
    const identity = notificationTurnIdentity(notification);
    if (identity?.terminal) this.arrivedTerminalTurns.add(identity.turnId);
    const instructionAck = notificationInstructionAck(notification);
    if (instructionAck) {
      this.arrivedInstructionAcks.set(instructionAck.instructionId, {
        threadId: instructionAck.threadId,
        turnId: instructionAck.turnId,
      });
    }
    const deliveriesAtArrival = this.deliveryTail;
    this.eventTail = this.eventTail
      .then(async () => {
        await deliveriesAtArrival;
        await this.handleNotification(notification);
      })
      .catch((error) => this.fail(error));
  }

  private releaseStartupNotifications(): Promise<void> {
    if (this.notificationMode === "discard") return this.eventTail;
    if (this.notificationMode === "buffering") {
      this.notificationMode = "live";
      for (const notification of this.startupNotifications.splice(0)) {
        this.enqueueNotification(notification);
      }
    }
    return this.eventTail;
  }

  private discardStartupNotifications(): void {
    if (this.notificationMode === "live") return;
    this.notificationMode = "discard";
    this.startupNotifications.length = 0;
  }

  /**
   * Rebuilds only causal journal state from persisted app-server history. Old
   * chat output is deliberately not republished and historical terminals never
   * run live Goal evaluation; the recovery coordinator owns that decision.
   */
  private async rebuildRecoveredObservationContext(
    turns: readonly CodexAppServerPersistedTurn[],
    replayableInstructionIds: ReadonlySet<string>,
    contextInstructionIds: ReadonlySet<string>,
    contextBindings: readonly {
      instructionId: string;
      turnId: string;
      providerEventId: string;
      recordedAt: string;
    }[],
  ): Promise<void> {
    const rebound = new Map<string, string>();
    const knownTurnIds = new Set(turns.map((turn) => turn.id));
    for (const binding of contextBindings) {
      const instructionId = identifier(
        binding.instructionId,
        "recovered binding.instructionId",
      );
      const turnId = identifier(binding.turnId, "recovered binding.turnId");
      if (!knownTurnIds.has(turnId)) {
        throw new CodexRuntimeSessionError(
          "provider_failed",
          `Codex recovery binding references unknown turn ${turnId}`,
        );
      }
      await this.eventObserver?.instructionWritten({
        instructionId,
        threadId: this.requireThreadId(),
        turnId,
        runEpoch: this.runEpoch,
        recordedAt: binding.recordedAt,
        providerEventId: binding.providerEventId,
      });
      rebound.set(instructionId, turnId);
    }
    for (const turn of turns) {
      const turnId = identifier(turn.id, "recovered turn.id");
      for (const item of turn.items) {
        const instructionId =
          item.type === "userMessage" && item.clientId
            ? identifier(item.clientId, "recovered userMessage.clientId")
            : undefined;
        const rebuildContext =
          instructionId !== undefined &&
          (replayableInstructionIds.has(instructionId) ||
            contextInstructionIds.has(instructionId));
        if (instructionId && rebuildContext) {
          const previousTurnId = rebound.get(instructionId);
          if (previousTurnId && previousTurnId !== turnId) {
            throw new CodexRuntimeSessionError(
              "provider_failed",
              `Codex history binds instruction ${instructionId} to multiple turns`,
            );
          }
          if (!previousTurnId) {
            const recordedAt = timestampFromSeconds(turn.startedAt);
            await this.eventObserver?.instructionWritten({
              instructionId,
              threadId: this.requireThreadId(),
              turnId,
              runEpoch: this.runEpoch,
              ...(recordedAt ? { recordedAt } : {}),
              providerEventId: `codex:${this.requireThreadId()}:${turnId}:input:${instructionId}`,
            });
            rebound.set(instructionId, turnId);
            if (replayableInstructionIds.has(instructionId)) {
              this.recoveredSettlements.push({
                instructionId,
                disposition: "accepted",
                recordedAt: recordedAt ?? new Date().toISOString(),
                providerEventId: `codex:${this.requireThreadId()}:${turnId}:input:${instructionId}`,
              });
            }
          }
          continue;
        }

        const projection = this.projector.project({
          method: "item/completed",
          params: {
            threadId: this.requireThreadId(),
            turnId,
            item,
            ...(turn.completedAt === null
              ? {}
              : { completedAtMs: turn.completedAt * 1_000 }),
          },
        });
        for (const event of projection.events) {
          await this.eventObserver?.observeEvent(event, this.runEpoch);
        }
        for (const message of projection.messages) {
          if (message.type === "text" && message.content) {
            this.lastAssistantByTurn.set(turnId, message.content);
          }
        }
      }
      if (
        turn.status === "completed" ||
        turn.status === "failed" ||
        turn.status === "interrupted"
      ) {
        const projection = this.projector.project({
          method: "turn/completed",
          params: {
            threadId: this.requireThreadId(),
            turn: {
              id: turnId,
              status: turn.status,
              completedAt: turn.completedAt,
            },
          },
        });
        for (const event of projection.events) {
          await this.eventObserver?.observeEvent(event, this.runEpoch);
        }
      }
    }
  }

  private async handleProjectedEvent(
    event: CodexNormalizedRuntimeEvent,
  ): Promise<void> {
    if (event.threadId !== this.threadId) return;
    if (event.kind === "item.completed") {
      await this.eventObserver?.observeEvent(event, this.runEpoch);
      return;
    }

    const turnContext = this.captureContext(event.turnId);
    await this.eventObserver?.observeEvent(event, this.runEpoch);
    if (event.turnId !== this.currentTurnId) return;
    this.requeueUnacknowledgedTurn(event.turnId);
    this.arrivedTerminalTurns.delete(event.turnId);
    const expectedInterrupt = this.expectedInterruptedTurns.delete(
      event.turnId,
    );
    this.currentTurnId = undefined;
    this.currentState = "idle";
    this.terminalSequence++;
    const terminal = this.currentTerminal();
    this.terminalHistory.push(terminal);
    if (this.terminalHistory.length > 16) this.terminalHistory.shift();
    this.resolveTerminalWaiters(terminal);
    if (event.usage) {
      this.totalInputTokens += event.usage.inputTokens;
      this.totalOutputTokens += event.usage.outputTokens;
    }

    if (expectedInterrupt && event.status === "interrupted") {
      return;
    }
    if (event.status !== "completed") {
      this.currentState = "failed";
      await this.finalizeAfterProviderFailure(event.turnId, turnContext);
      return;
    }

    // A terminal event is already a valid lifecycle boundary, but keep normal
    // Goal/context input queued until its semantic evaluation has settled.
    // This prevents a new turn from overtaking the continuation decision.
    this.pendingInputHolds++;
    let decision: GoalStopDecision | undefined;
    try {
      decision = await this.goalController?.evaluateStop({
        runEpoch: this.runEpoch,
        assistantTurnId: event.turnId,
        turnContext,
        lastAssistantMessage: this.lastAssistantByTurn.get(event.turnId),
        stopHookActive: false,
      });
    } catch (error) {
      await this.serializeDelivery(async () => {
        this.pendingInputHolds = Math.max(0, this.pendingInputHolds - 1);
      });
      throw error;
    }
    this.lastAssistantByTurn.delete(event.turnId);

    const shouldPublishResult = await this.serializeDelivery(async () => {
      this.pendingInputHolds = Math.max(0, this.pendingInputHolds - 1);
      await this.flushPendingBoundary();
      if (this.currentTurnId || decision?.decision === "block") return false;
      // Fence subsequent deliveries before publishing the terminal result.
      this.currentState = "closed";
      return true;
    });
    if (shouldPublishResult) {
      await this.publishResult(event.turnId);
      this.output.close();
      void this.client.shutdown();
    }
  }

  private async finalizeAfterProviderFailure(
    turnId: string,
    turnContext: RuntimeObservationContext | null,
  ): Promise<void> {
    try {
      if (!this.recoveryOwned) {
        await this.goalController?.finalizeWithoutContinuation({
          runEpoch: this.runEpoch,
          evaluationId: `codex-provider-failure:${turnId}`,
          turnContext,
        });
      }
    } finally {
      await this.output.publish({
        type: "error",
        message: "Codex provider stopped before the Goal completed.",
        messageId: `codex:${turnId}:error`,
        runEpoch: this.runEpoch,
      });
      this.output.close();
      void this.client.shutdown();
    }
  }

  private captureContext(turnId: string): RuntimeObservationContext | null {
    if (!this.threadId) return null;
    return (
      this.eventObserver?.captureTurnContext({
        threadId: this.threadId,
        turnId,
        runEpoch: this.runEpoch,
      }) ?? null
    );
  }

  private async recordInstructionWritten(
    instructionId: string,
    turnId: string,
  ): Promise<void> {
    await this.eventObserver?.instructionWritten({
      instructionId,
      threadId: this.requireThreadId(),
      turnId,
      runEpoch: this.runEpoch,
      providerEventId: `codex:${this.requireThreadId()}:${turnId}:input:${instructionId}`,
    });
  }

  private async acknowledgeInstruction(input: {
    threadId: string;
    turnId: string;
    instructionId: string;
  }): Promise<void> {
    if (input.threadId !== this.threadId) return;
    const pending = this.pendingHandoffs.get(input.instructionId);
    this.arrivedInstructionAcks.delete(input.instructionId);
    if (!pending) return;
    if (pending.turnId !== undefined && pending.turnId !== input.turnId) {
      // A terminal notification can requeue an unacknowledged instruction
      // before the old turn's userMessage acknowledgement arrives. Once the
      // instruction belongs to a newer turn, that late acknowledgement is
      // stale and must not fail the live Runtime Session.
      return;
    }
    for (const { instruction } of pending.pending) {
      const instructionId = instruction.id;
      await this.recordInstructionWritten(instructionId, input.turnId);
      this.rememberReceipt(instructionId, "written_to_sdk", input.turnId);
    }
    this.pendingHandoffs.delete(input.instructionId);
  }

  private matchesArrivedInstructionAck(
    instructionId: string,
    turnId: string,
  ): boolean {
    const ack = this.arrivedInstructionAcks.get(instructionId);
    return ack?.threadId === this.threadId && ack?.turnId === turnId;
  }

  private enqueuePendingBoundary(pending: PendingInstruction): void {
    if (
      this.pendingBoundary.some(
        ({ instruction }) => instruction.id === pending.instruction.id,
      )
    ) {
      return;
    }
    this.pendingBoundary.push(pending);
    this.pendingBoundary.sort(
      (left, right) => left.instruction.sequence - right.instruction.sequence,
    );
  }

  private requeueUnacknowledgedTurn(turnId: string): void {
    for (const [instructionId, handoff] of this.pendingHandoffs) {
      if (handoff.turnId !== turnId) continue;
      this.pendingHandoffs.delete(instructionId);
      this.arrivedInstructionAcks.delete(instructionId);
      for (const pending of handoff.pending) {
        this.enqueuePendingBoundary(pending);
      }
    }
  }

  private rememberReceipt(
    instructionId: string,
    state: "queued" | "written_to_sdk",
    turnId?: string,
  ): RuntimeDeliveryReceipt {
    const receipt: RuntimeDeliveryReceipt = {
      instructionId,
      runtimeSessionId: this.runtimeSessionId,
      state,
      recordedAt: new Date().toISOString(),
      ...(turnId
        ? {
            providerEventId: `codex:${this.requireThreadId()}:${turnId}:input:${instructionId}`,
          }
        : {}),
    };
    this.receipts.set(instructionId, receipt);
    return structuredClone(receipt);
  }

  private async watchExit(): Promise<void> {
    const exit = await this.client.waitForExit();
    if (this.closing) return;
    await this.eventTail;
    if (
      this.closing ||
      this.currentState === "closed" ||
      this.currentState === "failed"
    ) {
      return;
    }
    if (!exit.expected) {
      await this.fail(
        new CodexRuntimeSessionError(
          "provider_failed",
          `Codex app-server exited with code ${exit.exitCode}`,
        ),
      );
      return;
    }
    const turnId = this.currentTurnId;
    if (turnId && this.captureContext(turnId)) {
      await this.fail(
        new CodexRuntimeSessionError(
          "provider_failed",
          "Codex app-server stopped while executing an active Goal",
        ),
      );
      return;
    }
    this.currentTurnId = undefined;
    this.currentState = "closed";
    this.rejectTerminalWaiters(
      new CodexRuntimeSessionError("closed", "Codex Runtime Session closed"),
    );
    this.output.close();
  }

  private async fail(error: unknown): Promise<void> {
    if (
      this.closing ||
      this.currentState === "closed" ||
      this.currentState === "failed"
    ) {
      return;
    }
    const turnId = this.currentTurnId;
    const context = turnId ? this.captureContext(turnId) : null;
    this.currentTurnId = undefined;
    this.currentState = "failed";
    this.rejectTerminalWaiters(
      error instanceof Error
        ? error
        : new CodexRuntimeSessionError(
            "provider_failed",
            "Codex provider stopped unexpectedly",
          ),
    );
    try {
      if (turnId) await this.finalizeAfterProviderFailure(turnId, context);
      else {
        await this.output.publish({
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Codex provider stopped unexpectedly.",
          messageId: `codex:${this.runtimeSessionId}:error`,
          runEpoch: this.runEpoch,
        });
        this.output.close();
      }
    } finally {
      void this.client.shutdown();
    }
  }

  private serializeDelivery<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.deliveryTail.then(operation);
    this.deliveryTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private currentTerminal(): RuntimeTurnTerminal {
    return {
      runtimeSessionId: this.runtimeSessionId,
      runEpoch: this.runEpoch,
      terminalSequence: this.terminalSequence,
      state: "idle",
    };
  }

  private completeInterruptedTurn(turnId: string): void {
    this.expectedInterruptedTurns.delete(turnId);
    if (this.currentTurnId !== turnId) return;
    this.requeueUnacknowledgedTurn(turnId);
    this.arrivedTerminalTurns.delete(turnId);
    this.currentTurnId = undefined;
    this.currentState = "idle";
    this.terminalSequence++;
    const terminal = this.currentTerminal();
    this.terminalHistory.push(terminal);
    if (this.terminalHistory.length > 16) this.terminalHistory.shift();
    this.resolveTerminalWaiters(terminal);
  }

  private resolveTerminalWaiters(terminal: RuntimeTurnTerminal): void {
    for (const waiter of [...this.terminalWaiters]) {
      if (
        waiter.expectedRunEpoch !== terminal.runEpoch ||
        terminal.terminalSequence <= waiter.afterTerminalSequence
      ) {
        continue;
      }
      this.terminalWaiters.delete(waiter);
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(structuredClone(terminal));
    }
  }

  private rejectTerminalWaiters(error: Error): void {
    for (const waiter of this.terminalWaiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(error);
    }
    this.terminalWaiters.clear();
  }

  private async publishResult(turnId: string): Promise<void> {
    if (this.resultPublished) return;
    this.resultPublished = true;
    await this.output.publish({
      type: "result",
      content: "turn.completed",
      messageId: `codex:${this.requireThreadId()}:${turnId}:result`,
      usage: {
        inputTokens: this.totalInputTokens,
        outputTokens: this.totalOutputTokens,
      },
      runEpoch: this.runEpoch,
    });
  }

  private assertRunEpoch(expected: number): void {
    if (this.runEpoch !== nonNegativeInteger(expected, "expectedRunEpoch")) {
      throw new CodexRuntimeSessionError(
        "invalid_run_epoch",
        `Expected runEpoch ${expected}, active epoch is ${this.runEpoch}`,
      );
    }
  }

  private assertOpen(): void {
    if (
      this.closing ||
      this.currentState === "closed" ||
      this.currentState === "failed"
    ) {
      throw new CodexRuntimeSessionError(
        "closed",
        "Codex Runtime Session is not accepting instructions",
      );
    }
  }

  private requireThreadId(): string {
    if (!this.threadId) {
      throw new CodexRuntimeSessionError(
        "not_started",
        "Codex provider thread has not started",
      );
    }
    return this.threadId;
  }
}

function isInterruptInstruction(
  instruction: RuntimeInstruction,
): instruction is Extract<
  RuntimeInstruction,
  { kind: "control.interrupt" | "goal.pause" | "goal.cancel" }
> {
  return (
    instruction.kind === "control.interrupt" ||
    instruction.kind === "goal.pause" ||
    instruction.kind === "goal.cancel"
  );
}

function eventTurnId(
  events: readonly CodexNormalizedRuntimeEvent[],
): string | undefined {
  return events[0]?.turnId;
}

function notificationTurnIdentity(
  notification: CodexAppServerNotification,
): { threadId: string; turnId: string; terminal: boolean } | undefined {
  if (!notification.params || typeof notification.params !== "object") {
    return undefined;
  }
  const params = notification.params as Record<string, unknown>;
  const threadId =
    typeof params.threadId === "string" ? params.threadId : undefined;
  if (!threadId) return undefined;
  if (notification.method === "item/completed") {
    return typeof params.turnId === "string"
      ? { threadId, turnId: params.turnId, terminal: false }
      : undefined;
  }
  if (notification.method !== "turn/completed") return undefined;
  const turn = params.turn;
  if (!turn || typeof turn !== "object") return undefined;
  const turnId = (turn as Record<string, unknown>).id;
  return typeof turnId === "string"
    ? { threadId, turnId, terminal: true }
    : undefined;
}

function notificationInstructionAck(
  notification: CodexAppServerNotification,
): { threadId: string; turnId: string; instructionId: string } | undefined {
  if (
    (notification.method !== "item/started" &&
      notification.method !== "item/completed") ||
    !notification.params ||
    typeof notification.params !== "object"
  ) {
    return undefined;
  }
  const params = notification.params as {
    threadId?: unknown;
    turnId?: unknown;
    item?: unknown;
  };
  if (
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string"
  ) {
    return undefined;
  }
  const item = params.item;
  if (!item || typeof item !== "object") return undefined;
  const candidate = item as { type?: unknown; clientId?: unknown };
  if (
    candidate.type !== "userMessage" ||
    typeof candidate.clientId !== "string"
  ) {
    return undefined;
  }
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    instructionId: candidate.clientId,
  };
}

function isTurnNoLongerSteerable(error: unknown): boolean {
  if (
    !(error instanceof CodexAppServerRpcError) ||
    error.method !== "turn/steer"
  ) {
    return false;
  }
  const details = `${error.message} ${String(error.data ?? "")}`;
  return /\binvalid request\b|no active turn|expected.{0,40}turn.{0,40}(?:mismatch|not found)|turn.{0,80}(?:not active|not found|mismatch|completed|closed|cannot be steered|not steerable)/i.test(
    details,
  );
}

function identifier(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    value !== value.trim()
  ) {
    throw new TypeError(`${name} must be a non-empty identifier`);
  }
  return value;
}

function timestampFromSeconds(value: number | null): string | undefined {
  if (value === null || !Number.isFinite(value) || value < 0) return undefined;
  const timestamp = new Date(value * 1_000);
  return Number.isNaN(timestamp.getTime())
    ? undefined
    : timestamp.toISOString();
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function abortError(): Error {
  const error = new Error("Codex terminal wait aborted");
  error.name = "AbortError";
  return error;
}
