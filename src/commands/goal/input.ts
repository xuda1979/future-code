interface GoalInputCommand {
  value: unknown;
  mode: string;
  isMeta?: boolean;
  origin?: unknown;
}

/** Read original dispatch provenance, before slash expansion creates visible
 * user-shaped metadata. Scheduled/model/notification messages are not human
 * steering, even when their expanded messages look like a human turn. */
export function trustedGoalInputs(commands: readonly GoalInputCommand[]): string[] {
  return commands.filter(command => command.mode === "prompt" && !command.isMeta &&
    command.origin === undefined && typeof command.value === "string")
    .map(command => command.value as string);
}
