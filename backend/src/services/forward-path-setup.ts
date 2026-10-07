/**
 * Forward creation path setup.
 *
 * Product rule: users choose a path; NodeBinding stays an internal reusable
 * infrastructure relation. Creation may prepare missing local relations only
 * when the actor already has node-management permission.
 */

export type ForwardPathSegment =
  | "ingress_to_egress"
  | "ingress_to_middle"
  | "middle_to_egress";

export interface ForwardPathRelation {
  from_node_id: number;
  to_node_id: number;
  segment: ForwardPathSegment;
}

export function requiredForwardPathRelations(input: {
  mode: "direct" | "relay";
  ingress_node_id: number;
  egress_node_id: number | null;
  middle_node_id?: number | null;
  federated_egress_peer?: string | null;
}): ForwardPathRelation[] {
  if (input.mode !== "relay") return [];
  // A federated egress is authorized by the federation grant, not a local
  // NodeBinding. Local path setup therefore applies only to a local egress.
  if (input.federated_egress_peer || input.egress_node_id == null) return [];

  const middle = input.middle_node_id ?? null;
  if (middle == null) {
    return [{
      from_node_id: input.ingress_node_id,
      to_node_id: input.egress_node_id,
      segment: "ingress_to_egress",
    }];
  }
  return [
    {
      from_node_id: input.ingress_node_id,
      to_node_id: middle,
      segment: "ingress_to_middle",
    },
    {
      from_node_id: middle,
      to_node_id: input.egress_node_id,
      segment: "middle_to_egress",
    },
  ];
}

export interface ForwardPathRelationDb {
  nodeBinding: {
    findUnique(args: {
      where: {
        ingress_node_id_egress_node_id: {
          ingress_node_id: number;
          egress_node_id: number;
        };
      };
      select?: { id: true };
    }): Promise<{ id: number } | null>;
    upsert(args: {
      where: {
        ingress_node_id_egress_node_id: {
          ingress_node_id: number;
          egress_node_id: number;
        };
      };
      update: Record<string, never>;
      create: { ingress_node_id: number; egress_node_id: number };
      select?: { id: true };
    }): Promise<{ id: number }>;
  };
}

export type EnsureForwardPathRelationsResult =
  | { ok: true; created: ForwardPathRelation[] }
  | { ok: false; code: "path_setup_permission_required"; missing: ForwardPathRelation[] };

/**
 * Ensure all local adjacency relations inside the caller's transaction.
 *
 * - Existing relations are reusable and require no node-management privilege.
 * - Missing relations are created only when canManageNodes=true.
 * - With no privilege, nothing is written and every missing segment is returned.
 */
export async function ensureForwardPathRelations(
  db: ForwardPathRelationDb,
  relations: readonly ForwardPathRelation[],
  canManageNodes: boolean,
): Promise<EnsureForwardPathRelationsResult> {
  const missing: ForwardPathRelation[] = [];
  const created: ForwardPathRelation[] = [];

  for (const relation of relations) {
    const where = {
      ingress_node_id_egress_node_id: {
        ingress_node_id: relation.from_node_id,
        egress_node_id: relation.to_node_id,
      },
    };
    const existing = await db.nodeBinding.findUnique({ where, select: { id: true } });
    if (existing) continue;
    if (!canManageNodes) {
      missing.push(relation);
      continue;
    }
    await db.nodeBinding.upsert({
      where,
      update: {},
      create: {
        ingress_node_id: relation.from_node_id,
        egress_node_id: relation.to_node_id,
      },
      select: { id: true },
    });
    created.push(relation);
  }

  return missing.length > 0
    ? { ok: false, code: "path_setup_permission_required", missing }
    : { ok: true, created };
}
