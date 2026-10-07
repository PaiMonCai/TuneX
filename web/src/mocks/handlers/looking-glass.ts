/**
 * Looking Glass mock（与真后端**同路径、同形状、同拒绝顺序**）。
 *
 * 唯一真相是 `backend/src/routes/looking-glass.ts` + `services/looking-glass.ts`（拒绝顺序在
 * `runLookingGlass`：开关 → 节点归属 → 方法/超时 → 目标写法与公网判定 → 单飞 → 能力协商 → 审计 → 下发）。
 *
 * ── 为什么这个 mock 会"拒绝成功" ──
 * 真机发起测试会让**那台 Agent** 真的拨目标，再由面板把结果归一后回给调用者。mock 环境里
 * **没有 Agent、没有节点**，因此它**不可能**产生一次真实拨号的结果。于是：
 *   · 所有**发包之前**的拒绝（开关/归属/方法/超时/目标校验/单飞）逐条镜像 —— 这些是纯校验，
 *     镜像得越准越有用；
 *   · 一旦走到"下发"，mock 如实返回 `502 agent_failed`（"mock 环境没有可下发命令的 Agent：
 *     不伪造探测结果"）。**绝不**编一个 `reachable`：那会把"没测过"演成"连上了"。
 * 需要看成功的报告长什么样，用真实拓扑（真机 `POST` 一次即可，结果形状见本文件的类型注释）。
 *
 * 状态挂 `WeakMap<Store, …>`：`resetStore()` 换对象即归零，不必改 `mocks/state.ts`。
 */
import * as rt from "../runtime";
import type { MockResponse, Store } from "../runtime";

const { asRecord, fail, numOrNull, ok, parseId, reqStr } = rt;

/* 与后端 `services/looking-glass.ts` 逐字一致的上限与开关名 */
const ENABLED_ENV = "LOOKING_GLASS_ENABLED";
// task-42：方法闭集扩到 5 种（tcp_connect + ICMP echo + 无特权路径跟踪）。
const METHODS = ["tcp_connect", "ping", "ping6", "traceroute", "traceroute6"];
/** 本版本**明确不提供**的方法 + 原因（与后端 `LOOKING_GLASS_UNAVAILABLE_METHODS` 同源）。 */
const UNAVAILABLE_METHODS = [
  {
    method: "mtr",
    reason:
      "镜像里没有 mtr 二进制；且 mtr 默认需要 raw socket（CAP_NET_RAW），生产 caps 下不可用 —— 所以我们不做它，而不是假装支持",
  },
  { method: "mtr6", reason: "同 mtr：无二进制 + 依赖 raw socket（CAP_NET_RAW）" },
];
const MAX_TARGETS = 4;
const MAX_PINNED_ADDRESSES = 4;
const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 5000;

/** 后端 `LOOKING_GLASS_CAVEATS` 的**原文**（mock 与服务端同源：这些是要照实回给界面的口径声明）。 */
const CAVEATS = [
  "这是从该节点发出的主动探测（tcp_connect / ping / ping6）：连上或收到回包只证明 L3/L4 可达，不证明对端业务可用。",
  "域名由面板解析、节点只拨固定地址：因此它不能回答「节点侧 DNS 能否解析该域名」。",
  "ping/ping6 由节点在容器内调用镜像自带的 ping 二进制（非特权 ICMP），依赖节点内核允许非特权 ICMP；ping6 还需要节点自身有 IPv6 出网路径 —— 没有时结果是 unreachable，那不是方法未实现。",
  "traceroute / traceroute6 由节点调用 iputils 的 tracepath 实现（非特权：UDP 探测 + ICMP 超时回包），因此没有放开 CAP_NET_RAW；目标家族没有出网路径时它是 send failed，属真实网络事实。",
  "不含 mtr / mtr6：镜像里没有该二进制，且它默认需要 raw socket（CAP_NET_RAW）—— 生产安装用 --cap-drop ALL --cap-add NET_BIND_SERVICE。（busybox 的 traceroute 同样因 raw socket 被拒，我们用它之外的无特权路径。）",
  "不含 UDP：datagram 没有可靠探测来源，本版本不产生该事实。",
  "不含 HTTP：重定向/降级/凭据是另一份威胁模型，本版本不做。",
  "结果不含任何数据面载荷与凭据；每次发起与拒绝都会写审计。",
];

/** 私网/回环/链路本地/多播/保留段（mock 只做**判定所需**的常用段，够拦住开发期的误用）。 */
const NON_PUBLIC_PREFIXES: Array<[string, string]> = [
  ["10.", "10.0.0.0/8 私网"],
  ["127.", "127.0.0.0/8 环回"],
  ["192.168.", "192.168.0.0/16 私网"],
  ["169.254.", "169.254.0.0/16 链路本地"],
  ["224.", "224.0.0.0/4 多播"],
  ["0.", "0.0.0.0/8 保留"],
  ["100.64.", "100.64.0.0/10 运营商级 NAT"],
  ["172.16.", "172.16.0.0/12 私网"],
  ["172.17.", "172.16.0.0/12 私网"],
  ["172.18.", "172.16.0.0/12 私网"],
  ["172.19.", "172.16.0.0/12 私网"],
  ["172.2", "172.16.0.0/12 私网"],
  ["172.30.", "172.16.0.0/12 私网"],
  ["172.31.", "172.16.0.0/12 私网"],
];

interface MockLookingGlassState {
  /** 单飞：node id → 上一次发起的时刻（毫秒）。真机用 30s TTL 的锁。 */
  inflight: Map<number, number>;
}

const STORES = new WeakMap<Store, MockLookingGlassState>();

function stateOf(db: Store): MockLookingGlassState {
  let state = STORES.get(db);
  if (!state) {
    state = { inflight: new Map() };
    STORES.set(db, state);
  }
  return state;
}

function nonPublicReason(host: string): string | null {
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return "特殊用途域名（非公网可解析）";
  }
  for (const [prefix, label] of NON_PUBLIC_PREFIXES) {
    if (host.startsWith(prefix)) return label;
  }
  return null;
}

function invalid(message: string, code: string, errorLayer = "runtime_admission"): MockResponse {
  return { status: 400, body: { error: message, code, error_layer: errorLayer } };
}

/**
 * mock 环境里"能不能对该节点下发"的一个诚实答案：只有**演示节点**存在，且没有 Agent 在跑。
 * 所以走到下发这一步一律 502 `agent_failed`（真机对应 `issueAgentLookingGlass` 的失败分支）。
 */
function agentUnavailable(nodeKey: string): MockResponse {
  return {
    status: 502,
    body: {
      error: `mock 环境没有可下发命令的 Agent（节点 ${nodeKey}）：本 mock 不伪造探测结果`,
      code: "agent_failed",
      error_layer: "runtime_admission",
    },
  };
}

export async function handleLookingGlassMock(ctx: rt.MockAuthedRouteContext): Promise<MockResponse | null> {
  const { method, seg, db, user, req, scopeId } = ctx;
  if (seg[0] !== "looking-glass") return null;
  const state = stateOf(db);

  /* ---------------- GET /api/looking-glass/status ---------------- */
  if (seg[1] === "status" && method === "GET") {
    /**
     * 与真机缺省一致：**关闭**（真机 `LOOKING_GLASS_ENABLED` 未设置）。
     * 平台的开关是环境变量，mock 无法读它，因此这里固定 `false` —— 这正是本部署的真实样子；
     * 想演示"已开启"的界面分支，用组件/纯函数测试（`lookingGlassPhase`）而不是让 mock 撒谎。
     */
    return ok({
      enabled: false,
      switch_env: ENABLED_ENV,
      platform_admin_override: user.super_admin === true,
      method: METHODS[0],
      caps: {
        max_targets: MAX_TARGETS,
        max_pinned_addresses: MAX_PINNED_ADDRESSES,
        default_timeout_ms: DEFAULT_TIMEOUT_MS,
        max_timeout_ms: MAX_TIMEOUT_MS,
        methods: [...METHODS],
        unavailable_methods: UNAVAILABLE_METHODS.map((entry) => ({ ...entry })),
      },
      targets: "public-only（私网/回环/链路本地/多播/保留段一律拒绝）",
      caveats: CAVEATS,
    });
  }

  /* ---------------- POST /api/looking-glass/nodes/:id/tests ---------------- */
  if (seg[1] === "nodes" && seg[3] === "tests" && method === "POST") {
    /**
     * 与真机同一道门：这条路由挂 `resolveWorkspaceAccess(c, "read", "node")`
     * ⇒ 不是本工作空间成员 = 404；是成员但角色没有 `node:read` = 403。
     * mock 若跳过这道门，"没权限"在开发期就永远看不到（正是本专项反复修的"mock 骗人"）。
     */
    const membership = db.workspaceMembers.find(
      (row) => row.workspace_id === scopeId && row.user_id === user.id && row.active,
    );
    if (!membership) {
      return { status: 404, body: { error: "工作空间不存在", code: "not_found", error_layer: "resource_scope" } };
    }
    const grants = rt.mockEffectivePermissions(db, membership);
    if (grants.permissions["node:read"] !== true) {
      return { status: 403, body: { error: "当前工作空间角色无权读取节点", code: "permission_denied", error_layer: "capability" } };
    }
    const nodeId = parseId(seg[2]);
    if (nodeId === null) {
      return { status: 404, body: { error: "节点不存在", code: "not_found", error_layer: "resource_scope" } };
    }
    // ① 开关：mock 的部署是关闭的 ⇒ 非管理员 403（管理员例外放行，与真机 `decideLookingGlassEntry` 一致）。
    if (user.super_admin !== true) {
      return {
        status: 403,
        body: {
          error: `Looking Glass 在本部署未启用（未设置 ${ENABLED_ENV}=true）：功能默认关闭，请联系管理员开启`,
          code: "looking_glass_disabled",
          error_layer: "capability",
        },
      };
    }
    // ② 节点归属（mock 的节点是跨作用域演示数据：只校验节点存在，与服务端"属于本工作空间"等价的最小面）。
    const node = db.nodes.find((row) => row.id === nodeId);
    if (!node) {
      return { status: 404, body: { error: "节点不存在", code: "not_found", error_layer: "resource_scope" } };
    }
    const body = asRecord(req.body);
    // ③ 方法：只支持 tcp_connect（未知方法拒绝，不降级）。
    const requestedMethod = reqStr(body.method);
    if (requestedMethod !== "" && !METHODS.includes(requestedMethod)) {
      return invalid(`本版本不提供方法 ${requestedMethod}（未知方法拒绝，不降级）`, "method_not_supported");
    }
    // ④ 超时范围。
    const rawTimeout = body.timeout_ms;
    if (rawTimeout !== undefined && rawTimeout !== null) {
      const timeout = numOrNull(rawTimeout);
      if (timeout === null || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
        return invalid(`timeout 必须是 1-${MAX_TIMEOUT_MS} 的整数毫秒`, "timeout_out_of_range");
      }
    }
    // ⑤ 目标写法与公网判定（顺序与措辞尽量贴后端，界面据此给"为什么/下一步"）。
    const rawTargets = body.targets;
    if (!Array.isArray(rawTargets)) return invalid("至少需要一个目标", "too_many_targets");
    if (rawTargets.length === 0) return invalid("至少需要一个目标", "too_many_targets");
    if (rawTargets.length > MAX_TARGETS) {
      return invalid(`一次最多 ${MAX_TARGETS} 个目标（超限拒绝，不截断）`, "too_many_targets");
    }
    const seen = new Set<string>();
    for (const entry of rawTargets) {
      const row = asRecord(entry);
      const host = reqStr(row.host);
      const port = numOrNull(row.port);
      if (row === null || typeof row !== "object" || host === "" || typeof row.host !== "string") {
        return invalid("目标必须是 {host, port} 对象", "invalid_hostname");
      }
      if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) {
        return invalid("端口必须是 1-65535 的整数", "invalid_port");
      }
      const key = `${host.toLowerCase()}:${port}`;
      if (seen.has(key)) return invalid(`重复目标 ${key}`, "duplicate_target");
      seen.add(key);
      const reason = nonPublicReason(host.toLowerCase());
      if (reason !== null) {
        return invalid(`目标地址不属于公网单播（命中保留段 ${reason}）`, "target_not_public");
      }
    }
    // ⑥ 单飞：同一节点同一时刻至多一个（真机是 30s TTL 的锁）。
    const held = state.inflight.get(nodeId);
    const now = Date.now();
    if (held !== undefined && now - held < 30_000) {
      return {
        status: 409,
        body: {
          error: `该节点已有一个测试在途（${Math.trunc((now - held) / 1000)}s）：同一节点同一时刻至多一个测试`,
          code: "looking_glass_busy",
          error_layer: "runtime_admission",
        },
      };
    }
    state.inflight.set(nodeId, now);
    // ⑦ 下发：mock 没有 Agent ⇒ 如实 502，**不伪造**任何结果行。
    return agentUnavailable(node.node_id);
  }

  return null;
}
