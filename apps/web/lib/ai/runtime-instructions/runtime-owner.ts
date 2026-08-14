export function resolveAuthenticatedGoalRuntimeOwnerId(
  session: unknown,
): string | undefined {
  if (!session || typeof session !== "object") return undefined;
  const user = (session as { user?: unknown }).user;
  if (!user || typeof user !== "object") return undefined;
  const id = (user as { id?: unknown }).id;
  return typeof id === "string" &&
    id.length > 0 &&
    id.length <= 256 &&
    id === id.trim()
    ? id
    : undefined;
}
