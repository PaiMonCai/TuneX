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

/* ================================================================== */
/* 契约类型                                                            */
/* ================================================================== */

export type ForwardMode = "direct" | "relay";
export type ForwardDesiredStatus = "active" | "inactive";

/** 业务字段全集（§13.3.1）：创建后可编辑的全部字段。 */
export interface ForwardCandidateConfig {
  name: string;
  mode: ForwardMode;
  ingress_node_id: number;
  /** direct 必须 null；relay 必填。 */
  egress_node_id: number | null;
  /** NULL = 「自动分配」（与创建 contract 同义）。 */
  listen_port: number | null;
  /** direct 目标；relay 可为 null（目标在 egress targets 里）。 */
  target_host: string | null;
  target_port: number | null;
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
  ingress_node_id: number | null;
  egress_node_id: number | null;
  ingress_node: { id: number; node_id: string; role: string | null } | null;
  egress_node: { id: number; node_id: string; role: string | null } | null;
  egress_pool: { id: number; node_id: number } | null;
  egress_targets?: Array<{ host: string; port: number; weight: number; order_by: number }>;
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
    ingress_node_id: row.ingress_node_id ?? 0,
    egress_node_id: row.egress_node_id ?? null,
    // 注意：这里取**请求值**语义的表格。存量行没有 snapshot，listen_port 列
    // 存的是编排后落地的 concrete port，无法与「用户请求自动」区分——按
    // 「当前占用」处理比按「自动」处理安全（不会把 fixed port 偷偷改成 auto）。
    listen_port: row.listen_port ?? null,
    target_host: row.remote_host ?? null,
    target_port: row.remote_port ?? null,
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
    ingress_node_id:
      patch.ingress_node_id !== undefined ? patch.ingress_node_id : base.ingress_node_id,
    egress_node_id: patch.egress_node_id !== undefined ? patch.egress_node_id : base.egress_node_id,
    listen_port: patch.listen_port !== undefined ? patch.listen_port : base.listen_port,
    target_host: patch.target_host !== undefined ? patch.target_host : base.target_host,
    target_port: patch.target_port !== undefined ? patch.target_port : base.target_port,
  };
}

/** 是否纯 metadata 修改（当前只有 name）：§13.3.2 禁止为它触发 runtime 重建。 */
export function isMetadataOnlyPatch(base: ForwardCandidateConfig, candidate: ForwardCandidateConfig): boolean {
  return (
    base.mode === candidate.mode &&
    base.ingress_node_id === candidate.ingress_node_id &&
    base.egress_node_id === candidate.egress_node_id &&
    base.listen_port === candidate.listen_port &&
    (base.target_host ?? "") === (candidate.target_host ?? "") &&
    (base.target_port ?? null) === (candidate.target_port ?? null)
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

  if (!Number.isInteger(candidate.ingress_node_id) || candidate.ingress_node_id < 1) {
    errors.push("必须指定入口节点");
    reasons.push("missing_ingress");
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
      errors.push("RELAY 转发必须指定出口节点");
      reasons.push("missing_egress");
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
  ingress: { id: number; node_id: string; role: string | null; connect_ip: string | null } | null;
  egress: { id: number; node_id: string; role: string | null } | null;
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
    if (!ctx.egress) {
      errors.push("出口节点不存在");
      reasons.push("not_found");
    } else if (ctx.egress.role !== "egress" && ctx.egress.role !== "both") {
      errors.push(`出口节点 ${ctx.egress.node_id} 不具备出口能力`);
      reasons.push("node_unavailable");
    }
    if (ctx.ingress && ctx.egress && ctx.bindingExists === false) {
      errors.push("该出口尚未绑定到当前入口节点");
      reasons.push("binding_required");
    }
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
  const egressNodeChange =
    input.current.egress_node_id !== input.candidate.egress_node_id;
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
}

export interface CreateForwardRevisionResult {
  revision: number;
  snapshotId: number;
  /** 是否实际写入了新 snapshot。false = 纯 metadata（name-only）不生成 revision。 */
  wroteSnapshot: boolean;
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
        ingress_node_id: true,
        egress_node_id: true,
        listen_ip: true,
        listen_port: true,
        forward_addresses: true,
        forward_addresses_protocol: true,
        out_node_group_id: true,
        desired_status: true,
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

    const targets =
      input.candidate.mode === "relay" && input.egressTargets && input.egressTargets.length > 0
        ? (input.egressTargets as unknown as Prisma.InputJsonValue)
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
          ingress_node_id: input.candidate.ingress_node_id,
          egress_node_id: input.candidate.egress_node_id,
          listen_ip: input.resolvedListenIp ?? row.listen_ip,
          listen_port: input.candidate.listen_port,
          target_host: input.candidate.mode === "direct" ? input.candidate.target_host : null,
          target_port: input.candidate.mode === "direct" ? input.candidate.target_port : null,
          egress_pool_id: input.egressPoolId ?? null,
          egress_port: input.egressPort ?? null,
          targets,
          created_by_id: input.createdById,
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
        ingress_node_id: input.candidate.ingress_node_id,
        egress_node_id: input.candidate.egress_node_id,
        // 自动分配时保留当前 concrete port（编排器 apply 后再写回确切值）：
        // 把它清成 null 会让 reconciler 在「尚未 apply」的窗口里读到残缺状态。
        listen_port: input.candidate.listen_port ?? row.listen_port,
        listen_ip: input.resolvedListenIp ?? row.listen_ip,
        remote_host: input.candidate.mode === "direct" ? input.candidate.target_host : null,
        remote_port: input.candidate.mode === "direct" ? input.candidate.target_port : null,
        forward_addresses: directTarget
          ? (directTarget as unknown as Prisma.InputJsonValue)
          : existingAddresses,
        forward_addresses_protocol:
          directTarget !== null
            ? (["tcp"] as unknown as Prisma.InputJsonValue)
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
