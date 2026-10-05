/**
 * DDNS readiness gate and post-migration successor.
 *
 * Automatic DNS reuses the failover/reconciliation cadence. Migration is gated
 * on a usable provider path, and DNS changes are published only after the new
 * Forward revision is applied so clients are never pointed at an unready ingress.
 */
import { createHttpDdnsProviderClient, syncForwardDns, type DdnsProviderClient, type DdnsSyncDeps, type DdnsSyncResult } from "./ddns-executor.ts";
import { isSealedDdnsConfig, openDdnsCredential } from "./ddns-binding.ts";
import { candidateRejection } from "./ingress-candidate.ts";

/** 就绪性判据中“最近一次成功写”的有效期。 */
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

/** 后继的生产实现（薄委托：真正的逻辑在 `runDdnsSuccessor`）。 */
export async function defaultDdnsSuccessor(tunnelId: number): Promise<{ outcome: string }> {
  const { db } = await import("../db.ts");
  const result = await runDdnsSuccessor(productionSuccessorDeps(db as unknown as DdnsSuccessorDeps["db"]), { tunnelId });
  return { outcome: result.outcome };
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
