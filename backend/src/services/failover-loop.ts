/**
 * Automatic Forward placement evaluation on the existing reconcile cadence.
 *
 * The loop selects Forwards with placement state, supplies policy/candidate facts
 * that are not owned by the executor, invokes the existing failover executor and
 * preserves its structured result. Missing policy, destination or required port
 * facts fail closed. The loop does not create a second timer, roll placement
 * epochs backward or invent a separate compensation path.
 */

import { Prisma } from "@prisma/client";
import { db } from "../db.ts";
import { systemConfig } from "./config.ts";
import { candidateRejection, type CandidateFacts } from "./ingress-candidate.ts";
// task-43：按转发的**入口成员次序**（意图）。次序读不到时回退到既有规则（`node_id` 升序），
// 读取器自己吞掉异常并返回 `null` —— 见 `readIngressMemberIntent` 的注释。
import {
  ingressOrderIndexOf,
  readIngressMemberIntent,
  type IngressMemberIntentRow,
} from "./preferred-ingress.ts";
// V5-WP17.4：闸门与后继。**静态** import 是安全的：这两个模块都不在 import 期读 env
//（`ddns-successor` 里的 `db` 是延迟 import），所以本模块仍然可以在没有 DATABASE_URL 的
// 进程里被 import 与断言。
import { defaultDnsGate, defaultDdnsSuccessor } from "./ddns-successor.ts";
import {
  executeFailoverForTunnel,
  readFailoverDecisionFacts,
  type ApplyPlacementMove,
  type FailoverExecutorDeps,
  type FailoverExecutionResult,
  type FailoverExecutorDb,
  type FailoverDestinations,
  type PlacementMoveRequest,
} from "./failover-executor.ts";
import type { FailoverPolicyFacts } from "./failover-policy.ts";

/** 策略配置键：`{ "auto_failover": bool, "auto_failback": bool }`。 */
export const FAILOVER_POLICY_CONFIG_KEY = "FAILOVER_POLICY";

/**
 * 读运维策略。
 *
 * **缺省即关**：没配置过就两个都 false。§8 要求"自动迁移必须是显式 policy"，
 * 而"默认打开、出事再关"正好违背它 —— 迁移是会中断服务的动作，不该由缺省值开启。
 * 坏 JSON 同样按关闭处理（并**报告**，见调用方的 log）。
 */
export async function readFailoverPolicy(): Promise<FailoverPolicyFacts & { parse_error?: string }> {
  const raw = await systemConfig.getConfig(FAILOVER_POLICY_CONFIG_KEY).catch(() => null);
  if (raw === null || raw === "") return { auto_failover: false, auto_failback: false };
  try {
    const parsed = JSON.parse(raw) as { auto_failover?: unknown; auto_failback?: unknown };
    return {
      auto_failover: parsed.auto_failover === true,
      auto_failback: parsed.auto_failback === true,
    };
  } catch (e) {
    return {
      auto_failover: false,
      auto_failback: false,
      parse_error: (e as Error)?.message ?? String(e),
    };
  }
}

/**
 * 候选节点：同一**入口节点组**内、非现任、且**通过编译器同一份判定**的节点。
 *
 * V5-WP17.1 之前它用 `role + state_report(5 分钟)` 判断，那与编译器的判据**不同源**：
 * 一台凭据已被吊销、或生命周期停在 `suspended` 的机器，在编译器眼里不可用，在这里却"可用"
 * —— 于是迁移会把一条转发搬到一台**面板指挥不动**的机器上。现在两边共用
 * `candidateRejection()`（准入 → 生命周期 → 角色 → 在线），差异只剩一个显式开关：
 * 故障转移额外要求"此刻在线"，因为它要挑一台**现在就能接管**的机器。
 *
 * **首选入口（契约 D4 收口）**：`tunnel.preferred_ingress_node_id` 之前没有存储、而这里又恒返回
 * `preferred_node_id = null` ⇒ 自动回切永远不可能发生。现在偏好从列里读，并且**即使它今天不合格
 * 也照原样报出** —— 判定留给策略（`failback_healthy_checks` 那条条件），这样运维看到的原因是
 * "首选节点不可达 / 端口不可用 / 连续健康次数不够"，而不是一句无信息量的"没有回切"。
 *
 * **唯一的例外**：在本次成员次序里被**显式停用**的成员（`forward_ingress_member.is_enabled=false`）
 * 不能当回切目标 —— 停用的意图就是"不让它接管"，而 `candidates` 已经按同一份 `IngressOrderIndex`
 * 排除了它。两边不一致的症状是：候选永远选不到它，回切却每拍都指向它（P1 缺陷现场）。
 * 次序**读不到**时按"没有次序"处理，既有语义逐位不变。
 */
/**
 * 候选查询的依赖缝隙。
 *
 * 参数类型用**真实 Prisma 参数类型**（而不是 `unknown`）—— 这不是洁癖，是把它当成最后一道
 * 类型防线：`db.node.findMany({ select: { has_credential: true } })` 曾在这里**静默通过**
 * （`Node` 根本没有这一列，它是派生事实 `node_credential_hash != null`），后果是**每一拍
 * failover 扫描都抛错中止**，而闸门与 DNS 后继就在那个循环里 ⇒ WP17.4 在运行期从未执行过。
 * 缝隙用 `unknown` 就等于把 Prisma 的字段校验关掉了：替身不认识字段，编译期也不认识。
 */
export interface FailoverCandidateDb {
  tunnel: { findUnique: (args: Prisma.TunnelFindUniqueArgs) => Promise<unknown> };
  node: { findMany: (args: Prisma.NodeFindManyArgs) => Promise<unknown[]> };
  /**
   * task-43：入口成员次序（意图）的读面。**可选** —— 老替身没有它时按"读不到次序"处理
   * （回退到 `node_id` 升序），这样既有测试与既有部署都不会因为多了一个读面而变形。
   */
  forwardIngressMember?: {
    findMany: (args: Prisma.ForwardIngressMemberFindManyArgs) => Promise<unknown>;
  };
}

export async function pickFailoverDestination(
  ctx: {
    tunnel_id: number;
    workspace_id: number;
    owner_node_id: number | null;
    /** 显式时钟：在线判定不能读真实时钟，否则扫描结论随墙上时钟漂移。 */
    now?: Date;
  },
  // 缺省走进程级 `db`，测试传替身（与本模块其余部分的依赖注入同一取向）。
  // 值得注入的理由很具体：候选过滤的规则是这条 WP 的核心，而"哪台机器算合格"必须在
  // **没有数据库**的进程里就能断言。
  candidateDb: FailoverCandidateDb = db as unknown as FailoverCandidateDb,
  /**
   * task-43：次序来源。`undefined` = 本函数自己读一次（直调方）；扫描器会传**整批读到的**
   * 结果（每拍一次查询，而不是每条隧道一次）。`null` = 读不到 ⇒ 回退今天的行为。
   */
  options?: { order?: readonly IngressMemberIntentRow[] | null },
): Promise<FailoverDestinations> {
  const tunnel = (await candidateDb.tunnel.findUnique({
    where: { id: ctx.tunnel_id },
    select: { in_node_group_id: true, preferred_ingress_node_id: true },
  })) as { in_node_group_id: number; preferred_ingress_node_id: number | null } | null;
  if (!tunnel) return { candidate_node_id: null, preferred_node_id: null };

  const rows = ((await candidateDb.node.findMany({
    where: {
      node_group_id: tunnel.in_node_group_id,
      id: ctx.owner_node_id === null ? undefined : { not: ctx.owner_node_id },
      role: { in: ["ingress", "both"] },
    },
    select: {
      id: true,
      node_group_id: true,
      role: true,
      lifecycle: true,
      status: true,
      last_seen_at: true,
      // `has_credential` **不是列**：它是派生事实（`node_credential_hash != null`），
      // 与 `forward-service.ts` / `attention.ts` / `support-bundle.ts` 同口径。
      // 直接 select 它会让 Prisma 抛 "Unknown field"，而扫描是**逐条循环**里的调用 ⇒
      // 一条坏查询会让整轮扫描中止（连带闸门与 DNS 后继都不跑）。
      node_credential_hash: true,
      credential_revoked: true,
    },
    orderBy: { id: "asc" },
  })) as unknown as Array<CandidateFacts & { id: number; node_credential_hash?: string | null }>).map((row) => ({
    ...row,
    node_id: row.id,
    has_credential: Boolean(row.node_credential_hash),
  }));

  // task-43 —— 次序（意图）。只有"哪台先被挑中"受影响；合格性判定一行不改。
  const intent =
    options?.order !== undefined
      ? options.order
      : candidateDb.forwardIngressMember
        ? await readIngressMemberIntent(
            candidateDb as unknown as { forwardIngressMember: NonNullable<FailoverCandidateDb["forwardIngressMember"]> },
            ctx.tunnel_id,
          )
        : null;
  const order = ingressOrderIndexOf(intent ?? null);

  const eligible = rows.filter(
    (node) =>
      candidateRejection(node, "ingress", {
        requireOnline: true,
        ...(ctx.now ? { now: ctx.now } : {}),
      }) === null,
  );
  // 次序上显式停用的成员不参与接管（"这次我不让它接管"是一条意图，不是事实）。
  const candidates = eligible.filter((node) => !order.isDisabled(node.node_id));

  // 偏好等于现任 ⇒ 没有"回切"可言（回切的定义就是离开现任）。报 null 而不是原样透出，
  // 否则每一拍都会有一条"回切条件不满足"的噪音，而它描述的是一件本就不需要发生的事。
  //
  // task-47：**显式停用的成员不参与回切**，与上面的 `candidates` 用同一份 `order.isDisabled`
  // —— 停用是"这次不让它接管"的意图，它既不该被选为候选，也不该成为回切目标。只读不到次序
  // （`intent === null`）时 `isDisabled` 恒 false ⇒ 既有语义（离线/维护中的偏好照原样报出）
  // 逐位不变：一次可修复的读错误不该凭空禁用所有节点。
  const preferredRaw = tunnel.preferred_ingress_node_id;
  const preferredId =
    preferredRaw !== null && preferredRaw !== ctx.owner_node_id && !order.isDisabled(preferredRaw)
      ? preferredRaw
      : null;

  // 候选选择：**次序优先，其次 node_id 升序**（task-43 引入按转发的成员次序）。
  // 没有保存过次序时，这一条恰好退化成"按 id 升序取第一个合格者"= 迁移前的行为。
  //
  // 排序**显式写在函数里**而不是依赖查询的 `orderBy`：那是"选哪一台"这条行为的一部分，
  // 交给调用方的查询去保证，等于让它成为一条隐式契约（替身按别的顺序返回就会静默改掉选择）。
  // 排序（task-43 起）：**有用户次序就按用户次序**（0 起升序），其余候选排在后面并按
  // `node_id` 升序 —— 无次序（`hasIntent === false`）时这一行退化成"全按 node_id 升序"，
  // 也就是迁移前的逐位一致行为（有测试钉住）。
  const first = [...candidates].sort((a, b) => {
    const ra = order.orderRankOf(a.node_id);
    const rb = order.orderRankOf(b.node_id);
    if (ra !== null && rb !== null) return ra - rb;
    if (ra !== null) return -1;
    if (rb !== null) return 1;
    return a.node_id - b.node_id;
  })[0];
  return { candidate_node_id: first?.node_id ?? null, preferred_node_id: preferredId };
}

export interface FailoverSweepOptions {
  /** 只评估这些 tunnel（缺省 = 所有有归属租约的 Forward）。测试与小范围试跑都用它。 */
  readonly tunnelIds?: readonly number[];
  readonly db?: FailoverExecutorDb;
  readonly now?: () => Date;
  readonly log?: (event: { level: "info" | "warn" | "error"; message: string; detail?: unknown }) => void;
  /**
   * 策略来源。缺省读系统配置；注入之后本模块的策略分支可以在**没有数据库**的进程里断言
   * —— "策略没配置 ⇒ 什么都不做"这条 fail-closed 规则值得被钉住，而它恰恰是最不该需要
   * 起一个数据库才能测的规则。
   */
  readonly readPolicy?: typeof readFailoverPolicy;
  /** 只评估这些 tunnel 时用的执行器（测试注入替身）。 */
  readonly execute?: typeof executeFailoverForTunnel;
  /**
   * V5-WP17.4 —— **就绪性前置闸门**（契约 F5 ④）。缺省走生产实现。
   * 不可用 ⇒ **不调用执行器**、记 `dns_path_unready`、epoch 不动。
   */
  readonly dnsGate?: (tunnelId: number) => Promise<{ applicable: boolean; ready: boolean; reason?: string }>;
  /**
   * V5-WP17.4 —— **DNS 后继**（迁移/回切之后写 DNS）。缺省走生产实现。
   * 每拍对每条开启自动解析的转发调用一次；值集没变时它**零外呼**，所以"每拍都看"不产生额外成本。
   */
  readonly dnsSuccessor?: (tunnelId: number) => Promise<{ outcome: string }>;
  /**
   * V5-WP17.1：记录"首选节点这一拍是否合格"。缺省写 `tunnel.failback_healthy_checks`。
   *
   * 做成可注入的钩子而不是往 `FailoverExecutorDb` 上加 `update`：那个接口是**执行器**的
   * 读面，为了一个计数写放大所有替身（本仓有十几处）不成比例；而"连续 N 次"这条规则的
   * 断言恰恰需要能在**不连数据库**的进程里跑。
   */
  readonly recordFailbackCheck?: (tunnelId: number, ready: boolean) => Promise<void>;
}

export interface FailoverSweepResult {
  readonly evaluated: number;
  readonly moved: number;
  readonly held: number;
  readonly results: readonly FailoverExecutionResult[];
  /**
   * 因 DNS 路径不可用而**没有调用执行器**的转发（含原因码）。
   * 它们是**观测事实**，必须能被看见：静默地不迁移与"没有需要迁移的"在日志里长得一样，
   * 而前者的排查成本极高（契约 §7 第 7 条对这一点有明确要求）。
   */
  readonly dns_gated: readonly { readonly tunnel_id: number; readonly reason: string }[];
}

/**
 * 一次扫描：找出候选 Forward，逐个交给执行器。
 *
 * 逐个而不是并发：迁移会改归属并触发 rollout，多个同时迁移会让"冷却"与"端口可用性"这两个
 * 判断基于彼此过期的快照。一次扫描处理一个，下一拍再处理下一个 —— 慢一点，但每个决定都
 * 建立在真实状态上。
 */
export async function runFailoverSweep(options: FailoverSweepOptions = {}): Promise<FailoverSweepResult> {
  const now = options.now ?? (() => new Date());
  const logFn = options.log ?? ((e) => console.log(`[failover] ${e.level} ${e.message}`, e.detail ?? ""));

  const policy = await (options.readPolicy ?? readFailoverPolicy)();
  if (policy.parse_error) {
    logFn({ level: "warn", message: "FAILOVER_POLICY 配置无法解析，按关闭处理", detail: policy.parse_error });
  }
  // 策略关闭时**不扫描**：省掉每拍的读库，也让"没开自动迁移"在日志里是静默的而不是每拍一条 hold。
  if (!policy.auto_failover && !policy.auto_failback) {
    return { evaluated: 0, moved: 0, held: 0, results: [], dns_gated: [] };
  }

  const tunnelIds = options.tunnelIds
    ? [...options.tunnelIds]
    : (
        await db.placementLease.findMany({ select: { tunnel_id: true }, orderBy: { tunnel_id: "asc" } })
      ).map((l) => l.tunnel_id);

  // task-43：**每拍一次**读完整批次序（不是每条隧道一次）。读不到就整批按"无次序"处理，
  // 回退到既有规则 —— 次序是偏好，不该让一次读错误冻结自动迁移。
  const memberDb = options.db ?? (db as unknown as FailoverExecutorDb);
  const intentRows = await (async (): Promise<IngressMemberIntentRow[] | null> => {
    try {
      const rows = (await (memberDb as unknown as {
        forwardIngressMember: {
          findMany: (args: Prisma.ForwardIngressMemberFindManyArgs) => Promise<unknown>;
        };
      }).forwardIngressMember.findMany({
        where: { tunnel_id: { in: tunnelIds } },
        select: { tunnel_id: true, node_id: true, priority: true, is_enabled: true },
        orderBy: [{ priority: "asc" }, { node_id: "asc" }],
      })) as Array<{ tunnel_id: number; node_id: number; priority: number; is_enabled: boolean }>;
      return rows.map((row) => ({ ...row, is_enabled: row.is_enabled === true }));
    } catch {
      return null;
    }
  })();
  const intentByTunnel = new Map<number, IngressMemberIntentRow[]>();
  for (const row of intentRows ?? []) {
    const list = intentByTunnel.get((row as unknown as { tunnel_id: number }).tunnel_id) ?? [];
    list.push(row as IngressMemberIntentRow);
    intentByTunnel.set((row as unknown as { tunnel_id: number }).tunnel_id, list);
  }
  const intentForTunnel = (tunnelId: number): readonly IngressMemberIntentRow[] | null =>
    intentRows === null ? null : (intentByTunnel.get(tunnelId) ?? []);

  const deps: FailoverExecutorDeps = {
    readDecisionFacts: (input) =>
      readFailoverDecisionFacts(input, {
        db: options.db ?? (db as unknown as FailoverExecutorDb),
        policy: () => policy,
        // `now` 在这里是**函数**（扫描级时钟），候选判定要的是**时刻**。
    destinations: (ctx) =>
      pickFailoverDestination({ ...ctx, now: now() }, memberDb as unknown as FailoverCandidateDb, {
        order: intentForTunnel(ctx.tunnel_id),
      }),
    // V5-WP17.1（契约 D4）：回切的"连续健康次数"必须**有一处真的在累计**，否则它恒为 0，
    // `FAILBACK_HEALTHY_CHECKS` 那条条件永远不满足 —— 偏好照样存了，回切照样不会发生。
    failbackHealthyChecks: async (tunnelId) => {
      const row = (await (options.db ?? (db as unknown as FailoverExecutorDb)).tunnel.findUnique({
        where: { id: tunnelId },
        select: { failback_healthy_checks: true },
      })) as { failback_healthy_checks: number } | null;
      return row?.failback_healthy_checks ?? 0;
    },
      }),
    loadLease: async (tunnelId) => (await import("./placement-lease.ts")).loadLease(tunnelId),
    claimLease: async (input) => (await import("./placement-lease.ts")).claimLease(input),
    releaseLease: async (input) => (await import("./placement-lease.ts")).releaseLease(input),
    applyPlacementMove: defaultApplyPlacementMove,
    now,
    log: (event) =>
      logFn({
        level: event.level,
        message: `failover ${event.event}${event.reason ? ` (${event.reason})` : ""}`,
        detail: { tunnel_id: event.tunnel_id, detail: event.detail },
      }),
  };

  const results: FailoverExecutionResult[] = [];
  const dnsGated: Array<{ tunnel_id: number; reason: string }> = [];
  let moved = 0;
  let held = 0;
  const dnsGate = options.dnsGate ?? defaultDnsGate;
  const dnsSuccessor = options.dnsSuccessor ?? defaultDdnsSuccessor;
  for (const tunnelId of tunnelIds) {
    // ── V5-WP17.4 ① 就绪性闸门（**执行器之前**）──
    //
    // 开了自动解析但 DNS 这条路写不通时**不迁移**：迁移让客户端在 TTL 内连旧地址是"短暂中断"，
    // 而"面板显示已切换、DNS 还是旧地址"是看着正常实际全挂。代价不对称 ⇒ 宁可不动（epoch 不动，
    // 契约 F5 ④），并把原因记成可观测的事实（静默地不迁移与"没有需要迁移的"在日志里长得一样）。
    const gate = await dnsGate(tunnelId);
    if (gate.applicable && !gate.ready) {
      const reason = gate.reason ?? "dns_path_unready";
      dnsGated.push({ tunnel_id: tunnelId, reason });
      logFn({
        level: "warn",
        message: "failover gated: DNS 路径不可用，本轮不迁移",
        detail: { tunnel_id: tunnelId, reason },
      });
      continue;
    }

    const result = await (options.execute ?? executeFailoverForTunnel)(tunnelId, deps);
    results.push(result);
    if (result.outcome === "moved") moved += 1;
    if (result.outcome === "hold") held += 1;
    // V5-WP17.1（契约 D4）：维护"首选节点连续健康次数"。
    //
    // 位置有意放在**判定之后**：判定读的是上一拍的值，这一拍的结果写给下一拍看 ——
    // 于是"连续 N 次健康"是真的 N 次观测，而不是同一拍里既判又算（那会让阈值退化成 1）。
    //
    // `null`（没有偏好 / 没读到事实）**什么都不做**：偏好可能刚被设上、或刚被清掉，
    // 这时清零会把运维刚表达完的意图立刻抹掉，而它其实还没被观测过一次。
    if (result.failback_ready !== null) {
      try {
        await (options.recordFailbackCheck ?? defaultRecordFailbackCheck)(result.tunnel_id, result.failback_ready);
      } catch (e) {
        // 计数写失败**不能**让整轮扫描失败：迁移判定本身已经完成，而"计数差一次"比
        // "因为写计数失败而丢掉这一拍的全部结论"轻得多。
        logFn({ level: "warn", message: "failback 健康计数写入失败", detail: (e as Error)?.message ?? String(e) });
      }
    }
    if (result.outcome !== "hold") {
      logFn({ level: "info", message: `failover ${result.outcome}`, detail: result });
    }

    // ── V5-WP17.4 ② DNS 后继（**执行器之后**）──
    //
    // 每拍对每条走过闸门的转发各一次：值集没变时 `syncForwardDns` 的第一层判据让它**零外呼**，
    // 所以"每拍都看"不产生额外成本，换来的是自愈（迁移完成、退避到期、人工改了拓扑都会自然收敛）。
    // "迁移完成时回调一次"不够：rollout 是异步的，而且会失败、会重试。
    try {
      const after = await dnsSuccessor(tunnelId);
      if (after.outcome === "synced") {
        logFn({ level: "info", message: "ddns successor", detail: { tunnel_id: tunnelId } });
      }
    } catch (e) {
      // DNS 后继失败**不**影响迁移判定：迁移已经完成，DNS 有自己的退避与重试节拍。
      logFn({
        level: "warn",
        message: "ddns successor failed",
        detail: { tunnel_id: tunnelId, error: (e as Error)?.message ?? String(e) },
      });
    }
  }
  return { evaluated: tunnelIds.length, moved, held, results, dns_gated: dnsGated };
}

/**
 * 缺省的计数写入：`increment` 是**原子**的 —— 读-改-写会在并发扫描下丢更新，
 * 而丢更新的表现是"回切永远差一次"，从现象几乎反推不出来。
 */
const defaultRecordFailbackCheck = async (tunnelId: number, ready: boolean): Promise<void> => {
  await db.tunnel.update({
    where: { id: tunnelId },
    data: ready ? { failback_healthy_checks: { increment: 1 } } : { failback_healthy_checks: 0 },
  });
};

/**
 * 生产接线：走**既有**的 Forward 变更路径（用户在界面上改入口节点走的就是那条）。
 *
 * 放在这里而不是模块级 import：`forward-service` 在 import 期就需要 DATABASE_URL，
 * 动态解析让本模块（及其安全核心）可以在没有 env 的进程里被 import 与断言。
 */
const defaultApplyPlacementMove: ApplyPlacementMove = async (request: PlacementMoveRequest) => {
  const { patchForward } = await import("./forward-service.ts");
  const patch: Record<string, unknown> = { ingress_node_id: request.toNodeId };
  if (request.expectedConfigRevision !== null) patch.expected_revision = request.expectedConfigRevision;
  const result = await patchForward(request.tunnelId, request.workspaceId, patch);
  if (result.ok) {
    return { ok: true, kind: "dispatched", code: null, message: null, revision: null, apply_status: null };
  }
  // `patchForward` returns a DISCRIMINATED UNION: on failure the error fields are on the
  // result itself (`{ok:false, status, code, message}`), not nested under `.error`.
  const err = result as unknown as { status?: number; code?: string; message?: string };
  // 409（用户同时编辑过）是"被拒绝"而不是"失败"：它意味着乐观并发基线过期，
  // 执行器必须把它当作可重试的拒绝，而不是当成一次崩溃。
  const rejected = err.status === 409;
  return {
    ok: false,
    kind: rejected ? "rejected" : "failed",
    code: err.code ?? null,
    message: err.message ?? "placement move failed",
    revision: null,
    apply_status: null,
  };
};
