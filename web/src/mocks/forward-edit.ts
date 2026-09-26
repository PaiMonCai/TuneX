/**
 * WP4 mock 契约：Forward 全字段编辑 + preview。
 *
 * 形状镜像 backend/src/services/forward-revision.ts（V4-WP1 冻结）与
 * backend/src/routes/forwards.ts（PATCH / preview）。mock 的价值在于让 UI
 * 跑在形状正确的契约上，因此这里的错误码、impact 字段、merge 语义与后端
 * **逐条同名**；契约本身以后端为准，后端变更时必须同步本文件。
 *
 * 单一真相源：`resolveForwardCandidateMock()` 被 PATCH 与 preview 共用，
 * 与后端 resolveForwardCandidate() 的结构一致——两个入口只差「是否落库」。
 */
import type {
  ForwardImpact,
  ForwardPatchInput,
  ForwardPreviewResult,
  ForwardValidation,
  PortForward,
} from "@/lib/types";
import type { MockNodeBinding, MockStore } from "./state";
import type { Tunnel, UserNode } from "@/lib/types";

/** WP1 错误码（与 backend FORWARD_REVISION_ERROR_CODES 同名同义）。 */
export const FORWARD_MOCK_ERRORS = {
  invalid_input: "invalid_input",
  not_found: "not_found",
  revision_conflict: "revision_conflict",
  binding_required: "binding_required",
  port_conflict: "port_conflict",
  port_invalid: "port_invalid",
  node_unavailable: "node_unavailable",
  mode_topology_mismatch: "mode_topology_mismatch",
} as const;

export type ForwardMockErrorCode =
  (typeof FORWARD_MOCK_ERRORS)[keyof typeof FORWARD_MOCK_ERRORS];

export interface ForwardMockError {
  status: 400 | 404 | 409;
  code: ForwardMockErrorCode;
  message: string;
  data?: { latest_revision?: number; errors?: string[]; reasons?: string[] };
}

/** mock 端完整候选 config（与后端 ForwardCandidateConfig 同形）。 */
export interface MockForwardCandidate {
  name: string;
  mode: "direct" | "relay";
  ingress_node_id: number;
  egress_node_id: number | null;
  /** null = 自动分配 */
  listen_port: number | null;
  target_host: string | null;
  target_port: number | null;
}

export interface MockForwardBase extends MockForwardCandidate {
  id: number;
  config_revision: number;
  applied_revision: number | null;
  apply_status: Tunnel["apply_status"];
  desired_status: Tunnel["desired_status"];
}

/**
 * Tunnel 行 → mock desired 投影。
 *
 * mock 的 desired 指针由 tunnel 行自身承担（不引入第二张 revision 表，
 * 见 reports/v4-wp4-plan.md §3），因此这里就是唯一的投影点；
 * PATCH 与 preview 都从它出发合并 patch。
 */
export function rowOf(db: MockStore, tunnel: Tunnel): MockForwardBase {
  const pooled =
    tunnel.egress_pool_id != null
      ? (db.egressTargets.get(tunnel.egress_pool_id) ?? []).find(
          (target) => target.status === "active",
        ) ?? null
      : null;
  const parsed = parseTarget(tunnel.forward_addresses[0]);
  const target =
    pooled ?? (tunnel.remote_host && tunnel.remote_port
      ? { host: tunnel.remote_host, port: tunnel.remote_port }
      : parsed);
  return {
    id: tunnel.id,
    name: tunnel.name,
    mode: (tunnel.tunnel_mode ?? "direct") as "direct" | "relay",
    ingress_node_id:
      tunnel.ingress_node_id ??
      db.nodes.find(
        (node) =>
          node.node_group_id === tunnel.in_node_group_id &&
          (node.role === "ingress" || node.role === "both"),
      )?.id ??
      tunnel.in_node_group_id,
    egress_node_id: tunnel.egress_node_id ?? null,
    listen_port: tunnel.listen_port ?? null,
    target_host: target?.host ?? null,
    target_port: target?.port ?? null,
    config_revision: tunnel.config_revision ?? 0,
    applied_revision: tunnel.applied_revision ?? null,
    apply_status: tunnel.apply_status ?? null,
    desired_status: tunnel.desired_status ?? null,
  };
}

function parseTarget(address: string | undefined): { host: string; port: number } | null {
  if (!address) return null;
  const match = /^\[([^\]]+)\]:(\d+)$/.exec(address) ?? /^([^:]+):(\d+)$/.exec(address);
  if (!match) return null;
  const port = Number(match[2]);
  return Number.isInteger(port) ? { host: match[1]!, port } : null;
}

const RESERVED_PORTS = [22, 80, 443, 3306, 5432, 6379, 27017, 9090, 9191];

function invalid(
  message: string,
  extra?: ForwardMockError["data"],
): { ok: false; error: ForwardMockError } {
  return { ok: false, error: { status: 400, code: "invalid_input", message, data: extra } };
}

/** 端口归一化：1..65535 整数；null = 自动分配；越界/非法 → port_invalid。 */
function normalizePort(value: unknown): { ok: true; port: number | null } | { ok: false; message: string } {
  if (value === undefined || value === null || value === "") return { ok: true, port: null };
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: "端口必须是 1-65535 的整数" };
  }
  return { ok: true, port };
}

function normalizeName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length >= 1 && name.length <= 60 ? name : null;
}

function normalizeHost(value: unknown): string | null {
  const host = typeof value === "string" ? value.trim() : "";
  return host.length >= 1 && host.length <= 255 ? host : null;
}

function normalizeNodeId(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 当前 desired config：mock 的 desired 指针由 tunnel 行自身承担。 */
export function mockCurrentDesiredConfig(row: MockForwardBase): MockForwardCandidate {
  return {
    name: row.name,
    mode: row.mode,
    ingress_node_id: row.ingress_node_id,
    egress_node_id: row.egress_node_id,
    // 存量行存的是落地端口，无法区分「用户请求自动」；与后端同口径按当前占用处理。
    listen_port: row.listen_port,
    target_host: row.target_host,
    target_port: row.target_port,
  };
}

/**
 * 合并 patch 得到完整候选 config。
 *
 * `undefined` = 未提供（沿用当前值）；显式 `null` 是合法语义：
 * `listen_port: null` = 改为自动分配，`egress_node_id: null` = 改为 direct。
 */
export function mergeMockForwardCandidate(
  base: MockForwardCandidate,
  patch: ForwardPatchInput,
): MockForwardCandidate {
  const ingress = normalizeNodeId(patch.ingress_node_id);
  const egress = normalizeNodeId(patch.egress_node_id);
  // undefined = 未提供（沿用当前值）；null / "" = 显式改自动分配。
  const listen = patch.listen_port === undefined ? undefined : normalizePort(patch.listen_port);
  const targetHost = patch.target_host === undefined ? undefined : normalizeHost(patch.target_host);
  const targetPort = patch.target_port === undefined ? undefined : (() => {
    if (patch.target_port === null) return null;
    const n = Number(patch.target_port);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
  })();
  return {
    name: patch.name !== undefined ? normalizeName(patch.name) ?? base.name : base.name,
    mode: patch.mode !== undefined ? patch.mode : base.mode,
    ingress_node_id: ingress === undefined ? base.ingress_node_id : (ingress ?? base.ingress_node_id),
    egress_node_id: egress === undefined ? base.egress_node_id : egress,
    // 归一化失败（越界/非法）时沿用当前值：形态错误由 validate 段报出，
    // 这里不做静默截断（与后端 normalizeForwardPort 的失败路径一致）。
    listen_port:
      listen === undefined ? base.listen_port : listen.ok ? listen.port : base.listen_port,
    target_host: targetHost === undefined ? base.target_host : targetHost,
    target_port: targetPort === undefined ? base.target_port : targetPort,
  };
}

/** 纯 metadata（只有 name）→ 不 bump revision、不收敛 runtime（§13.3.2）。 */
export function isMockMetadataOnlyPatch(
  base: MockForwardCandidate,
  candidate: MockForwardCandidate,
): boolean {
  return (
    base.mode === candidate.mode &&
    base.ingress_node_id === candidate.ingress_node_id &&
    (base.egress_node_id ?? null) === (candidate.egress_node_id ?? null) &&
    (base.listen_port ?? null) === (candidate.listen_port ?? null) &&
    (base.target_host ?? "") === (candidate.target_host ?? "") &&
    (base.target_port ?? null) === (candidate.target_port ?? null)
  );
}

export interface MockForwardEnvironment {
  ingress: UserNode | null;
  egress: UserNode | null;
  /** 同入口节点上被其它 Forward 占用的 listen_port。 */
  portHolders: Array<{ tunnel_id: number; port: number }>;
  /** ingress → egress NodeBinding 是否存在。 */
  bindingExists: boolean | null;
  ingressConnectIp: string | null;
}

/**
 * 纯形态校验（无 IO 段，与后端 validateForwardCandidate 同顺序同 reason 码）。
 * 需要读库的部分见 {@link validateMockCandidateWithEnv}。
 */
export function validateMockCandidate(candidate: MockForwardCandidate): ForwardValidation {
  const errors: string[] = [];
  const reasons: string[] = [];

  if (normalizeName(candidate.name) === null) {
    errors.push("转发名称不能为空且不超过 60 字符");
    reasons.push("invalid_name");
  }
  if (candidate.mode !== "direct" && candidate.mode !== "relay") {
    errors.push("转发模式只能是 direct 或 relay");
    reasons.push("invalid_mode");
    return { ok: false, errors, warnings: [], reasons };
  }
  if (!Number.isInteger(candidate.ingress_node_id) || candidate.ingress_node_id < 1) {
    errors.push("必须指定入口节点");
    reasons.push("missing_ingress");
  }
  if (candidate.mode === "direct") {
    if (candidate.egress_node_id !== null) {
      errors.push("DIRECT 转发不能指定出口节点");
      reasons.push("mode_topology_mismatch");
    }
    if (normalizeHost(candidate.target_host) === null) {
      errors.push("DIRECT 转发必须指定目标 Host");
      reasons.push("missing_target_host");
    }
    if (
      typeof candidate.target_port !== "number" ||
      !Number.isInteger(candidate.target_port) ||
      candidate.target_port < 1 ||
      candidate.target_port > 65535
    ) {
      errors.push("DIRECT 转发必须指定合法目标端口");
      reasons.push("invalid_target_port");
    }
  } else {
    if (candidate.egress_node_id === null) {
      errors.push("RELAY 转发必须指定出口节点");
      reasons.push("missing_egress");
    } else if (!Number.isInteger(candidate.egress_node_id) || candidate.egress_node_id < 1) {
      errors.push("出口节点 ID 不合法");
      reasons.push("invalid_egress");
    } else if (candidate.egress_node_id === candidate.ingress_node_id) {
      errors.push("入口和出口不能是同一节点");
      reasons.push("same_ingress_egress");
    }
    const hasHost = normalizeHost(candidate.target_host) !== null;
    const hasPort = candidate.target_port !== null;
    if (hasHost !== hasPort) {
      errors.push("RELAY 转发的目标 Host 与端口必须成对提供");
      reasons.push("incomplete_target");
    }
  }

  const port = normalizePort(candidate.listen_port);
  if (!port.ok) {
    errors.push(port.message);
    reasons.push("port_invalid");
  } else if (port.port !== null && RESERVED_PORTS.includes(port.port)) {
    errors.push(`端口 ${port.port} 是平台保留端口，不能用于转发`);
    reasons.push("port_invalid");
  }

  return { ok: errors.length === 0, errors, warnings: [], reasons };
}

/** 读库校验段：节点能力 / 端口占用 / NodeBinding（与后端 WithDb 同 reason 码）。 */
export function validateMockCandidateWithEnv(
  candidate: MockForwardCandidate,
  env: MockForwardEnvironment,
): ForwardValidation {
  const errors: string[] = [];
  const reasons: string[] = [];

  if (!env.ingress) {
    errors.push("入口节点不存在");
    reasons.push("not_found");
  } else if (env.ingress.role !== "ingress" && env.ingress.role !== "both") {
    errors.push(`入口节点 ${env.ingress.node_id} 不具备入口能力`);
    reasons.push("node_unavailable");
  }

  if (candidate.mode === "relay") {
    if (!env.egress) {
      errors.push("出口节点不存在");
      reasons.push("not_found");
    } else if (env.egress.role !== "egress" && env.egress.role !== "both") {
      errors.push(`出口节点 ${env.egress.node_id} 不具备出口能力`);
      reasons.push("node_unavailable");
    }
    if (env.ingress && env.egress && env.bindingExists === false) {
      errors.push("该出口尚未绑定到当前入口节点");
      reasons.push("binding_required");
    }
  }

  const port = normalizePort(candidate.listen_port);
  if (port.ok && port.port !== null && env.portHolders.some((h) => h.port === port.port)) {
    errors.push(`端口 ${port.port} 已被占用`);
    reasons.push("port_conflict");
  }

  return { ok: errors.length === 0, errors, warnings: [], reasons };
}

/** 两段合并：preview 与 update 都用它，因此两边结论必然一致（§13.3.3）。 */
export function validateMockCandidateFull(
  candidate: MockForwardCandidate,
  env: MockForwardEnvironment | null,
): ForwardValidation {
  const pure = validateMockCandidate(candidate);
  if (!pure.ok || env === null) return pure;
  const withEnv = validateMockCandidateWithEnv(candidate, env);
  return {
    ok: pure.ok && withEnv.ok,
    errors: [...pure.errors, ...withEnv.errors],
    warnings: [...pure.warnings, ...withEnv.warnings],
    reasons: [...pure.reasons, ...withEnv.reasons],
  };
}

/** 预测对外访问地址 `ip:port`；无法确定时不猜（与后端 predictExternalAddress 同口径）。 */
export function mockPredictExternalAddress(
  candidate: MockForwardCandidate,
  ingressConnectIp: string | null,
  resolvedListenPort: number | null,
): string | null {
  if (!ingressConnectIp) return null;
  const host = String(ingressConnectIp).split(",").map((x) => x.trim()).find(Boolean);
  if (!host || resolvedListenPort === null) return null;
  return `${host}:${resolvedListenPort}`;
}

/**
 * 影响面：与后端 computeForwardImpact / §13.3.4 Hot Reload 分类表逐行对应。
 *
 * mock 只实现 UI 需要的最小真子集，端口冲突判定在后端还有 node_port_lease
 * 一层；UI 断言只覆盖形状与方向，不断言后端才有的精确值。
 */
export function computeMockForwardImpact(input: {
  current: MockForwardCandidate;
  candidate: MockForwardCandidate;
  ingressNodeId: string | null;
  egressNodeId: string | null;
  currentIngressNodeId: string | null;
  currentEgressNodeId: string | null;
  ingressConnectIp: string | null;
  resolvedListenPort: number | null;
  currentResolvedListenPort: number | null;
  bindingRequired: boolean;
}): ForwardImpact {
  const metadataOnly = isMockMetadataOnlyPatch(input.current, input.candidate);
  const modeChange = input.current.mode !== input.candidate.mode;
  const ingressNodeChange =
    input.current.ingress_node_id !== input.candidate.ingress_node_id;
  const egressNodeChange =
    (input.current.egress_node_id ?? null) !== (input.candidate.egress_node_id ?? null);
  const listenPortChange =
    (input.current.listen_port ?? null) !== (input.candidate.listen_port ?? null) ||
    (input.currentResolvedListenPort ?? null) !== (input.resolvedListenPort ?? null);
  const targetChange =
    (input.current.target_host ?? "") !== (input.candidate.target_host ?? "") ||
    (input.current.target_port ?? null) !== (input.candidate.target_port ?? null);
  const egressTargetChange =
    egressNodeChange || (input.candidate.mode === "relay" && targetChange);

  const listenerReplacement =
    !metadataOnly && (listenPortChange || ingressNodeChange || modeChange);
  const changesExternalAddress = !metadataOnly && (listenPortChange || ingressNodeChange);

  const nodesPrepareDrain = new Set<string>();
  if (!metadataOnly) {
    if (input.ingressNodeId) nodesPrepareDrain.add(input.ingressNodeId);
    if (input.candidate.mode === "relay" && input.egressNodeId) {
      nodesPrepareDrain.add(input.egressNodeId);
    }
    if (ingressNodeChange && input.currentIngressNodeId) {
      nodesPrepareDrain.add(input.currentIngressNodeId);
    }
    if (egressNodeChange && input.currentEgressNodeId) {
      nodesPrepareDrain.add(input.currentEgressNodeId);
    }
  }

  const desiredAddress = metadataOnly
    ? null
    : mockPredictExternalAddress(
        input.candidate,
        input.ingressConnectIp,
        input.resolvedListenPort,
      );

  return {
    metadata_only: metadataOnly,
    runtime_change: !metadataOnly,
    changes_external_address: changesExternalAddress,
    listen_port_change: listenPortChange,
    listener_replacement: listenerReplacement,
    ingress_node_change: ingressNodeChange,
    egress_node_change: egressNodeChange,
    mode_change: modeChange,
    target_change: targetChange,
    egress_target_change: egressTargetChange,
    nodes_prepare_drain: [...nodesPrepareDrain],
    binding_required: input.bindingRequired,
    port_status: input.candidate.listen_port === null ? "auto" : "ok",
    desired_address: desiredAddress,
  };
}

/** mock store 读封装：ingress / egress / 占用端口 / binding / connect_ip。 */
export function mockForwardEnvironment(
  db: MockStore,
  candidate: MockForwardCandidate,
  selfTunnelId: number,
): MockForwardEnvironment {
  const findNode = (id: number | null) =>
    id === null ? null : db.nodes.find((node) => node.id === id) ?? null;
  const project = (node: ReturnType<typeof findNode>): UserNode | null => {
    if (!node) return null;
    const group = db.nodeGroups.find((g) => g.id === node.node_group_id);
    const role =
      node.role ??
      (group?.node_type === "in"
        ? "ingress"
        : group?.node_type === "out"
          ? "egress"
          : null);
    return {
      ...node,
      agent_id: node.agent_id ?? `mock-agent-${node.id}`,
      role,
      online: Boolean(node.online) && node.status === "active",
    };
  };
  const ingress = project(findNode(candidate.ingress_node_id));
  const egress = project(findNode(candidate.egress_node_id));
  const portHolders = db.tunnels
    .filter((t) => t.id !== selfTunnelId && t.listen_port !== null && t.listen_port !== undefined)
    .map((t) => ({ tunnel_id: t.id, port: t.listen_port as number }));
  const bindings: MockNodeBinding[] = db.nodeBindings;
  const bindingExists =
    candidate.mode === "relay" && egress && ingress
      ? bindings.some(
          (b) =>
            Number(b.ingress_node_id) === Number(ingress.id) &&
            Number(b.egress_node_id) === Number(egress.id),
        )
      : null;
  return {
    ingress,
    egress,
    portHolders,
    bindingExists,
    ingressConnectIp: ingress?.connect_ip ?? null,
  };
}

/** preview / update 的公共前置（对应后端 resolveForwardCandidate）。 */
export function resolveMockForwardCandidate(
  db: MockStore,
  base: MockForwardBase,
  patch: ForwardPatchInput,
):
  | { ok: true; candidate: MockForwardCandidate; env: MockForwardEnvironment; validation: ForwardValidation }
  | { ok: false; error: ForwardMockError } {
  const current = mockCurrentDesiredConfig(base);
  const candidate = mergeMockForwardCandidate(current, patch);
  const env = mockForwardEnvironment(db, candidate, base.id);

  const pure = validateMockCandidate(candidate);
  if (!pure.ok) {
    return {
      ok: false,
      error: {
        status: 400,
        code: invalid_topology_reason(pure.reasons),
        message: pure.errors[0] ?? "端口转发参数不合法",
        data: { errors: pure.errors, reasons: pure.reasons },
      },
    };
  }
  const validation = validateMockCandidateFull(candidate, env);
  if (!validation.ok) {
    const first = validation.reasons[0];
    const status: ForwardMockError["status"] =
      first === "binding_required" || first === "port_conflict" || first === "node_unavailable"
        ? 409
        : first === "not_found"
          ? 404
          : 400;
    return {
      ok: false,
      error: {
        status,
        code: invalid_topology_reason(validation.reasons),
        message: validation.errors[0] ?? "端口转发参数不合法",
        data: { errors: validation.errors, reasons: validation.reasons },
      },
    };
  }
  return { ok: true, candidate, env, validation };
}

/** 形态/读库校验失败原因码 → 稳定错误码（只映射 UI 分支会用的几个）。 */
function invalid_topology_reason(reasons: string[]): ForwardMockErrorCode {
  if (reasons.includes("mode_topology_mismatch")) return "mode_topology_mismatch";
  if (reasons.includes("binding_required")) return "binding_required";
  if (reasons.includes("port_conflict")) return "port_conflict";
  if (reasons.includes("port_invalid")) return "port_invalid";
  if (reasons.includes("node_unavailable")) return "node_unavailable";
  if (reasons.includes("not_found")) return "not_found";
  return "invalid_input";
}

/**
 * PATCH 落库：合并 → 校验 → expected_revision 闸门 → 递增 revision。
 *
 * mock 的「假 Agent」：非纯 name patch 后把 apply_status 置 pending 并立即
 * 推进到 active（completeOrchestration），与 handler 既有 mock 语义一致；
 * applied_revision 被拉到新 revision，因此 UI 的 running-vs-desired 会经过
 * 「待应用 → 已应用」的完整过程（同一次请求内完成，测试里同步可观测）。
 */
export function applyMockForwardPatch(
  db: MockStore,
  tunnel: Tunnel,
  patch: ForwardPatchInput,
): { ok: true; view: PortForward } | { ok: false; error: ForwardMockError } {
  const row = rowOf(db, tunnel);
  const resolved = resolveMockForwardCandidate(db, row, patch);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { candidate, env } = resolved;
  const metadataOnly = isMockMetadataOnlyPatch(mockCurrentDesiredConfig(row), candidate);

  const expected = patch.expected_revision;
  if (!metadataOnly && expected !== undefined && expected !== null) {
    const latest = Number(tunnel.config_revision ?? 0);
    if (Number(expected) !== latest) {
      return {
        ok: false,
        error: {
          status: 409,
          code: "revision_conflict",
          message: "该转发已被他人修改，请刷新后重新确认",
          data: { latest_revision: latest },
        },
      };
    }
  }

  tunnel.name = candidate.name;
  tunnel.tunnel_mode = candidate.mode;
  tunnel.ingress_node_id = candidate.ingress_node_id;
  tunnel.egress_node_id = candidate.mode === "relay" ? candidate.egress_node_id : null;
  tunnel.listen_port = candidate.listen_port;
  if (candidate.mode === "direct") {
    tunnel.remote_host = candidate.target_host;
    tunnel.remote_port = candidate.target_port;
    const target =
      candidate.target_host && candidate.target_port
        ? candidate.target_host.includes(":") && !candidate.target_host.startsWith("[")
          ? `[${candidate.target_host}]:${candidate.target_port}`
          : `${candidate.target_host}:${candidate.target_port}`
        : `${candidate.target_host ?? ""}:${candidate.target_port ?? ""}`;
    tunnel.forward_addresses = [target];
  }
  tunnel.egress_port = candidate.mode === "relay" ? tunnel.egress_port ?? null : null;
  tunnel.out_node_group_id = candidate.mode === "relay"
    ? env.egress?.node_group_id ?? null
    : null;
  tunnel.out_node_group =
    candidate.mode === "relay"
      ? (() => {
          const g = env.egress?.node_group_id
            ? db.nodeGroups.find((x) => x.id === env.egress!.node_group_id)
            : undefined;
          return g ? { id: g.id, name: g.name, node_type: g.node_type } : null;
        })()
      : null;

  if (metadataOnly) {
    tunnel.updated_at = new Date().toISOString();
    return { ok: true, view: viewMockForward(db, tunnel) };
  }

  tunnel.config_revision = Number(tunnel.config_revision ?? 0) + 1;
  tunnel.desired_status = tunnel.desired_status ?? "active";
  tunnel.apply_status = "pending";
  tunnel.apply_error = null;
  tunnel.apply_error_code = null;
  tunnel.updated_at = new Date().toISOString();
  // 假 Agent ACK（与 create/retry/resume 的 mock 语义一致）。
  tunnel.applied_revision = tunnel.config_revision;
  tunnel.apply_status = "active";
  tunnel.last_applied_at = new Date().toISOString();
  return { ok: true, view: viewMockForward(db, tunnel) };
}

/**
 * preview：同一前置 + 影响面，**不写库**。
 */
export function previewMockForwardUpdate(
  db: MockStore,
  tunnel: Tunnel,
  patch: ForwardPatchInput,
): { ok: true; result: ForwardPreviewResult } | { ok: false; error: ForwardMockError } {
  const row = rowOf(db, tunnel);
  const resolved = resolveMockForwardCandidate(db, row, patch);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { candidate, env } = resolved;
  const base = mockCurrentDesiredConfig(row);
  const metadataOnly = isMockMetadataOnlyPatch(base, candidate);
  const resolvedListenPort = candidate.listen_port ?? row.listen_port ?? null;
  const bindingRequired = candidate.mode === "relay" && env.bindingExists === false;
  const impact = computeMockForwardImpact({
    current: base,
    candidate,
    ingressNodeId: env.ingress?.node_id ?? null,
    egressNodeId: env.egress?.node_id ?? null,
    currentIngressNodeId: row.ingress_node_id
      ? (db.nodes.find((n) => n.id === row.ingress_node_id)?.node_id ?? null)
      : null,
    currentEgressNodeId: row.egress_node_id
      ? (db.nodes.find((n) => n.id === row.egress_node_id)?.node_id ?? null)
      : null,
    ingressConnectIp: env.ingressConnectIp,
    resolvedListenPort,
    currentResolvedListenPort: row.listen_port ?? null,
    bindingRequired,
  });

  return {
    ok: true,
    result: {
      current: {
        revision: Number(row.config_revision ?? 0),
        config: base,
        apply_status: row.apply_status ?? null,
        desired_status: row.desired_status ?? null,
      },
      candidate: {
        revision: Number(row.config_revision ?? 0) + (metadataOnly ? 0 : 1),
        config: candidate,
      },
      impact,
      validation: validateMockCandidateFull(candidate, env),
    },
  };
}

// `viewMockForward` 由 handler 注入，避免本模块反向依赖 handler 的投影函数。
let viewMockForward: (db: MockStore, tunnel: Tunnel) => PortForward = () => {
  throw new Error("viewMockForward not injected");
};

export function injectMockForwardView(
  fn: (db: MockStore, tunnel: Tunnel) => PortForward,
): void {
  viewMockForward = fn;
}
