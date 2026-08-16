import type {
  GoalEvaluationResult,
  GoalEvidence,
} from "@openloomi/ai/agent/runtime-instructions";

const REPEATED_FAILURE_THRESHOLD = 3;
const MAX_FINGERPRINT_CHARACTERS = 1_024;
const MAX_DESCRIPTION_CHARACTERS = 500;
const FAILURE_EVIDENCE_TYPES = new Set<GoalEvidence["type"]>([
  "command_result",
  "test_result",
  "tool_result",
]);

export interface RepeatedDeterministicFailure {
  attempts: number;
  fingerprint: string;
  description: string;
}

interface FailureAttempt {
  lastEvidenceIndex: number;
  failures: Map<
    string,
    {
      evidence: GoalEvidence;
      evidenceIndex: number;
      operationFingerprint: string | undefined;
    }
  >;
}

/**
 * Finds a repeated, deterministic execution failure without keeping process
 * state. The evidence snapshot is durable, so the guard survives a Runtime
 * restart and provider-event replay cannot increment the attempt count.
 */
export function findRepeatedDeterministicFailure(input: {
  evidence: readonly GoalEvidence[];
  previousEvaluation: GoalEvaluationResult | undefined;
  evaluation: GoalEvaluationResult;
}): RepeatedDeterministicFailure | undefined {
  if (
    !input.previousEvaluation ||
    !sameEvaluationProgress(input.previousEvaluation, input.evaluation)
  ) {
    return undefined;
  }

  const criterionEvidenceIds = new Set(
    input.evaluation.evidence.flatMap(({ evidenceIds }) => evidenceIds),
  );
  let attempts: FailureAttempt[] = [];
  let attemptsByInstruction = new Map<string, FailureAttempt>();

  for (const [evidenceIndex, evidence] of input.evidence.entries()) {
    // Newly proven Goal criteria are authoritative progress. Discard all
    // older failures so they cannot trip the circuit after Goal progress.
    if (criterionEvidenceIds.has(evidence.id)) {
      attempts = [];
      attemptsByInstruction = new Map();
      continue;
    }
    if (evidence.success === true) {
      clearRecoveredOperation(
        attempts,
        attemptsByInstruction,
        operationFingerprint(evidence),
      );
      continue;
    }
    if (
      evidence.success !== false ||
      !FAILURE_EVIDENCE_TYPES.has(evidence.type) ||
      evidence.instructionId === undefined
    ) {
      continue;
    }

    const fingerprint = failureFingerprint(evidence);
    if (!fingerprint) continue;
    let attempt = attemptsByInstruction.get(evidence.instructionId);
    if (!attempt) {
      attempt = {
        lastEvidenceIndex: evidenceIndex,
        failures: new Map(),
      };
      attemptsByInstruction.set(evidence.instructionId, attempt);
      attempts.push(attempt);
    }
    attempt.lastEvidenceIndex = evidenceIndex;
    const previous = attempt.failures.get(fingerprint);
    if (!previous || previous.evidenceIndex < evidenceIndex) {
      attempt.failures.set(fingerprint, {
        evidence,
        evidenceIndex,
        operationFingerprint: operationFingerprint(evidence),
      });
    }
  }

  const recent = attempts
    .sort((left, right) => left.lastEvidenceIndex - right.lastEvidenceIndex)
    .slice(-REPEATED_FAILURE_THRESHOLD);
  if (recent.length < REPEATED_FAILURE_THRESHOLD) return undefined;

  const repeatedFingerprints = [...recent[0].failures.keys()].filter(
    (fingerprint) =>
      recent.every((attempt) => attempt.failures.has(fingerprint)),
  );
  if (repeatedFingerprints.length === 0) return undefined;

  const fingerprint = repeatedFingerprints.sort()[0];
  const latest = recent
    .map((attempt) => attempt.failures.get(fingerprint))
    .filter(
      (
        failure,
      ): failure is {
        evidence: GoalEvidence;
        evidenceIndex: number;
        operationFingerprint: string | undefined;
      } => failure !== undefined,
    )
    .sort((left, right) => right.evidenceIndex - left.evidenceIndex)[0];
  if (!latest) return undefined;

  return {
    attempts: REPEATED_FAILURE_THRESHOLD,
    fingerprint,
    description: failureDescription(latest.evidence),
  };
}

function clearRecoveredOperation(
  attempts: FailureAttempt[],
  attemptsByInstruction: Map<string, FailureAttempt>,
  recoveredOperation: string | undefined,
): void {
  if (!recoveredOperation) return;
  for (const [instructionId, attempt] of attemptsByInstruction) {
    for (const [fingerprint, failure] of attempt.failures) {
      if (failure.operationFingerprint === recoveredOperation) {
        attempt.failures.delete(fingerprint);
      }
    }
    if (attempt.failures.size === 0) {
      attemptsByInstruction.delete(instructionId);
      const index = attempts.indexOf(attempt);
      if (index >= 0) attempts.splice(index, 1);
    }
  }
}

function sameEvaluationProgress(
  left: GoalEvaluationResult,
  right: GoalEvaluationResult,
): boolean {
  return progressFingerprint(left) === progressFingerprint(right);
}

function progressFingerprint(evaluation: GoalEvaluationResult): string {
  return JSON.stringify({
    satisfiedCriteria: [...evaluation.satisfiedCriteria].sort(),
    missingCriteria: [...evaluation.missingCriteria].sort(),
    evidence: evaluation.evidence
      .map(({ criterionId, evidenceIds }) => ({
        criterionId,
        evidenceIds: [...evidenceIds].sort(),
      }))
      .sort((left, right) => left.criterionId.localeCompare(right.criterionId)),
  });
}

function failureFingerprint(evidence: GoalEvidence): string | undefined {
  const payload = asRecord(evidence.payload);
  const detail =
    stringField(payload, "error") ?? stringField(payload, "outputPreview");
  if (detail) {
    return boundedFingerprint(`${evidence.type}:detail:${detail}`);
  }

  const command = stringField(payload, "command");
  if (command) {
    return boundedFingerprint(`${evidence.type}:command:${command}`);
  }

  const toolName = stringField(payload, "toolName");
  const paths = stringArrayField(payload, "paths");
  if (evidence.type === "tool_result" && paths.length > 0) {
    const stablePaths = paths.map((path) => path.trim().toLowerCase()).sort();
    return boundedFingerprint(
      `${evidence.type}:file-change:${JSON.stringify(stablePaths)}`,
    );
  }

  const summaryClass = evidence.summary.split(":", 1)[0]?.trim();
  const fallback = [evidence.type, toolName, summaryClass]
    .filter((value): value is string => Boolean(value))
    .join(":");
  return fallback ? boundedFingerprint(fallback) : undefined;
}

function operationFingerprint(evidence: GoalEvidence): string | undefined {
  const payload = asRecord(evidence.payload);
  const paths = stringArrayField(payload, "paths");
  if (paths.length > 0) {
    return boundedFingerprint(
      `paths:${JSON.stringify(
        paths.map((path) => path.trim().toLowerCase()).sort(),
      )}`,
    );
  }
  const command = stringField(payload, "command");
  if (command) return boundedFingerprint(`command:${command}`);
  const toolName = stringField(payload, "toolName");
  return toolName ? boundedFingerprint(`tool:${toolName}`) : undefined;
}

function boundedFingerprint(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "<id>",
    )
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, MAX_FINGERPRINT_CHARACTERS);
}

function failureDescription(evidence: GoalEvidence): string {
  const payload = asRecord(evidence.payload);
  const description =
    stringField(payload, "error") ??
    stringField(payload, "outputPreview") ??
    evidence.summary;
  const normalized = description.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_DESCRIPTION_CHARACTERS
    ? normalized
    : `${normalized.slice(0, MAX_DESCRIPTION_CHARACTERS - 16)}...[truncated]`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArrayField(
  record: Record<string, unknown> | undefined,
  field: string,
): string[] {
  const value = record?.[field];
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && Boolean(item.trim()),
      )
    : [];
}
