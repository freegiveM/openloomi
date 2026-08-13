import { createHash } from "node:crypto";

import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { assertRuntimeSessionStateTransition } from "@openloomi/ai/agent/runtime-instructions";
import type {
  RuntimeDeliveryReceipt,
  RuntimeInstruction,
  RuntimeRunEpochAdvanceResult,
  RuntimeSessionLifecycleControlPort,
  RuntimeSessionState,
  RuntimeTerminalInputHold,
  RuntimeTurnBoundary,
  RuntimeTurnBoundaryInputHold,
  RuntimeTurnTerminal,
} from "@openloomi/ai/agent/runtime-instructions";
import { AgentOutputEventBus } from "@melandlabs/ai/agent/runtime";
import {
  AgentSupplementalInputQueue,
  SupplementalInputRuntimeInstructionTransport,
  type AgentSupplementalInputHold,
} from "@openloomi/ai/agent/supplemental-input";
import type { AgentMessage } from "@melandlabs/ai/agent";
import type { AgentSupplementalInput, AgentSupplementalInputSource } from "@/lib/ai/agent/types-shim";

import type { ClaudeRuntimeLogger } from "../skills";
import {
  CLAUDE_API_ERROR_SENTINEL,
  isClaudeSdkApiErrorMessage,
} from "../message-converter";
import type {
  ClaudeRuntimeEventObserverPort,
  ClaudeInstructionTurnHandoff,
  ClaudeRuntimeToolOutcome,
  ClaudeRuntimeToolStart,
} from "./event-observer";
import { ClaudeInputMultiplexer } from "./input-multiplexer";
import { ClaudeOutputMultiplexer } from "./output-multiplexer";
import type { ClaudeSdkTransport } from "./sdk-transport";
import type {
  ClaudeRuntimeGoalFinalizationDecision,
  ClaudeRuntimeGoalStopController,
  ClaudeRuntimeStopHookDecision,
  ClaudeRuntimeStopHookInput,
  ClaudeRuntimeStopHookObserver,
} from "./supplemental-hooks";

export interface ClaudeRuntimeSessionOptions {
  runtimeSessionId: string;
  runEpoch: number;
  /** Provider identity loaded from durable state for an exact SDK resume. */
  expectedProviderSessionId?: string;
  sdkTransport: ClaudeSdkTransport;
  logger: ClaudeRuntimeLogger;
  createMessageId: () => string;
  /** Immediately terminates the provider process after a trusted fatal signal. */
  abortProvider?: (reason: Error) => void;
  supplementalInput?: AgentSupplementalInputSource;
}

export type ClaudeProviderFailureSource =
  | "sdk_message"
  | "session_store"
  | "stderr";

interface TerminalWaiter {
  expectedRunEpoch: number;
  afterTerminalSequence: number;
  resolve: (terminal: RuntimeTurnTerminal) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface ProviderSessionInitializationWaiter {
  resolve: (providerSessionId: string) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Owns one Claude SDK Query and exposes an OpenLoomi runtime-session boundary.
 * Goal lifecycle and persistence intentionally remain outside this class.
 */
export class ClaudeRuntimeSession
  implements RuntimeSessionLifecycleControlPort, ClaudeRuntimeStopHookObserver
{
  readonly runtimeSessionId: string;

  private readonly sdkTransport: ClaudeSdkTransport;
  private readonly logger: ClaudeRuntimeLogger;
  private readonly createMessageId: () => string;
  private readonly abortProvider?: (reason: Error) => void;
  private readonly output: AgentOutputEventBus<AgentMessage>;
  private readonly outputMultiplexer: ClaudeOutputMultiplexer;
  private readonly inputQueue: AgentSupplementalInputQueue;
  private readonly instructionTransport: SupplementalInputRuntimeInstructionTransport;
  private readonly externalInput?: AgentSupplementalInputSource;
  private readonly expectedProviderSessionId?: string;

  private query: Query | null = null;
  private outputPump: Promise<void> | null = null;
  private providerFailureSource?: ClaudeProviderFailureSource;
  private providerFailurePublication: Promise<void> | null = null;
  private currentState: RuntimeSessionState = "starting";
  private processedSdkMessages = 0;
  private closing = false;
  private providerOutputEpoch: number;
  private terminalSequence = 0;
  private readonly terminalHistory: RuntimeTurnTerminal[] = [];
  private readonly terminalWaiters = new Set<TerminalWaiter>();
  private eventObserver: ClaudeRuntimeEventObserverPort | null = null;
  private stopController: ClaudeRuntimeGoalStopController | null = null;
  private readonly continuationInstructionIds = new Set<string>();
  private readonly initialTurnInstructionIds = new Set<string>();
  private replayingInitialInstructions = false;
  private expectedProviderInterruptResults = 0;
  private latestAssistantTurnId?: string;
  private assistantTurnSequence = 0;
  private providerSessionInitializationError?: ClaudeRuntimeSessionError;
  private readonly providerSessionInitializationWaiters =
    new Set<ProviderSessionInitializationWaiter>();

  claudeSessionId?: string;

  constructor(options: ClaudeRuntimeSessionOptions) {
    assertRunEpoch(options.runEpoch);
    this.runtimeSessionId = options.runtimeSessionId;
    this.expectedProviderSessionId = options.expectedProviderSessionId
      ? providerSessionIdentifier(options.expectedProviderSessionId)
      : undefined;
    this.providerOutputEpoch = options.runEpoch;
    this.sdkTransport = options.sdkTransport;
    this.logger = options.logger;
    this.createMessageId = options.createMessageId;
    this.abortProvider = options.abortProvider;
    this.output = new AgentOutputEventBus<AgentMessage>();
    this.outputMultiplexer = new ClaudeOutputMultiplexer(
      options.createMessageId,
    );

    if (options.supplementalInput instanceof AgentSupplementalInputQueue) {
      this.inputQueue = options.supplementalInput;
    } else {
      this.inputQueue = new AgentSupplementalInputQueue({
        runEpoch: options.runEpoch,
      });
      this.externalInput = options.supplementalInput;
    }

    this.instructionTransport =
      new SupplementalInputRuntimeInstructionTransport({
        runtimeSessionId: options.runtimeSessionId,
        runEpoch: options.runEpoch,
        queue: this.inputQueue,
      });
  }

  get state(): RuntimeSessionState {
    return this.currentState;
  }

  get runEpoch(): number {
    return this.inputQueue.getRunEpoch();
  }

  get liveInputSource(): AgentSupplementalInputSource {
    return this.inputQueue;
  }

  get sdkMessageCount(): number {
    return this.processedSdkMessages;
  }

  /**
   * Fail the OpenLoomi runtime immediately after an authoritative provider
   * failure. Provider diagnostics are deliberately not accepted here: callers
   * classify the signal and this boundary emits only the stable safe sentinel.
   *
   * Returns true only for the first accepted failure signal.
   */
  reportProviderFailure(source: ClaudeProviderFailureSource): boolean {
    if (
      this.providerFailureSource !== undefined ||
      this.closing ||
      this.currentState === "closed" ||
      this.currentState === "failed"
    ) {
      return false;
    }

    this.providerFailureSource = source;
    const failure = new ClaudeRuntimeSessionError(
      "provider_failed",
      "Claude provider failed",
    );
    this.logger.error(
      `[Claude ${this.runtimeSessionId}] Terminal provider failure (${source})`,
    );
    this.transition("failed");
    this.inputQueue.setInterruptHandler(null);
    this.inputQueue.setHandoffHandler(null);
    this.inputQueue.close();
    this.rejectTerminalWaiters(this.terminalUnavailable("failed"));
    this.rejectProviderSessionInitialization(
      this.providerSessionInitializationUnavailable("failed"),
    );

    // Abort first so the custom Windows spawner terminates the whole process
    // tree. Query.close() remains best-effort and is never awaited.
    try {
      this.abortProvider?.(failure);
    } catch (error) {
      this.logger.warn(
        `[Claude ${this.runtimeSessionId}] Failed to abort provider process`,
        error,
      );
    }
    const query = this.query;
    this.query = null;
    try {
      query?.close();
    } catch (error) {
      this.logger.warn(
        `[Claude ${this.runtimeSessionId}] Failed to close SDK Query after provider failure`,
        error,
      );
    }

    this.providerFailurePublication = this.output
      .publish({
        type: "error",
        message: CLAUDE_API_ERROR_SENTINEL,
        messageId: this.createMessageId(),
        runEpoch: this.providerOutputEpoch,
      })
      .catch((error) => {
        this.logger.warn(
          `[Claude ${this.runtimeSessionId}] Failed to publish provider failure`,
          error,
        );
      })
      .finally(() => this.output.close());
    return true;
  }

  /**
   * Resolves only after the SDK emits system/init for the expected provider
   * session. Recovery coordination uses this barrier before replaying any
   * instruction into the resumed process.
   */
  waitUntilProviderSessionInitialized(
    input: { signal?: AbortSignal } = {},
  ): Promise<string> {
    if (this.claudeSessionId) return Promise.resolve(this.claudeSessionId);
    if (this.providerSessionInitializationError) {
      return Promise.reject(this.providerSessionInitializationError);
    }
    if (input.signal?.aborted) {
      return Promise.reject(this.providerSessionInitializationAborted());
    }
    if (this.currentState === "closed" || this.currentState === "failed") {
      return Promise.reject(
        this.providerSessionInitializationUnavailable(this.currentState),
      );
    }

    return new Promise<string>((resolve, reject) => {
      const waiter: ProviderSessionInitializationWaiter = {
        resolve,
        reject,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      };
      if (input.signal) {
        waiter.onAbort = () => {
          if (!this.providerSessionInitializationWaiters.delete(waiter)) return;
          this.removeProviderSessionWaiterAbortListener(waiter);
          reject(this.providerSessionInitializationAborted());
        };
        input.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.providerSessionInitializationWaiters.add(waiter);
    });
  }

  attachEventObserver(observer: ClaudeRuntimeEventObserverPort): void {
    if (this.query || this.currentState !== "starting") {
      throw new ClaudeRuntimeSessionError(
        "already_started",
        "Claude runtime event observer must be attached before start",
      );
    }
    if (this.eventObserver && this.eventObserver !== observer) {
      throw new ClaudeRuntimeSessionError(
        "observer_already_attached",
        "Claude runtime session already has an event observer",
      );
    }
    this.eventObserver = observer;
  }

  attachGoalStopController(controller: ClaudeRuntimeGoalStopController): void {
    if (this.query || this.currentState !== "starting") {
      throw new ClaudeRuntimeSessionError(
        "already_started",
        "Claude Goal Stop controller must be attached before start",
      );
    }
    if (this.stopController && this.stopController !== controller) {
      throw new ClaudeRuntimeSessionError(
        "stop_controller_already_attached",
        "Claude runtime session already has a Goal Stop controller",
      );
    }
    this.stopController = controller;
  }

  async finalizeGoalWithoutContinuation(
    evaluationId: string,
    runtimeLeaseToken?: string,
  ): Promise<ClaudeRuntimeGoalFinalizationDecision> {
    const controller = this.stopController;
    if (!controller) {
      throw new ClaudeRuntimeSessionError(
        "stop_controller_missing",
        "Claude runtime session has no Goal Stop controller",
      );
    }

    await this.eventObserver?.flush();
    const turnContexts =
      (await this.eventObserver?.captureTurnContexts(this.runEpoch)) ?? [];
    return controller.finalizeWithoutContinuation({
      runEpoch: this.runEpoch,
      evaluationId,
      turnContext: turnContexts.at(-1) ?? null,
      ...(runtimeLeaseToken === undefined ? {} : { runtimeLeaseToken }),
    });
  }

  async evaluateStop(
    input: ClaudeRuntimeStopHookInput,
  ): Promise<ClaudeRuntimeStopHookDecision> {
    const boundProviderSessionId =
      this.claudeSessionId ?? this.expectedProviderSessionId;
    if (
      input.providerSessionId !== undefined &&
      boundProviderSessionId !== undefined &&
      input.providerSessionId !== boundProviderSessionId
    ) {
      throw new ClaudeRuntimeSessionError(
        "provider_session_mismatch",
        `Stop hook belongs to Claude session ${input.providerSessionId}, not ${boundProviderSessionId}`,
      );
    }
    const controller = this.stopController;
    if (!controller) {
      throw new ClaudeRuntimeSessionError(
        "stop_controller_missing",
        "Claude runtime session has no Goal Stop controller",
      );
    }

    const requestedRunEpoch = input.runEpoch ?? this.runEpoch;
    const lastAssistantMessage = input.lastAssistantMessage;
    const assistantTurnId =
      input.assistantTurnId ??
      this.latestAssistantTurnId ??
      this.fallbackAssistantTurnId(lastAssistantMessage);
    if (requestedRunEpoch !== this.runEpoch) {
      return controller.evaluateStop({
        runEpoch: requestedRunEpoch,
        assistantTurnId,
        turnContext: null,
        ...(lastAssistantMessage === undefined ? {} : { lastAssistantMessage }),
        stopHookActive: input.stopHookActive,
      });
    }

    await this.eventObserver?.flush();
    const turnContexts =
      (await this.eventObserver?.captureTurnContexts(requestedRunEpoch)) ?? [];
    const turnContext = turnContexts.at(-1) ?? null;
    if (lastAssistantMessage) {
      await this.recordObservation("record Stop assistant report", (observer) =>
        observer.observeStopAssistantReport({
          assistantTurnId,
          text: lastAssistantMessage,
          ...(input.providerSessionId === undefined
            ? {}
            : { providerSessionId: input.providerSessionId }),
          runEpoch: requestedRunEpoch,
          contexts: turnContexts,
        }),
      );
    }

    if (this.currentState === "running") this.transition("evaluating");
    try {
      const decision = await controller.evaluateStop({
        runEpoch: requestedRunEpoch,
        assistantTurnId,
        turnContext,
        ...(lastAssistantMessage === undefined ? {} : { lastAssistantMessage }),
        stopHookActive: input.stopHookActive,
      });
      if (decision.decision === "block") {
        await this.requireInstructionWritten(
          decision.instruction.id,
          requestedRunEpoch,
          "current_turn",
        );
      }
      if (decision.decision === "block" && this.currentState === "evaluating") {
        this.transition("running");
      }
      return decision;
    } catch (error) {
      if (this.currentState === "evaluating") this.transition("running");
      throw error;
    }
  }

  start(input: {
    initialPrompt: string | AsyncIterable<SDKUserMessage>;
    queryOptions?: Options;
  }): void {
    if (this.query || this.currentState !== "starting") {
      throw new ClaudeRuntimeSessionError(
        "already_started",
        "Claude runtime session can only be started once",
      );
    }

    this.inputQueue.setHandoffHandler((supplementalInput) => {
      const turnHandoff = this.resolveInstructionTurnHandoff(supplementalInput);
      this.observeSupplementalInputHandoff(supplementalInput);
      void this.observeInstructionWritten(
        supplementalInput.id,
        supplementalInput.runEpoch,
        turnHandoff,
      );
    });
    const multiplexer = new ClaudeInputMultiplexer(
      input.initialPrompt,
      this.runtimeSessionId,
      this.inputQueue,
    );
    try {
      this.query = this.sdkTransport.startQuery({
        prompt: multiplexer.toSdkPrompt(),
        options: input.queryOptions,
      });
      this.inputQueue.setInterruptHandler(async () => {
        this.expectedProviderInterruptResults++;
        try {
          await this.query?.interrupt();
        } catch (error) {
          this.expectedProviderInterruptResults = Math.max(
            0,
            this.expectedProviderInterruptResults - 1,
          );
          throw error;
        }
      });
      this.transition("running");
      this.outputPump = this.pumpQuery(this.query);
      if (this.externalInput) {
        void this.pumpExternalInput(this.externalInput);
      }
    } catch (error) {
      try {
        this.query?.close();
      } catch {
        // Preserve the original startup failure.
      }
      this.inputQueue.close();
      this.output.abort(error);
      this.transition("failed");
      this.rejectProviderSessionInitialization(
        this.providerSessionInitializationUnavailable("failed"),
      );
      throw error;
    }
  }

  subscribe(): AsyncIterable<AgentMessage> {
    return this.output.subscribe();
  }

  async replayInitialInstructions<T>(replay: () => Promise<T>): Promise<T> {
    if (this.replayingInitialInstructions) {
      throw new ClaudeRuntimeSessionError(
        "initial_replay_in_progress",
        "Claude runtime session is already replaying initial instructions",
      );
    }
    this.replayingInitialInstructions = true;
    try {
      return await replay();
    } finally {
      this.replayingInitialInstructions = false;
    }
  }

  async deliver(
    instruction: RuntimeInstruction,
  ): Promise<RuntimeDeliveryReceipt> {
    const idle = this.currentState === "idle";
    if (this.replayingInitialInstructions) {
      this.initialTurnInstructionIds.add(instruction.id);
    }
    if (instruction.kind === "goal.continue") {
      this.continuationInstructionIds.add(instruction.id);
    }
    const receipt = await this.instructionTransport.deliver(instruction, {
      interruptControl: !idle,
      interruptSteer: !idle,
    });
    if (receipt.state !== "queued" || !this.query) {
      this.initialTurnInstructionIds.delete(instruction.id);
      this.continuationInstructionIds.delete(instruction.id);
      return receipt;
    }

    if (
      instruction.kind === "control.interrupt" ||
      instruction.kind === "goal.pause" ||
      instruction.kind === "goal.cancel"
    ) {
      await this.observeInstructionWritten(
        instruction.id,
        instruction.payload.expectedRunEpoch,
        "next_turn",
      );
      if (
        this.runEpoch === instruction.payload.expectedRunEpoch &&
        (this.currentState === "running" || this.currentState === "evaluating")
      ) {
        this.transition("interrupted");
      }
      return receipt;
    }

    if (instruction.deliveryMode === "next_boundary" && idle) {
      this.inputQueue.releasePendingInform();
    }
    return receipt;
  }

  async interrupt(
    input: string | { reason: string; expectedRunEpoch: number },
  ): Promise<void> {
    const request =
      typeof input === "string"
        ? { reason: input, expectedRunEpoch: this.runEpoch }
        : input;

    if (!this.query) {
      throw new ClaudeRuntimeSessionError(
        "not_started",
        "Claude runtime session has not started",
      );
    }
    await this.instructionTransport.interrupt(request);
    if (this.runEpoch !== request.expectedRunEpoch) {
      throw new ClaudeRuntimeSessionError(
        "invalid_run_epoch",
        `Run epoch advanced while interrupt ${request.expectedRunEpoch} was in flight`,
      );
    }
    if (this.currentState === "running" || this.currentState === "evaluating") {
      this.transition("interrupted");
    }
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
    assertRunEpoch(expectedRunEpoch);
    if (this.runEpoch !== expectedRunEpoch) {
      throw new ClaudeRuntimeSessionError(
        "invalid_run_epoch",
        `Expected run epoch ${expectedRunEpoch}, active epoch is ${this.runEpoch}`,
      );
    }

    const queueHold =
      this.inputQueue.holdPendingInputForRunEpoch(expectedRunEpoch);
    try {
      const boundary = this.captureTurnBoundary();
      if (boundary.runEpoch !== expectedRunEpoch) {
        throw new ClaudeRuntimeSessionError(
          "invalid_run_epoch",
          `Expected run epoch ${expectedRunEpoch}, active epoch is ${boundary.runEpoch}`,
        );
      }
      return {
        boundary,
        hold: this.createTerminalInputHold(queueHold),
      };
    } catch (error) {
      queueHold.release();
      throw error;
    }
  }

  private createTerminalInputHold(
    hold: AgentSupplementalInputHold,
  ): RuntimeTerminalInputHold {
    return {
      runEpoch: hold.runEpoch,
      release: (options = {}) => {
        hold.release();
        if (
          options.releasePendingIfIdle === true &&
          this.currentState === "idle" &&
          this.runEpoch === hold.runEpoch
        ) {
          this.inputQueue.releasePendingInform();
        }
      },
    };
  }

  waitForTurnTerminal(input: {
    expectedRunEpoch: number;
    afterTerminalSequence: number;
    signal?: AbortSignal;
  }): Promise<RuntimeTurnTerminal> {
    assertRunEpoch(input.expectedRunEpoch);
    if (
      !Number.isInteger(input.afterTerminalSequence) ||
      input.afterTerminalSequence < 0
    ) {
      throw new ClaudeRuntimeSessionError(
        "invalid_terminal_boundary",
        "afterTerminalSequence must be a non-negative integer",
      );
    }
    if (input.signal?.aborted) {
      return Promise.reject(this.terminalWaitAborted());
    }

    const observed = this.terminalHistory.find(
      (terminal) =>
        terminal.runEpoch === input.expectedRunEpoch &&
        terminal.terminalSequence > input.afterTerminalSequence,
    );
    if (observed) return Promise.resolve(structuredClone(observed));

    if (this.runEpoch !== input.expectedRunEpoch) {
      return Promise.reject(
        new ClaudeRuntimeSessionError(
          "invalid_run_epoch",
          `Expected run epoch ${input.expectedRunEpoch}, active epoch is ${this.runEpoch}`,
        ),
      );
    }
    if (this.currentState === "closed" || this.currentState === "failed") {
      return Promise.reject(this.terminalUnavailable(this.currentState));
    }

    return new Promise<RuntimeTurnTerminal>((resolve, reject) => {
      const waiter: TerminalWaiter = {
        expectedRunEpoch: input.expectedRunEpoch,
        afterTerminalSequence: input.afterTerminalSequence,
        resolve,
        reject,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      };
      if (input.signal) {
        waiter.onAbort = () => {
          if (!this.terminalWaiters.delete(waiter)) return;
          this.removeWaiterAbortListener(waiter);
          reject(this.terminalWaitAborted());
        };
        input.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.terminalWaiters.add(waiter);
    });
  }

  advanceRunEpoch(input: {
    expectedRunEpoch: number;
    nextRunEpoch: number;
  }): RuntimeRunEpochAdvanceResult {
    if (this.currentState !== "idle") {
      throw new ClaudeRuntimeSessionError(
        "turn_not_terminal",
        `Cannot advance runEpoch while Runtime Session is ${this.currentState}`,
      );
    }
    const discarded = this.instructionTransport.advanceRunEpoch(input);
    this.latestAssistantTurnId = undefined;
    this.assistantTurnSequence = 0;
    return {
      previousRunEpoch: input.expectedRunEpoch,
      runEpoch: input.nextRunEpoch,
      discardedInputIds: discarded.map((entry) => entry.id),
    };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.stopController = null;
    this.initialTurnInstructionIds.clear();
    this.continuationInstructionIds.clear();

    this.inputQueue.setInterruptHandler(null);
    this.inputQueue.setHandoffHandler(null);
    try {
      this.query?.close();
    } catch (error) {
      this.logger.warn(
        `[Claude ${this.runtimeSessionId}] Failed to close SDK Query`,
        error,
      );
    }
    this.inputQueue.close();
    try {
      this.externalInput?.close?.();
    } catch (error) {
      this.logger.warn(
        `[Claude ${this.runtimeSessionId}] Failed to close external live input`,
        error,
      );
    }
    if (!this.providerFailurePublication) this.output.close();
    this.rejectTerminalWaiters(this.terminalUnavailable("closed"));
    this.rejectProviderSessionInitialization(
      this.providerSessionInitializationUnavailable("closed"),
    );
    if (this.currentState !== "closed" && this.currentState !== "failed") {
      this.transition("closed");
    }

    // SDK iterator cleanup is provider-owned and can remain pending after a
    // broken response stream. Runtime shutdown must not wait indefinitely for
    // Query.return()/next() before releasing durable recovery ownership.
    if (this.providerFailurePublication) {
      await this.providerFailurePublication;
    } else if (this.outputPump) {
      await this.outputPump;
    }
    if (this.eventObserver) {
      try {
        await this.eventObserver.flush();
      } catch (error) {
        this.logger.warn(
          `[Claude ${this.runtimeSessionId}] Failed to flush Goal observations`,
          error,
        );
      }
    }
  }

  private async pumpQuery(query: Query): Promise<void> {
    let failed = false;
    const iterator = query[Symbol.asyncIterator]();
    try {
      while (true) {
        const result = await iterator.next();
        if (result.done) break;
        const message = result.value;
        const observedRunEpoch = this.providerOutputEpoch;
        const terminalApiError = isClaudeSdkApiErrorMessage(message);
        const expectedInterruptResult =
          this.consumeExpectedProviderInterruptResult(message);
        this.processedSdkMessages++;
        if (!terminalApiError) {
          this.updateSessionFromSdkMessage(message, observedRunEpoch);
          await this.recordProviderObservation(message, observedRunEpoch);
        }
        if (terminalApiError) {
          failed = true;
          this.reportProviderFailure("sdk_message");
          // Do not break out of a for-await loop here. AsyncIteratorClose would
          // await Query.return(), which some failed provider streams never
          // settle. The explicit iterator can be abandoned after process abort.
          return;
        }
        if (!expectedInterruptResult) {
          for (const agentMessage of this.outputMultiplexer.convert(message)) {
            await this.output.publish({
              ...agentMessage,
              runEpoch: observedRunEpoch,
            });
          }
        }
        if (message.type === "result") {
          if (observedRunEpoch === this.runEpoch) {
            this.inputQueue.releasePendingInform();
            if (
              this.currentState !== "idle" &&
              this.currentState !== "closed" &&
              this.currentState !== "failed"
            ) {
              this.transition("idle");
            }
          }
          this.recordTerminal(observedRunEpoch);
        }
      }
      if (!this.providerFailureSource) this.output.close();
    } catch (error) {
      // Session-initialization failures reject their registration barrier
      // before reaching this catch. Give that owner one microtask to close the
      // runtime, preserving the established closed-vs-failed lifecycle race
      // without invoking (or awaiting) the provider iterator's return().
      await Promise.resolve();
      if (!this.closing && !this.providerFailureSource) {
        failed = true;
        this.output.abort(error);
      }
    } finally {
      this.inputQueue.close();
      this.rejectProviderSessionInitialization(
        this.providerSessionInitializationUnavailable(
          failed ? "failed" : "closed",
        ),
      );
      this.rejectTerminalWaiters(
        this.terminalUnavailable(failed ? "failed" : "closed"),
      );
      if (
        !this.closing &&
        this.currentState !== "closed" &&
        this.currentState !== "failed"
      ) {
        this.transition(failed ? "failed" : "closed");
      }
    }
  }

  private async pumpExternalInput(
    source: AgentSupplementalInputSource,
  ): Promise<void> {
    try {
      for await (const input of source) {
        await this.inputQueue.enqueue({
          ...input,
          runEpoch: input.runEpoch ?? this.runEpoch,
        });
      }
    } catch (error) {
      if (!this.closing) {
        this.logger.warn(
          `[Claude ${this.runtimeSessionId}] External live input stopped unexpectedly`,
          error,
        );
      }
    }
  }

  private updateSessionFromSdkMessage(
    message: SDKMessage,
    observedRunEpoch: number,
  ): void {
    if (message.type === "system" && message.subtype === "init") {
      const providerSessionId = providerSessionIdentifier(message.session_id);
      const expected = this.expectedProviderSessionId;
      const existing = this.claudeSessionId;
      if (
        (expected !== undefined && providerSessionId !== expected) ||
        (existing !== undefined && providerSessionId !== existing)
      ) {
        const mismatch = new ClaudeRuntimeSessionError(
          "provider_session_mismatch",
          `Claude initialized provider session ${providerSessionId}, expected ${expected ?? existing}`,
        );
        this.rejectProviderSessionInitialization(mismatch);
        throw mismatch;
      }
      this.claudeSessionId = providerSessionId;
      this.resolveProviderSessionInitialization(providerSessionId);
    }
    if (message.type === "assistant" && observedRunEpoch === this.runEpoch) {
      this.latestAssistantTurnId =
        sdkMessageUuid(message) ??
        this.fallbackAssistantTurnId(assistantMessageText(message));
    }
    if (
      observedRunEpoch === this.runEpoch &&
      message.type !== "result" &&
      (this.currentState === "idle" ||
        this.currentState === "evaluating" ||
        this.currentState === "interrupted")
    ) {
      this.transition("running");
    }
  }

  private consumeExpectedProviderInterruptResult(message: SDKMessage): boolean {
    if (this.expectedProviderInterruptResults === 0) return false;
    if (message.type !== "result") return false;
    this.expectedProviderInterruptResults--;
    return (
      message.subtype === "error_during_execution" &&
      (message.terminal_reason === "aborted_streaming" ||
        message.terminal_reason === "aborted_tools" ||
        message.errors.some((error) => /\brequest\b.*\baborted\b/i.test(error)))
    );
  }

  private observeSupplementalInputHandoff(input: AgentSupplementalInput): void {
    const inputRunEpoch = input.runEpoch ?? this.runEpoch;
    if (
      inputRunEpoch !== this.runEpoch ||
      this.currentState === "closed" ||
      this.currentState === "failed"
    ) {
      return;
    }

    this.providerOutputEpoch = inputRunEpoch;
    if (
      this.currentState === "starting" ||
      this.currentState === "idle" ||
      this.currentState === "evaluating" ||
      this.currentState === "interrupted"
    ) {
      this.transition("running");
    }
  }

  async captureToolStart(
    input: Omit<ClaudeRuntimeToolStart, "runEpoch">,
  ): Promise<void> {
    if (!this.eventObserver) return;
    await this.eventObserver.captureToolStart({
      ...input,
      runEpoch: this.providerOutputEpoch,
    });
  }

  async observeToolOutcome(
    input: Omit<ClaudeRuntimeToolOutcome, "runEpoch">,
  ): Promise<void> {
    if (!this.eventObserver) return;
    await this.eventObserver.observeToolOutcome({
      ...input,
      runEpoch: this.providerOutputEpoch,
    });
  }

  private async observeInstructionWritten(
    instructionId: string,
    runEpoch: number,
    turnHandoff: ClaudeInstructionTurnHandoff,
  ): Promise<void> {
    await this.recordObservation("record SDK instruction handoff", (observer) =>
      observer.instructionWritten({
        instructionId,
        runEpoch,
        turnHandoff,
        recordedAt: new Date().toISOString(),
      }),
    );
  }

  private async requireInstructionWritten(
    instructionId: string,
    runEpoch: number,
    turnHandoff: ClaudeInstructionTurnHandoff,
  ): Promise<void> {
    const observer = this.eventObserver;
    if (!observer) {
      throw new ClaudeRuntimeSessionError(
        "instruction_handoff_failed",
        "Claude Goal continuation requires a runtime event observer",
      );
    }
    try {
      await observer.instructionWritten({
        instructionId,
        runEpoch,
        turnHandoff,
        recordedAt: new Date().toISOString(),
      });
    } catch (cause) {
      throw new ClaudeRuntimeSessionError(
        "instruction_handoff_failed",
        `Failed to register Claude Goal continuation ${instructionId}: ${errorMessage(cause)}`,
      );
    }
  }

  private resolveInstructionTurnHandoff(
    input: AgentSupplementalInput,
  ): ClaudeInstructionTurnHandoff {
    const isInitialReplay = this.initialTurnInstructionIds.delete(input.id);
    const isContinuation = this.continuationInstructionIds.delete(input.id);
    return input.intent === "inform" ||
      this.currentState === "idle" ||
      isInitialReplay ||
      isContinuation
      ? "current_turn"
      : "next_turn";
  }

  private async recordProviderObservation(
    message: SDKMessage,
    runEpoch: number,
  ): Promise<void> {
    await this.recordObservation("record SDK event", (observer) =>
      observer.observeSdkMessage(message, runEpoch),
    );
  }

  private async recordObservation(
    operation: string,
    record: (observer: ClaudeRuntimeEventObserverPort) => Promise<void>,
  ): Promise<void> {
    const observer = this.eventObserver;
    if (!observer) return;
    try {
      await record(observer);
    } catch (error) {
      this.logger.warn(
        `[Claude ${this.runtimeSessionId}] Failed to ${operation}`,
        error,
      );
    }
  }

  private recordTerminal(runEpoch: number): void {
    const terminal: RuntimeTurnTerminal = {
      runtimeSessionId: this.runtimeSessionId,
      runEpoch,
      terminalSequence: ++this.terminalSequence,
      state: "idle",
    };
    this.terminalHistory.push(terminal);
    if (this.terminalHistory.length > 64) this.terminalHistory.shift();

    for (const waiter of [...this.terminalWaiters]) {
      if (
        waiter.expectedRunEpoch !== runEpoch ||
        waiter.afterTerminalSequence >= terminal.terminalSequence
      ) {
        continue;
      }
      this.terminalWaiters.delete(waiter);
      this.removeWaiterAbortListener(waiter);
      waiter.resolve(structuredClone(terminal));
    }
  }

  private rejectTerminalWaiters(error: Error): void {
    for (const waiter of this.terminalWaiters) {
      this.removeWaiterAbortListener(waiter);
      waiter.reject(error);
    }
    this.terminalWaiters.clear();
  }

  private resolveProviderSessionInitialization(
    providerSessionId: string,
  ): void {
    for (const waiter of this.providerSessionInitializationWaiters) {
      this.removeProviderSessionWaiterAbortListener(waiter);
      waiter.resolve(providerSessionId);
    }
    this.providerSessionInitializationWaiters.clear();
  }

  private rejectProviderSessionInitialization(
    error: ClaudeRuntimeSessionError,
  ): void {
    if (this.claudeSessionId) return;
    this.providerSessionInitializationError ??= error;
    for (const waiter of this.providerSessionInitializationWaiters) {
      this.removeProviderSessionWaiterAbortListener(waiter);
      waiter.reject(this.providerSessionInitializationError);
    }
    this.providerSessionInitializationWaiters.clear();
  }

  private removeProviderSessionWaiterAbortListener(
    waiter: ProviderSessionInitializationWaiter,
  ): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  private providerSessionInitializationAborted(): ClaudeRuntimeSessionError {
    return new ClaudeRuntimeSessionError(
      "provider_session_initialization_aborted",
      "Waiting for the Claude provider session initialization was aborted",
    );
  }

  private providerSessionInitializationUnavailable(
    state: "closed" | "failed",
  ): ClaudeRuntimeSessionError {
    return new ClaudeRuntimeSessionError(
      "provider_session_initialization_unavailable",
      `Claude Runtime Session became ${state} before provider initialization was confirmed`,
    );
  }

  private removeWaiterAbortListener(waiter: TerminalWaiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  private terminalWaitAborted(): ClaudeRuntimeSessionError {
    return new ClaudeRuntimeSessionError(
      "terminal_wait_aborted",
      "Waiting for the Claude turn terminal boundary was aborted",
    );
  }

  private terminalUnavailable(
    state: "closed" | "failed",
  ): ClaudeRuntimeSessionError {
    return new ClaudeRuntimeSessionError(
      "terminal_unavailable",
      `Claude Runtime Session became ${state} before the turn terminal boundary was observed`,
    );
  }

  private fallbackAssistantTurnId(lastAssistantMessage?: string): string {
    const sequence = ++this.assistantTurnSequence;
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.runtimeSessionId,
          this.runEpoch,
          sequence,
          lastAssistantMessage ?? "",
        ]),
      )
      .digest("hex");
  }

  private transition(next: RuntimeSessionState): void {
    if (this.currentState === next) return;
    assertRuntimeSessionStateTransition(this.currentState, next);
    this.currentState = next;
  }
}

export type ClaudeRuntimeSessionErrorCode =
  | "already_started"
  | "initial_replay_in_progress"
  | "instruction_handoff_failed"
  | "invalid_terminal_boundary"
  | "invalid_run_epoch"
  | "not_started"
  | "observer_already_attached"
  | "provider_session_mismatch"
  | "provider_failed"
  | "provider_session_initialization_aborted"
  | "provider_session_initialization_unavailable"
  | "stop_controller_already_attached"
  | "stop_controller_missing"
  | "terminal_unavailable"
  | "terminal_wait_aborted"
  | "turn_not_terminal";

export class ClaudeRuntimeSessionError extends Error {
  constructor(
    public readonly code: ClaudeRuntimeSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClaudeRuntimeSessionError";
  }
}

function sdkMessageUuid(message: SDKMessage): string | undefined {
  const uuid = (message as SDKMessage & { uuid?: unknown }).uuid;
  return typeof uuid === "string" && uuid.length > 0 && uuid.length <= 256
    ? uuid
    : undefined;
}

function assistantMessageText(message: SDKMessage): string {
  if (message.type !== "assistant") return "";
  const content = (message as SDKMessage & { message?: { content?: unknown } })
    .message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : [],
    )
    .join("\n")
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertRunEpoch(runEpoch: number): void {
  if (!Number.isInteger(runEpoch) || runEpoch < 0) {
    throw new ClaudeRuntimeSessionError(
      "invalid_run_epoch",
      "runEpoch must be a non-negative integer",
    );
  }
}

function providerSessionIdentifier(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim()
  ) {
    throw new ClaudeRuntimeSessionError(
      "provider_session_mismatch",
      "Claude provider session ID must be a non-empty identifier",
    );
  }
  return value;
}
