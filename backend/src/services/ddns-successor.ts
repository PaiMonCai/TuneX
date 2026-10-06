/**
 * DDNS readiness gate and post-migration successor.
 *
 * Automatic DNS participates in the existing failover/reconciliation cadence;
 * it does not create another timer or Agent command path. When automatic DNS is
 * enabled, migration starts only if the provider path is demonstrably usable.
 * After placement changes, DNS is updated only once the new Forward revision is
 * actually applied, preventing clients from being pointed at an unready ingress.
 */
import { createHttpDdnsProviderClient, syncForwardDns, type DdnsProviderClient, type DdnsSyncDeps, type DdnsSyncResult } from "./ddns-executor.ts";
import { isSealedDdnsConfig, openDdnsCredential } from "./ddns-binding.ts";
import { candidateRejection } from "./ingress-candidate.ts";

/** 契约 §6：就绪性判据的"最近一次成功写"有效期。 */
export const DDNS_PROOF_MAX_AGE_MS = 600_000;

export const DDNS_GATE_REASONS = {
  /** DNS 路径不可用：不迁移（epoch 不动）。 */
  dns_path_unready: "dns_path_unready",
  /** provider 行缺失或凭据不是封存形态。 */
  dns_provider_unconfigured: "dns_provider_unconfigured",
  /** 迁移已发出，但新入口还没到 `applied_revision == config_revision`。 */
  dns_waiting_for_rollout: "dns_waiting_for_rollout",
} as const;

export interface DdnsGateRow {
  readonly id: number;
  readonly dns_auto_resolve: boolean | null;
  readonly dns_provider_id: number | null;
  readonly dns_synced_at: Date | null;
  readonly dns_domain: string | null;
  readonly dns_record_type: string | null;
  readonly applied_revision: number | null;
  readonly config_revision: number | null;
}

export interface DdnsGateDeps {
  readonly db: {
    tunnel: { findFirst: (args: unknown) => Promise<unknown> };
  };
  /** provider 是否是"配置完整"的（行存在 + 凭据已封存）。 */
  readonly providerConfigured: (providerId: number) => Promise<boolean>;
  /** 只读探测：provider 侧能否读回。抛错/返回 false 都算不可用。 */
  /**
   * 只读探测。带上域名/类型是因为"这条路通不通"要问的是**这条记录**能不能读回来，
   * 而不是"这个 provider 对象存不存在"。
   */
  readonly probeProvider?: (providerId: number, query: { domain: string; recordType: string }) => Promise<boolean>;
  readonly now?: () => Date;
}

export type DdnsPathReadiness =
  | { readonly applicable: false; readonly ready: true }
  | { readonly applicable: true; readonly ready: true; readonly proof: "fresh_sync" | "probe" }
  | {
      readonly applicable: true;
      readonly ready: false;
      readonly reason: (typeof DDNS_GATE_REASONS)["dns_path_unready"] | (typeof DDNS_GATE_REASONS)["dns_provider_unconfigured"];
    };

/**
 * DNS 路径是否就绪。**只有显式开了 `dns_auto_resolve` 才参与判定** —— 没开的转发不该被
 * DNS 的事实拖住（那会把一个可选功能变成全局迁移的前置条件）。
 *
 * 判据（F5 ④）：provider 配置完整 **且**（最近一次成功写在 `DDNS_PROOF_MAX_AGE_MS` 内
 * **或** 只读探测成功）。用"最近成功写的凭证"而不是"provider 对象存在"，是因为前者是**证据**、
 * 后者只是**配置**：一个刚配好但从来没写通过的 provider 不该让迁移开始。
 */
export async function dnsPathReadiness(
  deps: DdnsGateDeps,
  input: { tunnelId: number },
): Promise<DdnsPathReadiness> {
  const now = deps.now?.() ?? new Date();
  const row = (await deps.db.tunnel.findFirst({
    where: { id: input.tunnelId },
    select: {
      id: true,
      dns_auto_resolve: true,
      dns_provider_id: true,
      dns_synced_at: true,
      dns_domain: true,
      dns_record_type: true,
      applied_revision: true,
      config_revision: true,
    },
  })) as DdnsGateRow | null;

  if (!row || row.dns_auto_resolve !== true) return { applicable: false, ready: true };
  if (row.dns_provider_id === null) {
    return { applicable: true, ready: false, reason: DDNS_GATE_REASONS.dns_provider_unconfigured };
  }
  if (!(await deps.providerConfigured(row.dns_provider_id))) {
    return { applicable: true, ready: false, reason: DDNS_GATE_REASONS.dns_provider_unconfigured };
  }
  if (row.dns_synced_at instanceof Date && now.getTime() - row.dns_synced_at.getTime() <= DDNS_PROOF_MAX_AGE_MS) {
    return { applicable: true, ready: true, proof: "fresh_sync" };
  }
  // 没有新鲜的成功写 ⇒ 只读探测。**探测本身也要有失败路径**：一个会抛错的 provider
  // 不该让扫描崩掉，而应该被当成"路径不可用"。
  if (deps.probeProvider && row.dns_domain && row.dns_record_type) {
    try {
      if (await deps.probeProvider(row.dns_provider_id, { domain: row.dns_domain, recordType: row.dns_record_type })) {
        return { applicable: true, ready: true, proof: "probe" };
      }
    } catch {
      // 落到下面的 unready。
    }
  }
  return { applicable: true, ready: false, reason: DDNS_GATE_REASONS.dns_path_unready };
}

export interface DdnsSuccessorDeps extends DdnsSyncDeps {
  readonly db: DdnsSyncDeps["db"] & {
    tunnel: {
      findFirst: (args: unknown) => Promise<unknown>;
      update: (args: unknown) => Promise<unknown>;
    };
  };
}

export type DdnsSuccessorOutcome =
  /** 没开自动解析 / 没绑定 ⇒ 不做任何事（零外呼）。 */
  | { readonly outcome: "not_applicable" }
  /** 迁移已发出但新入口还没 applied ⇒ 这一拍不做，**下一拍再看**。 */
  | { readonly outcome: "waiting_for_rollout"; readonly applied_revision: number | null; readonly config_revision: number | null }
  | { readonly outcome: "synced"; readonly sync: DdnsSyncResult };

/**
 * DNS 后继：把期望值集落到 provider 上。**前置条件是"迁移真的到了"**。
 *
 * 为什么后继要由扫描每拍调用而不是"迁移完成时回调一次"：rollout 是异步的，而且会失败、会重试；
 * 一次回调只有在"它一定会成功且一定会通知我们"时才成立。每拍检查是**幂等且自愈**的 ——
 * 值集没变时它零外呼（`syncForwardDns` 的第一层判据），所以"每拍都看"不产生任何额外成本。
 */
export async function runDdnsSuccessor(
  deps: DdnsSuccessorDeps,
  input: { tunnelId: number },
): Promise<DdnsSuccessorOutcome> {
  const row = (await deps.db.tunnel.findFirst({
    where: { id: input.tunnelId },
    select: {
      id: true,
      dns_auto_resolve: true,
      dns_provider_id: true,
      applied_revision: true,
      config_revision: true,
    },
  })) as DdnsGateRow | null;

  if (!row || row.dns_auto_resolve !== true || row.dns_provider_id === null) {
    return { outcome: "not_applicable" };
  }
  if (row.applied_revision !== row.config_revision) {
    // 先写再搬 = 把客户端指向还没监听的机器；所以要等它真的到达。
    return {
      outcome: "waiting_for_rollout",
      applied_revision: row.applied_revision,
      config_revision: row.config_revision,
    };
  }
  return { outcome: "synced", sync: await syncForwardDns(deps, { tunnelId: input.tunnelId }) };
}

/* ================================================================== */
/* 独立同步节拍（不经过 failover 策略）                                  */
/* ================================================================== */

/** 候选集合的读面：只要能从库里列出"开了自动同步的转发"。 */
export interface DdnsSyncSweepDb {
  readonly tunnel: { findMany: (args: unknown) => Promise<unknown[]> };
}

export interface DdnsSyncSweepOptions {
  /** 只同步这些 tunnel（测试与小范围试跑用）。缺省 = 库里所有候选。 */
  readonly tunnelIds?: readonly number[];
  readonly db?: DdnsSyncSweepDb;
  /** 单条转发的同步动作。缺省 = 生产后继 `defaultDdnsSuccessor`。 */
  readonly sync?: (tunnelId: number) => Promise<{ outcome: string; action?: string }>;
  readonly log?: (event: { level: "info" | "warn" | "error"; message: string; detail?: unknown }) => void;
}

export interface DdnsSyncSweepResult {
  readonly evaluated: number;
  /** 真的写了、并且读回确认（`synced`）。 */
  readonly synced: number;
  /** 写成功但**没读回**（provider 不支持读回，或读回与期望不一致）—— 禁止显示成"已确认"。 */
  readonly unverified: number;
  /** 没有要写的东西：值集未变 / 退避窗口内 / 未开自动解析。**零外呼**。 */
  readonly noop: number;
  /** 迁移已发出但新入口还没 `applied` ⇒ 这一拍不写，下一拍再看。 */
  readonly waiting: number;
  /** 没绑定/没开自动解析（后继报 not_applicable）。 */
  readonly not_applicable: number;
  /** 执行器报出的失败（已按退避排下一次），例如 provider 写入失败、地址不可用。 */
  readonly failed: number;
  /** 后继本身**抛出**的异常（一条坏数据不能拖垮整轮扫描）。 */
  readonly errors: number;
  readonly outcomes: readonly { readonly tunnel_id: number; readonly outcome: string; readonly action?: string }[];
}

/**
 * 一次 DDNS 同步扫描：**为纯 DNS 能力提供自己的节拍**。
 *
 * ── 为什么必须与 failover 策略解耦 ──
 *
 * 写入路径以前只挂在 failover 扫描的末尾，而那个扫描在 `auto_failover`/`auto_failback`
 * **都关**时整轮直接返回（`failover-loop.ts` 的 fail-closed 首行），而这两个开关的缺省值
 * 就是关（§8：自动迁移必须是显式 policy，那是对的）。于是"绑定域名 + 开自动同步"这个
 * **纯 DNS** 的产品能力，被一个与它无关的安全闸门顺带关掉了：默认部署下永远不写。
 *
 * 这条节拍**不读、也不改** failover 策略（它连那个模块都不 import）：只遍历"开了自动
 * 同步且绑定了 provider"的转发，调用与"迁移之后"**同一个** `runDdnsSuccessor`。
 * "该不该写"的判据仍然只有一处 —— 执行器自己的（`auto_resolve` / 期望值集 / 退避 /
 * 值集差）。这里不新增任何第二套判定，也不引入第二个"DNS 已切换"的定义。
 *
 * ── 与 failover 的后继调用重复吗 ──
 *
 * 会重复**检查**，不会重复**写**：`syncForwardDns` 在值集未变时零外呼，所以策略打开时
 * 两条路径各看一眼是免费的。并发下也安全，理由有三条（都不需要新机制）：
 *   1. BullMQ worker 默认 concurrency = 1 ⇒ 同一个进程里两条节拍**串行**，不会同时进入；
 *   2. 就算多副本并发，两边算出的期望值集是**同一个**（同一份 `desiredValues`），重复写
 *      的内容相同 ⇒ 值集收敛到同一个结果，不会抖动；
 *   3. 唯一的代价是"多一次外呼"，而不会出现两个不同的值集 —— 权威事实
 *      （`dns_confirmed_values` / `dns_verified` / `dns_synced_at`）仍然只有
 *      `syncForwardDns` 一处写。下一拍也会按读回结果自愈。
 *
 * 逐条而不是并发：与 failover 扫描同一条纪律 —— 一次外呼的延迟不该被放大成一批同时写。
 */
export async function runDdnsSyncSweep(options: DdnsSyncSweepOptions = {}): Promise<DdnsSyncSweepResult> {
  const logFn = options.log ?? ((e) => console.log(`[ddns] ${e.level} ${e.message}`, e.detail ?? ""));
  const sync = options.sync ?? defaultDdnsSuccessor;

  let tunnelIds: number[];
  if (options.tunnelIds) {
    tunnelIds = [...options.tunnelIds];
  } else {
    // 延迟 import `db`：本模块的安全核心要能在没有 DATABASE_URL 的进程里被 import。
    const database = options.db ?? ((await import("../db.ts")).db as unknown as DdnsSyncSweepDb);
    const rows = (await database.tunnel.findMany({
      where: { dns_auto_resolve: true, dns_provider_id: { not: null } },
      select: { id: true },
      orderBy: { id: "asc" },
    })) as Array<{ id: number }>;
    tunnelIds = rows.map((row) => row.id);
  }

  const outcomes: Array<{ tunnel_id: number; outcome: string; action?: string }> = [];
  let synced = 0;
  let unverified = 0;
  let noop = 0;
  let waiting = 0;
  let notApplicable = 0;
  let failed = 0;
  let errors = 0;

  for (const tunnelId of tunnelIds) {
    try {
      const result = await sync(tunnelId);
      outcomes.push({ tunnel_id: tunnelId, outcome: result.outcome, ...(result.action ? { action: result.action } : {}) });
      if (result.outcome === "synced") {
        // `outcome === "synced"` 只说明"后继跑完了"，**真正写没写**在执行器的 action 里：
        // noop/suggested/backoff 都是"什么都没写"，把它们计成 synced 会让日志撒谎。
        const action = result.action ?? "synced";
        if (action === "synced") synced += 1;
        else if (action === "synced_unverified") unverified += 1;
        else if (action === "error" || action === "unavailable") failed += 1;
        else noop += 1;
        logFn({ level: "info", message: "ddns sync", detail: { tunnel_id: tunnelId, action } });
      } else if (result.outcome === "waiting_for_rollout") {
        waiting += 1;
      } else {
        notApplicable += 1;
      }
    } catch (e) {
      // 一条转发的失败**不能**拖垮整轮扫描：DNS 有自己的退避与重试节拍，而"因为第 3 条
      // 抛错就再也不看第 4 条"会让故障扩散成静默的全量停摆（与 failover 循环同一条纪律）。
      errors += 1;
      // 抛错的那一条也要出现在 outcomes 里：否则"扫描了几条、哪条坏了"只能靠日志猜。
      outcomes.push({ tunnel_id: tunnelId, outcome: "error" });
      logFn({
        level: "warn",
        message: "ddns sync failed",
        detail: { tunnel_id: tunnelId, error: (e as Error)?.message ?? String(e) },
      });
    }
  }

  return { evaluated: tunnelIds.length, synced, unverified, noop, waiting, not_applicable: notApplicable, failed, errors, outcomes };
}

/* ================================================================== */
/* 生产接线                                                            */
/* ================================================================== */

/**
 * 闸门的生产实现。**延迟 import** `db`：`failover-loop` 的安全核心要能在没有
 * `DATABASE_URL` 的进程里被 import 与断言（那个模块自己的注释就是这么要求的）。
 */
export async function defaultDnsGate(tunnelId: number): Promise<DdnsPathReadiness> {
  // 只有 `db` 需要延迟 import（它会在 import 期读 env）；其余两个是纯模块。
  const { db } = await import("../db.ts");
  const secrets = process.env.AUTH_SECRET ?? "";

  return dnsPathReadiness(
    {
      db: db as unknown as DdnsGateDeps["db"],
      providerConfigured: async (providerId) => {
        const provider = (await (db as unknown as {
          dNSProvider: { findUnique: (a: unknown) => Promise<unknown> };
        }).dNSProvider.findUnique({ where: { id: providerId }, select: { config: true } })) as { config?: unknown } | null;
        return isSealedDdnsConfig(provider?.config);
      },
      probeProvider: async (providerId, query) => {
        const provider = (await (db as unknown as {
          dNSProvider: { findUnique: (a: unknown) => Promise<unknown> };
        }).dNSProvider.findUnique({ where: { id: providerId }, select: { config: true } })) as { config?: unknown } | null;
        const sealed = typeof provider?.config === "string" ? provider.config : "";
        if (sealed === "") return false;
        const credential = openDdnsCredential(sealed, secrets);
        if (!credential.endpoint) {
          // 没有可覆盖的 endpoint ⇒ 没有可探测的地址。**这不算 ready**：判定"路径可用"
          // 必须有证据，而一个连地址都说不出的 provider 给不出证据。
          return false;
        }
        const client = createHttpDdnsProviderClient({
          endpoint: credential.endpoint,
          token: credential.token,
          ...(credential.zone ? { zone: credential.zone } : {}),
        });
        return (await client.readValues(query)) !== null;
      },
    },
    { tunnelId },
  );
}

/**
 * 把后继结果拍平成同步扫描要的 `{ outcome, action }`。
 *
 * 返回的 `action`（`synced` vs `synced_unverified` vs `noop`/`backoff`/`error`…）是必要的：
 * `outcome` 只说明"后继跑完了"，而"到底写没写、读回来没有"在 action 里 —— 只有 outcome
 * 会把"写了但没读回"和"确认过"显示成同一件事，也会把 noop 算成一次写。
 *
 * 生产与测试**共用这一处**，避免"测试里的拍平逻辑"和"生产里的"各写一遍然后慢慢分叉。
 */
export function successorSummary(result: DdnsSuccessorOutcome): { outcome: string; action?: string } {
  return { outcome: result.outcome, ...(result.outcome === "synced" ? { action: result.sync.action } : {}) };
}

/** 后继的生产实现（薄委托：真正的逻辑在 `runDdnsSuccessor`）。 */
export async function defaultDdnsSuccessor(tunnelId: number): Promise<{ outcome: string; action?: string }> {
  const { db } = await import("../db.ts");
  return successorSummary(await runDdnsSuccessor(productionSuccessorDeps(db as unknown as DdnsSuccessorDeps["db"]), { tunnelId }));
}

/**
 * 后继的生产依赖。
 *
 * `desiredValues` **复用 WP17.1 那份候选判定**（`candidateRejection`）来算"哪些入口合格"：
 * DNS 值集与故障转移候选必须是**同一批机器**，否则会出现"迁移把归属搬到 A，而 DNS 里写的是
 * B"——两个各自都"算对了"的判定给出的不同答案，是最难查的一类。
 */
export function productionSuccessorDeps(db: DdnsSuccessorDeps["db"]): DdnsSuccessorDeps {
  const secrets = process.env.AUTH_SECRET ?? "";
  return {
    db,
    // **必须同步**：执行器在 try 里同步构造客户端（见它与 `DdnsSyncDeps.clientFor` 的注释），
    // 而"解封失败"要以异常形式被那次 try 接住，走它自己的 error + 退避路径。
    clientFor: ({ sealedConfig }) => {
      const credential = openDdnsCredential(sealedConfig, secrets);
      if (!credential.endpoint) {
        // 没有地址就写不出去。抛错让 `syncForwardDns` 走它自己的 error + 退避路径，
        // 而不是在这里悄悄用一个默认地址。
        throw new Error("ddns: provider 凭据里没有 endpoint，无法写入");
      }
      return createHttpDdnsProviderClient({
        endpoint: credential.endpoint,
        token: credential.token,
        ...(credential.zone ? { zone: credential.zone } : {}),
      });
    },
    desiredValues: async ({ tunnelId, mode, ownerNodeId }) => {
      // ── 值集只能包含**真的在服务这条转发**的地址 ──────────────────────────────
      //
      // 这条规则压过一切：`Tunnel.ingress_node_id` 是**单一 owner**，今天没有任何
      // "一条转发由多个入口同时服务"的机制。所以按"入口组里合格的节点"去凑多值记录集，
      // 会**把不服务这条转发的机器写进 A 记录** —— 那不是"多入口"，那是把大约一半客户端
      // 送进黑洞（比少写一条记录坏得多：前者静默地坏，后者至少连不上会重试）。
      //
      // 于是今天两种形态算出的是**同一个值集**（owner 的 `connect_ip`）：多值机器是现成的
      // （值集本来就是数组、写的是整集合），但它**只有在一个真的多节点服务能力落地之后**
      // 才可能有第二个元素 —— 那是另一个 WP，不是 DNS 这一片。
      void tunnelId;
      void mode;
      if (ownerNodeId === null) return { ok: false as const, reason: "owner 未知" };
      const node = (await (db as unknown as {
        node: { findUnique: (a: unknown) => Promise<unknown> };
      }).node.findUnique({ where: { id: ownerNodeId }, select: { connect_ip: true } })) as { connect_ip?: string | null } | null;
      const ip = node?.connect_ip?.trim() ?? "";
      return ip === "" ? { ok: false as const, reason: "owner 没有 connect_ip" } : { ok: true as const, values: [ip] };
    },
  };
}
