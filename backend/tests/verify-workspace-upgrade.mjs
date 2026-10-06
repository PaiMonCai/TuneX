import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
try {
  const a = await db.workspace.findUniqueOrThrow({ where: { personal_user_id: 701 }, include: { members: true } });
  const b = await db.workspace.findUniqueOrThrow({ where: { personal_user_id: 702 }, include: { members: true } });
  assert.notEqual(a.id, b.id);
  assert.equal(a.kind, "personal");
  assert.equal(a.members.length, 1);
  assert.deepEqual({ id: a.members[0].user_id, role: a.members[0].role }, { id: 701, role: "owner" });
  assert.deepEqual({ id: b.members[0].user_id, role: b.members[0].role }, { id: 702, role: "owner" });
  const group = await db.nodeGroup.findUniqueOrThrow({ where: { id: 801 } });
  const tunnel = await db.tunnel.findUniqueOrThrow({ where: { id: 901 } });
  assert.equal(group.workspace_id, a.id);
  assert.equal(tunnel.workspace_id, a.id);
  assert.equal(group.user_id, 701);
  assert.equal(tunnel.user_id, 701);

  const traffic = await db.tunnelTraffic.findFirstOrThrow({
    where: { tunnel_id: 901 },
  });
  assert.equal(traffic.workspace_id, a.id);
  assert.equal(traffic.traffic, 4096);

  const fkRows = await db.$queryRawUnsafe(
    "SELECT COUNT(*) AS c FROM information_schema.KEY_COLUMN_USAGE " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tunnel_traffic' " +
      "AND COLUMN_NAME = 'tunnel_id' AND REFERENCED_TABLE_NAME = 'tunnel'",
  );
  assert.equal(Number(fkRows[0]?.c ?? -1), 0, "traffic ledger must no longer depend on live Tunnel FK");

  await db.tunnel.delete({ where: { id: 901 } });
  const afterDelete = await db.tunnelTraffic.findFirstOrThrow({
    where: { tunnel_id: 901, workspace_id: a.id },
  });
  assert.equal(afterDelete.traffic, 4096);

  console.log(
    "Workspace upgrade retained two distinct users, backfilled traffic ownership, and preserved ledger history after Tunnel deletion.",
  );
} finally {
  await db.$disconnect();
}
