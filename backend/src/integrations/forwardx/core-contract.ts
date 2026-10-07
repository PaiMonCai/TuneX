import { createHash } from "node:crypto";

/**
 * A01 — ForwardX integration boundary.
 *
 * This module freezes the dimensions that A02/A03 must consume. It is deliberately
 * pure: no Prisma, Redis, Hono or Agent I/O belongs here.
 *
 * IMPORTANT: "available" means the current TuneX runtime can execute the shape.
 * It does NOT mean LinkResource CRUD/deployment is already implemented or exposed.
 */
export const FORWARD_LINK_CONTRACT_VERSION = "tunex-forward-link/v1" as const;

export const BUSINESS_PROTOCOLS = ["tcp", "udp", "both"] as const;
export type BusinessProtocol = (typeof BUSINESS_PROTOCOLS)[number];

const BUSINESS_TCP: BusinessProtocol = BUSINESS_PROTOCOLS[0];
const BUSINESS_UDP: BusinessProtocol = BUSINESS_PROTOCOLS[1];
const BUSINESS_BOTH: BusinessProtocol = BUSINESS_PROTOCOLS[2];

export const CLIENT_FRONTS = ["plain", "tls", "ws", "wss"] as const;
export type ClientFront = (typeof CLIENT_FRONTS)[number];

export const CARRIERS = [
  "native_private",
  "fxp_v1",
  "gost_tcp",
  "gost_tls",
  "gost_wss",
  "wireguard_fxp_v2",
  "forwardx_mtls",
  "forwardx_mwss",
  "forwardx_mtcp",
] as const;
export type Carrier = (typeof CARRIERS)[number];

export const EXECUTION_DRIVERS = [
  "native",
  "fxp",
  "gost",
  "wireguard",
  "nftables",
  "iptables",
  "realm",
  "socat",
  "nginx",
] as const;
export type ExecutionDriver = (typeof EXECUTION_DRIVERS)[number];

export const LINK_RESOURCE_KINDS = ["local", "point_to_point", "chain"] as const;
export type LinkResourceKind = (typeof LINK_RESOURCE_KINDS)[number];

export const LINK_RESOURCE_LIFECYCLES = [
  "draft",
  "deploying",
  "active",
  "degraded",
  "suspended",
  "retired",
] as const;
export type LinkResourceLifecycle = (typeof LINK_RESOURCE_LIFECYCLES)[number];

export const PLACEMENT_ROLES = ["local", "ingress", "transit", "egress"] as const;
export type PlacementRole = (typeof PLACEMENT_ROLES)[number];

export type MatrixRelease = "available" | "planned" | "unsupported";

export interface ExecutionSelection {
  readonly business_protocol: BusinessProtocol;
  readonly client_front: ClientFront;
  readonly carrier: Carrier;
  readonly driver: ExecutionDriver;
}

export interface ExecutionMatrixEntry extends ExecutionSelection {
  /**
   * Runtime availability only. A02 still owns LinkResource persistence/deployment.
   * "planned" MUST fail closed; callers may not silently fall back to another entry.
   */
  readonly release: MatrixRelease;
  /**
   * Capability names must be reported by the Agent before a NEW LinkResource can
   * use the entry. Existing legacy_private Tunnel rows remain on their old path.
   */
  readonly required_agent_capabilities: readonly string[];
  /**
   * Semver floor for newly released non-native execution. null means that this is
   * an existing compatibility runtime whose release predates the A01 version gate.
   * A03/A14 MUST set a concrete floor before changing a non-native row to available.
   */
  readonly minimum_agent_version: string | null;
  readonly note: string;
}

const native = (
  business_protocol: BusinessProtocol,
  client_front: ClientFront,
  capabilities: readonly string[],
  note: string,
): ExecutionMatrixEntry => ({
  business_protocol,
  client_front,
  carrier: "native_private",
  driver: "native",
  release: "available",
  required_agent_capabilities: capabilities,
  minimum_agent_version: null,
  note,
});

/**
 * The single support table consumed by A02/A03.
 *
 * It intentionally advertises ONLY execution that already exists in TuneX.
 * FXP/GOST/WG/both names are frozen here but stay planned until their real
 * runner, status and network gates land. This prevents "enum == support".
 */
export const FORWARD_EXECUTION_MATRIX: readonly ExecutionMatrixEntry[] = [
  native(
    "tcp",
    "plain",
    ["forward.native.stream.v1"],
    "Existing native TCP runtime; inter-node hop is legacy plaintext/private-network only.",
  ),
  native(
    "tcp",
    "tls",
    ["forward.native.stream.v1", "forward.front.tls.v1"],
    "TLS terminates at the client-facing listener; this does not encrypt the inter-node hop.",
  ),
  native(
    "tcp",
    "ws",
    ["forward.native.stream.v1", "forward.front.ws.v1"],
    "WebSocket is a client-facing framing layer; inter-node carrier remains native_private.",
  ),
  native(
    "udp",
    "plain",
    ["forward.native.datagram.v1"],
    "Existing UDP datagram runtime; protocol identity remains UDP end-to-end.",
  ),
  {
    business_protocol: BUSINESS_BOTH,
    client_front: "plain",
    carrier: "native_private",
    driver: "native",
    release: "planned",
    required_agent_capabilities: ["forward.protocol.both.v1"],
    minimum_agent_version: null,
    note: "A04 must make TCP/UDP leases and child runtimes protocol-aware before this can open.",
  },
  {
    business_protocol: BUSINESS_TCP,
    client_front: "plain",
    carrier: "fxp_v1",
    driver: "fxp",
    release: "planned",
    required_agent_capabilities: ["forward.driver.fxp.v1", "forward.carrier.fxp-v1.tcp.v1"],
    minimum_agent_version: null,
    note: "A03 PoC/release gate; never fall back to native_private when unavailable.",
  },
  {
    business_protocol: BUSINESS_UDP,
    client_front: "plain",
    carrier: "fxp_v1",
    driver: "fxp",
    release: "planned",
    required_agent_capabilities: ["forward.driver.fxp.v1", "forward.carrier.fxp-v1.udp.v1"],
    minimum_agent_version: null,
    note: "A03 PoC/release gate; UDP remains the business protocol even when carried by FXP.",
  },
  {
    business_protocol: BUSINESS_TCP,
    client_front: "plain",
    carrier: "gost_tcp",
    driver: "gost",
    release: "planned",
    required_agent_capabilities: ["forward.driver.gost.v1", "forward.carrier.gost-tcp.v1"],
    minimum_agent_version: null,
    note: "A03 opens only after managed-binary/config/status and real payload evidence.",
  },
  {
    business_protocol: BUSINESS_TCP,
    client_front: "plain",
    carrier: "gost_tls",
    driver: "gost",
    release: "planned",
    required_agent_capabilities: ["forward.driver.gost.v1", "forward.carrier.gost-tls.v1"],
    minimum_agent_version: null,
    note: "A03 candidate; encrypted hop and client front are separate facts.",
  },
  {
    business_protocol: BUSINESS_TCP,
    client_front: "plain",
    carrier: "gost_wss",
    driver: "gost",
    release: "planned",
    required_agent_capabilities: ["forward.driver.gost.v1", "forward.carrier.gost-wss.v1"],
    minimum_agent_version: null,
    note: "A03 candidate; not exposed until the exact ForwardX/GOST semantics are proven.",
  },
  {
    business_protocol: BUSINESS_TCP,
    client_front: "plain",
    carrier: "wireguard_fxp_v2",
    driver: "wireguard",
    release: "planned",
    required_agent_capabilities: ["forward.driver.wireguard.v1", "forward.carrier.fxp-v2.v1"],
    minimum_agent_version: null,
    note: "A14 only. V2 means WG outer transport plus the defined inner FXP semantics.",
  },
  ...(["forwardx_mtls", "forwardx_mwss", "forwardx_mtcp"] as const).map(
    (carrier): ExecutionMatrixEntry => ({
      business_protocol: BUSINESS_TCP,
      client_front: "plain",
      carrier,
      driver: "gost",
      release: "planned",
      required_agent_capabilities: [`forward.carrier.${carrier}.v1`],
      minimum_agent_version: null,
      note: "A14: name is reserved; exact ForwardX multiplexing semantics must be verified before release.",
    }),
  ),
] as const;

export const NEW_LINK_AGENT_POLICY = {
  /** A new LinkResource never infers support from an old enum or desired-state shape. */
  require_capability_manifest: true,
  /** A stamped version is evidence; "unknown" is not a version and cannot pass a new-feature gate. */
  reject_unknown_agent_version: true,
  /** No failed secure/managed selection may be converted to native_private. */
  allow_runtime_fallback: false,
} as const;

export interface AgentCapabilitySnapshot {
  readonly version: string | null;
  readonly capabilities: readonly string[] | null;
}

export type ExecutionAdmissionFailureCode =
  | "unsupported_combination"
  | "capability_not_released"
  | "agent_version_unknown"
  | "agent_capabilities_missing"
  | "agent_capability_missing";

export type ExecutionAdmission =
  | { readonly ok: true; readonly entry: ExecutionMatrixEntry }
  | {
      readonly ok: false;
      readonly code: ExecutionAdmissionFailureCode;
      readonly message: string;
      readonly entry?: ExecutionMatrixEntry;
      readonly missing_capabilities?: readonly string[];
    };

export function executionMatrixEntry(
  selection: ExecutionSelection,
): ExecutionMatrixEntry | null {
  return (
    FORWARD_EXECUTION_MATRIX.find(
      (entry) =>
        entry.business_protocol === selection.business_protocol &&
        entry.client_front === selection.client_front &&
        entry.carrier === selection.carrier &&
        entry.driver === selection.driver,
    ) ?? null
  );
}

/**
 * Admission for NEW LinkResource deployments.
 *
 * This never mutates the selection and therefore cannot "helpfully" downgrade
 * fxp/gost/wg to native plaintext.
 */
export function admitExecutionSelection(
  selection: ExecutionSelection,
  agent: AgentCapabilitySnapshot,
): ExecutionAdmission {
  const entry = executionMatrixEntry(selection);
  if (!entry) {
    return {
      ok: false,
      code: "unsupported_combination",
      message: "该 business/front/carrier/driver 组合不在冻结支持矩阵中",
    };
  }
  if (entry.release !== "available") {
    return {
      ok: false,
      code: "capability_not_released",
      message: "该组合仅保留契约名称，尚未通过真实 runtime/network 验收",
      entry,
    };
  }

  const version = agent.version?.trim() ?? "";
  if (NEW_LINK_AGENT_POLICY.reject_unknown_agent_version && (version === "" || version === "unknown")) {
    return {
      ok: false,
      code: "agent_version_unknown",
      message: "新 LinkResource 要求 Agent 上报可识别版本；unknown 不能作为能力证据",
      entry,
    };
  }

  if (NEW_LINK_AGENT_POLICY.require_capability_manifest && !agent.capabilities) {
    return {
      ok: false,
      code: "agent_capabilities_missing",
      message: "Agent 未上报 capability manifest，不能接收新 LinkResource",
      entry,
    };
  }

  const capabilities = new Set(agent.capabilities ?? []);
  const missing = entry.required_agent_capabilities.filter((cap) => !capabilities.has(cap));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "agent_capability_missing",
      message: `Agent 缺少能力：${missing.join(", ")}`,
      missing_capabilities: missing,
      entry,
    };
  }

  return { ok: true, entry };
}

/**
 * Existing Tunnel.forward_protocol is historically a mixed "client front +
 * business protocol" field. A01 maps it into the new orthogonal dimensions
 * without changing the existing writer.
 */
export function legacyForwardSelection(protocol: unknown): ExecutionSelection | null {
  const value = typeof protocol === "string" ? protocol.trim().toLowerCase() : "tcp";
  switch (value || "tcp") {
    case "tcp":
      return { business_protocol: BUSINESS_TCP, client_front: "plain", carrier: "native_private", driver: "native" };
    case "tls":
      return { business_protocol: BUSINESS_TCP, client_front: "tls", carrier: "native_private", driver: "native" };
    case "ws":
      return { business_protocol: BUSINESS_TCP, client_front: "ws", carrier: "native_private", driver: "native" };
    case "udp":
      return { business_protocol: BUSINESS_UDP, client_front: "plain", carrier: "native_private", driver: "native" };
    default:
      return null;
  }
}

export const LINK_FACT_OWNERSHIP = {
  LinkResource: {
    owns: ["workspace identity", "kind", "lifecycle", "use authorization"],
    does_not_own: ["NodeGroup truth", "business target health"],
  },
  LinkVersion: {
    owns: ["immutable topology", "per-hop carrier", "resource policy", "canonical digest"],
    does_not_own: ["business target mutation"],
  },
  LinkDeployment: {
    owns: ["placement", "generation", "owner/epoch", "deployment result", "restore facts"],
    does_not_own: ["multi-active members hidden behind one ingress owner"],
  },
  ForwardLinkBinding: {
    owns: ["exact link version reference", "binding revision", "legacy/shared mode"],
    does_not_own: ["a second mutable copy of shared topology"],
  },
  TransportCredential: {
    owns: ["scope", "key reference", "expiry", "rotation", "revocation"],
    does_not_own: ["AUTH_SECRET reuse", "plaintext export"],
  },
  BatchJob: {
    owns: ["frozen input", "persistent progress", "per-item result", "recovery"],
    does_not_own: ["Redis/BullMQ as the only source of truth"],
  },
} as const;

export const LINK_WRITER_AUTHORITY = {
  legacy_private: "existing Forward rollout/reconcile writer",
  shared_link: "Link deployment compiler + generation/CAS merge",
  binding: "Forward binding service; may reference but never rewrite immutable LinkVersion",
} as const;

export interface CanonicalLinkVersionInput {
  readonly contract_version: typeof FORWARD_LINK_CONTRACT_VERSION;
  readonly link_id: number;
  readonly version: number;
  readonly kind: LinkResourceKind;
  readonly topology: unknown;
  readonly hops: readonly {
    readonly index: number;
    readonly node_id: number;
    readonly carrier: Carrier;
    readonly driver: ExecutionDriver;
  }[];
  readonly policy: unknown;
}

/** JSON-compatible canonicalisation. Undefined/non-finite/function values are refused. */
export function canonicalJson(value: unknown): string {
  const encode = (input: unknown): unknown => {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    ) return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new Error("canonical_json_non_finite_number");
      return input;
    }
    if (Array.isArray(input)) return input.map(encode);
    if (typeof input === "object") {
      const object = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(object).sort()) {
        const child = object[key];
        if (
          child === undefined ||
          typeof child === "function" ||
          typeof child === "symbol" ||
          typeof child === "bigint"
        ) {
          throw new Error(`canonical_json_unsupported_value:${key}`);
        }
        out[key] = encode(child);
      }
      return out;
    }
    throw new Error("canonical_json_unsupported_value");
  };
  return JSON.stringify(encode(value));
}

export function canonicalConfigDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function positiveInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name}_must_be_positive_safe_integer`);
  return value;
}

export interface RuntimeIdentityInput {
  readonly link_id: number;
  readonly link_version: number;
  readonly placement_id: number;
  readonly role: PlacementRole;
  readonly protocol: Exclude<BusinessProtocol, "both">;
}

/**
 * Stable runtime identity. "both" is intentionally excluded: A04 owns the two
 * child runtime identities (tcp + udp) instead of hiding them behind one id.
 */
export function linkRuntimeId(input: RuntimeIdentityInput): string {
  const link = positiveInt(input.link_id, "link_id");
  const version = positiveInt(input.link_version, "link_version");
  const placement = positiveInt(input.placement_id, "placement_id");
  return `tunex-link-${link}-v${version}-p${placement}-${input.role}-${input.protocol}`;
}

export type LeaseProtocol = "tcp" | "udp";
export type NormalizedBindScope =
  | "ipv4:*"
  | "ipv6:*"
  | `ipv4:${string}`
  | `ipv6:${string}`;

const BIND_SCOPE_RE = /^(ipv4|ipv6):([^\s|]+)$/;

/**
 * A01 freezes the identity fields; A04 owns address-family/wildcard/dual-stack
 * conflict semantics. The caller must therefore provide an already-normalised
 * scope rather than an arbitrary listen string.
 */
export function protocolPortLeaseKey(input: {
  readonly node_id: number;
  readonly bind_scope: NormalizedBindScope;
  readonly protocol: LeaseProtocol;
  readonly port: number;
}): string {
  const node = positiveInt(input.node_id, "node_id");
  const port = positiveInt(input.port, "port");
  if (port > 65535) throw new Error("port_out_of_range");
  if (!BIND_SCOPE_RE.test(input.bind_scope)) throw new Error("bind_scope_not_normalized");
  return `node:${node}|scope:${input.bind_scope}|protocol:${input.protocol}|port:${port}`;
}

export const LEGACY_COMPATIBILITY = {
  unbound_tunnel_mode: "legacy_private",
  /** Migration is explicit per rule; similarity never auto-merges resources. */
  migration: "expand -> dual-read -> explicit single-writer cutover -> verify -> later contract",
  /** Old plaintext is never relabelled as encrypted. */
  plaintext_reclassification_allowed: false,
  /** Deleting a binding never implies deleting a shared carrier. */
  binding_delete_deletes_link: false,
  /** New shared runtime config has one compiler/writer only. */
  shared_runtime_writer_count: 1,
} as const;
