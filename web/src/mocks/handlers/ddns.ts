/**
 * DDNS mock（EXPOSE 既有后端：**同路径、同形状、同错误码**）。
 *
 * 唯一真相是 `backend/src/routes/ddns.ts` + `routes/forwards.ts` 的 DDNS 段 +
 * `services/ddns-binding.ts`。这里刻意逐条镜像它最容易骗人的几处：
 *
 *   1. **provider 列表永不含凭据**：连"封存态"都不给，只有 `has_credential`。
 *      mock 若把 token 回显出来，本地看着"能用"，线上永远拿不到 —— 那是 mock 骗人。
 *   2. **绑定后只可能是 `pending`**（`synced_at: null` / `verified: false` /
 *      `confirmed_values: []`）；mock 不能造 `synced`，因为没有执行器去读回确认。
 *      `synced` / `synced_unverified` / `error` / 退避 这几态在 mock 里**不可产生**：
 *      它们是执行器（worker）的事实，编一个出来等于把"未验证"演成"已验证"。
 *   3. **三个读投影字段始终存在**（`auto_resolve` / `attempt_count` / `next_attempt_at`），
 *      与 D4 冻结的契约一致；未绑定行的退避两列投影成 `null`（不是 0）。
 *   4. **错误码与 HTTP 状态**逐条对齐（`sendDdns` 的 404/403/400 分流）。
 *   5. **入口地址只来自 `ingress_node.connect_ip`**：为空/非 IP 字面量 ⇒
 *      `dns_address_unavailable`，绝不回落（`dns_address_unavailable` 也是"不给地址"）。
 *
 * 状态挂在一个 `WeakMap<MockStore, …>` 上：`resetStore()` 会换掉 store 对象，
 * 于是 mock 状态自动归零，不需要（也不允许）去改 `mocks/state.ts` 的 `MockStore` 形状。
 */
import * as rt from "../runtime";
import type { MockResponse, Store } from "../runtime";
import type { DnsBindingState, DnsMode, DnsRecordType, DnsState, DnsProviderView } from "@/lib/types/ddns";

const { fail, nextId, notFound, numOrNull, parseId, reqStr } = rt;

/** 请求体必须是对象；否则等价于后端 `c.req.json()` 失败（400 `invalid_input`）。 */
function objectBody(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

const PROVIDER_TYPES = ["cloudflare", "huawei"] as const;
const RECORD_TYPES = ["A", "AAAA", "CNAME"] as const;
const MODES = ["multi_entry", "single_active"] as const;

const ERROR_CODES = {
  ddns_not_found: "ddns_not_found",
  dns_address_unavailable: "dns_address_unavailable",
  dns_domain_invalid: "dns_domain_invalid",
  dns_record_type_mismatch: "dns_record_type_mismatch",
  dns_mode_record_type_conflict: "dns_mode_record_type_conflict",
  dns_provider_not_found: "dns_provider_not_found",
  dns_provider_forbidden: "dns_provider_forbidden",
  dns_provider_credential_invalid: "dns_provider_credential_invalid",
  shared_group_dns_denied: "shared_group_dns_denied",
} as const;

interface MockProviderRow extends DnsProviderView {
  /**
   * mock 里代替 DB 的封存串（`v1.…`）。**绝不进任何响应**：
   * `providerView()` 是唯一出参，测试断言响应体里找不到它。
   */
  sealed_config: string;
}

interface MockForwardDnsRow {
  domain: string | null;
  record_type: string | null;
  mode: string | null;
  provider_id: number | null;
  confirmed_values: string[];
  synced_at: string | null;
  verified: boolean;
  last_error: string | null;
  auto_resolve: boolean;
  attempt_count: number | null;
  next_attempt_at: string | null;
}

interface MockDdnsState {
  providers: MockProviderRow[];
  /** key = tunnel id（DDNS 读投影的键在真实库里就是 `tunnel` 行）。 */
  bindings: Map<number, MockForwardDnsRow>;
}

const STORES = new WeakMap<Store, MockDdnsState>();

function stateOf(db: Store): MockDdnsState {
  let state = STORES.get(db);
  if (!state) {
    state = { providers: [], bindings: new Map() };
    STORES.set(db, state);
  }
  return state;
}

/* ------------------------------ 纯函数：投影 ------------------------------ */

/** 与 `dnsStateFor()` 同判据：domain 空 = unbound；有 last_error = error；有 synced_at 才谈 verified。 */
function dnsStateFor(row: MockForwardDnsRow): DnsState {
  if (!row.domain || row.domain.trim() === "") return "unbound";
  if (row.last_error && row.last_error.trim() !== "") return "error";
  if (row.synced_at !== null) return row.verified ? "synced" : "synced_unverified";
  return "pending";
}

function dnsBindingState(row: MockForwardDnsRow, expected: readonly string[]): DnsBindingState {
  const state = dnsStateFor(row);
  const bound = state !== "unbound";
  return {
    state,
    domain: bound ? row.domain : null,
    record_type: bound && RECORD_TYPES.includes(row.record_type as DnsRecordType) ? (row.record_type as DnsRecordType) : null,
    mode: bound && MODES.includes(row.mode as DnsMode) ? (row.mode as DnsMode) : null,
    provider_id: bound ? row.provider_id : null,
    expected_values: expected.filter((value) => value !== ""),
    confirmed_values: bound ? [...row.confirmed_values] : [],
    synced_at: bound ? row.synced_at : null,
    verified: bound ? row.verified === true : false,
    last_error: bound ? row.last_error : null,
    // 三个 D4 读投影：未绑定行一律 false / null（**不**用 0 顶替），与后端投影逐字一致。
    auto_resolve: bound && row.auto_resolve === true,
    attempt_count: bound ? attemptsOf(row) : null,
    next_attempt_at: bound ? row.next_attempt_at : null,
  };
}

/** 连续失败计数：非正整数一律 0（与后端投影一致），未绑定行由调用方改成 `null`。 */
function attemptsOf(row: MockForwardDnsRow): number {
  return typeof row.attempt_count === "number" && Number.isInteger(row.attempt_count) && row.attempt_count > 0
    ? row.attempt_count
    : 0;
}

const EMPTY_BINDING: MockForwardDnsRow = {
  domain: null,
  record_type: null,
  mode: null,
  provider_id: null,
  confirmed_values: [],
  synced_at: null,
  verified: false,
  last_error: null,
  auto_resolve: false,
  attempt_count: null,
  next_attempt_at: null,
};

/** 对外可见的 provider 形状：**永远不含凭据**（替代 `providerView()`）。 */
function providerView(row: MockProviderRow): DnsProviderView {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    workspace_id: row.workspace_id,
    platform_level: row.workspace_id === null,
    has_credential: row.sealed_config.startsWith("v1."),
    created_at: row.created_at,
  };
}

/** 域名归一化 + 语法检查（镜像 `normalizeDnsDomain`）。返回 null = 非法。 */
function normalizeDnsDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, "");
  if (trimmed.length === 0 || trimmed.length > 253) return null;
  if (!trimmed.includes(".")) return null;
  if (trimmed.includes("..") || trimmed.startsWith("-") || trimmed.endsWith("-")) return null;
  for (const label of trimmed.split(".")) {
    if (label.length === 0 || label.length > 63) return null;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
  }
  return trimmed;
}

/** 地址族判定（镜像 `dnsRecordTypeForAddress`）：非 IP 字面量 ⇒ null（==> 不可用）。 */
function dnsRecordTypeForAddress(address: unknown): "A" | "AAAA" | null {
  if (typeof address !== "string") return null;
  const value = address.trim();
  if (value.length === 0) return null;
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

/* ------------------------------ 响应封装 ------------------------------ */

/** 与 `sendDdns()` 同分流：404（not_found 家族）/ 403（forbidden 家族）/ 400。 */
function sendDdns<T>(result: { ok: true; value: T } | { ok: false; code: string; error: string }, successStatus = 200): MockResponse {
  if (!result.ok) {
    const status =
      result.code === ERROR_CODES.ddns_not_found || result.code === ERROR_CODES.dns_provider_not_found
        ? 404
        : result.code === ERROR_CODES.dns_provider_forbidden || result.code === ERROR_CODES.shared_group_dns_denied
          ? 403
          : 400;
    return { status, body: { error: result.error, code: result.code, error_layer: "ddns" } };
  }
  return { status: successStatus, body: { data: result.value } };
}

function failDdns(code: string, error: string): { ok: false; code: string; error: string } {
  return { ok: false, code, error };
}

/* ------------------------------ 作用域 / 权限 ------------------------------ */

/**
 * 设置域 RBAC（`ddnsRoutes.use("*")` 的镜像）：读要 `settings:read`，写要 `settings:manage`。
 * 注意转发子路径 `/forwards/:id/dns` **不**走这里：它由 `handler.ts` 既有的 forward 族闸门
 * （`forward:read` / `forward:update`；DELETE 的中间件预筛是 `forward:delete`）负责。
 */
function settingsDenied(ctx: rt.MockAuthedRouteContext, scopeId: number | undefined, manage: boolean): MockResponse | null {
  const membership = ctx.db.workspaceMembers.find(
    (row) => row.workspace_id === scopeId && row.user_id === ctx.user.id && row.active,
  );
  if (!membership) return notFound("工作空间不存在");
  const grants = rt.mockEffectivePermissions(ctx.db, membership);
  const key = manage ? "settings:manage" : "settings:read";
  if (!grants.permissions[key as keyof typeof grants.permissions]) return fail(403, "工作空间角色无权操作", "permission_denied");
  return null;
}

/** 解绑在真实后端还要处理器再要 `forward:update`（`forward:delete` 只是中间件预筛）。 */
function forwardUpdateDenied(ctx: rt.MockAuthedRouteContext, scopeId: number | undefined): MockResponse | null {
  const membership = ctx.db.workspaceMembers.find(
    (row) => row.workspace_id === scopeId && row.user_id === ctx.user.id && row.active,
  );
  if (!membership) return notFound("工作空间不存在");
  const grants = rt.mockEffectivePermissions(ctx.db, membership);
  if (!grants.permissions["forward:update"]) return fail(403, "工作空间角色无权操作", "permission_denied");
  return null;
}

/* ------------------------------ 路由 ------------------------------ */

export async function handleDdnsMock(ctx: rt.MockAuthedRouteContext): Promise<MockResponse | null> {
  const { method, seg, db, user, req, scopeId } = ctx;

  const state = stateOf(db);

  /* ---------------- /api/ddns/providers ---------------- */

  if (seg[0] === "ddns" && seg[1] === "providers") {
    const manage = method !== "GET";
    const denied = settingsDenied(ctx, scopeId, manage);
    if (denied) return denied;
    const platformAdmin = user.super_admin === true;


    if (method === "GET" && seg[2] === undefined) {
      const rows = state.providers
        .filter((row) => (platformAdmin ? row.workspace_id === scopeId || row.workspace_id === null : row.workspace_id === scopeId))
        .sort((a, b) => a.id - b.id);
      return sendDdns({ ok: true, value: rows.map(providerView) });
    }

    if (method === "POST" && seg[2] === undefined) {
      const body = objectBody(req.body);
      if (!body) return { status: 400, body: { error: "provider 参数不合法", code: "invalid_input" } };
      const name = reqStr(body.name).trim();
      const type = reqStr(body.type);
      const credential = objectBody(body.credential);
      const token = credential ? reqStr(credential.token).trim() : "";
      // 后端是 zod `.strict()`：多出字段也应当 400（mock 不放过形状错误）。
      const extra = Object.keys(body).filter((key) => !["name", "type", "credential", "platform_level"].includes(key));
      if (extra.length > 0) {
        return { status: 400, body: { error: `Unrecognized key: "${extra[0]}"`, code: "invalid_input" } };
      }
      if (name === "") return { status: 400, body: { error: "provider 名称不能为空", code: "invalid_input" } };
      if (!PROVIDER_TYPES.includes(type as (typeof PROVIDER_TYPES)[number])) {
        return { status: 400, body: { error: "Invalid option: expected one of \"cloudflare\"|\"huawei\"", code: "invalid_input" } };
      }
      if (token === "") {
        return { status: 400, body: { error: "Invalid input: expected string, received undefined", code: "invalid_input" } };
      }
      const platformLevel = body.platform_level === true;
      if (platformLevel && !platformAdmin) {
        return sendDdns(failDdns(ERROR_CODES.dns_provider_forbidden, "平台级 provider 只有平台管理员能创建"));
      }
      const created: MockProviderRow = {
        id: nextId(state.providers),
        name,
        type,
        workspace_id: platformLevel ? null : (scopeId ?? null),
        platform_level: platformLevel,
        has_credential: true,
        created_at: rt.nowIso(),
        // 封存形态标记：与后端 `isSealedDdnsConfig` 的 `v\d+\.` 前缀一致（不含明文 token）。
        sealed_config: "v1.mock-sealed",
      };
      state.providers.push(created);
      // 入参 token **丢弃**：mock 不保存明文，也不回显（连封存串都不给）。
      return sendDdns({ ok: true, value: providerView(created) }, 201);
    }

    if (method === "DELETE" && seg[2] !== undefined) {
      const providerId = parseId(seg[2]);
      if (providerId === null) return { status: 400, body: { error: "ID 不合法", code: "invalid_input" } };
      const index = state.providers.findIndex(
        (row) => row.id === providerId && (platformAdmin ? row.workspace_id === scopeId || row.workspace_id === null : row.workspace_id === scopeId),
      );
      if (index < 0) return sendDdns(failDdns(ERROR_CODES.dns_provider_not_found, "DNS provider 不存在"));
      state.providers.splice(index, 1);
      return sendDdns({ ok: true, value: { deleted: true } });
    }
    return null;
  }

  /* ---------------- /api/forwards/:id/dns ---------------- */

  if (seg[0] === "forwards" && seg[2] === "dns") {
    const forwardId = parseId(seg[1]);
    if (forwardId === null) return { status: 400, body: { error: "ID 不合法", code: "invalid_input" } };
    // 转发是否存在 / 是否已绑定前门（真实后端按 tunnel + category=port_forward 查）。
    const tunnel = db.tunnels.find((row) => row.id === forwardId);
    if (!tunnel) return sendDdns(failDdns(ERROR_CODES.ddns_not_found, "端口转发不存在"));

    // 入口地址事实：**只**来自入口节点的 `connect_ip`（真实 GET 的 select 就只取这一列）。
    //
    // mock 的种子隧道没有 `ingress_node_id` 列，而转发视图用 `mockIngressNode()` 从节点组
    // 回解入口。这里复用**同一个**解析器，免得同一份 mock 里"详情页说入口是节点 1、
    // DNS 卡说没有入口地址"这种自相矛盾（health 模块当年就是因为这个才统一走它）。
    const ingressId = tunnel.ingress_node_id ?? rt.mockIngressNode(db, tunnel)?.id ?? null;
    const ingress = ingressId === null ? null : db.nodes.find((node) => node.id === ingressId) ?? null;
    const connectIp = ingress?.connect_ip?.trim() ?? "";

    if (method === "GET") {
      const row = state.bindings.get(forwardId) ?? EMPTY_BINDING;
      return sendDdns({ ok: true, value: dnsBindingState(row, connectIp === "" ? [] : [connectIp]) });
    }

    if (method === "POST") {
      // 处理器权限：`authorizeForward(c, id, "update")`（`forward:update` + own 语义由外层闸门管）。
      const body = objectBody(req.body);
      if (!body) return { status: 400, body: { error: "DNS 绑定参数不合法", code: "invalid_input" } };
      const extra = Object.keys(body).filter(
        (key) => !["domain", "record_type", "mode", "provider_id", "auto_resolve", "ttl_seconds"].includes(key),
      );
      if (extra.length > 0) {
        return { status: 400, body: { error: `Unrecognized key: "${extra[0]}"`, code: "invalid_input" } };
      }
      const domainRaw = reqStr(body.domain).trim();
      const recordType = reqStr(body.record_type);
      const mode = reqStr(body.mode);
      if (domainRaw === "" || domainRaw.length > 253 || !RECORD_TYPES.includes(recordType as DnsRecordType) || !MODES.includes(mode as DnsMode)) {
        return { status: 400, body: { error: "Invalid input", code: "invalid_input" } };
      }
      // `DnsBindSchema` 里 `ttl_seconds` 是 `int().min(60).max(3600)`：越界/非数字都在路由层 400。
      // Web 首发**不发送**这个字段（后端收下即丢弃，无列），但 mock 不能因此接受服务端会拒的形状。
      if (body.ttl_seconds !== undefined) {
        const ttl = body.ttl_seconds;
        if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
          return { status: 400, body: { error: "Too small: expected number to be >=60", code: "invalid_input" } };
        }
      }
      // ① 入口地址：没有入口节点 / connect_ip 为空 ⇒ 拒绝，**绝不回落**。
      if (ingressId === null || connectIp === "") {
        return sendDdns(failDdns(ERROR_CODES.dns_address_unavailable, "入口节点的 connect_ip 为空：前门地址只能来自它，面板不猜地址"));
      }
      const domain = normalizeDnsDomain(domainRaw);
      if (domain === null) return sendDdns(failDdns(ERROR_CODES.dns_domain_invalid, "域名不合法"));
      const natural = dnsRecordTypeForAddress(connectIp);
      if (natural === null) {
        return sendDdns(failDdns(ERROR_CODES.dns_address_unavailable, `入口地址 ${connectIp} 不是可用的 IP 字面量`));
      }
      if (recordType !== "CNAME" && recordType !== natural) {
        return sendDdns(
          failDdns(ERROR_CODES.dns_record_type_mismatch, `记录类型 ${recordType} 与入口地址 ${connectIp}（${natural}）不匹配`),
        );
      }
      if (mode === "multi_entry" && recordType === "CNAME") {
        return sendDdns(failDdns(ERROR_CODES.dns_mode_record_type_conflict, "多入口形态不支持 CNAME 记录"));
      }
      const providerId = numOrNull(body.provider_id);
      if (providerId !== null) {
        const provider = state.providers.find((row) => row.id === providerId);
        if (!provider) return sendDdns(failDdns(ERROR_CODES.dns_provider_not_found, "DNS provider 不存在"));
        if (provider.workspace_id === null && user.super_admin !== true) {
          return sendDdns(failDdns(ERROR_CODES.dns_provider_forbidden, "平台级 DNS provider 只有平台管理员能使用"));
        }
        if (provider.workspace_id !== null && provider.workspace_id !== scopeId) {
          return sendDdns(failDdns(ERROR_CODES.dns_provider_not_found, "DNS provider 不存在"));
        }
        if (!provider.sealed_config.startsWith("v1.")) {
          return sendDdns(failDdns(ERROR_CODES.dns_provider_credential_invalid, "该 provider 的凭据不是封存形态，拒绝用于绑定"));
        }
      }
      const previous = state.bindings.get(forwardId) ?? EMPTY_BINDING;
      const updated: MockForwardDnsRow = {
        domain,
        record_type: recordType,
        mode,
        provider_id: providerId,
        // 绑定/改绑 = 期望值集变了 ⇒ 之前那次确认作废（只退回 pending，绝不自称 synced）。
        confirmed_values: [],
        synced_at: null,
        verified: false,
        last_error: null,
        auto_resolve: body.auto_resolve === true,
        // 退避两列 bind 时**不重置**（与后端一致）：投影照实说还在退避窗口里。
        attempt_count: previous.attempt_count,
        next_attempt_at: previous.next_attempt_at,
      };
      state.bindings.set(forwardId, updated);
      return sendDdns({ ok: true, value: dnsBindingState(updated, [connectIp]) });
    }

    if (method === "DELETE") {
      // 真实后端：中间件预筛 `forward:delete`（外层闸门已查），处理器再要 `forward:update`。
      const denied = forwardUpdateDenied(ctx, scopeId);
      if (denied) return denied;
      const previous = state.bindings.get(forwardId) ?? EMPTY_BINDING;
      const updated: MockForwardDnsRow = {
        ...EMPTY_BINDING,
        // 解绑不动退避两列（列还在行上），但投影在未绑定时一律给 null。
        attempt_count: previous.attempt_count,
        next_attempt_at: previous.next_attempt_at,
      };
      state.bindings.set(forwardId, updated);
      return sendDdns({ ok: true, value: dnsBindingState(updated, []) });
    }
    return null;
  }

  return null;
}
