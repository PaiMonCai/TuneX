/**
 * EgressPool and EgressTarget administration.
 *
 * This file preserves the existing DB and validation semantics while separating
 * egress resource CRUD from node role/lifecycle workflows.
 */
import { DEFAULT_POOL_NAME, err, toAdminError, deps, asRow, asRows, falsy, parseOk, parseFail, parseNodeRole, isValidTargetPort, parsePortRange, parseLbStrategy, parseEgressStatus, parseRequiredHost, parseOptionalHost, parsePoolName, parseTargetPort, parseWeight, parseOrderBy, parseRemark, hasEgressCapability, poolHasViableTarget, isRoleMismatch, stateAgeSeconds, isStaleState, credentialStateOf, jsonOr } from "./node-admin-core.ts";
import type { NodeRoleValue, EgressStatusValue, NodeAdminError, NodeRow, StateReportRow, EgressPoolRow, EgressTargetRow, NodeAdminDb, NodeAdminDeps, ParseResult, NodeCredentialState } from "./node-admin-core.ts";
import { guardEgressSelector } from "./node-admin-core.ts";

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

  const selectorDenied = await guardEgressSelector(pd, nodeId, lbParsed.value ?? node.lb_strategy);
  if (selectorDenied) return selectorDenied;

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

  const poolStrategy = input.lbStrategy !== undefined ? data.lb_strategy : pool.lb_strategy;
  const node = poolStrategy == null
    ? asRow<{ lb_strategy: string | null }>(await pd.node.findUnique({ where: { id: pool.node_id }, select: { lb_strategy: true } }))
    : null;
  if (poolStrategy == null && !node) return err("not_found", "节点不存在");
  const selectorDenied = await guardEgressSelector(pd, pool.node_id, poolStrategy ?? node?.lb_strategy);
  if (selectorDenied) return selectorDenied;

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

