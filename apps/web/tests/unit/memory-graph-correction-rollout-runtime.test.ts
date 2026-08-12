import {
  type MemorySummaryRecord,
  type RawMessage,
  type RawMessageGraphGovernanceStorage,
  type RawMessageMemoryGraphCorrectionCommand,
  type RawMessageMemoryGraphRollbackCommand,
  type RawMessageQuery,
  createRawMessageMemoryGraphStore,
  queryMemoryWithFallback,
  runMemoryForgettingCycle,
  runMemoryGraphRolloutEvaluation,
  runMemoryGraphCorrection as runTrustedMemoryGraphCorrection,
  runMemoryGraphRollback as runTrustedMemoryGraphRollback,
  storeRawMessagesWithGraphEvolution,
} from "@melandlabs/indexeddb";
import {
  type MemoryGraphSnapshot,
  type OwnerScope,
  buildGraphAwareRetrievalDryRun,
  buildMemoryGraphCorrectionPlan,
} from "@melandlabs/memory-consolidation";
import { describe, expect, it } from "vitest";

const NOW = 1_700_000_000_000;
const OWNER = { userId: "user-1" } satisfies OwnerScope;

type LegacyCommandScope = {
  requestedBy?: string;
  workspaceId?: string;
  tenantId?: string;
};

function trustedCommandInput<
  T extends
    | RawMessageMemoryGraphCorrectionCommand
    | RawMessageMemoryGraphRollbackCommand,
>(userId: string, command: T & LegacyCommandScope) {
  const { requestedBy, workspaceId, tenantId, ...trustedCommand } = command;
  return {
    trustedContext: {
      ownerScope: { userId, workspaceId, tenantId },
      requestedBy: requestedBy ?? userId,
    },
    command: trustedCommand as T,
  };
}

function runMemoryGraphCorrection(input: {
  storage: RawMessageGraphGovernanceStorage;
  userId: string;
  command: RawMessageMemoryGraphCorrectionCommand & LegacyCommandScope;
  now?: number;
}) {
  return runTrustedMemoryGraphCorrection({
    storage: input.storage,
    now: input.now,
    ...trustedCommandInput(input.userId, input.command),
  });
}

function runMemoryGraphRollback(input: {
  storage: RawMessageGraphGovernanceStorage;
  userId: string;
  command: RawMessageMemoryGraphRollbackCommand & LegacyCommandScope;
  now?: number;
}) {
  return runTrustedMemoryGraphRollback({
    storage: input.storage,
    now: input.now,
    ...trustedCommandInput(input.userId, input.command),
  });
}

class GovernanceRuntimeTestManager {
  readonly messages = new Map<string, RawMessage>();
  readonly summaries = new Map<string, MemorySummaryRecord>();
  nextId = 1;
  failRestoreWrites = 0;
  restoreWriteCount = 0;
  readonly failRestoreWriteNumbers = new Set<number>();
  noopRestoreWrites = 0;
  failLedgerWrites = 0;
  summaryWriteCount = 0;
  readonly failSummaryWriteNumbers = new Set<number>();
  restoreDeprecatedMessages?: (
    messageIds: string[],
    input: { userId?: string; supersededBySummaryId?: string },
  ) => Promise<number>;

  constructor(input: { supportsRestore?: boolean } = {}) {
    if (input.supportsRestore !== false) {
      this.restoreDeprecatedMessages = async (messageIds, options) => {
        this.restoreWriteCount += 1;
        if (this.failRestoreWriteNumbers.has(this.restoreWriteCount)) {
          throw new Error("restore write failed");
        }
        if (this.failRestoreWrites > 0) {
          this.failRestoreWrites -= 1;
          throw new Error("restore write failed");
        }
        if (this.noopRestoreWrites > 0) {
          this.noopRestoreWrites -= 1;
          return 0;
        }
        let changed = 0;
        for (const messageId of messageIds) {
          const message = this.messages.get(messageId);
          if (
            !message ||
            message.deprecatedAt === undefined ||
            (options.userId && message.userId !== options.userId) ||
            (options.supersededBySummaryId &&
              message.supersededBySummaryId !== options.supersededBySummaryId)
          ) {
            continue;
          }
          const restored = { ...message };
          restored.deprecatedAt = undefined;
          restored.deprecationReason = undefined;
          restored.supersededBySummaryId = undefined;
          this.messages.set(messageId, restored);
          changed += 1;
        }
        return changed;
      };
    }
  }

  async storeMessage(message: RawMessage): Promise<number> {
    if (
      message.content === "OpenLoomi internal memory graph ledger" &&
      this.failLedgerWrites > 0
    ) {
      this.failLedgerWrites -= 1;
      throw new Error("ledger write failed");
    }
    const existing = this.messages.get(message.messageId);
    const id = existing?.id ?? this.nextId++;
    this.messages.set(message.messageId, { ...message, id });
    return id;
  }

  async storeMessages(messages: RawMessage[]): Promise<number[]> {
    return Promise.all(messages.map((message) => this.storeMessage(message)));
  }

  async compareAndSwapGraphLedger(
    message: RawMessage,
    input: { expectedVersion: string; metadataKey: string },
  ): Promise<boolean> {
    const current = this.messages.get(message.messageId);
    const ledger = current?.metadata?.[input.metadataKey] as
      | { snapshot?: { version?: unknown } }
      | undefined;
    const currentVersion =
      typeof ledger?.snapshot?.version === "string"
        ? ledger.snapshot.version
        : "0";
    if (currentVersion !== input.expectedVersion) return false;
    await this.storeMessage(message);
    return true;
  }

  async getMessageById(messageId: string): Promise<RawMessage | null> {
    return this.messages.get(messageId) ?? null;
  }

  async queryMessages(query: RawMessageQuery): Promise<RawMessage[]> {
    let messages = [...this.messages.values()];
    if (query.userId) {
      messages = messages.filter((message) => message.userId === query.userId);
    }
    if (!query.includeArchived) {
      messages = messages.filter((message) => message.archivedAt === undefined);
    }
    if (!query.includeDeprecated) {
      messages = messages.filter(
        (message) => message.deprecatedAt === undefined,
      );
    }
    messages.sort((left, right) => right.timestamp - left.timestamp);
    return messages.slice(
      query.offset ?? 0,
      (query.offset ?? 0) + (query.limit ?? query.pageSize ?? messages.length),
    );
  }

  async upsertSummaries(summaries: MemorySummaryRecord[]): Promise<void> {
    this.summaryWriteCount += 1;
    if (this.failSummaryWriteNumbers.has(this.summaryWriteCount)) {
      throw new Error("summary write failed");
    }
    for (const summary of summaries) {
      const existing = this.summaries.get(summary.summaryId);
      this.summaries.set(summary.summaryId, {
        ...summary,
        createdAt: existing?.createdAt ?? summary.createdAt,
      });
    }
  }

  async querySummaries(input: {
    userId?: string;
    summaryIds?: string[];
    pageSize?: number;
  }): Promise<MemorySummaryRecord[]> {
    return [...this.summaries.values()]
      .filter(
        (summary) =>
          (!input.userId || summary.userId === input.userId) &&
          (!input.summaryIds || input.summaryIds.includes(summary.summaryId)),
      )
      .slice(0, input.pageSize);
  }

  async deprecateMessages(
    messageIds: string[],
    input: {
      userId?: string;
      deprecatedAt?: number;
      reason?: string;
      supersededBySummaryId?: string;
    } = {},
  ): Promise<number> {
    let changed = 0;
    for (const messageId of messageIds) {
      const message = this.messages.get(messageId);
      if (
        !message ||
        message.deprecatedAt !== undefined ||
        (input.userId && message.userId !== input.userId)
      ) {
        continue;
      }
      this.messages.set(messageId, {
        ...message,
        deprecatedAt: input.deprecatedAt ?? Date.now(),
        deprecationReason: input.reason,
        supersededBySummaryId: input.supersededBySummaryId,
      });
      changed += 1;
    }
    return changed;
  }

  async searchMessagesSemantically(input: {
    userId: string;
    includeArchived?: boolean;
    includeDeprecated?: boolean;
  }): Promise<unknown[]> {
    return [...this.messages.values()]
      .filter(
        (message) =>
          message.userId === input.userId &&
          !message.messageId.startsWith("__") &&
          (input.includeArchived || message.archivedAt === undefined) &&
          (input.includeDeprecated || message.deprecatedAt === undefined),
      )
      .map((message) => ({ message, similarity: 1 }));
  }

  async hardDeleteArchived(): Promise<number> {
    return 0;
  }

  async markMessagesAccessed(): Promise<number> {
    return 0;
  }
}

function rawMessage(
  messageId: string,
  input: {
    relationGroup?: string;
    relationValue?: string;
    sourceIdentity?: string;
    applicability?: Record<string, unknown>;
    timestamp?: number;
    userId?: string;
  } = {},
): RawMessage {
  const relationGroup = input.relationGroup ?? "language";
  return {
    messageId,
    platform: "slack",
    botId: "bot-1",
    userId: input.userId ?? OWNER.userId,
    timestamp: input.timestamp ?? Math.floor(NOW / 1000),
    content: `User ${relationGroup} preference: ${input.relationValue ?? "zh"}`,
    attachments: [],
    metadata: {
      relationGroup,
      relationValue: input.relationValue ?? "zh",
      sourceIdentity: input.sourceIdentity ?? `source:${messageId}`,
      memoryApplicability: input.applicability ?? { scope: "global" },
    },
    embedding: [1, 0],
    embeddingModel: "test",
    createdAt: input.timestamp ?? Math.floor(NOW / 1000),
    memoryStage: "short",
  };
}

async function storeEvidence(
  manager: GovernanceRuntimeTestManager,
  messages: RawMessage[],
  now = NOW,
  ownerScope: OwnerScope = OWNER,
) {
  return storeRawMessagesWithGraphEvolution({
    storage: manager,
    messages,
    graphEvolution: {
      enabled: true,
      workspaceId: ownerScope.workspaceId,
      tenantId: ownerScope.tenantId,
    },
    now,
  });
}

async function graph(
  manager: GovernanceRuntimeTestManager,
  scope: OwnerScope = OWNER,
) {
  return createRawMessageMemoryGraphStore({
    storage: manager,
    ownerScope: scope,
    now: () => NOW,
  }).readSnapshot({ ownerScope: scope, includeAuditOnly: true });
}

async function seedConsolidated(
  manager: GovernanceRuntimeTestManager,
  ownerScope: OwnerScope = OWNER,
) {
  await storeEvidence(manager, [rawMessage("zh-1")], NOW, ownerScope);
  await storeEvidence(
    manager,
    [rawMessage("zh-2", { timestamp: Math.floor(NOW / 1000) + 1 })],
    NOW + 1000,
    ownerScope,
  );
  await storeEvidence(
    manager,
    [rawMessage("zh-3", { timestamp: Math.floor(NOW / 1000) + 2 })],
    NOW + 2000,
    ownerScope,
  );
  const lifecycle = await runMemoryForgettingCycle(
    manager as never,
    ownerScope.userId,
    {
      now: NOW + 3000,
      graphLifecycle: {
        enabled: true,
        workspaceId: ownerScope.workspaceId,
        tenantId: ownerScope.tenantId,
      },
    },
  );
  const summary = [...manager.summaries.values()][0];
  const snapshot = await graph(manager, ownerScope);
  if (!summary || !snapshot.clusters[0]) {
    throw new Error("expected consolidated graph fixture");
  }
  expect(lifecycle.graphLifecycle?.status).toBe("applied");
  return { summary, cluster: snapshot.clusters[0], snapshot };
}

describe("memory graph correction, rollback, and rollout runtime", () => {
  it("corrects an incorrect merge without deleting graph history", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster } = await seedConsolidated(manager);
    for (const [id, supersededBySummaryId] of [
      ["zh-1", "summary-group-a"],
      ["zh-2", "summary-group-a"],
      ["zh-3", "summary-group-b"],
    ] as const) {
      const message = manager.messages.get(id);
      if (!message) throw new Error("expected deprecated source evidence");
      manager.messages.set(id, { ...message, supersededBySummaryId });
    }
    manager.failRestoreWriteNumbers.add(manager.restoreWriteCount + 2);
    const partial = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "remove-incorrect-member",
        reason: "The third observation belongs to a separate context",
        action: {
          type: "remove-member",
          clusterId: cluster.clusterId,
          nodeId: "zh-3",
        },
      },
    });
    expect(partial.status).toBe("partial-failure");
    expect(partial.restoredRecords).toBe(1);
    expect(manager.messages.get("zh-1")?.deprecatedAt).toBeDefined();
    expect(manager.messages.get("zh-2")?.deprecatedAt).toBeDefined();
    expect(manager.messages.get("zh-3")?.deprecatedAt).toBeUndefined();
    const result = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 5000,
      command: {
        commandId: "remove-incorrect-member",
        reason: "The third observation belongs to a separate context",
        action: {
          type: "remove-member",
          clusterId: cluster.clusterId,
          nodeId: "zh-3",
        },
      },
    });
    expect(result.status).toBe("applied");
    expect(result.restoredRecords).toBe(2);
    for (const id of ["zh-1", "zh-2", "zh-3"]) {
      expect(manager.messages.get(id)?.deprecatedAt).toBeUndefined();
    }
    const snapshot = await graph(manager);
    expect(
      snapshot.clusters.find((item) => item.clusterId === cluster.clusterId)
        ?.nodeIds,
    ).not.toContain("zh-3");
    expect(
      snapshot.clusters.find((item) => item.nodeIds.includes("zh-3")),
    ).toEqual(
      expect.objectContaining({
        lifecycleStatus: "forming",
        metadata: expect.objectContaining({
          correctedFromClusterId: cluster.clusterId,
        }),
      }),
    );
    expect(
      snapshot.edges.some(
        (edge) =>
          (edge.fromNodeId === "zh-3" || edge.toNodeId === "zh-3") &&
          edge.metadata?.inactive === true,
      ),
    ).toBe(true);
    expect(
      snapshot.nodes.find((node) => node.id === cluster.representativeNodeId)
        ?.visibility,
    ).toBe("audit-only");
    expect(
      snapshot.clusters.find((item) => item.clusterId === cluster.clusterId)
        ?.representativeNodeId,
    ).toBeUndefined();
    const operations = await createRawMessageMemoryGraphStore({
      storage: manager,
      ownerScope: OWNER,
    }).readAppliedOperations({ ownerScope: OWNER, nodeId: "zh-3" });
    expect(operations.map((operation) => operation.kind)).toContain(
      "remove-cluster-member",
    );
  });

  it("persists a corrected summary as representative and keeps the old summary audit-only", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    const result = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "correct-summary-content",
        reason: "The generated summary overstated the preference",
        action: {
          type: "correct-summary",
          clusterId: cluster.clusterId,
          summaryId: summary.summaryId,
          correctedContent: "The user generally prefers Chinese responses.",
        },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "applied",
        summaryId: expect.any(String),
      }),
    );
    expect(manager.summaries.get(result.summaryId ?? "")?.summaryText).toBe(
      "The user generally prefers Chinese responses.",
    );
    const snapshot = await graph(manager);
    expect(snapshot.clusters[0].representativeNodeId).toBe(result.summaryId);
    expect(
      snapshot.nodes.find((node) => node.id === summary.summaryId)?.visibility,
    ).toBe("audit-only");
    expect(
      snapshot.nodes.find((node) => node.id === result.summaryId)?.visibility,
    ).toBe("default");
    const retrieval = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "language preference",
      baselineNodeIds: snapshot.nodes.map((node) => node.id),
      snapshot,
      visibilityMode: "default",
    });
    expect(retrieval.rankedNodeIds).toContain(result.summaryId);
    expect(retrieval.rankedNodeIds).not.toContain(summary.summaryId);
    expect(result.auditTrail?.sourceNodeIds).toEqual(
      expect.arrayContaining(["zh-1", "zh-2", "zh-3"]),
    );
    const correctionOperations = await createRawMessageMemoryGraphStore({
      storage: manager,
      ownerScope: OWNER,
    }).readAppliedOperations({ ownerScope: OWNER, nodeId: result.summaryId });
    expect(correctionOperations[0]?.metadata).toEqual(
      expect.objectContaining({ previousSummaryText: summary.summaryText }),
    );
  });

  it("rolls back a corrected summary through its original source linkage", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    const corrected = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "correct-summary-before-rollback",
        reason: "Use reviewed wording before testing recovery",
        action: {
          type: "correct-summary",
          clusterId: cluster.clusterId,
          summaryId: summary.summaryId,
          correctedContent: "The user generally prefers Chinese responses.",
        },
      },
    });
    if (!corrected.summaryId) {
      throw new Error("expected a persisted corrected summary");
    }

    const rollback = await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 5000,
      command: {
        commandId: "rollback-corrected-summary",
        reason: "Restore the original evidence and representative",
        summaryId: corrected.summaryId,
      },
    });

    expect(rollback).toEqual(
      expect.objectContaining({ status: "applied", restoredRecords: 3 }),
    );
    for (const id of ["zh-1", "zh-2", "zh-3"]) {
      expect(manager.messages.get(id)?.deprecatedAt).toBeUndefined();
    }
    const snapshot = await graph(manager);
    expect(
      snapshot.nodes.find((node) => node.id === summary.summaryId)?.visibility,
    ).toBe("default");
    expect(
      snapshot.nodes.find((node) => node.id === corrected.summaryId)
        ?.visibility,
    ).toBe("audit-only");
    expect(
      snapshot.clusters.find((item) => item.clusterId === cluster.clusterId)
        ?.representativeNodeId,
    ).toBe(summary.summaryId);
  });

  it("reports partial corrected-summary restoration and converges on retry", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    const corrected = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "correct-summary-before-partial-rollback",
        reason: "Use reviewed wording before testing partial recovery",
        action: {
          type: "correct-summary",
          clusterId: cluster.clusterId,
          summaryId: summary.summaryId,
          correctedContent: "The user generally prefers Chinese responses.",
        },
      },
    });
    if (!corrected.summaryId) {
      throw new Error("expected a persisted corrected summary");
    }
    const command = {
      commandId: "rollback-corrected-summary-after-partial-restore",
      reason: "Retry after the second restoration group fails",
      summaryId: corrected.summaryId,
    };
    for (const id of ["zh-1", "zh-2", "zh-3"]) {
      const message = manager.messages.get(id);
      if (!message) throw new Error("expected deprecated source evidence");
      manager.messages.set(id, {
        ...message,
        supersededBySummaryId: corrected.summaryId,
      });
    }
    manager.failRestoreWriteNumbers.add(manager.restoreWriteCount + 2);

    const partial = await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 5000,
      command,
    });

    expect(partial).toEqual(
      expect.objectContaining({
        status: "partial-failure",
        restoredRecords: 3,
        reasonCodes: ["memory_graph_restore_deprecated_messages_failed"],
      }),
    );
    for (const id of ["zh-1", "zh-2", "zh-3"]) {
      expect(manager.messages.get(id)?.deprecatedAt).toBeUndefined();
    }
    expect(
      (await graph(manager)).nodes.find(
        (node) => node.id === corrected.summaryId,
      )?.visibility,
    ).toBe("default");

    const retried = await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 6000,
      command,
    });

    expect(retried.status).toBe("applied");
    expect(retried.restoredRecords).toBe(0);
    const snapshot = await graph(manager);
    expect(
      snapshot.nodes.find((node) => node.id === summary.summaryId)?.visibility,
    ).toBe("default");
    expect(
      snapshot.nodes.find((node) => node.id === corrected.summaryId)
        ?.visibility,
    ).toBe("audit-only");
  });

  it("keeps a corrected summary pending until its graph commit succeeds", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    const command = {
      commandId: "retry-corrected-summary-publication",
      reason: "Keep the correction hidden until graph persistence succeeds",
      action: {
        type: "correct-summary" as const,
        clusterId: cluster.clusterId,
        summaryId: summary.summaryId,
        correctedSummaryId: "pending-corrected-summary",
        correctedContent: "The user prefers Chinese responses after review.",
      },
    };

    manager.failLedgerWrites = 1;
    const failed = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command,
    });
    expect(failed.status).toBe("failed");
    const pendingRecall = await queryMemoryWithFallback(manager as never, {
      userId: OWNER.userId,
      limit: 10,
      minRawResultsWithoutFallback: 10,
    });
    expect(
      pendingRecall.items.some(
        (item) =>
          item.sourceType === "summary" &&
          item.summary.summaryId === "pending-corrected-summary",
      ),
    ).toBe(false);
    const pendingBeforeConflict = manager.summaries.get(
      "pending-corrected-summary",
    );
    const conflictingRetry = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4500,
      command: {
        ...command,
        action: {
          ...command.action,
          correctedContent: "A different correction must not reuse this ID.",
        },
      },
    });
    expect(conflictingRetry).toEqual(
      expect.objectContaining({
        status: "conflict",
        reasonCodes: ["memory_graph_command_id_payload_conflict"],
      }),
    );
    expect(manager.summaries.get("pending-corrected-summary")).toEqual(
      pendingBeforeConflict,
    );
    expect(
      (await graph(manager)).nodes.some(
        (node) => node.id === "pending-corrected-summary",
      ),
    ).toBe(false);

    const retried = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 5000,
      command,
    });
    expect(retried.status).toBe("applied");
    const publishedRecall = await queryMemoryWithFallback(manager as never, {
      userId: OWNER.userId,
      limit: 10,
      minRawResultsWithoutFallback: 10,
    });
    expect(
      publishedRecall.items.some(
        (item) =>
          item.sourceType === "summary" &&
          item.summary.summaryId === "pending-corrected-summary",
      ),
    ).toBe(true);
  });

  it("retries corrected summary publication after its graph commit", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    const command = {
      commandId: "retry-corrected-summary-after-graph-commit",
      reason: "Keep the correction pending until the summary publish retry",
      action: {
        type: "correct-summary" as const,
        clusterId: cluster.clusterId,
        summaryId: summary.summaryId,
        correctedSummaryId: "publish-after-graph-retry",
        correctedContent: "The reviewed preference is Chinese responses.",
      },
    };

    manager.failSummaryWriteNumbers.add(manager.summaryWriteCount + 2);
    const failed = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command,
    });
    expect(failed).toEqual(
      expect.objectContaining({
        status: "partial-failure",
        reasonCodes: expect.arrayContaining([
          "memory_graph_corrected_summary_publication_failed",
        ]),
      }),
    );
    expect((await graph(manager)).clusters[0].representativeNodeId).toBe(
      "publish-after-graph-retry",
    );
    const pendingRecall = await queryMemoryWithFallback(manager as never, {
      userId: OWNER.userId,
      limit: 10,
      minRawResultsWithoutFallback: 10,
    });
    expect(
      pendingRecall.items.some(
        (item) =>
          item.sourceType === "summary" &&
          item.summary.summaryId === "publish-after-graph-retry",
      ),
    ).toBe(false);

    const retried = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 5000,
      command,
    });
    expect(retried.status).toBe("replayed");
    const publishedRecall = await queryMemoryWithFallback(manager as never, {
      userId: OWNER.userId,
      limit: 10,
      minRawResultsWithoutFallback: 10,
    });
    expect(
      publishedRecall.items.some(
        (item) =>
          item.sourceType === "summary" &&
          item.summary.summaryId === "publish-after-graph-retry",
      ),
    ).toBe(true);
  });

  it("applies explicit lifecycle and preferred-representative corrections", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    const corrected = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "representative-candidate",
        reason: "Create a reviewed representative",
        action: {
          type: "correct-summary",
          clusterId: cluster.clusterId,
          summaryId: summary.summaryId,
          correctedContent: "Reviewed language preference.",
        },
      },
    });
    const lifecycle = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 5000,
      command: {
        commandId: "mark-cluster-active",
        reason: "Keep this cluster active during review",
        action: {
          type: "set-lifecycle",
          clusterId: cluster.clusterId,
          lifecycleStatus: "active",
        },
      },
    });
    expect(lifecycle.status).toBe("applied");
    expect((await graph(manager)).clusters[0].lifecycleStatus).toBe("active");

    const preferred = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 6000,
      command: {
        commandId: "restore-reviewed-preference",
        reason: "The original summary is the preferred reviewed wording",
        action: {
          type: "set-representative",
          clusterId: cluster.clusterId,
          representativeNodeId: summary.summaryId,
        },
      },
    });
    expect(preferred.status).toBe("applied");
    const snapshot = await graph(manager);
    expect(snapshot.clusters[0].representativeNodeId).toBe(summary.summaryId);
    expect(
      snapshot.nodes.find((node) => node.id === summary.summaryId)?.visibility,
    ).toBe("default");
    expect(
      snapshot.nodes.find((node) => node.id === corrected.summaryId)
        ?.visibility,
    ).toBe("audit-only");
  });

  it("rolls back persisted consolidation, restores raw retrieval, and is idempotent", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { summary, snapshot: initialSnapshot } =
      await seedConsolidated(manager);
    const first = await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "rollback-consolidation",
        reason: "The consolidation must be reversed for review",
        expectedVersion: initialSnapshot.version,
        summaryId: summary.summaryId,
      },
    });

    expect(first).toEqual(
      expect.objectContaining({ status: "applied", restoredRecords: 3 }),
    );
    expect(first.sourceRecordIds).toEqual(
      expect.arrayContaining(["zh-1", "zh-2", "zh-3"]),
    );
    expect(first.auditTrail?.sourceNodeIds).toEqual(
      expect.arrayContaining(["zh-1", "zh-2", "zh-3"]),
    );
    expect(first.auditTrail?.operationIds.length).toBeGreaterThan(0);
    for (const id of ["zh-1", "zh-2", "zh-3"]) {
      expect(manager.messages.get(id)?.deprecatedAt).toBeUndefined();
    }
    const snapshot = await graph(manager);
    expect(
      snapshot.nodes.find((node) => node.id === summary.summaryId)?.visibility,
    ).toBe("audit-only");
    expect(
      snapshot.nodes
        .filter((node) => node.type === "raw")
        .every((node) => node.visibility === "default"),
    ).toBe(true);
    const defaultMemory = await queryMemoryWithFallback(manager as never, {
      userId: OWNER.userId,
      limit: 10,
      minRawResultsWithoutFallback: 1,
    });
    expect(defaultMemory.items.every((item) => item.sourceType === "raw")).toBe(
      true,
    );
    const replay = await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 5000,
      command: {
        commandId: "rollback-consolidation",
        reason: "The consolidation must be reversed for review",
        expectedVersion: initialSnapshot.version,
        summaryId: summary.summaryId,
      },
    });
    expect(["no-op", "replayed"]).toContain(replay.status);
    expect(replay.restoredRecords).toBe(0);
    expect(manager.messages.get("zh-1")?.deprecatedAt).toBeUndefined();
  });

  it("rejects stale, colliding, and cross-scope rollback commands before recovery", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { summary, snapshot } = await seedConsolidated(manager);
    const before = await graph(manager);

    const stale = await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "stale-rollback",
        reason: "Reject stale operator state",
        expectedVersion: String(Number(snapshot.version ?? "0") - 1),
        summaryId: summary.summaryId,
      },
    });
    expect(stale).toEqual(
      expect.objectContaining({
        status: "conflict",
        reasonCodes: ["memory_graph_version_conflict"],
      }),
    );
    expect(await graph(manager)).toEqual(before);
    expect(manager.messages.get("zh-1")?.deprecatedAt).toBeDefined();

    const wrongScope = await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "cross-scope-rollback",
        reason: "Reject another workspace",
        workspaceId: "workspace-b",
        summaryId: summary.summaryId,
      },
    });
    expect(wrongScope).toEqual(
      expect.objectContaining({
        status: "no-op",
        reasonCodes: ["memory_graph_rollback_source_records_not_found"],
      }),
    );
    expect(await graph(manager)).toEqual(before);
    expect(manager.messages.get("zh-1")?.deprecatedAt).toBeDefined();

    const applied = await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "stable-rollback-command",
        reason: "Apply reviewed rollback",
        summaryId: summary.summaryId,
      },
    });
    expect(applied.status).toBe("applied");
    const afterApplied = await graph(manager);

    const collision = await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "stable-rollback-command",
        reason: "Different reason under the same command id",
        summaryId: summary.summaryId,
      },
    });
    expect(collision).toEqual(
      expect.objectContaining({
        status: "conflict",
        reasonCodes: ["memory_graph_command_id_payload_conflict"],
      }),
    );
    expect(await graph(manager)).toEqual(afterApplied);
  });

  it("hides a superseded summary by default and restores it on rollback", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { summary: oldSummary } = await seedConsolidated(manager);
    await storeEvidence(
      manager,
      [rawMessage("en-1", { relationValue: "en" })],
      NOW + 4000,
    );
    await storeEvidence(
      manager,
      [rawMessage("en-2", { relationValue: "en" })],
      NOW + 5000,
    );
    await storeEvidence(
      manager,
      [rawMessage("en-3", { relationValue: "en" })],
      NOW + 6000,
    );
    const lifecycle = await runMemoryForgettingCycle(
      manager as never,
      OWNER.userId,
      { now: NOW + 7000, graphLifecycle: { enabled: true } },
    );
    expect(lifecycle.graphLifecycle?.createdSummaries).toBe(1);
    const superseded = await graph(manager);
    const newSummary = superseded.nodes.find(
      (node) =>
        node.type === "summary" &&
        node.id !== oldSummary.summaryId &&
        node.visibility === "default",
    );
    expect(newSummary).toBeDefined();
    const supersededCluster = superseded.clusters.find(
      (cluster) => cluster.representativeNodeId === oldSummary.summaryId,
    );
    expect(supersededCluster).toEqual(
      expect.objectContaining({
        lifecycleStatus: "superseded",
        metadata: expect.objectContaining({
          supersededBySummaryId: newSummary?.id,
        }),
      }),
    );
    expect(
      superseded.nodes.find((node) => node.id === oldSummary.summaryId)
        ?.visibility,
    ).toBe("audit-only");
    expect(
      superseded.edges.some(
        (edge) =>
          edge.kind === "supersede" &&
          edge.fromNodeId === oldSummary.summaryId &&
          edge.toNodeId === newSummary?.id,
      ),
    ).toBe(true);
    const defaultRetrieval = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "language preference",
      baselineNodeIds: superseded.nodes.map((node) => node.id),
      snapshot: superseded,
      visibilityMode: "default",
    });
    expect(defaultRetrieval.rankedNodeIds).toContain(newSummary?.id);
    expect(defaultRetrieval.rankedNodeIds).not.toContain(oldSummary.summaryId);

    const rollback = await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 8000,
      command: {
        commandId: "rollback-preference-supersession",
        reason: "Restore the previous reviewed preference",
        summaryId: newSummary?.id ?? "",
      },
    });
    expect(rollback.status).toBe("applied");
    const restored = await graph(manager);
    expect(
      restored.nodes.find((node) => node.id === oldSummary.summaryId)
        ?.visibility,
    ).toBe("default");
    expect(
      restored.nodes.find((node) => node.id === newSummary?.id)?.visibility,
    ).toBe("audit-only");
    const restoredCluster = restored.clusters.find(
      (cluster) => cluster.clusterId === supersededCluster?.clusterId,
    );
    expect(restoredCluster?.lifecycleStatus).toBe("stable");
    expect(restoredCluster?.metadata?.supersededBySummaryId).toBeUndefined();
    expect(restoredCluster?.metadata?.supersededByClusterId).toBeUndefined();
    for (const id of ["zh-1", "zh-2", "zh-3"]) {
      expect(manager.messages.get(id)?.deprecatedAt).toBeDefined();
    }
    for (const id of ["en-1", "en-2", "en-3"]) {
      expect(manager.messages.get(id)?.deprecatedAt).toBeUndefined();
    }
  });

  // Both arms of one claim: what baseline retrieval does without the graph,
  // and what changes with it. Raw records can be hidden without the graph
  // because they carry `deprecatedAt`; summaries carry no such field, so a
  // superseded summary is only distinguishable from a live one in the graph.
  it("keeps a superseded summary in baseline retrieval that only the graph can hide", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { summary: supersededSummary } = await seedConsolidated(manager);
    for (const [index, id] of ["en-1", "en-2", "en-3"].entries()) {
      await storeEvidence(
        manager,
        [rawMessage(id, { relationValue: "en" })],
        NOW + 4000 + index * 1000,
      );
    }
    await runMemoryForgettingCycle(manager as never, OWNER.userId, {
      now: NOW + 7000,
      graphLifecycle: { enabled: true },
    });

    const snapshot = await graph(manager);
    const replacementSummaryId = snapshot.nodes.find(
      (node) =>
        node.type === "summary" &&
        node.id !== supersededSummary.summaryId &&
        node.visibility === "default",
    )?.id;
    expect(replacementSummaryId).toBeDefined();
    expect(
      snapshot.nodes.find((node) => node.id === supersededSummary.summaryId)
        ?.visibility,
    ).toBe("audit-only");

    // Without the graph. Storage cannot express that the old summary was
    // superseded, so baseline retrieval returns it beside its replacement.
    const baseline = await queryMemoryWithFallback(manager as never, {
      userId: OWNER.userId,
      limit: 10,
      minRawResultsWithoutFallback: 10,
    });
    const baselineSummaryIds = baseline.items
      .filter((item) => item.sourceType === "summary")
      .map((item) => item.summary.summaryId);
    expect(baselineSummaryIds).toContain(supersededSummary.summaryId);
    expect(baselineSummaryIds).toContain(replacementSummaryId);
    expect(manager.summaries.get(supersededSummary.summaryId)).toBeDefined();

    // With the graph, over the very same baseline candidates.
    const baselineNodeIds = baseline.items.map((item) =>
      item.sourceType === "raw" ? item.record.id : item.summary.summaryId,
    );
    const withGraph = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "language preference",
      baselineNodeIds,
      snapshot,
      visibilityMode: "default",
    });
    expect(withGraph.rankedNodeIds).not.toContain(supersededSummary.summaryId);
    expect(withGraph.rankedNodeIds).toContain(replacementSummaryId);

    // Suppressed, not destroyed: audit retrieval still reaches it.
    const audit = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "language preference",
      baselineNodeIds,
      snapshot,
      visibilityMode: "audit",
    });
    expect(audit.rankedNodeIds).toContain(supersededSummary.summaryId);

    // Negative control. Same retrieval, same mechanics, with only the graph's
    // record of the supersession removed. If the summary still disappeared,
    // something other than that knowledge would be doing the work.
    const withoutSupersessionKnowledge = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "language preference",
      baselineNodeIds,
      snapshot: {
        ...snapshot,
        nodes: snapshot.nodes.map((node) =>
          node.id === supersededSummary.summaryId
            ? { ...node, visibility: "default" as const }
            : node,
        ),
      },
      visibilityMode: "default",
    });
    expect(withoutSupersessionKnowledge.rankedNodeIds).toContain(
      supersededSummary.summaryId,
    );
  });

  // MR-4 requires supersession to follow sustained evidence, not recency. The
  // one-off arm is the control: identical mechanics, less evidence. If the
  // graph simply retired whatever was contradicted, it would fire there too.
  it("supersedes a stable preference only when the contradiction is sustained", async () => {
    async function contradict(englishCount: number) {
      const manager = new GovernanceRuntimeTestManager();
      const seeded = await seedConsolidated(manager);
      for (let index = 0; index < englishCount; index += 1) {
        await storeEvidence(
          manager,
          [rawMessage(`en-${index}`, { relationValue: "en" })],
          NOW + 4000 + index * 1000,
        );
      }
      await runMemoryForgettingCycle(manager as never, OWNER.userId, {
        now: NOW + 9000,
        graphLifecycle: { enabled: true },
      });
      const snapshot = await graph(manager);
      return {
        manager,
        snapshot,
        stablePreferenceId: seeded.summary.summaryId,
        visibility: snapshot.nodes.find(
          (node) => node.id === seeded.summary.summaryId,
        )?.visibility,
      };
    }

    // A single contradicting record must not retire the stable preference.
    const oneOff = await contradict(1);
    expect(oneOff.visibility).toBe("default");
    expect(
      oneOff.snapshot.clusters.map((cluster) => cluster.lifecycleStatus),
    ).not.toContain("superseded");

    // Sustained contradiction retires it, and records why.
    const sustained = await contradict(3);
    expect(sustained.visibility).toBe("audit-only");
    expect(
      sustained.snapshot.clusters.some(
        (cluster) => cluster.lifecycleStatus === "superseded",
      ),
    ).toBe(true);

    // The same evidence, the same two phases, with the graph disabled. The
    // baseline does not produce a wrong answer about supersession — it never
    // forms a representative at all, so it has nothing to supersede. This is a
    // capability the graph adds, not a defect it repairs.
    const baseline = new GovernanceRuntimeTestManager();
    async function ingest(prefix: string, value: string, offset: number) {
      for (const index of [0, 1, 2]) {
        await storeRawMessagesWithGraphEvolution({
          storage: baseline,
          messages: [
            rawMessage(`${prefix}-${index}`, { relationValue: value }),
          ],
          graphEvolution: { enabled: false },
          now: NOW + offset + index * 1000,
        });
      }
      await runMemoryForgettingCycle(baseline as never, OWNER.userId, {
        now: NOW + offset + 3000,
      });
    }
    await ingest("base-zh", "zh", 0);
    await ingest("base-en", "en", 4000);

    expect(baseline.summaries.size).toBe(0);
    expect(
      [...baseline.messages.values()].filter(
        (message) => message.deprecatedAt !== undefined,
      ),
    ).toHaveLength(0);
    const baselineHits = await queryMemoryWithFallback(baseline as never, {
      userId: OWNER.userId,
      limit: 10,
      minRawResultsWithoutFallback: 10,
    });
    const baselineRawIds = baselineHits.items
      .filter((item) => item.sourceType === "raw")
      .map((item) => item.record.id);
    for (const index of [0, 1, 2]) {
      expect(baselineRawIds).toContain(`base-zh-${index}`);
      expect(baselineRawIds).toContain(`base-en-${index}`);
    }
  });

  // MR-4 again, on the other axis: the same sustained contradiction must retire
  // a global preference or leave it alone depending only on whether the new
  // evidence claims global validity. The global arm doubles as the control —
  // identical mechanics and dose with the applicability removed. The baseline
  // has no applicability and forms no representative at all, which the sibling
  // test above already establishes.
  it("lets a task-scoped exception coexist with the preference it contradicts", async () => {
    async function contradictWith(applicability?: Record<string, unknown>) {
      const manager = new GovernanceRuntimeTestManager();
      const seeded = await seedConsolidated(manager);
      for (const index of [0, 1, 2]) {
        await storeEvidence(
          manager,
          [rawMessage(`en-${index}`, { relationValue: "en", applicability })],
          NOW + 4000 + index * 1000,
        );
      }
      await runMemoryForgettingCycle(manager as never, OWNER.userId, {
        now: NOW + 9000,
        graphLifecycle: { enabled: true },
      });
      const snapshot = await graph(manager);
      return {
        preferenceVisibility: snapshot.nodes.find(
          (node) => node.id === seeded.summary.summaryId,
        )?.visibility,
        lifecycles: snapshot.clusters
          .map((cluster) => cluster.lifecycleStatus)
          .sort(),
      };
    }

    // Claiming global validity retires the standing preference.
    const global = await contradictWith(undefined);
    expect(global.preferenceVisibility).toBe("audit-only");
    expect(global.lifecycles).toContain("superseded");

    // The same three records scoped to one task leave it standing, and the
    // exception is kept as its own stable structure rather than merged away.
    const scoped = await contradictWith({ scope: "task", key: "task-1" });
    expect(scoped.preferenceVisibility).toBe("default");
    expect(scoped.lifecycles).not.toContain("superseded");
    expect(scoped.lifecycles).toEqual(["stable", "stable"]);
  });

  // MR-10 asks for retrieval changes to be explainable. Both arms here reach
  // the same result, so nothing about quality is in question — what differs is
  // whether the system can say what it withheld and under which rule.
  it("names the records it withheld, which the baseline cannot", async () => {
    const manager = new GovernanceRuntimeTestManager();
    await seedConsolidated(manager);
    const snapshot = await graph(manager);

    // One candidate set for both arms: ask for the deprecated sources too, so
    // the comparison is about accounting rather than about what was searched.
    const candidates = await queryMemoryWithFallback(manager as never, {
      userId: OWNER.userId,
      limit: 10,
      minRawResultsWithoutFallback: 10,
      includeDeprecated: true,
    });
    const candidateIds = candidates.items.map((item) =>
      item.sourceType === "raw" ? item.record.id : item.summary.summaryId,
    );
    for (const id of ["zh-1", "zh-2", "zh-3"]) {
      expect(candidateIds).toContain(id);
    }

    const withGraph = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "language preference",
      baselineNodeIds: candidateIds,
      snapshot,
      visibilityMode: "default",
    });
    for (const id of ["zh-1", "zh-2", "zh-3"]) {
      expect(withGraph.hiddenDeprecatedNodeIds).toContain(id);
      expect(withGraph.rankedNodeIds).not.toContain(id);
    }
    expect(withGraph.reasonCodes).toContain("default_hides_deprecated_raw");
    expect(withGraph.reasonCodes).toContain(
      "cluster_representative_prioritized",
    );

    // The baseline reaches the same result set and drops the same three
    // records without a trace: its response mentions neither the records nor a
    // rule, so nothing downstream can report what was withheld.
    const baseline = await queryMemoryWithFallback(manager as never, {
      userId: OWNER.userId,
      limit: 10,
      minRawResultsWithoutFallback: 10,
    });
    expect(baseline.items).toHaveLength(withGraph.rankedNodeIds.length);
    expect(
      baseline.items.filter((item) => item.sourceType === "raw"),
    ).toHaveLength(0);
    // Apart from the results themselves the response carries only counters,
    // so there is no field a withheld-record list could occupy.
    const listFields = Object.entries(
      baseline as unknown as Record<string, unknown>,
    )
      .filter(([key, value]) => key !== "items" && Array.isArray(value))
      .map(([key]) => key);
    expect(listFields).toHaveLength(0);

    // Negative control: with the deprecation record removed from the snapshot
    // the accounting disappears, so it follows that record rather than the
    // shape of the query.
    const withoutDeprecationRecord = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "language preference",
      baselineNodeIds: candidateIds,
      snapshot: {
        ...snapshot,
        nodes: snapshot.nodes.map((node) =>
          node.type === "raw"
            ? { ...node, visibility: "default" as const }
            : node,
        ),
      },
      visibilityMode: "default",
    });
    expect(withoutDeprecationRecord.hiddenDeprecatedNodeIds).toHaveLength(0);
  });

  // G2. The demonstrations above each show something the graph does. This asks
  // the opposite question over the same machinery: of everything the baseline
  // would have returned, does the enabled path drop anything without being able
  // to say which record and under which rule. A silent drop is the failure mode
  // that makes turning defaults on unsafe, and no test that checks only what
  // survived can see it.
  it("accounts for every baseline result the enabled path withholds", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { summary: supersededSummary } = await seedConsolidated(manager);
    for (const [index, id] of ["en-1", "en-2", "en-3"].entries()) {
      await storeEvidence(
        manager,
        [rawMessage(id, { relationValue: "en" })],
        NOW + 4000 + index * 1000,
      );
    }
    await runMemoryForgettingCycle(manager as never, OWNER.userId, {
      now: NOW + 7000,
      graphLifecycle: { enabled: true },
    });
    await storeEvidence(
      manager,
      [
        rawMessage("scoped-1", {
          applicability: { scope: "task", key: "task-x" },
        }),
      ],
      NOW + 8000,
    );
    await storeEvidence(
      manager,
      [rawMessage("stale-1", { relationValue: "fr" })],
      NOW + 8500,
    );
    const other = { userId: "user-2" } satisfies OwnerScope;
    await storeEvidence(
      manager,
      [rawMessage("foreign-1", { userId: other.userId })],
      NOW + 9000,
      other,
    );

    // A candidate index shared across owners can surface a foreign record, and
    // a graph that lags ingestion has never seen some of what the baseline
    // finds. Both are handed in so the retrieval path has to refuse them rather
    // than be shielded from them by the fixture.
    const ownerSnapshot = await graph(manager);
    const otherSnapshot = await graph(manager, other);
    expect(otherSnapshot.nodes.map((node) => node.id)).toContain("foreign-1");
    const snapshot = {
      ...ownerSnapshot,
      // `deprecated` is a state the visibility type allows and the retrieval
      // rules treat distinctly, but no write path in the repository produces
      // it. Setting it here is the only way to reach that rule.
      nodes: [...ownerSnapshot.nodes, ...otherSnapshot.nodes].map((node) =>
        node.id === "stale-1"
          ? { ...node, visibility: "deprecated" as const }
          : node,
      ),
    };

    const baseline = await queryMemoryWithFallback(manager as never, {
      userId: OWNER.userId,
      limit: 20,
      minRawResultsWithoutFallback: 20,
      includeDeprecated: true,
    });
    const baselineNodeIds = [
      ...baseline.items.map((item) =>
        item.sourceType === "raw" ? item.record.id : item.summary.summaryId,
      ),
      "foreign-1",
      "absent-1",
    ];
    for (const id of ["zh-1", "scoped-1", supersededSummary.summaryId]) {
      expect(baselineNodeIds).toContain(id);
    }

    const withGraph = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "language preference",
      baselineNodeIds,
      snapshot,
      visibilityMode: "default",
    });

    const withheld = baselineNodeIds.filter(
      (nodeId) => !withGraph.rankedNodeIds.includes(nodeId),
    );
    for (const id of [
      "zh-1",
      "stale-1",
      "scoped-1",
      "foreign-1",
      "absent-1",
      supersededSummary.summaryId,
    ]) {
      expect(withheld).toContain(id);
    }

    // Nothing is dropped anonymously, and each drop names a rule rather than
    // just a count.
    const accounted = new Map(
      withGraph.withheldBaselineNodes.map((entry) => [
        entry.nodeId,
        entry.reason,
      ]),
    );
    expect(withheld.filter((nodeId) => !accounted.has(nodeId))).toEqual([]);
    expect([...accounted.values()]).not.toContain("unexplained");
    expect(withGraph.reasonCodes).not.toContain(
      "baseline_withheld_without_reason",
    );
    expect(accounted.get("zh-1")).toBe("audit-only");
    expect(accounted.get(supersededSummary.summaryId)).toBe("audit-only");
    expect(accounted.get("stale-1")).toBe("deprecated");
    expect(accounted.get("scoped-1")).toBe("out-of-applicability");
    expect(accounted.get("foreign-1")).toBe("out-of-owner-scope");
    expect(accounted.get("absent-1")).toBe("absent-from-graph");

    // A visibility decision hides a record; it must not remove it. A scope or
    // applicability decision has to do the opposite and stay unreachable in
    // every mode, so the two are asserted apart rather than folded into one
    // "still reachable" claim. Audit mode alone does not restore a `deprecated`
    // node, so the recovery path G2 relies on is audit mode plus
    // `includeDeprecated` rather than audit mode by itself.
    const audit = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "language preference",
      baselineNodeIds,
      snapshot,
      visibilityMode: "audit",
      includeDeprecated: true,
    });
    for (const [nodeId, reason] of accounted) {
      if (reason === "deprecated" || reason === "audit-only") {
        expect(audit.rankedNodeIds, `${nodeId} lost to audit`).toContain(
          nodeId,
        );
      } else {
        expect(audit.rankedNodeIds, `${nodeId} leaked to audit`).not.toContain(
          nodeId,
        );
      }
    }

    // The other direction. Over that candidate set the graph adds nothing, so
    // asserting on it would prove nothing. The case where it does add is a
    // baseline that surfaced a cluster member without its representative,
    // which is what a semantic hit on one raw record looks like.
    const narrow = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "language preference",
      baselineNodeIds: ["en-1"],
      snapshot,
      visibilityMode: "default",
    });
    const added = narrow.rankedNodeIds.filter((nodeId) => nodeId !== "en-1");
    expect(added.length).toBeGreaterThan(0);
    // Nothing enters the result the baseline did not surface unless the graph
    // itself can say why. Inferring the justification from the snapshot would
    // let the test do the explaining that G2 asks the graph to do.
    const admitted = new Map(
      narrow.addedBeyondBaselineNodes.map((entry) => [
        entry.nodeId,
        entry.reason,
      ]),
    );
    expect(added.filter((nodeId) => !admitted.has(nodeId))).toEqual([]);
    expect([...admitted.values()]).not.toContain("unexplained");
    for (const nodeId of added) {
      expect(admitted.get(nodeId), `unjustified addition: ${nodeId}`).toBe(
        "cluster-representative",
      );
    }
  });

  // The acceptance table asks that repeated consistent evidence reinforce one
  // cluster and improve its retrieval priority. Only the first half turns out to
  // be the graph's doing. Repetition consolidates, which changes what retrieval
  // returns; the ordering the requirement describes is produced by the baseline
  // retriever, and the last arm here is what establishes that rather than
  // assuming it either way.
  it("represents a repeated preference by one summary, and reorders nothing the baseline already ordered", async () => {
    async function arm(dose: number, graphLifecycleEnabled: boolean) {
      const manager = new GovernanceRuntimeTestManager();
      for (let index = 0; index < dose; index += 1) {
        await storeEvidence(
          manager,
          [
            rawMessage(`zh-${index + 1}`, {
              timestamp: Math.floor(NOW / 1000) + index,
            }),
          ],
          NOW + index * 1000,
        );
      }
      // A second, unrelated topic so "priority" has something to be measured
      // against. One observation, so it never consolidates in any arm.
      await storeEvidence(
        manager,
        [
          rawMessage("proj-1", {
            relationGroup: "project",
            relationValue: "atlas",
          }),
        ],
        NOW + 3500,
      );
      await runMemoryForgettingCycle(manager as never, OWNER.userId, {
        now: NOW + 4000,
        graphLifecycle: { enabled: graphLifecycleEnabled },
      });
      const snapshot = await graph(manager);
      const baseline = await queryMemoryWithFallback(manager as never, {
        userId: OWNER.userId,
        limit: 20,
        minRawResultsWithoutFallback: 20,
      });
      return {
        snapshot,
        cluster: snapshot.clusters.find(
          (candidate) => candidate.clusterId === "cluster:zh-1",
        ),
        baselineNodeIds: baseline.items.map((item) =>
          item.sourceType === "raw" ? item.record.id : item.summary.summaryId,
        ),
      };
    }

    // Sustained evidence. The cluster reaches `stable`, gains a representative,
    // and retrieval returns that one record in place of its three sources.
    const sustained = await arm(3, true);
    expect(sustained.cluster?.lifecycleStatus).toBe("stable");
    const representativeId = sustained.cluster?.representativeNodeId;
    expect(representativeId).toBeDefined();
    expect(sustained.baselineNodeIds).toEqual([representativeId, "proj-1"]);

    // Dose control: identical content and mechanics, one observation. Nothing
    // consolidates, so the evidence is still retrieved as itself.
    const single = await arm(1, true);
    expect(single.cluster?.lifecycleStatus).toBe("forming");
    expect(single.cluster?.representativeNodeId).toBeUndefined();
    expect(single.baselineNodeIds).toEqual(["zh-1", "proj-1"]);

    // Baseline arm: the same three observations with graph lifecycle disabled
    // produce no summary at all, so this is a capability the graph adds rather
    // than a baseline defect it repairs.
    const withoutGraph = await arm(3, false);
    expect(withoutGraph.cluster?.representativeNodeId).toBeUndefined();
    expect(withoutGraph.baselineNodeIds).toEqual([
      "zh-3",
      "zh-2",
      "zh-1",
      "proj-1",
    ]);

    // The sources are represented, not lost.
    const audit = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "preference",
      baselineNodeIds: ["zh-1", "zh-2", "zh-3"],
      snapshot: sustained.snapshot,
      visibilityMode: "audit",
      includeDeprecated: true,
    });
    for (const id of ["zh-1", "zh-2", "zh-3"]) {
      expect(audit.rankedNodeIds).toContain(id);
    }

    // And the half of the claim that is not the graph's. Given the order the
    // real retriever produces, graph-aware ranking returns it unchanged: the
    // representative is already first without the graph. The rule that would
    // lift it does exist — handed the reverse order it applies — but it never
    // has to, so no priority improvement here is attributable to the graph.
    const rank = (baselineNodeIds: string[]) =>
      buildGraphAwareRetrievalDryRun({
        ownerScope: OWNER,
        query: "preference",
        baselineNodeIds,
        snapshot: sustained.snapshot,
        visibilityMode: "default",
      }).rankedNodeIds;
    expect(rank(sustained.baselineNodeIds)).toEqual(sustained.baselineNodeIds);
    expect(rank([...sustained.baselineNodeIds].reverse())).toEqual([
      representativeId,
      "proj-1",
    ]);
  });

  // MR-4 allows a scoped memory to widen only on repeated support across
  // independent contexts. Same content and same dose in every arm; only the
  // independence of the contexts differs, which makes each arm the control for
  // the one above it.
  it("widens a scoped preference only when independent contexts agree", async () => {
    async function contexts(
      entries: Array<{
        scope: "task" | "conversation";
        key: string;
        source: string;
        validUntil?: number;
      }>,
    ) {
      const manager = new GovernanceRuntimeTestManager();
      const { summary } = await seedConsolidated(manager);
      for (const [index, entry] of entries.entries()) {
        await storeEvidence(
          manager,
          [
            rawMessage(`en-${index + 1}`, {
              relationValue: "en",
              applicability: {
                scope: entry.scope,
                key: entry.key,
                ...(entry.validUntil === undefined
                  ? {}
                  : { validUntil: entry.validUntil }),
              },
              sourceIdentity: entry.source,
              timestamp: Math.floor(NOW / 1000) + 10 + index,
            }),
          ],
          NOW + 4000 + index * 1000,
        );
      }
      const snapshot = await graph(manager);
      const scoped = snapshot.clusters.filter((cluster) =>
        cluster.clusterId.startsWith("cluster:en-"),
      );
      return {
        standing: snapshot.clusters.find(
          (cluster) => cluster.clusterId === "cluster:zh-1",
        ),
        summaryId: summary.summaryId,
        scopes: scoped.map((cluster) => cluster.applicability?.scope),
        broadened: scoped.filter((cluster) =>
          cluster.reasonCodes.includes(
            "applicability_broadened_across_contexts",
          ),
        ).length,
      };
    }

    // Three contexts, three distinct sources. The scoped memory widens, and the
    // standing global preference is challenged rather than replaced: it is still
    // `stable` and still the active representative.
    const independent = await contexts([
      { scope: "task", key: "t1", source: "src-a" },
      { scope: "task", key: "t2", source: "src-b" },
      { scope: "conversation", key: "c3", source: "src-c" },
    ]);
    expect(independent.scopes).toEqual(["global", "global", "global"]);
    expect(independent.broadened).toBe(3);
    expect(independent.standing?.lifecycleStatus).toBe("stable");
    expect(independent.standing?.representativeNodeId).toBe(
      independent.summaryId,
    );

    // Two contexts is not repeated support across independent contexts. Same
    // sources, same content, one fewer context.
    const two = await contexts([
      { scope: "task", key: "t1", source: "src-a" },
      { scope: "task", key: "t2", source: "src-b" },
    ]);
    expect(two.scopes).toEqual(["task", "task"]);
    expect(two.broadened).toBe(0);

    // Time-limited evidence keeps its window. Widening the scope of something
    // that expires would outlive the evidence, so these do not widen at any
    // count.
    const timeLimited = await contexts([
      { scope: "task", key: "t1", source: "src-a", validUntil: NOW + 100_000 },
      { scope: "task", key: "t2", source: "src-b", validUntil: NOW + 100_000 },
      {
        scope: "conversation",
        key: "c3",
        source: "src-c",
        validUntil: NOW + 100_000,
      },
    ]);
    expect(timeLimited.scopes).toEqual(["task", "task", "conversation"]);
    expect(timeLimited.broadened).toBe(0);
  });

  it("keeps the summary active when restore capability is missing or fails", async () => {
    const missing = new GovernanceRuntimeTestManager({
      supportsRestore: false,
    });
    const missingSeed = await seedConsolidated(missing);
    const missingResult = await runMemoryGraphRollback({
      storage: missing,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "rollback-without-adapter",
        reason: "Review rollback",
        summaryId: missingSeed.summary.summaryId,
      },
    });
    expect(missingResult).toEqual(
      expect.objectContaining({
        status: "partial-failure",
        reasonCodes: expect.arrayContaining([
          "adapter_missing_restore_deprecated_messages",
        ]),
      }),
    );
    expect(
      (await graph(missing)).nodes.find(
        (node) => node.id === missingSeed.summary.summaryId,
      )?.visibility,
    ).toBe("default");

    const failing = new GovernanceRuntimeTestManager();
    const failingSeed = await seedConsolidated(failing);
    failing.failRestoreWrites = 1;
    const failed = await runMemoryGraphRollback({
      storage: failing,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "rollback-failing-adapter",
        reason: "Review rollback",
        summaryId: failingSeed.summary.summaryId,
      },
    });
    expect(failed.status).toBe("partial-failure");
    expect(
      (await graph(failing)).nodes.find(
        (node) => node.id === failingSeed.summary.summaryId,
      )?.visibility,
    ).toBe("default");
  });

  it("does not retire the representative when raw restoration makes no progress", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { summary } = await seedConsolidated(manager);
    const command = {
      commandId: "rollback-silent-noop-adapter",
      reason: "Do not retire the representative until raw records are visible",
      summaryId: summary.summaryId,
    };
    manager.noopRestoreWrites = 1;

    const blocked = await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command,
    });
    expect(blocked).toEqual(
      expect.objectContaining({
        status: "partial-failure",
        reasonCodes: ["memory_graph_rollback_source_restore_incomplete"],
      }),
    );
    expect(
      (await graph(manager)).nodes.find((node) => node.id === summary.summaryId)
        ?.visibility,
    ).toBe("default");
    expect(manager.messages.get("zh-1")?.deprecatedAt).toBeDefined();

    const retried = await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 5000,
      command,
    });
    expect(retried.status).toBe("applied");
    expect(
      (await graph(manager)).nodes.find((node) => node.id === summary.summaryId)
        ?.visibility,
    ).toBe("audit-only");
    expect(manager.messages.get("zh-1")?.deprecatedAt).toBeUndefined();
  });

  it("replays an applied correction with its original expected version", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, snapshot } = await seedConsolidated(manager);
    const command = {
      commandId: "expected-version-replay",
      reason: "Keep the reviewed lifecycle decision idempotent",
      expectedVersion: snapshot.version,
      action: {
        type: "set-lifecycle" as const,
        clusterId: cluster.clusterId,
        lifecycleStatus: "active" as const,
      },
    };
    const applied = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command,
    });
    expect(applied.status).toBe("applied");

    const replayed = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command,
    });
    expect(replayed.status).toBe("replayed");
    expect((await graph(manager)).clusters[0].lifecycleStatus).toBe("active");
  });

  it("rejects reuse of a correction command id with different content", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary, snapshot } = await seedConsolidated(manager);
    const first = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "stable-correction-command",
        reason: "Apply reviewed wording",
        expectedVersion: snapshot.version,
        action: {
          type: "correct-summary",
          clusterId: cluster.clusterId,
          summaryId: summary.summaryId,
          correctedContent: "First reviewed wording.",
        },
      },
    });
    expect(first.status).toBe("applied");
    const correctedSummaryId = first.summaryId ?? "";

    const collision = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "stable-correction-command",
        reason: "Apply reviewed wording",
        expectedVersion: snapshot.version,
        action: {
          type: "correct-summary",
          clusterId: cluster.clusterId,
          summaryId: summary.summaryId,
          correctedContent: "Different wording under the same command id.",
        },
      },
    });
    expect(collision).toEqual(
      expect.objectContaining({
        status: "conflict",
        reasonCodes: ["memory_graph_command_id_payload_conflict"],
      }),
    );
    expect(manager.summaries.get(correctedSummaryId)?.summaryText).toBe(
      "First reviewed wording.",
    );
  });

  it("rejects correction identifiers that collide with unrelated graph state", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    const before = await graph(manager);

    const clusterCollision = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "separated-cluster-id-collision",
        reason: "Do not overwrite the source cluster",
        action: {
          type: "remove-member",
          clusterId: cluster.clusterId,
          nodeId: "zh-3",
          separatedClusterId: cluster.clusterId,
        },
      },
    });
    expect(clusterCollision).toEqual(
      expect.objectContaining({
        status: "no-op",
        reasonCodes: expect.arrayContaining([
          "memory_graph_correction_separated_cluster_id_conflict",
        ]),
      }),
    );

    const nodeCollision = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "corrected-summary-id-collision",
        reason: "Do not overwrite retained raw evidence",
        action: {
          type: "correct-summary",
          clusterId: cluster.clusterId,
          summaryId: summary.summaryId,
          correctedSummaryId: "zh-1",
          correctedContent: "Reviewed preference.",
        },
      },
    });
    expect(nodeCollision).toEqual(
      expect.objectContaining({
        status: "no-op",
        reasonCodes: expect.arrayContaining([
          "memory_graph_correction_corrected_summary_id_conflict",
        ]),
      }),
    );
    manager.summaries.set("unlinked-summary-store-id", {
      ...summary,
      summaryId: "unlinked-summary-store-id",
      summaryText: "An unrelated retained summary.",
    });
    const summaryStoreCollision = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "corrected-summary-store-id-collision",
        reason: "Do not overwrite an unlinked stored summary",
        action: {
          type: "correct-summary",
          clusterId: cluster.clusterId,
          summaryId: summary.summaryId,
          correctedSummaryId: "unlinked-summary-store-id",
          correctedContent: "Reviewed preference.",
        },
      },
    });
    expect(summaryStoreCollision).toEqual(
      expect.objectContaining({
        status: "no-op",
        reasonCodes: expect.arrayContaining([
          "memory_graph_correction_corrected_summary_id_conflict",
        ]),
      }),
    );
    expect(
      manager.summaries.get("unlinked-summary-store-id")?.summaryText,
    ).toBe("An unrelated retained summary.");

    expect(await graph(manager)).toEqual(before);
  });

  it("rejects a summary correction sourced from outside the target cluster", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    const foreignSummaryId = "foreign-summary";
    manager.summaries.set(foreignSummaryId, {
      ...summary,
      summaryId: foreignSummaryId,
      summaryText: "Unrelated summary content.",
    });

    const result = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "foreign-summary-correction",
        reason: "Reject cross-cluster provenance",
        action: {
          type: "correct-summary",
          clusterId: cluster.clusterId,
          summaryId: foreignSummaryId,
          correctedContent: "This must not become the cluster representative.",
        },
      },
    });
    expect(result).toEqual(
      expect.objectContaining({
        status: "no-op",
        reasonCodes: expect.arrayContaining([
          "memory_graph_summary_not_found_or_scope_mismatch",
        ]),
      }),
    );
    expect(manager.summaries.size).toBe(2);
    expect((await graph(manager)).clusters[0].representativeNodeId).toBe(
      summary.summaryId,
    );
  });

  it("rejects stale or cross-scope corrections before dependent mutation", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, snapshot } = await seedConsolidated(manager);
    const before = await graph(manager);
    const stale = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "stale-correction",
        reason: "stale review",
        expectedVersion: String(Number(snapshot.version ?? "0") - 1),
        action: {
          type: "remove-member",
          clusterId: cluster.clusterId,
          nodeId: "zh-3",
        },
      },
    });
    expect(stale.status).toBe("conflict");
    expect(await graph(manager)).toEqual(before);

    const wrongCluster = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "wrong-cluster-correction",
        reason: "wrong cluster",
        action: {
          type: "remove-member",
          clusterId: "missing-cluster",
          nodeId: "zh-3",
        },
      },
    });
    expect(wrongCluster.status).toBe("no-op");
    expect(manager.messages.get("zh-3")?.deprecatedAt).toBeDefined();

    const wrongScope = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "wrong-workspace-correction",
        reason: "wrong workspace",
        workspaceId: "workspace-b",
        action: {
          type: "remove-member",
          clusterId: cluster.clusterId,
          nodeId: "zh-3",
        },
      },
    });
    expect(wrongScope).toEqual(
      expect.objectContaining({
        status: "no-op",
        reasonCodes: expect.arrayContaining(["memory_graph_scope_mismatch"]),
      }),
    );
    expect(await graph(manager)).toEqual(before);
  });

  it("exposes competing alternatives and builds rollout decisions from persisted evidence", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    await runMemoryGraphRollback({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "evaluation-rollback",
        reason: "Restore raw evidence",
        summaryId: summary.summaryId,
      },
    });
    await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 5000,
      command: {
        commandId: "evaluation-correction",
        reason: "Separate a polluted source",
        action: {
          type: "remove-member",
          clusterId: cluster.clusterId,
          nodeId: "zh-3",
        },
      },
    });
    const blocked = await runMemoryGraphRolloutEvaluation({
      storage: manager,
      userId: OWNER.userId,
      scenarioId: "missing-semantic-artifact",
    });
    expect(blocked.report.summary.decision).toBe("blocked");
    expect(blocked.reasonCodes).toContain(
      "memory_graph_required_semantic_eval_artifact_missing",
    );

    const ready = await runMemoryGraphRolloutEvaluation({
      storage: manager,
      userId: OWNER.userId,
      scenarioId: "persisted-runtime-artifacts",
      queryEmbedding: [1, 0],
      pollutedArtifactIds: ["zh-3"],
    });
    expect(ready.runtimeEvidence.correctionOperationIds.length).toBeGreaterThan(
      0,
    );
    expect(ready.runtimeEvidence.rollbackOperationIds.length).toBeGreaterThan(
      0,
    );
    expect(ready.report.summary.decision).toBe("ready-for-limited-rollout");
    expect(
      ready.report.graphRetrievalScenarios.find(
        (scenario) => scenario.scenarioId === "runtime-audit-retrieval",
      )?.auditTrailNodeIds,
    ).toContain(summary.summaryId);

    const crossScopeSemantic = rawMessage("cross-scope-semantic");
    crossScopeSemantic.metadata = {
      ...(crossScopeSemantic.metadata ?? {}),
      memoryOwnerScope: {
        userId: OWNER.userId,
        workspaceId: "other-workspace",
      },
    };
    await manager.storeMessage(crossScopeSemantic);
    const contaminated = await runMemoryGraphRolloutEvaluation({
      storage: manager,
      userId: OWNER.userId,
      scenarioId: "semantic-cross-scope-contamination",
      queryEmbedding: [1, 0],
      pollutedArtifactIds: ["zh-3"],
    });
    expect(contaminated.report.summary.decision).toBe("blocked");
    expect(contaminated.report.semanticRetrievalScenarios[0]?.metadata).toEqual(
      expect.objectContaining({
        crossScopeRecordIds: ["cross-scope-semantic"],
      }),
    );

    const competitionManager = new GovernanceRuntimeTestManager();
    await storeEvidence(competitionManager, [rawMessage("global-zh")]);
    await storeEvidence(
      competitionManager,
      [rawMessage("global-en", { relationValue: "en" })],
      NOW + 1000,
    );
    await storeEvidence(
      competitionManager,
      [rawMessage("global-ja", { relationValue: "ja" })],
      NOW + 2000,
    );
    const competition = await graph(competitionManager);
    const conflict = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "language preference",
      baselineNodeIds: ["global-zh"],
      snapshot: competition,
      visibilityMode: "conflict",
    });
    expect(conflict.reasonCodes).toContain("competing_alternatives_exposed");
    expect(conflict.rankedNodeIds).toEqual(
      expect.arrayContaining(["global-zh", "global-en", "global-ja"]),
    );
  });

  it("does not attach an unlinked summary to a target graph cluster", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    const unrelatedSummary = {
      ...summary,
      summaryId: "unlinked-summary",
      sourceRecordIds: ["unlinked-source"],
      summaryText: "Unrelated workspace summary.",
    };
    await manager.upsertSummaries([unrelatedSummary]);
    const before = await graph(manager);
    const result = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "reject-unlinked-summary",
        reason: "The target summary belongs to another graph scope",
        action: {
          type: "correct-summary",
          clusterId: cluster.clusterId,
          summaryId: unrelatedSummary.summaryId,
          correctedContent: "This correction must not cross graph scope.",
        },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "no-op",
        reasonCodes: expect.arrayContaining([
          "memory_graph_summary_not_found_or_scope_mismatch",
        ]),
      }),
    );
    expect(manager.summaries.get(unrelatedSummary.summaryId)?.summaryText).toBe(
      unrelatedSummary.summaryText,
    );
    expect(await graph(manager)).toEqual(before);
  });
});

describe("memory graph control-plane regressions", () => {
  it("finds a correction target beyond the first summary page", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    manager.summaries.clear();
    for (let index = 0; index < 1000; index += 1) {
      manager.summaries.set(`decoy-summary-${index}`, {
        ...summary,
        summaryId: `decoy-summary-${index}`,
      });
    }
    manager.summaries.set(summary.summaryId, summary);

    const result = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "correct-summary-after-first-page",
        reason: "Resolve the target by id instead of scanning one page",
        action: {
          type: "correct-summary",
          clusterId: cluster.clusterId,
          summaryId: summary.summaryId,
          correctedSummaryId: "corrected-summary-after-first-page",
          correctedContent: "The reviewed preference is Chinese responses.",
        },
      },
    });

    expect(result.status).toBe("applied");
    expect(
      manager.summaries.get("corrected-summary-after-first-page")?.summaryText,
    ).toBe("The reviewed preference is Chinese responses.");
  });

  it("does not treat delimiter-colliding owner scopes as equal", () => {
    const requestedScope = {
      tenantId: "tenant",
      workspaceId: "workspace|segment",
      userId: "user",
    } satisfies OwnerScope;
    const foreignScope = {
      tenantId: "tenant|workspace",
      workspaceId: "segment",
      userId: "user",
    } satisfies OwnerScope;
    const snapshot = {
      ownerScope: requestedScope,
      nodes: [],
      edges: [],
      clusters: [
        {
          clusterId: "foreign-cluster",
          ownerScope: foreignScope,
          nodeIds: [],
          lifecycleStatus: "forming",
          supportScore: 0,
          updatedAt: NOW,
          reasonCodes: [],
        },
      ],
      version: "1",
      capturedAt: NOW,
    } satisfies MemoryGraphSnapshot;

    const plan = buildMemoryGraphCorrectionPlan({
      ownerScope: requestedScope,
      snapshot,
      commandId: "scope-delimiter-collision",
      reason: "Keep tenant and workspace boundaries exact",
      now: NOW,
      persistence: { mode: "write", enabled: true },
      action: {
        type: "set-lifecycle",
        clusterId: "foreign-cluster",
        lifecycleStatus: "active",
      },
    });

    expect(plan.operations).toEqual([]);
    expect(plan.reasonCodes).toContain(
      "memory_graph_correction_cluster_not_found",
    );
  });

  it("keeps retired supersession edges available to audit traversal", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster } = await seedConsolidated(manager);
    const result = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command: {
        commandId: "audit-retired-supersession",
        reason: "Preserve the retired representative chain for audit",
        action: {
          type: "remove-member",
          clusterId: cluster.clusterId,
          nodeId: "zh-3",
        },
      },
    });
    expect(result.status).toBe("applied");
    if (!cluster.representativeNodeId) {
      throw new Error(
        "expected the consolidated fixture to have a representative",
      );
    }
    const snapshot = await graph(manager);
    const retiredSupersedeEdge = snapshot.edges.find(
      (edge) =>
        edge.kind === "supersede" &&
        edge.toNodeId === cluster.representativeNodeId &&
        edge.metadata?.inactive === true,
    );
    if (!retiredSupersedeEdge) {
      throw new Error("expected an inactive supersession edge");
    }
    const audit = buildGraphAwareRetrievalDryRun({
      ownerScope: OWNER,
      query: "language preference",
      baselineNodeIds: [cluster.representativeNodeId],
      snapshot,
      visibilityMode: "audit",
      includeDeprecated: true,
    });
    expect(audit.auditTrail?.flatMap((trail) => trail.edgeIds)).toContain(
      retiredSupersedeEdge.id,
    );
  });

  it("does not move a competing node across clusters when setting a representative", async () => {
    const manager = new GovernanceRuntimeTestManager();
    await storeEvidence(manager, [rawMessage("global-zh")]);
    await storeEvidence(
      manager,
      [rawMessage("global-en", { relationValue: "en" })],
      NOW + 1000,
    );
    await storeEvidence(
      manager,
      [rawMessage("global-ja", { relationValue: "ja" })],
      NOW + 2000,
    );
    const before = await graph(manager);
    const sourceCluster = before.clusters.find((cluster) =>
      cluster.nodeIds.includes("global-zh"),
    );
    const competingCluster = before.clusters.find(
      (cluster) =>
        cluster.clusterId !== sourceCluster?.clusterId &&
        cluster.nodeIds.includes("global-en"),
    );
    if (!sourceCluster || !competingCluster) {
      throw new Error("expected independent competing clusters");
    }
    const result = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      command: {
        commandId: "reject-cross-cluster-representative",
        reason: "A representative cannot silently move between clusters",
        action: {
          type: "set-representative",
          clusterId: sourceCluster.clusterId,
          representativeNodeId: "global-en",
        },
      },
    });
    expect(result).toEqual(
      expect.objectContaining({
        status: "no-op",
        reasonCodes: expect.arrayContaining([
          "memory_graph_correction_representative_not_in_cluster",
        ]),
      }),
    );
    expect(await graph(manager)).toEqual(before);
  });

  it("blocks pending summary publication and passes the convergence gate after retry", async () => {
    const manager = new GovernanceRuntimeTestManager();
    const { cluster, summary } = await seedConsolidated(manager);
    const command = {
      commandId: "rollout-pending-summary",
      reason: "Keep rollout blocked until publication finishes",
      action: {
        type: "correct-summary" as const,
        clusterId: cluster.clusterId,
        summaryId: summary.summaryId,
        correctedSummaryId: "rollout-pending-summary",
        correctedContent: "The reviewed preference is Chinese responses.",
      },
    };
    manager.failSummaryWriteNumbers.add(manager.summaryWriteCount + 2);
    const failed = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 4000,
      command,
    });
    expect(failed.status).toBe("partial-failure");
    const pending = await runMemoryGraphRolloutEvaluation({
      storage: manager,
      userId: OWNER.userId,
      scenarioId: "pending-summary-rollout",
    });
    expect(pending.report.gates).toContainEqual(
      expect.objectContaining({
        gateId: "runtime.publication-convergence",
        passed: false,
        actual: expect.arrayContaining(["rollout-pending-summary"]),
      }),
    );
    const retried = await runMemoryGraphCorrection({
      storage: manager,
      userId: OWNER.userId,
      now: NOW + 5000,
      command,
    });
    expect(retried.status).toBe("replayed");
    const converged = await runMemoryGraphRolloutEvaluation({
      storage: manager,
      userId: OWNER.userId,
      scenarioId: "pending-summary-rollout",
    });
    expect(
      converged.report.gates.find(
        (gate) => gate.gateId === "runtime.publication-convergence",
      )?.passed,
    ).toBe(true);
  });
});
