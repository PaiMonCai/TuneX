/**
 * WP11 — Tunnel RELAY API 服务层（`DEVELOPMENT.md` §7.13）。
 *
 * ── 本层的职责边界（§7.13「所有运行操作统一走 orchestrator」）──
 *
 * 这里做**期望状态**的读写：CRUD 只改 `tunnel` 行里的 desired state
 * （`tunnel_mode` / `desired_status` / `egress_pool_id` / `egress_node_id` …），
 * 状态查询读回放（`apply_status` + revision + error）。
 *
 * **所有会让 Agent 动起来的操作都必须经过 WP8 编排器**——
 * `applyRelayTunnel` 收下 tunnelId 后调 `createRelayTunnel`（创建）或
 * `dispatchEgress`/`dispatchIngress`（重下发），绝不在这里手写任何
 * dispatch / transport / 命令信封。retry / suspend / resume / delete
 * 四个动作同一模式：先落 desired，再交给 orchestrator 收敛。
 *
 * 为什么不复造编排：§7.13 明令禁止「route 自己写第二套下发逻辑」。
 * 多一条下发路径意味着多一处 revision 账本、多一处补偿顺序可以写错——
 * 铁律一（先出口后入口）只在 `scheduler.ts` 里实现一次。
 *
 * ── 依赖注入 ──
 * 与 portPool / node-admin 同一取向：默认走进程级 `db` 单例，每个公开函数
 * 接受 {@link TunnelApiDeps} 覆盖。测试把内存替身传进去即可离线跑，
 * **不需要 `mock.module`**（它会随 worktree / CI 路径静默打歪）。
 * 编排器（`orchestrate`）与策略加载（`loadPolicy`）同样可注入，测试里
 * 换成假 Agent / 假策略即可验证「确实走的是 orchestrator」。
 */
import { db } from "../db.ts";
import {
  SCHEDULER_ERROR_CODES,
  createRelayTunnel,
  reapplyDirectTunnel,
  reapplyRelayTunnel,
  type ApplyDirectResult,
  type CreateRelayTunnelResult,
} from "./scheduler.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { getEffectivePolicy } from "./policy-service.ts";
import { checkTunnelCreation, type EffectivePolicy } from "./capability-policy.ts";

/* ================================================================== */
/* 常量                                                               */
/* ================================================================== */

/** 隧道模式（schema `enum TunnelMode` 的服务层镜像）。 */
export const TUNNEL_MODES = ["direct", "relay"] as const;
export type TunnelModeValue = (typeof TUNNEL_MODES)[number];

/** apply 状态机五态（§4.1，schema 是 VARCHAR(20) 而非枚举）。 */
export const APPLY_STATUSES = ["pending", "applying", "active", "error", "suspended"] as const;
export type ApplyStatusValue = (typeof APPLY_STATUSES)[number];

/** desired 状态（§4.1 只有两态）。 */
export const DESIRED_STATUSES = ["active", "inactive"] as const;
export type DesiredStatusValue = (typeof DESIRED_STATUSES)[number];

/**
 * WP11 允许的动作集合（穷尽列出；测试对数组内容做锚定断言）。
 *
 * 每个动作的语义差异在 {@link ACTION_意图}——特别是 `retry` 与 `resume`：
 * retry 从 error 态重新编排（revision 前进），resume 从 suspended 恢复
 * 期望状态（不动 version，让 Agent 的等版本逻辑自然 duplicate）。
 */
export const TUNNEL_ACTIONS = ["retry", "suspend", "resume", "delete"] as const;
export type TunnelAction = (typeof TUNNEL_ACTIONS)[number];

/* ================================================================== */
/* 错误模型                                                            */
/* ================================================================== */

export type TunnelApiErrorCode =
  /** 入参校验失败（400）。 */
  | "invalid_input"
  /** 隧道 / 节点组 / 池不存在（404）。 */
  | "not_found"
  /** 跨租户或无权限访问（403）。 */
  | "forbidden"
  /** 与当前状态冲突（409）：池被用 / 动作与状态不兼容 / 端口占用。 */
  | "conflict"
  /** 当前 apply 状态不允许这个动作（409）。 */
  | "invalid_state"
  /** 策略/额度拒绝（403）。 */
  | "policy_denied"
  /** 下发失败（502/503；Tunnel 记录已保留，错误已落库）。 */
  | "apply_failed"
  /** 数据库不可用（503；不 fail-open）。 */
  | "db_unavailable";

/** 错误码 → HTTP 状态码（路由层只查这张表，不自己判）。 */
export const TUNNEL_API_ERROR_STATUS: Record<TunnelApiErrorCode, 400 | 403 | 404 | 409 | 502 | 503> = {
  invalid_input: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  invalid_state: 409,
  policy_denied: 403,
  apply_failed: 502,
  db_unavailable: 503,
};

export interface TunnelApiError {
  ok: false;
  code: TunnelApiErrorCode;
  message: string;
  /** `apply_failed` 时带上编排器的结构化错误码（供前端展示与排障）。 */
  apply_error_code?: string;
}

function err(code: TunnelApiErrorCode, message: string, extra?: { apply_error_code?: string }): TunnelApiError {
  return { ok: false, code, message, ...extra };
}

/** Prisma 已知错误 → 本模块错误（P2002 唯一冲突 / P2025 行不存在）。 */
export function toTunnelApiError(e: unknown, fallback = "操作失败，请稍后重试"): TunnelApiError {
  const code = (e as { code?: string } | null)?.code;
  if (code === "P2002") return err("conflict", "已存在同端口的隧道（唯一键冲突）");
  if (code === "P2025") return err("not_found", "记录不存在");
  return err("db_unavailable", fallback);
}

/* ================================================================== */
/* 类型（DB 行投影）                                                    */
/* ================================================================== */

/** 本模块读写的最小 tunnel 行投影（对齐 schema 的 v3 增量列）。 */
export interface TunnelRow {
  id: number;
  name: string;
  tunnel_type: string;
  listen_ip: string | null;
  listen_port: number | null;
  status: string;
  in_node_group_id: number;
  out_node_group_id: number | null;
  user_id: number;
  workspace_id: number;
  tunnel_mode: string | null;
  ingress_node_id: number | null;
  egress_node_id: number | null;
  egress_pool_id: number | null;
  egress_port: number | null;
  remote_host: string | null;
  remote_port: number | null;
  desired_status: string | null;
  apply_status: string | null;
  config_revision: number | null;
  applied_revision: number | null;
  apply_error_code: string | null;
  apply_error: string | null;
  last_applied_at: Date | null;
  [k: string]: unknown;
}

/** 节点组行投影（授权判定只需要 id / node_type / workspace_id / is_shared）。 */
export interface NodeGroupRow {
  id: number;
  name?: string;
  node_type: string;
  workspace_id: number;
  is_shared?: boolean;
}

/** 出口池行投影（归属校验：池必须属于出口节点）。 */
export interface EgressPoolRow {
  id: number;
  node_id: number;
  name: string;
  status: string;
}

/** 节点行投影（delete 补偿撤两端时需要入口/出口两台节点）。 */
export interface TunnelApiNodeRow {
  id: number;
  node_id: string;
  connect_ip: string | null;
  role: string | null;
}

/** 本模块需要的 DB 投影（prisma `db` 满足之；测试用内存替身）。 */
export interface TunnelApiDb {
  tunnel: {
    findUnique(args: unknown): Promise<unknown>;
    findFirst(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    count(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    delete(args: unknown): Promise<unknown>;
  };
  node: {
    findUnique(args: unknown): Promise<unknown>;
  };
  nodeGroup: {
    findUnique(args: unknown): Promise<unknown>;
  };
  egressPool: {
    findUnique(args: unknown): Promise<unknown>;
    findFirst(args: unknown): Promise<unknown>;
  };
}

export interface TunnelApiDeps {
  db?: TunnelApiDb;
  /**
   * 创建编排入口（默认 {@link createRelayTunnel}，WP8）。
   * 测试注入假编排器即可验证「创建确实走 orchestrator」。
   */
  applyCreate?: (input: unknown, orchestrator: Orchestrator) => Promise<CreateRelayTunnelResult>;
  /**
   * 重入编排入口（默认 {@link reapplyRelayTunnel}，WP8）。
   * retry / resume 走这一条：对**已存在**的行重新下发，绝不新建行。
   */
  applyReapply?: (
    tunnelId: number,
    orchestrator: Orchestrator,
    deps?: unknown,
  ) => Promise<CreateRelayTunnelResult>;
  /** DIRECT 对既有 pending 行的 v3 编排。 */
  applyDirect?: (
    tunnelId: number,
    orchestrator: Orchestrator,
    deps?: unknown,
  ) => Promise<ApplyDirectResult>;
  /**
   * 进程级 orchestrator（WP8 的 Orchestrator 实例，revision 闸门跨请求共享）。
   * 未注入时隧道操作仍可读写 desired state，但 apply 停在 pending——
   * **不假装成功**（reconciler 的 fill_missing_runtime 稍后按同 revision 补发）。
   */
  orchestrator?: Orchestrator | null;
  /** 策略读取（默认 {@link getEffectivePolicy}，noCache）。 */
  loadPolicy?: (workspaceId: number) => Promise<EffectivePolicy>;
  /** 覆盖「现在」（测试注入固定时间）。 */
  now?: () => Date;
}

function resolveDeps(over: TunnelApiDeps | undefined): {
  db: TunnelApiDb;
  loadPolicy: (workspaceId: number) => Promise<EffectivePolicy>;
  applyCreate: (input: unknown, orchestrator: Orchestrator) => Promise<CreateRelayTunnelResult>;
  applyReapply: (tunnelId: number, orchestrator: Orchestrator, deps?: unknown) => Promise<CreateRelayTunnelResult>;
  applyDirect: (tunnelId: number, orchestrator: Orchestrator, deps?: unknown) => Promise<ApplyDirectResult>;
  now: () => Date;
} {
  return {
    db: over?.db ?? (db as unknown as TunnelApiDb),
    loadPolicy: over?.loadPolicy ?? ((workspaceId: number) => getEffectivePolicy(workspaceId, { noCache: true })),
    applyCreate:
      over?.applyCreate ?? (createRelayTunnel as unknown as (i: unknown, o: Orchestrator) => Promise<CreateRelayTunnelResult>),
    applyReapply:
      over?.applyReapply ?? (reapplyRelayTunnel as unknown as (t: number, o: Orchestrator, d?: unknown) => Promise<CreateRelayTunnelResult>),
    applyDirect:
      over?.applyDirect ?? (reapplyDirectTunnel as unknown as (t: number, o: Orchestrator, d?: unknown) => Promise<ApplyDirectResult>),
    now: over?.now ?? (() => new Date()),
  };
}

/** 把一行 unknown 收窄成行类型。 */
function asRow<T>(row: unknown): T | null {
  return row ? (row as T) : null;
}

/* ================================================================== */
/* 纯校验（无 IO，可离线单测）                                          */
/* ================================================================== */

/** 模式入参归一化：只接受 direct/relay（大小写不敏感），否则 null。 */
export function parseTunnelMode(value: unknown): TunnelModeValue | null {
  const s = String(value ?? "").trim().toLowerCase();
  return (TUNNEL_MODES as readonly string[]).includes(s) ? (s as TunnelModeValue) : null;
}

/** desired 入参归一化（active/inactive）。 */
export function parseDesiredStatus(value: unknown): DesiredStatusValue | null {
  const s = String(value ?? "").trim().toLowerCase();
  return (DESIRED_STATUSES as readonly string[]).includes(s) ? (s as DesiredStatusValue) : null;
}

/** apply 状态查询过滤入参（五态 + all）。 */
export function parseApplyStatusFilter(value: unknown): ApplyStatusValue | null {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "" || s === "all") return null;
  return (APPLY_STATUSES as readonly string[]).includes(s) ? (s as ApplyStatusValue) : null;
}

/** 端口入参（1..65535 整数）；空值 → null。 */
export function parsePort(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : NaN;
}

/** host:port 形态（与 routes/tunnels.ts 的 FORWARD_RE 同口径）。 */
const FORWARD_RE = /^(\[[0-9a-fA-F:]+\]|[^:\s]+):\d{1,5}$/;

/** DIRECT 目标必须是 host:port；RELAY 不接受 forward_addresses。 */
export function parseForwardAddress(value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (s === "") return null;
  return FORWARD_RE.test(s) ? s : null;
}

/**
 * RELAY 拓扑前置校验（无 IO）。
 *
 * RELAY 必须**两跳**：入口组 + 出口组都要有，且不能是同一组（§2.1：
 * 双跳退化成单跳就没有 RELAY 的意义）。显式 `egress_pool_id` 可选——
 * 不传则由编排器取出口节点的 `default` 池（§2.2）。
 */
export function validateRelayTopology(input: {
  inNodeGroupId: number;
  outNodeGroupId: number | null;
  egressPoolId?: number | null;
}): { ok: true } | { ok: false; message: string } {
  if (!Number.isInteger(input.inNodeGroupId) || input.inNodeGroupId <= 0) {
    return { ok: false, message: "必须指定入口节点组" };
  }
  if (input.outNodeGroupId === null) {
    return { ok: false, message: "RELAY 模式必须指定出口节点组（§2.1 双跳）" };
  }
  if (input.outNodeGroupId === input.inNodeGroupId) {
    return { ok: false, message: "入口与出口不能是同一节点组（RELAY 必须双跳）" };
  }
  if (
    input.egressPoolId !== undefined &&
    input.egressPoolId !== null &&
    (!Number.isInteger(input.egressPoolId) || input.egressPoolId <= 0)
  ) {
    return { ok: false, message: "出口池 ID 非法" };
  }
  return { ok: true };
}

/**
 * 动作与当前状态的兼容矩阵。
 *
 *  · `retry`   —— 只允许 `error`（§4.1「失败时保留 Tunnel，前端展示原因
 *    并允许 Retry」）。别的状态重试是空转，直接 409 让前端别亮这个按钮。
 *  · `resume`  —— 允许 `suspended` 与 `error`（暂停后恢复 / 失败后恢复）。
 *  · `suspend` —— 允许非 `suspended` 的任何态（幂等等同于「已在 suspended」）。
 *  · `delete`  —— 物理删除是用户显式动作，任何状态都允许（编排器负责撤两端）。
 */
export function canRunAction(
  action: TunnelAction,
  tunnel: { apply_status: string | null; desired_status?: string | null },
): { ok: true } | { ok: false; message: string } {
  const status = tunnel.apply_status ?? "pending";
  switch (action) {
    case "retry":
      if (status !== "error") {
        return { ok: false, message: `仅 error 状态的隧道可以重试（当前 ${status}）` };
      }
      return { ok: true };
    case "resume":
      if (status !== "suspended" && status !== "error") {
        return { ok: false, message: `仅 suspended / error 状态可以恢复（当前 ${status}）` };
      }
      return { ok: true };
    case "suspend":
      if (status === "suspended") {
        return { ok: false, message: "隧道已处于 suspended 状态" };
      }
      return { ok: true };
    case "delete":
      return { ok: true };
    default:
      return { ok: false, message: `未知动作 ${String(action)}` };
  }
}

/**
 * 动作 → 落库的 desired/apply 状态。
 *
 * retry/resume 都把 desired 推回 `active`（用户明确要求它跑）；
 * suspend 推到 `inactive` + `apply_status=suspended`。
 * delete 不落状态——它走物理删除路径（撤两端后删行）。
 */
export function desiredAfterAction(action: TunnelAction): {
  desired_status: DesiredStatusValue;
  apply_status?: ApplyStatusValue;
  clear_error: boolean;
} {
  switch (action) {
    case "retry":
      return { desired_status: "active", apply_status: "pending", clear_error: true };
    case "resume":
      return { desired_status: "active", apply_status: "pending", clear_error: true };
    case "suspend":
      return { desired_status: "inactive", apply_status: "suspended", clear_error: false };
    case "delete":
      return { desired_status: "inactive", clear_error: false };
  }
}

/** 对外隧道视图：把 nullable 的 v3 列归一成前端可直接渲染的形状。 */
export function tunnelView(t: TunnelRow) {
  return {
    ...t,
    online: t.apply_status === "active",
    // 老 DIRECT 行没有 v3 声明；把它们显示成 direct 而不是 null，
    // 让前端不必为「模式未声明」单独做一支 UI（存量库已回填 direct）。
    tunnel_mode: t.tunnel_mode ?? "direct",
    apply_status: t.apply_status ?? "pending",
    desired_status: t.desired_status ?? "inactive",
    config_revision: t.config_revision ?? 0,
    applied_revision: t.applied_revision ?? 0,
  };
}

/* ================================================================== */
/* 读：状态查询                                                        */
/* ================================================================== */

export interface TunnelStateResult {
  ok: true;
  tunnel: ReturnType<typeof tunnelView>;
}

/**
 * 单条隧道的运行状态（用于状态查询端点）。
 *
 * 返回的是**投影**而不是裸行：把 error 码/文案、revision 对齐关系
 * （`applied_revision < config_revision` = 待下发）一次性算好，前端
 * 不必自己比对 revision。归属校验在这里做（按 workspace），
 * 因此调用方传的 tunnelId 必须是本租户的。
 */
export async function getTunnelState(
  tunnelId: number,
  workspaceId: number,
  over?: TunnelApiDeps,
): Promise<TunnelStateResult | TunnelApiError> {
  const { db: pdb } = resolveDeps(over);
  const row = asRow<TunnelRow>(
    await pdb.tunnel.findFirst({ where: { id: tunnelId, workspace_id: workspaceId } }),
  );
  if (!row) return err("not_found", "隧道不存在");
  return { ok: true, tunnel: tunnelView(row) };
}

export interface ListTunnelsResult {
  ok: true;
  items: ReturnType<typeof tunnelView>[];
  total: number;
}

/** 列表（workspace 归属 + 可选 apply_status / mode 过滤 + 分页）。 */
export async function listTunnels(
  query: {
    workspaceId: number;
    applyStatus?: ApplyStatusValue | null;
    tunnelMode?: TunnelModeValue | null;
    keyword?: string;
    page?: number;
    pageSize?: number;
  },
  over?: TunnelApiDeps,
): Promise<ListTunnelsResult> {
  const { db: pdb } = resolveDeps(over);
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 20));
  const where: Record<string, unknown> = { workspace_id: query.workspaceId };
  if (query.applyStatus) where.apply_status = query.applyStatus;
  if (query.tunnelMode) where.tunnel_mode = query.tunnelMode;
  if (query.keyword) where.name = { contains: query.keyword };
  const rows = (await pdb.tunnel.findMany({
    where,
    orderBy: [{ id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  })) as TunnelRow[];
  const total = (await pdb.tunnel.count({ where })) as number;
  return { ok: true, items: rows.map(tunnelView), total };
}

/* ================================================================== */
/* 写：创建（走 orchestrator）                                          */
/* ================================================================== */

export interface CreateTunnelInput {
  name: string;
  mode: TunnelModeValue;
  userId: number;
  workspaceId: number;
  personalWorkspaceId: number;
  inNodeGroupId: number;
  /** RELAY 必填；DIRECT 可空。 */
  outNodeGroupId: number | null;
  /** RELAY 可选；不传取出口节点 default 池（编排器负责）。 */
  egressPoolId?: number | null;
  listenPort?: number | null;
  tunnelType?: string;
  /** DIRECT 模式目标。 */
  remoteHost?: string | null;
  remotePort?: number | null;
  forwardAddresses?: string[] | null;
}

/**
 * 创建隧道。
 *
 * RELAY：校验拓扑 → 落 desired → **交给 WP8 编排器**（`createRelayTunnel`），
 * 编排器的失败已经自己落好 `apply_status=error`（§7.11 四条要求），
 * 这里只把结果翻译成 HTTP 语义：失败 → 502/409 + 结构化错误码，
 * **绝不删行**（失败保留 Tunnel 是 §4.1 铁律）。
 *
 * DIRECT：走 legacy 等价路径（`forward_addresses` 双写 + socket 推送由
 * routes/tunnels.ts 的既有逻辑负责）——本服务只落 v3 列，行为与原版一致。
 */
export async function createTunnel(
  input: CreateTunnelInput,
  over?: TunnelApiDeps,
): Promise<
  | { ok: true; tunnelId: number; mode: TunnelModeValue; revision: number }
  | { ok: true; tunnelId: number; mode: "direct" }
  | TunnelApiError
> {
  const deps = resolveDeps(over);
  const { db: pdb } = deps;
  const name = String(input.name ?? "").trim();
  if (name === "") return err("invalid_input", "隧道名称不能为空");
  if (name.length > 60) return err("invalid_input", "隧道名称长度不能超过 60 字符");

  const mode = parseTunnelMode(input.mode);
  if (mode === null) return err("invalid_input", "隧道模式非法（direct/relay）");

  if (mode === "direct") {
    const forward = (input.forwardAddresses ?? []).map((x) => String(x).trim()).filter(Boolean);
    if (forward.length === 0) return err("invalid_input", "至少需要一个转发目标");
    const parsed = parseForwardAddress(forward[0]);
    if (!parsed) return err("invalid_input", "DIRECT 转发目标格式应为 host:port");
    const split = /^\[([^\]]+)\]:(\d+)$/.exec(parsed) ?? /^([^:]+):(\d+)$/.exec(parsed);
    if (!split) return err("invalid_input", "DIRECT 转发目标格式应为 host:port");
    const remoteHost = input.remoteHost ?? split[1]!;
    const remotePort = input.remotePort ?? Number(split[2]);

    const inGroup = asRow<NodeGroupRow>(await pdb.nodeGroup.findUnique({ where: { id: input.inNodeGroupId } }));
    if (!inGroup) return err("not_found", "入口节点组不存在");

    const pending = asRow<TunnelRow>(
      await pdb.tunnel.create({
        data: {
          name,
          tunnel_type: input.tunnelType ?? "tcp",
          listen_ip: "0.0.0.0",
          listen_port: input.listenPort ?? null,
          listen_protocol: [input.tunnelType ?? "tcp"],
          status: "active",
          forward_addresses: forward,
          load_balance_type: "round",
          ip_type: "ipv4",
          in_node_group_id: input.inNodeGroupId,
          out_node_group_id: null,
          user_id: input.userId,
          workspace_id: input.workspaceId,
          tunnel_mode: "direct",
          desired_status: "inactive",
          apply_status: "pending",
          config_revision: 0,
          applied_revision: null,
          remote_host: remoteHost,
          remote_port: remotePort,
        },
      }),
    );
    if (!pending) return err("db_unavailable", "创建失败");

    const policy = await deps.loadPolicy(input.workspaceId);
    const decision = checkTunnelCreation(policy, {
      tunnelCount: 0,
      trafficUsed: 0,
      protocol: input.tunnelType ?? "tcp",
      inGroupOwned: inGroup.workspace_id === input.workspaceId,
      inGroupId: inGroup.id,
      outGroupId: null,
      outGroupOwned: true,
    });
    if (!decision.allowed) {
      await pdb.tunnel.update({
        where: { id: pending.id },
        data: {
          apply_status: "error",
          desired_status: "inactive",
          apply_error_code: SCHEDULER_ERROR_CODES.policy_denied,
          apply_error: `[${SCHEDULER_ERROR_CODES.policy_denied}] ${decision.message ?? "策略拒绝"}`,
        },
      }).catch(() => {});
      return err("policy_denied", decision.message ?? "策略拒绝");
    }

    const orchestrator = over?.orchestrator ?? null;
    if (!orchestrator) return { ok: true, tunnelId: pending.id, mode: "direct", revision: 0 };

    const applied = await deps.applyDirect(pending.id, orchestrator, {
      db: deps.db as never,
      loadPolicy: deps.loadPolicy,
      now: deps.now,
    });
    if (!applied.ok) {
      return err("apply_failed", applied.error, { apply_error_code: applied.error_code });
    }
    return { ok: true, tunnelId: pending.id, mode: "direct", revision: applied.revision };
  }

  /* ---- RELAY：落 pending desired，交给编排器 ---- */
  const topology = validateRelayTopology({
    inNodeGroupId: input.inNodeGroupId,
    outNodeGroupId: input.outNodeGroupId,
    egressPoolId: input.egressPoolId,
  });
  if (!topology.ok) return err("invalid_input", topology.message);

  const inGroup = asRow<NodeGroupRow>(await pdb.nodeGroup.findUnique({ where: { id: input.inNodeGroupId } }));
  if (!inGroup) return err("not_found", "入口节点组不存在");
  const outGroup = asRow<NodeGroupRow>(
    await pdb.nodeGroup.findUnique({ where: { id: input.outNodeGroupId } }),
  );
  if (!outGroup) return err("not_found", "出口节点组不存在");

  const pending = asRow<TunnelRow>(
    await pdb.tunnel.create({
      data: {
        name,
        tunnel_type: input.tunnelType ?? "tcp",
        listen_ip: "0.0.0.0",
        listen_port: input.listenPort ?? null,
        listen_protocol: [input.tunnelType ?? "tcp"],
        status: "active",
        forward_addresses: [],
        load_balance_type: "round",
        ip_type: "ipv4",
        in_node_group_id: input.inNodeGroupId,
        out_node_group_id: input.outNodeGroupId,
        user_id: input.userId,
        workspace_id: input.workspaceId,
        tunnel_mode: "relay",
        desired_status: "inactive",
        apply_status: "pending",
        config_revision: 0,
        applied_revision: null,
        egress_pool_id: input.egressPoolId ?? null,
      },
    }),
  );
  if (!pending) return err("db_unavailable", "创建失败");

  const orchestrator = over?.orchestrator ?? null;
  if (!orchestrator) {
    // 没有编排器实例（未接线）时**不假装成功**：隧道停在 pending，
    // 调用方拿到的是「未下发」而不是「已 active」。reconciler 有 sink
    // 之后会按同 revision 补发（§7.12 fill_missing_runtime）。
    return { ok: true, tunnelId: pending.id, mode: "relay", revision: 0 };
  }

  const policy = await deps.loadPolicy(input.workspaceId);
  const decision = checkTunnelCreation(policy, {
    tunnelCount: 0,
    trafficUsed: 0,
    protocol: input.tunnelType ?? "tcp",
    inGroupOwned: inGroup.workspace_id === input.workspaceId,
    inGroupId: inGroup.id,
    outGroupId: outGroup.id,
    outGroupOwned: outGroup.workspace_id === input.workspaceId,
  });
  if (!decision.allowed) {
    await pdb.tunnel
      .update({
        where: { id: pending.id },
        data: {
          apply_status: "error",
          desired_status: "inactive",
          apply_error_code: SCHEDULER_ERROR_CODES.policy_denied,
          apply_error: `[${SCHEDULER_ERROR_CODES.policy_denied}] ${decision.message ?? "策略拒绝"}`,
        },
      })
      .catch(() => {});
    return err("policy_denied", decision.message ?? "策略拒绝");
  }

  const result = over?.applyCreate
    ? await deps.applyCreate(
        {
          tunnelId: pending.id,
          name,
          userId: input.userId,
          workspaceId: input.workspaceId,
          personalWorkspaceId: input.personalWorkspaceId,
          tunnelType: input.tunnelType ?? "tcp",
          inNodeGroupId: input.inNodeGroupId,
          outNodeGroupId: input.outNodeGroupId,
          egressPoolId: input.egressPoolId ?? null,
          listenPort: input.listenPort ?? null,
          listenIp: "0.0.0.0",
        },
        orchestrator,
      )
    : await deps.applyReapply(pending.id, orchestrator, {
        db: deps.db as never,
        loadPolicy: deps.loadPolicy,
        now: deps.now,
      });

  if (!result.ok) {
    // 失败已由编排器落库（apply_status=error + 结构化错误 + 补偿）。
    // 这里只翻译错误码；重试由用户显式触发（retry 端点）。
    return err("apply_failed", result.error, { apply_error_code: result.error_code });
  }
  return { ok: true, tunnelId: result.tunnelId, mode: "relay", revision: result.revision };
}

/* ================================================================== */
/* 写：运行操作（retry / suspend / resume / delete）                    */
/* ================================================================== */

export interface TunnelActionResult {
  ok: true;
  tunnelId: number;
  action: TunnelAction;
  /** apply 后的 revision（delete 为 0：行已不存在）。 */
  revision: number;
  tunnel?: ReturnType<typeof tunnelView>;
}

/**
 * 统一的运行操作入口。
 *
 * 顺序固定（与 §7.11 的「先落 desired 再收敛」一致）：
 *   1. 归属 + 状态兼容校验；
 *   2. 落 desired / apply_status（delete 除外）；
 *   3. **交给 orchestrator** 收敛到 active（retry/resume 重下发两端，
 *      suspend 只需标记，delete 撤两端后删行）。
 *
 * suspend 为什么不需要下发：Agent 侧的 `suspend_tunnel` 命令（WP6 六种
 * 动作之一）保留隧道与配置、只停转发。控制面把它记成 `apply_status=
 * suspended` 即可让 reconciler 不再试图补发（`wantsActive` 为 false）；
 * 真正让 Agent 停转发的那条命令由后续接线补上（与 WP9 的 sink 同一
 * 接线点），在此之前 suspended 是控制面的期望状态，不影响正确性。
 */
export async function runTunnelAction(
  tunnelId: number,
  action: TunnelAction,
  workspaceId: number,
  over?: TunnelApiDeps,
): Promise<TunnelActionResult | TunnelApiError> {
  const deps = resolveDeps(over);
  const { db: pdb } = deps;

  const tunnel = asRow<TunnelRow>(
    await pdb.tunnel.findFirst({ where: { id: tunnelId, workspace_id: workspaceId } }),
  );
  if (!tunnel) return err("not_found", "隧道不存在");

  const compat = canRunAction(action, tunnel);
  if (!compat.ok) return err("invalid_state", compat.message);

  if (action === "delete") {
    /* ---- delete：撤两端（编排器补偿路径）→ 删行 ---- */
    const orchestrator = over?.orchestrator ?? null;
    if (orchestrator && tunnel.tunnel_mode === "relay") {
      // revision+1：与 orchestrator.removeTunnel 的 stale 闸门契约一致
      //（用失败那次同值会被 Agent 判 stale 而撤不掉）。
      const revision = (tunnel.config_revision ?? 0) + 1;
      const egressNode = asRow<TunnelApiNodeRow>(
        await pdb.node.findUnique({
          where: { id: tunnel.egress_node_id ?? 0 },
          select: { id: true, node_id: true, connect_ip: true, role: true },
        }),
      );
      if (egressNode) {
        await orchestrator
          .removeTunnel({ tunnelId, node: egressNode as never, revision, reason: "tunnel deleted" })
          .catch(() => {});
      }
      // 入口侧同样要撤。补偿失败不阻断删除：行没了之后残留的 listener
      // 由 reconciler 的租约回收 + 同 revision 重发兜底，而「删不掉」
      // 对用户是死局（§4.1 的删除是显式用户动作）。
      const ingressNode = asRow<TunnelApiNodeRow>(
        await pdb.node.findUnique({
          where: { node_group_id: tunnel.in_node_group_id, role: "ingress" },
          select: { id: true, node_id: true, connect_ip: true, role: true },
        }),
      );
      if (ingressNode && ingressNode.id !== egressNode?.id) {
        await orchestrator
          .removeTunnel({ tunnelId, node: ingressNode as never, revision, reason: "tunnel deleted" })
          .catch(() => {});
      }
    }
    await pdb.tunnel.delete({ where: { id: tunnel.id } }).catch((e: unknown) => {
      throw toTunnelApiError(e, "删除失败");
    });
    return { ok: true, tunnelId: tunnel.id, action, revision: 0 };
  }

  const next = desiredAfterAction(action);
  const updated = asRow<TunnelRow>(
    await pdb.tunnel.update({
      where: { id: tunnel.id },
      data: {
        desired_status: next.desired_status,
        ...(next.apply_status ? { apply_status: next.apply_status } : {}),
        ...(next.clear_error ? { apply_error_code: null, apply_error: null } : {}),
      },
    }),
  );
  if (!updated) return err("not_found", "隧道不存在");

  if (action === "suspend") {
    return { ok: true, tunnelId: tunnel.id, action, revision: updated.config_revision ?? 0, tunnel: tunnelView(updated) };
  }

  /* ---- retry / resume：走 orchestrator 重新下发两端 ---- */
  const orchestrator = over?.orchestrator ?? null;
  if (!orchestrator || updated.tunnel_mode !== "relay") {
    // 未接线或 DIRECT：只完成 desired 切换。reconciler 的
    // fill_missing_runtime 会用同 revision 补发（RELAY），
    // legacy 配置推送照旧覆盖 DIRECT。
    return { ok: true, tunnelId: tunnel.id, action, revision: updated.config_revision ?? 0, tunnel: tunnelView(updated) };
  }

  const result = await deps.applyReapply(tunnel.id, orchestrator, {
    db: deps.db as never,
    loadPolicy: deps.loadPolicy,
    now: deps.now,
  });

  if (!result.ok) {
    // 编排失败：编排器已把行落成 error（保留记录）。这里**不能** 204 掉，
    // 调用方必须看到失败才能展示原因并允许再次 Retry（§4.1）。
    return err("apply_failed", result.error, { apply_error_code: result.error_code });
  }
  const after = asRow<TunnelRow>(
    await pdb.tunnel.findFirst({ where: { id: tunnel.id, workspace_id: workspaceId } }),
  );
  return {
    ok: true,
    tunnelId: tunnel.id,
    action,
    revision: result.revision,
    ...(after ? { tunnel: tunnelView(after) } : {}),
  };
}

/* ================================================================== */
/* 写：更新（desired state）                                            */
/* ================================================================== */

export interface UpdateTunnelInput {
  name?: string;
  listenPort?: number | null;
  remoteHost?: string | null;
  remotePort?: number | null;
  /** 改模式（direct↔relay）。改模式等于重建下发：与 WP4 对齐必须走编排器。 */
  mode?: TunnelModeValue;
  inNodeGroupId?: number;
  outNodeGroupId?: number | null;
  egressPoolId?: number | null;
  forwardAddresses?: string[] | null;
}

/**
 * 更新隧道的 desired state。
 *
 * 只改**配置/归属**类字段（名字、端口、目标、池、组）。运行态变更
 * （retry/suspend/resume/delete）走 {@link runTunnelAction}——它才接
 * 编排器。改 `egress_pool_id` 是 §4.2 的「目标池热更新」，由
 * `update_targets` 覆盖（WP6 已冻结该动作），接线点与 suspend 相同。
 */
export async function updateTunnel(
  tunnelId: number,
  input: UpdateTunnelInput,
  workspaceId: number,
  over?: TunnelApiDeps,
): Promise<{ ok: true; tunnel: ReturnType<typeof tunnelView> } | TunnelApiError> {
  const { db: pdb } = resolveDeps(over);
  const tunnel = asRow<TunnelRow>(
    await pdb.tunnel.findFirst({ where: { id: tunnelId, workspace_id: workspaceId } }),
  );
  if (!tunnel) return err("not_found", "隧道不存在");

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (name === "") return err("invalid_input", "隧道名称不能为空");
    if (name.length > 60) return err("invalid_input", "隧道名称长度不能超过 60 字符");
    data.name = name;
  }
  if (input.listenPort !== undefined) {
    if (input.listenPort === null) {
      data.listen_port = null;
    } else {
      const port = parsePort(input.listenPort);
      if (Number.isNaN(port)) return err("invalid_input", "监听端口必须在 1-65535 之间");
      const conflict = asRow<TunnelRow>(
        await pdb.tunnel.findFirst({
          where: {
            in_node_group_id: (data.in_node_group_id as number | undefined) ?? tunnel.in_node_group_id,
            listen_port: port,
            NOT: { id: tunnel.id },
          },
        }),
      );
      if (conflict) return err("conflict", "监听端口已被占用");
      data.listen_port = port;
    }
  }
  if (input.mode !== undefined) {
    const mode = parseTunnelMode(input.mode);
    if (mode === null) return err("invalid_input", "隧道模式非法（direct/relay）");
    if (mode === "relay" && tunnel.out_node_group_id === null && input.outNodeGroupId === undefined) {
      return err("invalid_input", "切换到 RELAY 必须指定出口节点组");
    }
    data.tunnel_mode = mode;
  }
  if (input.inNodeGroupId !== undefined) {
    const g = Number.isInteger(input.inNodeGroupId)
      ? asRow<NodeGroupRow>(await pdb.nodeGroup.findUnique({ where: { id: input.inNodeGroupId } }))
      : null;
    if (!g) return err("not_found", "入口节点组不存在");
    data.in_node_group_id = g.id;
  }
  if (input.outNodeGroupId !== undefined) {
    if (input.outNodeGroupId === null) {
      // 关键：要看**更新后的**模式——同一个 PATCH 里可能既 relay 又清出口组，
      // 此时 `data.tunnel_mode` 已是新值；未改 mode 时沿用行上现值。两种
      // 情况都不能让 RELAY 失去出口组（否则双跳退化成残状态）。
      const effectiveMode = (data.tunnel_mode as string | undefined) ?? tunnel.tunnel_mode ?? "direct";
      if (effectiveMode === "relay") {
        return err("invalid_input", "RELAY 模式必须保留出口节点组");
      }
      data.out_node_group_id = null;
    } else {
      const g = Number.isInteger(input.outNodeGroupId)
        ? asRow<NodeGroupRow>(await pdb.nodeGroup.findUnique({ where: { id: input.outNodeGroupId } }))
        : null;
      if (!g) return err("not_found", "出口节点组不存在");
      data.out_node_group_id = g.id;
    }
  }
  if (input.egressPoolId !== undefined) {
    if (input.egressPoolId === null) {
      data.egress_pool_id = null;
    } else {
      const pool = asRow<EgressPoolRow>(
        await pdb.egressPool.findUnique({ where: { id: input.egressPoolId } }),
      );
      if (!pool) return err("not_found", "出口池不存在");
      data.egress_pool_id = pool.id;
    }
  }
  if (input.forwardAddresses !== undefined) {
    const forward = (input.forwardAddresses ?? []).map((x) => String(x).trim()).filter(Boolean);
    if (forward.length === 0) return err("invalid_input", "至少需要一个转发目标");
    const invalid = forward.map(parseForwardAddress).find((x) => x === null);
    if (invalid !== undefined) return err("invalid_input", `转发目标格式应为 host:port：${invalid ?? "非法地址"}`);
    data.forward_addresses = forward;
  }
  if (input.remoteHost !== undefined) data.remote_host = input.remoteHost;
  if (input.remotePort !== undefined) data.remote_port = input.remotePort;

  const updated = asRow<TunnelRow>(await pdb.tunnel.update({ where: { id: tunnel.id }, data }));
  if (!updated) return err("not_found", "隧道不存在");
  return { ok: true, tunnel: tunnelView(updated) };
}
