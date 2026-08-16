import { describe, expect, test } from "vitest";
import {
  filterTaskComposerCommands,
  findActiveTaskComposerCommand,
  moveTaskComposerCommandIndex,
  type TaskComposerCommand,
} from "@/components/task-composer/command-menu";

const goalCommand: TaskComposerCommand = {
  id: "goal",
  trigger: "/goal",
  label: "Create a Goal",
  description: "Plan and run a long-running task",
  modeLabel: "Goal mode",
};

describe("TaskComposer command menu", () => {
  test("suggests Goal while typing a leading slash command", () => {
    for (const value of ["/", "/g", "/go", "/GOAL"]) {
      expect(filterTaskComposerCommands(value, [goalCommand])).toEqual([
        goalCommand,
      ]);
    }
  });

  test("does not suggest commands inside chat text or after an objective", () => {
    for (const value of [
      "please /goal",
      " /goal",
      "/goal build it",
      "/goalkeeper",
      "https://example.com/",
    ]) {
      expect(filterTaskComposerCommands(value, [goalCommand])).toEqual([]);
    }
  });

  test("recognizes Goal mode only at the exact command boundary", () => {
    expect(findActiveTaskComposerCommand("/goal", [goalCommand])).toBe(
      goalCommand,
    );
    expect(findActiveTaskComposerCommand("  /goal ship it", [goalCommand])).toBe(
      goalCommand,
    );
    expect(
      findActiveTaskComposerCommand("/GOAL ship it", [goalCommand]),
    ).toBeUndefined();
    expect(
      findActiveTaskComposerCommand("/goalkeeper ship it", [goalCommand]),
    ).toBeUndefined();
    expect(
      findActiveTaskComposerCommand("please /goal ship it", [goalCommand]),
    ).toBeUndefined();
  });

  test("moves and wraps keyboard selection across multiple commands", () => {
    expect(moveTaskComposerCommandIndex(0, "next", 2)).toBe(1);
    expect(moveTaskComposerCommandIndex(1, "next", 2)).toBe(0);
    expect(moveTaskComposerCommandIndex(1, "previous", 2)).toBe(0);
    expect(moveTaskComposerCommandIndex(0, "previous", 2)).toBe(1);
    expect(moveTaskComposerCommandIndex(0, "next", 0)).toBe(0);
  });
});
