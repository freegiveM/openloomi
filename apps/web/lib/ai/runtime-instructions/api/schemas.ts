import {
  AgentGoalUpdateSchema,
  CreateAgentGoalInputSchema,
  GoalConstraintSchema,
  GoalContextReferenceSchema,
} from "@openloomi/ai/agent/runtime-instructions";
import { z } from "zod";

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim(), {
    message: "Identifier must not contain surrounding whitespace",
  });

const userConstraintSchema = z
  .object({
    id: GoalConstraintSchema.shape.id,
    description: GoalConstraintSchema.shape.description,
    enforcement: z.literal("model_guidance").default("model_guidance"),
  })
  .strict();

const userContextReferenceSchema = z
  .object({
    id: GoalContextReferenceSchema.shape.id,
    kind: GoalContextReferenceSchema.shape.kind,
    refId: GoalContextReferenceSchema.shape.refId,
    label: GoalContextReferenceSchema.shape.label,
    summary: GoalContextReferenceSchema.shape.summary,
    attributes: GoalContextReferenceSchema.shape.attributes,
  })
  .strict();

const userGoalUpdateSchema = z
  .object({
    objective: AgentGoalUpdateSchema.shape.objective,
    successCriteria: AgentGoalUpdateSchema.shape.successCriteria.refine(
      (criteria) =>
        criteria === undefined ||
        criteria.every((criterion) => criterion.verification.type !== "manual"),
      {
        message:
          "Manual success criteria require an attestation API that is not available yet",
      },
    ),
    constraints: z.array(userConstraintSchema).optional(),
    priority: AgentGoalUpdateSchema.shape.priority,
    deadline: AgentGoalUpdateSchema.shape.deadline,
    maxTurns: AgentGoalUpdateSchema.shape.maxTurns,
    maxTokens: AgentGoalUpdateSchema.shape.maxTokens,
    maxDurationSeconds: AgentGoalUpdateSchema.shape.maxDurationSeconds,
    completionPolicy: AgentGoalUpdateSchema.shape.completionPolicy.refine(
      (policy) => policy === undefined || policy !== "manual",
      {
        message:
          "The manual completion policy requires an attestation API that is not available yet",
      },
    ),
  })
  .strict()
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "A Goal update must change at least one field",
  });

export const GoalSessionQuerySchema = z
  .object({ runtimeSessionId: identifierSchema })
  .strict();

export const ActivateGoalRequestSchema = z
  .object({
    runtimeSessionId: identifierSchema,
    objective: CreateAgentGoalInputSchema.shape.objective,
  })
  .strict();

export const UpdateGoalRequestSchema = z
  .object({
    runtimeSessionId: identifierSchema,
    expectedRevision: z.int().positive(),
    update: userGoalUpdateSchema,
  })
  .strict();

export const ResumeGoalRequestSchema = z
  .object({
    runtimeSessionId: identifierSchema,
    expectedRevision: z.int().positive(),
    reason: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict();

export const PauseGoalRequestSchema = ResumeGoalRequestSchema;

export const UpsertGoalContextRequestSchema = z
  .object({
    runtimeSessionId: identifierSchema,
    expectedRevision: z.int().positive(),
    contextRef: userContextReferenceSchema,
    deliveryMode: z.enum(["next_boundary", "steer"]).optional(),
  })
  .strict();

export const RemoveGoalContextRequestSchema = z
  .object({
    runtimeSessionId: identifierSchema,
    expectedRevision: z.int().positive(),
    contextRefId: identifierSchema,
    deliveryMode: z.enum(["next_boundary", "steer"]).optional(),
  })
  .strict();

export const IdempotencyKeySchema = identifierSchema;
export const GoalIdSchema = z.uuid();

export type ActivateGoalRequest = z.output<typeof ActivateGoalRequestSchema>;
export type UpdateGoalRequest = z.output<typeof UpdateGoalRequestSchema>;
export type ResumeGoalRequest = z.output<typeof ResumeGoalRequestSchema>;
export type PauseGoalRequest = z.output<typeof PauseGoalRequestSchema>;
export type UpsertGoalContextRequest = z.output<
  typeof UpsertGoalContextRequestSchema
>;
export type RemoveGoalContextRequest = z.output<
  typeof RemoveGoalContextRequestSchema
>;
