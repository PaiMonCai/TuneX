/**
 * V5.5 Federation —— mock 契约镜像（WP14/WP15/WP16 的 Admin Console 面）。
 *
 * **唯一真相是后端**：`backend/src/routes/admin-federation.ts` + `backend/src/services/federation/errors.ts`。
 * 本文件把它们的状态码表与错误体形状**逐字镜像**过来，供 `handler.ts` 使用；
 * `components/admin/__tests__/federation-contract.test.ts` 会直接读后端源码比对，
 * 后端改了而这里没跟上就会红 —— 这正是 mock 存在的意义（让前端在 mock 模式下
 * 跑的是真实契约，而不是「任何请求都成功」的假实现）。
 *
 * 三条与本 WP 直接相关的契约事实：
 *  1. 错误体是 `{ code, message, retryable, peer_panel_id, correlation_id }`，
 *     没有 `error` 字段，也没有 `data` 包装；
 *  2. 列表端点在后端是 `{ data: [...] }` 信封，但 `request()` 在 **mock 模式不解包**，
 *     所以 mock 这里必须直接返回前端类型对应的形状（裸数组）—— 与 `/admin/role` 一致；
 *  3. invite 的 token **只在唯一一次响应里出现**：state 里只留 hash，
 *     后续 `GET /peers` 永远不会把它带出来。
 */
import {
  FEDERATION_ERROR_CODES,
  FEDERATION_HOP_ROLES,
  type FederationErrorCode,
  type FederationGrant,
  type FederationGrantCapacity,
  type FederationPeer,
  type FederationUsageRecord,
} from "@/lib/types";

/* ------------------------------------------------------------------ */
/* 错误码闭集 + 状态码 / 可重试表（镜像 errors.ts）                     */
/* ------------------------------------------------------------------ */

export { FEDERATION_ERROR_CODES };
export type { FederationErrorCode };

/** 镜像 `backend/src/services/federation/errors.ts` 的 `STATUS`。 */
export const FEDERATION_ERROR_STATUS: Record<string, number> = {
  federation_disabled: 403,
  peer_unknown: 403,
  peer_revoked: 403,
  peer_unreachable: 502,
  signature_invalid: 401,
  clock_skew: 401,
  message_expired: 401,
  duplicate_message: 409,
  message_malformed: 400,
  grant_not_found: 404,
  grant_not_active: 409,
  grant_scope_violation: 403,
  grant_expired: 409,
  quota_exhausted: 429,
  lease_not_found: 404,
  lease_expired: 409,
  lease_revoked: 409,
  intent_revision_stale: 409,
  unsupported_topology: 422,
  handshake_invalid: 403,
  key_unknown: 401,
  internal_error: 500,
};

/** 镜像 `errors.ts` 的 `RETRYABLE`：只有这几类值得重试。 */
export const FEDERATION_ERROR_RETRYABLE: ReadonlySet<string> = new Set([
  "peer_unreachable",
  "clock_skew",
  "message_expired",
  "duplicate_message",
  "internal_error",
]);

/** 与后端 `federationErrorBody()` 同形状。 */
export function federationErrorBody(
  code: FederationErrorCode | string,
  message: string,
  peerPanelId: string | null = null,
  correlationId: string = `mock-${Math.random().toString(16).slice(2, 10)}`,
): {
  code: string;
  message: string;
  retryable: boolean;
  peer_panel_id: string | null;
  correlation_id: string;
} {
  return {
    code,
    message,
    retryable: FEDERATION_ERROR_RETRYABLE.has(code),
    peer_panel_id: peerPanelId,
    correlation_id: correlationId,
  };
}

/** 取状态码（未收录的码按 500，与后端 `STATUS[code]` 缺省行为一致）。 */
export function federationErrorStatus(code: string): number {
  return FEDERATION_ERROR_STATUS[code] ?? 500;
}

/* ------------------------------------------------------------------ */
/* mock 状态                                                           */
/* ------------------------------------------------------------------ */

/** mock 里的 peer 行：`public_keys` 是 JWK 列表（对外投影成 `key_ids` 指纹）。 */
export interface MockFederationPeerRow {
  id: number;
  peer_panel_id: string;
  display_name: string;
  endpoint_url: string;
  status: string;
  public_keys: Array<{ key_id: string; jwk: Record<string, string> }>;
  trust_scope: unknown;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface MockFederationState {
  enabled: boolean;
  panel_id: string;
  key_id: string;
  /** 邀请 token 的**哈希**（明文只在 invite 响应里出现一次）。 */
  invitation_hashes: Map<string, { peer_id: number; expires_at: string }>;
  peers: MockFederationPeerRow[];
  /** 内部行：比 `GET /grants` 的响应多一个 `id`（供 lease.grant_id 关联），响应里会剥掉。 */
  grants: MockFederationGrantRow[];
  leases: Array<Record<string, unknown>>;
  placements: Array<Record<string, unknown>>;
  usage: FederationUsageRecord[];
}

/**
 * grant 内部行 = `GET /grants` 响应字段 + `id`。
 *
 * `id` 不对外（后端响应里没有它），但 `lease.grant_id` 指向它，所以撤销级联需要它。
 */
export interface MockFederationGrantRow {
  id: number;
  grant_ref: string;
  peer_id: number;
  workspace_id: number | null;
  grant_epoch: number;
  status: string;
  scope: unknown;
  capacity: unknown;
  quota_reserved: boolean;
  expires_at: string;
  revoked_at: string | null;
}

/** grant 内部行 → 后端 `GET /grants` 的响应投影（**不含** `id`）。 */
export function toGrantResponse(row: MockFederationGrantRow): FederationGrant {
  return {
    grant_ref: row.grant_ref,
    peer_id: row.peer_id,
    workspace_id: row.workspace_id,
    grant_epoch: row.grant_epoch,
    status: row.status,
    scope: row.scope,
    capacity: row.capacity,
    quota_reserved: row.quota_reserved,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
  };
}

/** 非终态（会被 grant 撤销 / peer 撤销级联影响的状态）。 */
export const MOCK_LIVE_LEASE_STATES: readonly string[] = ["reserved", "active", "releasing"];

/** mock 里「网络不通」的确定性触发条件：endpoint 含这个串。 */
export const MOCK_UNREACHABLE_HINT = "unreachable";

export function isMockUnreachable(endpointUrl: string): boolean {
  return endpointUrl.includes(MOCK_UNREACHABLE_HINT);
}

/**
 * token → hash。
 *
 * 这是**形状模拟**，不是密码学：mock 只需要保证「state 里不存明文、明文只出现一次」
 * 这条不变量，因此用一个确定性的非可逆变换即可（真实后端是 sha256）。
 */
export function mockTokenHash(token: string): string {
  let h = 0;
  for (let i = 0; i < token.length; i += 1) h = (h * 31 + token.charCodeAt(i)) >>> 0;
  return `mockhash_${h.toString(16)}`;
}

/** 生成一次性邀请 token（形如 `fedinv_<32hex>`，长度满足后端 zod 的 16–256）。 */
export function mockInviteToken(): string {
  let s = "";
  for (let i = 0; i < 4; i += 1) s += Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `fedinv_${s}`;
}

/** peer 行 → 后端 `PeerSummary` 投影（**不**含公钥原文，只给 key_id 指纹）。 */
export function toPeerSummary(row: MockFederationPeerRow): FederationPeer {
  return {
    id: row.id,
    peer_panel_id: row.peer_panel_id,
    display_name: row.display_name,
    endpoint_url: row.endpoint_url,
    status: row.status,
    key_ids: row.public_keys.map((k) => k.key_id),
    trust_scope: row.trust_scope,
    last_seen_at: row.last_seen_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
  };
}

export function findPeerById(state: MockFederationState, id: number): MockFederationPeerRow | undefined {
  return state.peers.find((p) => p.id === id);
}

export function findPeerByPanelId(state: MockFederationState, panelId: string): MockFederationPeerRow | undefined {
  return state.peers.find((p) => p.peer_panel_id === panelId);
}

/** 该 peer 名下仍存活的租约。 */
export function liveLeasesOfPeer(state: MockFederationState, panelId: string): Array<Record<string, unknown>> {
  return state.leases.filter(
    (l) => l.peer_panel_id === panelId && MOCK_LIVE_LEASE_STATES.includes(String(l.state)),
  );
}

export function grantByRef(state: MockFederationState, ref: string): MockFederationGrantRow | undefined {
  return state.grants.find((g) => g.grant_ref === ref);
}

/* ------------------------------------------------------------------ */
/* 种子                                                                */
/* ------------------------------------------------------------------ */

const PANEL_A = "1f0a5c2e-9d31-4b77-8a44-6c1e2b0d5f90";
const PANEL_B = "7c2b8e14-3a55-4f0d-9c21-8be4d7a01c33";
const PANEL_C = "b45d9017-6e28-4c1a-8f73-2d90e5a1b6c2";
const REVOKED_PANEL = "0a91f3c7-5b62-4d38-91ee-4f7a2c8d6e15";
/** 信任成立但对端当前不可达（endpoint 含 `unreachable`）。 */
const UNREACHABLE_PANEL = "5e3c7a2d-8b41-4a6f-9d02-1c8f4b7e9a20";

const KB = 1024;
const GB = 1024 * 1024 * 1024;

/**
 * 时间基准：相对「构建这一刻」计算，保证同一进程内
 * 「活跃的 grant/lease 未来才过期」「已撤销/已过期的在过去」这两条时序事实成立。
 * 测试断言时序关系，不断言绝对时间戳。
 */
const T0 = Date.now();
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const scopeFor = (nodeGroups: number[], hopRoles: string[]) => ({
  node_group_ids: nodeGroups,
  hop_roles: hopRoles,
  allow_target_policy: null,
});

const capacityFor = (maxLegs: number | null, mbps: number | null = null, conns: number | null = null) => ({
  max_legs: maxLegs,
  max_bandwidth_mbps: mbps,
  max_connections: conns,
});

/** 构建一份全新的联邦 mock 状态（`resetStore()` 每次调用）。 */
export function buildMockFederation(): MockFederationState {
  const state: MockFederationState = {
    enabled: true,
    panel_id: PANEL_A,
    key_id: "k_a1b2c3d4e5f60718",
    invitation_hashes: new Map(),
    peers: [
      {
        id: 1,
        peer_panel_id: PANEL_B,
        display_name: "Panel B (SG)",
        endpoint_url: "https://panel-b.internal:3000",
        status: "active",
        public_keys: [{ key_id: "k_9f8e7d6c5b4a3210", jwk: { kty: "OKP", crv: "Ed25519", x: "mock" } }],
        trust_scope: scopeFor([2, 3], ["egress"]),
        last_seen_at: at(-4),
        revoked_at: null,
        created_at: at(-60 * 24 * 12),
      },
      {
        id: 2,
        peer_panel_id: `pending:${PANEL_C}`,
        display_name: "Panel C (JP, 待握手)",
        endpoint_url: "https://panel-c.internal:3000",
        status: "pending",
        public_keys: [],
        trust_scope: null,
        last_seen_at: null,
        revoked_at: null,
        created_at: at(-30),
      },
      {
        id: 3,
        peer_panel_id: REVOKED_PANEL,
        display_name: "Panel D (已撤销)",
        endpoint_url: "https://panel-d.internal:3000",
        status: "revoked",
        public_keys: [{ key_id: "k_1122334455667788", jwk: { kty: "OKP", crv: "Ed25519", x: "mock" } }],
        trust_scope: scopeFor([4], ["transit"]),
        last_seen_at: at(-60 * 24),
        revoked_at: at(-60),
        created_at: at(-60 * 24 * 30),
      },
      {
        // 信任成立但对端当前不可达：用来演示「网络不通」与「信任不成立 / 被撤销」是两回事
        id: 4,
        peer_panel_id: UNREACHABLE_PANEL,
        display_name: "Panel E (对端不可达)",
        endpoint_url: `https://panel-e.${MOCK_UNREACHABLE_HINT}.internal:3000`,
        status: "active",
        public_keys: [{ key_id: "k_aabbccddeeff0011", jwk: { kty: "OKP", crv: "Ed25519", x: "mock" } }],
        trust_scope: scopeFor([2], ["egress"]),
        last_seen_at: at(-45),
        revoked_at: null,
        created_at: at(-60 * 24 * 3),
      },
    ],
    grants: [
      {
        id: 1,
        grant_ref: "g_2a7c91",
        peer_id: 1,
        workspace_id: 2,
        grant_epoch: 3,
        status: "active",
        scope: scopeFor([2, 3], ["egress"]),
        capacity: capacityFor(4, 500, 200),
        quota_reserved: true,
        expires_at: at(60 * 24),
        revoked_at: null,
      },
      {
        id: 2,
        grant_ref: "g_5b1e40",
        peer_id: 1,
        workspace_id: null,
        grant_epoch: 1,
        status: "suspended",
        scope: scopeFor([3], ["transit"]),
        capacity: capacityFor(2),
        quota_reserved: false,
        expires_at: at(60 * 12),
        revoked_at: null,
      },
      {
        id: 3,
        grant_ref: "g_9d3f22",
        peer_id: 3,
        workspace_id: 2,
        grant_epoch: 7,
        status: "expired",
        scope: scopeFor([4], ["transit"]),
        capacity: capacityFor(1),
        quota_reserved: false,
        expires_at: at(-120),
        revoked_at: null,
      },
    ],
    leases: [
      {
        lease_ref: "l_1a2b3c",
        grant_id: 1,
        peer_panel_id: PANEL_B,
        forward_ref: "f_77c1",
        intent_id: "i_0011",
        state: "active",
        lease_epoch: 2,
        hop_role: "egress",
        node_id: 4,
        listen_port: 24001,
        requested_revision: 5,
        applied_revision: 5,
        last_error_code: null,
        expires_at: at(55),
        released_at: null,
      },
      {
        lease_ref: "l_4d5e6f",
        grant_id: 1,
        peer_panel_id: PANEL_B,
        forward_ref: "f_88d2",
        intent_id: "i_0012",
        state: "reserved",
        lease_epoch: 1,
        hop_role: "egress",
        node_id: 5,
        listen_port: null,
        requested_revision: 2,
        applied_revision: null,
        last_error_code: null,
        expires_at: at(20),
        released_at: null,
      },
      {
        // applied 落后于 requested：页面必须把两个 revision 都摊开，不能只说「同步」
        lease_ref: "l_7a8b9c",
        grant_id: 2,
        peer_panel_id: PANEL_B,
        forward_ref: "f_99e3",
        intent_id: "i_0013",
        state: "releasing",
        lease_epoch: 4,
        hop_role: "transit",
        node_id: 6,
        listen_port: 24102,
        requested_revision: 9,
        applied_revision: 7,
        last_error_code: "peer_unreachable",
        expires_at: at(5),
        released_at: null,
      },
      {
        lease_ref: "l_def012",
        grant_id: 3,
        peer_panel_id: REVOKED_PANEL,
        forward_ref: "f_11a4",
        intent_id: "i_0014",
        state: "revoked",
        lease_epoch: 3,
        hop_role: "transit",
        node_id: null,
        listen_port: null,
        requested_revision: 4,
        applied_revision: 4,
        last_error_code: "grant_not_active",
        expires_at: at(-90),
        released_at: at(-60),
      },
      {
        lease_ref: "l_failed01",
        grant_id: 2,
        peer_panel_id: PANEL_C,
        forward_ref: "f_22b5",
        intent_id: "i_0015",
        state: "failed",
        lease_epoch: 1,
        hop_role: "ingress",
        node_id: null,
        listen_port: null,
        requested_revision: 1,
        applied_revision: null,
        last_error_code: "quota_exhausted",
        expires_at: at(-10),
        released_at: null,
      },
    ],
    placements: [
      {
        peer_panel_id: PANEL_B,
        forward_ref: "f_77c1",
        tunnel_id: 101,
        intent_id: "i_0011",
        lease_ref: "l_1a2b3c",
        lease_epoch: 2,
        hop_role: "egress",
        desired_revision: 5,
        applied_revision: 5,
        state: "active",
        peer_node_ref: "sg-egress-01",
        peer_port: 24001,
        last_error_code: null,
        expires_at: at(55),
      },
      {
        peer_panel_id: PANEL_B,
        forward_ref: "f_99e3",
        tunnel_id: 102,
        intent_id: "i_0013",
        lease_ref: "l_7a8b9c",
        lease_epoch: 4,
        hop_role: "transit",
        desired_revision: 9,
        applied_revision: 7,
        state: "degraded",
        peer_node_ref: "jp-transit-02",
        peer_port: 24102,
        last_error_code: "peer_unreachable",
        expires_at: at(5),
      },
    ],
    usage: [
      {
        usage_id: "u_0001",
        peer_panel_id: PANEL_B,
        lease_ref: "l_1a2b3c",
        forward_ref: "f_77c1",
        tunnel_id: 101,
        window_start: at(-60),
        window_end: at(-30),
        bytes_in: String(3 * GB),
        bytes_out: String(11 * GB),
        connections: 4210,
        attribution: "attributed",
        attribution_hint: null,
        received_at: at(-29),
      },
      {
        usage_id: "u_0002",
        peer_panel_id: PANEL_B,
        lease_ref: "l_7a8b9c",
        forward_ref: "f_99e3",
        tunnel_id: 102,
        window_start: at(-60),
        window_end: at(-30),
        bytes_in: String(512 * KB),
        bytes_out: String(2 * GB),
        connections: 88,
        attribution: "attributed",
        attribution_hint: null,
        received_at: at(-29),
      },
      {
        // 无法归因：forward_ref / tunnel_id 全 null —— 必须单独成桶，绝不混进上面两行
        usage_id: "u_0003",
        peer_panel_id: PANEL_B,
        lease_ref: "l_ffffffff",
        forward_ref: null,
        tunnel_id: null,
        window_start: at(-60),
        window_end: at(-30),
        bytes_in: String(64 * KB),
        bytes_out: String(128 * KB),
        connections: 3,
        attribution: "unattributed",
        // l_ffffffff 在本机没有 placement 行 → 属于「本地无轨迹」那类
        attribution_hint: "no_local_placement",
        received_at: at(-28),
      },
      {
        usage_id: "u_0004",
        peer_panel_id: REVOKED_PANEL,
        lease_ref: "l_def012",
        forward_ref: null,
        tunnel_id: null,
        window_start: at(-180),
        window_end: at(-150),
        bytes_in: String(1 * GB),
        bytes_out: String(1 * GB),
        connections: 12,
        attribution: "unattributed",
        // l_def012 对应的 placement 不在本页种子里，但该 lease 曾存在 → 用冲突型判据演示第二类
        attribution_hint: "placement_conflict",
        received_at: at(-149),
      },
      {
        usage_id: "u_0005",
        peer_panel_id: PANEL_C,
        lease_ref: "l_failed01",
        forward_ref: "f_22b5",
        tunnel_id: null,
        window_start: at(-240),
        window_end: at(-210),
        bytes_in: "0",
        bytes_out: "0",
        connections: 0,
        attribution: "attributed",
        attribution_hint: null,
        received_at: at(-209),
      },
    ],
  };
  // 让 attribution_hint 与 placements **真的自洽**：判据是「本机有没有这条 lease_ref 的 placement」，
  // 而不是随手写的字面量（后端就是这么算的：knownLeases.has(lease_ref) → placement_conflict）。
  const knownLeaseRefs = new Set(state.placements.map((p) => String(p.lease_ref)));
  state.usage = state.usage.map((u) =>
    u.attribution === "attributed"
      ? { ...u, attribution_hint: null }
      : {
          ...u,
          attribution_hint: knownLeaseRefs.has(u.lease_ref) ? "placement_conflict" : "no_local_placement",
        },
  );
  return state;
}

/* ------------------------------------------------------------------ */
/* 路由实现（自包含，可离线单测）                                        */
/* ------------------------------------------------------------------ */

export interface FederationMockResponse {
  status: number;
  body: unknown;
}

export interface FederationMockRequest {
  method: string;
  /** `/admin/federation` 之后的路径段，例如 `["peers","3","ping"]` */
  seg: string[];
  body?: unknown;
  state: MockFederationState;
  /** 注入时钟，便于测试（默认 `() => new Date()`） */
  now?: () => Date;
}

/*
 * 下面几个 helper 与 handler.ts 里的同名局部函数同义。
 * 这里刻意自包含：本模块要能在 bun test 里**脱离 handler.ts**（它 import 了半个应用）
 * 单独驱动，`mocks/__tests__` 与 `components/admin/__tests__` 都用它做契约测试。
 */
function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
function reqStr(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}
function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function nextId(items: { id: number }[]): number {
  return items.reduce((m, x) => Math.max(m, x.id), 0) + 1;
}
function parseId(seg: string | undefined): number | null {
  if (seg === undefined) return null;
  const n = Number(seg);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 从 endpoint 派生一个稳定的（形状像 UUID 的）panel_id，避免 mock 里出现随机值。 */
export function mockPanelIdFromEndpoint(endpointUrl: string): string {
  const h = mockTokenHash(endpointUrl).replace("mockhash_", "").padStart(8, "0");
  return `${h.slice(0, 8)}-1111-4222-8333-${h.slice(0, 12).padEnd(12, "0")}`;
}

type ScopeParse = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

/** 镜像后端 `parseGrantScope`：未知键 / 非法类型一律 fail-closed。 */
export function parseMockGrantScope(raw: unknown): ScopeParse {
  if (raw === undefined || raw === null) {
    return { ok: true, value: { node_group_ids: [], hop_roles: [], allow_target_policy: null } };
  }
  const rec = asRecord(raw);
  if (Object.keys(rec).length === 0 && (typeof raw !== "object" || Array.isArray(raw))) {
    return { ok: false, message: "grant scope 必须是 JSON 对象" };
  }
  const allowed = new Set(["node_group_ids", "hop_roles", "allow_target_policy"]);
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) return { ok: false, message: `grant scope 含未知键 "${key}"（fail-closed）` };
  }
  const groups: number[] = [];
  const rawGroups = rec.node_group_ids;
  if (rawGroups !== undefined && rawGroups !== null) {
    if (!Array.isArray(rawGroups)) return { ok: false, message: "scope.node_group_ids 必须是正整数数组" };
    for (const g of rawGroups) {
      if (!Number.isInteger(g) || (g as number) <= 0) {
        return { ok: false, message: `scope.node_group_ids 含非法值：${String(g)}` };
      }
      if (!groups.includes(g as number)) groups.push(g as number);
    }
  }
  const roles: string[] = [];
  const rawRoles = rec.hop_roles;
  if (rawRoles !== undefined && rawRoles !== null) {
    if (!Array.isArray(rawRoles)) return { ok: false, message: "scope.hop_roles 必须是数组" };
    for (const r of rawRoles) {
      if (typeof r !== "string" || !FEDERATION_HOP_ROLES.includes(r as never)) {
        return { ok: false, message: `scope.hop_roles 含未知角色：${String(r)}` };
      }
      if (!roles.includes(r)) roles.push(r);
    }
  }
  let policy: string[] | null = null;
  const rawPolicy = rec.allow_target_policy;
  if (rawPolicy !== undefined && rawPolicy !== null) {
    if (!Array.isArray(rawPolicy)) return { ok: false, message: "scope.allow_target_policy 必须是字符串数组" };
    policy = [];
    for (const p of rawPolicy) {
      if (typeof p !== "string" || p.trim() === "") {
        return { ok: false, message: "scope.allow_target_policy 含空字符串" };
      }
      if (!policy.includes(p)) policy.push(p);
    }
  }
  return { ok: true, value: { node_group_ids: groups, hop_roles: roles, allow_target_policy: policy } };
}

type CapacityParse =
  | { ok: true; value: FederationGrantCapacity }
  | { ok: false; message: string };

/** 镜像后端 `parseGrantCapacity`：未知键 / 负数 / 非整数 → fail-closed。 */
export function parseMockGrantCapacity(raw: unknown): CapacityParse {
  const unlimited: FederationGrantCapacity = { max_legs: null, max_bandwidth_mbps: null, max_connections: null };
  if (raw === undefined || raw === null) return { ok: true, value: unlimited };
  const rec = asRecord(raw);
  const allowed = new Set(["max_legs", "max_bandwidth_mbps", "max_connections"]);
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) return { ok: false, message: `grant capacity 含未知键 "${key}"（fail-closed）` };
  }
  const read = (key: keyof FederationGrantCapacity): number | null | { bad: string } => {
    const v = rec[key];
    if (v === undefined || v === null) return null;
    if (!Number.isInteger(v) || (v as number) < 0) return { bad: `capacity.${key} 必须是非负整数` };
    return v as number;
  };
  const legs = read("max_legs");
  const mbps = read("max_bandwidth_mbps");
  const conns = read("max_connections");
  for (const v of [legs, mbps, conns]) {
    if (v !== null && typeof v === "object") return { ok: false, message: v.bad };
  }
  return {
    ok: true,
    value: {
      max_legs: legs as number | null,
      max_bandwidth_mbps: mbps as number | null,
      max_connections: conns as number | null,
    },
  };
}

/**
 * 处理一条 `/admin/federation/*` 请求。
 *
 * 返回 `null` 表示"这个路径不属于 federation"（交给 handler 继续匹配）。
 * 管理员权限闸在 handler 里（与本模块无关）。
 */
export function handleFederationMock(req: FederationMockRequest): FederationMockResponse | null {
  const { method, seg, state } = req;
  const now = req.now ?? (() => new Date());
  const nowIso = () => now().toISOString();

  const ok = (body: unknown): FederationMockResponse => ({ status: 200, body });
  const fedFail = (
    code: FederationErrorCode,
    message: string,
    status?: number,
    peerPanelId: string | null = null,
  ): FederationMockResponse => ({
    status: status ?? federationErrorStatus(code),
    body: federationErrorBody(code, message, peerPanelId),
  });

  const sub = seg[0];

  if (sub === "status" && method === "GET") {
    return ok({
      enabled: state.enabled,
      panel_id: state.panel_id,
      key_id: state.key_id,
      peers: state.peers.length,
      revoked_peers: state.peers.filter((p) => p.status === "revoked").length,
      grants: state.grants.length,
      active_leases: state.leases.filter((l) => MOCK_LIVE_LEASE_STATES.includes(String(l.state))).length,
    });
  }

  if (sub === "enable" && method === "POST") {
    const changed = !state.enabled;
    state.enabled = true;
    return ok({ enabled: true, panel_id: state.panel_id, key_id: state.key_id, changed });
  }

  if (sub === "disable" && method === "POST") {
    const changed = state.enabled;
    state.enabled = false;
    return ok({ enabled: false, changed });
  }

  if (sub === "peers") {
    if (method === "GET" && seg[1] === undefined) return ok(state.peers.map(toPeerSummary));

    if (method === "POST" && seg[1] === "invite") {
      const body = asRecord(req.body);
      const displayName = reqStr(body.display_name);
      const endpointUrl = reqStr(body.endpoint_url);
      const ttl = numOrNull(body.ttl_seconds);
      if (!displayName || !endpointUrl) return fedFail("message_malformed", "邀请参数非法", 400);
      if (ttl !== null && (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600)) {
        return fedFail("message_malformed", "ttl_seconds 必须在 60–3600 之间", 400);
      }
      const peerId = nextId(state.peers);
      const token = mockInviteToken();
      const expiresAt = new Date(now().getTime() + (ttl ?? 900) * 1000).toISOString();
      state.peers.push({
        id: peerId,
        peer_panel_id: `pending:${mockPanelIdFromEndpoint(endpointUrl)}`,
        display_name: displayName,
        endpoint_url: endpointUrl,
        status: "pending",
        public_keys: [],
        trust_scope: null,
        last_seen_at: null,
        revoked_at: null,
        created_at: nowIso(),
      });
      // 只存 hash：明文 token 随本次响应离开，之后任何 GET /peers 都不会再带出它
      state.invitation_hashes.set(mockTokenHash(token), { peer_id: peerId, expires_at: expiresAt });
      return ok({
        peer_id: peerId,
        token,
        expires_at: expiresAt,
        panel_id: state.panel_id,
        key_id: state.key_id,
        public_jwk: { kty: "OKP", crv: "Ed25519", x: `mock-public-${state.key_id}` },
      });
    }

    if (method === "POST" && seg[1] === "handshake") {
      const body = asRecord(req.body);
      const endpointUrl = reqStr(body.endpoint_url);
      const token = reqStr(body.token);
      if (!endpointUrl || token.length < 16) return fedFail("message_malformed", "握手参数非法", 400);
      const hash = mockTokenHash(token);
      const invitation = state.invitation_hashes.get(hash);
      if (!invitation) return fedFail("handshake_invalid", "邀请 token 无效或已被使用", 403);
      if (isMockUnreachable(endpointUrl)) return fedFail("peer_unreachable", `无法连接 ${endpointUrl}`, 502);
      const peer = findPeerById(state, invitation.peer_id);
      if (!peer) return fedFail("peer_unknown", "邀请对应的 peer 已不存在", 403);
      state.invitation_hashes.delete(hash); // 一次性消费
      peer.peer_panel_id = peer.peer_panel_id.replace(/^pending:/, "");
      peer.status = "active";
      peer.display_name = reqStr(body.display_name) || peer.display_name;
      peer.public_keys = [
        { key_id: `k_${mockTokenHash(peer.peer_panel_id).slice(-16)}`, jwk: { kty: "OKP", crv: "Ed25519", x: "mock" } },
      ];
      peer.last_seen_at = nowIso();
      return ok({ ok: true, peer_id: peer.id, peer_panel_id: peer.peer_panel_id });
    }

    const peerId = parseId(seg[1]);
    if (peerId !== null) {
      const peer = findPeerById(state, peerId);
      if (!peer) return fedFail("peer_unknown", "未知的 peer", 404);

      if (method === "POST" && seg[2] === "ping") {
        if (peer.status === "revoked") return fedFail("peer_revoked", "该 peer 的信任已撤销", 403, peer.peer_panel_id);
        if (peer.status !== "active") {
          // 尚未完成握手的 peer：对端不认识我们的公钥（不是「网络不通」，也不是「信任被撤销」）
          return fedFail("key_unknown", "对端尚未建立信任（请先完成握手）", 401, peer.peer_panel_id);
        }
        if (isMockUnreachable(peer.endpoint_url)) {
          return fedFail("peer_unreachable", `无法连接 ${peer.endpoint_url}`, 502, peer.peer_panel_id);
        }
        peer.last_seen_at = nowIso();
        return ok({
          ok: true,
          peer_panel_id: peer.peer_panel_id,
          response: { ok: true, panel_id: `remote-${peer.peer_panel_id.slice(0, 8)}`, protocol_version: 1 },
        });
      }

      if (method === "POST" && seg[2] === "rotate") {
        return ok({ ok: true, key_id: state.key_id, notified: [peer.peer_panel_id] });
      }

      if (method === "DELETE" && seg[2] === undefined) {
        if (peer.status === "revoked") {
          return fedFail("peer_revoked", "该 peer 的信任已经撤销（不可逆）", 403, peer.peer_panel_id);
        }
        peer.status = "revoked";
        peer.revoked_at = nowIso();
        let revokedLeases = 0;
        for (const lease of state.leases) {
          if (lease.peer_panel_id !== peer.peer_panel_id) continue;
          if (!MOCK_LIVE_LEASE_STATES.includes(String(lease.state))) continue;
          lease.state = "revoked";
          lease.released_at = nowIso();
          revokedLeases += 1;
        }
        return ok({ ok: true, peer_panel_id: peer.peer_panel_id, revoked_leases: revokedLeases });
      }
    }
  }

  if (sub === "key" && seg[1] === "rotate" && method === "POST") {
    const notified: string[] = [];
    const failed: Array<{ peer_panel_id: string; code: string; message: string }> = [];
    for (const peer of state.peers) {
      if (peer.status !== "active") continue;
      if (isMockUnreachable(peer.endpoint_url)) {
        failed.push({
          peer_panel_id: peer.peer_panel_id,
          code: "peer_unreachable",
          message: `无法通知 ${peer.endpoint_url}`,
        });
      } else {
        notified.push(peer.peer_panel_id);
      }
    }
    const keyId = `k_${mockTokenHash(`${state.panel_id}:${nowIso()}`).slice(-16)}`;
    if (failed.length > 0) {
      // 与后端一致：HTTP 502，但响应体仍是 FederationKeyRotateResult（ok:false + 明细）
      return {
        status: 502,
        body: {
          ok: false,
          key_id: keyId,
          notified,
          failed,
          code: "peer_unreachable",
          message: "轮转失败：部分 peer 未接受新公钥",
          retryable: true,
          peer_panel_id: failed[0].peer_panel_id,
          correlation_id: "mock-key-rotate",
        },
      };
    }
    state.key_id = keyId;
    return ok({ ok: true, key_id: keyId, notified });
  }

  if (sub === "grants") {
    if (method === "GET" && seg[1] === undefined) return ok(state.grants.map(toGrantResponse));

    if (method === "POST" && seg[1] === undefined) {
      const body = asRecord(req.body);
      const peerPanelId = reqStr(body.peer_panel_id);
      if (!peerPanelId) return fedFail("message_malformed", "缺少 peer_panel_id", 400);
      const expiresIn = numOrNull(body.expires_in_seconds);
      if (expiresIn === null || !Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 30 * 24 * 3600) {
        return fedFail("message_malformed", "expires_in_seconds 非法", 400);
      }
      const scope = parseMockGrantScope(body.scope);
      if (!scope.ok) return fedFail("grant_scope_violation", scope.message, 403);
      const capacity = parseMockGrantCapacity(body.capacity);
      if (!capacity.ok) return fedFail("message_malformed", capacity.message, 400);

      const peer = findPeerByPanelId(state, peerPanelId);
      if (!peer || peer.status === "revoked") return fedFail("peer_unknown", "未知的 peer", 404);
      const live = liveLeasesOfPeer(state, peerPanelId).length;
      if (capacity.value.max_legs !== null && live >= capacity.value.max_legs) {
        return fedFail(
          "quota_exhausted",
          `该 peer 的 leg 配额已用尽（${live}/${capacity.value.max_legs}）`,
          429,
          peerPanelId,
        );
      }
      const grantRef = `g_${mockTokenHash(`${peerPanelId}:${state.grants.length}:${nowIso()}`).slice(-6)}`;
      const row: MockFederationGrantRow = {
        id: nextId(state.grants),
        grant_ref: grantRef,
        peer_id: peer.id,
        workspace_id: numOrNull(body.workspace_id),
        grant_epoch: 1,
        status: "active",
        scope: scope.value,
        capacity: capacity.value,
        quota_reserved: body.quota_reserved === true,
        expires_at: new Date(now().getTime() + expiresIn * 1000).toISOString(),
        revoked_at: null,
      };
      state.grants.push(row);
      return ok({
        ok: true,
        grant_ref: grantRef,
        grant_epoch: 1,
        status: "active",
        expires_at: row.expires_at,
        scope: row.scope,
        capacity: row.capacity,
      });
    }

    const grant = grantByRef(state, String(seg[1]));

    if (method === "POST" && seg[2] === "revoke") {
      if (!grant) return fedFail("grant_not_found", "未知的 grant", 404);
      if (grant.status === "revoked") {
        return ok({
          ok: true,
          already_revoked: true,
          grant_epoch: grant.grant_epoch,
          leases_revoked: 0,
          teardown_ok: 0,
          teardown_failed: 0,
          ports_released: 0,
          ports_pending: 0,
          quota_released: false,
          raced: 0,
        });
      }
      // 级联：先落 revoked 状态，再谈停服（与后端 cascadeRevokeLeases 的顺序一致）
      let revoked = 0;
      let released = 0;
      for (const lease of state.leases) {
        if (lease.grant_id !== grant.id) continue;
        if (!MOCK_LIVE_LEASE_STATES.includes(String(lease.state))) continue;
        lease.state = "revoked";
        lease.released_at = nowIso();
        revoked += 1;
        if (lease.listen_port !== null) released += 1;
      }
      grant.status = "revoked";
      grant.grant_epoch += 1;
      grant.revoked_at = nowIso();
      return ok({
        ok: true,
        already_revoked: false,
        grant_epoch: grant.grant_epoch,
        leases_revoked: revoked,
        teardown_ok: revoked,
        teardown_failed: 0,
        ports_released: released,
        ports_pending: 0,
        quota_released: grant.quota_reserved,
        raced: 0,
      });
    }

    if (method === "POST" && (seg[2] === "suspend" || seg[2] === "resume")) {
      if (!grant) return fedFail("grant_not_found", "未知的 grant", 404);
      const expiresAt = Date.parse(grant.expires_at);
      if (seg[2] === "suspend") {
        if (grant.status === "expired") return fedFail("grant_expired", "grant 已过期", 409);
        if (grant.status === "revoked") return fedFail("grant_not_active", "grant 已撤销", 409);
        if (grant.status === "suspended") {
          return ok({ ok: true, already_suspended: true, grant_epoch: grant.grant_epoch });
        }
        grant.status = "suspended";
        grant.grant_epoch += 1;
        return ok({ ok: true, already_suspended: false, grant_epoch: grant.grant_epoch });
      }
      if (grant.status === "revoked") return fedFail("grant_not_active", "grant 已撤销，不能恢复", 409);
      if (grant.status === "expired" || now().getTime() >= expiresAt) {
        // 不许「用恢复绕过过期」：续期必须新开 epoch（契约 §3.1）
        return fedFail("grant_expired", "grant 已过期，请新开一个授予", 409);
      }
      if (grant.status === "active") {
        return ok({ ok: true, already_suspended: false, grant_epoch: grant.grant_epoch });
      }
      grant.status = "active";
      grant.grant_epoch += 1;
      return ok({ ok: true, already_suspended: false, grant_epoch: grant.grant_epoch });
    }
  }

  if (sub === "leases" && method === "GET" && seg[1] === undefined) return ok(state.leases);
  if (sub === "placements" && method === "GET" && seg[1] === undefined) return ok(state.placements);
  if (sub === "usage" && method === "GET" && seg[1] === undefined) return ok(state.usage);

  return null;
}
