import { nativeBothBlock, nativeBothBlockText } from "@/lib/forward-native-both";
import type { UserNode } from "@/lib/types";
import type { MockStore } from "./state";

/** Store-scoped middle-hop facts are shared by topology and transition admission. */
const middleHops = new WeakMap<MockStore, Map<number, number>>();
export function mockForwardMiddleHops(db: MockStore): Map<number, number> {
  let rows = middleHops.get(db);
  if (!rows) { rows = new Map(); middleHops.set(db, rows); }
  return rows;
}

export function mockForwardCapabilities() {
  return { native_both_enabled: process.env.FORWARD_NATIVE_BOTH_ENABLED === "true" };
}

export function mockNativeBothGate(db: MockStore, input: {
  mode: "direct" | "relay"; ingress: UserNode | null; egress: UserNode | null;
  middleNodeId?: string; existingBoth?: boolean; pathChanged?: boolean;
}) {
  const node = (value: UserNode | null): UserNode | null => {
    if (!value) return null;
    const state = db.nodeStates.get(value.id);
    const age = state?.reported_at ? Math.max(0, Math.round((Date.now() - Date.parse(state.reported_at)) / 1000)) : NaN;
    // Mirror mock diagnostics' freshness window without inventing advertisements.
    return { ...value, capabilities: state?.capabilities ?? null, capabilities_fresh: Number.isFinite(age) && age <= 75 };
  };
  const block = nativeBothBlock({ ...input, capabilities: mockForwardCapabilities(), ingress: node(input.ingress), egress: node(input.egress) });
  return block ? { code: "native_both_unavailable", message: nativeBothBlockText("zh", block), details: { reason: block } } : null;
}
