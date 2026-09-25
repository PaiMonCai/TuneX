/**
 * WP10 — Admin Node / Egress API 服务层
 *
 * 依据 `DEVELOPMENT.md` §7.13「WP10 / WP11 — API Track」。WP10 的范围：
 *   · Node role（能力声明）管理；
 *   · credential list/get（**只查状态，绝不下发明文或哈希**——issue/rotate/revoke
 *     在 WP7 已交付，见 services/node-credential.ts）；
 *   · EgressPool / EgressTarget CRUD（§2.2 层级 `Node → EgressPool → EgressTarget[]`）；
 *   · runtime/state query（读 `node_state_report`，WP7 的快照表）。
 *
 * ── 本层没有「下发」能力（这是刻意的）──
 * §7.13 对 WP11 立了规矩「所有运行操作统一走 orchestrator，禁止 route 自己写
 * 第二套下发逻辑」，WP10 同样遵守：这里只改 DB 里的 **desired state**（角色、
 * 池、目标），revision 自增、Agent 通知、补偿回滚都是 WP8 编排器的事。
 * 因此本模块**不 import** socket/*、control-protocol/*、portPool（Redis）。
 *
 * ── 为什么端口校验自带一份而不 import portPool ──
 * `EgressTarget.port` 与 `NodePortLease.port` 的合法区间语义相同（1..65535），
 * 但两者的其余校验完全不同：租约端口要过黑名单（那是「监听端口不能被
 * 基础设施占用」），**出口目标端口不能过黑名单**（转发到目标的 443 是天经
 * 地义的事）。所以这里只共享「是不是 1..65535 的整数」这一条，其余本地判；
 * 并且 portPool 有 Redis 连接的模块副作用，不 import 它（本模块的测试必须
 * 能完全不连 DB/Redis/net 跑离线）。
 *
 * ── 依赖注入 ──
 * 与 portPool 同一取向：默认走进程级 `db` 单例，但每个公开函数都接受
 * {@link NodeAdminDeps} 覆盖，测试直接把内存替身传进去，**不需要
 * mock.module**（那个会随 worktree / CI 路径静默打歪）。
 */
import { db } from "../db.ts";

/* ================================================================== */
/* 常量                                                                */
/* ================================================================== */

/** NodeRole 枚举的服务层镜像（schema.prisma `enum NodeRole`）。 */
export const NODE_ROLES = ["ingress", "egress", "both"] as const;
export type NodeRoleValue = (typeof NODE_ROLES)[number];

/** 目标/池启用状态（schema `enum Status`，本模块只用两个值）。 */
export const EGRESS_STATUSES = ["active", "inactive"] as const;
export type EgressStatusValue = (typeof EGRESS_STATUSES)[number];

/** 负载均衡策略（schema `enum LBStrategy`）。 */
export const LB_STRATEGIES = ["round", "rand", "weighted_round"] as const;
export type LbStrategyValue = (typeof LB_STRATEGIES)[number];

/** 每个出口节点自动维护的默认池名（schema `EgressPool` 注释）。 */
export const DEFAULT_POOL_NAME = "default";

/** 端口合法管理区间。 */
export const PORT_MIN = 1;
export const PORT_MAX = 65535;

/**
 * 状态快照视为陈旧（= 面板侧认为「这个节点刚才是离线/没上报」）的秒数。
 *
 * 只是**展示**口径，不替代 socket/offline-detector 的 Redis 防抖翻转
 * （那层才写 `node.status`）；这里根据 `state_report.reported_at` 与当前
 * 时间的差给一个可解释的布尔值，前端直接渲染「5 分钟未上报」。
 */
export const NODE_STATE_STALE_SECONDS = 300;

/** 池名/目标字段的长度上限（与 schema VarChar 对齐）。 */
export const POOL_NAME_MAX = 120;
export const TARGET_HOST_MAX = 255;

/* ================================================================== */
/* 错误模型                                                            */
/* ================================================================== */

export type NodeAdminErrorCode =
  /** 入参校验失败（400） */
  | "invalid_input"
  /** 目标行不存在（404） */
  | "not_found"
  /** 与既有状态冲突：唯一键、池被隧道引用（409） */
  | "conflict"
  /** 当前状态不允许这个操作（409）——例如 ingress 节点要配出口池 */
  | "invalid_state"
  /** 数据库不可用（503；不 fail-open） */
  | "db_unavailable";

/** 错误码 → HTTP 状态码（路由层只查这张表，不自己判）。 */
export const ADMIN_ERROR_STATUS: Record<NodeAdminErrorCode, 400 | 404 | 409 | 503> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  invalid_state: 409,
  db_unavailable: 503,
};

export interface NodeAdminError {
  ok: false;
  code: NodeAdminErrorCode;
  message: string;
}

function err(code: NodeAdminErrorCode, message: string): NodeAdminError {
  return { ok: false, code, message };
}

/** Prisma 已知错误 → 管理面错误（P2002 唯一冲突 / P2025 行不存在）。 */
export function toAdminError(e: unknown, fallback = "操作失败，请稍后重试"): NodeAdminError {
  const code = (e as { code?: string } | null)?.code;
  if (code === "P2002") return err("conflict", "已存在同名记录（唯一键冲突）");
  if (code === "P2025") return err("not_found", "记录不存在");
  return err("db_unavailable", fallback);
}

/* ================================================================== */
/* 类型（DB 行投影）                                                    */
/* ================================================================== */

export interface NodeRow {
  id: number;
  node_id: string;
  status: string;
  weight: number;
  connect_ip: string;
  version: string;
  role: string | null;
  last_seen_at: Date | null;
  port_range_min: number | null;
  port_range_max: number | null;
  lb_strategy: string | null;
  order_by: number;
  backup: boolean;
  dns_status: boolean;
  node_credential_hash: string | null;
  credential_revoked: boolean;
  credential_rotated_at: Date | null;
  credential_last_rejected_at: Date | null;
  node_group?: { id: number; name: string; node_type: string } | null;
  state_report?: StateReportRow | null;
}

export interface StateReportRow {
  node_id: number;
  version: string | null;
  role: string | null;
  reported_revision: number | null;
  tunnels: unknown;
  egress_pools: unknown;
  used_ports: unknown;
  last_error: string | null;
  reported_at: Date;
}

export interface EgressPoolRow {
  id: number;
  node_id: number;
  name: string;
  lb_strategy: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  targets?: EgressTargetRow[];
}

export interface EgressTargetRow {
  id: number;
  pool_id: number;
  host: string;
  port: number;
  weight: number;
  order_by: number;
  remark: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

/** 本模块需要的 DB 投影（prisma `db` 满足之；测试用内存替身）。 */
export interface NodeAdminDb {
  node: {
    findUnique(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    count(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
  };
  egressPool: {
    findUnique(args: unknown): Promise<unknown>;
    findFirst(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    count(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    delete(args: unknown): Promise<unknown>;
  };
  egressTarget: {
    findUnique(args: unknown): Promise<unknown>;
    findFirst(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    count(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
    delete(args: unknown): Promise<unknown>;
  };
  nodeStateReport: {
    findUnique(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
  };
  tunnel: {
    count(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
  };
}

export interface NodeAdminDeps {
  db?: NodeAdminDb;
  /** 覆盖「陈旧」判定用的当前时间（测试注入）。 */
  now?: () => Date;
}

function deps(over: NodeAdminDeps | undefined): { db: NodeAdminDb; now: () => Date } {
  return { db: over?.db ?? defaultDb, now: over?.now ?? (() => new Date()) };
}

/** 进程级默认依赖（路由直接用）。 */
const defaultDb = db as unknown as NodeAdminDb;

/** 把一行 unknown 收窄成行类型（DB 返回值只有调用方知道形状）。 */
function asRow<T>(row: unknown): T | null {
  return row ? (row as T) : null;
}

/** 把一组 unknown 收窄成行数组。 */
function asRows<T>(rows: unknown): T[] {
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** 空串当零的显式布尔判定（表单未勾选 / 老客户端都发 false）。 */
function falsy(input: unknown): boolean {
  return input === false || input === "" || input === "false" || input === null;
}

/* ================================================================== */
/* 纯校验（无 IO，可离线单测）                                          */
/* ================================================================== */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function parseOk<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function parseFail<T>(message: string): ParseResult<T> {
  return { ok: false, message };
}

/**
 * 节点角色解析。`null` = 显式清空（回到「尚未声明角色」）。
 *
 * 空串同样按清空处理：前端 select 的占位项回传空串是常态，把它判成
 * 「不合法」会让管理员永远无法撤回一次误设。但 `undefined` / 键缺失**不是**
 * 清空——缺失表示「这次调用不想动它」，两者必须可区分。
 */
export function parseNodeRole(input: unknown): ParseResult<NodeRoleValue | null> {
  // `undefined` 与 `null` / 空串同为「未指定」：调用方（查询串缺省、表单没填）
  // 都不该因为「没选」而拿到 400。
  if (input === undefined || input === null) return parseOk(null);
  if (input === "") return parseOk(null);
  if (typeof input !== "string") return parseFail("角色必须是 ingress / egress / both");
  const role = input.trim().toLowerCase();
  if (role === "") return parseOk(null);
  if ((NODE_ROLES as readonly string[]).includes(role)) return parseOk(role as NodeRoleValue);
  return parseFail("角色必须是 ingress / egress / both");
}

/**
 * 端口号是否在合法管理区间内（与租约端口同源，但这里没有黑名单——转发到
 * 目标 443 是正常需求）。
 */
export function isValidTargetPort(port: unknown): port is number {
  return (
    typeof port === "number" && Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX
  );
}

/**
 * 解析节点端口区间（per-node 端口所有权域，`node.port_range_min/max`）。
 *
 * `null` = 未配置：分配侧必须拒绝在未配置区间上分配（portPool 的
 * `resolveNodeRange`），管理侧语义同样如此，**不回落**节点组 `port_range`
 * （那是 legacy DIRECT 整组下发用的，不是 per-node 所有权）。
 */
export function parsePortRange(min: unknown, max: unknown): ParseResult<{ min: number; max: number } | null> {
  const minUnset = min === null || min === undefined || min === "";
  const maxUnset = max === null || max === undefined || max === "";
  if (minUnset && maxUnset) return parseOk(null);
  if (minUnset !== maxUnset) return parseFail("端口区间必须同时提供上下限");
  const lo = typeof min === "string" ? Number(min) : min;
  const hi = typeof max === "string" ? Number(max) : max;
  if (!isValidTargetPort(lo) || !isValidTargetPort(hi)) {
    return parseFail(`端口区间必须是 ${PORT_MIN}-${PORT_MAX} 的整数`);
  }
  if (lo > hi) return parseFail("端口区间下限不能大于上限");
  return parseOk({ min: lo, max: hi });
}

export function parseLbStrategy(input: unknown): ParseResult<LbStrategyValue | null> {
  if (input === null || input === undefined || input === "") return parseOk(null);
  if (typeof input !== "string") return parseFail("负载均衡策略必须是 round / rand");
  const v = input.trim().toLowerCase();
  if (v === "") return parseOk(null);
  if ((LB_STRATEGIES as readonly string[]).includes(v)) return parseOk(v as LbStrategyValue);
  return parseFail("负载均衡策略必须是 round / rand");
}

export function parseEgressStatus(input: unknown): ParseResult<EgressStatusValue> {
  if (typeof input !== "string") return parseFail("状态必须是 active / inactive");
  const v = input.trim().toLowerCase();
  if ((EGRESS_STATUSES as readonly string[]).includes(v)) return parseOk(v as EgressStatusValue);
  return parseFail("状态必须是 active / inactive");
}

/** 必填 host 的包装（create 路径）。 */
function parseRequiredHost(input: unknown): ParseResult<string> {
  if (input === undefined || input === null || input === "") return parseFail("目标地址必填");
  return parseTargetHost(input);
}

/** 可选 host（PATCH 路径）：给了就按同一套规则校验，没给就放行。 */
function parseOptionalHost(input: unknown): ParseResult<string | undefined> {
  if (input === undefined || input === null || input === "") return parseOk(undefined);
  return parseTargetHost(input);
}

export function parsePoolName(input: unknown): ParseResult<string> {
  if (typeof input !== "string") return parseFail("池名称不合法");
  const name = input.trim();
  if (name.length === 0 || name.length > POOL_NAME_MAX) {
    return parseFail(`池名称长度必须在 1-${POOL_NAME_MAX} 之间`);
  }
  // 名字会出现在 URL 与配置下发里：空白与斜杠没有任何合法用途。
  if (/[\s/]/.test(name)) return parseFail("池名称不能包含空白或斜杠");
  return parseOk(name);
}

/**
 * 目标地址解析。
 *
 * 刻意**不**拒绝 `:`：IPv6 字面量（`2001:db8::1`）本来就是合法 host，端口
 * 另有独立列。拒绝的是「带 scheme 的 URL」和「含空白的地址」——两者都是把
 * `host:port` 组合串塞进 host 列的旧形状（schema 注释明确禁止）。

 */
export function parseTargetHost(input: unknown): ParseResult<string> {
  if (typeof input !== "string") return parseFail("目标地址不合法");
  const host = input.trim();
  if (host.length === 0 || host.length > TARGET_HOST_MAX) {
    return parseFail(`目标地址长度必须在 1-${TARGET_HOST_MAX} 之间`);
  }
  if (/\s/.test(host)) return parseFail("目标地址不能包含空白字符");
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(host)) {
    return parseFail("目标地址请填写 IP 或域名，不要带 http:// 等前缀");
  }
  return parseOk(host);
}

export function parseTargetPort(input: unknown, required = true): ParseResult<number | undefined> {
  if (input === undefined || input === null || input === "") {
    if (required) return parseFail("目标端口必填");
    return parseOk(undefined);
  }
  const port = typeof input === "string" ? Number(input) : input;
  if (!isValidTargetPort(port)) {
    return parseFail(`目标端口必须是 ${PORT_MIN}-${PORT_MAX} 的整数`);
  }
  return parseOk(port as number);
}

/** 权重：0 合法（目标在线但先不接流），其余 0-65535 整数。 */
export function parseWeight(input: unknown): ParseResult<number> {
  if (input === undefined || input === null || input === "") return parseOk(1);
  const weight = typeof input === "string" ? Number(input) : input;
  if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 0 || weight > 65535) {
    return parseFail("权重必须是 0-65535 的整数");
  }
  return parseOk(weight);
}

export function parseOrderBy(input: unknown): ParseResult<number> {
  if (input === undefined || input === null || input === "") return parseOk(1000);
  const orderBy = typeof input === "string" ? Number(input) : input;
  if (typeof orderBy !== "number" || !Number.isFinite(orderBy)) return parseFail("排序值必须是数字");
  return parseOk(orderBy);
}

export function parseRemark(input: unknown): ParseResult<string | null> {
  if (input === undefined || input === null || input === "") return parseOk(null);
  if (typeof input !== "string") return parseFail("备注必须是字符串");
  const remark = input.trim();
  if (remark.length > 255) return parseFail("备注长度不能超过 255");
  return parseOk(remark.length === 0 ? null : remark);
}

/** 角色是否具备出口能力（§2.2：只有 egress / both 节点上才有 EgressPool）。 */
export function hasEgressCapability(role: string | null | undefined): boolean {
  return role === "egress" || role === "both";
}

/**
 * 池是否还有「可用目标」：至少一个 `active` 且 `weight > 0`。
 *
 * §2.2 硬规则（原样）：池内至少保留一个 active 且 weight>0 的目标，否则拒绝
 * 应用新目标快照。DB 层不强约束，本函数就是它的应用层实现点。
 */
export function poolHasViableTarget(
  targets: { status: string; weight: number }[] | null | undefined,
): boolean {
  return (targets ?? []).some((t) => t.status === "active" && t.weight > 0);
}

/** 自报角色与节点角色是否不一致（Agent 侧大小写可能与枚举不同，故归一化比较）。 */
export function isRoleMismatch(
  reportedRole: string | null | undefined,
  nodeRole: string | null | undefined,
): boolean {
  if (!reportedRole || !nodeRole) return false;
  return reportedRole.trim().toLowerCase() !== nodeRole.trim().toLowerCase();
}

/** 快照年龄（秒）。负数（时钟偏差）按 0 处理，不让前端渲染 -3 秒。 */
export function stateAgeSeconds(reportedAt: Date, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - reportedAt.getTime()) / 1000));
}

/** 快照是否陈旧（超过 {@link NODE_STATE_STALE_SECONDS} 未上报）。 */
export function isStaleState(
  reportedAt: Date,
  now: Date,
  threshold = NODE_STATE_STALE_SECONDS,
): boolean {
  return stateAgeSeconds(reportedAt, now) > threshold;
}

/**
 * 节点凭据状态投影 —— **本模块唯一下发凭据相关信息的出口**。
 *
 * 刻意不含 `node_credential_hash`：管理端列表需要的是「签发了吗 / 撤销了吗 /
 * 上次什么时候动过」，哈希对管理员毫无用途却是拖库后的可用攻击面。
 * 明文只在 WP7 的 issue/rotate 响应里出现一次（routes/admin.ts）。
 */
export interface NodeCredentialState {
  node_id: number;
  node_key: string;
  role: NodeRoleValue | null;
  has_credential: boolean;
  revoked: boolean;
  state: "never" | "active" | "revoked";
  rotated_at: Date | null;
  last_rejected_at: Date | null;
}

export function credentialStateOf(node: {
  id: number;
  node_id: string;
  role: string | null;
  node_credential_hash: string | null;
  credential_revoked: boolean;
  credential_rotated_at: Date | null;
  credential_last_rejected_at: Date | null;
}): NodeCredentialState {
  const has = typeof node.node_credential_hash === "string" && node.node_credential_hash.length > 0;
  const parsed = parseNodeRole(node.role);
  return {
    node_id: node.id,
    node_key: node.node_id,
    role: parsed.ok ? parsed.value : null,
    has_credential: has,
    revoked: has && node.credential_revoked,
    state: !has ? "never" : node.credential_revoked ? "revoked" : "active",
    rotated_at: node.credential_rotated_at ?? null,
    last_rejected_at: node.credential_last_rejected_at ?? null,
  };
}

/** JSON 安全化（null/undefined → 缺省），用于快照字段的透传。 */
function jsonOr<T>(value: unknown, fallback: T): T {
  return value === null || value === undefined ? fallback : (value as T);
}

/* ================================================================== */
/* 节点解析                                                            */
/* ================================================================== */

/**
 * 面板侧定位节点：数字主键（`db.id`）或字符串 `node_id`。
 *
 * 与 routes/admin.ts 的 `resolveNodeIdParam` 同语义——WP7 的凭据端点已经
 * 接受两种形态，WP10 的新端点保持一致，避免前端为同一资源记两套 id 规则。
 */
export async function resolveNodeId(
  pd: NodeAdminDb,
  param: string,
): Promise<{ ok: true; id: number } | { ok: false; message: string }> {
  const num = Number(param);
  if (Number.isInteger(num) && num > 0) {
    const row = asRow<{ id: number }>(
      await pd.node.findUnique({ where: { id: num }, select: { id: true } }),
    );
    return row ? { ok: true, id: row.id } : { ok: false, message: "节点不存在" };
  }
  const trimmed = param.trim();
  if (trimmed.length === 0) return { ok: false, message: "节点不存在" };
  const row = asRow<{ id: number }>(
    await pd.node.findUnique({ where: { node_id: trimmed }, select: { id: true } }),
  );
  return row ? { ok: true, id: row.id } : { ok: false, message: "节点不存在" };
}

/* ================================================================== */
/* Node role 管理                                                      */
/* ================================================================== */

export interface UpdateNodeRoleInput {
  /** `null` / "" = 显式清空角色（回到「尚未声明」）。 */
  role?: unknown;
  portRangeMin?: unknown;
  portRangeMax?: unknown;
  lbStrategy?: unknown;
}

/**
 * 更新节点角色（+ 可选的端口区间 / 默认出口策略）。
 *
 * 三条守卫，按顺序：
 *   1. **丢掉出口能力前必须先把池清干净**：ingress 节点上的出口池不会跟着
 *      角色消失，留着 = 「以为在跑出口其实没有出口能力」；要删池请显式走
 *      {@link deleteEgressPool}（它自己会检查是否被隧道引用）。
 *   2. **获得出口能力时补 default 池**：schema 注释「每个出口节点自动拥有
 *      一个 default 池」在此落地，而不是留给将来 WP8 发现「没有池可挂隧道」。
 *      幂等（唯一冲突 = 别人已建好，视为成功）。
 *   3. 端口区间同 portPool 语义：未配置 = 没有 v3 端口域，不回落节点组
 *      `port_range`。
 */
export async function updateNodeRole(
  nodeId: number,
  input: UpdateNodeRoleInput,
  inject?: NodeAdminDeps,
): Promise<
  | { ok: true; node: NodeRow; default_pool_created: boolean }
  | NodeAdminError
> {
  const { db: pd } = deps(inject);

  const roleParsed = parseNodeRole(input.role);
  if (!roleParsed.ok) return err("invalid_input", roleParsed.message);
  const rangeParsed = parsePortRange(input.portRangeMin, input.portRangeMax);
  if (!rangeParsed.ok) return err("invalid_input", rangeParsed.message);
  const lbParsed = parseLbStrategy(input.lbStrategy);
  if (!lbParsed.ok) return err("invalid_input", lbParsed.message);

  const node = asRow<NodeRow>(await pd.node.findUnique({ where: { id: nodeId } }));
  if (!node) return err("not_found", "节点不存在");

  const nextRole = roleParsed.value;
  const gainingEgress = hasEgressCapability(nextRole) && !hasEgressCapability(node.role);
  const losingEgress = !hasEgressCapability(nextRole) && hasEgressCapability(node.role);

  // 守卫 1：降级角色前必须先清池。
  if (losingEgress) {
    const poolCount = (await pd.egressPool.count({ where: { node_id: nodeId } })) as number;
    if (poolCount > 0) {
      return err(
        "invalid_state",
        `该节点还有 ${poolCount} 个出口池，请先删除出口池再取消出口角色`,
      );
    }
  }

  const data: Record<string, unknown> = {};
  // 只在调用方显式给了对应键时动该字段：`undefined` = 本次不动，
  // `null` / "" = 显式清空。两者必须可区分，见 parseNodeRole 注释。
  if (input.role !== undefined) data.role = nextRole;
  if (input.portRangeMin !== undefined || input.portRangeMax !== undefined) {
    data.port_range_min = rangeParsed.value?.min ?? null;
    data.port_range_max = rangeParsed.value?.max ?? null;
  }
  if (input.lbStrategy !== undefined) data.lb_strategy = lbParsed.value;

  let updated: NodeRow;
  try {
    updated =
      Object.keys(data).length > 0
        ? (asRow<NodeRow>(await pd.node.update({ where: { id: nodeId }, data })) ?? node)
        : node;
  } catch (e) {
    return toAdminError(e, "节点更新失败");
  }

  // 守卫 2：刚获得出口能力 → 补 default 池（幂等）。
  let defaultPoolCreated = false;
  if (gainingEgress) {
    const existing = asRow<{ id: number }>(
      await pd.egressPool.findFirst({
        where: { node_id: nodeId, name: DEFAULT_POOL_NAME },
        select: { id: true, targets: false },
      }),
    );
    if (!existing) {
      try {
        await pd.egressPool.create({
          data: {
            node_id: nodeId,
            name: DEFAULT_POOL_NAME,
            lb_strategy: updated.lb_strategy ?? "round",
          },
        });
        defaultPoolCreated = true;
      } catch (e) {
        if ((e as { code?: string })?.code !== "P2002") {
          return toAdminError(e, "创建默认出口池失败");
        }
      }
    }
  }

  return { ok: true, node: updated, default_pool_created: defaultPoolCreated };
}

/* ================================================================== */
/* 节点详情                                                            */
/* ================================================================== */

export interface NodeDetailResult {
  node: Omit<NodeRow, "node_credential_hash">;
  role: NodeRoleValue | null;
  credential: NodeCredentialState;
  pools: EgressPoolRow[];
  pool_count: number;
  tunnel_count: number;
}

/**
 * 节点详情：节点行（**脱去凭据哈希**）+ 凭据状态 + 出口池（含目标）+ 隧道引用数。
 *
 * 与列表的差别只在这里才 include `targets`：节点级详情是一次点开一行的诊断页，
 * 需要目标清单；列表要的是「这个节点能当出口吗、有没有池」。
 */
export async function getNodeDetail(
  nodeId: number,
  inject?: NodeAdminDeps,
): Promise<{ ok: true; detail: NodeDetailResult } | NodeAdminError> {
  const { db: pd } = deps(inject);
  const node = asRow<NodeRow>(
    await pd.node.findUnique({
      where: { id: nodeId },
      include: { node_group: { select: { id: true, name: true, node_type: true } } },
    }),
  );
  if (!node) return err("not_found", "节点不存在");

  const pools = asRows<EgressPoolRow>(
    await pd.egressPool.findMany({
      where: { node_id: nodeId },
      orderBy: [{ id: "asc" }],
      include: { targets: { orderBy: [{ order_by: "asc" }, { id: "asc" }] } },
    }),
  );
  const tunnelCount = (await pd.tunnel.count({ where: { egress_node_id: nodeId } })) as number;
  const roleParsed = parseNodeRole(node.role);
  const { node_credential_hash: _hash, ...nodeWithoutHash } = node;

  return {
    ok: true,
    detail: {
      node: nodeWithoutHash,
      role: roleParsed.ok ? roleParsed.value : null,
      credential: credentialStateOf(node),
      pools,
      pool_count: pools.length,
      tunnel_count: tunnelCount,
    },
  };
}

/* ================================================================== */
/* EgressPool CRUD                                                     */
/* ================================================================== */

export interface CreatePoolInput {
  name?: unknown;
  lbStrategy?: unknown;
  status?: unknown;
}

/**
 * 建池。
 *
 * 前置条件：节点角色必须有出口能力（`egress` / `both`）。让「根本没有出口
 * 能力」的节点挂池，出来的池没人能挂隧道（WP8 会拒），只是把错误推向
 * 编排器——在这里就拦掉，错误信息才是「角色不对」而不是「配置失败」。
 */
export async function createEgressPool(
  nodeId: number,
  input: CreatePoolInput,
  inject?: NodeAdminDeps,
): Promise<{ ok: true; pool: EgressPoolRow } | NodeAdminError> {
  const { db: pd } = deps(inject);

  const nameParsed = parsePoolName(input.name);
  if (!nameParsed.ok) return err("invalid_input", nameParsed.message);
  const lbParsed = parseLbStrategy(input.lbStrategy);
  if (!lbParsed.ok) return err("invalid_input", lbParsed.message);
  const statusParsed = parseEgressStatus(input.status ?? "active");
  if (!statusParsed.ok) return err("invalid_input", statusParsed.message);

  const node = asRow<{ id: number; role: string | null; lb_strategy: string | null }>(
    await pd.node.findUnique({
      where: { id: nodeId },
      select: { id: true, role: true, lb_strategy: true },
    }),
  );
  if (!node) return err("not_found", "节点不存在");
  if (!hasEgressCapability(node.role)) {
    return err("invalid_state", "该节点没有出口能力（role 需为 egress 或 both）");
  }
  if (nameParsed.value === DEFAULT_POOL_NAME) {
    return err("conflict", `池名 ${DEFAULT_POOL_NAME} 保留给自动创建的默认池`);
  }

  try {
    const pool = asRow<EgressPoolRow>(
      await pd.egressPool.create({
        data: {
          node_id: nodeId,
          name: nameParsed.value,
          lb_strategy: lbParsed.value ?? node.lb_strategy ?? "round",
          status: statusParsed.value,
        },
      }),
    )!;
    return { ok: true, pool };
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      return err("conflict", "同名出口池已存在");
    }
    return toAdminError(e, "创建出口池失败");
  }
}

export interface UpdatePoolInput {
  name?: unknown;
  lbStrategy?: unknown;
  status?: unknown;
}

/** 改池（名称 / 策略 / 启停）。移除目标走 {@link upsertTargets}。 */
export async function updateEgressPool(
  poolId: number,
  input: UpdatePoolInput,
  inject?: NodeAdminDeps,
): Promise<{ ok: true; pool: EgressPoolRow } | NodeAdminError> {
  const { db: pd } = deps(inject);

  const pool = asRow<EgressPoolRow>(await pd.egressPool.findUnique({ where: { id: poolId } }));
  if (!pool) return err("not_found", "出口池不存在");

  const data: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const nameParsed = parsePoolName(input.name);
    if (!nameParsed.ok) return err("invalid_input", nameParsed.message);
    if (nameParsed.value === DEFAULT_POOL_NAME && pool.name !== DEFAULT_POOL_NAME) {
      return err("conflict", `池名 ${DEFAULT_POOL_NAME} 保留给自动创建的默认池`);
    }
    data.name = nameParsed.value;
  }
  if (input.lbStrategy !== undefined) {
    const lbParsed = parseLbStrategy(input.lbStrategy);
    if (!lbParsed.ok) return err("invalid_input", lbParsed.message);
    data.lb_strategy = lbParsed.value;
  }
  if (input.status !== undefined) {
    const statusParsed = parseEgressStatus(input.status);
    if (!statusParsed.ok) return err("invalid_input", statusParsed.message);
    // 停用整池会指向它的 RELAY 隧道进入可解释的 error/suspended
    // （schema 注释），但「active 池不能一个可用目标都没有」仍然成立——
    // 否则下发的是空目标快照。
    if (statusParsed.value === "active") {
      const targets = asRows<{ status: string; weight: number }>(
        await pd.egressTarget.findMany({
          where: { pool_id: poolId },
          select: { status: true, weight: true },
        }),
      );
      if (!poolHasViableTarget(targets)) {
        return err("invalid_state", "启用池前必须先至少有一个 active 且 weight>0 的目标");
      }
    }
    data.status = statusParsed.value;
  }

  if (Object.keys(data).length === 0) return { ok: true, pool };

  try {
    const updated = asRow<EgressPoolRow>(
      await pd.egressPool.update({ where: { id: poolId }, data }),
    )!;
    return { ok: true, pool: updated };
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return err("conflict", "同名出口池已存在");
    return toAdminError(e, "更新出口池失败");
  }
}

/**
 * 删池。
 *
 * 守卫：有 RELAY 隧道在引用它 → 409，让调用方先把隧道改到别的池
 * （§2.2「改目标池 = PATCH /node/targets 热更新」）。这里**不**做级联删除
 * 隧道——那正是 schema 用 `ON DELETE SET NULL` 而不是 Cascade 的原因：
 * 删节点/删池都不许静默抹掉用户的隧道。
 */
export async function deleteEgressPool(
  poolId: number,
  inject?: NodeAdminDeps,
): Promise<{ ok: true; deleted: boolean } | NodeAdminError> {
  const { db: pd } = deps(inject);

  const pool = asRow<EgressPoolRow>(await pd.egressPool.findUnique({ where: { id: poolId } }));
  if (!pool) return err("not_found", "出口池不存在");

  const referencing = (await pd.tunnel.count({ where: { egress_pool_id: poolId } })) as number;
  if (referencing > 0) {
    return err(
      "conflict",
      `还有 ${referencing} 条 RELAY 隧道引用该池，请先把它们改到其他池`,
    );
  }

  try {
    await pd.egressPool.delete({ where: { id: poolId } });
    return { ok: true, deleted: true };
  } catch (e) {
    if ((e as { code?: string })?.code === "P2025") return err("not_found", "出口池不存在");
    return toAdminError(e, "删除出口池失败");
  }
}

/** 列池（默认按节点过滤，`nodeId` 为 null = 全量，供管理端全局视图）。 */
export async function listEgressPools(
  options: { nodeId?: number | null; includeTargets?: boolean } = {},
  inject?: NodeAdminDeps,
): Promise<{ ok: true; pools: EgressPoolRow[]; total: number } | NodeAdminError> {
  const { db: pd } = deps(inject);
  const where = options.nodeId ? { node_id: options.nodeId } : {};
  const pools = asRows<EgressPoolRow>(
    await pd.egressPool.findMany({
      where,
      orderBy: [{ node_id: "asc" }, { id: "asc" }],
      ...(options.includeTargets
        ? { include: { targets: { orderBy: [{ order_by: "asc" }, { id: "asc" }] } } }
        : {}),
    }),
  );
  return { ok: true, pools, total: pools.length };
}

/* ================================================================== */
/* EgressTarget CRUD                                                   */
/* ================================================================== */

export interface TargetInput {
  host?: unknown;
  port?: unknown;
  weight?: unknown;
  orderBy?: unknown;
  remark?: unknown;
  status?: unknown;
}

/**
 * 单条目标解析（create / update 共用，规则必须一致）。
 *
 * `partial` 为 true 时 host/port 变成可选（只校验「给了的」）——PATCH 只改
 * 权重或备注是常见操作，要求连地址一起重传既啰嗦又会把「没改的字段」在
 * 校验层变成必填。create 走 `partial: false`，两者共享同一套格式规则，
 * 只是「缺失」的含义不同。
 */
export function parseTargetInput(
  input: TargetInput,
  options: { partial?: boolean } = {},
): ParseResult<{
  host: string | undefined;
  port: number | undefined;
  weight: number | undefined;
  order_by: number | undefined;
  remark: string | null | undefined;
  status: EgressStatusValue | undefined;
}> {
  const partial = options.partial === true;
  const host = partial ? parseOptionalHost(input.host) : parseRequiredHost(input.host);
  if (!host.ok) return parseFail(host.message);
  const port = partial ? parseTargetPort(input.port, false) : parseTargetPort(input.port, true);
  if (!port.ok) return parseFail(port.message);
  const weight = parseWeight(input.weight);
  if (!weight.ok) return parseFail(weight.message);
  const orderBy = parseOrderBy(input.orderBy);
  if (!orderBy.ok) return parseFail(orderBy.message);
  const remark = parseRemark(input.remark);
  if (!remark.ok) return parseFail(remark.message);
  const status =
    input.status === undefined
      ? parseOk<EgressStatusValue | undefined>(undefined)
      : parseEgressStatus(input.status);
  if (!status.ok) return parseFail(status.message);
  return parseOk({
    host: host.value,
    port: port.value,
    weight: weight.value,
    order_by: orderBy.value,
    remark: remark.value,
    status: status.value,
  });
}

/**
 * 加目标。
 *
 * **建完就检查不变式**：这是 §2.2「至少一个 active 且 weight>0」的另一半——
 * 只在池级校验不够，目标级增删同样能让池失去可用目标。池原先是不可用的
 * （空池或全停用）时首次加入 active+weight>0 的目标，正好把它救活。
 */
export async function createTarget(
  poolId: number,
  input: TargetInput,
  inject?: NodeAdminDeps,
): Promise<{ ok: true; target: EgressTargetRow } | NodeAdminError> {
  const { db: pd } = deps(inject);

  const parsed = parseTargetInput(input);
  if (!parsed.ok) return err("invalid_input", parsed.message);

  const pool = asRow<EgressPoolRow>(
    await pd.egressPool.findUnique({
      where: { id: poolId },
      include: { targets: { select: { status: true, weight: true } } },
    }),
  );
  if (!pool) return err("not_found", "出口池不存在");
  const v = parsed.value;
  if (pool.status !== "active" && (v.status ?? "active") === "active") {
    return err("invalid_state", "出口池已停用，不能添加 active 目标");
  }

  try {
    const target = asRow<EgressTargetRow>(
      await pd.egressTarget.create({
        data: {
          pool_id: poolId,
          host: v.host,
          port: v.port as number,
          weight: v.weight ?? 1,
          order_by: v.order_by ?? 1000,
          remark: v.remark ?? null,
          status: v.status ?? "active",
        },
      }),
    )!;
    return { ok: true, target };
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      return err("conflict", "同一池内已存在相同地址与端口的目标");
    }
    return toAdminError(e, "创建出口目标失败");
  }
}

export async function updateTarget(
  targetId: number,
  input: TargetInput,
  inject?: NodeAdminDeps,
): Promise<{ ok: true; target: EgressTargetRow } | NodeAdminError> {
  const { db: pd } = deps(inject);

  const parsed = parseTargetInput(input, { partial: true });
  if (!parsed.ok) return err("invalid_input", parsed.message);

  const existing = asRow<EgressTargetRow>(
    await pd.egressTarget.findUnique({ where: { id: targetId } }),
  );
  if (!existing) return err("not_found", "出口目标不存在");

  const v = parsed.value;
  const data: Record<string, unknown> = {};
  if (v.host !== undefined) data.host = v.host;
  if (v.port !== undefined) data.port = v.port;
  if (v.weight !== undefined) data.weight = v.weight;
  if (v.order_by !== undefined) data.order_by = v.order_by;
  if (v.remark !== undefined) data.remark = v.remark;
  if (v.status !== undefined) {
    // 停用单个目标是允许的（池内还有别的），但把 active 池的最后一个可用目标
    // 也停用会让下发变成空快照——这与池级校验同一条不变式。
    const siblings = asRows<{ id: number; status: string; weight: number }>(
      await pd.egressTarget.findMany({
        where: { pool_id: existing.pool_id },
        select: { id: true, status: true, weight: true },
      }),
    );
    const simulated = siblings.map((t) =>
      t.id === targetId ? { ...t, status: v.status!, weight: v.weight ?? t.weight } : t,
    );
    if (!poolHasViableTarget(simulated)) {
      return err("invalid_state", "至少需要保留一个 active 且 weight>0 的目标");
    }
    data.status = v.status;
  }

  // `weight` 单独出现时（status 沿用）也必须过同一道不变式：把最后一个可用
  // 目标的权重改成 0 等同于把它停用——下发会拿到一个空快照。
  if (v.weight !== undefined) {
    const siblings = asRows<{ id: number; status: string; weight: number }>(
      await pd.egressTarget.findMany({
        where: { pool_id: existing.pool_id },
        select: { id: true, status: true, weight: true },
      }),
    );
    const simulated = siblings.map((t) =>
      t.id === targetId
        ? { ...t, status: v.status ?? t.status, weight: v.weight! }
        : t,
    );
    if (!poolHasViableTarget(simulated)) {
      return err("invalid_state", "至少需要保留一个 active 且 weight>0 的目标");
    }
  }

  if (Object.keys(data).length === 0) return { ok: true, target: existing };

  try {
    const updated = asRow<EgressTargetRow>(
      await pd.egressTarget.update({ where: { id: targetId }, data }),
    )!;
    return { ok: true, target: updated };
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      return err("conflict", "同一池内已存在相同地址与端口的目标");
    }
    return toAdminError(e, "更新出口目标失败");
  }
}

/**
 * 删目标。
 *
 * 守卫：删完会让池失去最后一个可用目标 → 409。要「暂时不用这个目标」请把
 * 它的 status 改成 inactive；要「清空整池」请直接删池（它会检查隧道引用）。
 * 这条与 {@link updateTarget} 的模拟判定同源，只是以删除为终态。
 */
export async function deleteTarget(
  targetId: number,
  inject?: NodeAdminDeps,
): Promise<{ ok: true; deleted: boolean } | NodeAdminError> {
  const { db: pd } = deps(inject);

  const existing = asRow<EgressTargetRow>(
    await pd.egressTarget.findUnique({ where: { id: targetId } }),
  );
  if (!existing) return err("not_found", "出口目标不存在");

  const siblings = asRows<{ status: string; weight: number }>(
    await pd.egressTarget.findMany({
      where: { pool_id: existing.pool_id, NOT: { id: targetId } },
      select: { status: true, weight: true },
    }),
  );
  if (!poolHasViableTarget(siblings)) {
    return err(
      "invalid_state",
      "删除后会没有任何可用目标（active 且 weight>0），请改为停用该目标或整池删除",
    );
  }

  try {
    await pd.egressTarget.delete({ where: { id: targetId } });
    return { ok: true, deleted: true };
  } catch (e) {
    if ((e as { code?: string })?.code === "P2025") return err("not_found", "出口目标不存在");
    return toAdminError(e, "删除出口目标失败");
  }
}

/** 列目标（默认按池过滤）。 */
export async function listTargets(
  options: { poolId?: number | null } = {},
  inject?: NodeAdminDeps,
): Promise<{ ok: true; targets: EgressTargetRow[]; total: number } | NodeAdminError> {
  const { db: pd } = deps(inject);
  const where = options.poolId ? { pool_id: options.poolId } : {};
  const targets = asRows<EgressTargetRow>(
    await pd.egressTarget.findMany({
      where,
      orderBy: [{ order_by: "asc" }, { id: "asc" }],
    }),
  );
  return { ok: true, targets, total: targets.length };
}

/**
 * 批量替换池内目标集（面板的「保存目标池」就是这个语义）。
 *
 * 为什么提供批量：逐条增删改的中间态会让「池里只剩一个停用目标」被提交成功，
 * 而用户在编辑表单里看到的从来不是那个中间态。整批提交 + 一次性终态校验
 * （{@link poolHasViableTarget}）才与管理员的心智一致。
 *
 * 保留 `id` 的行走 update，没有 `id` 的新增，载荷里没出现的旧行删除。
 */
export async function replaceTargets(
  poolId: number,
  inputs: unknown[],
  inject?: NodeAdminDeps,
): Promise<{ ok: true; targets: EgressTargetRow[] } | NodeAdminError> {
  const { db: pd } = deps(inject);

  const pool = asRow<EgressPoolRow>(await pd.egressPool.findUnique({ where: { id: poolId } }));
  if (!pool) return err("not_found", "出口池不存在");
  if (!Array.isArray(inputs)) return err("invalid_input", "目标列表必须是数组");

  type Desired = {
    id?: number;
    host: string;
    port: number;
    weight: number;
    order_by: number;
    remark: string | null;
    status: EgressStatusValue;
  };
  const desired: Desired[] = [];
  for (const raw of inputs) {
    if (!raw || typeof raw !== "object") return err("invalid_input", "目标条目必须是对象");
    const rec = raw as Record<string, unknown>;
    const id = rec.id === undefined || rec.id === null || rec.id === "" ? undefined : Number(rec.id);
    if (id !== undefined && (!Number.isInteger(id) || id <= 0)) {
      return err("invalid_input", "目标 id 不合法");
    }
    // 整批替换是**全量**语义：每条都必须自带地址与端口（没有「沿用旧值」）。
    const parsed = parseTargetInput({ ...rec, port: rec.port, weight: rec.weight });
    if (!parsed.ok) return err("invalid_input", parsed.message);
    if (parsed.value.host === undefined || parsed.value.port === undefined) {
      return err("invalid_input", "目标必须同时提供地址与端口");
    }
    desired.push({
      id,
      host: parsed.value.host,
      port: parsed.value.port as number,
      weight: parsed.value.weight ?? 1,
      order_by: parsed.value.order_by ?? 1000,
      remark: parsed.value.remark ?? null,
      status: parsed.value.status ?? "active",
    });
  }

  // 终态不变式：整批提交后池必须还有一个可用目标。
  if (!poolHasViableTarget(desired)) {
    return err("invalid_state", "目标集必须至少包含一个 active 且 weight>0 的目标");
  }
  // 池自身停用时整批 active 目标无意义。
  if (pool.status !== "active" && desired.some((d) => d.status === "active")) {
    return err("invalid_state", "出口池已停用，不能提交 active 目标");
  }

  const existing = asRows<EgressTargetRow>(
    await pd.egressTarget.findMany({ where: { pool_id: poolId }, orderBy: { id: "asc" } }),
  );
  const keepIds: number[] = [];
  const result: EgressTargetRow[] = [];
  try {
    for (const d of desired) {
      if (d.id === undefined) {
        const created = asRow<EgressTargetRow>(
          await pd.egressTarget.create({
            data: {
              pool_id: poolId,
              host: d.host,
              port: d.port,
              weight: d.weight,
              order_by: d.order_by,
              remark: d.remark,
              status: d.status,
            },
          }),
        )!;
        result.push(created);
        keepIds.push(created.id);
      } else {
        const updated = asRow<EgressTargetRow>(
          await pd.egressTarget.update({
            where: { id: d.id },
            data: {
              host: d.host,
              port: d.port,
              weight: d.weight,
              order_by: d.order_by,
              remark: d.remark,
              status: d.status,
            },
          }),
        );
        if (!updated) return err("not_found", `目标 ${d.id} 不存在或不属于该池`);
        result.push(updated);
        keepIds.push(updated.id);
      }
    }
    // 删除载荷里没出现的旧行。
    for (const row of existing) {
      if (!keepIds.includes(row.id)) {
        await pd.egressTarget.delete({ where: { id: row.id } }).catch(() => {
          /* 已被并发删除：目标即消失，视为成功 */
        });
      }
    }
    return { ok: true, targets: result };
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      return err("conflict", "同一池内已存在相同地址与端口的目标");
    }
    return toAdminError(e, "保存目标集失败");
  }
}

/**
 * 把 agent 上报来的 `host:port` 串解析成 `{ host, port }`。
 *
 * 幂等性取向：容错但不猜测——`[v6]:port` 形态按方括号切，其余按**最后一个**
 * 冒号切（IPv6 裸地址会被误判，但 agent 侧本来就要求 `host` 字段而不是组合
 * 串，本函数只服务于「历史载荷 / 面板回显」这类兼容路径）。
 */
export function parseHostPort(value: string): { host: string; port: number } | null {
  const text = value.trim();
  if (text.length === 0) return null;
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(text);
  if (bracketed) {
    const port = Number(bracketed[2]);
    if (!isValidTargetPort(port)) return null;
    return { host: bracketed[1], port };
  }
  const at = text.lastIndexOf(":");
  if (at <= 0 || at === text.length - 1) return null;
  const host = text.slice(0, at);
  const port = Number(text.slice(at + 1));
  if (!isValidTargetPort(port)) return null;
  return { host, port };
}

/* ================================================================== */
/* runtime / state query（读 node_state_report，WP7 落库的快照）          */
/* ================================================================== */

export interface NodeStateView {
  node_id: number;
  node_key: string;
  role: NodeRoleValue | null;
  reported_role: string | null;
  role_mismatch: boolean;
  online: boolean;
  status: string;
  last_seen_at: Date | null;
  reported_at: Date | null;
  age_seconds: number | null;
  stale: boolean;
  version: string | null;
  reported_revision: number | null;
  tunnels: unknown;
  used_ports: unknown;
  egress_pools: unknown;
  last_error: string | null;
}

/**
 * 单节点运行态视图。
 *
 * 三个「不一致」都在这里显式标注而不是抹平：
 *   · `role_mismatch`：Agent 自报角色 vs 面板角色。以 `node.role` 为准
 *     （§7.4「role 不回填、不猜」的延伸），不一致只提示不覆盖；
 *   · `stale` / `online`：快照陈旧（DB 侧单一真相）与 `node.status`
 *     （Redis 防抖翻转）是两套口径，前端两个都展示——管理员需要知道
 *     「offline-detector 说在线但五分钟没上报」这种自相矛盾的情况。
 */
export async function getNodeState(
  nodeId: number,
  inject?: NodeAdminDeps,
): Promise<{ ok: true; state: NodeStateView } | NodeAdminError> {
  const { db: pd, now } = deps(inject);

  const node = asRow<NodeRow>(
    await pd.node.findUnique({
      where: { id: nodeId },
      select: {
        id: true,
        node_id: true,
        role: true,
        status: true,
        last_seen_at: true,
      },
    }),
  );
  if (!node) return err("not_found", "节点不存在");

  const snapshot = asRow<StateReportRow>(
    await pd.nodeStateReport.findUnique({
      where: { node_id: nodeId },
      select: {
        node_id: true,
        version: true,
        role: true,
        reported_revision: true,
        tunnels: true,
        egress_pools: true,
        used_ports: true,
        last_error: true,
        reported_at: true,
      },
    }),
  );

  const roleParsed = parseNodeRole(node.role);
  const nowDate = now();
  const age = snapshot ? stateAgeSeconds(snapshot.reported_at, nowDate) : null;
  const stale = snapshot ? isStaleState(snapshot.reported_at, nowDate) : true;

  return {
    ok: true,
    state: {
      node_id: node.id,
      node_key: node.node_id,
      role: roleParsed.ok ? roleParsed.value : null,
      reported_role: snapshot?.role ?? null,
      role_mismatch: snapshot ? isRoleMismatch(snapshot.role, node.role) : false,
      online: node.status === "active",
      status: node.status,
      last_seen_at: node.last_seen_at ?? null,
      reported_at: snapshot?.reported_at ?? null,
      age_seconds: age,
      stale,
      version: snapshot?.version ?? null,
      reported_revision: snapshot?.reported_revision ?? null,
      tunnels: jsonOr(snapshot?.tunnels, []),
      used_ports: jsonOr(snapshot?.used_ports, []),
      egress_pools: jsonOr(snapshot?.egress_pools, {}),
      last_error: snapshot?.last_error ?? null,
    },
  };
}

export interface FleetStateOptions {
  /** 面板角色过滤：缺省 / 空串 = 不过滤，`all` 视为不过滤。 */
  role?: string | null;
  /** 在线过滤：`true` / `false` / `1` / `0` / `yes` / `no`；缺省或空串 = 不过滤。 */
  online?: string | null;
  /** 上报过期的过滤（同上）。 */
  stale?: string | null;
}

/**
 * 查询串里的三段布尔解析：`?online=true` / `?online=false` / `?online=` / 缺省。
 *
 * 空串与缺省都是「不过滤」（面板的下拉框没选时发 `?online=`），不是 false——
 * 把人家的下拉默认值当成「只看离线」会变成最常见的面板误报来源。
 */
function parseBoolQuery(input: unknown): boolean | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  return !falsy(input);
}

/** 面板的角色过滤下拉：「all」与空串都是「全部」，不是非法角色。 */
function normalizeRoleQuery(input: string | null | undefined): string | null | undefined {
  if (input === undefined || input === null) return input;
  const v = input.trim().toLowerCase();
  if (v === "" || v === "all") return null;
  return v;
}

/** 全量节点运行态（管理端巡检页）。`role` / `online` / `stale` 三段过滤。 */
export async function listNodeStates(
  options: FleetStateOptions = {},
  inject?: NodeAdminDeps,
): Promise<{ ok: true; states: NodeStateView[]; total: number } | NodeAdminError> {
  const { db: pd, now } = deps(inject);

  const roleParsed = parseNodeRole(normalizeRoleQuery(options.role));
  if (!roleParsed.ok) return err("invalid_input", roleParsed.message);
  const onlineFilter = parseBoolQuery(options.online);
  const staleFilter = parseBoolQuery(options.stale);

  const where: Record<string, unknown> = {};
  if (roleParsed.value !== null) where.role = roleParsed.value;
  if (onlineFilter === true) where.status = "active";
  if (onlineFilter === false) where.status = { not: "active" };

  const nodes = asRows<NodeRow>(
    await pd.node.findMany({
      where,
      orderBy: [{ order_by: "asc" }, { id: "asc" }],
      select: {
        id: true,
        node_id: true,
        role: true,
        status: true,
        last_seen_at: true,
      },
    }),
  );

  const nowDate = now();
  const states: NodeStateView[] = [];
  for (const node of nodes) {
    const snapshot = asRow<StateReportRow>(
      await pd.nodeStateReport.findUnique({
        where: { node_id: node.id },
        select: {
          node_id: true,
          version: true,
          role: true,
          reported_revision: true,
          tunnels: true,
          egress_pools: true,
          used_ports: true,
          last_error: true,
          reported_at: true,
        },
      }),
    );
    const roleVal = parseNodeRole(node.role);
    const age = snapshot ? stateAgeSeconds(snapshot.reported_at, nowDate) : null;
    const stale = snapshot ? isStaleState(snapshot.reported_at, nowDate) : true;
    if (staleFilter !== undefined && stale !== staleFilter) continue;
    states.push({
      node_id: node.id,
      node_key: node.node_id,
      role: roleVal.ok ? roleVal.value : null,
      reported_role: snapshot?.role ?? null,
      role_mismatch: snapshot ? isRoleMismatch(snapshot.role, node.role) : false,
      online: node.status === "active",
      status: node.status,
      last_seen_at: node.last_seen_at ?? null,
      reported_at: snapshot?.reported_at ?? null,
      age_seconds: age,
      stale,
      version: snapshot?.version ?? null,
      reported_revision: snapshot?.reported_revision ?? null,
      tunnels: jsonOr(snapshot?.tunnels, []),
      used_ports: jsonOr(snapshot?.used_ports, []),
      egress_pools: jsonOr(snapshot?.egress_pools, {}),
      last_error: snapshot?.last_error ?? null,
    });
  }
  return { ok: true, states, total: states.length };
}

/**
 * credential 列表（状态查询，**绝不下发明文或哈希**）。
 *
 * 逐个节点 include `state_report` 会让查询变成 N+1，这里一次性按节点
 * **分桶**拉取：快照按 `node_id` 唯一，Map 查找是 O(1)。
 */
export async function listNodeStatesWithCredentials(
  options: FleetStateOptions = {},
  inject?: NodeAdminDeps,
): Promise<
  | { ok: true; items: Array<NodeStateView & { credential: NodeCredentialState }>; total: number }
  | NodeAdminError
> {
  const { db: pd, now } = deps(inject);

  const roleParsed = parseNodeRole(normalizeRoleQuery(options.role));
  if (!roleParsed.ok) return err("invalid_input", roleParsed.message);
  const onlineFilter = parseBoolQuery(options.online);
  const staleFilter = parseBoolQuery(options.stale);

  const where: Record<string, unknown> = {};
  if (roleParsed.value !== null) where.role = roleParsed.value;
  if (onlineFilter === true) where.status = "active";
  if (onlineFilter === false) where.status = { not: "active" };

  const nodes = asRows<NodeRow>(
    await pd.node.findMany({
      where,
      orderBy: [{ order_by: "asc" }, { id: "asc" }],
      select: {
        id: true,
        node_id: true,
        role: true,
        status: true,
        last_seen_at: true,
        node_credential_hash: true,
        credential_revoked: true,
        credential_rotated_at: true,
        credential_last_rejected_at: true,
      },
    }),
  );

  // 快照一次拉全再按 node_id 分桶（没有 include 的 N+1）。
  const reports = asRows<StateReportRow>(
    await pd.nodeStateReport.findMany({
      select: {
        node_id: true,
        version: true,
        role: true,
        reported_revision: true,
        tunnels: true,
        egress_pools: true,
        used_ports: true,
        last_error: true,
        reported_at: true,
      },
    }),
  );
  const byNode = new Map(reports.map((r) => [r.node_id, r]));

  const nowDate = now();
  const items: Array<NodeStateView & { credential: NodeCredentialState }> = [];
  for (const node of nodes) {
    const snapshot = byNode.get(node.id) ?? null;
    const roleVal = parseNodeRole(node.role);
    const age = snapshot ? stateAgeSeconds(snapshot.reported_at, nowDate) : null;
    const stale = snapshot ? isStaleState(snapshot.reported_at, nowDate) : true;
    if (staleFilter !== undefined && stale !== staleFilter) continue;
    items.push({
      node_id: node.id,
      node_key: node.node_id,
      role: roleVal.ok ? roleVal.value : null,
      reported_role: snapshot?.role ?? null,
      role_mismatch: snapshot ? isRoleMismatch(snapshot.role, node.role) : false,
      online: node.status === "active",
      status: node.status,
      last_seen_at: node.last_seen_at ?? null,
      reported_at: snapshot?.reported_at ?? null,
      age_seconds: age,
      stale,
      version: snapshot?.version ?? null,
      reported_revision: snapshot?.reported_revision ?? null,
      tunnels: jsonOr(snapshot?.tunnels, []),
      used_ports: jsonOr(snapshot?.used_ports, []),
      egress_pools: jsonOr(snapshot?.egress_pools, {}),
      last_error: snapshot?.last_error ?? null,
      // 状态投影：只有布尔/时间戳，没有哈希也没有明文。
      credential: credentialStateOf(node),
    });
  }
  return { ok: true, items, total: items.length };
}

/**
 * 单节点凭据状态（`GET /api/admin/node/:id/credential`）。
 *
 * 「list/get」在 WP7 只交付了 issue/rotate/revoke，这里补的是**读**——
 * 面板需要回答「这个节点签过吗 / 撤销了吗 / 上次什么时候动过 / 谁还在拿旧
 * 钥匙敲门」。明文与哈希都不出现在响应里（见 {@link credentialStateOf}）。
 */
export async function getNodeCredential(
  nodeId: number,
  inject?: NodeAdminDeps,
): Promise<{ ok: true; credential: NodeCredentialState } | NodeAdminError> {
  const { db: pd } = deps(inject);
  const node = asRow<{
    id: number;
    node_id: string;
    role: string | null;
    node_credential_hash: string | null;
    credential_revoked: boolean;
    credential_rotated_at: Date | null;
    credential_last_rejected_at: Date | null;
  }>(
    await pd.node.findUnique({
      where: { id: nodeId },
      select: {
        id: true,
        node_id: true,
        role: true,
        node_credential_hash: true,
        credential_revoked: true,
        credential_rotated_at: true,
        credential_last_rejected_at: true,
      },
    }),
  );
  if (!node) return err("not_found", "节点不存在");
  return { ok: true, credential: credentialStateOf(node) };
}
