/**
 * Agent command-capability negotiation.
 *
 * Stored state reports describe which command actions an Agent implements.
 * Missing capability facts are treated according to the compatibility baseline;
 * explicit unsupported actions fail closed with an upgrade-required reason.
 */

 *  —— 控制协议能力协商（纯函数，无 IO）。
 *
 * 这一层回答一个问题：**这个节点现在能不能收到这个动作？**
 *
 * ── 为什么需要协商 ──
 * 面板与 Agent 的版本独立滚动：面板先升级、节点稍后才换镜像，是常态。没有
 * 协商时，面板对"新动作"只有两种选择，两种都错：
 *   · 假设旧 Agent 能执行 → 发出一条它不认识、也不会 ACK 的命令，节点侧只能
 *     回 `unsupported_action`，面板把超时当成网络问题，排障方向从一开始就错；
 *   · 假设旧 Agent 不能执行 → 升级窗口内所有旧节点立刻停止收命令，把一次
 *     平滑升级变成一次全网中断。
 * 所以协商必须能表达第三种状态：**"这个 Agent 还没告诉我"**。
 *
 * ── 两种"没有能力"必须区分 ──
 *   `capabilities` 缺失（旧 Agent 从未上报）
 *       → 按 baseline 处理：协议冻结时就存在的动作继续可用，
 *         baseline 以外的新动作一律拒绝（升级提示）。
 *   `capabilities` 存在但坏形状 / 不含该动作
 *       → fail-closed：连 baseline 动作也不再假设支持，明确要求升级。
 * 把两者混为一谈，就会在上面两个错误里二选一。
 *
 * ── 能力不是授权 ──
 * 这里的判定只回答"对端实现了没有"。它**不**参与工作空间 RBAC、资源作用域、
 * 能力策略或额度判定（§13.5 五层里的第 5 层 Runtime Admission 的一个子条件）。
 * Agent 自报的能力绝不能用来授予任何权限：它是节点对自己实现的描述。
 */

/** 控制协议版本：面板当前实现的版本。 */
export const CONTROL_PROTOCOL_VERSION = 1;

/**
 * 协议冻结时就已经存在的动作。
 *
 * 这些动作在  之前就随 / 的 Agent 发布，因此"未上报能力"的旧
 * Agent 必须继续被认为支持它们——否则升级期间整批旧节点会被拒绝下发。
 *
 * 新增动作（诊断、drain、升级……）**不在**此表内：它们必须被明确上报，
 * 未上报即视为不支持（这就是协商的全部意义）。
 */
export const BASELINE_COMMAND_ACTIONS = ["apply_tunnel", "remove_tunnel", "suspend_tunnel"] as const;

/** 单个能力名的长度上限（Agent 侧是编译期常量，这里的限制只为防御坏载荷）。 */
export const CAPABILITY_NAME_MAX_CHARS = 64;

/** 一次上报最多接受多少条能力（防止把状态上报变成任意大数组）。 */
export const CAPABILITY_MAX_ITEMS = 32;

/** 面板对某个动作的能力判定结果。 */
export type CapabilityDecision =
  | { supported: true; basis: "advertised" | "baseline" }
  | { supported: false; reason: "incompatible_agent" | "upgrade_required"; detail: string };

/**
 * 规范化 Agent 上报的能力清单。
 *
 * 返回值刻意区分三种输入：
 *   · `null`  —— 该字段**缺失**（旧 Agent）→ 调用方按 baseline 处理；
 *   · `[]`    —— 字段存在但没有可用条目（含空数组）→ "什么都不支持"；
 *   · `[...]` —— 去重、排序后的清单。
 *
 * 坏形状（不是数组、元素不是字符串、超长、超量）**抛错**而不是静默丢弃：
 * 静默丢弃会把"Agent 报了个坏清单"变成"Agent 什么都没报"，从而把 fail-closed
 * 悄悄降级成 baseline 放行——那是安全方向的错误。
 */
export function normalizeCapabilities(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new TypeError("capabilities must be an array of strings");
  }
  if (value.length > CAPABILITY_MAX_ITEMS) {
    throw new TypeError(`capabilities has more than ${CAPABILITY_MAX_ITEMS} items`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") throw new TypeError("capabilities entries must be strings");
    const name = entry.trim();
    if (name === "" || name.length > CAPABILITY_NAME_MAX_CHARS) {
      throw new TypeError("capabilities entry is empty or too long");
    }
    seen.add(name);
  }
  return [...seen].sort();
}

/** Agent 上报的控制协议版本；缺失 → null（未上报），坏值 → 抛错。 */
export function normalizeProtocolVersion(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError("control_protocol_version must be a non-negative integer");
  }
  return value;
}

/**
 * 一个节点的协商事实。`capabilities === null` 表示"该 Agent 未上报"，
 * 必须与空数组区分开。
 */
export interface AgentCapabilityFacts {
  capabilities: string[] | null;
  protocolVersion: number | null;
}

/**
 * 把「库里存的一行」折算成可用的协商事实。
 *
 * 这里守的是一条容易被忽略、但方向很危险的规则：**重装会让上报过期**。
 *
 * 节点重装（重新 enrollment / 轮换凭据）时 agent_id 与 node_id 都不变，因此
 * 状态上报行会**保留**——可重装完全可能把节点换成一个更旧或不同构建的 Agent
 * 二进制。此时库里那份 "capabilities" 描述的是**上一个进程**，而它可能比现在
 * 跑的二进制"支持"更多动作。拿它去放行，就等于向一个不认识该动作的 Agent 下发
 * 命令（正是 §13.5 禁止的"未知命令猜测"）。
 *
 * 判据：当前凭据是在最后一次上报**之后**签发的 ⇒ 那份上报属于上一个进程 ⇒
 * 当作「未上报」处理。结果是 baseline 动作照常（不制造升级中断），baseline 以外
 * 的动作被拒（fail-closed）。短暂窗口后 Agent 会重新上报，能力随即恢复。
 */
export function capabilityFactsFromStored(row: {
  control_protocol_version?: number | null;
  capabilities?: unknown;
  reported_at?: Date | string | null;
  credential_rotated_at?: Date | string | null;
} | null | undefined): AgentCapabilityFacts | null {
  if (!row) return null;
  const reportedAt = toTime(row.reported_at);
  const rotatedAt = toTime(row.credential_rotated_at);
  if (reportedAt !== null && rotatedAt !== null && reportedAt <= rotatedAt) {
    // The advertisement predates the credential this node is using now, so it
    // describes a process that is no longer running.
    return null;
  }
  return {
    protocolVersion: normalizeProtocolVersion(row.control_protocol_version),
    // 形状坏 → 抛错（由调用方转成拒绝），绝不静默变成"未上报"。
    capabilities: normalizeCapabilities(row.capabilities),
  };
}

function toTime(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/** 判定某动作是否可下发。纯函数：调用方负责提供**新鲜且归属正确**的事实。 */
export function decideCapability(facts: AgentCapabilityFacts | null | undefined, action: string): CapabilityDecision {
  const name = String(action ?? "").trim();
  if (name === "") {
    return { supported: false, reason: "incompatible_agent", detail: "action is required" };
  }
  const baseline = (BASELINE_COMMAND_ACTIONS as readonly string[]).includes(name);

  // 没有任何上报事实（没有行 / 读不到）：只有当动作属于 baseline 时才放行。
  // 这不是"假设旧 Agent 支持新动作"，而是"不给升级窗口制造中断"。
  if (!facts) {
    return baseline
      ? { supported: true, basis: "baseline" }
      : { supported: false, reason: "upgrade_required", detail: `节点尚未上报控制协议能力，无法下发 ${name}` };
  }

  if (facts.capabilities === null) {
    return baseline
      ? { supported: true, basis: "baseline" }
      : { supported: false, reason: "upgrade_required", detail: `节点 Agent 未上报控制协议能力，无法下发 ${name}` };
  }

  if (facts.capabilities.includes(name)) {
    return { supported: true, basis: "advertised" };
  }

  // 字段存在但不含该动作：Agent 明确描述了自己的实现，就按它说的办。
  return {
    supported: false,
    reason: baseline ? "incompatible_agent" : "upgrade_required",
    detail: `当前 Agent 未实现 ${name}（已上报 ${facts.capabilities.length} 项能力）`,
  };
}

/**
 * 把判定结果转成可以直接进 HTTP 响应的错误体。
 *
 * `error_layer` 固定 `runtime_admission`：这些拒绝不属于 RBAC，也不属于额度，
 * 而是"这一层运行条件不满足"（§13.5 的错误码分层要求）。
 */
export function capabilityErrorBody(decision: Extract<CapabilityDecision, { supported: false }>) {
  return {
    error: decision.detail,
    code: decision.reason,
    error_layer: "runtime_admission" as const,
    condition: decision.reason,
  };
}
