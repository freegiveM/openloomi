import type { RuntimeProvider } from "@openloomi/ai/agent/runtime-instructions";

export interface GoalPlanRequest {
  ownerId: string;
  provider: RuntimeProvider;
  objective: string;
  workingDirectory?: string;
}

export interface GoalPlannerPort {
  plan(request: GoalPlanRequest): Promise<string[]>;
}

export class GoalPlanningError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GoalPlanningError";
  }
}
