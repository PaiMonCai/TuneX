/**
 * 全链路租户作用域（TEN-02）—— Redis key 命名与隔离判定的**单一真相源**
 *
 * 「TEN-02 部分完成」缺的就是这一层：Socket room / 心跳 / 离线标记在别的分支
 * 上带过 `ws:<scope>` 前缀，而当前分支的 Redis 侧完全没有作用域——所有键都是
 * 裸名（`license` / `sysinfo:<gid>:<node>` / `node_group:config_hash` …）。
 * 裸名的后果是**两个租户的同 ID 资源撞在同一个键上**：workspace A 写入的
 * 心跳会让 workspace B 的离线判定短路，A 的配置指纹会挡住 B 组的下发。
 * MySQL 不提供行级自动隔离，因此租户边界必须以「统一命名 + 统一边界判定」
 * 在应用层兜底，且每一处读写都必须经过本模块——不允许在业务代码里手拼键名。
 *
 * ── 作用域 ID（scope）──
 *   · 普通资源：`scope = workspace_id`（正整数）；
 *   · 平台级资源（平台共享节点组等）：`scope = 0`（{@link GLOBAL_SCOPE}）。
 *   把 `null / undefined / 非法值` 一律折叠为 0，保证「无归属」不会被误当成
 *   某个真实租户——它只会落进 platform bucket，而 platform bucket 里的内容
 *   按定义就不含任何租户资产。
 *
 * ── v3（WP1）新增的节点侧资源 ──
 * `Node` / `EgressPool` / `EgressTarget` / `NodePortLease` **不带 workspace_id
 * 列**，归属沿 `Node → node_group → workspace_id` 单向上查。这类资源的 scope
 * 必须经 {@link nodeScope} 派生（唯一入口，见其注释），DB 侧只有一份归属真相。
 * 端口租约的 Redis NX 抢占锁见 {@link portLeaseLockKey}（协调用途，长期真相
 * 仍是 DB 的 `UNIQUE(node_id, port)`）。
 *
 * ── 隔离不变量 ──
 *   1. 任何**描述租户资产**的 key 都不能只带资源 id 而不带 scope；
 *   2. 键的解析（{@link parseScopedKey}）与生成必须同源，否则 worker 扫描时会
 *      读到别的租户的标记；
 *   3. Socket room 由「节点组 → 其 scope」派生，连接方无法自选 room。
 *
 * 本模块只含纯函数与常量，不 import db / redis，可在无依赖环境下单测。
 */

/** 平台级作用域（无 workspace 归属，如平台共享入口节点组）。 */
export const GLOBAL_SCOPE = 0;

/** 全局 key 前缀段（= `ws:global`）。 */
export const GLOBAL_SCOPE_TAG = "global";

/** scope 段位分隔符。 */
const SEP = ":";

/** 段内转义：`\` → `\\`、`:` → `\:`（保证任何业务值都不会伪造出新的段）。 */
function escapeSegment(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/** 反转义：`\\x` → `x`（escapeSegment 的逆，只处理其产生的两种序列）。 */
function unescapeSegment(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/** 按分隔符切分，尊重 `\` 转义（不能用正则 lookbehind：`\\` 会被误判）。 */
function splitEscaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === sep) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/* ================================================================== */
/* 作用域归一化                                                        */
/* ================================================================== */

/**
 * 把任意 workspace 归属折叠成合法 scope：
 * 正整数直接返回；`null / undefined / 非整数 / <=0` → {@link GLOBAL_SCOPE}。
 */
export function scopeId(workspaceId: number | null | undefined): number {
  return typeof workspaceId === "number" && Number.isInteger(workspaceId) && workspaceId > 0
    ? workspaceId
    : GLOBAL_SCOPE;
}

/** scope 的字符串前缀段：workspace id 或 `global`。 */
export function scopeTag(scope: number | null | undefined): string {
  const s = scopeId(scope);
  return s === GLOBAL_SCOPE ? GLOBAL_SCOPE_TAG : String(s);
}

/* ================================================================== */
/* 核心：scopedKey                                                     */
/* ================================================================== */

/**
 * **所有** Redis key 的统一入口：`ws:<scope>:<key...>`。
 *
 * - `scope` 为 workspace id（正整数）→ `ws:<id>:...`
 * - `scope` 为 0 / null / undefined / 非法 → `ws:global:...`（平台共享）
 * - segment 里的分隔符会被转义，避免调用方用业务值拼出跨段歧义的键
 *   （如 node_id 含冒号时把 `:offline` 段吞掉）。
 *
 * 为什么全局共享的 key 也要走这里：`ws:global:` 让「全局」成为一个**显式**
 * 的选择（调用方要显式传 0/不传），而不是恰好漏写了 scope 的结果——
 * 漏写 scope 与「这是全局键」在字符串上没有区别，这正是裸名时代的漏洞。
 */
export function scopedKey(
  scope: number | null | undefined,
  ...segments: Array<string | number>
): string {
  const parts = segments.map((s) => String(s)).filter((s) => s.length > 0);
  if (parts.length === 0) {
    // 只有 scope、没有资源段等于把整个 scope 桶当一个 key 用，必然误用。
    throw new Error("scopedKey: at least one resource segment is required");
  }
  const escaped = parts.map(escapeSegment);
  return ["ws", scopeTag(scope), ...escaped].join(SEP);
}

/** 从 {@link scopedKey} 生成的 key 反解出 scope 与资源段；非本形态返回 `null`。 */
export function parseScopedKey(
  key: string,
): { scope: number; segments: string[] } | null {
  const m = /^ws:(\d+|global):(.+)$/.exec(key);
  if (!m) return null;
  const scope = m[1] === GLOBAL_SCOPE_TAG ? GLOBAL_SCOPE : Number(m[1]);
  if (!Number.isInteger(scope) || scope < 0) return null;
  return {
    scope,
    segments: splitEscaped(m[2], SEP).map(unescapeSegment),
  };
}

/** 扫描 pattern：某 scope（缺省全部）下的某资源前缀。 */
export function scopedPattern(
  scope: number | null | undefined | "*",
  ...segments: Array<string | number>
): string {
  const tag = scope === "*" ? "*" : scopeTag(scope);
  const parts = segments.map((s) => String(s)).filter((s) => s.length > 0);
  return ["ws", tag, ...parts].join(SEP);
}

/* ================================================================== */
/* 节点组 / 节点资源 key                                               */
/* ================================================================== */

/** 节点组配置指纹（Redis hash；field = groupId，value = 明文 JSON 的 sha256）。 */
export function configHashKey(scope: number | null | undefined): string {
  return scopedKey(scope, "node_group", "config_hash");
}

/** 出口端口缓存（Redis hash；field = `${nodeId}:${type}`，value = 端口）。 */
export function outListenKey(scope: number | null | undefined): string {
  return scopedKey(scope, "tunnel", "out_listen");
}

/** 流量缓冲前缀（worker 归档时按此扫描，如 `${prefix}:<tunnelId>`）。 */
export function trafficBufferPrefix(scope: number | null | undefined): string {
  return scopedKey(scope, "tunnel", "traffic");
}

/**
 * 流量缓冲 hash 键：`ws:<scope>:tunnel:traffic:<tunnelId>`。
 * field = 本地计量日界 `YYYY-MM-DD`，value = 该日界累计字节（HINCRBYFLOAT）。
 * 与 {@link trafficBufferPrefix} 的区别：prefix 供 worker 全量 SCAN 用，
 * 本函数供「写入侧」（agent 上报）与「解析侧」（worker 逐键读）精确定位。
 */
export function trafficBufferKey(
  scope: number | null | undefined,
  tunnelId: number | string,
): string {
  return `${trafficBufferPrefix(scope)}:${escapeSegment(String(tunnelId))}`;
}

/** 解析 {@link trafficBufferKey}；非本模块形态返回 null。 */
export function parseTrafficBufferKey(
  key: string,
): { scope: number; tunnelId: string } | null {
  const parsed = parseScopedKey(key);
  if (!parsed) return null;
  const [kind, ...rest] = parsed.segments;
  if (kind !== "tunnel" || rest.length !== 2) return null;
  // 段位固定为 traffic:<tunnelId>（tunnelId 不可能含分隔符 —— 它是自增整数）
  if (rest[0] !== "traffic") return null;
  const tunnelId = rest[1]!;
  if (!/^\d+$/.test(tunnelId)) return null;
  return { scope: parsed.scope, tunnelId };
}

/** 观测回传缓冲（agent → 控制面，list）。 */
export function observerBufferKey(scope: number | null | undefined): string {
  return scopedKey(scope, "tunnel", "observer", "raw");
}

/** 活跃节点组集合（Redis set；成员 = groupId 字符串）。 */
export function aliveGroupsKey(scope: number | null | undefined): string {
  return scopedKey(scope, "alive_groups");
}

/**
 * 节点注册防爆破键。
 *
 * `node_group.token` 本身全局唯一（uuid），密钥自作用域：值只描述「这个
 * token 自己」，不描述别的租户资产，因此放在 global 段。
 */
export function registerBlockKey(nodeToken: string): string {
  return scopedKey(GLOBAL_SCOPE, "register_block", nodeToken);
}

/**
 * 节点心跳键：`ws:<scope>:node:<groupId>:<nodeId>:heartbeat`。
 * scope 使「同 ID 节点组」不会跨租户共享心跳状态。
 */
export function heartbeatKey(
  scope: number | null | undefined,
  groupId: number,
  nodeId: string,
): string {
  return scopedKey(scope, "node", groupId, nodeId, "heartbeat");
}

/** 心跳键扫描 pattern（与 {@link heartbeatKey} 同源，勿手拼）。 */
export function heartbeatPattern(scope?: number | null): string {
  return scopedPattern(scope ?? "*", "node", "*", "*", "heartbeat");
}

/** 解析心跳键；非本模块形态返回 `null`。 */
export function parseHeartbeatKey(
  key: string,
): { scope: number; groupId: number; nodeId: string } | null {
  const parsed = parseScopedKey(key);
  if (!parsed) return null;
  const [kind, groupRaw, ...rest] = parsed.segments;
  if (kind !== "node" || !/^\d+$/.test(groupRaw) || rest.length < 1) return null;
  // 末段必须是 heartbeat（node_id 可能含冒号，已由 parseScopedKey 还原）
  if (rest[rest.length - 1] !== "heartbeat") return null;
  const nodeId = rest.slice(0, -1).join(":");
  if (nodeId.length === 0) return null;
  return { scope: parsed.scope, groupId: Number(groupRaw), nodeId };
}

/**
 * 离线标记键：`ws:<scope>:node:<groupId>:<nodeId>:offline`。
 * 保留 `:offline` 末段，使 worker 仍可一次扫全部租户（{@link offlinePattern}）。
 */
export function disconnectMarkerKey(
  scope: number | null | undefined,
  groupId: number,
  nodeId: string,
): string {
  return scopedKey(scope, "node", groupId, nodeId, "offline");
}

/** 离线标记扫描 pattern（跨租户；scope 由解析器还原）。 */
export function offlinePattern(scope?: number | null): string {
  return scopedPattern(scope ?? "*", "node", "*", "*", "offline");
}

/** 解析离线标记键；非本模块形态返回 `null`。 */
export function parseDisconnectMarkerKey(
  key: string,
): { scope: number; groupId: number; nodeId: string } | null {
  const parsed = parseScopedKey(key);
  if (!parsed) return null;
  const [kind, groupRaw, ...rest] = parsed.segments;
  if (kind !== "node" || !/^\d+$/.test(groupRaw) || rest.length < 1) return null;
  if (rest[rest.length - 1] !== "offline") return null;
  const nodeId = rest.slice(0, -1).join(":");
  if (nodeId.length === 0) return null;
  return { scope: parsed.scope, groupId: Number(groupRaw), nodeId };
}

/** Socket.IO room 名：`ws:<scope>:node_group/<groupId>`。 */
export function socketRoom(scope: number | null | undefined, groupId: number): string {
  return `ws:${scopeTag(scope)}:node_group/${groupId}`;
}

/**
 * 解析 `ws:<scope>:node_group/<groupId>` room 名（测试/审计用）。
 * 非该形态返回 `null`。
 */
export function parseSocketRoom(room: string): { scope: number; groupId: number } | null {
  const m = /^ws:(\d+|global):node_group\/(\d+)$/.exec(room);
  if (!m) return null;
  const scope = m[1] === GLOBAL_SCOPE_TAG ? GLOBAL_SCOPE : Number(m[1]);
  return { scope, groupId: Number(m[2]) };
}

/* ================================================================== */
/* 节点组可见性 / 可管理性                                             */
/* ================================================================== */

/** 判定节点组作用域所需的最小字段。 */
export interface GroupScopeRow {
  id: number;
  workspace_id: number | null;
  /** 平台共享节点组（对普通 workspace 只读可用）。缺省视为 false。 */
  is_shared?: boolean | null;
}

/**
 * 节点组是否可被某 workspace **使用**（用于建隧道时选择入/出组）：
 *   · 平台共享组（`is_shared`）—— 任何 workspace 可用；
 *   · 否则必须是该 workspace 自有（`workspace_id === wsId`）。
 */
export function isGroupUsableByWorkspace(group: GroupScopeRow, wsId: number): boolean {
  if (group.is_shared === true) return true;
  return group.workspace_id !== null && group.workspace_id === wsId;
}

/**
 * 节点组是否由某 workspace **拥有并可管理**（用户侧无管理入口；
 * 供校验「不能拿别人的私有组」/审计使用）：自有且非平台共享。
 */
export function isGroupOwnedByWorkspace(group: GroupScopeRow, wsId: number): boolean {
  if (group.is_shared === true) return false;
  return group.workspace_id !== null && group.workspace_id === wsId;
}

/** 节点组可用性判定结果。 */
export type GroupUsability = "own" | "shared" | "cross_tenant";

/**
 * 分类节点组对某 workspace 的关系：
 *   · `own`          —— 该 workspace 自有；
 *   · `shared`       —— 平台共享（只读可用）；
 *   · `cross_tenant` —— 别的租户私有组 → **必须拒绝**（越权探针的核心断言）。
 */
export function classifyGroupForWorkspace(
  group: GroupScopeRow,
  wsId: number,
): GroupUsability {
  if (group.is_shared === true) return "shared";
  if (group.workspace_id !== null && group.workspace_id === wsId) return "own";
  return "cross_tenant";
}

/**
 * 解析一个节点组应使用的 scope：平台共享 → {@link GLOBAL_SCOPE}；
 * 否则其 workspace_id（无归属亦折叠为 0）。
 */
export function groupScope(
  group: Pick<GroupScopeRow, "workspace_id" | "is_shared">,
): number {
  return group.is_shared === true ? GLOBAL_SCOPE : scopeId(group.workspace_id);
}

/* ================================================================== */
/* v3 节点侧资源作用域（WP1）                                          */
/* ================================================================== */

/**
 * v3 节点侧资源（{@link Node} / `EgressPool` / `EgressTarget` / `NodePortLease`）
 * 应使用的 scope。
 *
 * 这四张表**都没有 workspace_id 列**：归属沿
 * `Node → node_group → workspace_id` 单向上查，DB 里只存一份归属真相，
 * 避免「冗余列与真相列漂移」这类经典不一致。因此所有派生位置的 scope 必须
 * 经由本函数统一解析，不允许各处自己读 `node.node_group.workspace_id`。
 *
 * 输入只要求带 node_group 的最小投影，便于调用方在 `select` 里只取需要的列。
 */
export function nodeScope(
  node: {
    node_group?: Pick<GroupScopeRow, "workspace_id" | "is_shared"> | null;
  },
): number {
  return groupScope(node.node_group ?? { workspace_id: null });
}

/**
 * 端口租约快速抢占锁（§5.1）：`ws:<scope>:node_port_lease:lock:<nodeId>:<port>`。
 *
 * DEVELOPMENT.md §5.1：物理唯一性的最终真相是 DB 的 `UNIQUE(node_id, port)`，
 * Redis NX 只做**快速并发抢占/短事务协调**，不作为长期唯一真相源。因此：
 *   · 抢到锁 ≠ 拿到端口（DB insert 仍可能因唯一键失败，那是正常路径）；
 *   · 锁必须有 TTL（进程崩溃不能永久阻塞分配）；
 *   · 锁丢失后由 DB unique 兜底，不允许「锁没了就把已有 lease 判为孤儿」。
 *
 * scope 让两个租户的同 ID 节点不会在同一个物理端口上互抢。
 */
export function portLeaseLockKey(
  scope: number | null | undefined,
  nodeId: string,
  port: number,
): string {
  return scopedKey(scope, "node_port_lease", "lock", nodeId, port);
}

/** 租约锁扫描 pattern（跨租户；WP3 reconciler 对账用）。 */
export function portLeaseLockPattern(scope?: number | null): string {
  return scopedPattern(scope ?? "*", "node_port_lease", "lock", "*", "*");
}

/** 解析 {@link portLeaseLockKey}；非本模块形态返回 `null`。 */
export function parsePortLeaseLockKey(
  key: string,
): { scope: number; nodeId: string; port: number } | null {
  const parsed = parseScopedKey(key);
  if (!parsed) return null;
  // 段位固定为 lock:<nodeId...>:<port>：末段必须是端口，其余拼回 nodeId
  const [kind, lock, ...rest] = parsed.segments;
  if (kind !== "node_port_lease" || lock !== "lock" || rest.length < 2) return null;
  const port = rest[rest.length - 1];
  if (!/^\d+$/.test(port)) return null;
  const nodeId = rest.slice(0, -1).join(":");
  if (nodeId.length === 0) return null;
  return { scope: parsed.scope, nodeId, port: Number(port) };
}

/**
 * v3 节点注册防爆破键（按 node credential，WP7）。
 *
 * 与 {@link registerBlockKey}（节点组 token，全局唯一、已隐含归属）的区别：
 * 节点凭据的爆破防护发生在**身份解析之前**，此时还不知道节点属于哪个
 * workspace，只能按凭据指纹自作用域——值只描述「这次失败尝试」，不描述
 * 任何租户资产，故放 global 段。
 */
export function nodeRegisterBlockKey(credentialFingerprint: string): string {
  return scopedKey(GLOBAL_SCOPE, "node_register_block", credentialFingerprint);
}

/* ================================================================== */
/* 隧道作用域                                                          */
/* ================================================================== */

/**
 * 隧道是否属于某 workspace。用于列表/详情/变更的强制 where。
 * `workspace_id` 为 null 的历史/无归属记录**不**归属任何租户（fail-closed）。
 */
export function tunnelBelongsToWorkspace(
  tunnel: { workspace_id: number | null },
  wsId: number,
): boolean {
  return tunnel.workspace_id !== null && tunnel.workspace_id === wsId;
}
