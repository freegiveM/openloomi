import type { RuntimeInstruction } from "@openloomi/ai/agent/runtime-instructions";
import { describe, expect, it } from "vitest";

import { resolveGoalEvidenceRevisionFloor } from "@/lib/ai/runtime-instructions/runtime-observation";

const GOAL_ID = "10000000-0000-4000-8000-000000000001";

type EvidenceBoundaryKind = Extract<
  RuntimeInstruction["kind"],
  | "goal.update"
  | "context.upsert"
  | "context.remove"
  | "constraint.upsert"
  | "constraint.remove"
>;

function instruction(
  kind: RuntimeInstruction["kind"],
  goalRevision: number,
  goalId = GOAL_ID,
): RuntimeInstruction {
  // The resolver intentionally reads only immutable instruction identity. The
  // payload is irrelevant to this focused boundary test.
  return { kind, goalId, goalRevision } as RuntimeInstruction;
}

describe("resolveGoalEvidenceRevisionFloor", () => {
  it("keeps activation evidence across lifecycle-only revisions", () => {
    expect(
      resolveGoalEvidenceRevisionFloor(GOAL_ID, 5, [
        instruction("goal.activate", 1),
        instruction("goal.pause", 2),
        instruction("goal.resume", 3),
        instruction("goal.continue", 3),
        instruction("control.interrupt", 4),
      ]),
    ).toBe(1);
  });

  it.each<EvidenceBoundaryKind>([
    "goal.update",
    "context.upsert",
    "context.remove",
    "constraint.upsert",
    "constraint.remove",
  ])("moves the evidence boundary to the latest %s instruction", (kind) => {
    expect(
      resolveGoalEvidenceRevisionFloor(GOAL_ID, 8, [
        instruction("goal.activate", 1),
        instruction(kind, 6),
        instruction("goal.pause", 7),
        instruction("goal.resume", 8),
      ]),
    ).toBe(6);
  });

  it("fails closed when no applicable instruction history is available", () => {
    expect(
      resolveGoalEvidenceRevisionFloor(GOAL_ID, 5, [
        instruction(
          "goal.activate",
          1,
          "20000000-0000-4000-8000-000000000001",
        ),
        instruction("goal.update", 6),
      ]),
    ).toBe(5);
  });
});
