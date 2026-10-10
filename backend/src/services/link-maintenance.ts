import { Prisma, type LinkMaintenanceMigration } from "@prisma/client";
import { db } from "../db.ts";
import { canonicalConfigDigest } from "../integrations/forwardx/core-contract.ts";
import { LinkEndpointConfigSchema, LinkMaintenancePreviewSchema } from "../integrations/forwardx/link-maintenance.ts";
import { LinkMaintenanceCommitSchema, LinkMaintenanceCancelSchema, MaintenanceStatusSchema,
  maintenanceRequestDigest, verifyMaintenanceReceipt, LINK_MAINTENANCE_HOLD_MS,
  LINK_MAINTENANCE_SNAPSHOT_BYTES } from "../integrations/forwardx/link-maintenance-state.ts";
import { LinkResourceError } from "./link-errors.ts";
import { assertLinkFeature, captureLinkMaintenance, lockScopedLink, sealKey } from "./link-resource.ts";
import { closeMaintenanceIntent, currentMaintenanceIntent } from "./link-maintenance-guard.ts";

type Snapshot = Awaited<ReturnType<typeof captureLinkMaintenance>>["snapshot"];
function snapshot(row: LinkMaintenanceMigration): Snapshot {
  if (canonicalConfigDigest(row.snapshot) !== row.snapshot_digest) throw new LinkResourceError("link_maintenance_snapshot_corrupt", 503);
  const value = row.snapshot as unknown as Snapshot;
  const request = LinkMaintenancePreviewSchema.safeParse(value?.request);
  if (value?.schema_version !== 1 || !request.success || request.data.change.type !== row.operation
    || request.data.expected_version !== row.expected_version || request.data.expected_generation !== row.expected_generation
    || value.state_token !== row.state_token || !Array.isArray(value.admission?.references)
    || value.admission.references.length > 500) throw new LinkResourceError("link_maintenance_snapshot_corrupt", 503);
  return value;
}
function publicMigration(row: LinkMaintenanceMigration) {
  const facts = snapshot(row);
  const config = LinkEndpointConfigSchema.parse(facts.request.change.type === "update_endpoints"
    ? facts.request.change.config : facts.baseline.config);
  return { schema_version: 1 as const, id: row.id, link_id: row.link_id, workspace_id: row.workspace_id,
    created_by: row.created_by, operation: facts.request.change.type, status: MaintenanceStatusSchema.parse(row.status),
    state_version: row.state_version, expected_version: row.expected_version, expected_generation: row.expected_generation,
    candidate_config: config,
    references: { total: facts.admission.references.length,
      active: facts.admission.references.filter((r) => r.desired_status === "active").length,
      suspended: facts.admission.references.filter((r) => r.desired_status === "inactive").length },
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
    hold_expires_at: row.hold_expires_at.toISOString(), reason_code: row.reason_code,
    execution: { supported: false as const }, ports: { reserved: false as const, availability: "not_checked" as const } };
}

/** Commit only a bounded, immutable intent. LinkVersion/Deployment and runtime ownership do not change. */
export async function commitLinkMaintenance(workspaceId: number, linkId: number, actorId: number, raw: unknown) {
  assertLinkFeature();
  if (process.env.TUNEX_LINK_MAINTENANCE_ENABLED !== "true") throw new LinkResourceError("link_maintenance_not_enabled");
  const input = LinkMaintenanceCommitSchema.parse(raw);
  const request = LinkMaintenancePreviewSchema.parse({ expected_version: input.expected_version,
    expected_generation: input.expected_generation, change: input.change });
  // Retries reuse the exact receipt, including after it expires; a new receipt is a new request key.
  const digest = canonicalConfigDigest({ actor_id: actorId, request, receipt: input.receipt });
  return db.$transaction(async (tx) => {
    await lockScopedLink(tx, workspaceId, linkId);
    const existing = await tx.linkMaintenanceMigration.findUnique({ where: {
      link_id_idempotency_key: { link_id: linkId, idempotency_key: input.idempotency_key } } });
    if (existing) {
      if (existing.workspace_id !== workspaceId || existing.created_by !== actorId || existing.request_digest !== digest)
        throw new LinkResourceError("link_maintenance_idempotency_conflict");
      return { migration: publicMigration(existing), replayed: true };
    }
    const now = new Date();
    if (await currentMaintenanceIntent(tx, linkId, now)) throw new LinkResourceError("link_maintenance_in_progress");
    const captured = await captureLinkMaintenance(tx, workspaceId, linkId, request, now);
    verifyMaintenanceReceipt(input.receipt, { workspace_id: workspaceId, link_id: linkId,
      state_token: captured.preview.snapshot.state_token, request_digest: maintenanceRequestDigest(request) }, sealKey(), now);
    if (!input.expected_generation) throw new LinkResourceError("link_not_deployed");
    if (captured.preview.runtime.state !== "ready") throw new LinkResourceError("link_runtime_unconfirmed");
    if (!Object.values(captured.preview.changes).some(Boolean)) throw new LinkResourceError("link_no_change");
    const serialized = JSON.stringify(captured.snapshot);
    if (Buffer.byteLength(serialized, "utf8") > LINK_MAINTENANCE_SNAPSHOT_BYTES)
      throw new LinkResourceError("link_maintenance_snapshot_too_large");
    const frozen = JSON.parse(serialized) as Prisma.InputJsonValue;
    const row = await tx.linkMaintenanceMigration.create({ data: {
      link_id: linkId, workspace_id: workspaceId, created_by: actorId, idempotency_key: input.idempotency_key,
      request_digest: digest, operation: input.change.type, status: "awaiting_executor", state_version: 1,
      active_link_id: linkId, expected_version: input.expected_version, expected_generation: input.expected_generation,
      state_token: captured.preview.snapshot.state_token, snapshot_digest: canonicalConfigDigest(frozen), snapshot: frozen,
      hold_expires_at: new Date(now.getTime() + LINK_MAINTENANCE_HOLD_MS), created_at: now, updated_at: now,
      events: { create: { state_version: 1, status: "awaiting_executor", created_by: actorId, created_at: now } },
    } });
    return { migration: publicMigration(row), replayed: false };
  });
}

/** These read/cancel paths remain usable with submission/FXP flags disabled. */
export async function listLinkMaintenance(workspaceId: number, linkId: number) {
  return db.$transaction(async (tx) => {
    await lockScopedLink(tx, workspaceId, linkId);
    return (await tx.linkMaintenanceMigration.findMany({ where: { workspace_id: workspaceId, link_id: linkId },
      orderBy: { id: "desc" }, take: 20 })).map(publicMigration);
  });
}
export async function getLinkMaintenance(workspaceId: number, linkId: number, migrationId: number) {
  return db.$transaction(async (tx) => {
    await lockScopedLink(tx, workspaceId, linkId);
    const row = await tx.linkMaintenanceMigration.findFirst({ where: { id: migrationId, link_id: linkId, workspace_id: workspaceId } });
    if (!row) throw new LinkResourceError("link_maintenance_not_found", 404);
    const events = await tx.linkMaintenanceEvent.findMany({ where: { migration_id: row.id }, orderBy: { state_version: "asc" }, take: 16 });
    return { ...publicMigration(row), events: events.map((e) => ({ state_version: e.state_version,
      status: MaintenanceStatusSchema.parse(e.status), reason_code: e.reason_code, created_at: e.created_at.toISOString() })) };
  });
}
export async function cancelLinkMaintenance(workspaceId: number, linkId: number, migrationId: number, actorId: number, raw: unknown) {
  const { expected_state_version: expected } = LinkMaintenanceCancelSchema.parse(raw);
  return db.$transaction(async (tx) => {
    await lockScopedLink(tx, workspaceId, linkId);
    const row = await tx.linkMaintenanceMigration.findFirst({ where: { id: migrationId, workspace_id: workspaceId, link_id: linkId } });
    if (!row) throw new LinkResourceError("link_maintenance_not_found", 404);
    // Exactly the completed cancel can be replayed. Other terminal states are never reopened.
    if (row.status === "cancelled" && (row.state_version === expected || row.state_version === expected + 1)) return publicMigration(row);
    if (row.state_version !== expected) throw new LinkResourceError("link_maintenance_state_conflict");
    if (row.status !== "awaiting_executor") throw new LinkResourceError("link_maintenance_terminal");
    await closeMaintenanceIntent(tx, row, "cancelled", "link_maintenance_cancelled", actorId, new Date());
    return publicMigration(await tx.linkMaintenanceMigration.findUniqueOrThrow({ where: { id: row.id } }));
  });
}

/** Worker restart recovery revalidates or closes intent metadata only. It never dispatches candidate commands. */
export async function reconcileLinkMaintenance(): Promise<{ scanned: number; closed: number; errors: number }> {
  const rows = await db.linkMaintenanceMigration.findMany({ where: { status: "awaiting_executor" },
    orderBy: [{ hold_expires_at: "asc" }, { id: "asc" }], take: 100 });
  let closed = 0, errors = 0;
  for (const row of rows) {
    try {
      const changed = await db.$transaction(async (tx) => {
        await lockScopedLink(tx, row.workspace_id, row.link_id);
        const current = await tx.linkMaintenanceMigration.findUniqueOrThrow({ where: { id: row.id } });
        if (current.status !== "awaiting_executor") return false;
        const now = new Date();
        if (current.hold_expires_at.getTime() <= now.getTime()) {
          await closeMaintenanceIntent(tx, current, "expired", "link_maintenance_hold_expired", null, now);
          return true;
        }
        let reason: string | null = null;
        try {
          if (process.env.TUNEX_FXP_LINKS_ENABLED !== "true" || process.env.TUNEX_LINK_MAINTENANCE_ENABLED !== "true")
            reason = "link_maintenance_not_enabled";
          else {
            const facts = snapshot(current);
            const captured = await captureLinkMaintenance(tx, row.workspace_id, row.link_id,
              LinkMaintenancePreviewSchema.parse(facts.request), now);
            if (captured.preview.snapshot.state_token !== current.state_token) reason = "link_maintenance_state_changed";
            else if (captured.preview.runtime.state !== "ready") reason = "link_runtime_unconfirmed";
          }
        } catch (error) {
          if (error instanceof LinkResourceError) reason = error.code;
          else throw error; // Database outage is not proof the desired state changed.
        }
        if (!reason) return false;
        await closeMaintenanceIntent(tx, current, "invalidated", reason, null, now);
        return true;
      });
      if (changed) closed++;
    } catch { errors++; }
  }
  return { scanned: rows.length, closed, errors };
}
