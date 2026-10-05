/**
 * DDNS provider execution service.
 *
 * This is the DDNS layer that performs provider network calls. Desired addresses
 * are normalized as a set, provider writes are verified when possible, and
 * failures update DNS synchronization/audit facts without changing Forward
 * ownership or placement state.
 */
import { buildAuditEntry, type AuditEntry, type AuditSink } from "./audit.ts";

/* ================================================================== */
/* 取值                                                                */
/* ================================================================== */

/**
 * 退避阶梯（毫秒）。第 n 次失败后等 `DDNS_BACKOFF_MS[min(n, len-1)]`。
 *
 * 取值理由：DNS 写失败几乎总是三类——对端限流、凭据过期、域名配置错。前两类会在分钟级自愈，
 * 第三类要人来改；阶梯从 5s 起、到 15 分钟封顶，既不在限流时火上浇油，也不会让一个刚修好的
 * 凭据等半小时才被用上。**注意它与 `DDNS_SYNC_DEADLINE_MS`（120s）不是一个东西**：后者是
 * "一次同步的期限"，前者是"两次尝试之间至少隔多久"。
 */
export const DDNS_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000, 900_000] as const;

/** 第 `attempt`（从 1 开始）次失败之后的下一次最早尝试延迟。 */
export function nextAttemptDelayMs(attempt: number): number {
  const index = Math.max(0, Math.min(Math.trunc(attempt) - 1, DDNS_BACKOFF_MS.length - 1));
  return DDNS_BACKOFF_MS[index] ?? DDNS_BACKOFF_MS[DDNS_BACKOFF_MS.length - 1]!;
}

/** 单次 provider 调用的上限（契约 §6：≤10s）。 */
export const DDNS_PROVIDER_TIMEOUT_MS = 10_000;

/* ================================================================== */
/* 值集规划（纯函数）                                                   */
/* ================================================================== */

/** 归一化：去空白、去重、**排序** —— 集合的语义不能在序列上塌掉（见文件头 ②）。 */
export function normalizeDnsValues(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of values) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value !== "") out.add(value);
  }
  return [...out].sort();
}

export interface DdnsValuePlan {
  /** 需要新增的值。 */
  readonly creates: string[];
  /** 需要删除的值。 */
  readonly removals: string[];
  /**
   * 值不变、但记录属性要改的情况（今天只有 TTL）。
   * 与 creates/removals 分开是因为二者的对端操作不同：前者是"值集合改了"，后者是"属性改了"。
   */
  readonly updates: string[];
  /** 有任何要对 provider 说的话吗。false ⇒ **零外呼**。 */
  readonly changed: boolean;
}

/**
 * 期望值集 vs provider 已确认值集 → 要执行的动作。
 *
 * `ttlChanged` 由调用方给出：TTL 不在值集里，所以它不参与集合运算，但它确实需要一次写。
 * 把它做成**入参**而不是让本函数去读配置，是为了让"这次写是因为什么"在类型上就可见 ——
 * 一个只有 TTL 变化的任务不该看起来像"值集变了"。
 */
export function planDdnsValueChanges(
  desired: readonly string[],
  confirmed: readonly string[],
  ttlChanged = false,
): DdnsValuePlan {
  const want = normalizeDnsValues(desired);
  const have = normalizeDnsValues(confirmed);
  const haveSet = new Set(have);
  const wantSet = new Set(want);
  const creates = want.filter((v) => !haveSet.has(v));
  const removals = have.filter((v) => !wantSet.has(v));
  // 值集没变、只是 TTL 变了：此时"更新"针对的是记录本身，取期望值集（空集时无意义）。
  const updates = creates.length === 0 && removals.length === 0 && ttlChanged ? [...want] : [];
  return { creates, removals, updates, changed: creates.length > 0 || removals.length > 0 || updates.length > 0 };
}

/**
 * 期望值集：由**形态**决定（契约 F4）。
 *
 * - `single_active` ⇒ 当前 owner 的 `connect_ip`；
 * - `multi_entry`（首选） ⇒ 当前**可用**入口集合。
 *
 * 可用性由调用方给（WP17.4 用与 failover 同一份候选判定算出来）。`ownerIp` 为空且形态是
 * `single_active` 时返回空集 —— 空集**不是**"写一个空记录集"，调用方必须把它当成
 * "地址不可用 ⇒ 什么都不做"（否则一次缺地址的同步会把整个域名清空）。
 */
export function desiredDnsValuesFor(input: {
  mode: "multi_entry" | "single_active";
  ownerIp?: string | null;
  availableIps?: readonly string[];
}): string[] {
  if (input.mode === "single_active") {
    const owner = (input.ownerIp ?? "").trim();
    return owner === "" ? [] : [owner];
  }
  return normalizeDnsValues(input.availableIps ?? []);
}

/* ================================================================== */
/* provider 适配                                                        */
/* ================================================================== */

export interface DdnsRecordQuery {
  readonly domain: string;
  readonly recordType: string;
  readonly zone?: string;
}

export interface DdnsWriteRequest extends DdnsRecordQuery {
  readonly values: readonly string[];
  readonly ttlSeconds: number;
}

/**
 * provider 客户端。**只描述能力，不描述厂商** —— 厂商差异留在适配器里（`endpoint` 可覆盖，
 * 于是 Gate 可以用一个本地 stub 而**不必新增 provider 类型**，契约 F6 明确要求如此）。
 */
export interface DdnsProviderClient {
  /** 是否支持读回。false ⇒ 结果只能是 `synced_unverified`（禁止假成功）。 */
  readonly supportsReadBack: boolean;
  /** 读当前记录值。返回 `null` = 读不到（网络/权限），**不是**"空记录集"。 */
  readValues(query: DdnsRecordQuery): Promise<string[] | null>;
  writeValues(request: DdnsWriteRequest): Promise<void>;
}

export interface HttpDdnsProviderOptions {
  /** 形如 `https://api.example.test/dns`；去掉尾斜杠。 */
  readonly endpoint: string;
  readonly token: string;
  readonly zone?: string;
  readonly timeoutMs?: number;
  /**
   * 注入 fetch（测试用；生产走全局 fetch）。
   *
   * 类型刻意**窄于** `typeof fetch`：运行时实现（Bun/undici）会往 fetch 上挂
   * `preconnect` 之类的额外属性，用 `typeof fetch` 会让每一个测试替身都必须伪造它们 ——
   * 而这里真正用到的只有"输入 → 响应"这一个函数形状。
   */
  readonly fetchImpl?: DdnsFetch;
}

/** 执行器真正用到的 fetch 形状（见 `HttpDdnsProviderOptions.fetchImpl`）。 */
export type DdnsFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class DdnsProviderError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "DdnsProviderError";
  }
}

/**
 * HTTP 适配器：`GET {endpoint}/records?domain=&type=` → `{values: string[]}`；
 * `POST {endpoint}/records` ← `{domain, type, values, ttl, zone?}`。
 *
 * 这是一个**刻意的窄契约**：它不试图覆盖各家 DNS 厂商的真实 API（那是后续按需增加适配器的
 * 事），而是先把"面板与执行器之间"的边界固定下来，让值集规划、读回、退避这些与厂商无关的
 * 部分能够被真实地测试。
 *
 * **`retryable` 的分级**：网络错误/5xx/429 可重试；4xx（凭据错、域名不存在）→ 不可重试，
 * 因为重试一万次也不会变对，而退避阶梯会让"凭据过期"看起来像是"服务端不稳"。
 */
export function createHttpDdnsProviderClient(options: HttpDdnsProviderOptions): DdnsProviderClient {
  const base = options.endpoint.replace(/\/+$/, "");
  const timeout = options.timeoutMs ?? DDNS_PROVIDER_TIMEOUT_MS;
  const doFetch: DdnsFetch = options.fetchImpl ?? fetch;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${options.token}`,
  };

  async function call(path: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      // 超时与连接失败都是"对端没说不行"，属于可重试。
      throw new DdnsProviderError(`provider 调用失败：${(e as Error)?.message ?? String(e)}`, true);
    }
  }

  return {
    supportsReadBack: true,
    async readValues(query) {
      const params = new URLSearchParams({ domain: query.domain, type: query.recordType });
      const zone = query.zone ?? options.zone;
      if (zone) params.set("zone", zone);
      const res = await call(`/records?${params.toString()}`, { method: "GET" });
      if (res.status === 404) return []; // 记录集不存在 = 空集，与"读不到"不同。
      if (!res.ok) {
        throw new DdnsProviderError(
          `provider 读回失败：HTTP ${res.status}`,
          res.status >= 500 || res.status === 429,
        );
      }
      const body = (await res.json().catch(() => null)) as { values?: unknown } | null;
      if (!body || !Array.isArray(body.values)) {
        throw new DdnsProviderError("provider 读回响应缺少 values[]", false);
      }
      return body.values.filter((v): v is string => typeof v === "string");
    },
    async writeValues(request) {
      const res = await call("/records", {
        method: "POST",
        body: JSON.stringify({
          domain: request.domain,
          type: request.recordType,
          values: [...request.values],
          ttl: request.ttlSeconds,
          ...((request.zone ?? options.zone) ? { zone: request.zone ?? options.zone } : {}),
        }),
      });
      if (!res.ok) {
        throw new DdnsProviderError(
          `provider 写入失败：HTTP ${res.status}`,
          res.status >= 500 || res.status === 429,
        );
      }
    },
  };
}

/* ================================================================== */
/* 同步                                                                */
/* ================================================================== */

/** 一次同步的结论。**逐项都是可判定的**（没有"完成但不确定"这种含糊态）。 */
export const DDNS_SYNC_ACTIONS = [
  /** 未开启自动解析：只回报建议值集，**零外呼**。 */
  "suggested",
  /** 值集没变：**零外呼**（doD 1 要的正是这条）。 */
  "noop",
  /** 上一拍失败、退避未到：什么都不做。 */
  "backoff",
  /** 地址不可用（owner 没有 connect_ip 等）：不写，也不清空。 */
  "unavailable",
  /** 写入成功且读回一致。 */
  "synced",
  /** 写入成功但未能确认（读回不一致 / provider 不支持读回）。 */
  "synced_unverified",
  /** 失败（已记录退避）。 */
  "error",
] as const;
export type DdnsSyncAction = (typeof DDNS_SYNC_ACTIONS)[number];

export interface DdnsSyncResult {
  readonly action: DdnsSyncAction;
  readonly desired: string[];
  readonly confirmed: string[];
  readonly plan: DdnsValuePlan | null;
  readonly error: string | null;
  readonly next_attempt_at: string | null;
}

export interface DdnsSyncDb {
  tunnel: {
    findFirst: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  };
}

export interface DdnsSyncDeps {
  readonly db: DdnsSyncDb;
  /** 由调用方按 provider 行构造（`config` 是封存串）。 */
  readonly clientFor: (input: {
    providerId: number;
    sealedConfig: string;
    recordType: string;
    zone?: string;
  }) => DdnsProviderClient;
  /** 期望值集的来源（WP17.4 用与 failover 同一份候选判定算）。 */
  readonly desiredValues: (input: {
    tunnelId: number;
    mode: "multi_entry" | "single_active";
    ownerNodeId: number | null;
  }) => Promise<{ ok: true; values: string[] } | { ok: false; reason: string }>;
  readonly now?: () => Date;
  readonly auditSink?: AuditSink;
  readonly log?: (event: { level: "info" | "warn" | "error"; message: string; detail?: unknown }) => void;
}

interface BindingRow {
  id: number;
  workspace_id: number | null;
  dns_domain: string | null;
  dns_record_type: string | null;
  dns_mode: string | null;
  dns_provider_id: number | null;
  dns_auto_resolve: boolean | null;
  dns_confirmed_values: unknown;
  dns_synced_at: Date | null;
  dns_verified: boolean | null;
  dns_last_error: string | null;
  dns_attempt_count: number | null;
  dns_next_attempt_at: Date | null;
  ingress_node_id: number | null;
  config_revision: number | null;
}

const TTL_SECONDS = 300;

/**
 * 同步一条转发的 DNS 前门。**唯一的外呼入口**。
 *
 * 顺序即纪律：先读绑定 → 判"要不要写"（开关 + 退避 + 值集差 + 地址可用性）→ 才外呼。
 * 前三项里任何一项为否都**零外呼**，因为每一次外呼都是一次可能被限流、被审计、被误判为
 * "我们想改配置"的动作。
 */
export async function syncForwardDns(
  deps: DdnsSyncDeps,
  input: { tunnelId: number },
): Promise<DdnsSyncResult> {
  const now = deps.now?.() ?? new Date();
  const row = (await deps.db.tunnel.findFirst({
    where: { id: input.tunnelId },
    select: {
      id: true,
      workspace_id: true,
      dns_domain: true,
      dns_record_type: true,
      dns_mode: true,
      dns_provider_id: true,
      dns_auto_resolve: true,
      dns_confirmed_values: true,
      dns_synced_at: true,
      dns_verified: true,
      dns_last_error: true,
      dns_attempt_count: true,
      dns_next_attempt_at: true,
      ingress_node_id: true,
      config_revision: true,
    },
  })) as BindingRow | null;

  const base = (extra: Partial<DdnsSyncResult> & { action: DdnsSyncAction }): DdnsSyncResult => ({
    desired: [],
    confirmed: [],
    plan: null,
    error: null,
    next_attempt_at: null,
    ...extra,
  });

  if (!row || !row.dns_domain || !row.dns_record_type || !row.dns_mode || row.dns_provider_id === null) {
    // 没绑定 ⇒ 不需要同步（不是错误）。
    return base({ action: "noop" });
  }

  const mode = row.dns_mode === "single_active" ? "single_active" : "multi_entry";
  const wanted = await deps.desiredValues({ tunnelId: row.id, mode, ownerNodeId: row.ingress_node_id });
  if (!wanted.ok) {
    // 地址不可用 ⇒ **不写、也不清空**：空值集写下去会把整个域名抹掉。
    await deps.auditSink?.write(
      ddnsAudit(row, { action: "unavailable", detail: wanted.reason, values: [], at: now }),
    );
    return base({ action: "unavailable", error: wanted.reason });
  }

  const desired = normalizeDnsValues(wanted.values);
  const confirmed = normalizeDnsValues(
    Array.isArray(row.dns_confirmed_values) ? (row.dns_confirmed_values as unknown[]).filter((v): v is string => typeof v === "string") : [],
  );

  if (row.dns_auto_resolve !== true) {
    // 契约 F5 ③：缺省 false ⇒ 只回报建议值集，**零外呼**。
    return base({ action: "suggested", desired, confirmed });
  }

  if (desired.length === 0) {
    return base({ action: "unavailable", desired, confirmed, error: "期望值集为空：地址不可用" });
  }

  if (row.dns_next_attempt_at instanceof Date && row.dns_next_attempt_at.getTime() > now.getTime()) {
    return base({
      action: "backoff",
      desired,
      confirmed,
      next_attempt_at: row.dns_next_attempt_at.toISOString(),
    });
  }

  const plan = planDdnsValueChanges(desired, confirmed);
  if (!plan.changed) {
    // 值集没变 ⇒ **零外呼**（DoD 1：停掉一个入口不应产生任何 DNS 写）。
    return base({ action: "noop", desired, confirmed, plan });
  }

  const provider = (await deps.db.tunnel.findFirst({
    where: { id: row.id },
    select: { dns_provider: { select: { id: true, config: true } } },
  })) as { dns_provider?: { id: number; config: unknown } | null } | null;
  const sealed = typeof provider?.dns_provider?.config === "string" ? provider.dns_provider.config : "";
  if (sealed === "") {
    return base({ action: "error", desired, confirmed, plan, error: "provider 凭据不可用（未封存或缺失）" });
  }

  try {
    // 客户端构造**在 try 里面**：解封失败（密钥轮换过、数据被改坏）是"数据不可用"，
    // 必须是可解释的 `error` 结果 + 退避，而不是一个抛到调用方那里的异常 —— 后者会让
    // 扫描日志里出现一次"崩溃"，而真实情况是"这一条凭据需要人来处理"。
    const client = deps.clientFor({
      providerId: row.dns_provider_id,
      sealedConfig: sealed,
      recordType: row.dns_record_type,
    });
    await client.writeValues({ domain: row.dns_domain, recordType: row.dns_record_type, values: desired, ttlSeconds: TTL_SECONDS });

    // ── L1 读回（禁止假成功的落点）──
    let verified = false;
    let readBack: string[] | null = null;
    if (client.supportsReadBack) {
      readBack = await client.readValues({ domain: row.dns_domain, recordType: row.dns_record_type });
      verified = readBack !== null && sameValues(normalizeDnsValues(readBack), desired);
    }

    await deps.db.tunnel.update({
      where: { id: row.id },
      data: {
        // 写成功就记 `synced_at`；`verified` 才是"读回来了"的事实。二者分开，投影才能区分
        // `synced` 与 `synced_unverified`（D2）。
        dns_synced_at: now,
        dns_verified: verified,
        dns_confirmed_values: verified ? desired : confirmed,
        dns_last_error: null,
        dns_attempt_count: 0,
        dns_next_attempt_at: null,
      },
    });

    const action: DdnsSyncAction = verified ? "synced" : "synced_unverified";
    await deps.auditSink?.write(
      ddnsAudit(row, {
        action,
        detail: verified ? null : client.supportsReadBack ? "读回与期望不一致" : "provider 不支持读回",
        values: desired,
        at: now,
      }),
    );
    return base({ action, desired, confirmed: verified ? desired : confirmed, plan });
  } catch (e) {
    const error = e instanceof DdnsProviderError ? e.message : `DNS 写入失败：${(e as Error)?.message ?? String(e)}`;
    const retryable = e instanceof DdnsProviderError ? e.retryable : true;
    const attempt = (row.dns_attempt_count ?? 0) + 1;
    // 不可重试的错误**不排退避**：让它下一拍立刻再试一次没有意义，而挂着 next_attempt_at
    // 会让运维以为"系统在重试"。错误本身留在 dns_last_error 上等人处理。
    const nextAttemptAt = retryable ? new Date(now.getTime() + nextAttemptDelayMs(attempt)) : null;
    await deps.db.tunnel.update({
      where: { id: row.id },
      data: {
        dns_last_error: error.slice(0, 120),
        dns_attempt_count: attempt,
        dns_next_attempt_at: nextAttemptAt,
        // **不**动 epoch / revision / confirmed_values：F7 冻结"失败不改归属、不回退"。
        dns_verified: false,
      },
    });
    deps.log?.({ level: "warn", message: "DDNS 同步失败", detail: { tunnel_id: row.id, error, retryable, attempt } });
    await deps.auditSink?.write(
      ddnsAudit(row, { action: "error", detail: error, values: desired, at: now, extra: { retryable, attempt } }),
    );
    return base({
      action: "error",
      desired,
      confirmed,
      plan,
      error,
      next_attempt_at: nextAttemptAt?.toISOString() ?? null,
    });
  }
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** DNS 事件的审计条目：借用**既有** sink，不新造一套审计事实。 */
function ddnsAudit(
  row: BindingRow,
  input: { action: string; detail: string | null; values: readonly string[]; at: Date; extra?: Record<string, unknown> },
): AuditEntry {
  return buildAuditEntry({
    // 合成一条真实存在的路径：`analyzePath` 因此把资源归属成这条 Forward，
    // 于是 DNS 事件与"谁改了这条转发"落在同一批审计里，而不是另起一页。
    method: "POST",
    path: `/api/forwards/${row.id}/dns`,
    status: input.action === "error" ? 502 : 200,
    user: null,
    ip: null,
    userAgent: null,
    metadata: {
      action: input.action,
      domain: row.dns_domain,
      record_type: row.dns_record_type,
      mode: row.dns_mode,
      values: [...input.values],
      detail: input.detail,
      at: input.at.toISOString(),
      ...(input.extra ?? {}),
    },
  });
}
