/** Native composite Forward contract; deliberately independent of shared FXP. */
export const FORWARD_NATIVE_BOTH_CAPABILITY = "forward.protocol.both.native.v1";

/** Discovery and write admission use the same default-off, exact-value flag. */
export function forwardNativeBothEnabled(): boolean {
  return process.env.FORWARD_NATIVE_BOTH_ENABLED === "true";
}

/** Flag controls entry into both, never recovery/removal of an existing rule. */
export function nativeBothEntryDisabled(protocol: unknown, previous?: unknown): boolean {
  return protocol === "both" && previous !== "both" && !forwardNativeBothEnabled();
}

/** Validate stored/candidate shape without changing its protocol or topology. */
export function nativeBothShapeError(row: {
  protocol?: unknown; forward_protocol?: unknown; link_resource_id?: unknown;
  mode?: unknown; tunnel_mode?: unknown; middle_node_id?: unknown;
  federated_egress_peer?: unknown; tls_cert_path?: unknown; tls_key_path?: unknown;
  client_source?: unknown; link_source_config?: unknown;
  lb_strategy?: unknown;
  egress_pool?: { lb_strategy?: unknown } | null;
  egress_node?: { lb_strategy?: unknown; id?: unknown; connect_ip?: unknown } | null;
}): string | null {
  const protocol = row.forward_protocol ?? row.protocol;
  if (typeof protocol !== "string" || protocol.trim().toLowerCase() !== "both" || row.link_resource_id != null) return null;
  const mode = row.tunnel_mode ?? row.mode;
  if (mode !== "direct" && mode !== "relay") return "native_both_mode_unsupported";
  if (row.middle_node_id != null) return "native_both_middle_unsupported";
  if (row.federated_egress_peer != null && row.federated_egress_peer !== "") return "native_both_federated_unsupported";
  if (row.tls_cert_path != null && row.tls_cert_path !== "" || row.tls_key_path != null && row.tls_key_path !== "")
    return "native_both_tls_unsupported";
  if (row.client_source != null || row.link_source_config != null) return "native_both_source_unsupported";
  const strategy = row.egress_pool?.lb_strategy ?? row.lb_strategy ?? row.egress_node?.lb_strategy;
  if (typeof strategy === "string" && strategy.trim().toUpperCase() === "IP_HASH") return "native_both_ip_hash_unsupported";
  return null;
}
