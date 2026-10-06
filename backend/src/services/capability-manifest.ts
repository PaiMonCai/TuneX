/**
 * Agent runtime capability manifest.
 *
 * Action capability and runtime capability are orthogonal: the former answers
 * whether an Agent can execute a command action; this manifest answers which
 * product protocols/transports/runtime features it actually implements.
 *
 * Missing manifests use the frozen compatibility baseline. Explicitly advertised
 * absence fails closed. Unknown future manifest schema versions are never guessed.
 */

import type { AgentCapabilityFacts } from "./agent-capability.ts";
import {
  capabilityFactsFromStored,
  normalizeProtocolVersion,
} from "./agent-capability.ts";
import { FORWARD_PROTOCOLS, FORWARD_TRANSPORTS } from "./forward-contract.ts";

/* ================================================================== */
/* 协议常量                                                            */
/* ================================================================== */

/**
 * `capability_manifest` 的 schema 版本。
 *
 * 面板只认这一个值。更高（或更低）的版本不是「坏形状」，而是**不可读**：
 * Unknown future schema versions are treated as unavailable rather than guessed.
 * ——baseline TCP 继续跑（不制造全网中断），baseline 以外一律拒绝。
 * 反过来把一个更新版 Agent 判成 malformed 并 fail-closed 全部动作，会让一次
 * Agent 灰度升级变成整批节点停摆，方向恰好错反。
 */
export const CAPABILITY_MANIFEST_SCHEMA_VERSION = 2;

/** 单个能力名长度上限（与 V4 action 能力同一上限，防御坏载荷）。 */
export const MANIFEST_ITEM_MAX_CHARS = 64;

/** 每个维度最多接受多少条（防止把状态上报变成任意大数组）。 */
export const MANIFEST_MAX_ITEMS = 32;

/**
 * runtime 特性清单：Agent 侧**已经编译进去**的运行时行为。
 *
 * 只描述「这台 Agent 的 runtime 实现了这个行为」，与套餐、RBAC 无关。
 */
export const MANIFEST_RUNTIME_FEATURES = [
  /** 已运行隧道的配置热替换（换 upstream 不重建 listener）。 */
  "hot_reload",
  /** 有界优雅关机：停新连接 → 排空 → 收敛。 */
  "graceful_drain",
  /** 面板中断时从本地 last-known-good 快照恢复。 */
  "lkg_restore",
] as const;
export type ManifestRuntimeFeature = (typeof MANIFEST_RUNTIME_FEATURES)[number];

/**
 * 诊断特性清单（**观测用**）。
 *
 * 注意：诊断的**下发准入**不在这里判定。它继续由 V4 的
 * {@link decideCapability}（动作维度）决定，否则同一件事会有两套真相
 * ——manifest 说支持、actions 里却没有 diagnose_tunnel，面板就会向一个不会
 * 应答的 Agent 发命令。这里的 diagnostics 只用于展示与 Support Bundle。
 */
export const MANIFEST_DIAGNOSTIC_FEATURES = ["tunnel_probe", "node_snapshot"] as const;
export type ManifestDiagnosticFeature = (typeof MANIFEST_DIAGNOSTIC_FEATURES)[number];

/* ================================================================== */
/* 契约形状                                                            */
/* ================================================================== */

/** Agent 上报的 v2 能力清单。所有列表都是**已规范化**的（去重 + 排序）。 */
export interface CapabilityManifest {
  schema_version: number;
  protocols: string[];
  transports: string[];
  runtime: string[];
  diagnostics: string[];
}

/**
 * Baseline: combinations that predate explicit runtime capability reporting.
 *
 * 未上报 manifest 的旧 Agent 必须继续被认为支持它们——否则升级窗口内所有旧
 * 节点立刻停止收命令，把一次平滑升级变成一次全网中断。baseline 之外的新组合
 * （UDP / TLS / WS / QUIC、未来的 runtime 特性）**必须**被明确上报。
 */
export const BASELINE_PROTOCOLS: readonly string[] = ["tcp"];
export const BASELINE_TRANSPORTS: readonly string[] = ["stream"];
export const BASELINE_RUNTIME_FEATURES: readonly string[] = [
  "hot_reload",
  "graceful_drain",
  "lkg_restore",
];

/* ================================================================== */
/* 规范化                                                              */
/* ================================================================== */

/**
 * 规范化 Agent 上报的 `capability_manifest`。
 *
 * 返回值区分三种输入：
 *   · `null` —— 字段缺失 / 无法读取（旧 Agent，或 schema 版本不被本面板支持）
 *               → 调用方按 baseline 处理；
 *   · 对象   —— 已去重排序的清单；
 *   · 抛错   —— 坏形状（非对象、schema_version 非整数、维度不是字符串数组…）。
 *
 * 坏形状**抛错**而不是静默丢弃：静默丢弃会把「Agent 报了个坏清单」变成
 * 「Agent 什么都没报」，从而把 fail-closed 悄悄降级成 baseline 放行。
 *
 * 未知条目名**保留**（事实就是事实，面板不替 Agent 改写它的广告），但判定
 * 只做精确匹配，所以未知名字不构成任何许可。这样既不撒谎，也不会因为未来
 * Agent 多报了一个协议名就把整条 manifest 判死。
 */
export function normalizeCapabilityManifest(value: unknown): CapabilityManifest | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("capability_manifest must be an object");
  }
  const raw = value as Record<string, unknown>;
  const version = raw.schema_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new TypeError("capability_manifest.schema_version must be a non-negative integer");
  }
  if (version !== CAPABILITY_MANIFEST_SCHEMA_VERSION) {
    // 可读性失败 ≠ 坏形状：更高版本是**未知语义**，按未上报处理（baseline），
    // 由调用方决定如何提示。见 CAPABILITY_MANIFEST_SCHEMA_VERSION 的注释。
    return null;
  }
  return {
    schema_version: version,
    protocols: normalizeManifestList(raw.protocols, "protocols"),
    transports: normalizeManifestList(raw.transports, "transports"),
    runtime: normalizeManifestList(raw.runtime, "runtime"),
    diagnostics: normalizeManifestList(raw.diagnostics, "diagnostics"),
  };
}

function normalizeManifestList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    // 维度缺失 = 这一维什么都没上报 = 空集（**不是**坏形状，也不是「全部支持」）。
    // 空集对判定意味着「manifest 在，但这一维没有可用条目」→ fail-closed。
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`capability_manifest.${field} must be an array of strings`);
  }
  if (value.length > MANIFEST_MAX_ITEMS) {
    throw new TypeError(`capability_manifest.${field} has more than ${MANIFEST_MAX_ITEMS} items`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new TypeError(`capability_manifest.${field} entries must be strings`);
    }
    const name = entry.trim();
    if (name === "" || name.length > MANIFEST_ITEM_MAX_CHARS) {
      throw new TypeError(`capability_manifest.${field} entry is empty or too long`);
    }
    seen.add(name);
  }
  return [...seen].sort();
}

/* ================================================================== */
/* 库行 → 协商事实                                                     */
/* ================================================================== */

/**
 * 一个节点的 v2 协商事实（全部已规范化，判定函数不再抛错）。
 *
 * `capabilitiesMalformed` / `manifestMalformed` 与「未上报」必须分开：
 * 前者 fail-closed，后者按 baseline 放行。把两者混成一个 `null`，就是把这个
 * 模块存在的意义抹掉。
 */
export interface AgentV2CapabilityFacts {
  /** Agent 上报的控制协议版本（null = 未上报）。 */
  protocolVersion: number | null;
  /** null = 未上报；[] = 明确上报「什么都不支持」。 */
  capabilities: string[] | null;
  /** 上报了 capabilities 但形状坏 → fail-closed。 */
  capabilitiesMalformed: boolean;
  /** null = 未上报 / schema 版本不可读。 */
  manifest: CapabilityManifest | null;
  /** 上报了 capability_manifest 但形状坏 → fail-closed。 */
  manifestMalformed: boolean;
}

/** 无任何上报事实（与「未上报」等价，但不是「坏形状」）。 */
export const ABSENT_V2_CAPABILITY_FACTS: AgentV2CapabilityFacts = Object.freeze({
  protocolVersion: null,
  capabilities: null,
  capabilitiesMalformed: false,
  manifest: null,
  manifestMalformed: false,
});

/** 库行投影（`node_state_report` + 关联的凭据轮换时刻）。 */
export interface CapabilityManifestRow {
  control_protocol_version?: number | null;
  capabilities?: unknown;
  capability_manifest?: unknown;
  reported_at?: Date | string | null;
  credential_rotated_at?: Date | string | null;
}

/**
 * 库行 → v2 协商事实；`null` 表示**这份广告已作废**（重装 / 无行）。
 *
 * 复用 V4 的 {@link capabilityFactsFromStored} 判定新鲜度，而不是在这里再写
 * 一遍「reported_at ≤ credential_rotated_at ⇒ 过期」的比较：那是同一个事实，
 * 两处实现迟早会漂移。代价是它会在 capabilities 坏形状时抛错——本函数接住并
 * 记成 `capabilitiesMalformed`，让上层得到一个**总是可判定**的事实对象。
 */
export function capabilityFactsFromStoredV2(row: CapabilityManifestRow | null | undefined): AgentV2CapabilityFacts | null {
  if (!row) return null;

  let actions: AgentCapabilityFacts | null = null;
  let capabilitiesMalformed = false;
  try {
    actions = capabilityFactsFromStored({
      control_protocol_version: row.control_protocol_version,
      capabilities: row.capabilities,
      reported_at: row.reported_at,
      credential_rotated_at: row.credential_rotated_at,
    });
  } catch {
    // 坏形状：**仍然要判断新鲜度**，否则一条陈旧的坏载荷会被当成"当前事实"。
    // 这里单独比较一次，是因为 V4 辅助函数在抛错前没有返回新鲜度信息。
    if (isAdvertisementStale(row)) return null;
    capabilitiesMalformed = true;
  }
  if (actions === null && !capabilitiesMalformed) return null; // 陈旧广告 → 整份作废

  let manifest: CapabilityManifest | null = null;
  let manifestMalformed = false;
  try {
    manifest = normalizeCapabilityManifest(row.capability_manifest);
  } catch {
    manifestMalformed = true;
  }

  return {
    protocolVersion: capabilitiesMalformed ? safeProtocolVersion(row.control_protocol_version) : actions?.protocolVersion ?? null,
    capabilities: actions?.capabilities ?? null,
    capabilitiesMalformed,
    manifest,
    manifestMalformed,
  };
}

function isAdvertisementStale(row: CapabilityManifestRow): boolean {
  const reported = toTime(row.reported_at);
  const rotated = toTime(row.credential_rotated_at);
  return reported !== null && rotated !== null && reported <= rotated;
}

function toTime(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/** 版本规范化，坏值 → null（事实不可用，但比整条上报更不致命）。 */
function safeProtocolVersion(value: unknown): number | null {
  try {
    return normalizeProtocolVersion(value);
  } catch {
    return null;
  }
}

/* ================================================================== */
/* 判定                                                                */
/* ================================================================== */

/**
 * Runtime admission 的拒绝原因码（§5.2）。
 *
 * 必须可区分，不能全压成「节点离线」：前端据此决定展示「升级 Agent」还是
 * 「换节点」，运维据此决定是补签凭据还是开新协议 Gate。
 */
export type ManifestRejectionReason =
  | "upgrade_required"
  | "incompatible_agent"
  | "malformed_capability_manifest"
  | "protocol_not_supported"
  | "transport_not_supported"
  | "runtime_feature_not_supported";

export type ManifestDecision =
  | { supported: true; basis: "advertised" | "baseline" }
  | { supported: false; reason: ManifestRejectionReason; detail: string };

/**
 * 三个维度的判定共用同一条规则，只有「维度名 / baseline 集合 / 拒绝原因」不同。
 *
 * 抽出来不是为了少写几行，而是为了让三个维度**不可能**出现方向不一致：
 * 任何一处把「缺失」读成「不支持」，或者把「坏形状」读成「未上报」，都会在
 * 这份共用的实现里立刻暴露。
 */
function decideDimension(
  facts: AgentV2CapabilityFacts | null | undefined,
  dimension: string,
  item: unknown,
  baseline: readonly string[],
  missingReason: ManifestRejectionReason,
): ManifestDecision {
  const name = typeof item === "string" ? item.trim() : "";
  if (name === "") {
    return { supported: false, reason: "incompatible_agent", detail: `${dimension} is required` };
  }

  // 坏形状 → 连 baseline 都不再假设支持：Agent 明确描述了自己，但描述不可读，
  // 唯一安全的解释是「不知道它实现了什么」。
  if (facts?.manifestMalformed) {
    return {
      supported: false,
      reason: "malformed_capability_manifest",
      detail: `节点上报的 capability_manifest 形状非法，无法判定 ${dimension}=${name}；请升级或重装 Agent`,
    };
  }

  // 没有可用 manifest（未上报 / schema 版本不可读）：baseline 继续，其余拒绝。
  if (!facts || !facts.manifest) {
    return baseline.includes(name)
      ? { supported: true, basis: "baseline" }
      : {
          supported: false,
          reason: "upgrade_required",
          detail: `节点尚未上报 capability_manifest，无法确认它实现了 ${dimension}=${name}`,
        };
  }

  const advertised = dimensionList(facts.manifest, dimension);
  if (advertised.includes(name)) return { supported: true, basis: "advertised" };

  // manifest 在，但不含该项：Agent 明确描述了自己的实现，就按它说的办。
  return {
    supported: false,
    reason: missingReason,
    detail: `当前 Agent 未实现 ${dimension}=${name}（已上报 ${advertised.length} 项）`,
  };
}

function dimensionList(manifest: CapabilityManifest, dimension: string): string[] {
  switch (dimension) {
    case "protocol":
      return manifest.protocols;
    case "transport":
      return manifest.transports;
    case "runtime":
      return manifest.runtime;
    default:
      return [];
  }
}

/** 该节点是否实现了某个产品协议。 */
export function decideProtocolCapability(
  facts: AgentV2CapabilityFacts | null | undefined,
  protocol: unknown,
): ManifestDecision {
  return decideDimension(facts, "protocol", protocol, BASELINE_PROTOCOLS, "protocol_not_supported");
}

/** 该节点是否实现了某个传输契约（stream / datagram）。 */
export function decideTransportCapability(
  facts: AgentV2CapabilityFacts | null | undefined,
  transport: unknown,
): ManifestDecision {
  return decideDimension(facts, "transport", transport, BASELINE_TRANSPORTS, "transport_not_supported");
}

/** 该节点 runtime 是否具备某个运行时特性（hot_reload / drain / LKG…）。 */
export function decideRuntimeCapability(
  facts: AgentV2CapabilityFacts | null | undefined,
  feature: unknown,
): ManifestDecision {
  return decideDimension(facts, "runtime", feature, BASELINE_RUNTIME_FEATURES, "runtime_feature_not_supported");
}

/**
 * 把判定结果转成可直接进 HTTP 响应的错误体（与 V4 的能力拒绝同一分层）。
 */
export function manifestErrorBody(decision: Extract<ManifestDecision, { supported: false }>) {
  return {
    error: decision.detail,
    code: decision.reason,
    error_layer: "runtime_admission" as const,
    condition: decision.reason,
  };
}

/** 面板已知的产品协议集合（供测试与文档引用；判定仍走 forward-contract）。 */
export const KNOWN_MANIFEST_PROTOCOLS: readonly string[] = [...FORWARD_PROTOCOLS];
/** 面板已知的传输契约集合。 */
export const KNOWN_MANIFEST_TRANSPORTS: readonly string[] = [...FORWARD_TRANSPORTS];
