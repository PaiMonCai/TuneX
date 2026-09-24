/** A workspace owns its groups. Legacy per-user grants apply ONLY in a personal workspace. */
export function isNodeGroupGranted(
  userId: number,
  group: { id: number; user_id?: number; workspace_id?: number },
  direction: "in" | "out",
  grants: ReadonlyArray<{ node_group_id: number; direction: "in" | "out"; active: boolean }>,
  workspaceId?: number,
  personalWorkspaceId?: number,
): boolean {
  if (!Number.isInteger(userId) || group.user_id === undefined) return false;
  if (workspaceId !== undefined) {
    if (group.workspace_id === undefined) return false;
    if (group.workspace_id === workspaceId) return true;
    if (workspaceId !== personalWorkspaceId) return false;
  } else if (group.user_id === userId) return true; // legacy synthetic/test inputs
  return grants.some((g) => g.active && g.node_group_id === group.id && g.direction === direction);
}
