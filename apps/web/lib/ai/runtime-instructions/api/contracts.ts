import type {
  AgentGoal,
  AgentGoalRun,
  DeliveryState,
  GoalEvaluationResult,
  GoalEvidence,
  RuntimeInstructionKind,
  RuntimeSessionState,
} from "@melandlabs/ai/agent/runtime-instructions";

export type PublicAgentGoal = AgentGoal & {
  runtimeSessionId: string;
  slot: "primary";
};

export type PublicGoalEvaluationResult = Omit<
  GoalEvaluationResult,
  "nextInstruction"
>;

export type PublicAgentGoalRun = Omit<
  AgentGoalRun,
  "ownerId" | "providerSessionId" | "lastEvaluation"
> & { lastEvaluation?: PublicGoalEvaluationResult };

export type PublicGoalEvidence = Omit<GoalEvidence, "payload">;

export interface PublicGoalDelivery {
  instructionId: string;
  sequence: number;
  kind: RuntimeInstructionKind;
  goalRevision?: number;
  state: DeliveryState;
  attempt: number;
  issuedAt: string;
  updatedAt: string;
  errorCode?: string;
}

export interface PublicGoalProgress {
  completedCriteria: number;
  totalCriteria: number;
  turnsUsed: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  lastReason?: string;
  lastEvidenceAt?: string;
}

export interface PublicGoalSummary {
  goal: PublicAgentGoal;
  latestRun: PublicAgentGoalRun | null;
  latestDelivery: PublicGoalDelivery | null;
  progress: PublicGoalProgress;
}

export interface AgentGoalSessionResponse {
  runtimeSessionId: string;
  live: boolean;
  activeGoalId: string | null;
  goals: PublicGoalSummary[];
}

export interface AgentGoalRecoverySession {
  runtimeSessionId: string;
  state: RuntimeSessionState;
  live: boolean;
  chat: {
    id: string;
    title: string;
    createdAt: string;
  };
}

export interface AgentGoalRecoverySessionsResponse {
  sessions: AgentGoalRecoverySession[];
}

export interface AgentGoalDetailResponse extends PublicGoalSummary {
  runtimeSessionId: string;
  live: boolean;
  evidence: PublicGoalEvidence[];
}

export interface PublicDeliveryReceipt {
  runtimeSessionId: string;
  state: "queued" | "written_to_sdk" | "rejected";
  recordedAt: string;
}

export type PublicInstructionDispatchFailure =
  | {
      status: "rejected";
      instructionId: string;
      receipt: PublicDeliveryReceipt;
      code: "transport_rejected";
    }
  | {
      status: "transport_failed";
      runtimeSessionId: string;
      instructionId: string;
      code: "transport_failed";
    };

export type PublicInstructionDispatch =
  | {
      status: "accepted";
      instructionId: string;
      receipt: PublicDeliveryReceipt;
    }
  | PublicInstructionDispatchFailure
  | {
      status: "unavailable" | "superseded";
      runtimeSessionId: string;
      instructionId: string;
    }
  | {
      status: "deferred";
      runtimeSessionId: string;
      instructionId: string;
      blockedByInstructionId: string;
      failure: PublicInstructionDispatchFailure;
    };

export interface AgentGoalCommandResponse {
  goal: PublicAgentGoal;
  instruction: {
    id: string;
    sequence: number;
    kind: RuntimeInstructionKind;
    goalRevision?: number;
    issuedAt: string;
  };
  deduplicated: boolean;
  dispatch: PublicInstructionDispatch;
}
