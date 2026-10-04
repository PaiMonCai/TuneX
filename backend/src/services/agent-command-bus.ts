/**
 * v3 outbound-only Agent command bus.
 *
 * The panel never dials an Agent. Orchestrator commands are queued in Redis and
 * the authenticated Agent polls /api/internal/node/commands over its existing
 * outbound HTTP path, executes locally, then POSTs an ACK. Redis is transport
 * state only; DB desired state remains canonical and startup restore comes from
 * buildDesiredNodeSnapshot().
 */
import { db } from "../db.ts";
import { redis, scopedKey } from "../redis.ts";
import { validatePayload, type CommandEnvelope } from "./control-protocol/index.ts";
import { admitPersistedProtocol } from "./forward-contract.ts";
import {
  targetHealthWireEntries,
  type TargetHealthWireEntry,
} from "./target-health-read.ts";
import {
  admissionLayerLabel,
  admitAction,
  admitOnNode,
  loadNodeCapabilityFacts,
  type AgentV2CapabilityFacts,
} from "./runtime-admission.ts";
import { randomUUID } from "node:crypto";
import {
  AgentTransportError,
  RELAY_DISPATCH_ERROR_CODES,
  type AgentTransport,
  type AgentTunnelConfig,
  type OrchestratorNode,
} from "./orchestrator.ts";

export interface QueuedAgentCommand {
  envelope: CommandEnvelope;
  config: AgentTunnelConfig | null;
  /** V4-WP11C diagnose payload; delivered beside the envelope, like `config`. */
  probe?: { targets: { host: string; port: number }[]; timeout_ms?: number } | null;
  queued_at: string;
}

export interface AgentCommandAck {
  command_id: string;
  /** Echoed by the agent. Verified against the pending record when present. */
  action?: string | null;
  resource_id?: string | null;
  ok: boolean;
  applied_revision?: number | null;
  error_code?: string | null;
  error?: string | null;
  /** V4-WP11C: a read-only action's findings (diagnose). Bounded below. */
  results?: AgentDiagnoseResult[] | null;
  /** V4-WP11C: the node's own bounded self report (collect_diagnostics). */
  facts?: NodeSelfFacts | null;
}

/**
 * The node self report, as validated on this side.
 *
 * Deliberately a closed shape: an agent (or anything holding its credential)
 * cannot widen a diagnostic into an arbitrary payload, because every field here
 * is checked and the object is rebuilt rather than trusted.
 */
export interface NodeSelfFacts {
  version: string;
  role: string;
  agent_id: string;
  node_id: string;
  runtime: {
    tunnel_count: number;
    truncated: boolean;
    ports_total: number;
    listen_ports: number[];
    tunnels: { id: string; mode: string; ingress_port: number; egress_port?: number; revision: number; crosses_node: boolean }[];
  };
  state_dir: {
    path: string;
    configured: boolean;
    dir_exists: boolean;
    cache_present: boolean;
    cache_mod_time?: string;
    cache_valid: boolean;
  };
  process: {
    uptime_seconds: number;
    started_at: string;
    go_version: string;
    os: string;
    arch: string;
    cpu_count: number;
    gomaxprocs: number;
    goroutines: number;
    heap_bytes: number;
  };
  shutting_down: boolean;
}

/** One probe outcome, as reported by the agent. */
export interface AgentDiagnoseResult {
  host: string;
  port: number;
  status: string;
  elapsed_ms: number;
  resolved_ip?: string;
  detail?: string;
}

const COMMAND_TTL_S = 120;
const ACK_TIMEOUT_MS = 15_000;
const ACK_POLL_MS = 100;
/** Hard ceiling on a stored ACK body; anything larger is refused, not truncated
 * into a shape the caller would read as a real result. */
const ACK_MAX_BYTES = 8 * 1024;
/** V4-WP11C caps: a probe request may carry at most this many results back. */
export const DIAGNOSE_RESULT_MAX_ITEMS = 8;
const DIAGNOSE_RESULT_HOST_MAX = 253;
const DIAGNOSE_RESULT_DETAIL_MAX = 160;
/** Error text is user-facing and stored in a VarChar(500) column upstream. */
const ACK_ERROR_MAX_CHARS = 500;
/** Mirrors the validator's own cap so a locally-built probe cannot exceed it. */
const DIAGNOSE_MAX_TIMEOUT_MS = 5000;
const ACK_ERROR_CODE_MAX_CHARS = 64;

function queueKey(scope: number, nodeId: number): string {
  return scopedKey(scope, "agent", "command", String(nodeId), "queue");
}
function ackKey(scope: number, nodeId: number, commandId: string): string {
  return scopedKey(scope, "agent", "command", String(nodeId), "ack", commandId);
}
/**
 * Pending-command ledger. An ACK is only accepted for a command this panel
 * actually issued to this node, within its lifetime. Without it, anyone holding
 * a node credential could inject an ACK for a command id of their choosing and
 * the orchestrator would treat it as that node's answer.
 */
function pendingKey(scope: number, nodeId: number, commandId: string): string {
  return scopedKey(scope, "agent", "command", String(nodeId), "pending", commandId);
}

/** The binding facts of an issued command, kept for ACK validation. */
interface PendingCommand {
  command_id: string;
  action: string;
  resource_id: string;
  revision: number;
  issued_at: string;
  /** Absolute deadline (ISO) — the ACK is not evidence after this instant. */
  expires_at: string;
  /**
   * The exact target set a diagnose command asked for. An answer that does not
   * cover it is refused, because "we could not probe B" would otherwise be read
   * as "A is reachable, so the path is fine".
   */
  expected_targets?: { host: string; port: number }[] | null;
}

/**
 * The narrow Redis surface this module needs.
 *
 * It is an interface rather than direct `redis.*` calls so the ACK-binding rules
 * below can be tested without a live Redis: those rules are security decisions,
 * and "only covered by an integration run" is not good enough for them.
 */
export interface CommandBusStore {
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  /** Queue a payload with a TTL (atomically in production). */
  push(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Set a payload with a TTL, overwriting (used for the pending ledger). */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Set only when absent; returns null when the key already existed. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<string | null>;
  /** Pop the oldest queued payload. */
  shift(key: string): Promise<string | null>;
}

const redisStore: CommandBusStore = {
  get: (key) => redis.get(key),
  del: (key) => redis.del(key),
  async push(key, value, ttlSeconds) {
    const tx = redis.multi();
    tx.rpush(key, value);
    tx.expire(key, ttlSeconds);
    await tx.exec();
  },
  async set(key, value, ttlSeconds) {
    await redis.set(key, value, "EX", ttlSeconds);
  },
  async setIfAbsent(key, value, ttlSeconds) {
    return redis.set(key, value, "EX", ttlSeconds, "NX");
  },
  shift: (key) => redis.lpop(key),
};

async function nodeScope(nodeId: number): Promise<number> {
  const node = await db.node.findUnique({
    where: { id: nodeId },
    select: { node_group: { select: { workspace_id: true } } },
  });
  if (!node) throw new AgentTransportError(
    RELAY_DISPATCH_ERROR_CODES.agent_rejected,
    `节点 ${nodeId} 不存在，拒绝下发`,
  );
  return node.node_group.workspace_id;
}

export interface EnqueueDeps {
  /**
   * Resolves the workspace scope a node's keys live under. Injectable for the
   * same reason the store is: the ordering and binding rules below are security
   * decisions, and they must be testable without a database.
   */
  resolveScope?: (nodeId: number) => Promise<number>;
}

export async function enqueueAgentCommand(
  nodeId: number,
  envelope: CommandEnvelope,
  config: AgentTunnelConfig | null,
  store: CommandBusStore = redisStore,
  probe?: QueuedAgentCommand["probe"],
  deps: EnqueueDeps = {},
): Promise<{ scope: number }> {
  const scope = await (deps.resolveScope ?? nodeScope)(nodeId);
  const item: QueuedAgentCommand = {
    envelope,
    config,
    ...(probe ? { probe } : {}),
    queued_at: new Date().toISOString(),
  };
  const key = queueKey(scope, nodeId);
  const pending: PendingCommand = {
    command_id: envelope.command_id,
    action: String(envelope.action ?? ""),
    resource_id: String(envelope.resource_id ?? ""),
    revision: Number(envelope.revision ?? 0),
    issued_at: item.queued_at,
    expires_at: String(envelope.expires_at ?? ""),
    expected_targets: probe?.targets ? probe.targets.map((t) => ({ host: t.host, port: t.port })) : null,
  };
  // Register the binding BEFORE publishing the command. The reverse order has a
  // real race: a fast agent can execute and ACK between the two writes, and the
  // answer would then be rejected as "unknown command" while the caller waits for
  // a timeout it can no longer receive.
  await store.set(pendingKey(scope, nodeId, envelope.command_id), JSON.stringify(pending), COMMAND_TTL_S);
  try {
    await store.push(key, JSON.stringify(item), COMMAND_TTL_S);
  } catch (error) {
    // Never leave a binding for a command that was never queued.
    await clearPendingCommand(scope, nodeId, envelope.command_id, store);
    throw error;
  }
  return { scope };
}

/**
 * Clear the pending record once its command is finished with (ack consumed or
 * timed out). Replay of the same command id afterwards is then impossible rather
 * than merely unlikely.
 */
async function clearPendingCommand(
  scope: number,
  nodeId: number,
  commandId: string,
  store: CommandBusStore,
): Promise<void> {
  await store.del(pendingKey(scope, nodeId, commandId)).catch(() => {});
}

export async function dequeueAgentCommand(
  scope: number,
  nodeId: number,
  store: CommandBusStore = redisStore,
): Promise<QueuedAgentCommand | null> {
  const raw = await store.shift(queueKey(scope, nodeId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as QueuedAgentCommand;
    if (!parsed || typeof parsed !== "object" || !parsed.envelope) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Store one Agent ACK, but only for a command this panel issued to THIS node and
 * that is still inside its lifetime.
 *
 * Rejections are the point of the function:
 *   · unknown/expired command id → the ACK is not evidence of anything, and
 *     accepting it would let a holder of the node credential fabricate a result
 *     for a command that was never sent;
 *   · an applied revision ahead of the issued revision → impossible, so forged
 *     or misrouted;
 *   · a duplicate ACK → the first answer wins (SET NX), so a late second answer
 *     cannot rewrite a result the orchestrator may already have acted on.
 *
 * Error text is truncated rather than rejected: hiding a real node failure
 * because its message was long would be worse than storing a clipped one.
 */
export async function storeAgentCommandAck(
  scope: number,
  nodeId: number,
  ack: AgentCommandAck,
  store: CommandBusStore = redisStore,
): Promise<void> {
  if (!ack || typeof ack.command_id !== "string" || ack.command_id.trim() === "") {
    throw new TypeError("command_id is required");
  }
  const commandId = ack.command_id.trim();

  const rawPending = await store.get(pendingKey(scope, nodeId, commandId));
  if (!rawPending) {
    throw new TypeError(`unknown or expired command_id: ${commandId}`);
  }
  let pending: PendingCommand | null = null;
  try {
    pending = JSON.parse(rawPending) as PendingCommand;
  } catch {
    pending = null;
  }
  if (!pending || pending.command_id !== commandId) {
    throw new TypeError(`unknown or expired command_id: ${commandId}`);
  }
  // The panel's deadline binds the answer too: a result that arrives after the
  // command expired is not the answer to a question anyone is still asking.
  if (pending.expires_at) {
    const deadline = Date.parse(pending.expires_at);
    if (Number.isFinite(deadline) && Date.now() > deadline) {
      throw new TypeError(`ack after command expiry: ${commandId}`);
    }
  }
  // An ACK that says which action/resource it is answering must agree with what
  // was issued. Without this, a node (or anyone holding its credential) could
  // answer a diagnose with the outcome of some other command.
  if (typeof ack.action === "string" && ack.action !== "" && ack.action !== pending.action) {
    throw new TypeError(`ack action ${ack.action} does not match issued action ${pending.action}`);
  }
  if (typeof ack.resource_id === "string" && ack.resource_id !== "" && ack.resource_id !== pending.resource_id) {
    throw new TypeError(`ack resource_id ${ack.resource_id} does not match issued ${pending.resource_id}`);
  }

  const normalized: {
    command_id: string;
    ok: boolean;
    applied_revision: number | null;
    error_code: string | null;
    error: string | null;
    results?: AgentDiagnoseResult[];
    facts?: NodeSelfFacts;
  } = {
    command_id: commandId,
    ok: ack.ok === true,
    applied_revision:
      typeof ack.applied_revision === "number" && Number.isFinite(ack.applied_revision)
        ? ack.applied_revision
        : null,
    error_code:
      typeof ack.error_code === "string" && ack.error_code !== ""
        ? ack.error_code.slice(0, ACK_ERROR_CODE_MAX_CHARS)
        : null,
    error:
      typeof ack.error === "string" && ack.error !== ""
        ? ack.error.slice(0, ACK_ERROR_MAX_CHARS)
        : null,
  };

  // A node cannot have applied a revision newer than the one it was told to
  // apply for this command.
  if (
    normalized.applied_revision !== null &&
    pending.revision > 0 &&
    normalized.applied_revision > pending.revision
  ) {
    throw new TypeError(
      `applied_revision ${normalized.applied_revision} exceeds issued revision ${pending.revision}`,
    );
  }

  const facts = normalizeNodeSelfFacts(ack.facts);
  if (facts) {
    if (pending.action !== "collect_diagnostics") {
      throw new TypeError("a self report is only accepted for collect_diagnostics");
    }
    normalized.facts = facts;
  } else if (pending.action === "collect_diagnostics" && ack.ok) {
    throw new TypeError("collect_diagnostics acknowledged OK without facts");
  }

  const results = normalizeDiagnoseResults(ack.results);
  if (results) {
    // A diagnose answer must cover exactly the requested target set.
    if (pending.action === "diagnose_tunnel") {
      const expected = pending.expected_targets ?? [];
      const problem = matchExpectedTargets(expected, results);
      if (problem) throw new TypeError(problem);
      if (!ack.ok) {
        // A refused diagnose may legitimately carry no results.
      } else if (results.length !== expected.length) {
        throw new TypeError(`diagnose ack returned ${results.length} results for ${expected.length} targets`);
      }
    }
    normalized.results = results;
  } else if (pending.action === "diagnose_tunnel" && ack.ok) {
    throw new TypeError("diagnose ack returned no results");
  }

  const payload = JSON.stringify(normalized);
  if (Buffer.byteLength(payload, "utf8") > ACK_MAX_BYTES) {
    throw new TypeError("ack payload too large");
  }

  const stored = await store.setIfAbsent(ackKey(scope, nodeId, commandId), payload, COMMAND_TTL_S);
  if (stored === null) {
    // A duplicate is not a new fact. Keep the first answer.
    throw new TypeError(`duplicate ack for command ${commandId}`);
  }
}

/**
 * Bound and validate the structured results a read-only action returns.
 *
 * Undefined/absent stays absent (apply-style ACKs carry no results). A malformed
 * list is refused rather than partially trusted: a diagnostic that reports half
 * the probes as "reachable" while dropping the rest would read as "all good".
 */
export function normalizeDiagnoseResults(value: unknown): AgentDiagnoseResult[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new TypeError("results must be an array");
  if (value.length > DIAGNOSE_RESULT_MAX_ITEMS) {
    throw new TypeError(`results has more than ${DIAGNOSE_RESULT_MAX_ITEMS} items`);
  }
  const out: AgentDiagnoseResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") throw new TypeError("result entries must be objects");
    const row = entry as Record<string, unknown>;
    if (typeof row.host !== "string" || row.host.length > DIAGNOSE_RESULT_HOST_MAX) {
      throw new TypeError("result host is missing or too long");
    }
    if (!Number.isInteger(row.port) || (row.port as number) < 1 || (row.port as number) > 65535) {
      throw new TypeError("result port is not a valid TCP port");
    }
    if (typeof row.status !== "string" || row.status.length > 32) {
      throw new TypeError("result status is missing or too long");
    }
    out.push({
      host: row.host,
      port: row.port as number,
      status: row.status,
      elapsed_ms: Number.isFinite(row.elapsed_ms) ? Math.max(0, Math.trunc(row.elapsed_ms as number)) : 0,
      ...(typeof row.resolved_ip === "string" && row.resolved_ip.length <= DIAGNOSE_RESULT_HOST_MAX
        ? { resolved_ip: row.resolved_ip } : {}),
      ...(typeof row.detail === "string" ? { detail: row.detail.slice(0, DIAGNOSE_RESULT_DETAIL_MAX) } : {}),
    });
  }
  return out;
}

/**
 * The answer must describe the request. Missing, duplicated or unknown targets
 * all mean the reply does not answer this question, so it is refused instead of
 * being rendered as a partial success.
 */
export function matchExpectedTargets(
  expected: { host: string; port: number }[],
  results: AgentDiagnoseResult[],
): string | null {
  const key = (host: string, port: number) => `${host.toLowerCase()}:${port}`;
  const want = new Set(expected.map((t) => key(t.host, t.port)));
  const seen = new Set<string>();
  for (const r of results) {
    const k = key(r.host, r.port);
    if (!want.has(k)) return `diagnose ack reported unrequested target ${k}`;
    if (seen.has(k)) return `diagnose ack reported duplicate target ${k}`;
    seen.add(k);
  }
  for (const t of expected) {
    if (!seen.has(key(t.host, t.port))) return `diagnose ack is missing target ${key(t.host, t.port)}`;
  }
  return null;
}

/**
 * Validate and rebuild a node self report.
 *
 * Every field is bounded and type-checked, and the object is constructed here
 * rather than stored as-is: a diagnostic answer that the panel passes through
 * would be a way for a node to place arbitrary data in a panel artefact.
 */
export function normalizeNodeSelfFacts(value: unknown): NodeSelfFacts | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("facts must be an object");
  const raw = value as Record<string, unknown>;
  const str = (v: unknown, max: number): string => {
    if (typeof v !== "string") throw new TypeError("fact string field missing");
    return v.length > max ? v.slice(0, max) : v;
  };
  const int = (v: unknown, max: number): number => {
    if (!Number.isFinite(v)) throw new TypeError("fact numeric field missing");
    return Math.max(0, Math.min(max, Math.trunc(v as number)));
  };
  const bool = (v: unknown): boolean => v === true;

  const runtime = raw.runtime as Record<string, unknown> | undefined;
  const stateDir = raw.state_dir as Record<string, unknown> | undefined;
  const process = raw.process as Record<string, unknown> | undefined;
  if (!runtime || !stateDir || !process) throw new TypeError("facts missing a required section");

  const rawTunnels = Array.isArray(runtime.tunnels) ? runtime.tunnels : [];
  if (rawTunnels.length > DIAGNOSE_RESULT_MAX_ITEMS * 8) {
    throw new TypeError("facts contain more tunnels than one answer may carry");
  }
  const tunnels = rawTunnels.map((entry) => {
    const row = entry as Record<string, unknown>;
    return {
      id: str(row.id, 255),
      mode: str(row.mode, 16),
      ingress_port: int(row.ingress_port, 65535),
      ...(row.egress_port === undefined ? {} : { egress_port: int(row.egress_port, 65535) }),
      revision: int(row.revision, Number.MAX_SAFE_INTEGER),
      crosses_node: bool(row.crosses_node),
    };
  });
  const ports = (Array.isArray(runtime.listen_ports) ? runtime.listen_ports : [])
    .slice(0, 256)
    .map((p) => int(p, 65535));

  return {
    version: str(raw.version, 64),
    role: str(raw.role, 32),
    agent_id: str(raw.agent_id, 128),
    node_id: str(raw.node_id, 128),
    runtime: {
      tunnel_count: int(runtime.tunnel_count, Number.MAX_SAFE_INTEGER),
      truncated: bool(runtime.truncated),
      ports_total: int(runtime.ports_total, 4096),
      listen_ports: ports,
      tunnels,
    },
    state_dir: {
      path: str(stateDir.path, 255),
      configured: bool(stateDir.configured),
      dir_exists: bool(stateDir.dir_exists),
      cache_present: bool(stateDir.cache_present),
      ...(typeof stateDir.cache_mod_time === "string" ? { cache_mod_time: stateDir.cache_mod_time.slice(0, 40) } : {}),
      cache_valid: bool(stateDir.cache_valid),
    },
    process: {
      uptime_seconds: int(process.uptime_seconds, Number.MAX_SAFE_INTEGER),
      started_at: str(process.started_at, 40),
      go_version: str(process.go_version, 32),
      os: str(process.os, 16),
      arch: str(process.arch, 16),
      cpu_count: int(process.cpu_count, 1024),
      gomaxprocs: int(process.gomaxprocs, 1024),
      goroutines: int(process.goroutines, 1_000_000),
      heap_bytes: int(process.heap_bytes, Number.MAX_SAFE_INTEGER),
    },
    shutting_down: bool(raw.shutting_down),
  };
}

export async function waitAgentCommandAck(
  scope: number,
  nodeId: number,
  commandId: string,
  timeoutMs = ACK_TIMEOUT_MS,
  store: CommandBusStore = redisStore,
): Promise<AgentCommandAck> {
  const key = ackKey(scope, nodeId, commandId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await store.get(key);
    if (raw) {
      await store.del(key);
      await clearPendingCommand(scope, nodeId, commandId, store);
      const ack = JSON.parse(raw) as AgentCommandAck;
      return ack;
    }
    await new Promise((resolve) => setTimeout(resolve, ACK_POLL_MS));
  }
  // Timed out: the command is abandoned, so its pending record must go too. A
  // late ACK for it would otherwise be accepted into a key nobody is watching
  // and could be mistaken for the answer to a later command.
  await clearPendingCommand(scope, nodeId, commandId, store);
  throw new AgentTransportError(
    RELAY_DISPATCH_ERROR_CODES.ack_timeout,
    `等待 Agent ACK 超时（node=${nodeId}, command=${commandId}）`,
  );
}

/**
 * Read the node's latest advertised capability facts (V4-WP11B actions +
 * V5-WP1 manifest).
 *
 * Deliberately narrow and lazy: this module is imported by the worker, so a
 * top-level Prisma import would connect during unit tests. The read itself
 * lives in `runtime-admission.ts` so the panel's admission facts have exactly
 * one loader; a failure there is reported as "no facts" (which still allows the
 * protocol-frozen baseline) instead of blocking every dispatch on a hiccup.
 */
async function loadCapabilityFacts(nodeId: number): Promise<AgentV2CapabilityFacts | null> {
  try {
    return await loadNodeCapabilityFacts(nodeId);
  } catch {
    return null;
  }
}

/**
 * Production transport: queue command and synchronously wait for the Agent ACK.
 * No Agent address or management token is required; node identity is proven by
 * the credential on the Agent -> Panel polling endpoints.
 */
export class OutboundAgentTransport implements AgentTransport {
  /**
   * capabilityFacts is injectable so the negotiation gate can be exercised
   * without a database. Production default reads the node's last state report.
   */
  constructor(
    private readonly capabilityFacts: (nodeId: number) => Promise<AgentV2CapabilityFacts | null> = loadCapabilityFacts,
    private readonly store: CommandBusStore = redisStore,
  ) {}

  /**
   * Refuse to queue a command the node has not advertised support for.
   *
   * V5-WP1: the gate now covers all three orthogonal dimensions (action +
   * protocol + transport) through the panel's single admission implementation.
   * The protocol is taken from the outgoing config, which is the very fact the
   * agent will act on — reading it from anywhere else would let the gate and the
   * payload disagree.
   *
   * This stays even though the scheduler already admits before dispatch: it is
   * the last line of defence, and it is the only one that also covers
   * non-scheduler callers (rollout, diagnosis, future routes).
   */
  private async assertCapability(
    node: OrchestratorNode,
    action: string,
    config?: AgentTunnelConfig | null,
  ): Promise<void> {
    let facts: AgentV2CapabilityFacts | null = null;
    try {
      facts = await this.capabilityFacts(node.id);
    } catch {
      // A stored value that cannot be read means "this node's negotiation facts
      // are unusable" — fail closed for everything except the protocol-frozen
      // baseline, exactly like an explicit disagreement.
      throw new AgentTransportError(
        RELAY_DISPATCH_ERROR_CODES.agent_rejected,
        `节点 ${node.id} 的能力上报无法读取，拒绝下发 ${action}；请升级 Agent`,
      );
    }
    const decision = admitOnNode(
      { nodeId: node.id, role: config?.mode === "EGRESS" ? "egress" : "ingress", facts },
      { action, protocol: config?.protocol },
    );
    if (!decision.ok) {
      throw new AgentTransportError(
        RELAY_DISPATCH_ERROR_CODES.agent_rejected,
        `${decision.detail}（原因=${decision.reason}，维度=${admissionLayerLabel(decision.layer)}）`,
      );
    }
  }

  private async send(
    node: OrchestratorNode,
    envelope: CommandEnvelope | undefined,
    config: AgentTunnelConfig | null,
  ): Promise<unknown> {
    if (!envelope) {
      throw new AgentTransportError(
        RELAY_DISPATCH_ERROR_CODES.ack_invalid,
        "outbound transport requires command envelope",
      );
    }
    // WP11B + WP1: never send an action/protocol/transport this node has not
    // told us it implements.
    await this.assertCapability(node, String(envelope.action ?? ""), config);
    const { scope } = await enqueueAgentCommand(node.id, envelope, config, this.store);
    const ack = await waitAgentCommandAck(scope, node.id, envelope.command_id, undefined, this.store);
    if (!ack.ok) {
      return {
        ok: false,
        error_code: ack.error_code ?? "apply_failed",
        error: ack.error ?? "agent rejected command",
      };
    }
    // An OK ack must carry the revision it applied. Substituting the issued
    // revision would turn "the agent did not tell us" into "the agent confirmed
    // this revision", which is exactly the fact the orchestrator then trusts.
    if (ack.applied_revision === null || ack.applied_revision === undefined) {
      return {
        ok: false,
        error_code: "ack_invalid",
        error: `agent acknowledged ${envelope.command_id} without applied_revision`,
      };
    }
    return { ok: true, applied_revision: ack.applied_revision };
  }

  applyEgress(node: OrchestratorNode, config: AgentTunnelConfig, envelope?: CommandEnvelope): Promise<unknown> {
    return this.send(node, envelope, config);
  }
  applyRelay(node: OrchestratorNode, config: AgentTunnelConfig, envelope?: CommandEnvelope): Promise<unknown> {
    return this.send(node, envelope, config);
  }
  applyDirect(node: OrchestratorNode, config: AgentTunnelConfig, envelope?: CommandEnvelope): Promise<unknown> {
    return this.send(node, envelope, config);
  }
  removeTunnel(node: OrchestratorNode, _tunnelId: string, envelope?: CommandEnvelope): Promise<unknown> {
    return this.send(node, envelope, null);
  }
  async isReachable(_node: OrchestratorNode): Promise<boolean> {
    // Reachability is proven by ACK. Avoid Panel -> Agent probes entirely.
    return true;
  }
}

/**
 * Issue a read-only diagnose command to one node and wait for its findings.
 *
 * It reuses the same rails as a mutating command on purpose: capability
 * negotiation decides whether the node implements the action at all, and the
 * pending/ACK ledger decides whether an answer is really this node's answer.
 * A diagnostic that bypassed those would be a second, weaker command path.
 */
export async function issueAgentDiagnose(
  input: {
    /** Only the id is needed: a probe needs no connect_ip and never dials from here. */
    nodeId: number;
    resourceId: string;
    targets: { host: string; port: number }[];
    timeoutMs?: number;
  },
  deps: {
    capabilityFacts?: (nodeId: number) => Promise<AgentV2CapabilityFacts | null>;
    store?: CommandBusStore;
  } = {},
): Promise<{ ok: true; results: AgentDiagnoseResult[] } | { ok: false; error_code: string; error: string }> {
  const factsReader = deps.capabilityFacts ?? loadCapabilityFacts;
  const store = deps.store ?? redisStore;

  const payload = {
    targets: input.targets.map((t) => ({ host: t.host, port: t.port })),
    ...(input.timeoutMs ? { timeout_ms: Math.min(input.timeoutMs, DIAGNOSE_MAX_TIMEOUT_MS) } : {}),
  };
  // Validate through the same frozen contract as every other action: a diagnose
  // that bypassed the validator would be a second, weaker command path.
  const payloadError = validatePayload("diagnose_tunnel", payload);
  if (payloadError) {
    return { ok: false, error_code: "invalid_payload", error: payloadError };
  }
  const envelope = {
    command_id: randomUUID(),
    resource: "tunnel",
    resource_id: input.resourceId,
    revision: 0, // read-only: it never advances a runtime revision
    action: "diagnose_tunnel",
    payload,
    expires_at: new Date(Date.now() + (input.timeoutMs ?? 20_000)).toISOString(),
  } as unknown as CommandEnvelope;

  let facts: AgentV2CapabilityFacts | null = null;
  try {
    facts = await factsReader(input.nodeId);
  } catch {
    return { ok: false, error_code: "incompatible_agent", error: `节点 ${input.nodeId} 的能力上报形状非法，拒绝下发诊断` };
  }
  // Diagnose has no protocol dimension: it probes a target path, it is not a
  // forward runtime. Requiring a protocol fact here would refuse a diagnostic on
  // a node whose manifest is silent about protocols for unrelated reasons.
  const decision = admitAction({ nodeId: input.nodeId, role: "ingress", facts }, "diagnose_tunnel");
  if (!decision.ok) {
    return { ok: false, error_code: decision.reason, error: decision.detail };
  }

  const { scope } = await enqueueAgentCommand(input.nodeId, envelope, null, store, {
    targets: input.targets,
    ...(input.timeoutMs ? { timeout_ms: input.timeoutMs } : {}),
  });
  let ack: AgentCommandAck;
  try {
    ack = await waitAgentCommandAck(scope, input.nodeId, envelope.command_id, input.timeoutMs ?? 20_000, store);
  } catch (error) {
    return { ok: false, error_code: "ack_timeout", error: (error as Error).message };
  }
  if (!ack.ok) {
    return { ok: false, error_code: ack.error_code ?? "diagnose_failed", error: ack.error ?? "节点拒绝执行诊断" };
  }
  return { ok: true, results: ack.results ?? [] };
}

/**
 * Ask one node for its own bounded self report.
 *
 * Same rails as every other command: capability negotiation decides whether the
 * node implements the action, and the pending/ACK ledger decides whether the
 * answer really belongs to this command.
 */
export async function issueAgentDiagnostics(
  input: { nodeId: number; timeoutMs?: number },
  deps: {
    capabilityFacts?: (nodeId: number) => Promise<AgentV2CapabilityFacts | null>;
    store?: CommandBusStore;
  } = {},
): Promise<{ ok: true; facts: NodeSelfFacts } | { ok: false; error_code: string; error: string }> {
  const factsReader = deps.capabilityFacts ?? loadCapabilityFacts;
  const store = deps.store ?? redisStore;

  let facts: AgentV2CapabilityFacts | null = null;
  try {
    facts = await factsReader(input.nodeId);
  } catch {
    return { ok: false, error_code: "incompatible_agent", error: `节点 ${input.nodeId} 的能力上报形状非法` };
  }
  // Action-only, same reason as diagnose_tunnel: a node-level self report has no
  // protocol dimension.
  const decision = admitAction({ nodeId: input.nodeId, role: "ingress", facts }, "collect_diagnostics");
  if (!decision.ok) {
    return { ok: false, error_code: decision.reason, error: decision.detail };
  }

  const timeoutMs = input.timeoutMs ?? 10_000;
  const envelope = {
    command_id: randomUUID(),
    resource: "node",
    resource_id: `node-${input.nodeId}`,
    revision: 0,
    action: "collect_diagnostics",
    payload: {},
    expires_at: new Date(Date.now() + timeoutMs).toISOString(),
  } as unknown as CommandEnvelope;

  const { scope } = await enqueueAgentCommand(input.nodeId, envelope, null, store, null);
  let ack: AgentCommandAck;
  try {
    ack = await waitAgentCommandAck(scope, input.nodeId, envelope.command_id, timeoutMs, store);
  } catch (error) {
    return { ok: false, error_code: "ack_timeout", error: (error as Error).message };
  }
  if (!ack.ok) {
    return { ok: false, error_code: ack.error_code ?? "diagnostics_failed", error: ack.error ?? "节点拒绝自检" };
  }
  if (!ack.facts) {
    return { ok: false, error_code: "incomplete_result", error: "节点没有返回自检事实" };
  }
  return { ok: true, facts: ack.facts };
}

function hostPort(host: string, port: number): string {
  const h = host.trim();
  return h.includes(":") && !h.startsWith("[") ? `[${h}]:${port}` : `${h}:${port}`;
}
function firstConnectIp(raw: string | null): string | null {
  if (!raw) return null;
  return raw.split(",").map((s) => s.trim()).find(Boolean) ?? null;
}

/**
 * Canonical desired snapshot used by Agent startup restore.
 * Only concrete node bindings are considered; NodeGroup is never re-interpreted
 * as placement.
 *
 * V5-WP4/G0: this is the one dispatch-ish path that deliberately bypasses the
 * orchestrator — the Agent *pulls* its desired state — so the protocol gate has
 * to run here too. Before, every entry was emitted with `protocol: "tcp"`, and a
 * historical non-TCP Forward whose row is still `desired_status='active'` was
 * therefore handed to the Agent as TCP on **every node restart**: the gate found
 * a `wss` row being re-applied every time an Agent came back, during the LKG
 * cases, because of exactly this.
 *
 * The rule: a row whose protocol fact is not admitted is **omitted** from the
 * snapshot (a single unrunnable Forward must not stop a node from restoring the
 * rest of its work) and reported in `skipped` so the omission is observable
 * instead of silent.
 */
/** 一行 desired 状态（`buildDesiredNodeSnapshot` 的输入投影）。 */
export interface DesiredRowProjection {
  id: number;
  tunnel_mode: string | null;
  desired_status: string | null;
  config_revision: number | null;
  forward_protocol?: unknown;
  tunnel_type?: unknown;
  ingress_node_id: number | null;
  egress_node_id: number | null;
  listen_port: number | null;
  listen_ip: string | null;
  remote_host: string | null;
  remote_port: number | null;
  egress_port: number | null;
  egress_node?: { connect_ip: string | null } | null;
  egress_pool?: { lb_strategy: string | null; targets: Array<{ host: string; port: number; weight: number; order_by: number }> } | null;
  /** V5-WP5-A1: node-local tls front paths (paths only, never key material). */
  tls_cert_path?: string | null;
  tls_key_path?: string | null;
}

export type DesiredRowOutcome =
  | { kind: "config"; config: AgentTunnelConfig }
  | { kind: "skip"; reason: string }
  | { kind: "not_for_node" };

/**
 * One desired row → the Agent config for `nodeId` (pure).
 *
 * Extracted so the protocol decision is testable without a database: this is the
 * exact spot where a historical non-TCP Forward used to be silently relabelled
 * `tcp` on every node restart.
 */
export function desiredTunnelConfigFor(
  row: DesiredRowProjection,
  nodeId: number,
  /**
   * V5.2 WP7 —— 该转发出口池的健康事实，按隧道 id 索引。
   *
   * 作为**入参**而不是在这里读库：这个函数是纯的（可离线断言"哪些行该下发"），而健康
   * 是 IO 结果。由调用方（快照构建）读一次、传进来，纯函数只负责把两类事实并排放好。
   */
  healthByTunnel: ReadonlyMap<number, readonly TargetHealthWireEntry[]> = new Map(),
): DesiredRowOutcome {
  const revision = row.config_revision ?? 0;
  if (revision <= 0) return { kind: "not_for_node" };

  // One row, one protocol: resolved once and used by every leg below, so the
  // three branches cannot disagree about which protocol this Forward is.
  const protocol = admitPersistedProtocol({
    forward_protocol: row.forward_protocol,
    tunnel_type: row.tunnel_type,
  });
  if (protocol === null) return { kind: "skip", reason: "protocol_not_supported" };

  // V5-WP5-A1: a tls front needs both paths. Without them the row is a broken
  // configuration, and the honest outcome is to keep it out of the snapshot —
  // the Agent must never be told "serve TLS" without a certificate.
  const tlsPaths =
    protocol === "tls"
      ? {
          tls_cert_path: (row.tls_cert_path ?? "").trim() || undefined,
          tls_key_path: (row.tls_key_path ?? "").trim() || undefined,
        }
      : {};
  if (protocol === "tls" && (tlsPaths.tls_cert_path === undefined || tlsPaths.tls_key_path === undefined)) {
    return { kind: "skip", reason: "tls_paths_missing" };
  }

  if (row.ingress_node_id === nodeId && row.tunnel_mode === "direct") {
    if (!row.listen_port || !row.remote_host || !row.remote_port) return { kind: "not_for_node" };
    return {
      kind: "config",
      config: {
        id: `tunex-${row.id}-direct`,
        mode: "DIRECT",
        ingress_port: row.listen_port,
        egress_port: 0,
        remote_host: row.remote_host,
        remote_port: row.remote_port,
        next_hop: "",
        targets: [],
        lb_strategy: "ROUND_ROBIN",
        protocol,
        ...tlsPaths,
        speed_limit: 0,
        revision,
        listen_host: row.listen_ip ?? undefined,
      },
    };
  }

  if (row.tunnel_mode === "relay" && row.egress_node_id === nodeId) {
    if (!row.egress_port) return { kind: "not_for_node" };
    const strategy =
      row.egress_pool?.lb_strategy === "rand" ? "RANDOM" :
      row.egress_pool?.lb_strategy === "weighted_round" ? "WEIGHTED_ROUND_ROBIN" :
      "ROUND_ROBIN";
    const poolTargets = (row.egress_pool?.targets ?? []).map((x) => ({
      host: x.host,
      port: x.port,
      weight: x.weight,
      order: Math.trunc(x.order_by),
    }));
    // V5.2 WP7: the snapshot carries health too, for the same reason the command path
    // does — and for one more that is easy to miss: an agent that RESTARTS rebuilds its
    // runtime from this snapshot, so a snapshot without health silently disables the
    // circuit breaker until the next command arrives. V5-G2 found it exactly that way
    // (connections still split 50/50 onto the refusing target after a restart).
    const health = healthByTunnel.get(row.id) ?? [];
    const healthForTargets = health.filter((h) =>
      poolTargets.some((t) => t.host === h.host && t.port === h.port),
    );
    return {
      kind: "config",
      config: {
        id: `tunex-${row.id}-egress`,
        mode: "EGRESS",
        ingress_port: 0,
        egress_port: row.egress_port,
        remote_host: "",
        remote_port: 0,
        next_hop: "",
        targets: poolTargets,
        ...(healthForTargets.length > 0 ? { target_health: healthForTargets } : {}),
        lb_strategy: strategy,
        protocol,
        speed_limit: 0,
        revision,
      },
    };
  }

  if (row.tunnel_mode === "relay" && row.ingress_node_id === nodeId) {
    const host = firstConnectIp(row.egress_node?.connect_ip ?? null);
    if (!row.listen_port || !row.egress_port || !host) return { kind: "not_for_node" };
    return {
      kind: "config",
      config: {
        id: `tunex-${row.id}-relay`,
        mode: "RELAY",
        ingress_port: row.listen_port,
        egress_port: 0,
        remote_host: host,
        remote_port: row.egress_port,
        next_hop: hostPort(host, row.egress_port),
        targets: [],
        lb_strategy: "ROUND_ROBIN",
        protocol,
        ...tlsPaths,
        speed_limit: 0,
        revision,
        listen_host: row.listen_ip ?? undefined,
      },
    };
  }

  return { kind: "not_for_node" };
}

export async function buildDesiredNodeSnapshot(
  nodeId: number,
): Promise<{ version: string; tunnels: AgentTunnelConfig[]; skipped: Array<{ id: number; reason: string }> }> {
  const rows = await db.tunnel.findMany({
    where: {
      desired_status: "active",
      OR: [{ ingress_node_id: nodeId }, { egress_node_id: nodeId }],
    },
    include: {
      egress_node: { select: { id: true, connect_ip: true } },
      egress_pool: {
        include: {
          targets: {
            where: { status: "active" },
            orderBy: { order_by: "asc" },
          },
        },
      },
    },
    orderBy: { id: "asc" },
  });

  // V5.2 WP7: read the health for the egress pools this snapshot will publish, ONCE,
  // and hand it to the pure mapping. A restart of this node must not silently lose the
  // circuit breaker, so the snapshot path publishes health exactly like the command
  // path does — one wire shape, two deliveries.
  const egressTargets: { host: string; port: number }[] = [];
  for (const t of rows as unknown as DesiredRowProjection[]) {
    if (t.tunnel_mode === "relay" && t.egress_node_id === nodeId) {
      for (const x of t.egress_pool?.targets ?? []) egressTargets.push({ host: x.host, port: x.port });
    }
  }
  const healthByTunnel = new Map<number, TargetHealthWireEntry[]>();
  if (egressTargets.length > 0) {
    const entries = await targetHealthWireEntries(egressTargets);
    for (const t of rows as unknown as DesiredRowProjection[]) {
      if (t.tunnel_mode !== "relay" || t.egress_node_id !== nodeId) continue;
      healthByTunnel.set(t.id, entries as TargetHealthWireEntry[]);
    }
  }

  // V5.3 WP9: ownership facts ride the snapshot as well, for the same reason health
  // does — an agent that restarts must still know its epoch, or the stale-epoch guard
  // resets to "never seen anything" and a demoted node could serve again.
  const leases = await db.placementLease.findMany({
    where: { tunnel_id: { in: (rows as unknown as DesiredRowProjection[]).map((r) => r.id) } },
    select: { tunnel_id: true, owner_node_id: true, epoch: true, lease_expires_at: true },
  });
  const leaseByTunnel = new Map(leases.map((l) => [l.tunnel_id, l]));

  const tunnels: AgentTunnelConfig[] = [];
  const skipped: Array<{ id: number; reason: string }> = [];
  for (const t of rows as unknown as DesiredRowProjection[]) {
    const outcome = desiredTunnelConfigFor(t, nodeId, healthByTunnel);
    if (outcome.kind === "skip") {
      skipped.push({ id: t.id, reason: outcome.reason });
    } else if (outcome.kind === "config") {
      const lease = leaseByTunnel.get(t.id);
      tunnels.push(
        lease && lease.owner_node_id === nodeId
          ? {
              ...outcome.config,
              ownership_epoch: lease.epoch,
              lease_expires_at: lease.lease_expires_at.toISOString(),
            }
          : outcome.config,
      );
    }
  }
  return { version: "tunex-v3", tunnels, skipped };
}
