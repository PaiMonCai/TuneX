/**
 * Transport-agnostic command validation, idempotency and revision gating.
 *
 * The validator owns envelope/payload shape checks and in-process duplicate/
 * stale-revision handling. It does not decide orchestration order, database
 * ownership or cross-process locking; those remain in their persistence/runtime
 * layers.
 */

import {
  ACTION_SPECS,
  ACK_STATUSES,
  COMMAND_ACTIONS,
  COMMAND_RESOURCES,
  DEFAULT_APPLIED_STATUS,
  ENVELOPE_KEYS,
  ERROR_CODES,
  IP_TYPES,
  LOAD_BALANCE_TYPES,
  TARGET_PROTOCOLS,
  TUNNEL_TYPES,
  type AckStatus,
  type CommandAck,
  type CommandAction,
  type CommandAckEnvelope,
  type CommandEnvelope,
  type CommandPayload,
  type CommandResource,
  type ErrorCode,
  type ResourceRecord,
  type ResourceSnapshot,
  type ResourceStatus,
  type CollectDiagnosticsEnvelope,
  type DiagnoseTunnelEnvelope,
  type StateRequestEnvelope,
} from "./types.ts";

/* ================================================================== */
/* 协议常量（冻结协议的一部分，不是运行时配置）                          */
/* ================================================================== */

/** 默认命令 TTL。下发的命令「过期即作废」，不给「迟早会到」的承诺。 */
export const DEFAULT_COMMAND_TTL_MS = 5 * 60 * 1000;
/** `command_id` 长度上界（UUID v4 = 36）。 */
export const MAX_COMMAND_ID_LEN = 64;
/** `resource_id` 长度上界。 */
export const MAX_RESOURCE_ID_LEN = 128;
/** 单地址长度上界（含 IPv6 最坏情况 + 域名 FQDN）。 */
export const MAX_ADDRESS_LEN = 253;
/** : 证书/私钥路径长度上界（与 Prisma `VarChar(512)` 对齐）。 */
const MAX_PATH_LEN = 512;

/** 名称长度上界（与 Prisma `VarChar(255)` 对齐）。 */
export const MAX_NAME_LEN = 255;
/** 目标池容量上界：防止一条命令把对端内存打爆。 */
export const MAX_TARGETS = 64;
/** 幂等账本容量上界（FIFO 淘汰。淘汰后 command_ack 重放会得到 `unknown_command`）。 */
export const MAX_LEDGER_ENTRIES = 1024;

/* ================================================================== */
/* 时间戳 / 过期                                                        */
/* ================================================================== */

/**
 * ISO 8601 且**必须显式带时区**（`Z` 或 `±HH:MM`）。
 * 拒裸本地时间（`2026-09-25T05:00:00`）：它无法判断先后，会被判断成「立刻过期」
 * 或「永不」，都不如直接拒绝。
 */
export const ISO_8601_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** 解析带时区的时间戳；非法返回 null（不抛）。 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  if (!ISO_8601_WITH_ZONE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** `expires_at < now` 即过期（边界：相等时仍有效）。 */
export function isExpired(expiresAt: string, nowMs: number): boolean {
  const ms = parseTimestamp(expiresAt);
  if (ms === null) return true; // 无法解析的时间戳按「可拒绝」处理，由校验返回 invalid_envelope
  return ms < nowMs;
}

/** 用 `nowMs` 生成 `expires_at`（下发侧工厂用，保证带 `Z`）。 */
export function expiresAtFrom(nowMs: number, ttlMs: number): string {
  return new Date(nowMs + ttlMs).toISOString();
}

/* ================================================================== */
/* revision 闸门（纯函数，硬规则 1/2/3 的可测内核）                       */
/* ================================================================== */

export type RevisionGateDecision =
  | { kind: "fresh" } // 该资源从未成功应用过任何 revision
  | { kind: "apply_newer" } // revision > applied_revision
  | { kind: "idempotent" } // revision === applied_revision
  | { kind: "stale_reject" }; // revision < applied_revision

/**
 * `applied_revision` 语义 = **上次成功应用的 revision**（失败不推进，见下方说明）。
 * 因此 `applied_revision === revision` 只能发生在「该版本此前已成功应用」之后，
 * 于是这个分支一定是幂等回放，不会把一次失败卡成永久失败：
 * 失败的应用不推进 `applied_revision`，重试同版本仍会走 `apply_newer` 重新执行。
 */
export function checkRevisionGate(appliedRevision: number | null, revision: number): RevisionGateDecision {
  if (appliedRevision === null) return { kind: "fresh" };
  if (revision > appliedRevision) return { kind: "apply_newer" };
  if (revision === appliedRevision) return { kind: "idempotent" };
  return { kind: "stale_reject" };
}

/* ================================================================== */
/* 信封结构校验（纯函数）                                                */
/* ================================================================== */

export type ValidationResult = { ok: true } | { ok: false; error_code: ErrorCode; error: string };

const ok: ValidationResult = { ok: true };
function fail(error_code: ErrorCode, error: string): ValidationResult {
  return { ok: false, error_code, error };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allow = new Set<string>(allowed);
  return Object.keys(obj).filter((k) => !allow.has(k));
}

function validateIntField(value: unknown, field: string, min: number, max: number): string | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return `${field} 必须是整数`;
  if (value < min || value > max) return `${field} 超出范围 [${min}, ${max}]`;
  return null;
}

export const ACTION_PAYLOAD_KEYS = {
  apply_tunnel: new Set(["tunnel"]),
  remove_tunnel: new Set(["reason"]),
  update_targets: new Set(["targets"]),
  suspend_tunnel: new Set(["reason"]),
  state_request: new Set<string>(),
  command_ack: new Set([
    "acked_command_id",
    "applied_revision",
    "status",
    "error_code",
    "error",
    "state",
    // V5.1b：datagram RELAY 的入口在 ACK 里回报自己的跳端点，面板用它告诉出口
    // 该对谁取证。**加这一条是必需的**——这个集合是封闭的，未知键会让整条 ACK 被判非法。
    // 兼容性：只有新面板能下发 udp RELAY，所以「新 Agent + 老面板」这一组合不可能真的
    // 发出这个键（老面板在校验层就拒绝该形状）。
    "hop_local_addr",
  ]),
  // : read-only probe. `targets` is derived from the tunnel's own
  // authorized desired state by the panel; the validator only bounds its shape.
  diagnose_tunnel: new Set(["targets", "timeout_ms"]),
  // No payload: the only accepted shape is an empty object.
  collect_diagnostics: new Set<string>(),
  // : `targets` carries **pinned public literals** (the panel resolved
  // the names; the agent must not resolve anything). Shape only — the
  // public-address policy lives in services/looking-glass.ts on both sides, and
  // keeping it out of here keeps this module free of business imports.
  looking_glass: new Set(["method", "targets", "timeout_ms"]),
} as const;

const TUNNEL_KEYS = new Set([
  "name",
  "tunnel_type",
  "listen_port",
  "listen_ip",
  "protocol",
  "load_balance",
  "ip_type",
  "targets",
  // : TLS front. Additive + optional per §3.5 — an Agent that predates
  // them ignores them, and one that knows them still refuses a tls tunnel whose
  // paths are absent (forwarder.TunnelConfig.Validate). The control plane
  // carries paths, never key material (DEVELOPMENT.md §6.1).
  "tls_cert_path",
  "tls_key_path",
]);

/** 单个 target 校验。返回错误文案或 null。 */
function validateTarget(target: unknown, index: number): string | null {
  if (!isPlainObject(target)) return `payload.targets[${index}] 必须是对象`;
  const extra = unknownKeys(target, ["address", "port", "weight", "protocol"]);
  if (extra.length > 0) return `payload.targets[${index}] 含未定义字段: ${extra.join(", ")}`;
  if (typeof target.address !== "string" || target.address.trim() === "") {
    return `payload.targets[${index}].address 不能为空`;
  }
  if (target.address.length > MAX_ADDRESS_LEN) return `payload.targets[${index}].address 过长`;
  const portErr = validateIntField(target.port, `payload.targets[${index}].port`, 1, 65535);
  if (portErr) return portErr;
  if (target.weight !== undefined) {
    const wErr = validateIntField(target.weight, `payload.targets[${index}].weight`, 0, 100);
    if (wErr) return wErr;
  }
  if (target.protocol !== undefined && !TARGET_PROTOCOLS.includes(target.protocol as never)) {
    return `payload.targets[${index}].protocol 必须是 ${TARGET_PROTOCOLS.join("/")}`;
  }
  return null;
}

/** target 数组校验（apply_tunnel 与 update_targets 共用）。 */
function validateTargets(value: unknown): string | null {
  if (!Array.isArray(value)) return "payload.targets 必须是数组";
  if (value.length === 0) return "payload.targets 不能为空";
  if (value.length > MAX_TARGETS) return `payload.targets 超过上限 ${MAX_TARGETS}`;
  for (let i = 0; i < value.length; i += 1) {
    const err = validateTarget(value[i], i);
    if (err) return err;
  }
  // 同一 address:port 重复即拒绝：重复目标只会放大故障面，不会提升可用性。
  const seen = new Set<string>();
  for (const t of value as { address: string; port: number }[]) {
    const key = `${t.address}:${t.port}`;
    if (seen.has(key)) return `payload.targets 含重复目标 ${key}`;
    seen.add(key);
  }
  return null;
}

function validateApplyTunnel(payload: Record<string, unknown>): string | null {
  const extra = unknownKeys(payload, [...ACTION_PAYLOAD_KEYS.apply_tunnel]);
  if (extra.length > 0) return `payload 含未定义字段: ${extra.join(", ")}`;
  const tunnel = payload.tunnel;
  if (!isPlainObject(tunnel)) return "payload.tunnel 必须是对象";
  const tExtra = unknownKeys(tunnel, [...TUNNEL_KEYS]);
  if (tExtra.length > 0) return `payload.tunnel 含未定义字段: ${tExtra.join(", ")}`;
  if (typeof tunnel.name !== "string" || tunnel.name.trim() === "") return "payload.tunnel.name 不能为空";
  if (tunnel.name.length > MAX_NAME_LEN) return "payload.tunnel.name 过长";
  if (typeof tunnel.tunnel_type !== "string" || !(TUNNEL_TYPES as readonly string[]).includes(tunnel.tunnel_type)) {
    return `payload.tunnel.tunnel_type 必须是 ${TUNNEL_TYPES.join("/")}`;
  }
  const portErr = validateIntField(tunnel.listen_port, "payload.tunnel.listen_port", 1, 65535);
  if (portErr) return portErr;
  // protocol 只校验"是字符串"（取值依赖运行时配置的 sniffing/协议插件，不在协议层枚举）；
  // load_balance / ip_type 走冻结白名单（与 Prisma 枚举的抄录一致）。
  if (tunnel.protocol !== undefined && typeof tunnel.protocol !== "string") {
    return "payload.tunnel.protocol 必须是字符串";
  }
  // : TLS paths. Shape only — the panel cannot see the node's
  // filesystem, so existence is the Agent's check (fail closed before binding).
  // What the control plane CAN guarantee is that these are node-local absolute
  // paths and not a smuggled blob: an unbounded string here would turn the
  // command channel into a file-writing primitive.
  for (const field of ["tls_cert_path", "tls_key_path"] as const) {
    const value = tunnel[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      return `payload.tunnel.${field} 不能为空字符串（应省略该字段）`;
    }
    if (value !== value.trim()) return `payload.tunnel.${field} 不应含首尾空白`;
    if (!value.startsWith("/")) return `payload.tunnel.${field} 必须是节点本地绝对路径`;
    if (value.length > MAX_PATH_LEN) return `payload.tunnel.${field} 过长`;
    if (value.includes("\n") || value.includes("\r") || value.includes("\x00")) {
      return `payload.tunnel.${field} 含非法字符`;
    }
  }
  const enumFields: [string, readonly string[]][] = [
    ["load_balance", LOAD_BALANCE_TYPES],
    ["ip_type", IP_TYPES],
  ];
  for (const [field, allowed] of enumFields) {
    const value = tunnel[field];
    if (value !== undefined && (typeof value !== "string" || !allowed.includes(value as never))) {
      return `payload.tunnel.${field} 必须是 ${allowed.join("/")}`;
    }
  }
  if (tunnel.listen_ip !== undefined) {
    if (typeof tunnel.listen_ip !== "string" || tunnel.listen_ip.trim() === "") {
      return "payload.tunnel.listen_ip 不能为空字符串（应省略该字段）";
    }
    if (tunnel.listen_ip.length > MAX_ADDRESS_LEN) return "payload.tunnel.listen_ip 过长";
  }
  return validateTargets(tunnel.targets);
}

function validateHopLocalAddr(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    return "payload.hop_local_addr 必须是非空字符串";
  }
  if (value !== value.trim()) return "payload.hop_local_addr 不应含首尾空白";
  if (value.length > MAX_ADDRESS_LEN + 8) return "payload.hop_local_addr 过长";

  let host = "";
  let portText = "";
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close <= 1 || value[close + 1] !== ":") {
      return "payload.hop_local_addr 必须是 [IPv6]:port";
    }
    host = value.slice(1, close);
    portText = value.slice(close + 2);
  } else {
    const colon = value.lastIndexOf(":");
    if (colon <= 0) return "payload.hop_local_addr 必须是 host:port";
    host = value.slice(0, colon);
    portText = value.slice(colon + 1);
  }

  if (host.trim() === "" || /[\s\r\n\x00]/.test(host)) {
    return "payload.hop_local_addr 的 host 非法";
  }
  if (!/^\d+$/.test(portText)) return "payload.hop_local_addr 的 port 必须是整数";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "payload.hop_local_addr 的 port 超出范围 [1, 65535]";
  }
  return null;
}

function validateReasonField(payload: Record<string, unknown>): string | null {
  if (payload.reason === undefined) return null;
  if (typeof payload.reason !== "string") return "payload.reason 必须是字符串";
  if (payload.reason.length > MAX_NAME_LEN) return `payload.reason 超过 ${MAX_NAME_LEN} 字符`;
  return null;
}

/**  caps, shared with the agent's own limits. */
export const DIAGNOSE_MAX_TARGETS = 8;
export const DIAGNOSE_MAX_TIMEOUT_MS = 5000;

/**
 *  线形上限（**结构**边界，不是安全策略）。
 *
 * 方向：这里的上限必须 **≥** `services/looking-glass.ts` 的同名常量，否则一条
 * 策略上合法的请求会先在本地校验被拒（"策略说可以、线形说不行"是一种很难查的
 * 漂移）。两者的一致性由 `v5-wp19/d-looking-glass.test.ts` 断言。
 *
 * 为什么比 diagnose 更小（4 < 8）：diagnose 的目标来自面板自己的 desired 状态，
 * 而这里的每一个目标都是**用户输入的**公网地址 —— 一次请求能打出的包数越少，
 * 这个功能离"端口扫描器"就越远。
 */
export const LOOKING_GLASS_MAX_TARGETS = 4;
export const LOOKING_GLASS_MAX_TIMEOUT_MS = 5000;

/** payload schema 校验（白名单字段 + 值域）。 */
export function validatePayload(action: CommandAction, payload: unknown): string | null {
  if (!isPlainObject(payload)) return "payload 必须是对象";
  switch (action) {
    case "apply_tunnel":
      return validateApplyTunnel(payload);
    case "update_targets": {
      const extra = unknownKeys(payload, [...ACTION_PAYLOAD_KEYS.update_targets]);
      if (extra.length > 0) return `payload 含未定义字段: ${extra.join(", ")}`;
      return validateTargets(payload.targets);
    }
    case "remove_tunnel":
    case "suspend_tunnel": {
      const extra = unknownKeys(payload, [...ACTION_PAYLOAD_KEYS[action]]);
      if (extra.length > 0) return `payload 含未定义字段: ${extra.join(", ")}`;
      return validateReasonField(payload);
    }
    case "state_request": {
      const extra = unknownKeys(payload, [...ACTION_PAYLOAD_KEYS.state_request]);
      if (extra.length > 0) return `payload 含未定义字段: ${extra.join(", ")}`;
      return null;
    }
    case "command_ack": {
      const extra = unknownKeys(payload, [...ACTION_PAYLOAD_KEYS.command_ack]);
      if (extra.length > 0) return `payload 含未定义字段: ${extra.join(", ")}`;
      if (typeof payload.acked_command_id !== "string" || payload.acked_command_id.trim() === "") {
        return "payload.acked_command_id 不能为空（它标识被回应的命令，与信封自身的 command_id 不同）";
      }
      if (payload.applied_revision !== null) {
        const err = validateIntField(payload.applied_revision, "payload.applied_revision", 0, Number.MAX_SAFE_INTEGER);
        if (err) return err;
      }
      if (typeof payload.status !== "string" || !(ACK_STATUSES as readonly string[]).includes(payload.status)) {
        return `payload.status 必须是 ${ACK_STATUSES.join("/")}`;
      }
      if (payload.error_code !== undefined) {
        if (typeof payload.error_code !== "string" || !(ERROR_CODES as readonly string[]).includes(payload.error_code)) {
          return `payload.error_code 必须属于协议错误码清单`;
        }
      }
      if (payload.error !== undefined && typeof payload.error !== "string") {
        return "payload.error 必须是字符串";
      }
      if (payload.state !== undefined && payload.state !== null && !isPlainObject(payload.state)) {
        return "payload.state 必须是对象或 null";
      }
      const hopLocalAddrError = validateHopLocalAddr(payload.hop_local_addr);
      if (hopLocalAddrError) return hopLocalAddrError;
      // status 为 applied/duplicate 时必须带回非负 applied_revision；否则必须带错误码。
      const status = payload.status as AckStatus;
      if ((status === "applied" || status === "duplicate") && payload.applied_revision === null) {
        return `status=${status} 时必须提供 payload.applied_revision`;
      }
      if ((status === "rejected" || status === "failed") && payload.error_code === undefined) {
        return `status=${status} 时必须提供 payload.error_code`;
      }
      return null;
    }
    case "collect_diagnostics": {
      const extra = unknownKeys(payload, [...ACTION_PAYLOAD_KEYS.collect_diagnostics]);
      if (extra.length > 0) return `payload 含未定义字段: ${extra.join(", ")}`;
      return null;
    }
    case "diagnose_tunnel": {
      const extra = unknownKeys(payload, [...ACTION_PAYLOAD_KEYS.diagnose_tunnel]);
      if (extra.length > 0) return `payload 含未定义字段: ${extra.join(", ")}`;
      if (!Array.isArray(payload.targets) || payload.targets.length === 0) {
        return "payload.targets 必须是非空数组";
      }
      if (payload.targets.length > DIAGNOSE_MAX_TARGETS) {
        return `payload.targets 超过上限 ${DIAGNOSE_MAX_TARGETS}`;
      }
      for (let i = 0; i < payload.targets.length; i += 1) {
        const entry = payload.targets[i];
        if (!isPlainObject(entry)) return `payload.targets[${i}] 必须是对象`;
        const entryExtra = unknownKeys(entry, ["host", "port"]);
        if (entryExtra.length > 0) return `payload.targets[${i}] 含未定义字段: ${entryExtra.join(", ")}`;
        if (typeof entry.host !== "string" || entry.host.trim() === "") {
          return `payload.targets[${i}].host 不能为空`;
        }
        if (entry.host.length > MAX_ADDRESS_LEN) return `payload.targets[${i}].host 过长`;
        const portErr = validateIntField(entry.port, `payload.targets[${i}].port`, 1, 65535);
        if (portErr) return portErr;
      }
      if (payload.timeout_ms !== undefined) {
        const err = validateIntField(payload.timeout_ms, "payload.timeout_ms", 1, DIAGNOSE_MAX_TIMEOUT_MS);
        if (err) return err;
      }
      return null;
    }
    case "looking_glass": {
      //：形状校验。语义白名单（公网段/规范写法/方法闭集）不在这里，
      // 由 services/looking-glass.ts 在下发前判、Agent 侧再判一次。
      const extra = unknownKeys(payload, [...ACTION_PAYLOAD_KEYS.looking_glass]);
      if (extra.length > 0) return `payload 含未定义字段: ${extra.join(", ")}`;
      const methods = ["tcp_connect"];
      if (typeof payload.method !== "string" || !methods.includes(payload.method)) {
        return `payload.method 必须是 ${methods.join("/")}`;
      }
      if (!Array.isArray(payload.targets) || payload.targets.length === 0) {
        return "payload.targets 必须是非空数组";
      }
      if (payload.targets.length > LOOKING_GLASS_MAX_TARGETS) {
        return `payload.targets 超过上限 ${LOOKING_GLASS_MAX_TARGETS}`;
      }
      for (let i = 0; i < payload.targets.length; i += 1) {
        const entry = payload.targets[i];
        if (!isPlainObject(entry)) return `payload.targets[${i}] 必须是对象`;
        const entryExtra = unknownKeys(entry, ["address", "port"]);
        if (entryExtra.length > 0) return `payload.targets[${i}] 含未定义字段: ${entryExtra.join(", ")}`;
        if (typeof entry.address !== "string" || entry.address.trim() === "") {
          return `payload.targets[${i}].address 不能为空`;
        }
        if (entry.address.length > MAX_ADDRESS_LEN) return `payload.targets[${i}].address 过长`;
        // 只接受"地址字符集"，不做语义判定：真正判定在 looking-glass.ts 与 Agent。
        if (!/^[0-9a-fA-F:.]+$/.test(entry.address.trim())) {
          return `payload.targets[${i}].address 必须是字面 IP（不允许域名：解析在面板侧完成）`;
        }
        const portErr = validateIntField(entry.port, `payload.targets[${i}].port`, 1, 65535);
        if (portErr) return portErr;
      }
      if (payload.timeout_ms !== undefined) {
        const err = validateIntField(payload.timeout_ms, "payload.timeout_ms", 1, LOOKING_GLASS_MAX_TIMEOUT_MS);
        if (err) return err;
      }
      return null;
    }
    default:
      return `未知 action: ${String(action)}`;
  }
}

/**
 * 信封结构校验（不含 revision 闸门/幂等——那些要读状态，见 `ControlValidator`）。
 *
 * 校验顺序固定：**结构 → 动作/资源配对 → payload → 时间戳 → TTL 上限 → 过期**。
 * 顺序刻意把「过期」放最后：一个结构就烂掉的报文，报它过期只会误导排障
 * （看起来像时钟问题，实际是拼写问题）。
 */
export function validateEnvelope(command: unknown, nowMs: number, opts: { maxTtlMs?: number } = {}): ValidationResult {
  if (!isPlainObject(command)) return fail("invalid_envelope", "命令必须是 JSON 对象");
  const extra = unknownKeys(command, ENVELOPE_KEYS as readonly string[]);
  if (extra.length > 0) return fail("invalid_envelope", `信封含未定义字段: ${extra.join(", ")}`);

  if (typeof command.command_id !== "string" || command.command_id.trim() === "") {
    return fail("invalid_envelope", "command_id 不能为空");
  }
  if (command.command_id.length > MAX_COMMAND_ID_LEN) {
    return fail("invalid_envelope", `command_id 超过 ${MAX_COMMAND_ID_LEN} 字符`);
  }
  if (typeof command.resource !== "string" || !(COMMAND_RESOURCES as readonly string[]).includes(command.resource)) {
    return fail("unknown_resource", `resource 必须是 ${COMMAND_RESOURCES.join("/")}`);
  }
  if (typeof command.resource_id !== "string" || command.resource_id.trim() === "") {
    return fail("invalid_envelope", "resource_id 不能为空");
  }
  if (command.resource_id.length > MAX_RESOURCE_ID_LEN) {
    return fail("invalid_envelope", `resource_id 超过 ${MAX_RESOURCE_ID_LEN} 字符`);
  }

  const revisionErr = validateIntField(command.revision as unknown as number | undefined, "revision", 0, Number.MAX_SAFE_INTEGER);
  if (revisionErr) return fail("invalid_envelope", revisionErr);
  const revision = command.revision as number;

  if (typeof command.action !== "string" || !(COMMAND_ACTIONS as readonly string[]).includes(command.action)) {
    return fail("unknown_action", `action 必须是 ${COMMAND_ACTIONS.join("/")}`);
  }
  const action = command.action as CommandAction;
  const resource = command.resource as CommandResource;
  const spec = ACTION_SPECS[action];
  if (!spec.resources.includes(resource)) {
    return fail(
      "action_resource_mismatch",
      `action ${action} 不允许作用于 ${resource}（仅 ${spec.resources.join("/")}）`,
    );
  }
  if (revision < spec.minRevision) {
    return fail("invalid_envelope", `action ${action} 要求 revision >= ${spec.minRevision}（收到 ${revision}）`);
  }

  const payloadErr = validatePayload(action, command.payload);
  if (payloadErr) return fail("payload_invalid", payloadErr);

  const expiresMs = parseTimestamp(command.expires_at);
  if (expiresMs === null) return fail("invalid_envelope", "expires_at 必须为带时区的 ISO 8601 字符串");

  const maxTtl = opts.maxTtlMs ?? DEFAULT_COMMAND_TTL_MS;
  if (command.issued_at !== undefined) {
    const issuedMs = parseTimestamp(command.issued_at);
    if (issuedMs === null) return fail("invalid_envelope", "issued_at 必须为带时区的 ISO 8601 字符串");
    if (issuedMs > expiresMs) return fail("invalid_envelope", "issued_at 晚于 expires_at");
    if (expiresMs - issuedMs > maxTtl) {
      return fail("ttl_exceeds_policy", `命令 TTL ${expiresMs - issuedMs}ms 超过上限 ${maxTtl}ms`);
    }
  } else if (expiresMs - nowMs > maxTtl) {
    // 没有 issued_at 时按"从现在起算的 TTL"兜底：仍要挡住一个"永远有效的命令"。
    return fail("ttl_exceeds_policy", `命令 TTL ${expiresMs - nowMs}ms 超过上限 ${maxTtl}ms`);
  }

  if (expiresMs < nowMs) {
    return fail("command_expired", `命令已于 ${command.expires_at as string} 过期，拒绝执行`);
  }
  return ok;
}

/* ================================================================== */
/* 稳定指纹（同一命令的判定不依赖 JSON 键序）                              */
/* ================================================================== */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** 命令指纹：action + resource + resource_id + revision + payload。 */
export function commandFingerprint(command: CommandEnvelope): string {
  return stableStringify({
    action: command.action,
    resource: command.resource,
    resource_id: command.resource_id,
    revision: command.revision,
    payload: command.payload,
  });
}

/* ================================================================== */
/* applier 回调契约                                                     */
/* ================================================================== */

/**
 * 执行一条已通过闸门的变更命令。返回 void = 按协议默认推进状态；
 * 返回对象 = 覆盖默认 status / 附带 state。抛异常 = `apply_failed`，状态不推进。
 * 同步/异步皆可（transport-agnostic：调用方决定是否真的发网络）。
 */
export interface ApplyResult {
  status?: ResourceStatus;
  state?: ResourceSnapshot | null;
  error_code?: ErrorCode;
  error?: string;
}
export type CommandApplier = (
  command: CommandEnvelope,
) => void | ApplyResult | Promise<void | ApplyResult>;

/* ================================================================== */
/* ControlValidator                                                     */
/* ================================================================== */

interface LedgerEntry {
  fingerprint: string;
  outcome: CommandOutcomeInternal;
}

/** 内部用结果记录（与 `CommandOutcome` 唯一差别是携带 fingerprint，不对外暴露）。 */
export interface CommandOutcomeInternal {
  command_id: string;
  action: CommandAction;
  resource: CommandResource;
  resource_id: string;
  revision: number;
  applied_revision: number | null;
  status: AckStatus;
  error_code?: ErrorCode;
  error?: string;
  state?: ResourceSnapshot | null;
  acked: boolean;
}

export interface ControlValidatorOptions {
  maxTtlMs?: number;
  /** 幂等账本容量，默认 MAX_LEDGER_ENTRIES。 */
  maxLedgerEntries?: number;
}

/**
 * 有状态校验器：持有 per-resource revision 状态 + command_id 幂等账本。
 *
 * 线程/进程安全边界：**同一实例内的并发安全由 per-resource 串行队列保证**（见
 * `withResourceLock`）；跨进程/跨副本不保证——那属于 / 的持久化仲裁层。
 */
export class ControlValidator {
  private readonly maxTtlMs: number;
  private readonly maxLedgerEntries: number;
  private readonly records = new Map<string, ResourceRecord>();
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly ledgerOrder: string[] = [];
  /** per-resource 串行队列：同一资源的命令绝不并行执行。 */
  private readonly resourceQueues = new Map<string, Promise<unknown>>();
  /** command_id → 执行中的 promise（同 ID 并发提交只执行一次）。 */
  private readonly inflight = new Map<string, Promise<CommandAck>>();
  /**
   * command_ack 信封自身的幂等账本。ACK 也是命令：同一条 ACK 报文被重发
   * （网络重投、对端重试）必须拿回同一结果，不能重复把 acked 标记翻一遍。
   * 与被 ack 的命令的账本分开：后者按目标命令 ID 索引，这个按 ACK 自己的 ID。
   */
  private readonly acks = new Map<string, CommandAck>();
  private readonly ackOrder: string[] = [];

  constructor(opts: ControlValidatorOptions = {}) {
    this.maxTtlMs = opts.maxTtlMs ?? DEFAULT_COMMAND_TTL_MS;
    this.maxLedgerEntries = opts.maxLedgerEntries ?? MAX_LEDGER_ENTRIES;
  }

  /* ---------------------------------------------------------------- */
  /* 状态管理                                                          */
  /* ---------------------------------------------------------------- */

  private static key(resource: CommandResource, resource_id: string): string {
    return `${resource}:${resource_id}`;
  }

  /** 读取某资源的 revision 状态（不存在返回 undefined）。 */
  getRecord(resource: CommandResource, resource_id: string): ResourceRecord | undefined {
    const record = this.records.get(ControlValidator.key(resource, resource_id));
    return record ? { ...record } : undefined;
  }

  /** 该资源的对外状态快照（state_request 的响应体）。 */
  snapshot(resource: CommandResource, resource_id: string): ResourceSnapshot {
    const record = this.records.get(ControlValidator.key(resource, resource_id));
    if (!record) {
      return {
        resource,
        resource_id,
        revision: 0,
        applied_revision: 0,
        status: "unknown",
        applying: false,
        last_attempted_revision: null,
      };
    }
    return {
      resource: record.resource,
      resource_id: record.resource_id,
      revision: record.revision,
      applied_revision: record.applied_revision,
      status: record.status,
      applying: record.applying,
      last_attempted_revision: record.last_attempted_revision,
    };
  }

  /**
   * 注入已知对端状态（例如从 DB 回填 / 从对端 state_request 的 state 字段恢复）。
   * `applied_revision` 缺省 = revision：回填的意图就是「这个版本已经生效」。
   * 注入不会写幂等账本——跨进程重放是否命中幂等，由账本的存活周期决定。
   */
  seed(snapshot: Partial<ResourceSnapshot> & { resource: CommandResource; resource_id: string }): ResourceRecord {
    const key = ControlValidator.key(snapshot.resource, snapshot.resource_id);
    const existing = this.records.get(key);
    const record: ResourceRecord = {
      resource: snapshot.resource,
      resource_id: snapshot.resource_id,
      revision: snapshot.revision ?? existing?.revision ?? 0,
      applied_revision: snapshot.applied_revision ?? snapshot.revision ?? existing?.applied_revision ?? 0,
      status: snapshot.status ?? existing?.status ?? "active",
      applying: false,
      last_attempted_revision: snapshot.last_attempted_revision ?? existing?.last_attempted_revision ?? null,
    };
    this.records.set(key, record);
    return { ...record };
  }

  /** 清空全部状态（测试/进程退出用）。 */
  reset(): void {
    this.records.clear();
    this.ledger.clear();
    this.ledgerOrder.length = 0;
    this.acks.clear();
    this.ackOrder.length = 0;
    this.inflight.clear();
    this.resourceQueues.clear();
  }

  /** 账本中的一条命令结果（幂等回放的来源）。 */
  outcome(command_id: string): CommandOutcomeInternal | undefined {
    const entry = this.ledger.get(command_id);
    return entry ? { ...entry.outcome } : undefined;
  }

  /* ---------------------------------------------------------------- */
  /* 结构化入口（可单独调用，纯无副作用）                                */
  /* ---------------------------------------------------------------- */

  /** 信封结构校验；不读也不写任何状态。 */
  validate(command: unknown, nowMs: number = Date.now()): ValidationResult {
    return validateEnvelope(command, nowMs, { maxTtlMs: this.maxTtlMs });
  }

  /** revision 闸门的纯判定：该命令相对当前状态该怎么处理。 */
  gate(resource: CommandResource, resource_id: string, revision: number): RevisionGateDecision {
    const record = this.records.get(ControlValidator.key(resource, resource_id));
    return checkRevisionGate(record ? record.applied_revision : null, revision);
  }

  /* ---------------------------------------------------------------- */
  /* 主入口：校验 + 闸门 + 串行执行 + 幂等账本                          */
  /* ---------------------------------------------------------------- */

  /**
   * 处理一条命令并返回 ACK。
   *
   * 并发语义（都是硬保证，测试钉死）：
   *  · 同一 `command_id` 并发到达 → 只执行一次，后续调用复用同一结果；
   *  · 同一 resource 的不同命令并发到达 → 按到达顺序串行执行，版本只前进不回退，
   *    每个成功应用的 revision 严格大于上一个；
   *  · 不同 resource 之间不互相阻塞。
   *
   * @param applier 变更执行器（`state_request` 不会调用它——查询不走 applier）。
   */
  async handle(
    command: unknown,
    applier: CommandApplier,
    nowMs: number = Date.now(),
  ): Promise<CommandAck> {
    const validated = this.validate(command, nowMs);
    if (!validated.ok) {
      // 结构就烂掉时尽量回显可解析的字段，其余为 null（调用方不得把 null 当合法值用）。
      return rejectAck(partialIdentity(command), validated.error_code, validated.error, nowMs);
    }
    const cmd = command as CommandEnvelope;

    // command_id 级去重：同 ID 在飞行中 → 等同一结果，第二个标 duplicate。
    const pending = this.inflight.get(cmd.command_id);
    if (pending) {
      const first = await pending;
      return first.status === "applied" ? { ...first, status: "duplicate" } : { ...first };
    }

    // 非变更动作不排 per-resource 队列：state_request 必须能捞到"正在 apply 中"的
    // 实时状态（否则它排在慢命令后面，观测全变成事后回放）；command_ack 只动账本
    // 的同步 Map 写入，与资源状态无关，也不需要串行化。
    if (cmd.action === "state_request" || cmd.action === "command_ack") {
      const run = (async () => this.execute(cmd, applier, nowMs))();
      this.inflight.set(cmd.command_id, run);
      try {
        return await run;
      } finally {
        this.inflight.delete(cmd.command_id);
      }
    }

    const run = this.withResourceLock(cmd.resource, cmd.resource_id, async () =>
      this.execute(cmd, applier, nowMs),
    );
    this.inflight.set(cmd.command_id, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(cmd.command_id);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 内部                                                              */
  /* ---------------------------------------------------------------- */

  /** 同 resource 的执行串成一个 promise 链（不同 resource 保持并行）。 */
  private withResourceLock(
    resource: CommandResource,
    resource_id: string,
    fn: () => Promise<CommandAck>,
  ): Promise<CommandAck> {
    const key = ControlValidator.key(resource, resource_id);
    const prev = this.resourceQueues.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // 队列本身吃掉异常：单个命令失败不能让整条链断掉。
    this.resourceQueues.set(key, run.catch(() => undefined));
    return run;
  }

  private execute(cmd: CommandEnvelope, applier: CommandApplier, nowMs: number): Promise<CommandAck> | CommandAck {
    switch (cmd.action) {
      case "state_request":
        return this.answerStateRequest(cmd, nowMs);
      case "command_ack":
        return this.recordAck(cmd, nowMs);
      case "collect_diagnostics": {
        // Read-only, same as diagnose: it must not touch the mutation path.
        const state = this.snapshot(cmd.resource, cmd.resource_id);
        return {
          command_id: cmd.command_id,
          action: cmd.action,
          resource: cmd.resource,
          resource_id: cmd.resource_id,
          revision: cmd.revision,
          applied_revision: state.applied_revision,
          status: "applied",
          state,
          acked_at: new Date(nowMs).toISOString(),
        };
      }
      case "diagnose_tunnel":
        // : a diagnose is READ-ONLY. It must not enter the mutation path,
        // which would apply the revision gate and advance the resource status —
        // a diagnostic that mutates is not a diagnostic.
        return this.recordReadOnlyProbe(cmd, nowMs);
      default:
        return this.executeMutation(cmd, applier, nowMs);
    }
  }

  /**
   * diagnose_tunnel：只读动作。
   *
   * 与 state_request 一样不经过变更闸门；与它不同的是诊断**确实要下发到 Agent**，
   * 所以由 orchestrator 走命令总线，而不是在这里就地回答。校验器这一层只负责
   * "信封与 payload 合法、且不需要任何状态推进"，并回一个 accepted 形状的回执，
   * 让调用方无法把它误当成一次已应用的变更。
   */
  private recordReadOnlyProbe(cmd: DiagnoseTunnelEnvelope, nowMs: number): CommandAck {
    const state = this.snapshot(cmd.resource, cmd.resource_id);
    const ack: CommandAck = {
      command_id: cmd.command_id,
      action: cmd.action,
      resource: cmd.resource,
      resource_id: cmd.resource_id,
      revision: cmd.revision,
      // Read-only: the applied revision is whatever the resource already had.
      applied_revision: state.applied_revision,
      status: "applied",
      state,
      acked_at: new Date(nowMs).toISOString(),
    };
    this.ledger.set(cmd.command_id, {
      fingerprint: commandFingerprint(cmd),
      outcome: {
        command_id: cmd.command_id,
        action: cmd.action,
        resource: cmd.resource,
        resource_id: cmd.resource_id,
        revision: cmd.revision,
        applied_revision: state.applied_revision,
        status: "applied",
        acked: false,
      },
    });
    return ack;
  }

  /** state_request：不读闸门、不写账本、不调 applier —— 永远回新鲜快照。 */
  private answerStateRequest(cmd: StateRequestEnvelope, nowMs: number): CommandAck {
    const state = this.snapshot(cmd.resource, cmd.resource_id);
    const ack: CommandAck = {
      command_id: cmd.command_id,
      action: cmd.action,
      resource: cmd.resource,
      resource_id: cmd.resource_id,
      revision: cmd.revision,
      applied_revision: state.applied_revision,
      status: "applied",
      state,
      acked_at: new Date(nowMs).toISOString(),
    };
    return ack;
  }

  /**
   * command_ack：把 ACK 装进信封回传。唯一的合法目标是 **账本里已知的命令**：
   * 没收到过的命令不会被凭空 ack 掉（否则一次伪造 ACK 就能让账本相信命令成功了）。
   *
   * 被 ack 的目标在 `payload.acked_command_id`，不是本信封的 `command_id` ——
   * 后者是"这条 ACK 报文自己的编号"，两者语义不同，混用会让 ack 永远找不到命令。
   */
  private recordAck(cmd: CommandAckEnvelope, nowMs: number): CommandAck {
    const memo = this.acks.get(cmd.command_id);
    if (memo) {
      return { ...memo, status: "duplicate", error: memo.error ?? `ACK ${cmd.command_id} 已处理过，结果不变` };
    }

    const acked = cmd.payload.acked_command_id;
    const entry = this.ledger.get(acked);

    if (!entry) {
      return ackFrom(cmd, "rejected", "unknown_command", `命令 ${acked} 不在幂等账本中（从未下发或已淘汰）`, null);
    }
    // 信封自身回显的 resource / resource_id / revision 必须与被 ack 的命令一致：
    // 否则一次错投的 ACK 就能把命令 A 的结果记到命令 B 头上。
    if (
      entry.outcome.resource !== cmd.resource ||
      entry.outcome.resource_id !== cmd.resource_id ||
      entry.outcome.revision !== cmd.revision
    ) {
      return ackFrom(
        cmd,
        "rejected",
        "command_mismatch",
        `command_ack 回显的 resource/resource_id/revision 与被 ack 的命令不符`,
        entry.outcome.applied_revision,
      );
    }

    // 原命令拒绝/失败了对端不需要再确认；幂等：重复 ACK 同一命令不报错。
    if (entry.outcome.status === "rejected" || entry.outcome.status === "failed") {
      return ackFrom(
        cmd,
        "duplicate",
        undefined,
        `命令 ${acked} 此前已为 ${entry.outcome.status}，ack 不再改变结果`,
        entry.outcome.applied_revision,
      );
    }

    if (cmd.payload.applied_revision !== null && cmd.payload.applied_revision !== entry.outcome.revision) {
      return ackFrom(
        cmd,
        "rejected",
        "revision_mismatch",
        `ack 的 applied_revision=${cmd.payload.applied_revision} 与命令 revision=${entry.outcome.revision} 不符`,
        entry.outcome.applied_revision,
      );
    }

    entry.outcome.acked = true;
    const ack = ackFrom(
      cmd,
      "applied",
      undefined,
      undefined,
      cmd.payload.applied_revision ?? entry.outcome.applied_revision,
      cmd.payload.state ?? null,
    );
    // V5.1b : carry the datagram hop endpoint onto the memoized ACK. It has to be
    // set BEFORE `rememberAck`, because the replays below return the remembered object —
    // a field that only existed on the first pass would vanish exactly when a command is
    // retried, and the panel would then never correct the exit's attestation.
    if (typeof cmd.payload.hop_local_addr === "string" && cmd.payload.hop_local_addr.trim() !== "") {
      ack.hop_local_addr = cmd.payload.hop_local_addr;
    }
    this.rememberAck(cmd.command_id, ack);
    return ack;
  }

  /** 记 ACK 自己的幂等账本（FIFO 淘汰，与被 ack 命令的账本同容量）。 */
  private rememberAck(command_id: string, ack: CommandAck): void {
    if (!this.acks.has(command_id)) {
      this.ackOrder.push(command_id);
      while (this.ackOrder.length > this.maxLedgerEntries) {
        const evicted = this.ackOrder.shift();
        if (evicted) this.acks.delete(evicted);
      }
    }
    this.acks.set(command_id, ack);
  }

  /** 变更命令：gate → execute → 原子推进。 */
  private async executeMutation(
    cmd: Extract<CommandEnvelope, { action: Exclude<CommandAction, "state_request" | "command_ack"> }>,
    applier: CommandApplier,
    nowMs: number,
  ): Promise<CommandAck> {
    const key = ControlValidator.key(cmd.resource, cmd.resource_id);
    const fingerprint = commandFingerprint(cmd);

    // ① command_id 幂等：同内容 → 回放；不同内容 → 拒（真正的客户端 bug）。
    const prior = this.ledger.get(cmd.command_id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return ackFrom(
          cmd,
          "rejected",
          "duplicate_command_id",
          `command_id ${cmd.command_id} 已被另一条命令占用`,
          this.records.get(key)?.applied_revision ?? null,
        );
      }
      return ackFrom(
        cmd,
        "duplicate",
        undefined,
        undefined,
        prior.outcome.applied_revision,
        prior.outcome.state ?? null,
      );
    }

    // ② revision 闸门（硬规则 1/2/3）。
    const record = this.records.get(key);
    const decision = checkRevisionGate(record ? record.applied_revision : null, cmd.revision);
    if (decision.kind === "stale_reject") {
      return ackFrom(
        cmd,
        "rejected",
        "stale_revision",
        `命令 revision=${cmd.revision} 低于已应用的 revision=${record!.applied_revision}`,
        record!.applied_revision,
      );
    }
    if (decision.kind === "idempotent") {
      const previous = this.lastAppliedOutcome(cmd.resource, cmd.resource_id, cmd.revision);
      const appliedRevision = previous?.outcome.applied_revision ?? record!.applied_revision;
      const state = previous?.outcome.state ?? null;

      // 同一 resource/revision 可以用新的 command_id 重试。虽然不再执行 applier，
      // **这个新 command_id 仍必须进入幂等账本**：Outbound transport 随后收到的
      // command_ack 会以本次 envelope.command_id 作为 acked_command_id。若这里只
      // 返回 duplicate 而不 remember，真实 Agent 的 ACK 会被 recordAck 判成
      // unknown_command，控制面反而把一次成功的幂等重放翻成 502。
      const aliasOutcome: CommandOutcomeInternal = {
        command_id: cmd.command_id,
        action: cmd.action,
        resource: cmd.resource,
        resource_id: cmd.resource_id,
        revision: cmd.revision,
        applied_revision: appliedRevision,
        status: "duplicate",
        state,
        acked: false,
      };
      this.remember(cmd.command_id, fingerprint, aliasOutcome);

      return ackFrom(
        cmd,
        "duplicate",
        undefined,
        previous ? undefined : `revision=${cmd.revision} 已应用（记录本次幂等别名）`,
        appliedRevision,
        state,
      );
    }

    // ③ 执行（applying 期间对 state_request 可见）+ 原子推进。
    const state = record ?? this.freshRecord(cmd.resource, cmd.resource_id);
    this.records.set(key, state);
    state.applying = true;
    state.last_attempted_revision = cmd.revision;

    try {
      const result = (await applier(cmd)) ?? {};
      state.applied_revision = cmd.revision;
      state.revision = Math.max(state.revision, cmd.revision);
      state.status = result.status ?? DEFAULT_APPLIED_STATUS[cmd.action] ?? "active";
      const outcome: CommandOutcomeInternal = {
        command_id: cmd.command_id,
        action: cmd.action,
        resource: cmd.resource,
        resource_id: cmd.resource_id,
        revision: cmd.revision,
        applied_revision: state.applied_revision,
        status: "applied",
        state: result.state ?? null,
        acked: false,
      };
      this.remember(cmd.command_id, fingerprint, outcome);
      return ackFrom(cmd, "applied", undefined, undefined, state.applied_revision, result.state ?? null);
    } catch (err) {
      const code: ErrorCode =
        err instanceof ControlProtocolError ? (err.code as ErrorCode) : "apply_failed";
      const message = err instanceof Error ? err.message : String(err);
      // 失败不推进 applied_revision：同 revision 重试仍会走 apply_newer 重来。
      state.status = "error";
      const outcome: CommandOutcomeInternal = {
        command_id: cmd.command_id,
        action: cmd.action,
        resource: cmd.resource,
        resource_id: cmd.resource_id,
        revision: cmd.revision,
        applied_revision: state.applied_revision,
        status: "failed",
        error_code: code,
        error: message,
        state: null,
        acked: false,
      };
      this.remember(cmd.command_id, fingerprint, outcome);
      return ackFrom(cmd, "failed", code, message, state.applied_revision);
    } finally {
      state.applying = false;
    }
  }

  private freshRecord(resource: CommandResource, resource_id: string): ResourceRecord {
    return {
      resource,
      resource_id,
      revision: 0,
      applied_revision: 0,
      status: "unknown",
      applying: false,
      last_attempted_revision: null,
    };
  }

  /** 账本里该 (resource, revision) 最近一次成功应用的结果。 */
  private lastAppliedOutcome(
    resource: CommandResource,
    resource_id: string,
    revision: number,
  ): LedgerEntry | undefined {
    for (let i = this.ledgerOrder.length - 1; i >= 0; i -= 1) {
      const entry = this.ledger.get(this.ledgerOrder[i]);
      if (!entry) continue;
      const o = entry.outcome;
      if (
        o.resource === resource &&
        o.resource_id === resource_id &&
        o.revision === revision &&
        (o.status === "applied" || o.status === "duplicate")
      ) {
        return entry;
      }
    }
    return undefined;
  }

  /** 写账本（FIFO 淘汰）。 */
  private remember(command_id: string, fingerprint: string, outcome: CommandOutcomeInternal): void {
    if (!this.ledger.has(command_id)) {
      this.ledgerOrder.push(command_id);
      while (this.ledgerOrder.length > this.maxLedgerEntries) {
        const evicted = this.ledgerOrder.shift();
        if (evicted) this.ledger.delete(evicted);
      }
    }
    this.ledger.set(command_id, { fingerprint, outcome });
  }
}

/** applier 抛它 = 用携带的 code 而不是 `apply_failed`（例如 quota 不足带自己的码）。 */
export class ControlProtocolError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ControlProtocolError";
    this.code = code;
  }
}

/* ================================================================== */
/* ACK 构造小工具                                                       */
/* ================================================================== */

/** 从任意（可能是坏的）命令里尽量掏出可用身份字段；掏不出就 null。 */
function partialIdentity(command: unknown): {
  command_id: string | null;
  action: CommandAction | null;
  resource: CommandResource | null;
  resource_id: string | null;
  revision: number | null;
} {
  const c = (isPlainObject(command) ? command : {}) as Record<string, unknown>;
  const s = (k: string): string | null => (typeof c[k] === "string" ? (c[k] as string) : null);
  const n = (k: string): number | null =>
    typeof c[k] === "number" && Number.isInteger(c[k]) ? (c[k] as number) : null;
  return {
    command_id: s("command_id"),
    action: (COMMAND_ACTIONS as readonly string[]).includes(c.action as string) ? (c.action as CommandAction) : null,
    resource: (COMMAND_RESOURCES as readonly string[]).includes(c.resource as string)
      ? (c.resource as CommandResource)
      : null,
    resource_id: s("resource_id"),
    revision: n("revision"),
  };
}

/** 拒绝型 ACK。 */
function rejectAck(
  identity: ReturnType<typeof partialIdentity>,
  error_code: ErrorCode,
  error: string,
  nowMs: number,
): CommandAck {
  return {
    command_id: identity.command_id,
    action: identity.action,
    resource: identity.resource,
    resource_id: identity.resource_id,
    revision: identity.revision,
    applied_revision: null,
    status: "rejected",
    error_code,
    error,
    acked_at: new Date(nowMs).toISOString(),
  };
}

interface AckSource {
  command_id: string;
  action: CommandAction;
  resource: CommandResource;
  resource_id: string;
  revision: number;
}

/** 从一条（已通过校验的）命令构造 ACK；结构型 ACK 用 `null` 身份时不要走这里。 */
function ackFrom(
  cmd: AckSource,
  status: AckStatus,
  error_code?: ErrorCode,
  error?: string,
  applied_revision?: number | null,
  state?: ResourceSnapshot | null,
): CommandAck {
  const ack: CommandAck = {
    command_id: cmd.command_id,
    action: cmd.action,
    resource: cmd.resource,
    resource_id: cmd.resource_id,
    revision: cmd.revision,
    applied_revision: applied_revision ?? null,
    status,
    acked_at: new Date().toISOString(),
  };
  if (error_code !== undefined) ack.error_code = error_code;
  if (error !== undefined) ack.error = error;
  if (state !== undefined) ack.state = state;
  return ack;
}
