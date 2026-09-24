/**
 * WP6 Command / Revision / ACK 协议 —— 统一出口。
 *
 * 契约定义见 `types.ts`，校验/闸门见 `validator.ts`。本文件只做 re-export，
 * 让调用方（WP7/WP8/WP9、agent 侧 Go 实现的镜像校对）只有一个 import 路径。
 *
 * 用法速览：
 *
 *   1. 用 createCommand 构造下发信封（会立刻校验 payload，坏 payload 当场抛错）。
 *   2. 用 ControlValidator.handle(cmd, applier) 跑校验 + revision 闸门 + 执行。
 *   3. 读返回的 ACK：applied / duplicate / rejected / failed。
 *
 *   同 revision 再下发得到 duplicate，更低 revision 得到 stale_revision，
 *   超过 expires_at 才到得到 command_expired。
 *
 * 本模块不含 Panel 到 Agent 的连接管理、不含鉴权、不含持久化：transport 由
 * 调用方决定（HTTP / WebSocket / Socket.IO 皆可），权威状态在 WP1 的 schema 里。
 */

export type {
  AckStatus,
  ActionSpec,
  ApplyTunnelEnvelope,
  ApplyTunnelPayload,
  CommandAck,
  CommandAckEnvelope,
  CommandAckPayload,
  CommandAction,
  CommandEnvelope,
  CommandEnvelopeBase,
  CommandOutcome,
  CommandPayload,
  CommandResource,
  CreateCommandInput,
  ErrorCode,
  RemoveTunnelEnvelope,
  RemoveTunnelPayload,
  ResourceRecord,
  ResourceSnapshot,
  ResourceStatus,
  StateRequestEnvelope,
  StateRequestPayload,
  SuspendTunnelEnvelope,
  SuspendTunnelPayload,
  TargetDescriptor,
  UpdateTargetsEnvelope,
  UpdateTargetsPayload,
} from "./types.ts";

export {
  ACK_STATUSES,
  ACTION_SPECS,
  COMMAND_ACTIONS,
  COMMAND_RESOURCES,
  DEFAULT_APPLIED_STATUS,
  ENVELOPE_KEYS,
  ERROR_CODES,
  IP_TYPES,
  LOAD_BALANCE_TYPES,
  RESOURCE_STATUSES,
  TARGET_PROTOCOLS,
  TUNNEL_TYPES,
} from "./types.ts";

export type {
  ApplyResult,
  CommandApplier,
  CommandOutcomeInternal,
  ControlValidatorOptions,
  RevisionGateDecision,
  ValidationResult,
} from "./validator.ts";

export {
  ACTION_PAYLOAD_KEYS,
  ControlProtocolError,
  ControlValidator,
  DEFAULT_COMMAND_TTL_MS,
  MAX_ADDRESS_LEN,
  MAX_COMMAND_ID_LEN,
  MAX_LEDGER_ENTRIES,
  MAX_NAME_LEN,
  MAX_RESOURCE_ID_LEN,
  MAX_TARGETS,
  checkRevisionGate,
  commandFingerprint,
  expiresAtFrom,
  isExpired,
  parseTimestamp,
  validateEnvelope,
  validatePayload,
} from "./validator.ts";

/* ================================================================== */
/* 下发侧工厂                                                            */
/* ================================================================== */

import { randomUUID } from "node:crypto";
import { DEFAULT_COMMAND_TTL_MS, expiresAtFrom, validatePayload } from "./validator.ts";
import type { CommandAction, CommandEnvelope, CommandPayload, CreateCommandInput } from "./types.ts";
import { ACTION_SPECS } from "./types.ts";

export interface CreateCommandOptions {
  /** TTL 覆盖（毫秒）；缺省 DEFAULT_COMMAND_TTL_MS。 */
  ttl_ms?: number;
  command_id?: string;
  issued_at?: string;
}

/**
 * 构造一条可下发的信封：补 `command_id` 与 `expires_at`（`issued_at + ttl`）。
 *
 * 可由显式 `action` 指定（推荐），或按 payload 形状推断（`tunnel` → apply_tunnel，
 * `targets` → update_targets，`applied_revision|status` → command_ack，`reason` →
 * suspend_tunnel，空对象 → state_request）。**`remove_tunnel` 与 `suspend_tunnel` 的
 * payload 形状相同（都可只有 `reason`），必须显式传 action。**
 *
 * 构造后立刻跑一次 `validatePayload`，**坏 payload 在这里就抛错**，而不是等到对端
 * 校验才发现。
 */
export function createCommand(
  input: Omit<CreateCommandInput, "payload"> & {
    payload: CommandPayload;
    action?: CommandAction;
  } & CreateCommandOptions,
): CommandEnvelope {
  const { ttl_ms, command_id, issued_at, action: explicitAction, ...rest } = input;
  const action = explicitAction ?? inferAction(input.payload);
  const issuedAt = issued_at ?? new Date(Date.now()).toISOString();
  const ttlMs = ttl_ms ?? DEFAULT_COMMAND_TTL_MS;

  const payloadError = validatePayload(action, input.payload);
  if (payloadError) {
    throw new TypeError(`createCommand: payload 不合法 (${action}): ${payloadError}`);
  }
  const spec = ACTION_SPECS[action];
  if (!spec.resources.includes(rest.resource)) {
    throw new TypeError(`createCommand: action ${action} 不允许作用于 ${rest.resource}`);
  }
  if (rest.revision < spec.minRevision) {
    throw new TypeError(`createCommand: action ${action} 要求 revision >= ${spec.minRevision}`);
  }

  const envelope = {
    command_id: command_id ?? randomUUID(),
    resource: rest.resource,
    resource_id: rest.resource_id,
    revision: rest.revision,
    action,
    payload: input.payload,
    expires_at: expiresAtFrom(Date.parse(issuedAt), ttlMs),
  } as unknown as CommandEnvelope;
  if (issuedAt) {
    (envelope as { issued_at?: string }).issued_at = issuedAt;
  }
  return envelope;
}

/** 按 payload 形状反推 action。 */
function inferAction(payload: unknown): CommandAction {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("payload 必须是对象");
  }
  const keys = Object.keys(payload as Record<string, unknown>);
  const has = (k: string) => keys.includes(k);
  if (has("tunnel")) return "apply_tunnel";
  if (has("targets")) return "update_targets";
  if (has("applied_revision") || has("status")) return "command_ack";
  if (has("reason")) return "suspend_tunnel";
  return "state_request";
}
