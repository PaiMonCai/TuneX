/**
 * Node admin shared contract, DB seam and pure validation helpers.
 *
 * Role/pool/target/state workflows stay in node-admin.ts; this module keeps
 * their shared input and dependency rules out of the orchestration file.
 */
/**
 * Admin Node / Egress API 服务层
 *
 * 本服务层的范围：
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
import type { LifecycleConditionCode, NodeImpact } from "./node-lifecycle.ts";
import { capabilityFactsFromStoredV2, type CapabilityManifestRow } from "./capability-manifest.ts";
import { admitSelectorFromStore, type SelectorAdmissionReason } from "./selector-admission.ts";

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
export const LB_STRATEGIES = ["round", "rand", "weighted_round", "fallback", "ip_hash"] as const;
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
  /**
   * 运行条件拒绝码（§13.5「必须使用可区分的错误码，Web 才能给用户正确下一步」）。
   *
   * 只有「依赖未清 / 收缩被阻止」这类条件拒绝才带：取值与
   * `GET /api/admin/node/:id/impact` 预检的 `role_check.condition` **同源**
   * （同一个 {@link checkRoleChange} 返回的 condition 原样透传）。
   */
  condition?: LifecycleConditionCode | SelectorAdmissionReason;
  error_layer?: "runtime_admission";
  /** 被拒时的依赖清单（与 impact 预检同一形状），Web 可直接渲染「要清什么」。 */
  dependencies?: NodeImpact;
}

export function err(code: NodeAdminErrorCode, message: string): NodeAdminError {
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
  /** V4-WP11B：Agent 上报的控制协议版本（null = 未上报）。 */
  control_protocol_version?: number | null;
  /** V4-WP11B：Agent 上报的能力清单（null = 未上报；数组 = 已上报）。 */
  capabilities?: unknown;
  capability_manifest?: unknown;
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
  /** impact 统计需要（与 node-lifecycle 的 `getNodeImpact` 同一组计数）。 */
  nodeBinding: {
    count(args: unknown): Promise<unknown>;
  };
  nodePortLease: {
    count(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
  };
  /** Federation impact is part of the same role-change admission check. */
  federationLease: {
    count(args: unknown): Promise<unknown>;
  };
  /**
   * 事务接缝（prisma 的 `$transaction` 满足之）。
   *
   * 省略 = 内存替身：守卫与写入仍按同一顺序执行，只是拿不到行锁
   * （离线单测用；见 `inNodeRoleTx`）。
   */
  $transaction?<T>(fn: (tx: NodeAdminDb) => Promise<T>): Promise<T>;
  /** 行锁接缝（prisma 的 `$queryRaw` 满足之）：`SELECT ... FOR UPDATE`。 */
  $queryRaw?(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

export interface NodeAdminDeps {
  db?: NodeAdminDb;
  /** 覆盖「陈旧」判定用的当前时间（测试注入）。 */
  now?: () => Date;
}

/** Egress policies have no original client-IP source, including inherited defaults. */
export async function guardEgressSelector(
  pd: NodeAdminDb,
  nodeId: number,
  strategy: unknown,
): Promise<NodeAdminError | null> {
  const decision = await admitSelectorFromStore(nodeId, { strategy, mode: "EGRESS" }, async (id) => {
    const row = asRow<CapabilityManifestRow & { node?: { credential_rotated_at?: Date | null } | null }>(
      await pd.nodeStateReport.findUnique({
        where: { node_id: id },
        select: {
          control_protocol_version: true, capabilities: true, capability_manifest: true, reported_at: true,
          node: { select: { credential_rotated_at: true } },
        },
      }),
    );
    return row ? capabilityFactsFromStoredV2({ ...row, credential_rotated_at: row.node?.credential_rotated_at }) : null;
  });
  return decision.ok ? null : {
    ok: false, code: "invalid_state", message: decision.detail,
    condition: decision.reason, error_layer: decision.error_layer,
  };
}

/**
 * 解析本模块的依赖（惰性 `db`）。
 *
 * 不能用模块级 `const defaultDb = db`：`db.ts` 在加载期就 new PrismaClient()
 * （读 DATABASE_URL），顶层绑定会把**真实** client 冻在模块作用域里——测试
 * 若在其后注册 `mock.module("../db.ts")` 替身就永远打不进去（路由路径没有
 * inject 参数，只能走 default），用例会以 `db_unavailable` 收尾。
 * `services/node-lifecycle.ts` 的 `loadDefaultDb()` 记录了同一个坑。
 */
export async function deps(over: NodeAdminDeps | undefined): Promise<{ db: NodeAdminDb; now: () => Date }> {
  const now = over?.now ?? (() => new Date());
  if (over?.db) return { db: over.db, now };
  return { db: (await loadDefaultDb()), now };
}

/**
 * 惰性解析的进程级 `db` 单例：首次调用时才 import，替身因此能先注册。
 * 缓存的是 Promise（并发首调用只 import 一次）。
 */
let defaultDbPromise: Promise<NodeAdminDb> | undefined;

function loadDefaultDb(): Promise<NodeAdminDb> {
  defaultDbPromise ??= import("../db.ts").then((m) => m.db as unknown as NodeAdminDb);
  return defaultDbPromise;
}

/** 把一行 unknown 收窄成行类型（DB 返回值只有调用方知道形状）。 */
export function asRow<T>(row: unknown): T | null {
  return row ? (row as T) : null;
}

/** 把一组 unknown 收窄成行数组。 */
export function asRows<T>(rows: unknown): T[] {
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** 空串当零的显式布尔判定（表单未勾选 / 老客户端都发 false）。 */
export function falsy(input: unknown): boolean {
  return input === false || input === "" || input === "false" || input === null;
}

/* ================================================================== */
/* 纯校验（无 IO，可离线单测）                                          */
/* ================================================================== */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

export function parseOk<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function parseFail<T>(message: string): ParseResult<T> {
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
  if (typeof input !== "string") return parseFail("负载均衡策略必须是 round / rand / weighted_round / fallback / ip_hash");
  const v = input.trim().toLowerCase();
  if (v === "") return parseOk(null);
  if ((LB_STRATEGIES as readonly string[]).includes(v)) return parseOk(v as LbStrategyValue);
  return parseFail("负载均衡策略必须是 round / rand / weighted_round / fallback / ip_hash");
}

export function parseEgressStatus(input: unknown): ParseResult<EgressStatusValue> {
  if (typeof input !== "string") return parseFail("状态必须是 active / inactive");
  const v = input.trim().toLowerCase();
  if ((EGRESS_STATUSES as readonly string[]).includes(v)) return parseOk(v as EgressStatusValue);
  return parseFail("状态必须是 active / inactive");
}

/** 必填 host 的包装（create 路径）。 */
export function parseRequiredHost(input: unknown): ParseResult<string> {
  if (input === undefined || input === null || input === "") return parseFail("目标地址必填");
  return parseTargetHost(input);
}

/** 可选 host（PATCH 路径）：给了就按同一套规则校验，没给就放行。 */
export function parseOptionalHost(input: unknown): ParseResult<string | undefined> {
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
export function jsonOr<T>(value: unknown, fallback: T): T {
  return value === null || value === undefined ? fallback : (value as T);
}

