import { createHash, randomUUID } from "node:crypto";

import {
  GoalEvaluationResultSchema,
  GoalEvidenceSchema,
  RuntimeInstructionSchema,
  assertDeliveryStateTransition,
  assertGoalRunStatusTransition,
  canonicalJson,
  type AgentGoalRun,
  type DeliveryState,
  type GoalEvaluationResult,
  type GoalRunStatus,
  type RuntimeClockPort,
  type RuntimeDeliveryReceipt,
  type RuntimeIdGeneratorPort,
  type RuntimeInstruction,
} from "@openloomi/ai/agent/runtime-instructions";

import { KeyedSerialExecutor } from "../../keyed-serial-executor";
import type {
  RuntimeGoalEvaluationOutcome,
  RuntimeGoalEvaluationSnapshot,
  RuntimeObservationContext,
  RuntimeObservationJournalPort,
  RuntimeObservationLeaseRegistration,
  RuntimeProviderEventObservation,
} from "../../runtime-observation";
import { resolveGoalEvidenceRevisionFloor } from "../../runtime-observation";
import type { RuntimeSessionPersistencePort } from "../../runtime-session-persistence";
import { persistenceConflict } from "../errors";
import type { PersistedRuntimeInstructionDelivery } from "../runtime-observation-mappers";
import {
  resolveSqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabaseSource,
} from "./database";
import type { SqliteGoalRuntimeStore } from "./store";

interface EvaluationLease {
  goalId: string;
  goalRevision: number;
  runEpoch: number;
  runId: string;
  phase: "evaluating" | "finished" | "abandoned";
}

interface AttachedRuntimeLease {
  readonly leaseToken: string;
  readonly registrations: Set<symbol>;
}

export class SqliteRuntimeObservationJournal implements RuntimeObservationJournalPort {
  private readonly database: SqliteGoalRuntimeDatabase;
  private readonly serial = new KeyedSerialExecutor();
  private readonly evaluations = new Map<string, EvaluationLease>();
  private readonly runtimeLeases = new Map<string, AttachedRuntimeLease>();

  constructor(
    source: SqliteGoalRuntimeDatabaseSource,
    private readonly runtimeSessions: RuntimeSessionPersistencePort,
    private readonly clock: RuntimeClockPort = { now: () => new Date() },
    private readonly ids: RuntimeIdGeneratorPort = { generate: randomUUID },
  ) {
    this.database = resolveSqliteGoalRuntimeDatabase(source);
  }

  attachRuntimeLease(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseToken: string;
  }): RuntimeObservationLeaseRegistration {
    const ownerId = identifier(input.ownerId, "ownerId");
    const runtimeSessionId = identifier(
      input.runtimeSessionId,
      "runtimeSessionId",
    );
    const leaseToken = identifier(input.leaseToken, "leaseToken");
    const key = scope(ownerId, runtimeSessionId);
    const existing = this.runtimeLeases.get(key);
    if (existing && existing.leaseToken !== leaseToken) {
      throw persistenceConflict(
        `Runtime Session ${runtimeSessionId} already has a different local ownership fence`,
      );
    }
    const registration = Symbol(runtimeSessionId);
    const attached =
      existing ??
      ({
        leaseToken,
        registrations: new Set<symbol>(),
      } satisfies AttachedRuntimeLease);
    attached.registrations.add(registration);
    this.runtimeLeases.set(key, attached);

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const current = this.runtimeLeases.get(key);
        if (current !== attached) return;
        current.registrations.delete(registration);
        if (current.registrations.size === 0) this.runtimeLeases.delete(key);
      },
    };
  }

  async prepareDelivery(input: {
    ownerId: string;
    instruction: RuntimeInstruction;
  }): Promise<void> {
    const instruction = RuntimeInstructionSchema.parse(input.instruction);
    const ownerId = identifier(input.ownerId, "ownerId");
    await this.serial.run(scope(ownerId, instruction.targetSessionId), () => {
      this.withRuntimeLease(ownerId, instruction.targetSessionId, (store) => {
        const stored = requireCanonicalInstruction(store, ownerId, instruction);
        requireCurrentEpoch(
          store,
          ownerId,
          instruction.targetSessionId,
          stored.runEpoch,
        );
        let delivery = store.getActiveDeliveryForInstruction(
          ownerId,
          instruction.targetSessionId,
          instruction.id,
        );
        if (!delivery) {
          const attempts = store.listDeliveryAttempts(
            ownerId,
            instruction.targetSessionId,
            instruction.id,
          );
          const previous = attempts.at(-1);
          if (
            previous &&
            previous.state !== "rejected" &&
            previous.state !== "failed" &&
            previous.state !== "expired"
          ) {
            return;
          }
          const now = this.now();
          store.insertPendingDelivery({
            id: this.ids.generate(),
            ownerId,
            runtimeSessionId: instruction.targetSessionId,
            instructionId: instruction.id,
            ...(previous?.goalRunId === undefined
              ? {}
              : { goalRunId: previous.goalRunId }),
            runEpoch: stored.runEpoch,
            attempt: (previous?.attempt ?? 0) + 1,
            availableAt: now,
            recordedAt: now,
          });
          delivery = store.getActiveDeliveryForInstruction(
            ownerId,
            instruction.targetSessionId,
            instruction.id,
          );
        }
        if (!delivery || delivery.state !== "pending") return;
        transitionDelivery(store, delivery, "leased", this.now(), {
          leaseToken: this.ids.generate(),
          leaseOwner: "claude-runtime",
          leaseExpiresAt: new Date(
            this.clock.now().getTime() + 60_000,
          ).toISOString(),
        });
      });
    });
  }

  async recordDeliveryReceipt(input: {
    ownerId: string;
    instruction: RuntimeInstruction;
    receipt: RuntimeDeliveryReceipt;
  }): Promise<void> {
    const instruction = RuntimeInstructionSchema.parse(input.instruction);
    const ownerId = identifier(input.ownerId, "ownerId");
    const receipt = parseReceipt(input.receipt, instruction);
    await this.serial.run(scope(ownerId, instruction.targetSessionId), () => {
      this.withRuntimeLease(ownerId, instruction.targetSessionId, (store) => {
        const canonical = requireCanonicalInstruction(
          store,
          ownerId,
          instruction,
        );
        requireCurrentEpoch(
          store,
          ownerId,
          instruction.targetSessionId,
          canonical.runEpoch,
        );
        let delivery = store.getActiveDeliveryForInstruction(
          ownerId,
          instruction.targetSessionId,
          instruction.id,
        );
        if (!delivery) {
          throw persistenceConflict(
            `Instruction ${instruction.id} has no prepared Delivery`,
          );
        }
        if (isSettledForReceipt(delivery.state, receipt.state)) return;
        if (delivery.state === "pending") {
          delivery = transitionDelivery(
            store,
            delivery,
            "leased",
            receipt.recordedAt,
            {
              leaseToken: this.ids.generate(),
              leaseOwner: "claude-runtime",
              leaseExpiresAt: new Date(
                Date.parse(receipt.recordedAt) + 60_000,
              ).toISOString(),
            },
          );
        }
        if (delivery.state === "leased") {
          delivery = transitionDelivery(
            store,
            delivery,
            "queued",
            receipt.recordedAt,
          );
        }
        if (receipt.state === "rejected") {
          if (
            delivery.state !== "queued" &&
            delivery.state !== "written_to_sdk" &&
            delivery.state !== "observed"
          ) {
            throw persistenceConflict(
              `Delivery ${delivery.id} cannot be rejected from ${delivery.state}`,
            );
          }
          transitionDelivery(store, delivery, "rejected", receipt.recordedAt, {
            providerEventId: receipt.providerEventId,
            errorCode: "transport_rejected",
            errorMessage: receipt.reason,
          });
          return;
        }
        if (receipt.state === "written_to_sdk" && delivery.state === "queued") {
          delivery = transitionDelivery(
            store,
            delivery,
            "written_to_sdk",
            receipt.recordedAt,
            {
              providerEventId: receipt.providerEventId,
            },
          );
          markRunHandoff(store, delivery, instruction, receipt.recordedAt);
        }
      });
    });
  }

  async recordInstructionHandoff(input: {
    ownerId: string;
    runtimeSessionId: string;
    instructionId: string;
    runEpoch: number;
    recordedAt?: string;
  }): Promise<boolean> {
    const ownerId = identifier(input.ownerId, "ownerId");
    const runtimeSessionId = identifier(
      input.runtimeSessionId,
      "runtimeSessionId",
    );
    const instructionId = identifier(input.instructionId, "instructionId");
    return this.serial.run(scope(ownerId, runtimeSessionId), () =>
      this.withRuntimeLease(ownerId, runtimeSessionId, (store) => {
        const session = store.getSession(ownerId, runtimeSessionId);
        if (!session || session.runEpoch !== input.runEpoch) return false;
        const stored = store.getInstruction(
          ownerId,
          runtimeSessionId,
          instructionId,
        );
        const delivery = store.getActiveDeliveryForInstruction(
          ownerId,
          runtimeSessionId,
          instructionId,
        );
        if (!stored || stored.runEpoch !== input.runEpoch || !delivery)
          return false;
        let written = delivery;
        const recordedAt = input.recordedAt ?? this.now();
        if (written.state === "pending") {
          written = transitionDelivery(store, written, "leased", recordedAt, {
            leaseToken: this.ids.generate(),
            leaseOwner: "claude-runtime",
            leaseExpiresAt: new Date(
              Date.parse(recordedAt) + 60_000,
            ).toISOString(),
          });
        }
        if (written.state === "leased") {
          written = transitionDelivery(store, written, "queued", recordedAt);
        }
        if (written.state === "queued") {
          written = transitionDelivery(
            store,
            written,
            "written_to_sdk",
            recordedAt,
          );
        }
        if (!isProviderVisible(written.state)) return false;
        markRunHandoff(store, written, stored.instruction, recordedAt);
        return true;
      }),
    );
  }

  async setProviderSession(input: {
    ownerId: string;
    runtimeSessionId: string;
    providerSessionId: string;
    runEpoch?: number;
  }): Promise<void> {
    await this.serial.run(
      scope(input.ownerId, input.runtimeSessionId),
      async () => {
        // Persist the resume handle at SDK initialization, even when this is
        // still an ordinary chat. A Goal can be injected later, and a crash
        // between its first handoff and the next Claude event must not leave
        // that durable Goal without the provider session it belongs to.
        await this.runtimeSessions.bindProviderSession({
          ownerId: input.ownerId,
          runtimeSessionId: input.runtimeSessionId,
          providerSessionId: input.providerSessionId,
          ...this.runtimeLeaseFence(
            input.ownerId,
            input.runtimeSessionId,
            input.runEpoch,
          ),
        });
        const activeRunId = this.withRuntimeLease(
          input.ownerId,
          input.runtimeSessionId,
          (store) => {
            const session = store.getSession(
              input.ownerId,
              input.runtimeSessionId,
            );
            const active = store.getAssignedPrimaryGoal(
              input.ownerId,
              input.runtimeSessionId,
            );
            if (!session || active?.persistedGoal.goal.status !== "active")
              return null;
            return (
              store.findRun(
                input.ownerId,
                input.runtimeSessionId,
                active.persistedGoal.goal.id,
                session.runEpoch,
              )?.id ?? null
            );
          },
        );
        if (!activeRunId) return;
        const at = this.now();
        this.withRuntimeLease(
          input.ownerId,
          input.runtimeSessionId,
          (store) => {
            const run = store.getRun(
              input.ownerId,
              input.runtimeSessionId,
              activeRunId,
            );
            const active = store.getAssignedPrimaryGoal(
              input.ownerId,
              input.runtimeSessionId,
            );
            if (
              !run ||
              isTerminalRun(run.status) ||
              active?.persistedGoal.goal.id !== run.goalId
            ) {
              return false;
            }
            return store.updateRun(
              run,
              { ...run, providerSessionId: input.providerSessionId },
              at,
            );
          },
        );
        // Session ownership is released by ClaudeGoalRuntimeRegistration when
        // the Query ends. A concurrent Goal transition here is not proof that
        // the live provider handle should be cleared.
      },
    );
  }

  async captureContext(input: {
    ownerId: string;
    runtimeSessionId: string;
    runEpoch: number;
    instructionId?: string;
  }): Promise<RuntimeObservationContext | null> {
    return this.serial.run(scope(input.ownerId, input.runtimeSessionId), () =>
      this.database.immediate((store) => {
        const session = store.getSession(input.ownerId, input.runtimeSessionId);
        return session?.runEpoch === input.runEpoch
          ? latestContext(
              store,
              input.ownerId,
              input.runtimeSessionId,
              input.runEpoch,
              input.instructionId,
            )
          : null;
      }),
    );
  }

  async observeProviderEvent(
    input: RuntimeProviderEventObservation,
  ): Promise<boolean> {
    const parsed = parseObservation(input);
    const eventFingerprint = providerEventFingerprint(parsed);
    return this.serial.run(
      scope(parsed.ownerId, parsed.runtimeSessionId),
      async () => {
        const preflightContext = this.withRuntimeLease(
          parsed.ownerId,
          parsed.runtimeSessionId,
          (store) => {
            const existing = store.getProviderEventReceipt(
              parsed.ownerId,
              parsed.runtimeSessionId,
              parsed.runEpoch,
              parsed.eventKey,
            );
            if (existing) {
              assertSameProviderEvent(existing, parsed, eventFingerprint);
              return "duplicate" as const;
            }
            const session = store.getSession(
              parsed.ownerId,
              parsed.runtimeSessionId,
            );
            if (!session || session.runEpoch !== parsed.runEpoch) return null;
            return parsed.context
              ? validateContext(
                  store,
                  parsed.context,
                  parsed.runEpoch,
                  parsed.terminal === true,
                )
              : latestContext(
                  store,
                  parsed.ownerId,
                  parsed.runtimeSessionId,
                  parsed.runEpoch,
                );
          },
        );
        if (preflightContext === "duplicate") return false;
        if (!preflightContext) return false;
        if (parsed.providerSessionId) {
          await this.runtimeSessions.bindProviderSession({
            ownerId: parsed.ownerId,
            runtimeSessionId: parsed.runtimeSessionId,
            providerSessionId: parsed.providerSessionId,
            ...this.runtimeLeaseFence(
              parsed.ownerId,
              parsed.runtimeSessionId,
              parsed.runEpoch,
            ),
          });
        }
        const accepted = this.withRuntimeLease(
          parsed.ownerId,
          parsed.runtimeSessionId,
          (store) => {
            const existing = store.getProviderEventReceipt(
              parsed.ownerId,
              parsed.runtimeSessionId,
              parsed.runEpoch,
              parsed.eventKey,
            );
            if (existing) {
              assertSameProviderEvent(existing, parsed, eventFingerprint);
              return false;
            }
            const session = store.getSession(
              parsed.ownerId,
              parsed.runtimeSessionId,
            );
            if (!session || session.runEpoch !== parsed.runEpoch) return false;
            const context = parsed.context
              ? validateContext(
                  store,
                  parsed.context,
                  parsed.runEpoch,
                  parsed.terminal === true,
                )
              : latestContext(
                  store,
                  parsed.ownerId,
                  parsed.runtimeSessionId,
                  parsed.runEpoch,
                );
            if (!context) return false;
            if (
              !store.insertProviderEventReceipt({
                ownerId: parsed.ownerId,
                runtimeSessionId: parsed.runtimeSessionId,
                runEpoch: parsed.runEpoch,
                eventKey: parsed.eventKey,
                providerEventId: parsed.providerEventId,
                ...(parsed.providerSessionId === undefined
                  ? {}
                  : { providerSessionId: parsed.providerSessionId }),
                eventFingerprint,
                observedAtSeconds: Math.floor(
                  Date.parse(parsed.observedAt) / 1_000,
                ),
                createdAtSeconds: Math.floor(
                  this.clock.now().getTime() / 1_000,
                ),
              })
            ) {
              const raced = store.getProviderEventReceipt(
                parsed.ownerId,
                parsed.runtimeSessionId,
                parsed.runEpoch,
                parsed.eventKey,
              );
              if (!raced) {
                throw persistenceConflict(
                  `Provider event ${parsed.eventKey} could not be recorded`,
                );
              }
              assertSameProviderEvent(raced, parsed, eventFingerprint);
              return false;
            }
            const deliveryContexts = acknowledgedContexts(
              store,
              context,
              parsed.acknowledgedContexts,
              parsed.runEpoch,
              parsed.terminal === true,
            );
            for (const acknowledged of deliveryContexts) {
              const instruction = store.getInstruction(
                parsed.ownerId,
                parsed.runtimeSessionId,
                acknowledged.instructionId,
              )?.instruction;
              let delivery = store.getActiveDeliveryForInstruction(
                parsed.ownerId,
                parsed.runtimeSessionId,
                acknowledged.instructionId,
              );
              if (!delivery || !instruction || isControl(instruction)) continue;
              if (delivery.state === "written_to_sdk") {
                delivery = transitionDelivery(
                  store,
                  delivery,
                  "observed",
                  parsed.observedAt,
                  {
                    providerEventId:
                      retainedProviderInputEventId(delivery.providerEventId) ??
                      parsed.providerEventId,
                  },
                );
              }
              if (parsed.terminal && delivery.state === "observed") {
                transitionDelivery(
                  store,
                  delivery,
                  "applied",
                  parsed.observedAt,
                  {
                    providerEventId:
                      retainedProviderInputEventId(delivery.providerEventId) ??
                      parsed.providerEventId,
                  },
                );
              }
            }
            const run = store.getRun(
              parsed.ownerId,
              parsed.runtimeSessionId,
              context.goalRunId,
            );
            if (!run || isTerminalRun(run.status)) return true;
            const nextStatus =
              run.status === "queued" || run.status === "continuing"
                ? "running"
                : run.status;
            const turnsUsed = run.turnsUsed + (parsed.usage?.turnsUsed ?? 0);
            const tokensUsed = run.tokensUsed + (parsed.usage?.tokensUsed ?? 0);
            if (
              !Number.isSafeInteger(turnsUsed) ||
              !Number.isSafeInteger(tokensUsed)
            ) {
              throw persistenceConflict(
                "Provider usage exceeds the supported counter range",
              );
            }
            const nextRun: AgentGoalRun = {
              ...run,
              status: nextStatus,
              turnsUsed,
              tokensUsed,
              lastActivityAt: latest(run.lastActivityAt, parsed.observedAt),
              ...(parsed.providerSessionId === undefined
                ? {}
                : { providerSessionId: parsed.providerSessionId }),
            };
            if (nextStatus !== run.status)
              assertGoalRunStatusTransition(run.status, nextStatus);
            if (!store.updateRun(run, nextRun, parsed.observedAt)) {
              throw persistenceConflict(
                `Goal Run ${run.id} changed while recording a provider event`,
              );
            }
            for (const draft of parsed.evidence ?? []) {
              if (
                store.findEvidenceBySourceEvent(
                  parsed.ownerId,
                  parsed.runtimeSessionId,
                  run.id,
                  draft.sourceEventId,
                )
              )
                continue;
              const evidence = GoalEvidenceSchema.parse({
                id: this.ids.generate(),
                goalId: context.goalId,
                goalRunId: run.id,
                goalRevision: context.goalRevision,
                instructionId: context.instructionId,
                type: draft.type,
                sourceEventId: draft.sourceEventId,
                summary: draft.summary,
                ...(draft.success === undefined
                  ? {}
                  : { success: draft.success }),
                payload: draft.payload,
                observedAt: draft.observedAt,
              });
              store.insertEvidence({
                ownerId: parsed.ownerId,
                runtimeSessionId: parsed.runtimeSessionId,
                runEpoch: parsed.runEpoch,
                evidence,
                recordedAt: parsed.observedAt,
              });
            }
            return true;
          },
        );
        return accepted;
      },
    );
  }

  async beginGoalEvaluation(input: {
    ownerId: string;
    runtimeSessionId: string;
    goalId: string;
    goalRevision: number;
    runEpoch: number;
    evaluationKey: string;
    recordedAt: string;
  }): Promise<RuntimeGoalEvaluationSnapshot | null> {
    const key = evaluationScope(
      input.ownerId,
      input.runtimeSessionId,
      input.evaluationKey,
    );
    return this.serial.run(scope(input.ownerId, input.runtimeSessionId), () => {
      if (this.evaluations.has(key)) return null;
      const snapshot = this.withRuntimeLease(
        input.ownerId,
        input.runtimeSessionId,
        (store) => {
          const session = store.getSession(
            input.ownerId,
            input.runtimeSessionId,
          );
          const active = store.getAssignedPrimaryGoal(
            input.ownerId,
            input.runtimeSessionId,
          );
          const run = store.findRun(
            input.ownerId,
            input.runtimeSessionId,
            input.goalId,
            input.runEpoch,
          );
          if (
            session?.runEpoch !== input.runEpoch ||
            active?.persistedGoal.goal.id !== input.goalId ||
            active.persistedGoal.goal.revision !== input.goalRevision ||
            !run ||
            run.goalRevision !== input.goalRevision ||
            run.status === "evaluating" ||
            run.status === "paused" ||
            run.status === "blocked" ||
            isTerminalRun(run.status)
          )
            return null;
          const evidenceRevisionFloor = resolveGoalEvidenceRevisionFloor(
            input.goalId,
            input.goalRevision,
            store.listInstructions(input.ownerId, input.runtimeSessionId),
          );
          assertGoalRunStatusTransition(run.status, "evaluating");
          const next = {
            ...run,
            status: "evaluating" as const,
            lastActivityAt: latest(run.lastActivityAt, input.recordedAt),
          };
          if (!store.updateRun(run, next, input.recordedAt)) return null;
          return {
            run: next,
            evidenceRevisionFloor,
            evidence: store
              .listEvidenceByRun(input.ownerId, input.runtimeSessionId, run.id)
              .filter(
                (item) =>
                  item.goalRevision >= evidenceRevisionFloor &&
                  item.goalRevision <= input.goalRevision,
              ),
          };
        },
      );
      if (snapshot) {
        this.evaluations.set(key, {
          goalId: input.goalId,
          goalRevision: input.goalRevision,
          runEpoch: input.runEpoch,
          runId: snapshot.run.id,
          phase: "evaluating",
        });
      }
      return snapshot;
    });
  }

  async finishGoalEvaluation(input: {
    ownerId: string;
    runtimeSessionId: string;
    goalId: string;
    goalRevision: number;
    runEpoch: number;
    evaluationKey: string;
    evaluation: GoalEvaluationResult;
    outcome: RuntimeGoalEvaluationOutcome;
    recordedAt: string;
  }): Promise<boolean> {
    const evaluation = GoalEvaluationResultSchema.parse(input.evaluation);
    if (
      (input.outcome === "completed") !== evaluation.completed ||
      (input.outcome === "continuing" &&
        evaluation.missingCriteria.length === 0)
    ) {
      throw persistenceConflict(
        `Evaluation result is inconsistent with Goal Run outcome ${input.outcome}`,
      );
    }
    const key = evaluationScope(
      input.ownerId,
      input.runtimeSessionId,
      input.evaluationKey,
    );
    return this.serial.run(scope(input.ownerId, input.runtimeSessionId), () => {
      const lease = this.evaluations.get(key);
      if (!matchesEvaluation(lease, input) || lease.phase !== "evaluating")
        return false;
      const finished = this.withRuntimeLease(
        input.ownerId,
        input.runtimeSessionId,
        (store) => {
          const run = store.getRun(
            input.ownerId,
            input.runtimeSessionId,
            lease.runId,
          );
          if (!run || run.runEpoch !== input.runEpoch) return false;
          let status: GoalRunStatus = run.status;
          if (input.outcome === "continuing") {
            if (run.status !== "evaluating") return false;
            assertGoalRunStatusTransition(run.status, "continuing");
            status = "continuing";
          } else if (run.status !== input.outcome) {
            // AgentGoalState commits the terminal state before evaluation details.
            return false;
          }
          const next = {
            ...run,
            status,
            lastEvaluation: evaluation,
            lastActivityAt: latest(run.lastActivityAt, input.recordedAt),
            ...(isTerminalRun(status)
              ? {
                  completedAt: latest(
                    run.completedAt ?? run.lastActivityAt,
                    input.recordedAt,
                  ),
                }
              : {}),
          };
          return store.updateRun(run, next, input.recordedAt);
        },
      );
      if (finished) lease.phase = "finished";
      return finished;
    });
  }

  async abandonGoalEvaluation(input: {
    ownerId: string;
    runtimeSessionId: string;
    goalId: string;
    goalRevision: number;
    runEpoch: number;
    evaluationKey: string;
    recordedAt: string;
  }): Promise<boolean> {
    const key = evaluationScope(
      input.ownerId,
      input.runtimeSessionId,
      input.evaluationKey,
    );
    return this.serial.run(scope(input.ownerId, input.runtimeSessionId), () => {
      const lease = this.evaluations.get(key);
      if (!matchesEvaluation(lease, input) || lease.phase !== "evaluating")
        return false;
      const abandoned = this.withRuntimeLease(
        input.ownerId,
        input.runtimeSessionId,
        (store) => {
          const run = store.getRun(
            input.ownerId,
            input.runtimeSessionId,
            lease.runId,
          );
          if (!run || run.status !== "evaluating") return false;
          assertGoalRunStatusTransition(run.status, "running");
          return store.updateRun(
            run,
            {
              ...run,
              status: "running",
              lastActivityAt: latest(run.lastActivityAt, input.recordedAt),
            },
            input.recordedAt,
          );
        },
      );
      if (abandoned) lease.phase = "abandoned";
      return abandoned;
    });
  }

  async finalizeControlInstruction(input: {
    ownerId: string;
    runtimeSessionId: string;
    instructionId: string;
    runEpoch: number;
    status: "paused" | "cancelled";
    recordedAt?: string;
  }): Promise<void> {
    await this.serial.run(scope(input.ownerId, input.runtimeSessionId), () => {
      this.withRuntimeLease(input.ownerId, input.runtimeSessionId, (store) => {
        const instruction = store.getInstruction(
          input.ownerId,
          input.runtimeSessionId,
          input.instructionId,
        );
        let delivery = store.getActiveDeliveryForInstruction(
          input.ownerId,
          input.runtimeSessionId,
          input.instructionId,
        );
        if (!instruction || !delivery) return;
        if (
          instruction.runEpoch !== input.runEpoch ||
          !controlMatches(instruction.instruction, input.status)
        ) {
          throw persistenceConflict(
            `Control instruction ${input.instructionId} does not match its lifecycle boundary`,
          );
        }
        const at = input.recordedAt ?? this.now();
        if (delivery.state === "queued")
          delivery = transitionDelivery(store, delivery, "written_to_sdk", at);
        if (delivery.state === "written_to_sdk") {
          delivery = transitionDelivery(store, delivery, "observed", at, {
            providerEventId: `runtime-boundary:${input.instructionId}`.slice(
              0,
              256,
            ),
          });
        }
        if (delivery.state === "observed")
          transitionDelivery(store, delivery, "applied", at);
      });
    });
  }

  async supersedeDeliveries(input: {
    ownerId: string;
    runtimeSessionId: string;
    instructionIds: string[];
    reason: string;
  }): Promise<void> {
    await this.serial.run(scope(input.ownerId, input.runtimeSessionId), () => {
      this.withRuntimeLease(input.ownerId, input.runtimeSessionId, (store) => {
        const deliveries = [...new Set(input.instructionIds)].flatMap(
          (instructionId) => {
            const delivery = store.getActiveDeliveryForInstruction(
              input.ownerId,
              input.runtimeSessionId,
              instructionId,
            );
            return delivery ? [delivery] : [];
          },
        );
        if (
          deliveries.some(
            (item) =>
              item.state !== "pending" &&
              item.state !== "leased" &&
              item.state !== "queued" &&
              item.state !== "superseded",
          )
        ) {
          throw persistenceConflict(
            "Only undelivered Runtime Instructions can be superseded",
          );
        }
        const at = this.now();
        for (const delivery of deliveries) {
          if (delivery.state === "superseded") continue;
          transitionDelivery(store, delivery, "superseded", at, {
            errorCode: "superseded",
            errorMessage: input.reason,
          });
        }
      });
    });
  }

  private withRuntimeLease<T>(
    ownerId: string,
    runtimeSessionId: string,
    operation: (store: SqliteGoalRuntimeStore) => T,
  ): T {
    const lease = this.runtimeLeases.get(scope(ownerId, runtimeSessionId));
    return this.database.immediate((store) => {
      if (lease) {
        const session = store.getSession(ownerId, runtimeSessionId);
        if (
          !session ||
          session.recoveryLeaseToken !== lease.leaseToken ||
          session.recoveryLeaseExpiresAtSeconds === undefined ||
          session.recoveryLeaseExpiresAtSeconds <=
            Math.floor(this.clock.now().getTime() / 1_000)
        ) {
          throw persistenceConflict(
            `Runtime Session ${runtimeSessionId} no longer owns its durable execution lease`,
          );
        }
      }
      return operation(store);
    });
  }

  private runtimeLeaseFence(
    ownerId: string,
    runtimeSessionId: string,
    expectedRunEpoch?: number,
  ): { runtimeLeaseToken?: string; expectedRunEpoch?: number } {
    const leaseToken = this.runtimeLeases.get(
      scope(ownerId, runtimeSessionId),
    )?.leaseToken;
    return {
      ...(leaseToken === undefined ? {} : { runtimeLeaseToken: leaseToken }),
      ...(expectedRunEpoch === undefined ? {} : { expectedRunEpoch }),
    };
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

function retainedProviderInputEventId(
  providerEventId: string | undefined,
): string | undefined {
  return providerEventId?.startsWith("codex:") &&
    providerEventId.includes(":input:")
    ? providerEventId
    : undefined;
}

function requireCanonicalInstruction(
  store: SqliteGoalRuntimeStore,
  ownerId: string,
  instruction: RuntimeInstruction,
) {
  const stored = store.getInstruction(
    ownerId,
    instruction.targetSessionId,
    instruction.id,
  );
  if (
    !stored ||
    canonicalJson(stored.instruction) !== canonicalJson(instruction)
  ) {
    throw persistenceConflict(
      `Instruction ${instruction.id} does not match the durable outbox`,
    );
  }
  return stored;
}

function requireCurrentEpoch(
  store: SqliteGoalRuntimeStore,
  ownerId: string,
  runtimeSessionId: string,
  runEpoch: number,
): void {
  if (store.getSession(ownerId, runtimeSessionId)?.runEpoch !== runEpoch) {
    throw persistenceConflict(
      "Runtime Instruction belongs to a stale run epoch",
      "run_epoch_conflict",
    );
  }
}

function transitionDelivery(
  store: SqliteGoalRuntimeStore,
  current: PersistedRuntimeInstructionDelivery,
  state: DeliveryState,
  updatedAt: string,
  fields: Partial<PersistedRuntimeInstructionDelivery> = {},
): PersistedRuntimeInstructionDelivery {
  if (current.state === state) return current;
  assertDeliveryStateTransition(current.state, state);
  const next: PersistedRuntimeInstructionDelivery = {
    ...current,
    ...fields,
    state,
    updatedAt: latest(current.updatedAt, updatedAt),
    ...(state === "leased"
      ? {}
      : {
          leaseToken: undefined,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
        }),
  };
  if (!store.updateDelivery(current, next)) {
    throw persistenceConflict(
      `Delivery ${current.id} changed during its state transition`,
    );
  }
  return next;
}

function markRunHandoff(
  store: SqliteGoalRuntimeStore,
  delivery: PersistedRuntimeInstructionDelivery,
  instruction: RuntimeInstruction,
  recordedAt: string,
): void {
  if (!delivery.goalRunId || isControl(instruction)) return;
  const run = store.getRun(
    delivery.ownerId,
    delivery.runtimeSessionId,
    delivery.goalRunId,
  );
  if (
    !run ||
    isTerminalRun(run.status) ||
    run.goalRevision !== instruction.goalRevision
  ) {
    return;
  }
  const status =
    run.status === "queued" || run.status === "continuing"
      ? "running"
      : run.status;
  if (status !== run.status) assertGoalRunStatusTransition(run.status, status);
  store.updateRun(
    run,
    { ...run, status, lastActivityAt: latest(run.lastActivityAt, recordedAt) },
    recordedAt,
  );
}

function latestContext(
  store: SqliteGoalRuntimeStore,
  ownerId: string,
  runtimeSessionId: string,
  runEpoch: number,
  instructionId?: string,
): RuntimeObservationContext | null {
  const active = store.getAssignedPrimaryGoal(ownerId, runtimeSessionId);
  if (active?.persistedGoal.goal.status !== "active") return null;
  const deliveries = store.listDeliveries(ownerId, runtimeSessionId);
  const candidates = store
    .listInstructions(ownerId, runtimeSessionId)
    .filter((instruction) => !isControl(instruction))
    .sort((left, right) => right.sequence - left.sequence);
  for (const instruction of candidates) {
    if (
      (instructionId !== undefined && instruction.id !== instructionId) ||
      instruction.goalId === undefined ||
      instruction.goalRevision === undefined
    )
      continue;
    const delivery = deliveries.find(
      (item) =>
        item.instructionId === instruction.id &&
        item.runEpoch === runEpoch &&
        item.goalRunId &&
        isProviderVisible(item.state),
    );
    if (!delivery?.goalRunId) continue;
    const run = store.getRun(ownerId, runtimeSessionId, delivery.goalRunId);
    if (
      run?.goalId !== active.persistedGoal.goal.id ||
      run.goalRevision !== active.persistedGoal.goal.revision ||
      run.goalRevision < instruction.goalRevision ||
      run.status === "paused" ||
      run.status === "blocked" ||
      isTerminalRun(run.status)
    ) {
      continue;
    }
    return {
      ownerId,
      runtimeSessionId,
      goalRunId: delivery.goalRunId,
      goalId: instruction.goalId,
      goalRevision: instruction.goalRevision,
      instructionId: instruction.id,
      runEpoch,
    };
  }
  return null;
}

function validateContext(
  store: SqliteGoalRuntimeStore,
  context: RuntimeObservationContext,
  runEpoch: number,
  terminalProviderEvent = false,
): RuntimeObservationContext | null {
  if (context.runEpoch !== runEpoch) return null;
  const run = store.getRun(
    context.ownerId,
    context.runtimeSessionId,
    context.goalRunId,
  );
  const delivery = store.getActiveDeliveryForInstruction(
    context.ownerId,
    context.runtimeSessionId,
    context.instructionId,
  );
  const instruction = store.getInstruction(
    context.ownerId,
    context.runtimeSessionId,
    context.instructionId,
  )?.instruction;
  return run?.goalId === context.goalId &&
    run.runEpoch === runEpoch &&
    run.goalRevision >= context.goalRevision &&
    run.status !== "paused" &&
    run.status !== "blocked" &&
    (!isTerminalRun(run.status) ||
      (terminalProviderEvent &&
        (run.status === "completed" || run.status === "budget_limited"))) &&
    delivery?.goalRunId === run.id &&
    delivery.runEpoch === runEpoch &&
    instruction?.goalId === context.goalId &&
    instruction.goalRevision === context.goalRevision
    ? structuredClone(context)
    : null;
}

function acknowledgedContexts(
  store: SqliteGoalRuntimeStore,
  primary: RuntimeObservationContext,
  acknowledged: RuntimeObservationContext[] | undefined,
  runEpoch: number,
  terminalProviderEvent: boolean,
): RuntimeObservationContext[] {
  const contexts = new Map<string, RuntimeObservationContext>();
  for (const candidate of [primary, ...(acknowledged ?? [])]) {
    const valid = validateContext(
      store,
      candidate,
      runEpoch,
      terminalProviderEvent,
    );
    if (valid) contexts.set(valid.instructionId, valid);
  }
  return [...contexts.values()];
}

function parseReceipt(
  receipt: RuntimeDeliveryReceipt,
  instruction: RuntimeInstruction,
): RuntimeDeliveryReceipt {
  if (
    receipt.instructionId !== instruction.id ||
    receipt.runtimeSessionId !== instruction.targetSessionId
  ) {
    throw new TypeError(
      "Runtime delivery receipt does not match its instruction",
    );
  }
  timestamp(receipt.recordedAt, "receipt.recordedAt");
  return structuredClone(receipt);
}

function parseObservation(
  input: RuntimeProviderEventObservation,
): RuntimeProviderEventObservation {
  identifier(input.ownerId, "ownerId");
  identifier(input.runtimeSessionId, "runtimeSessionId");
  identifier(input.eventKey, "eventKey");
  identifier(input.providerEventId, "providerEventId");
  timestamp(input.observedAt, "observedAt");
  if (!Number.isSafeInteger(input.runEpoch) || input.runEpoch < 0)
    throw new TypeError("runEpoch must be non-negative");
  for (const value of [input.usage?.turnsUsed, input.usage?.tokensUsed]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new TypeError("Provider usage must be non-negative");
  }
  if (
    input.context &&
    (input.context.ownerId !== input.ownerId ||
      input.context.runtimeSessionId !== input.runtimeSessionId ||
      input.context.runEpoch !== input.runEpoch)
  ) {
    throw new TypeError(
      "Provider observation context does not match its Runtime Session",
    );
  }
  for (const context of input.acknowledgedContexts ?? []) {
    if (
      context.ownerId !== input.ownerId ||
      context.runtimeSessionId !== input.runtimeSessionId ||
      context.runEpoch !== input.runEpoch
    ) {
      throw new TypeError(
        "Acknowledged context does not match its Runtime Session",
      );
    }
  }
  return structuredClone(input);
}

function assertSameProviderEvent(
  existing: {
    providerEventId: string;
    providerSessionId?: string;
    eventFingerprint: string;
  },
  observed: RuntimeProviderEventObservation,
  eventFingerprint: string,
): void {
  // Older receipts included usage in the hash. Codex history has no matching
  // per-turn usage snapshot, but the exact provider terminal ID is sufficient
  // to treat its no-evidence replay as the already-applied terminal.
  const replayableTerminal =
    observed.terminal === true &&
    observed.providerEventId.startsWith("codex:") &&
    (observed.evidence?.length ?? 0) === 0;
  if (
    existing.providerEventId !== observed.providerEventId ||
    existing.providerSessionId !== observed.providerSessionId ||
    (existing.eventFingerprint !== eventFingerprint && !replayableTerminal)
  ) {
    throw persistenceConflict(
      `Provider event key ${observed.eventKey} was reused with different event data`,
    );
  }
}

function providerEventFingerprint(
  observed: RuntimeProviderEventObservation,
): string {
  // `observedAt` is assigned by the local observer. A provider can replay the
  // same durable event after restart with a new observation timestamp, so it
  // must not participate in identity. Evidence timestamps are observer-local
  // for the same reason; evidence content remains fenced.
  // Usage is a process-local projection of Codex's cumulative counters. A
  // historical turn replay may not include the original usage snapshot.
  const { observedAt: _observedAt, usage: _usage, evidence, ...stable } =
    observed;
  return createHash("sha256")
    .update(
      canonicalJson({
        ...stable,
        ...(evidence === undefined
          ? {}
          : {
              evidence: evidence.map(
                ({ observedAt: _evidenceObservedAt, ...item }) => item,
              ),
            }),
      }),
    )
    .digest("hex");
}

function isSettledForReceipt(
  current: DeliveryState,
  receipt: RuntimeDeliveryReceipt["state"],
): boolean {
  if (receipt === "queued")
    return current === "queued" || isProviderVisible(current);
  if (receipt === "written_to_sdk") return isProviderVisible(current);
  return current === "rejected";
}

function isProviderVisible(state: DeliveryState): boolean {
  return (
    state === "written_to_sdk" ||
    state === "observed" ||
    state === "applied" ||
    state === "completed"
  );
}

function isControl(instruction: RuntimeInstruction): boolean {
  return (
    instruction.kind === "control.interrupt" ||
    instruction.kind === "goal.pause" ||
    instruction.kind === "goal.cancel"
  );
}

function controlMatches(
  instruction: RuntimeInstruction,
  status: "paused" | "cancelled",
): boolean {
  return status === "paused"
    ? instruction.kind === "goal.pause"
    : instruction.kind === "goal.cancel" ||
        instruction.kind === "control.interrupt";
}

function isTerminalRun(status: GoalRunStatus): boolean {
  return (
    status === "completed" ||
    status === "cancelled" ||
    status === "budget_limited" ||
    status === "failed"
  );
}

function matchesEvaluation(
  lease: EvaluationLease | undefined,
  input: { goalId: string; goalRevision: number; runEpoch: number },
): lease is EvaluationLease {
  return Boolean(
    lease &&
    lease.goalId === input.goalId &&
    lease.goalRevision === input.goalRevision &&
    lease.runEpoch === input.runEpoch,
  );
}

function evaluationScope(
  ownerId: string,
  runtimeSessionId: string,
  key: string,
): string {
  return JSON.stringify([ownerId, runtimeSessionId, key]);
}

function scope(ownerId: string, runtimeSessionId: string): string {
  return JSON.stringify([
    identifier(ownerId, "ownerId"),
    identifier(runtimeSessionId, "runtimeSessionId"),
  ]);
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value !== value.trim()
  ) {
    throw new TypeError(`${field} must be a non-empty identifier`);
  }
  return value;
}

function timestamp(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value)))
    throw new TypeError(`${field} must be an ISO timestamp`);
  return value;
}

function latest(...values: string[]): string {
  return values.reduce((result, value) =>
    Date.parse(value) > Date.parse(result) ? value : result,
  );
}
