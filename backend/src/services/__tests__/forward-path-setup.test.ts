import { describe, expect, test } from "bun:test";
import {
  ensureForwardPathRelations,
  requiredForwardPathRelations,
  type ForwardPathRelationDb,
} from "../forward-path-setup.ts";

function stub(existing: Array<[number, number]> = []) {
  const rows = new Map(existing.map(([a,b], i) => [`${a}->${b}`, { id: i + 1 }]));
  const writes: Array<[number, number]> = [];
  const db: ForwardPathRelationDb = {
    nodeBinding: {
      findUnique: async ({ where }) => {
        const p = where.ingress_node_id_egress_node_id;
        return rows.get(`${p.ingress_node_id}->${p.egress_node_id}`) ?? null;
      },
      upsert: async ({ where, create }) => {
        const p = where.ingress_node_id_egress_node_id;
        const key = `${p.ingress_node_id}->${p.egress_node_id}`;
        const hit = rows.get(key);
        if (hit) return hit;
        const row = { id: rows.size + 1 };
        rows.set(key, row);
        writes.push([create.ingress_node_id, create.egress_node_id]);
        return row;
      },
    },
  };
  return { db, writes };
}

describe("Forward creation path relation plan", () => {
  test("DIRECT and federated egress need no local relation", () => {
    expect(requiredForwardPathRelations({
      mode: "direct", ingress_node_id: 1, egress_node_id: null,
    })).toEqual([]);
    expect(requiredForwardPathRelations({
      mode: "relay", ingress_node_id: 1, egress_node_id: null, federated_egress_peer: "peer-a",
    })).toEqual([]);
  });

  test("single-hop custom path needs ingress → egress", () => {
    expect(requiredForwardPathRelations({
      mode: "relay", ingress_node_id: 1, egress_node_id: 2,
    })).toEqual([
      { from_node_id: 1, to_node_id: 2, segment: "ingress_to_egress" },
    ]);
  });

  test("three-node custom path needs the two adjacent relations, not ingress → egress", () => {
    expect(requiredForwardPathRelations({
      mode: "relay", ingress_node_id: 1, middle_node_id: 3, egress_node_id: 2,
    })).toEqual([
      { from_node_id: 1, to_node_id: 3, segment: "ingress_to_middle" },
      { from_node_id: 3, to_node_id: 2, segment: "middle_to_egress" },
    ]);
  });
});

describe("Forward creation automatic path setup", () => {
  const relations = requiredForwardPathRelations({
    mode: "relay", ingress_node_id: 1, middle_node_id: 3, egress_node_id: 2,
  });

  test("existing reusable relations need no node-management privilege", async () => {
    const { db, writes } = stub([[1,3],[3,2]]);
    const result = await ensureForwardPathRelations(db, relations, false);
    expect(result).toEqual({ ok: true, created: [] });
    expect(writes).toEqual([]);
  });

  test("missing relations are prepared when node management is allowed", async () => {
    const { db, writes } = stub([[1,3]]);
    const result = await ensureForwardPathRelations(db, relations, true);
    expect(result).toEqual({
      ok: true,
      created: [{ from_node_id: 3, to_node_id: 2, segment: "middle_to_egress" }],
    });
    expect(writes).toEqual([[3,2]]);
  });

  test("without node-management privilege, missing relations are reported and nothing is written", async () => {
    const { db, writes } = stub();
    const result = await ensureForwardPathRelations(db, relations, false);
    expect(result).toEqual({
      ok: false,
      code: "path_setup_permission_required",
      missing: relations,
    });
    expect(writes).toEqual([]);
  });
});
