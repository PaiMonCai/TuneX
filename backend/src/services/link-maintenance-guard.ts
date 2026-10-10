import type { Prisma, LinkMaintenanceMigration } from "@prisma/client";
import { MaintenanceStatusSchema, maintenanceTransition } from "../integrations/forwardx/link-maintenance-state.ts";
import { LinkResourceError } from "./link-errors.ts";

/** Caller holds the Link row lock. Close only an intent; never release runtime ports. */
export async function closeMaintenanceIntent(tx: Prisma.TransactionClient, row: LinkMaintenanceMigration,
  status: "cancelled" | "expired" | "invalidated", reason: string, actorId: number | null, now: Date) {
  const next = maintenanceTransition(MaintenanceStatusSchema.parse(row.status), row.state_version, row.state_version, status);
  const changed = await tx.linkMaintenanceMigration.updateMany({ where: { id: row.id,
    workspace_id: row.workspace_id, link_id: row.link_id, active_link_id: row.link_id,
    status: "awaiting_executor", state_version: row.state_version },
    data: { ...next, reason_code: reason, updated_at: now } });
  if (changed.count !== 1) throw new LinkResourceError("link_maintenance_state_conflict");
  await tx.linkMaintenanceEvent.create({ data: { migration_id: row.id, state_version: next.state_version,
    status, reason_code: reason, created_by: actorId, created_at: now } });
}

/** Expiry also works after the submission flag is disabled or Worker was offline. */
export async function currentMaintenanceIntent(tx: Prisma.TransactionClient, linkId: number, now = new Date()) {
  const row = await tx.linkMaintenanceMigration.findUnique({ where: { active_link_id: linkId } });
  if (row && row.hold_expires_at.getTime() <= now.getTime()) {
    await closeMaintenanceIntent(tx, row, "expired", "link_maintenance_hold_expired", null, now);
    return null;
  }
  return row;
}

export async function assertNoMaintenanceIntent(tx: Prisma.TransactionClient, linkId: number) {
  if (await currentMaintenanceIntent(tx, linkId)) throw new LinkResourceError("link_maintenance_in_progress");
}
