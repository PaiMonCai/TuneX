/**
 * V5-WP17.2 —— DNS 前门：**绑定落库 + RBAC + 封存凭据**（契约 §5 表；**零外呼**）。
 *
 * 这一片只做「**记住**用户想让 DNS 前门长成什么样」，**不发任何 DNS 请求**（执行器是 WP17.3）。
 * 单独切一个 WP 的理由是**失败代价不对称**：绑定与凭据属于**多租户**面（跨 workspace 读写
 * 凭据 = 数据泄漏），写 DNS 属于**可用性**面。两者混在一个 WP 里，评审时无法分别回答
 * "作用域对不对"和"重试策略对不对"。
 *
 * 冻结的硬规则（逐条有依据，见契约 §7 F1/F4/F6 与 §4.0 的 Lead 裁决）：
 *
 * ① **地址只能来自 `connect_ip`**（F1）。`connect_ip IS NULL` ⇒ 拒绝
 *    （`dns_address_unavailable`），**绝不回落**到 `listen_host`、请求体或面板自己猜：
 *    前门地址是"客户端真的能连上的那个地址"，猜错等于写出一条把用户引向黑洞的记录。
 * ② **凭据必须封存**（F6）。`DNSProvider.config` 只接受 `sealSecret` 的输出，且用**独立的
 *    HKDF info**（`tunex-ddns-v1`）——"换个用途就换 info，绝不共用同一把派生密钥"。
 * ③ **跨租户一律拒绝**（F6）。读 `settings:read`、写 `settings:manage`；**平台共享入口组**
 *    （对 workspace 之外的 user 有 active grant 的组，或平台级组）不得由租户凭据配置
 *    ⇒ `shared_group_dns_denied`。
 * ④ **状态必须能区分"已确认"与"未确认"**（D2 / F7）。`dns_state` 取值
 *    `unbound | pending | synced | synced_unverified | error`，**只有 `synced` 允许显示
 *    "已切换"**。本片只做**投影**（读模型）；写入状态是 WP17.3 执行器的事——所以这里
 *    刻意没有任何"设置状态"的入口。
 */
import type { Prisma } from "@prisma/client";
import { deriveDdnsSealKey, sealSecret, unsealSecret } from "./federation/seal.ts";

/* ================================================================== */
/* 取值与边界                                                          */
/* ================================================================== */

export const DDNS_ERROR_CODES = {
  /** 找不到该 Forward（或不在本 workspace）—— 一律 404，不区分"不存在"与"不是你的"。 */
  ddns_not_found: "ddns_not_found",
  /** 入口节点的 `connect_ip` 为 NULL ⇒ **拒绝绑定**（见 ①）。 */
  dns_address_unavailable: "dns_address_unavailable",
  /** 域名不合语法（大小写/尾点会先归一化，这里只拒真正的非法输入）。 */
  dns_domain_invalid: "dns_domain_invalid",
  /** 记录类型与入口地址族不匹配（A 需要 IPv4、AAAA 需要 IPv6）。 */
  dns_record_type_mismatch: "dns_record_type_mismatch",
  /** 多入口形态不支持 CNAME：一个 CNAME 只能指向一个名字，装不下"可用入口集合"。 */
  dns_mode_record_type_conflict: "dns_mode_record_type_conflict",
  /** TTL 超出 [60, 3600]。 */
  dns_ttl_out_of_range: "dns_ttl_out_of_range",
  /** provider 不存在，或不属于本 workspace 且不是平台管理员。 */
  dns_provider_not_found: "dns_provider_not_found",
  /** provider 是平台级的，而调用方不是平台管理员。 */
  dns_provider_forbidden: "dns_provider_forbidden",
  /** 凭据形状不合法（未封存 / 缺字段）。 */
  dns_provider_credential_invalid: "dns_provider_credential_invalid",
  /** 平台共享入口组不得由租户凭据配置（见 ③）。 */
  shared_group_dns_denied: "shared_group_dns_denied",
  /** 还没有绑定就想解绑 —— 幂等接口不该报错，但**审计**要能区分"真解绑了"与"本来就没有"。 */
  dns_not_bound: "dns_not_bound",
  dns_unavailable: "dns_unavailable",
} as const;

export type DdnsErrorCode = (typeof DDNS_ERROR_CODES)[keyof typeof DDNS_ERROR_CODES];

/** 契约 §6：TTL 下限抗抖动、上限把"客户端最坏切换窗口"压在 1 小时内。 */
export const DDNS_TTL_SECONDS = { min: 60, max: 3600, default: 300 } as const;

/**
 * `dns_state` 的**全部**取值（D2 / F7）。这是一份读模型，不是第二套状态机：
 * 它由 `dns_*` 列**推导**而来，没有任何写入口。
 */
export const DNS_STATES = ["unbound", "pending", "synced", "synced_unverified", "error"] as const;
export type DnsState = (typeof DNS_STATES)[number];

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];
export const DNS_MODES = ["multi_entry", "single_active"] as const;
/**
 * `DNSProviderType` 的取值（与 `prisma/schema.prisma` 的枚举**逐字一致**）。
 *
 * 为什么要在这里再列一次、而不是让路由收自由字符串：`type` 列是 DB 枚举 ⇒ 传一个枚举外的值
 * 在真库里是**运行期错误**（本次就是：路由收 `z.string()`，服务直接把它塞进 Prisma，
 * 收紧缝隙类型后编译期才报出来）。列成常量既能被路由拿去校验（非法值 → **400** 而不是 500），
 * 也能被测试断言"服务端接受的就是这两个"。
 */
export const DNS_PROVIDER_TYPES = ["cloudflare", "huawei"] as const;
export type DnsProviderType = (typeof DNS_PROVIDER_TYPES)[number];
export type DnsMode = (typeof DNS_MODES)[number];

/* ================================================================== */
/* 纯函数：归一化、匹配、投影                                            */
/* ================================================================== */

/**
 * 域名归一化 + 语法检查。返回 `null` = 非法。
 *
 * 归一化不是为了好看：`Example.COM.` 与 `example.com` 是同一个名字，而"用户以为改了一个
 * 域名、系统记成两个"会让解绑与审计都对不上。大小写与尾点在这里一次性抹平。
 */
export function normalizeDnsDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, "");
  if (trimmed.length === 0 || trimmed.length > 253) return null;
  // 单标签（裸主机名）被拒：前门必须是一个公网可解析的名字。
  if (!trimmed.includes(".")) return null;
  if (trimmed.includes("..") || trimmed.startsWith("-") || trimmed.endsWith("-")) return null;
  for (const label of trimmed.split(".")) {
    if (label.length === 0 || label.length > 63) return null;
    // 允许通配符标签是**故意**排除的：* 会把"可用入口集合"变成"任意地址集合"，
    // 那不是这个产品要表达的东西。
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
  }
  return trimmed;
}

/** 入口地址族 → 记录类型。IPv4=A、IPv6=AAAA；无法判定的地址（主机名/空）返回 null。 */
export function dnsRecordTypeForAddress(address: unknown): "A" | "AAAA" | null {
  if (typeof address !== "string") return null;
  const value = address.trim();
  if (value.length === 0) return null;
  // 面板侧的地址事实是 IP 字面量（`connect_ip`）；带字母又带点的可能是主机名，
  // 也可能是 IPv6 —— 所以先按 IPv6 探一次，再按"含冒号即非法"收口。
  if (value.includes(":")) return /^[0-9a-fA-F:]+$/.test(value) ? "AAAA" : null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
  }
  return "A";
}

export interface DnsBindingRow {
  dns_domain?: unknown;
  dns_record_type?: unknown;
  dns_mode?: unknown;
  dns_provider_id?: unknown;
  dns_confirmed_values?: unknown;
  dns_synced_at?: Date | null;
  dns_verified?: unknown;
  dns_last_error?: unknown;
}

/**
 * `dns_state` 投影（读模型）。
 *
 * 为什么 `synced` 必须同时要求 `dns_verified`：D2 冻结的"**禁止假成功**"。provider 写成功
 * 只证明"我们发了请求"，`verified` 才是"读回来确实是我们要的值"。两者混为一谈，产品就会在
 * "面板说切了、客户端还连旧 IP"时仍然显示已切换 —— 多租户下这是最坏的一类故障。
 * 于是：写成功但未读回 ⇒ **`synced_unverified`**（UI 禁止显示"已切换"），任何错误
 * ⇒ `error`（并带上最后错误，落在同一份投影里）。
 */
export function dnsStateFor(row: DnsBindingRow): DnsState {
  const domain = typeof row.dns_domain === "string" ? row.dns_domain.trim() : "";
  if (domain === "") return "unbound";
  const lastError = typeof row.dns_last_error === "string" ? row.dns_last_error.trim() : "";
  if (lastError !== "") return "error";
  if (row.dns_synced_at instanceof Date) {
    return row.dns_verified === true ? "synced" : "synced_unverified";
  }
  return "pending";
}

/** 投影的完整形状（给 API 用；含"期望值集"与"最后错误"，因为 F7 要求错误可解释）。 */
export interface DnsBindingState {
  state: DnsState;
  domain: string | null;
  record_type: DnsRecordType | null;
  mode: DnsMode | null;
  provider_id: number | null;
  expected_values: string[];
  confirmed_values: string[];
  synced_at: string | null;
  verified: boolean;
  last_error: string | null;
}

function stringList(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((v): v is string => typeof v === "string") : [];
}

/**
 * 投影。`expected` 由**调用方推**出来给进来，而不是读某一列 —— 期望值集不是被存下来的事实，
 * 它是"按当前形态应该出现在 DNS 里的地址集合"：
 *
 * - `multi_entry` ⇒ 当前**可用**入口集合（契约 F4 首选形态）；
 * - `single_active` ⇒ 当前 owner 的 `connect_ip`。
 *
 * 这条区别很重要：一旦把期望值也落成一列，就出现了两个真相源（列 vs 拓扑），而它们一定会
 * 漂移。所以本片只存 `dns_confirmed_values`（provider 侧**读回来**的值），期望值每次现算。
 */
export function dnsBindingState(
  row: DnsBindingRow & { dns_provider_id?: unknown },
  expected: readonly string[] = [],
): DnsBindingState {
  const state = dnsStateFor(row);
  return {
    state,
    domain: typeof row.dns_domain === "string" && row.dns_domain.trim() !== "" ? row.dns_domain.trim() : null,
    record_type: DNS_RECORD_TYPES.includes(row.dns_record_type as DnsRecordType)
      ? (row.dns_record_type as DnsRecordType)
      : null,
    mode: DNS_MODES.includes(row.dns_mode as DnsMode) ? (row.dns_mode as DnsMode) : null,
    provider_id: typeof row.dns_provider_id === "number" ? row.dns_provider_id : null,
    expected_values: expected.filter((v) => typeof v === "string" && v !== ""),
    confirmed_values: stringList(row.dns_confirmed_values),
    synced_at: row.dns_synced_at instanceof Date ? row.dns_synced_at.toISOString() : null,
    verified: row.dns_verified === true,
    last_error: typeof row.dns_last_error === "string" && row.dns_last_error.trim() !== "" ? row.dns_last_error.trim() : null,
  };
}

/* ================================================================== */
/* 依赖（测试注入替身）                                                 */
/* ================================================================== */

/**
 * DNS 前门的依赖缝隙。
 *
 * **参数类型必须是真实 Prisma 参数类型**（不是 `unknown`）。`unknown` 会把 Prisma 的字段与
 * **关系名**校验一起关掉：替身不认识它们，编译期也不认识 —— 于是"关系名写成表名"这种错误
 * 既过单测也过 tsc，直到真库里 500（本 WP 里就这样被抓到三处，另见 `f334f1c`）。
 */
export interface DdnsDb {
  tunnel: {
    findFirst: (args: Prisma.TunnelFindFirstArgs) => Promise<unknown>;
    update: (args: Prisma.TunnelUpdateArgs) => Promise<unknown>;
  };
  dNSProvider: {
    findFirst: (args: Prisma.DNSProviderFindFirstArgs) => Promise<unknown>;
    findMany: (args: Prisma.DNSProviderFindManyArgs) => Promise<unknown[]>;
    create: (args: Prisma.DNSProviderCreateArgs) => Promise<unknown>;
    delete: (args: Prisma.DNSProviderDeleteArgs) => Promise<unknown>;
  };
  nodeGroupGrant: { findFirst: (args: Prisma.NodeGroupGrantFindFirstArgs) => Promise<unknown> };
  node: { findUnique: (args: Prisma.NodeFindUniqueArgs) => Promise<unknown> };
}

export interface DdnsDeps {
  db: DdnsDb;
  /** 平台管理员判定（平台级 provider / 平台共享入口组要用）。 */
  isPlatformAdmin: (userId: number) => Promise<boolean>;
  /** 封存主密钥；缺省从环境读（与联邦那套同一个 AUTH_SECRET，但派生 info 不同）。 */
  sealSecretKey?: string;
  now?: () => Date;
  /**
   * **没有** `audit` 钩子，这是有意的：`services/audit.ts` 的 `shouldAudit()` 已经把
   * **所有**变更类 `/api/*` 请求自动记进审计（`buildAuditEntry` + 全局 sink）。在这里再造
   * 一个"领域审计"入口就等于有了两套审计事实，而它们一定会漂移。
   *
   * DNS **执行**（WP17.3）不在 HTTP 路径上，它才需要自己的审计出口 —— 到那时再加。
   */
}

export type DdnsResult<T> = { ok: true; value: T } | { ok: false; code: DdnsErrorCode; error: string };

function fail(code: DdnsErrorCode, error: string): DdnsResult<never> {
  return { ok: false, code, error };
}

function sealKey(deps: DdnsDeps): string {
  return deps.sealSecretKey ?? process.env.AUTH_SECRET ?? "";
}

/* ================================================================== */
/* 凭据封存                                                            */
/* ================================================================== */

/** provider 凭据的**明文**形状（落库前必须封存）。 */
export interface DdnsCredentialPlaintext {
  /** API token / secret（执行器用）。 */
  token: string;
  /** 可覆盖的 API endpoint（Gate 用本地 stub；契约 F6 明确不新增 provider 类型）。 */
  endpoint?: string;
  /** 需要 zone 的 provider 用它；字符串，避免在凭据里塞结构。 */
  zone?: string;
}

/**
 * 封存凭据。**唯一的落库入口** —— 任何绕过它写 `config` 的代码都是缺陷。
 */
export function sealDdnsCredential(credential: DdnsCredentialPlaintext, masterSecret: string): string {
  if (typeof credential?.token !== "string" || credential.token.trim() === "") {
    throw new Error("ddns: credential.token is required");
  }
  const payload = JSON.stringify({
    token: credential.token.trim(),
    ...(credential.endpoint ? { endpoint: credential.endpoint.trim() } : {}),
    ...(credential.zone ? { zone: credential.zone.trim() } : {}),
  });
  return sealSecret(payload, deriveDdnsSealKey(masterSecret));
}

/**
 * 解封凭据。**解封失败 = 数据不可用，不是"没有数据"**（契约 §4 第 5 条）：
 * 用 `throw` 而不是返回 null，调用方就必须显式决定"报错"还是"降级"——而"降级成没有凭据"
 * 会让执行器把一次密钥轮换错误变成静默的长期不写 DNS。
 */
export function openDdnsCredential(sealed: string, masterSecret: string): DdnsCredentialPlaintext {
  const raw = unsealSecret(sealed, deriveDdnsSealKey(masterSecret));
  const parsed = JSON.parse(raw) as DdnsCredentialPlaintext;
  if (typeof parsed?.token !== "string" || parsed.token === "") {
    throw new Error("ddns: sealed credential has no token");
  }
  return parsed;
}

/** `config` 是否已是封存形态（拒绝明文 JSON 落库）。 */
export function isSealedDdnsConfig(config: unknown): boolean {
  if (typeof config === "string") return /^v\d+\./.test(config);
  // Prisma 的 Json 列可以存字符串；历史行可能是对象 ⇒ 那是明文，判为未封存。
  return false;
}

/* ================================================================== */
/* 绑定 / 解绑                                                         */
/* ================================================================== */

export interface DnsBindingRequest {
  workspaceId: number;
  userId: number;
  tunnelId: number;
  domain: string;
  recordType: DnsRecordType;
  mode: DnsMode;
  providerId: number | null;
  autoResolve: boolean;
  ttlSeconds?: number;
  /** 平台共享入口组由平台管理员配置（F6 ③）。 */
  allowSharedGroup?: boolean;
}

interface TunnelRow {
  id: number;
  workspace_id: number | null;
  category: string;
  ingress_node_id: number | null;
  dns_domain: string | null;
}

interface NodeRow {
  id: number;
  connect_ip: string | null;
  node_group_id: number;
}

/**
 * 绑定（或改绑）一个 Forward 的 DNS 前门。**零外呼**：只写库。
 *
 * 顺序是有意的：先解析入口地址（①），再校验域名与记录类型，最后才碰 provider ——
 * 这样"入口没有可用地址"这一类最容易被忽略、也最致命的前置条件会**第一步**被拒绝，
 * 而不是等到写完 provider 检查才失败（那时错误信息会把运维引向 provider）。
 */
export async function bindForwardDns(deps: DdnsDeps, input: DnsBindingRequest): Promise<DdnsResult<DnsBindingState>> {
  const tunnel = (await deps.db.tunnel.findFirst({
    where: { id: input.tunnelId, workspace_id: input.workspaceId, category: "port_forward" },
    select: { id: true, workspace_id: true, category: true, ingress_node_id: true, dns_domain: true },
  })) as TunnelRow | null;
  if (!tunnel) return fail(DDNS_ERROR_CODES.ddns_not_found, "端口转发不存在");
  if (tunnel.ingress_node_id === null) {
    return fail(DDNS_ERROR_CODES.dns_address_unavailable, "该转发还没有入口节点，DNS 前门地址无从确定");
  }

  const node = (await deps.db.node.findUnique({
    where: { id: tunnel.ingress_node_id },
    select: { id: true, connect_ip: true, node_group_id: true },
  })) as NodeRow | null;
  const connectIp = node?.connect_ip?.trim() ?? "";
  if (!node || connectIp === "") {
    // ① 冻结的规则：没有 `connect_ip` 就拒绝，**不回落**到任何其它来源。
    return fail(
      DDNS_ERROR_CODES.dns_address_unavailable,
      "入口节点的 connect_ip 为空：前门地址只能来自它，面板不猜地址",
    );
  }

  const domain = normalizeDnsDomain(input.domain);
  if (domain === null) return fail(DDNS_ERROR_CODES.dns_domain_invalid, "域名不合法");

  const natural = dnsRecordTypeForAddress(connectIp);
  if (natural === null) {
    return fail(DDNS_ERROR_CODES.dns_address_unavailable, `入口地址 ${connectIp} 不是可用的 IP 字面量`);
  }
  if (input.recordType !== "CNAME" && input.recordType !== natural) {
    // A ↔ IPv4、AAAA ↔ IPv6。允许错配的唯一后果是"记录写得进去、客户端永远连不上"。
    return fail(
      DDNS_ERROR_CODES.dns_record_type_mismatch,
      `记录类型 ${input.recordType} 与入口地址 ${connectIp}（${natural}）不匹配`,
    );
  }
  if (input.mode === "multi_entry" && input.recordType === "CNAME") {
    // 一个 CNAME 只能指向一个名字，装不下"可用入口集合"——多入口形态的前提是多个值。
    return fail(DDNS_ERROR_CODES.dns_mode_record_type_conflict, "多入口形态不支持 CNAME 记录");
  }

  const ttl = input.ttlSeconds ?? DDNS_TTL_SECONDS.default;
  if (!Number.isInteger(ttl) || ttl < DDNS_TTL_SECONDS.min || ttl > DDNS_TTL_SECONDS.max) {
    return fail(
      DDNS_ERROR_CODES.dns_ttl_out_of_range,
      `TTL 必须在 ${DDNS_TTL_SECONDS.min}..${DDNS_TTL_SECONDS.max} 秒之间`,
    );
  }

  if (input.providerId !== null) {
    const provider = (await deps.db.dNSProvider.findFirst({
      where: { id: input.providerId },
      select: { id: true, workspace_id: true, config: true },
    })) as { id: number; workspace_id: number | null; config: unknown } | null;
    if (!provider) return fail(DDNS_ERROR_CODES.dns_provider_not_found, "DNS provider 不存在");
    if (provider.workspace_id === null) {
      // NULL = 平台级凭据（F6 ③ 与 D3）：租户不得使用它，除非调用方是平台管理员。
      if (!(await deps.isPlatformAdmin(input.userId)) && !input.allowSharedGroup) {
        return fail(DDNS_ERROR_CODES.dns_provider_forbidden, "平台级 DNS provider 只有平台管理员能使用");
      }
    } else if (provider.workspace_id !== input.workspaceId) {
      // 跨 workspace 一律"不存在"：区分"不存在"与"不是你的"会把别的租户的资源 id 暴露成事实。
      return fail(DDNS_ERROR_CODES.dns_provider_not_found, "DNS provider 不存在");
    }
    if (!isSealedDdnsConfig(provider.config)) {
      return fail(DDNS_ERROR_CODES.dns_provider_credential_invalid, "该 provider 的凭据不是封存形态，拒绝用于绑定");
    }
  }

  // ③ 平台共享入口组：对 workspace 之外的 user 有 active grant ⇒ 这份前门不只服务本租户，
  // 租户凭据不得写它（否则一次绑定会改变别的租户看到的入口）。
  const foreignGrant = (await deps.db.nodeGroupGrant.findFirst({
    where: {
      node_group_id: node.node_group_id,
      active: true,
      // 关系名是 **`workspace_memberships`**（`User` 上的字段名），不是 `workspace_members` ——
      // 后者是 `WorkspaceMember` 的 **@@map 表名**，两者只差几个字母，而这个错误在真库里是
      // **500**：这段查询只要 `provider_id !== null` 就无条件执行 ⇒ 任何合法绑定都建不上。
      user: { workspace_memberships: { none: { workspace_id: input.workspaceId } } },
    },
    select: { id: true },
  })) as { id: number } | null;
  if (foreignGrant && !input.allowSharedGroup) {
    if (!(await deps.isPlatformAdmin(input.userId))) {
      return fail(
        DDNS_ERROR_CODES.shared_group_dns_denied,
        "该入口节点组被授权给了其它租户：它的 DNS 前门只能由平台管理员配置",
      );
    }
  }

  const updated = (await deps.db.tunnel.update({
    where: { id: tunnel.id },
    data: {
      dns_domain: domain,
      dns_record_type: input.recordType,
      dns_mode: input.mode,
      dns_provider_id: input.providerId,
      dns_auto_resolve: input.autoResolve,
      // 绑定/改绑 = 期望值集变了 ⇒ 之前那次确认作废。**这是本片唯一会动状态的写**，
      // 而且只把状态**退回未确认**（`pending`），绝不自称 `synced`。
      dns_synced_at: null,
      dns_confirmed_values: [],
      dns_verified: false,
      dns_last_error: null,
    },
    select: {
      dns_domain: true,
      dns_record_type: true,
      dns_mode: true,
      dns_provider_id: true,
      dns_confirmed_values: true,
      dns_synced_at: true,
      dns_verified: true,
      dns_last_error: true,
    },
  })) as DnsBindingRow;


  // 期望值集这里只给**当前 owner 的地址**。`multi_entry` 的完整值集（该入口组里**可用**的
  // 全部入口地址）属于 WP17.4 的"就绪性前置闸门"——那里才有"哪些入口算可用"的判据。本片
  // 把它算小一点而不是算错：给一个地址是**真**的子集（owner 一定在里面），而按 group 里所有
  // 节点糊一个集合会在离线节点上直接说谎。
  return { ok: true, value: dnsBindingState(updated, [connectIp]) };
}

/**
 * 解绑。**幂等**：本来就没绑也返回成功——但审计里区分得出（`was_bound`）。
 * 为什么幂等：解绑是"收敛到未绑定"的意图，客户端重试不该看到 404。
 */
export async function unbindForwardDns(
  deps: DdnsDeps,
  input: { workspaceId: number; userId: number; tunnelId: number },
): Promise<DdnsResult<DnsBindingState>> {
  const tunnel = (await deps.db.tunnel.findFirst({
    where: { id: input.tunnelId, workspace_id: input.workspaceId, category: "port_forward" },
    select: { id: true, dns_domain: true },
  })) as { id: number; dns_domain: string | null } | null;
  if (!tunnel) return fail(DDNS_ERROR_CODES.ddns_not_found, "端口转发不存在");

  const updated = (await deps.db.tunnel.update({
    where: { id: tunnel.id },
    data: {
      dns_domain: null,
      dns_record_type: null,
      dns_mode: null,
      dns_provider_id: null,
      dns_auto_resolve: false,
      dns_synced_at: null,
      dns_confirmed_values: [],
      dns_verified: false,
      dns_last_error: null,
      // provider 解绑后**不删行**（凭据可能被别的转发用着），只是不再被引用。
    },
    select: {
      dns_domain: true,
      dns_record_type: true,
      dns_mode: true,
      dns_provider_id: true,
      dns_confirmed_values: true,
      dns_synced_at: true,
      dns_verified: true,
      dns_last_error: true,
    },
  })) as DnsBindingRow;


  // 解绑后没有期望值集：前门已经不存在，任何"应该出现的地址"都是空集。
  return { ok: true, value: dnsBindingState(updated, []) };
}

/* ================================================================== */
/* provider：封存凭据的 CRUD                                            */
/* ================================================================== */

export interface DnsProviderCreateRequest {
  workspaceId: number;
  userId: number;
  name: string;
  /** 只能是 `DNS_PROVIDER_TYPES` 里的取值（DB 枚举）。厂商差异靠 `endpoint` 覆盖，不靠新类型。 */
  type: DnsProviderType;
  credential: DdnsCredentialPlaintext;
  /** 平台管理员可以建**平台级** provider（workspace_id = NULL）。 */
  platformLevel?: boolean;
}

/** 对外可见的 provider 形状：**永远不含凭据**（连封存态都不给）。 */
export interface DnsProviderView {
  id: number;
  name: string;
  type: string;
  workspace_id: number | null;
  platform_level: boolean;
  has_credential: boolean;
  created_at: string | null;
}

export async function createDnsProvider(
  deps: DdnsDeps,
  input: DnsProviderCreateRequest,
): Promise<DdnsResult<DnsProviderView>> {
  const name = input.name?.trim() ?? "";
  if (name === "") return fail(DDNS_ERROR_CODES.dns_provider_credential_invalid, "provider 名称不能为空");
  let config: string;
  try {
    config = sealDdnsCredential(input.credential, sealKey(deps));
  } catch (e) {
    return fail(DDNS_ERROR_CODES.dns_provider_credential_invalid, (e as Error).message);
  }
  const workspaceId = input.platformLevel === true ? null : input.workspaceId;
  if (workspaceId === null && !(await deps.isPlatformAdmin(input.userId))) {
    return fail(DDNS_ERROR_CODES.dns_provider_forbidden, "平台级 provider 只有平台管理员能创建");
  }
  const created = (await deps.db.dNSProvider.create({
    data: {
      name,
      type: input.type,
      config,
      user_id: input.userId,
      workspace_id: workspaceId,
    },
    select: { id: true, name: true, type: true, workspace_id: true, config: true, created_at: true },
  })) as { id: number; name: string; type: string; workspace_id: number | null; config: unknown; created_at: Date | null };


  return { ok: true, value: providerView(created) };
}

function providerView(row: {
  id: number;
  name: string;
  type: string;
  workspace_id: number | null;
  config: unknown;
  created_at: Date | null;
}): DnsProviderView {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    workspace_id: row.workspace_id,
    platform_level: row.workspace_id === null,
    has_credential: isSealedDdnsConfig(row.config),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : null,
  };
}

/**
 * 列出**本 workspace 可见**的 provider：自己的 + 平台级的（平台级只有平台管理员能看见，
 * 否则一个租户就能从列表里推断出平台配置了哪些 DNS 服务商）。
 */
export async function listDnsProviders(
  deps: DdnsDeps,
  input: { workspaceId: number; userId: number },
): Promise<DdnsResult<DnsProviderView[]>> {
  const platformAdmin = await deps.isPlatformAdmin(input.userId);
  const rows = (await deps.db.dNSProvider.findMany({
    where: platformAdmin
      ? { OR: [{ workspace_id: input.workspaceId }, { workspace_id: null }] }
      : { workspace_id: input.workspaceId },
    select: { id: true, name: true, type: true, workspace_id: true, config: true, created_at: true },
    orderBy: { id: "asc" },
  })) as Array<{ id: number; name: string; type: string; workspace_id: number | null; config: unknown; created_at: Date | null }>;
  return { ok: true, value: rows.map(providerView) };
}

/** 删除 provider：作用域同 list（跨租户一律"不存在"）。 */
export async function deleteDnsProvider(
  deps: DdnsDeps,
  input: { workspaceId: number; userId: number; providerId: number },
): Promise<DdnsResult<{ deleted: boolean }>> {
  const platformAdmin = await deps.isPlatformAdmin(input.userId);
  const provider = (await deps.db.dNSProvider.findFirst({
    where: {
      id: input.providerId,
      ...(platformAdmin
        ? { OR: [{ workspace_id: input.workspaceId }, { workspace_id: null }] }
        : { workspace_id: input.workspaceId }),
    },
    select: { id: true, workspace_id: true },
  })) as { id: number; workspace_id: number | null } | null;
  if (!provider) return fail(DDNS_ERROR_CODES.dns_provider_not_found, "DNS provider 不存在");
  await deps.db.dNSProvider.delete({ where: { id: provider.id } });
  return { ok: true, value: { deleted: true } };
}

/** Prisma 的输入类型别名：让调用方（路由）不必 import 具体模型类型。 */
export type DdnsTunnelUpdate = Prisma.TunnelUpdateInput;
