/**
 * Admin Node / Egress workflows.
 *
 * Shared contracts and validation live in node-admin-core.ts; this file owns
 * node resolution, role changes and node detail reads.
 */
import { checkRoleChange, getNodeImpact, listActiveLeasePorts, type LifecycleDb } from "./node-lifecycle.ts";
import { DEFAULT_POOL_NAME, err, toAdminError, deps, asRow, asRows, falsy, parseOk, parseFail, parseNodeRole, isValidTargetPort, parsePortRange, parseLbStrategy, parseEgressStatus, parseRequiredHost, parseOptionalHost, parsePoolName, parseTargetPort, parseWeight, parseOrderBy, parseRemark, hasEgressCapability, poolHasViableTarget, isRoleMismatch, stateAgeSeconds, isStaleState, credentialStateOf, jsonOr } from "./node-admin-core.ts";
import type { NodeRoleValue, EgressStatusValue, NodeAdminError, NodeRow, StateReportRow, EgressPoolRow, EgressTargetRow, NodeAdminDb, NodeAdminDeps, ParseResult, NodeCredentialState } from "./node-admin-core.ts";
import { guardEgressSelector } from "./node-admin-core.ts";

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

  const selectorDenied = await guardEgressSelector(pd, nodeId,
    input.lbStrategy !== undefined ? lbParsed.value : node.lb_strategy);
  if (selectorDenied) return selectorDenied;

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


export {
  createEgressPool,
  updateEgressPool,
  deleteEgressPool,
  listEgressPools,
  parseTargetInput,
  createTarget,
  updateTarget,
  deleteTarget,
  listTargets,
  replaceTargets,
  parseHostPort,
} from "./node-admin-egress.ts";
export type { CreatePoolInput, UpdatePoolInput, TargetInput } from "./node-admin-egress.ts";

export {
  getNodeState,
  listNodeStates,
  listNodeStatesWithCredentials,
  getNodeCredential,
} from "./node-admin-state.ts";
export type { NodeStateView, FleetStateOptions } from "./node-admin-state.ts";
