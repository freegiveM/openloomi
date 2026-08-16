import type {
  GoalEvaluationResult,
  GoalEvidence,
} from "@openloomi/ai/agent/runtime-instructions";
import { describe, expect, it } from "vitest";

import { findRepeatedDeterministicFailure } from "@/lib/ai/runtime-instructions/goal-failure-circuit-breaker";

const INCOMPLETE: GoalEvaluationResult = {
  completed: false,
  confidence: 1,
  satisfiedCriteria: [],
  missingCriteria: ["step-1"],
  evidence: [],
  reason: "step-1 remains incomplete",
};

describe("Goal deterministic failure circuit breaker", () => {
  it("detects the same stable failure across three persisted instructions", () => {
    const evidence = [1, 2, 3].map((attempt) =>
      failedCommand(
        attempt,
        `helper launch failed: request ${uuid(100 + attempt)} program not found`,
      ),
    );

    const result = findRepeatedDeterministicFailure({
      // Model a new controller reading a reconstructed durable snapshot.
      evidence: structuredClone(evidence),
      previousEvaluation: structuredClone(INCOMPLETE),
      evaluation: structuredClone(INCOMPLETE),
    });

    expect(result).toMatchObject({
      attempts: 3,
      description: expect.stringContaining("program not found"),
    });
    expect(result?.fingerprint).toContain("<id>");
  });

  it("counts a replayed instruction only once", () => {
    const evidence = [1, 2, 3].map((event) =>
      failedCommand(1, "sandbox helper is missing", event),
    );

    expect(repeatedFailure(evidence)).toBeUndefined();
  });

  it("does not let unrelated success hide a repeated failure", () => {
    const evidence = [
      failedCommand(1),
      successfulFileChange(1),
      failedCommand(2),
      successfulFileChange(2),
      failedCommand(3),
      successfulFileChange(3),
    ];

    expect(repeatedFailure(evidence)).toMatchObject({ attempts: 3 });
  });

  it("resets failures when the same operation succeeds", () => {
    const evidence = [
      failedCommand(1),
      failedCommand(2),
      successfulCommand(3),
      failedCommand(4),
      failedCommand(5),
    ];

    expect(repeatedFailure(evidence)).toBeUndefined();
  });

  it("resets failures at persisted criterion progress", () => {
    const progressEvidence = agentReport(3);
    const progressed: GoalEvaluationResult = {
      completed: false,
      confidence: 1,
      satisfiedCriteria: ["step-1"],
      missingCriteria: ["step-2"],
      evidence: [{ criterionId: "step-1", evidenceIds: [progressEvidence.id] }],
      reason: "step-2 remains incomplete",
    };
    const evidence = [
      failedCommand(1),
      failedCommand(2),
      progressEvidence,
      failedCommand(4),
      failedCommand(5),
    ];

    expect(
      findRepeatedDeterministicFailure({
        evidence,
        previousEvaluation: progressed,
        evaluation: progressed,
      }),
    ).toBeUndefined();
  });

  it("does not stop three different failures", () => {
    const evidence = [
      failedCommand(1, "network unavailable"),
      failedCommand(2, "permission denied"),
      failedCommand(3, "compiler syntax error"),
    ];

    expect(repeatedFailure(evidence)).toBeUndefined();
  });

  it("uses sorted paths to distinguish failed file changes", () => {
    expect(
      repeatedFailure([
        failedFileChange(1, ["src/b.ts", "src/a.ts"]),
        failedFileChange(2, ["src/a.ts", "src/b.ts"]),
        failedFileChange(3, ["src/a.ts", "src/b.ts"]),
      ]),
    ).toMatchObject({ attempts: 3 });

    expect(
      repeatedFailure([
        failedFileChange(1, ["src/a.ts"]),
        failedFileChange(2, ["src/b.ts"]),
        failedFileChange(3, ["src/c.ts"]),
      ]),
    ).toBeUndefined();
  });

  it("does not treat assistant reports as deterministic failures", () => {
    const evidence = [agentReport(1), agentReport(2), agentReport(3)];

    expect(repeatedFailure(evidence)).toBeUndefined();
  });

  it("does not stop on the evaluation that makes criterion progress", () => {
    const evidence = [failedCommand(1), failedCommand(2), failedCommand(3)];
    const progressed: GoalEvaluationResult = {
      ...INCOMPLETE,
      satisfiedCriteria: ["step-1"],
      missingCriteria: ["step-2"],
    };

    expect(
      findRepeatedDeterministicFailure({
        evidence,
        previousEvaluation: INCOMPLETE,
        evaluation: progressed,
      }),
    ).toBeUndefined();
  });
});

function repeatedFailure(evidence: GoalEvidence[]) {
  return findRepeatedDeterministicFailure({
    evidence,
    previousEvaluation: INCOMPLETE,
    evaluation: INCOMPLETE,
  });
}

function failedCommand(
  instruction: number,
  outputPreview = "sandbox helper is missing",
  event = instruction,
): GoalEvidence {
  return evidence({
    instruction,
    event,
    type: "command_result",
    summary: "Command failed: pwsh Get-Location",
    success: false,
    payload: { command: "pwsh Get-Location", outputPreview },
  });
}

function successfulFileChange(instruction: number): GoalEvidence {
  return evidence({
    instruction,
    type: "file_change",
    summary: "File change succeeded: index.html",
    success: true,
    payload: { paths: ["index.html"] },
  });
}

function successfulCommand(instruction: number): GoalEvidence {
  return evidence({
    instruction,
    type: "command_result",
    summary: "Command succeeded: pwsh Get-Location",
    success: true,
    payload: { command: "pwsh Get-Location", outputPreview: "C:\\workspace" },
  });
}

function failedFileChange(instruction: number, paths: string[]): GoalEvidence {
  return evidence({
    instruction,
    type: "tool_result",
    summary: `File change failed: ${paths.join(", ")}`,
    success: false,
    payload: { paths },
  });
}

function agentReport(instruction: number): GoalEvidence {
  return evidence({
    instruction,
    type: "agent_report",
    summary: "Codex assistant report: continuing work",
    payload: { outputPreview: "continuing work" },
  });
}

function evidence(input: {
  instruction: number;
  event?: number;
  type: GoalEvidence["type"];
  summary: string;
  success?: boolean;
  payload: unknown;
}): GoalEvidence {
  const event = input.event ?? input.instruction;
  return {
    id: uuid(1_000 + event),
    goalId: uuid(1),
    goalRunId: uuid(2),
    goalRevision: 1,
    instructionId: uuid(100 + input.instruction),
    type: input.type,
    sourceEventId: `event-${event}`,
    summary: input.summary,
    ...(input.success === undefined ? {} : { success: input.success }),
    payload: input.payload as GoalEvidence["payload"],
    observedAt: new Date(Date.UTC(2026, 7, 15, 0, 0, event)).toISOString(),
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
