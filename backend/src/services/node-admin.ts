/**
 * Admin Node / Egress workflows.
 *
 * Shared contracts and validation live in node-admin-core.ts; this file owns
 * role changes, EgressPool/EgressTarget operations and runtime/state reads.
 */
import { checkRoleChange, getNodeImpact, listActiveLeasePorts, type LifecycleDb } from "./node-lifecycle.ts";
import { DEFAULT_POOL_NAME, err, toAdminError, deps, asRow, asRows, falsy, parseOk, parseFail, parseNodeRole, isValidTargetPort, parsePortRange, parseLbStrategy, parseEgressStatus, parseRequiredHost, parseOptionalHost, parsePoolName, parseTargetPort, parseWeight, parseOrderBy, parseRemark, hasEgressCapability, poolHasViableTarget, isRoleMismatch, stateAgeSeconds, isStaleState, credentialStateOf, jsonOr } from "./node-admin-core.ts";
import type { NodeRoleValue, EgressStatusValue, NodeAdminError, NodeRow, StateReportRow, EgressPoolRow, EgressTargetRow, NodeAdminDb, NodeAdminDeps, ParseResult, NodeCredentialState } from "./node-admin-core.ts";

export { NODE_ROLES, EGRESS_STATUSES, LB_STRATEGIES, DEFAULT_POOL_NAME, PORT_MIN, PORT_MAX, NODE_STATE_STALE_SECONDS, POOL_NAME_MAX, TARGET_HOST_MAX, ADMIN_ERROR_STATUS, toAdminError, parseNodeRole, isValidTargetPort, parsePortRange, parseLbStrategy, parseEgressStatus, parsePoolName, parseTargetHost, parseTargetPort, parseWeight, parseOrderBy, parseRemark, hasEgressCapability, poolHasViableTarget, isRoleMismatch, stateAgeSeconds, isStaleState, credentialStateOf } from "./node-admin-core.ts";
export type { NodeRoleValue, EgressStatusValue, LbStrategyValue, NodeAdminErrorCode, NodeAdminError, NodeRow, StateReportRow, EgressPoolRow, EgressTargetRow, NodeAdminDb, NodeAdminDeps, ParseResult, NodeCredentialState } from "./node-admin-core.ts";

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

/**
 * 角色 / 端口区间写入的**唯一**依赖判定入口（§13.4.3）。
 *
 * 判定与统计一行都不在本文件重写：直接复用 `services/node-lifecycle.ts` 的
 * `getNodeImpact` / `listActiveLeasePorts` / `checkRoleChange` —— 与
 * `GET /api/admin/node/:id/impact` 预检是**同一套口径**。
 *
 * V4-F2 的缺陷正是两者的漂移：预检用 `checkRoleChange` 判「不许收缩」，而写路径
 * 只查了出口池计数就落库 → 预检拒绝、PATCH 却 200 且 DB 已改。所以这里不新增
 * 第二套规则，只把同一个判定接到写路径上。
 *
 * 返回 null = 放行；否则 409 + `condition` + 依赖清单（§13.5 可区分错误码）。
 */
async function guardNodeRoleChange(
  pd: NodeAdminDb,
  node: NodeRow,
  input: {
    roleGiven: boolean;
    nextRole: NodeRoleValue | null;
    rangeGiven: boolean;
    nextRange: { min: number; max: number } | null;
  },
): Promise<NodeAdminError | null> {
  const lifecycleDb = pd as unknown as LifecycleDb;
  const impactResult = await getNodeImpact(node.id, { db: lifecycleDb });
  // 统计失败一律 fail-closed：看不见依赖时不许收缩（宁可 503 也不落库）。
  if (!impactResult.ok) return err("db_unavailable", "节点依赖统计失败，已拒绝本次修改");

  const verdict = checkRoleChange({
    node: { id: node.id, role: node.role },
    impact: impactResult.impact,
    check: {
      // 角色键缺失 = 本次不改角色 → 沿用当前角色参与判定；
      // 显式清空（null / ""）传空串，与预检 `?next_role=`（空值）同义：
      // 入口与出口能力都丢，仍需依赖为空才允许。
      nextRole: input.roleGiven ? (input.nextRole ?? "") : undefined,
      // 端口区间键缺失 = 区间不变 → 不可能新增悬空（portRangeWouldOrphan 对
      // null/undefined 返回 []）。给了才查租约，省一次查询。
      nextPortRange: input.rangeGiven ? input.nextRange : undefined,
      activeLeasePorts: input.rangeGiven
        ? await listActiveLeasePorts(node.id, { db: lifecycleDb })
        : [],
    },
  });
  if (verdict.ok) return null;
  return {
    ok: false,
    code: "invalid_state",
    message: verdict.message,
    condition: verdict.condition,
    dependencies: impactResult.impact,
  };
}

/**
 * 把「依赖判定 + 写入」收进**同一个事务**，并先锁住 node 行
 * （`SELECT id FROM node WHERE id = ? FOR UPDATE`）。
 *
 * 为什么锁 node 行就够（无需改 forward-service / portPool）：
 * `tunnel.ingress_node_id` / `tunnel.egress_node_id` / `node_port_lease.node_id`
 * 都是指向 `node` 的外键，InnoDB 在插入子行时会对该父行加共享锁；本事务持排他锁
 * 期间，并发的 Forward / 租约插入会阻塞到提交，因此锁内统计出的依赖清单在写入前
 * 不会再被改变（防 TOCTOU）。同一把锁也串行化同一节点的并发角色/区间修改。
 *
 * 省略事务接缝（内存替身）= 顺序执行同一套判定与写入，只是没有行锁。
 */
async function inNodeRoleTx<T>(
  pd: NodeAdminDb,
  nodeId: number,
  run: (tx: NodeAdminDb) => Promise<T>,
): Promise<T> {
  const begin = pd.$transaction?.bind(pd);
  if (!begin) return run(pd);
  return begin(async (tx: NodeAdminDb) => {
    const raw = tx.$queryRaw?.bind(tx);
    if (raw) await raw`SELECT id FROM node WHERE id = ${nodeId} FOR UPDATE`;
    return run(tx);
  });
}

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
 * 守卫，按顺序：
 *   0. **依赖收缩必须先过 impact check**（§13.4.3，见 {@link guardNodeRoleChange}）：
 *      丢掉入口/出口能力却仍有 Forward 用它，或端口区间收缩会让 active 租约悬空
 *      → 409 + condition，**不落库**。判定与 `GET /node/:id/impact` 预检同源。
 *   1. **丢掉出口能力前必须先把池清干净**：ingress 节点上的出口池不会跟着
 *      角色消失，留着 = 「以为在跑出口其实没有出口能力」；要删池请显式走
 *      {@link deleteEgressPool}（它自己会检查是否被隧道引用）。
 *   2. **获得出口能力时补 default 池**：schema 注释「每个出口节点自动拥有
 *      一个 default 池」在此落地，而不是留给将来 WP8 发现「没有池可挂隧道」。
 *      幂等（唯一冲突 = 别人已建好，视为成功）。
 *   3. 端口区间同 portPool 语义：未配置 = 没有 v3 端口域，不回落节点组
 *      `port_range`。
 *
 * 上面所有读取与写入都在**同一个事务 + node 行锁**里完成（{@link inNodeRoleTx}），
 * 否则「判定通过」与「落库」之间会被并发创建的 Forward 插空档。
 */
export async function updateNodeRole(
  nodeId: number,
  input: UpdateNodeRoleInput,
  inject?: NodeAdminDeps,
): Promise<
  | { ok: true; node: NodeRow; default_pool_created: boolean }
  | NodeAdminError
> {
  const { db: pd } = await deps(inject);

  // 入参校验是纯函数，先做完再进事务（不必占着行锁做 400）。
  const roleParsed = parseNodeRole(input.role);
  if (!roleParsed.ok) return err("invalid_input", roleParsed.message);
  const rangeParsed = parsePortRange(input.portRangeMin, input.portRangeMax);
  if (!rangeParsed.ok) return err("invalid_input", rangeParsed.message);
  const lbParsed = parseLbStrategy(input.lbStrategy);
  if (!lbParsed.ok) return err("invalid_input", lbParsed.message);

  try {
    return await inNodeRoleTx(pd, nodeId, (tx) => applyNodeRoleChange(tx, nodeId, input));
  } catch (e) {
    return toAdminError(e, "节点更新失败");
  }
}

/**
 * {@link updateNodeRole} 的守卫 + 落库主体。
 *
 * `pd` 由调用方传入（生产 = 事务客户端 `tx`，测试 = 内存替身），因此这里的每一次
 * count / findFirst / update 都落在**同一个事务**里：守卫读到的依赖与最终写入之间
 * 不存在可被并发插入的空档。
 */
async function applyNodeRoleChange(
  pd: NodeAdminDb,
  nodeId: number,
  input: UpdateNodeRoleInput,
): Promise<
  | { ok: true; node: NodeRow; default_pool_created: boolean }
  | NodeAdminError
> {
  const roleParsed = parseNodeRole(input.role);
  if (!roleParsed.ok) return err("invalid_input", roleParsed.message);
  const rangeParsed = parsePortRange(input.portRangeMin, input.portRangeMax);
  if (!rangeParsed.ok) return err("invalid_input", rangeParsed.message);
  const lbParsed = parseLbStrategy(input.lbStrategy);
  if (!lbParsed.ok) return err("invalid_input", lbParsed.message);

  const node = asRow<NodeRow>(await pd.node.findUnique({ where: { id: nodeId } }));
  if (!node) return err("not_found", "节点不存在");

  // 角色键缺失 = 本次不改角色（只改区间/策略）→ 沿用当前 role 参与守卫判定；
  // 显式 `null`/"" = 清空角色。二者必须可区分：把「没给 role」当成「清空 role」
  // 会让只改 lb_strategy 的请求被误判成丢掉入口能力（既有缺口），
  // 也会误建 default 池。持久化仍只认 `input.role !== undefined`（见下）。
  // `node.role` 来自 DB 的 `NodeRole?` 枚举，这里按枚举收窄（null = 尚未声明）。
  const currentRole = (node.role ?? null) as NodeRoleValue | null;
  const nextRole: NodeRoleValue | null = input.role !== undefined ? roleParsed.value : currentRole;
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

  // 守卫 2（§13.4.3）：角色 / 端口区间的**依赖收缩**必须先过 impact check，
  // 与 `GET /admin/node/:id/impact` 预检同源（同一个 checkRoleChange）。拒绝即
  // 返回，绝不落库——这正是 V4-F2 里「预检拒绝、PATCH 却 200」的缺口。
  //
  // 两个键都没给（例如只改 lb_strategy）时不可能收缩依赖，连统计都不做：
  // 否则一次无关改动会因为「统计暂时查不动」被 503 掉。
  const roleGiven = input.role !== undefined;
  const rangeGiven = input.portRangeMin !== undefined || input.portRangeMax !== undefined;
  if (roleGiven || rangeGiven) {
    const blocked = await guardNodeRoleChange(pd, node, {
      roleGiven,
      nextRole,
      rangeGiven,
      nextRange: rangeParsed.value,
    });
    if (blocked) return blocked;
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

  // 守卫 3：刚获得出口能力 → 补 default 池（幂等）。
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
          // Returning an error object from a Prisma transaction COMMITs the
          // earlier node.update. Throw so the transaction rolls the role change
          // back together with the failed default-pool creation.
          throw e;
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
  const { db: pd } = await deps(inject);
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
  const { db: pd } = await deps(inject);

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
  const { db: pd } = await deps(inject);

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
  const { db: pd } = await deps(inject);

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
  const { db: pd } = await deps(inject);
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
  const { db: pd } = await deps(inject);

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
  const { db: pd } = await deps(inject);

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
  const { db: pd } = await deps(inject);

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
  const { db: pd } = await deps(inject);
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
  const { db: pd } = await deps(inject);
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
  const desiredIds = new Set<number>();
  const desiredEndpoints = new Set<string>();

  for (const raw of inputs) {
    if (!raw || typeof raw !== "object") return err("invalid_input", "目标条目必须是对象");
    const rec = raw as Record<string, unknown>;
    const id = rec.id === undefined || rec.id === null || rec.id === "" ? undefined : Number(rec.id);
    if (id !== undefined && (!Number.isInteger(id) || id <= 0)) {
      return err("invalid_input", "目标 id 不合法");
    }
    if (id !== undefined) {
      if (desiredIds.has(id)) return err("invalid_input", `目标 id ${id} 重复`);
      desiredIds.add(id);
    }

    // 整批替换是**全量**语义：每条都必须自带地址与端口（没有「沿用旧值」）。
    const parsed = parseTargetInput({ ...rec, port: rec.port, weight: rec.weight });
    if (!parsed.ok) return err("invalid_input", parsed.message);
    if (parsed.value.host === undefined || parsed.value.port === undefined) {
      return err("invalid_input", "目标必须同时提供地址与端口");
    }
    const endpoint = `${parsed.value.host}:${parsed.value.port}`;
    if (desiredEndpoints.has(endpoint)) {
      return err("invalid_input", `目标集包含重复地址 ${endpoint}`);
    }
    desiredEndpoints.add(endpoint);
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

  const applyReplacement = async (
    tx: NodeAdminDb,
  ): Promise<{ ok: true; targets: EgressTargetRow[] } | NodeAdminError> => {
    const pool = asRow<EgressPoolRow>(await tx.egressPool.findUnique({ where: { id: poolId } }));
    if (!pool) return err("not_found", "出口池不存在");
    // 池自身停用时整批 active 目标无意义。
    if (pool.status !== "active" && desired.some((d) => d.status === "active")) {
      return err("invalid_state", "出口池已停用，不能提交 active 目标");
    }

    const existing = asRows<EgressTargetRow>(
      await tx.egressTarget.findMany({ where: { pool_id: poolId }, orderBy: { id: "asc" } }),
    );
    const existingIds = new Set(existing.map((row) => row.id));

    // target id is scoped by pool. Prisma's update({where:{id}}) alone would
    // happily mutate a target owned by another pool.
    for (const d of desired) {
      if (d.id !== undefined && !existingIds.has(d.id)) {
        return err("not_found", `目标 ${d.id} 不存在或不属于该池`);
      }
    }

    const keepIds: number[] = [];
    const result: EgressTargetRow[] = [];
    for (const d of desired) {
      if (d.id === undefined) {
        const created = asRow<EgressTargetRow>(
          await tx.egressTarget.create({
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
          await tx.egressTarget.update({
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

    // 删除载荷里没出现的旧行。只有 P2025 能解释成“并发方已经替我们删掉”；
    // 连接/事务/权限等其它错误必须冒泡，使整个生产事务回滚。
    for (const row of existing) {
      if (keepIds.includes(row.id)) continue;
      try {
        await tx.egressTarget.delete({ where: { id: row.id } });
      } catch (error) {
        if ((error as { code?: string })?.code !== "P2025") throw error;
      }
    }
    return { ok: true, targets: result };
  };

  try {
    const begin = pd.$transaction?.bind(pd);
    return begin ? await begin((tx) => applyReplacement(tx)) : await applyReplacement(pd);
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
  /**
   * V4-WP11B 控制协议协商事实。
   * `null` = 该 Agent 未上报（按基线动作处理），数组 = 其自述实现的动作清单。
   * 两者在下发判定里含义不同，因此这里也不做「null → []」的归一。
   */
  control_protocol_version: number | null;
  capabilities: string[] | null;
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
  const { db: pd, now } = await deps(inject);

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
        // V4-WP11B: the operator needs to see "this node cannot receive action X
        // yet" before it happens, not as a dispatch failure afterwards.
        control_protocol_version: true,
        capabilities: true,
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
      // Negotiation facts, surfaced verbatim. `capabilities: null` means "this
      // Agent never told us" and must NOT be rendered as an empty list: the two
      // have different meanings for what the panel is allowed to send.
      control_protocol_version: snapshot?.control_protocol_version ?? null,
      capabilities: Array.isArray(snapshot?.capabilities) ? snapshot?.capabilities : null,
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
  const { db: pd, now } = await deps(inject);

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
          control_protocol_version: true,
          capabilities: true,
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
          // Same rule as the single-node view: null means "not reported", and the
      // two cases must not be collapsed into an empty list.
      control_protocol_version: snapshot?.control_protocol_version ?? null,
      capabilities: Array.isArray(snapshot?.capabilities) ? snapshot?.capabilities : null,
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
  const { db: pd, now } = await deps(inject);

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
        control_protocol_version: true,
        capabilities: true,
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
      // Negotiation facts; `null` (never reported) is preserved as null.
      control_protocol_version: snapshot?.control_protocol_version ?? null,
      capabilities: Array.isArray(snapshot?.capabilities) ? snapshot?.capabilities : null,
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
  const { db: pd } = await deps(inject);
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
