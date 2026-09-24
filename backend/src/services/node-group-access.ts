import { db } from "../db.ts";
import { isNodeGroupGranted } from "./node-group-policy.ts";

/** Ownership or an explicit directional grant; missing owner never implies public. */
export async function canUseNodeGroup(
  userId: number,
  group: { id: number; user_id: number },
  direction: "in" | "out",
): Promise<boolean> {
  if (group.user_id === undefined) return false;
  if (isNodeGroupGranted(userId, group, direction, [])) return true;
  return (await db.nodeGroupGrant.findFirst({
    where: { user_id: userId, node_group_id: group.id, direction, active: true },
    select: { id: true },
  })) !== null;
}
