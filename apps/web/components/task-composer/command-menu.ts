export interface TaskComposerCommand {
  id: string;
  trigger: `/${string}`;
  label: string;
  description: string;
  modeLabel: string;
}

/** Returns commands matching a slash token at the start of an otherwise empty composer. */
export function filterTaskComposerCommands(
  value: string,
  commands: readonly TaskComposerCommand[],
): TaskComposerCommand[] {
  const match = /^\/([^\s/]*)$/.exec(value);
  if (!match) return [];

  const query = match[1].toLowerCase();
  return commands.filter((command) =>
    command.trigger.slice(1).toLowerCase().startsWith(query),
  );
}

/** Finds the command whose mode is active without matching longer commands. */
export function findActiveTaskComposerCommand(
  value: string,
  commands: readonly TaskComposerCommand[],
): TaskComposerCommand | undefined {
  const normalized = value.trimStart();
  return commands.find((command) => {
    return (
      normalized === command.trigger ||
      (normalized.startsWith(command.trigger) &&
        /^\s/.test(normalized.slice(command.trigger.length)))
    );
  });
}

export function moveTaskComposerCommandIndex(
  current: number,
  direction: "next" | "previous",
  commandCount: number,
): number {
  if (commandCount <= 0) return 0;
  return direction === "next"
    ? (current + 1) % commandCount
    : (current - 1 + commandCount) % commandCount;
}
