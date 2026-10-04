/**
 * V4-WP1 — Forward Revision Foundation（`DEVELOPMENT.md` §13.3.2 / §13.3.3）。
 *
 * ── 本模块是 Forward 编辑模型的**单一规则实现** ──
 * §13.3.3 硬约束：「校验逻辑只能有一个 Service 实现，preview 与真实 update
 * 不得各写一份规则」。因此这里导出：
 *
 *   · {@link mergeForwardCandidate} —— 读取当前 desired config → 合并 patch
 *     得到**完整候选 config**；
 *   · {@link validateForwardCandidate} —— 对完整候选 config 一次性校验；
 *   · {@link computeForwardImpact} —— 从 current → candidate 的差异算出
 *     §13.3.3 要求的 preview 影响面（外部地址 / NodeBinding / 端口 / 节点 /
 *     listener replacement / warning-blocking）；
 *   · {@link createForwardRevision} —— 事务内生成不可变 snapshot + 写
 *     `tunnel.desired_revision_id` + bump `config_revision`（同一事务）。
 *
 * preview（只读不落库）与 update（落库 + 收敛）都调同一组函数，**不可能**出现
 * 「preview 放行、update 拒绝」或反之。
 *
 * ── 为什么 revision 是「读库取 max 再 +1」而不是自增列 ──
 * `tunnel.config_revision` 是 Agent 侧的 wire 版本计数器（WP2 幂等闸门认它），
 * 必须与 snapshot 的 revision 同值。并发两次编辑时 `@@unique([tunnel_id,
 * revision])` 保证只有一个成功，另一个撞 P2002 → 由本模块统一翻译成
 * `409 revision_conflict` 并回带最新 revision（见 {@link handleRevisionConflict}），
 * 绝不静默覆写。
 */
import { Prisma } from "@prisma/client";
import { db } from "../db.ts";
import {
  normalizeForwardProtocol,
  persistedForwardProtocol,
  type ForwardMode,
  tlsPathsForProtocol,
} from "./forward-contract.ts";
// V5.5 WP15：远端出口腿支持边界只有一处定义（`federation/forward-hop.ts`），
// 校验与运行期必须用同一个集合 —— 各写一份就是"preview 放行、rollout 拒绝"的来源。
import { FEDERATED_EGRESS_UNSUPPORTED_PROTOCOLS } from "./federation/forward-hop.ts";

/* ================================================================== */
/* 契约类型                                                            */
/* ================================================================== */

export type ForwardDesiredStatus = "active" | "inactive";

/** 业务字段全集（§13.3.1）：创建后可编辑的全部字段。 */
export interface ForwardCandidateConfig {
  name: string;
  mode: ForwardMode;
  /** Persisted protocol fact; validation separately decides whether it is admitted. */
  protocol?: string;
  ingress_node_id: number;
  /** direct 必须 null；relay 必填。 */
  egress_node_id: number | null;
  /**
   * V5.4：三跳路由的中间跳。`null` = 单跳（V4 行为，绝大多数行）。
   *
   * 它与入出口是同一类事实（运行时放置），因此必须参与 current / merge / metadata-only
   * 三处比较 —— 只改它也必须产生新 revision 与 rollout。
   */
  middle_node_id?: number | null;
  /** NULL = 「自动分配」（与创建 contract 同义）。 */
  listen_port: number | null;
  /** direct 目标；relay 可为 null（目标在 egress targets 里）。 */
  target_host: string | null;
  target_port: number | null;
  /**
   * V5-WP5-A1：tls 前端的节点本地证书路径。它与 `protocol` 属于同一份 desired
   * 配置，所以同样可合并 —— 否则运维换一个证书文件名就必须删了重建（而重建还会
   * 重新分配监听端口）。
   */
  tls_cert_path?: string | null;
  tls_key_path?: string | null;
  /**
   * V5.5 WP15：这条 Forward 的**出口腿**由一个 peer panel 承载（存 peer_panel_id）。
   *
   * 它与 `egress_node_id` 是**互斥**的两件事（同一跳只能在一侧）：声明了 peer 就
   * 表示"本机没有出口节点"，因此必须参与 current / merge / metadata-only 三处比较
   * —— 只改它与只改 `middle_node_id` 是同一类 bug（漏在比较里 ⇒ PATCH 被当成
   * 纯 metadata，只写个 name 就 200，而"出口在哪一侧"一个字节没变）。
   *
   * 可空且可缺省：`undefined` = 未提交（沿用当前值），`null` = 明确回到"本机出口"。
   * 契约：`docs/v5-wp14-16-federation-contract.md` §3.2 / §3.4 / §9。
   */
  federated_egress_peer?: string | null;
}

/** patch 入参：全部可选；缺省 = 沿用当前 desired config 的值。 */
export type ForwardCandidatePatch = Partial<ForwardCandidateConfig>;

/** 编辑请求里 revision 之外的并发闸门（与 {@link ForwardCandidatePatch} 同体）。 */
export interface ForwardRevisionUpdateInput extends ForwardCandidatePatch {
  expected_revision?: number | null;
}

/** 当前 desired config 所在的最小行投影（tunnel 行 + 可选 snapshot）。 */
export interface ForwardRevisionRow {
  id: number;
  workspace_id: number;
  name: string;
  tunnel_mode: string | null;
  tunnel_type?: string | null;
  forward_protocol?: string | null;
  /** V5-WP5-A1：tls 前端的节点本地路径（只有路径，永远没有密钥内容）。 */
  tls_cert_path?: string | null;
  tls_key_path?: string | null;
  ingress_node_id: number | null;
  egress_node_id: number | null;
  /** V5.4：中间跳（NULL = 单跳）。 */
  middle_node_id?: number | null;
  ingress_node: { id: number; node_id: string; role: string | null } | null;
  egress_node: { id: number; node_id: string; role: string | null } | null;
  /** RELAY 指向的出口目标池 */
  egress_pool: { id: number; node_id: number } | null;
  egress_targets?: Array<{ host: string; port: number; weight: number; order_by: number }>;
  /** V5.5 WP15：出口腿的远端承载方（NULL = 本机出口，V4/V5 既有语义）。 */
  federated_egress_peer?: string | null;
  listen_ip: string | null;
  listen_port: number | null;
  remote_host: string | null;
  remote_port: number | null;
  egress_port: number | null;
  desired_status: string | null;
  apply_status: string | null;
  config_revision: number | null;
  applied_revision: number | null;
  desired_revision_id: number | null;
}

/** preview / update 共用的影响面（§13.3.3 逐项）。 */
export interface ForwardImpact {
  metadata_only: boolean;
  runtime_change: boolean;
  /** 外部访问地址是否改变（ingress 节点或监听端口变化）。 */
  changes_external_address: boolean;
  listen_port_change: boolean;
  /** 是否需要重建 listener（端口/入口节点/模式变化；纯 target 热换不算）。 */
  listener_replacement: boolean;
  ingress_node_change: boolean;
  egress_node_change: boolean;
  /** V5.5 WP15：出口腿的承载方（本机 ↔ peer）发生了变化。 */
  federated_egress_change?: boolean;
  /** V5.4：中间跳增加 / 删除 / 换节点。它不换 listener，但一定会改变 RELAY next_hop。 */
  middle_node_change?: boolean;
  mode_change: boolean;
  /** target host/port 热换（旧连接保持、新连接走新目标）。 */
  target_change: boolean;
  /** RELAY 出口池/目标集变化。 */
  egress_target_change: boolean;
  /** 参与 PREPARE / DRAIN 的 node_id（入口/出口变化时含新旧两端）。 */
  nodes_prepare_drain: string[];
  /** RELAY 需要新 NodeBinding。 */
  binding_required: boolean;
  port_status: "ok" | "auto" | "conflict" | "out_of_range";
  /** 预测的 ingress 访问地址（`ip:port`），无法确定时为 null。 */
  desired_address: string | null;
}

export interface ForwardValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** 每条 error/warning 的机器可判定原因码（前端按码给下一步）。 */
  reasons: string[];
}

export interface ForwardPreviewResult {
  current: {
    revision: number;
    config: ForwardCandidateConfig;
    apply_status: string | null;
    desired_status: string | null;
  };
  candidate: {
    revision: number;
    config: ForwardCandidateConfig;
  };
  impact: ForwardImpact;
  validation: ForwardValidation;
}

/* ================================================================== */
/* 错误码（稳定标识：写入 DB / 前端分支都按它，不随文案改版）            */
/* ================================================================== */

export const FORWARD_REVISION_ERROR_CODES = {
  invalid_input: "invalid_input",
  not_found: "not_found",
  revision_conflict: "revision_conflict",
  binding_required: "binding_required",
  port_conflict: "port_conflict",
  port_invalid: "port_invalid",
  node_unavailable: "node_unavailable",
  mode_topology_mismatch: "mode_topology_mismatch",
  db_unavailable: "db_unavailable",
} as const;

export type ForwardRevisionErrorCode =
  (typeof FORWARD_REVISION_ERROR_CODES)[keyof typeof FORWARD_REVISION_ERROR_CODES];

/** 错误码 → HTTP 状态码（路由层只查这张表）。 */
export const FORWARD_REVISION_ERROR_STATUS: Record<
  ForwardRevisionErrorCode,
  400 | 403 | 404 | 409 | 502 | 503
> = {
  invalid_input: 400,
  not_found: 404,
  revision_conflict: 409,
  binding_required: 409,
  port_conflict: 409,
  port_invalid: 400,
  node_unavailable: 409,
  mode_topology_mismatch: 400,
  db_unavailable: 503,
};

/** HTTPException 之外的轻量错误载体（服务层返回给路由层翻译）。 */
export class ForwardRevisionError extends Error {
  readonly code: ForwardRevisionErrorCode;
  readonly data?: Record<string, unknown>;
  constructor(code: ForwardRevisionErrorCode, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "ForwardRevisionError";
    this.code = code;
    this.data = data;
  }
  get status(): 400 | 403 | 404 | 409 | 502 | 503 {
    return FORWARD_REVISION_ERROR_STATUS[this.code];
  }
}

/** Prisma 已知错误 → 本模块错误（P2002 唯一冲突 / P2025 行不存在）。 */
export function toForwardRevisionError(e: unknown, fallback = "操作失败，请稍后重试"): ForwardRevisionError {
  const code = (e as { code?: string } | null)?.code;
  if (code === "P2002") {
    return new ForwardRevisionError("revision_conflict", "并发编辑冲突，请刷新后重试");
  }
  if (code === "P2025") {
    return new ForwardRevisionError("not_found", "端口转发不存在");
  }
  return new ForwardRevisionError("db_unavailable", fallback);
}

/** 端口黑名单：与 portPool.PORT_BLACKLIST 同口径（重复声明避免循环 import）。 */
const RESERVED_PORTS = [22, 80, 443, 3306, 5432, 6379, 27017, 9090, 9191];

/* ================================================================== */
/* 纯函数：当前 desired config 抽取                                      */
/* ================================================================== */

/**
 * 从行投影取「当前 desired config」。
 *
 * 优先用 `desired_revision_id` 指向的 snapshot（权威来源）；无 snapshot 的存量行
 * 按兼容投影列合成（等价于 revision 1 的基线）。两条路产出同一形状，
 * 因此「存量 Forward 首次编辑」与「已编辑过的 Forward 再次编辑」走的合并逻辑
 * 完全一致。
 */
export function currentDesiredConfig(row: ForwardRevisionRow): ForwardCandidateConfig {
  return {
    name: row.name,
    mode: row.tunnel_mode === "relay" ? "relay" : "direct",
    protocol: persistedForwardProtocol(row.forward_protocol, row.tunnel_type),
    ingress_node_id: row.ingress_node_id ?? 0,
    egress_node_id: row.egress_node_id ?? null,
    // V5.4：中间跳是**运行时放置事实**，和入出口同类 —— 所以它必须出现在 current / merge /
    // metadata-only 三处比较里。漏掉它与 V5-WP5-A1 漏掉 tls 路径是同一个 bug：
    // PATCH 只改中间跳时会被判成"纯 metadata"，只写 name 就返回 200，而路由一个字节没变。
    middle_node_id: row.middle_node_id ?? null,
    // 注意：这里取**请求值**语义的表格。存量行没有 snapshot，listen_port 列
    // 存的是编排后落地的 concrete port，无法与「用户请求自动」区分——按
    // 「当前占用」处理比按「自动」处理安全（不会把 fixed port 偷偷改成 auto）。
    listen_port: row.listen_port ?? null,
    target_host: row.remote_host ?? null,
    target_port: row.remote_port ?? null,
    tls_cert_path: row.tls_cert_path ?? null,
    tls_key_path: row.tls_key_path ?? null,
    // V5.5 WP15：出口腿在哪一侧是**运行时放置事实**（与入出口/中间跳同类），
    // 所以它必须出现在 current / merge / metadata-only 三处比较里。
    federated_egress_peer: normalizeFederatedEgressPeer(row.federated_egress_peer),
  };
}

/**
 * 合并 patch 得到**完整候选 config**（§13.3.3「读取当前 desired → 合并」
 * 的落地）。未出现的字段保留当前值；显式 `null` 是合法语义（如
 * `listen_port: null` = 改为自动分配，`egress_node_id: null` = 改为 direct
 * 或清空出口）。
 */
export function mergeForwardCandidate(
  base: ForwardCandidateConfig,
  patch: ForwardCandidatePatch,
): ForwardCandidateConfig {
  return {
    name: patch.name !== undefined ? patch.name : base.name,
    mode: patch.mode !== undefined ? patch.mode : base.mode,
    protocol: patch.protocol !== undefined ? patch.protocol : base.protocol,
    ingress_node_id:
      patch.ingress_node_id !== undefined ? patch.ingress_node_id : base.ingress_node_id,
    egress_node_id: patch.egress_node_id !== undefined ? patch.egress_node_id : base.egress_node_id,
    middle_node_id: patch.middle_node_id !== undefined ? patch.middle_node_id : base.middle_node_id,
    listen_port: patch.listen_port !== undefined ? patch.listen_port : base.listen_port,
    target_host: patch.target_host !== undefined ? patch.target_host : base.target_host,
    target_port: patch.target_port !== undefined ? patch.target_port : base.target_port,
    tls_cert_path: patch.tls_cert_path !== undefined ? patch.tls_cert_path : base.tls_cert_path,
    tls_key_path: patch.tls_key_path !== undefined ? patch.tls_key_path : base.tls_key_path,
    federated_egress_peer:
      patch.federated_egress_peer !== undefined
        ? normalizeFederatedEgressPeer(patch.federated_egress_peer)
        : normalizeFederatedEgressPeer(base.federated_egress_peer),
  };
}

/**
 * 归一化远端出口声明：`undefined`/空串/纯空白 一律按"未声明"（null）处理。
 *
 * 为什么空白也算未声明：`""` 与 NULL 在运行期是同一个问题（"这一跳在本机"），
 * 让两种写法产生两种状态只会制造一个只有靠猜才能解释的差异。
 */
export function normalizeFederatedEgressPeer(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const peer = value.trim();
  return peer.length === 0 ? null : peer;
}

/** 是否纯 metadata 修改（当前只有 name）：§13.3.2 禁止为它触发 runtime 重建。 */
export function isMetadataOnlyPatch(base: ForwardCandidateConfig, candidate: ForwardCandidateConfig): boolean {
  return (
    base.mode === candidate.mode &&
    persistedForwardProtocol(base.protocol) === persistedForwardProtocol(candidate.protocol) &&
    base.ingress_node_id === candidate.ingress_node_id &&
    base.egress_node_id === candidate.egress_node_id &&
    (base.middle_node_id ?? null) === (candidate.middle_node_id ?? null) &&
    base.listen_port === candidate.listen_port &&
    (base.target_host ?? "") === (candidate.target_host ?? "") &&
    (base.target_port ?? null) === (candidate.target_port ?? null) &&
    // V5-WP5-A1: the tls paths are runtime configuration, exactly like the target
    // is — so changing ONLY them must produce a revision and a rollout.
    //
    // Leaving them out of this comparison made a paths-only PATCH "metadata only":
    // the metadata branch writes `{ name }` and nothing else, so the API answered
    // 200 while the new certificate path was neither stored nor applied. The
    // operator's symptom would be a "saved" rotation that keeps serving the old
    // certificate — the exact failure G1A.6 exists to prevent.
    (base.tls_cert_path ?? null) === (candidate.tls_cert_path ?? null) &&
    (base.tls_key_path ?? null) === (candidate.tls_key_path ?? null) &&
    // V5.5 WP15：改"出口腿在哪一侧"是一次真实的放置变更（远端租约要建/要释放），
    // 绝不能被判成 metadata-only —— 那会返回 200 而什么都不发生。
    normalizeFederatedEgressPeer(base.federated_egress_peer) ===
      normalizeFederatedEgressPeer(candidate.federated_egress_peer)
  );
}

/* ================================================================== */
/* 纯函数：校验（preview 与 update 共用同一实现）                        */
/* ================================================================== */

/**
 * 归一化名称：trim + 长度上限 60（与创建表单同口径）。
 * 返回 null = 非法。
 */
export function normalizeForwardName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name.length < 1 || name.length > 60) return null;
  return name;
}

/** 端口归一化：1..65535 整数；null = 自动分配；其它 → null + reason。 */
export function normalizeForwardPort(
  value: unknown,
): { ok: true; port: number | null } | { ok: false; reason: string; code: ForwardRevisionErrorCode } {
  if (value === undefined) return { ok: true, port: null };
  if (value === null) return { ok: true, port: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    return { ok: false, reason: "端口必须是 1-65535 的整数", code: "port_invalid" };
  }
  return { ok: true, port: value };
}

export function normalizeTargetHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim();
  if (host.length < 1 || host.length > 255) return null;
  return host;
}

/**
 * 校验**完整候选 config**。
 *
 * 只做不依赖 DB 的形态/互斥校验；需要读库的部分（节点归属/能力、端口占用、
 * NodeBinding 存在性）在 {@link validateForwardCandidateWithDb} 追加。
 * 两者被 preview 与 update 按固定顺序串联，因此两边结论必然一致。
 */
export function validateForwardCandidate(candidate: ForwardCandidateConfig): ForwardValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const reasons: string[] = [];

  const name = normalizeForwardName(candidate.name);
  if (name === null) {
    errors.push("转发名称不能为空且不超过 60 字符");
    reasons.push("invalid_name");
  }

  if (candidate.mode !== "direct" && candidate.mode !== "relay") {
    errors.push("转发模式只能是 direct 或 relay");
    reasons.push("invalid_mode");
    return { ok: false, errors, warnings, reasons };
  }

  if (normalizeForwardProtocol(candidate.protocol) === null) {
    errors.push("当前版本不支持该转发协议");
    reasons.push("invalid_protocol");
    return { ok: false, errors, warnings, reasons };
  }

  // V5-WP5-A1: the tls path rule lives in ONE place (`tlsPathsForProtocol`) and is
  // now applied on the pure validation path, so create, preview and patch answer
  // with the same reason. Before this, create returned 400 for a non-tls with paths
  // while PATCH silently discarded them — the same rule with two behaviours, which
  // is worse than either behaviour on its own.
  const admittedProtocol = normalizeForwardProtocol(candidate.protocol);
  if (admittedProtocol !== null) {
    const paths = tlsPathsForProtocol(
      admittedProtocol,
      candidate.tls_cert_path,
      candidate.tls_key_path,
    );
    if (!paths.ok) {
      // `reason` here is the human sentence (the same one create returns), so the
      // machine-readable code is added alongside it rather than smuggled into it.
      errors.push(paths.reason);
      reasons.push("tls_paths_invalid");
      return { ok: false, errors, warnings, reasons };
    }
  }

  // V5.1b B1 boundary (DEVELOPMENT.md §6.2): udp is DIRECT-only in this build. The
  // inter-node hop shape for a datagram RELAY is an OPEN product decision, so the
  // panel refuses it here rather than letting the Agent be the only place that says
  // no — a boundary enforced in one layer is a boundary that can be bypassed by the
  // next caller, and the UI must be able to rely on validation, not on a warning of
  // its own.
  if (admittedProtocol === "udp" && candidate.mode !== "direct") {
    errors.push("UDP 转发当前只支持 DIRECT：跨节点跳的形态尚未冻结");
    reasons.push("datagram_relay_unsupported");
    return { ok: false, errors, warnings, reasons };
  }

  if (!Number.isInteger(candidate.ingress_node_id) || candidate.ingress_node_id < 1) {
    errors.push("必须指定入口节点");
    reasons.push("missing_ingress");
  }

  // ── V5.5 WP15：远端出口腿的声明（契约 §9 的第一阶段边界，全部 fail-closed）──
  //
  // 这些判定必须在**落库之前**给出可行动的原因码：一个"声明了但跑不起来"的
  // Forward 会让每一次 rollout 都失败在远端，而用户只看到一次保存成功。
  const federatedPeer = normalizeFederatedEgressPeer(candidate.federated_egress_peer);
  if (federatedPeer !== null) {
    if (candidate.mode !== "relay") {
      errors.push("只有 RELAY 转发才有独立的出口跳，DIRECT 不能声明远端出口");
      reasons.push("federated_egress_requires_relay");
      return { ok: false, errors, warnings, reasons };
    }
    if (candidate.egress_node_id !== null) {
      // 互斥而不是"以某一个为准"：两处同时声明时，运行期没人知道该信哪个
      // （本地会去分配端口、远端也会去租一条腿，而它们代表同一跳）。
      errors.push("远端出口 peer 与本机出口节点互斥：出口腿只能在一侧（清空本机出口节点或移除 peer）");
      reasons.push("federated_egress_conflicts_with_local_egress");
      return { ok: false, errors, warnings, reasons };
    }
    if ((candidate.middle_node_id ?? null) !== null) {
      errors.push("远端出口 + 中间跳 = 跨面板 3+ 跳，当前版本明确关闭");
      reasons.push("federated_egress_multi_hop_unsupported");
      return { ok: false, errors, warnings, reasons };
    }
    if (admittedProtocol !== null && FEDERATED_EGRESS_UNSUPPORTED_PROTOCOLS.includes(admittedProtocol)) {
      // 证书是**节点本地文件**，本机不可能知道对端那台节点的路径；猜一个路径
      // 等于下发一条永远起不来的监听（同"不猜 IP"的理由）。
      errors.push(`协议 ${admittedProtocol} 需要节点本地的证书文件路径，无法交给远端 peer；当前版本远端出口只支持 tcp / ws`);
      reasons.push("federated_egress_protocol_unsupported");
      return { ok: false, errors, warnings, reasons };
    }
  }

  if (candidate.mode === "direct") {
    if (candidate.egress_node_id !== null) {
      errors.push("DIRECT 转发不能指定出口节点");
      reasons.push("mode_topology_mismatch");
    }
    const host = normalizeTargetHost(candidate.target_host);
    if (host === null) {
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
      // 声明了远端 peer 时"没有本地出口节点"是**正确**状态（出口腿在 peer 上）；
      // 两种写法都缺出口才是真的缺（上面已经拦掉了互斥与非法组合）。
      if (federatedPeer === null) {
        errors.push("RELAY 转发必须指定出口节点");
        reasons.push("missing_egress");
      }
    } else if (!Number.isInteger(candidate.egress_node_id) || candidate.egress_node_id < 1) {
      errors.push("出口节点 ID 不合法");
      reasons.push("invalid_egress");
    } else if (candidate.egress_node_id === candidate.ingress_node_id) {
      errors.push("入口和出口不能是同一节点");
      reasons.push("same_ingress_egress");
    }
    // RELAY 的目标端口可以缺省（目标在 EgressTarget 上）；若同时给了 host/port，
    // 必须成对出现（RELAY 的 target 快照由 WP3 编排器从池里取）。
    const hasHost = candidate.target_host !== null && normalizeTargetHost(candidate.target_host) !== null;
    const hasPort = candidate.target_port !== null;
    if (hasHost !== hasPort) {
      errors.push("RELAY 转发的目标 Host 与端口必须成对提供");
      reasons.push("incomplete_target");
    }
  }

  const port = normalizeForwardPort(candidate.listen_port ?? undefined);
  if (!port.ok) {
    errors.push(port.reason);
    reasons.push(port.code);
  } else if (port.port !== null && RESERVED_PORTS.includes(port.port)) {
    errors.push(`端口 ${port.port} 是平台保留端口，不能用于转发`);
    reasons.push("port_invalid");
  }

  return { ok: errors.length === 0, errors, warnings, reasons };
}

/** 需要读库的校验输入（归属 / 能力 / 端口占用 / NodeBinding）。 */
export interface ForwardCandidateContext {
  /** 入口节点（已校验属于当前 workspace）。NULL = 不存在/越权。 */
  ingress: {
    id: number;
    node_id: string;
    role: string | null;
    connect_ip: string | null;
    node_group_id?: number | null;
  } | null;
  egress: {
    id: number;
    node_id: string;
    role: string | null;
    node_group_id?: number | null;
    lb_strategy?: string | null;
  } | null;
  /** 同节点上已占用 listen_port 的其它 Forward id（含 legacy DIRECT 与 v3）。 */
  portHolders: Array<{ tunnel_id: number; port: number }>;
  /** ingress → egress 的 NodeBinding 是否存在。 */
  bindingExists: boolean | null;
  /** 该节点是否配置了端口区间（port_range_min/max）；未配置时自动分配会失败。 */
  ingressRangeConfigured: boolean;
}

/**
 * 读库校验的第二段。
 *
 * 与 {@link validateForwardCandidate} 分开纯属依赖方向（无 IO 与有 IO），
 * 但**调用顺序固定**：preview 与 update 都先跑纯校验再跑这一段，
 * 因此两边结论一致（§13.3.3 单一实现）。
 */
export function validateForwardCandidateWithDb(
  candidate: ForwardCandidateConfig,
  ctx: ForwardCandidateContext,
): ForwardValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const reasons: string[] = [];

  if (!ctx.ingress) {
    errors.push("入口节点不存在");
    reasons.push("not_found");
  } else if (ctx.ingress.role !== "ingress" && ctx.ingress.role !== "both") {
    errors.push(`入口节点 ${ctx.ingress.node_id} 不具备入口能力`);
    reasons.push("node_unavailable");
  }

  if (candidate.mode === "relay") {
    // V5.5 WP15：声明了远端出口 peer 时，本机**没有**出口节点 —— 这不是"缺出口"，
    // 而是"出口在另一侧"。远端那一跳的容量与准入由 host 的 grant 决定（契约 §1/§3.1）。
    if (normalizeFederatedEgressPeer(candidate.federated_egress_peer) === null) {
      if (!ctx.egress) {
        errors.push("出口节点不存在");
        reasons.push("not_found");
      } else if (ctx.egress.role !== "egress" && ctx.egress.role !== "both") {
        errors.push(`出口节点 ${ctx.egress.node_id} 不具备出口能力`);
        reasons.push("node_unavailable");
      }
    }
    // Missing edit-time Binding is prepared by rollout.ensure_binding.
    // It is an impact/warning, not a reason to reject the desired topology.
  }

  const port = normalizeForwardPort(candidate.listen_port ?? undefined);
  if (port.ok && port.port !== null) {
    const holder = ctx.portHolders.find((h) => h.port === port.port);
    if (holder) {
      errors.push(`端口 ${port.port} 已被占用`);
      reasons.push("port_conflict");
    }
  }
  if (port.ok && port.port === null && !ctx.ingressRangeConfigured) {
    errors.push("入口节点未配置端口区间，无法自动分配端口");
    reasons.push("node_unavailable");
  }

  return { ok: errors.length === 0, errors, warnings, reasons };
}

/** 两段校验的合并（preview / update 都用它）。 */
export function validateForwardCandidateFull(
  candidate: ForwardCandidateConfig,
  ctx: ForwardCandidateContext | null,
): ForwardValidation {
  const pure = validateForwardCandidate(candidate);
  if (!pure.ok || ctx === null) return pure;
  const withDb = validateForwardCandidateWithDb(candidate, ctx);
  return {
    ok: pure.ok && withDb.ok,
    errors: [...pure.errors, ...withDb.errors],
    warnings: [...pure.warnings, ...withDb.warnings],
    reasons: [...pure.reasons, ...withDb.reasons],
  };
}

/* ================================================================== */
/* 纯函数：影响面（preview 的核心；WP3 五阶段的计划输入）                 */
/* ================================================================== */

/**
 * 预测的对外访问地址（`ip:port`）。无法确定（ingress 未知 / 端口自动且未分配）
 * 时返回 null——**不猜**：对用户宣称一个不确定的地址比说「未知」更糟。
 */
export function predictExternalAddress(
  candidate: ForwardCandidateConfig,
  ingress: { connect_ip: string | null } | null,
  resolvedPort: number | null,
): string | null {
  if (!ingress?.connect_ip) return null;
  const host = String(ingress.connect_ip).split(",").map((x) => x.trim()).find(Boolean);
  if (!host) return null;
  if (resolvedPort === null) return null;
  return `${host}:${resolvedPort}`;
}

/**
 * 从 current → candidate 的差异计算 §13.3.3 要求的 preview 影响面。
 *
 * 分类口径与 §13.3.4「Hot Reload 分类」表逐行对应：
 *  · 名称            → Control Plane only（metadata_only，无数据面影响）
 *  · target host/port → 原 runtime 热换 upstream（target_change，非 listener）
 *  · RELAY Egress     → egress_target_change / egress_node_change
 *  · direct↔relay     → 模式切换（listener 保持但两端全部重下发）
 *  · listen port      → 外部端口改变（listener_replacement）
 *  · ingress node     → 外部 IP/地址可能改变（listener_replacement + DRAIN 旧节点）
 */
export function computeForwardImpact(input: {
  current: ForwardCandidateConfig;
  candidate: ForwardCandidateConfig;
  ingressNodeId: string | null;
  egressNodeId: string | null;
  currentIngressNodeId: string | null;
  currentEgressNodeId: string | null;
  ingressConnectIp: string | null;
  resolvedListenPort: number | null;
  currentResolvedListenPort: number | null;
  bindingRequired: boolean;
}): ForwardImpact {
  const metadataOnly = isMetadataOnlyPatch(input.current, input.candidate);

  const modeChange = input.current.mode !== input.candidate.mode;
  const ingressNodeChange =
    input.current.ingress_node_id !== input.candidate.ingress_node_id;
  // V5.5 WP15：出口腿"在哪一侧"的变化与换出口节点是**同一类**放置变更 ——
  // 计划要重新出 prepare_egress / cutover_egress，远端租约要建/要释放。
  // 把它漏在比较外，声明变更就不会触发任何 rollout 步骤（只在 DB 里改了一列）。
  const federatedEgressChange =
    normalizeFederatedEgressPeer(input.current.federated_egress_peer) !==
    normalizeFederatedEgressPeer(input.candidate.federated_egress_peer);
  const egressNodeChange =
    input.current.egress_node_id !== input.candidate.egress_node_id || federatedEgressChange;
  const middleNodeChange =
    (input.current.middle_node_id ?? null) !== (input.candidate.middle_node_id ?? null);
  const listenPortChange =
    (input.current.listen_port ?? null) !== (input.candidate.listen_port ?? null) ||
    (input.currentResolvedListenPort ?? null) !== (input.resolvedListenPort ?? null);
  const targetChange =
    (input.current.target_host ?? "") !== (input.candidate.target_host ?? "") ||
    (input.current.target_port ?? null) !== (input.candidate.target_port ?? null);
  const egressTargetChange =
    egressNodeChange || (input.candidate.mode === "relay" && targetChange);

  // listener 是否需要重建：端口变化、入口节点迁移、模式切换。
  // target 热换**不重建** listener（§13.3.4：旧连接继续、新连接走新目标）。
  const listenerReplacement =
    !metadataOnly && (listenPortChange || ingressNodeChange || modeChange);

  const changesExternalAddress = !metadataOnly && (listenPortChange || ingressNodeChange);

  // 参与 PREPARE / DRAIN 的节点：入口或出口变化时含新旧两端。
  const nodesPrepareDrain = new Set<string>();
  if (!metadataOnly) {
    if (input.ingressNodeId) nodesPrepareDrain.add(input.ingressNodeId);
    if (input.candidate.mode === "relay" && input.egressNodeId) {
      nodesPrepareDrain.add(input.egressNodeId);
    }
    if (ingressNodeChange && input.currentIngressNodeId) nodesPrepareDrain.add(input.currentIngressNodeId);
    if (egressNodeChange && input.currentEgressNodeId) nodesPrepareDrain.add(input.currentEgressNodeId);
  }

  const portStatus: ForwardImpact["port_status"] =
    input.candidate.listen_port === null
      ? "auto"
      : input.candidate.listen_port !== undefined
        ? "ok"
        : "ok";

  const desiredAddress = metadataOnly
    ? null
    : predictExternalAddress(input.candidate, { connect_ip: input.ingressConnectIp }, input.resolvedListenPort);

  return {
    metadata_only: metadataOnly,
    runtime_change: !metadataOnly,
    changes_external_address: changesExternalAddress,
    listen_port_change: listenPortChange,
    listener_replacement: listenerReplacement,
    ingress_node_change: ingressNodeChange,
    egress_node_change: egressNodeChange,
    federated_egress_change: federatedEgressChange,
    middle_node_change: middleNodeChange,
    mode_change: modeChange,
    target_change: targetChange,
    egress_target_change: egressTargetChange,
    nodes_prepare_drain: [...nodesPrepareDrain],
    binding_required: input.bindingRequired,
    port_status: portStatus,
    desired_address: desiredAddress,
  };
}

/* ================================================================== */
/* 读：snapshot 查询                                                    */
/* ================================================================== */

/** 最新 revision 号 = `max(config_revision, 已有 snapshot 最大 revision)`。 */
export function nextRevisionNumber(input: {
  configRevision: number | null;
  maxSnapshotRevision: number | null;
}): number {
  return Math.max(input.configRevision ?? 0, input.maxSnapshotRevision ?? 0) + 1;
}

/** 读取 snapshot 列表（对账/排障/测试用）。 */
export async function listForwardRevisions(
  tunnelId: number,
  limit = 50,
  client?: Prisma.TransactionClient,
): Promise<
  Array<{
    id: number;
    revision: number;
    name: string;
    desired_status: string;
    mode: string;
    ingress_node_id: number;
    egress_node_id: number | null;
    listen_port: number | null;
    target_host: string | null;
    target_port: number | null;
    created_at: Date;
  }>
> {
  const store = client ?? db;
  const rows = await store.forwardRevision.findMany({
    where: { tunnel_id: tunnelId },
    orderBy: [{ revision: "desc" }],
    take: Math.max(1, Math.min(200, limit)),
  });
  return rows.map((r) => ({
    id: r.id,
    revision: r.revision,
    name: r.name,
    desired_status: r.desired_status,
    mode: r.mode,
    ingress_node_id: r.ingress_node_id,
    egress_node_id: r.egress_node_id,
    listen_port: r.listen_port,
    target_host: r.target_host,
    target_port: r.target_port,
    created_at: r.created_at,
  }));
}

/**
 * 并发冲突的统一出口。
 *
 * `@@unique([tunnel_id, revision])` 撞 P2002 时调用：回读最新 revision 返回
 * `409 revision_conflict` + `data.latest_revision`。语义（§13.3.3）：
 *   → 返回/提示最新 revision → 用户刷新后重新确认
 */
export function handleRevisionConflict(e: unknown, latestRevision: number | null): ForwardRevisionError {
  const code = (e as { code?: string } | null)?.code;
  if (code !== "P2002") throw e;
  return new ForwardRevisionError(
    "revision_conflict",
    "该转发已被他人修改，请刷新后重新确认",
    { latest_revision: latestRevision },
  );
}

/* ================================================================== */
/* 写：生成 snapshot + 推进 revision（单事务）                          */
/* ================================================================== */

export interface CreateForwardRevisionInput {
  tunnelId: number;
  /** 本次保存的**完整候选 config**（已是合并后的结果）。 */
  candidate: ForwardCandidateConfig;
  /** 期望状态：suspended 编辑 = inactive（存 desired 不启 runtime）。 */
  desiredStatus: ForwardDesiredStatus;
  /** 保存人（审计上下文）。 */
  createdById: number | null;
  /** RELAY 保存时刻的 active EgressTarget 快照；DIRECT 为 null。 */
  egressTargets?: Array<{ host: string; port: number; weight: number; order_by: number }> | null;
  /** 当前实际占用的 ingress concrete port（自动分配时由编排器回填）。 */
  resolvedListenIp?: string | null;
  /** 与 tunnel 表同源的 egress concrete 端口；无则为 null。 */
  egressPort?: number | null;
  /** egress pool 快照（由调用方在事务外解析好，避免本模块依赖池查询细节）。 */
  egressPoolId?: number | null;
  /**
   * V5-WP13.5B：本 revision 的来源 Route Profile（`DEVELOPMENT.md` §9.4.5）。
   *
   * **可选**：不传时沿用 tunnel 行上的来源指针（未从模板铺出来的 Forward 为 NULL，
   * 于是写入的也是 NULL —— 与新增列之前的行为逐字节一致）。
   *
   * 语义是「来源」而不是「本次由谁生成」：指针只由 Route Profile 的显式 apply
   * 更新，因此后续任何一次编辑都继续如实回答「这条 Forward 来自哪个模板 / 哪个
   * 版本」。具体解析出的跳（含角色）就是本行的 ingress/egress/middle 三列，
   * 用 `buildRoutePlan` 可还原，不再冗余存一份。
   */
  routeProfile?: { id: number; version: number } | null;
}

export interface CreateForwardRevisionResult {
  revision: number;
  snapshotId: number;
  /** 是否实际写入了新 snapshot。false = 纯 metadata（name-only）不生成 revision。 */
  wroteSnapshot: boolean;
}


/**
 * 为已经成功运行、但还没有 revision snapshot 的 Forward 补一条**同 revision**
 * baseline。它不 bump config_revision：只把当前 applied runtime 冻结为不可变
 * snapshot，并在该 revision 仍是 desired/applied 同步态时补 desired_revision_id。
 *
 * 这是 create/retry → 首次编辑之间的桥：没有 baseline 时，下一次 listener
 * replacement 只能看到新 desired，看不到旧 runtime，DRAIN/CLEANUP 就无法规划。
 */
export async function ensureForwardBaselineRevision(
  tunnelId: number,
  createdById: number | null,
  client?: Prisma.TransactionClient,
): Promise<{ revision: number; snapshotId: number; created: boolean } | null> {
  const run = async (
    tx: Prisma.TransactionClient,
  ): Promise<{ revision: number; snapshotId: number; created: boolean } | null> => {
    const row = await tx.tunnel.findUnique({
      where: { id: tunnelId },
      select: {
        id: true,
        category: true,
        name: true,
        tunnel_mode: true,
        tunnel_type: true,
        forward_protocol: true,
        ingress_node_id: true,
        egress_node_id: true,
        middle_node_id: true,
        listen_ip: true,
        listen_port: true,
        remote_host: true,
        remote_port: true,
        egress_pool_id: true,
        egress_port: true,
        config_revision: true,
        applied_revision: true,
        desired_revision_id: true,
        desired_status: true,
        // V5.5 WP15：补基线时也要冻结"出口腿当时在哪一侧"，否则旧 runtime 的
        // 快照会看起来像本机出口，补偿/对账会去本机找一条不存在的腿。
        federated_egress_peer: true,
      },
    });
    if (!row || row.category !== "port_forward") return null;

    const revision = Number(row.applied_revision ?? 0);
    const configRevision = Number(row.config_revision ?? 0);
    if (revision < 1 || revision !== configRevision) return null;

    let existing = await tx.forwardRevision.findFirst({
      where: { tunnel_id: tunnelId, revision },
      select: { id: true },
    });
    let created = false;

    if (!existing) {
      const egressTargets =
        row.tunnel_mode === "relay" && row.egress_pool_id != null
          ? await tx.egressTarget.findMany({
              where: { pool_id: row.egress_pool_id, status: "active" },
              orderBy: [{ order_by: "asc" }, { id: "asc" }],
              select: { host: true, port: true, weight: true, order_by: true },
            })
          : [];
      const targets =
        egressTargets.length > 0
          ? (egressTargets as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull;

      try {
        existing = await tx.forwardRevision.create({
          data: {
            tunnel_id: tunnelId,
            revision,
            name: row.name,
            desired_status: row.desired_status ?? "active",
            mode: row.tunnel_mode === "relay" ? "relay" : "direct",
            protocol: persistedForwardProtocol(row.forward_protocol, row.tunnel_type),
            ingress_node_id: row.ingress_node_id ?? 0,
            egress_node_id: row.egress_node_id,
            middle_node_id: row.middle_node_id,
            listen_ip: row.listen_ip,
            listen_port: row.listen_port,
            target_host: row.tunnel_mode === "direct" ? row.remote_host : null,
            target_port: row.tunnel_mode === "direct" ? row.remote_port : null,
            egress_pool_id: row.tunnel_mode === "relay" ? row.egress_pool_id : null,
            egress_port: row.tunnel_mode === "relay" ? row.egress_port : null,
            federated_egress_peer: normalizeFederatedEgressPeer(row.federated_egress_peer),
            targets,
            created_by_id: createdById,
          },
          select: { id: true },
        });
        created = true;
      } catch (e) {
        if ((e as { code?: string } | null)?.code !== "P2002") throw e;
        existing = await tx.forwardRevision.findFirst({
          where: { tunnel_id: tunnelId, revision },
          select: { id: true },
        });
        if (!existing) throw e;
      }
    }

    await tx.tunnel.updateMany({
      where: {
        id: tunnelId,
        config_revision: revision,
        applied_revision: revision,
        desired_revision_id: null,
      },
      data: { desired_revision_id: existing.id },
    });

    return { revision, snapshotId: existing.id, created };
  };

  if (client) return run(client);
  return db.$transaction(run);
}

/**
 * 不可变 snapshot 的**唯一**写入入口。
 *
 * 事务内三件事必须原子（否则会出现「指针指向不存在的 revision」这种中间态）：
 *   1. `forwardRevision.create`（撞 P2002 → {@link handleRevisionConflict}）；
 *   2. `tunnel.update({ config_revision: revision, desired_revision_id: id })`；
 *   3. 兼容投影列同步（name / tunnel_mode / ingress/egress_node_id / listen_port /
 *      remote_host / remote_port / forward_addresses / desired_status），
 *      让 socket/config-generator 与旧 Agent 继续按投影列工作。
 *
 * 纯 metadata 修改（仅改名）**不调用本函数**：§13.3.2 禁止为改名生成 revision
 * 或触发 listener 重建。
 */
export async function createForwardRevision(
  input: CreateForwardRevisionInput,
  client?: Prisma.TransactionClient,
): Promise<CreateForwardRevisionResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<CreateForwardRevisionResult> => {
    const row = await tx.tunnel.findUnique({
      where: { id: input.tunnelId },
      select: {
        config_revision: true,
        name: true,
        tunnel_mode: true,
        tunnel_type: true,
        forward_protocol: true,
        ingress_node_id: true,
        egress_node_id: true,
        listen_ip: true,
        listen_port: true,
        forward_addresses: true,
        forward_addresses_protocol: true,
        out_node_group_id: true,
        desired_status: true,
        // V5.5 WP15：未提交声明时"沿用当前值"（与 route_profile 指针同一取向）。
        federated_egress_peer: true,
        // V5-WP13.5B：来源模板指针（缺省 = NULL，见 CreateForwardRevisionInput.routeProfile）。
        route_profile_id: true,
        route_profile_version: true,
      },
    });
    if (!row) throw new ForwardRevisionError("not_found", "端口转发不存在");

    const [maxSnapshot] = await tx.forwardRevision.findMany({
      where: { tunnel_id: input.tunnelId },
      orderBy: { revision: "desc" },
      take: 1,
      select: { revision: true },
    });
    const revision = nextRevisionNumber({
      configRevision: row.config_revision,
      maxSnapshotRevision: maxSnapshot?.revision ?? null,
    });

    const protocol = normalizeForwardProtocol(input.candidate.protocol);
    if (protocol === null) {
      throw new ForwardRevisionError("invalid_input", "当前版本不支持该转发协议");
    }

    // V5.5 WP15：远端出口腿的目标池**不落本机 EgressPool** —— 池是"某台本机出口节点
    // 拨号去哪里"的关系，而那一跳不在这台面板上（契约 §1/§7：不复制远端资源）。
    // 目标作为这一版 revision 的运行态事实进 snapshot，apply 时随 grant 交给 host。
    const federatedPeer = normalizeFederatedEgressPeer(input.candidate.federated_egress_peer);
    const federatedRelay = federatedPeer !== null && input.candidate.mode === "relay";
    const relayTargets =
      federatedRelay && (!input.egressTargets || input.egressTargets.length === 0)
        ? input.candidate.target_host && input.candidate.target_port != null
          ? [{ host: input.candidate.target_host, port: input.candidate.target_port, weight: 1, order_by: 1000 }]
          : []
        : null;
    if (federatedRelay && (!input.egressTargets || input.egressTargets.length === 0) && relayTargets!.length === 0) {
      throw new ForwardRevisionError("invalid_input", "远端出口腿必须至少有一个目标（host + port）");
    }

    const targets =
      input.candidate.mode === "relay" && input.egressTargets && input.egressTargets.length > 0
        ? (input.egressTargets as unknown as Prisma.InputJsonValue)
        : relayTargets && relayTargets.length > 0
          ? (relayTargets as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull;

    let snapshotId: number;
    try {
      const created = await tx.forwardRevision.create({
        data: {
          tunnel_id: input.tunnelId,
          revision,
          name: input.candidate.name.trim(),
          desired_status: input.desiredStatus,
          mode: input.candidate.mode,
          protocol,
          ingress_node_id: input.candidate.ingress_node_id,
          egress_node_id: input.candidate.egress_node_id,
          middle_node_id: input.candidate.middle_node_id ?? null,
          listen_ip: input.resolvedListenIp ?? row.listen_ip,
          listen_port: input.candidate.listen_port,
          // 本机出口才存 target_host/port（DIRECT 的目标面在本机；RELAY 的目标在
          // targets 快照里）。远端出口腿的目标同样只在 targets 快照里。
          target_host: input.candidate.mode === "direct" ? input.candidate.target_host : null,
          target_port: input.candidate.mode === "direct" ? input.candidate.target_port : null,
          egress_pool_id: input.egressPoolId ?? null,
          egress_port: input.egressPort ?? null,
          // V5.5 WP15：这一跳"在哪一侧"是本次 revision 的**不可变放置事实**。
          // 候选没提交（undefined）时沿用 tunnel 行的当前值 —— 与 route_profile
          // 指针同一取向：不提交 ≠ 清空。
          federated_egress_peer:
            input.candidate.federated_egress_peer === undefined
              ? normalizeFederatedEgressPeer(row.federated_egress_peer)
              : normalizeFederatedEgressPeer(input.candidate.federated_egress_peer),
          targets,
          created_by_id: input.createdById,
          // V5-WP13.5B：来源模板的**不可变** provenance（§9.4.5）。显式入参优先，
          // 否则沿用 tunnel 行的指针（未从模板铺出来的 Forward 两列都是 NULL）。
          route_profile_id: input.routeProfile?.id ?? row.route_profile_id ?? null,
          route_profile_version: input.routeProfile?.version ?? row.route_profile_version ?? null,
        },
        select: { id: true },
      });
      snapshotId = created.id;
    } catch (e) {
      throw handleRevisionConflict(e, revision - 1);
    }

    const directTarget =
      input.candidate.mode === "direct" && input.candidate.target_host && input.candidate.target_port
        ? [targetAddress(input.candidate.target_host, input.candidate.target_port)]
        : null;
    // legacy 投影列是 JSON 类型：读出来是 JsonValue（可能是 null），写回去必须转成
    // Prisma 的输入类型。直接透传会触发 TS2322（`null` 不在 InputJsonValue 里）。
    const existingAddresses = (row.forward_addresses ?? Prisma.JsonNull) as Prisma.InputJsonValue;
    const existingProtocol =
      (row.forward_addresses_protocol ?? Prisma.JsonNull) as Prisma.InputJsonValue;

    await tx.tunnel.update({
      where: { id: input.tunnelId },
      data: {
        // ── 兼容投影列：socket/config-generator 与旧 Agent 的唯一读取源 ──
        name: input.candidate.name.trim(),
        tunnel_mode: input.candidate.mode,
        forward_protocol: protocol,
        ingress_node_id: input.candidate.ingress_node_id,
        egress_node_id: input.candidate.egress_node_id,
        middle_node_id: input.candidate.middle_node_id ?? null,
        // V5.5 WP15：声明列与 snapshot 在同一事务里落库（这就是"单写者"）。
        // 只在候选**提交了**这一字段时才写：未提交的调用方（如按模板铺出来的
        // revision）不得因为路过这里而把用户的声明清成 NULL。
        ...(input.candidate.federated_egress_peer === undefined
          ? {}
          : { federated_egress_peer: normalizeFederatedEgressPeer(input.candidate.federated_egress_peer) }),
        // 自动分配时保留当前 concrete port（编排器 apply 后再写回确切值）：
        // 把它清成 null 会让 reconciler 在「尚未 apply」的窗口里读到残缺状态。
        listen_port: input.candidate.listen_port ?? row.listen_port,
        listen_ip: input.resolvedListenIp ?? row.listen_ip,
        // V5.5 WP15：远端出口腿的目标存在投影列上（RELAY 本机出口的目标在
        // EgressPool 里，而远端腿没有本机池）。创建/重试路径要从这里读回目标再
        // 交给 host —— 少了这一步，远端腿会拿到一个空目标集。
        remote_host:
          input.candidate.mode === "direct"
            ? input.candidate.target_host
            : federatedPeer !== null
              ? input.candidate.target_host
              : null,
        remote_port:
          input.candidate.mode === "direct"
            ? input.candidate.target_port
            : federatedPeer !== null
              ? input.candidate.target_port
              : null,
        forward_addresses: directTarget
          ? (directTarget as unknown as Prisma.InputJsonValue)
          : input.candidate.mode === "relay"
            ? ([] as unknown as Prisma.InputJsonValue)
            : existingAddresses,
        forward_addresses_protocol:
          directTarget !== null
            ? ([protocol] as unknown as Prisma.InputJsonValue)
            : input.candidate.mode === "relay"
              ? ([] as unknown as Prisma.InputJsonValue)
              : existingProtocol,
        out_node_group_id: input.candidate.mode === "direct" ? null : row.out_node_group_id,
        desired_status: input.desiredStatus,
        // ── revision 账本（与 snapshot 同值，同一事务）──
        config_revision: revision,
        desired_revision_id: snapshotId,
      },
    });

    return { revision, snapshotId, wroteSnapshot: true };
  };

  if (client) return run(client);
  return db.$transaction(run);
}

/** host:port 组合（IPv6 加方括号）。与 forward-service#targetAddress 同口径。 */
export function targetAddress(host: string, port: number): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
}
