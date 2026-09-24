/** Node access is independent of plans and licenses. Incomplete owner data denies access. */
export function isNodeGroupGranted(
  userId: number,
  group: { id: number; user_id?: number },
  direction: "in" | "out",
  grants: ReadonlyArray<{ node_group_id: number; direction: "in" | "out"; active: boolean }>,
): boolean {
  if (!Number.isInteger(userId) || group.user_id === undefined) return false;
  return group.user_id === userId || grants.some(
    (g) => g.active && g.node_group_id === group.id && g.direction === direction,
  );
}
