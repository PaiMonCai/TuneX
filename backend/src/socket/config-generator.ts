/**
 * 节点配置生成（config-generator）
 *
 * 本模块是 `crypto/node-config.ts`（纯函数 + Fernet 序列化）之上的**编排层**：
 * 从 DB 拉取节点组 / 隧道 / 节点 / 链路，从 Redis 拉取出口端口与系统配置，
 * 然后复刻原版 `TunnelService.getNodeConfig(nodeGroup)` 的
 * `getInNodeConfig` / `getOutNodeConfig` 输出**形状与字节**。
 *
 * ── 权威依据 ──
 *  · 原版服务端反编译源：`/tmp/relayx_src2/src__services__tunnel.ts`
 *    （`pushNodeConfig` / `getInNodeConfig` / `getOutNodeConfig` /
 *      `filterAvailableTunnels` / `computeAllLimits` / `getConnectIP` /
 *      `getTunnelChainsFromTunnel`）
 *  · agent 二进制实测：`WAIT_LISTEN` 占位符解析、`4x["config","<fernet>"]` 裸字符串载荷
 *    （`/tmp/relayx-agent-reports/01-config-e2e.md`）
 *
 * ── 三条硬约束（违反任一条 → 原版 agent 进程级 panic）──
 *  ① `42["config","<密文>"]` 载荷是**裸字符串**，不是数组。本模块只产出**明文配置对象**
 *     （{@link generateNodeConfig}），加密与帧封装交给 `crypto/node-config.ts`
 *     （`encryptNodeConfig` / `buildConfigFrame`）以及 W2 的 config-pusher。
 *  ② 入口（in）节点的 `observers` **必须非空**。本模块恒注入指向 `${SITE_URL}/api/tunnel/observer`
 *     的 default observer。出口（out）节点配置**原版不带 `observers` 字段**（见下）。
 *  ③ `WAIT_LISTEN` 后**紧跟端口段、不带花括号**：`:WAIT_LISTEN20000-30000`。
 *     agent 反汇编里常量是 12 字节的 `:WAIT_LISTEN`，其余由 addr 透传（见 §WAIT_LISTEN）。
 *
 * ── in / out 配置差异（原版实测）──
 *  · in  ：`{ log, tls, services, chains, climiters, limiters, bypasses, admissions, observers }`
 *  · out ：`{ log, tls, chains, climiters, limiters, services }` —— **无 observers / bypasses / admissions**。
 *    注意 agent 对 `observers` 为**缺失**（Go nil slice）可容忍，但对**空数组**会 panic；
 *    因此 out 配置原样省略该字段（不要补 `observers: []`）。
 */

import { createHash } from "node:crypto";
import { isNodeGroupGranted } from "../services/node-group-policy.ts";
import { isIPv4, isIPv6 } from "node:net";
import { NodeType, TunnelCategory, TunnelType, IpType } from "@prisma/client";
import type { LoadBalanceType } from "@prisma/client";
import { db } from "../db.ts";
import { redis } from "../redis.ts";
import { env } from "../env.ts";
import { systemConfig } from "../services/config.ts";
import {
  DEFAULT_OBSERVER_NAME,
  DEFAULT_OBSERVER_PERIOD,
  observerEndpoint,
  serializeNodeConfig,
  type NodeConfig,
  type ServiceConfig,
} from "../crypto/node-config.ts";

/* ================================================================== */
/* 常量                                                               */
/* ================================================================== */

/** 出口端口缓存（Redis hash）：field = `${nodeId}:${type}`，value = 端口。 */
export const OUT_LISTEN_KEY = "tunnel:out_listen";

/** agent 动态选端口占位符前缀（原版字节级一致：`:WAIT_LISTEN` 12 字节）。 */
export const WAIT_LISTEN = "WAIT_LISTEN";

/** uuid v5 的 URL 命名空间（RFC 4122 附录 C）。 */
const UUID_NAMESPACE_URL = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** in 节点 config 的 `log.level`（原版减小 agent 噪声日志）。 */
export const DEFAULT_LOG_LEVEL = "fatal";
/** tls 段默认有效期。 */
export const DEFAULT_TLS_VALIDITY = "8760h";

/* ================================================================== */
/* 类型                                                               */
/* ================================================================== */

/** 可用于下发的最小节点视图。 */
export interface AvailableNode {
  id: number;
  node_id: string;
  connect_ip: string;
  weight: number;
  backup: boolean;
}

export interface AvailableNodeGroup {
  id: number;
  user_id: number;
  workspace_id: number;
  node_type: NodeType;
  load_balance_type: LoadBalanceType;
  nodes: AvailableNode[];
}

export interface AvailableTunnelChain {
  id: number;
  node_group_id: number;
  node_type: NodeType;
  node_group: AvailableNodeGroup;
}

export interface AvailableUserPlan {
  traffic: number | null;
  traffic_used: number;
  max_tunnels: number | null;
  whitelist_ips: string[] | null;
  plan: {
    traffic: number | null;
    max_tunnels: number | null;
    ip_limit: number | null;
    client_limit: number | null;
    bandwidth_limit: number | null;
    all_in_node_groups: boolean;
    all_out_node_groups: boolean;
    node_groups: { node_group_id: number }[];
  } | null;
}

export interface AvailableUser {
  id: number;
  personal_workspace?: { id: number } | null;
  node_group_grants?: { node_group_id: number; direction: NodeType; active: boolean }[];
  user_plan: AvailableUserPlan | null;
}

/**
 * 参与配置生成的隧道。字段全部取自 `tunnel` 表（含需要的关系展开）。
 * JSON 列（`listen_protocol` / `forward_addresses` / `forward_addresses_protocol`）
 * 用 `unknown` 承载 —— 本模块做形态归一化（既支持原版的**对象**形态，
 * 也支持 W1 隧道接口写入的**字符串数组**形态）。
 */
export interface AvailableTunnel {
  id: number;
  name: string;
  tunnel_type: TunnelType;
  category: TunnelCategory;
  listen_ip: string | null;
  listen_port: number | null;
  listen_protocol: unknown;
  forward_addresses: unknown;
  forward_addresses_protocol: unknown;
  load_balance_type: LoadBalanceType;
  ip_type: IpType;
  ip_limit: number | null;
  client_limit: number | null;
  bandwidth_limit: number | null;
  proxy_protocol: boolean;
  status: string;
  in_node_group_id: number;
  out_node_group_id: number | null;
  user_id: number;
  workspace_id: number;
  in_node_group?: AvailableNodeGroup;
  out_node_group?: AvailableNodeGroup | null;
  tunnel_chains?: AvailableTunnelChain[];
  /** in 节点组「协议封堵」列表（挂在隧道上避免二次查询；缺省 undefined）。 */
  in_node_group_block_protocols?: unknown;
  user?: AvailableUser;
}

/** 单条隧道的合并限速（取隧道级与套餐级的较小值）。 */
export interface TunnelLimit {
  ip_limit?: number;
  client_limit?: number;
  bandwidth_limit?: number;
  climiter_name?: string;
  limiter_name?: string;
}

export type OutListens = Record<string, string | number | null | undefined>;

export interface GenerateNodeConfigOptions {
  /** 覆盖 `SITE_URL`（默认取 {@link env}.siteUrl）。 */
  siteUrl?: string;
  /** 覆盖观测周期（秒的数字串，如 `"5"`）。不传则读系统配置 `OBSERVER_PERIOD`。 */
  observerPeriod?: string;
  /** 预取的隧道集（不传则内部按原版 `getAllAvailableTunnels` 语义查库）。 */
  allTunnels?: AvailableTunnel[];
  /** 预取的出口端口缓存（不传则读 Redis `${OUT_LISTEN_KEY}`）。 */
  outListens?: OutListens;
  /** 覆盖 `LIMIT_SCOPE`（`"tunnel"` = 按隧道限速，其它 = 按用户限速）。 */
  limitScope?: string;
  /** 预取的合并限速表（不传则内部用 {@link computeAllLimits} 计算）。 */
  tunnelLimits?: Map<number, TunnelLimit>;
}

/** {@link generateNodeConfig} 的返回：明文配置 + 线上 JSON + 指纹。 */
export interface GeneratedNodeConfig {
  nodeGroupId: number;
  nodeType: NodeType;
  /** 明文配置对象（未加密）。 */
  config: NodeConfig;
  /** 线上 JSON 字符串（紧凑、ASCII 安全，与 agent 期望逐字节一致）。 */
  json: string;
  /** 明文 JSON 的 sha256 hex（供 config-pusher 增量去重）。 */
  fingerprint: string;
}

/* ================================================================== */
/* 工具：形态归一化                                                    */
/* ================================================================== */

type JsonRecord = Record<string, unknown>;

function asRecord(v: unknown): JsonRecord | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as JsonRecord) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export interface ForwardAddress {
  address: string;
  host?: string;
  weight: number;
}

/**
 * 归一化 `forward_addresses`。
 *  · 原版：`[{ address, host?, weight }]`
 *  · W1 隧道接口：`["host:port", ...]`（weight 缺省 1）
 */
export function normalizeForwardAddresses(v: unknown): ForwardAddress[] {
  if (!Array.isArray(v)) return [];
  const out: ForwardAddress[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      if (item.trim() === "") continue;
      out.push({ address: item.trim(), weight: 1 });
      continue;
    }
    const rec = asRecord(item);
    if (!rec) continue;
    const address = str(rec.address) ?? str(rec.addr);
    if (!address) continue;
    out.push({
      address,
      host: str(rec.host),
      weight: num(rec.weight) ?? 1,
    });
  }
  return out;
}

export interface ProtocolInfo {
  type?: string;
  username?: string;
  password?: string;
}

/**
 * 归一化 `forward_addresses_protocol` / `listen_protocol` 的**类型段**。
 *  · 原版：`{ type, username?, password? }`
 *  · W1 隧道接口：`["tcp"]` / `"tcp"`（取首个字符串作为 type）
 */
export function normalizeProtocol(v: unknown): ProtocolInfo {
  if (v === null || v === undefined) return {};
  if (typeof v === "string") return { type: v };
  if (Array.isArray(v)) {
    const t = v.find((x): x is string => typeof x === "string" && x.length > 0);
    return t ? { type: t } : {};
  }
  const rec = asRecord(v);
  if (!rec) return {};
  return { type: str(rec.type), username: str(rec.username), password: str(rec.password) };
}

/** 保留原始 JSON 对象（供 listen_protocol 的 wireguard/vless/mieru/openvpn 分支读字段）。 */
function listenProtocolRecord(v: unknown): JsonRecord {
  return asRecord(v) ?? {};
}

/**
 * 已知的「上游代理」协议：命中的类型会把转发目标当作 proxy connector 走
 * `hop-forwarder-*` 链路（对应原版 `forward_addresses_protocol.type` 分支）。
 * 其余（含 tcp/udp 等传输类型）走标准 L4 `forwarder` 字典。
 */
const PROXY_FORWARD_PROTOCOLS = new Set([
  "socks5",
  "socks5h",
  "socks4",
  "socks4a",
  "socks",
  "ss",
  "ss2",
  "http",
  "http2",
]);

export type ForwarderMode = "plain" | "proxy";

/**
 * 判定转发模式（原版 `!forwarder_addresses_protocol?.type ? dict-forwarder : hop-forwarder`）。
 *
 *  · **对象形态**（原版 / 手工导入）：完全照搬原版 —— `{type}` 非空即视为代理转发。
 *  · **数组 / 字符串形态**（W1 `routes/tunnels.ts` 写入的 `[tunnel_type]`）：该形态语义是
 *    「每个转发地址的传输类型」，**不是**上游代理；仅当其值为已知代理协议时才走代理，
 *    否则按标准 L4 `forwarder` 处理（否则会丢掉 agent 实际路由所需的 forwarder 字典）。
 */
export function resolveForwarderMode(v: unknown): ForwarderMode {
  const rec = asRecord(v);
  if (rec) {
    return str(rec.type) ? "proxy" : "plain";
  }
  const info = normalizeProtocol(v);
  return info.type && PROXY_FORWARD_PROTOCOLS.has(info.type) ? "proxy" : "plain";
}

/* ================================================================== */
/* 工具：IP / addr                                                     */
/* ================================================================== */

/** 复刻原版 `formatIP`：IPv4 原样；`[v6]` 去方括号；其余原样。 */
export function formatIP(ip: string): string {
  if (isIPv4(ip)) return ip;
  if (ip.startsWith("[")) return ip.slice(1, -1);
  return ip;
}

/** 复刻原版 `joinIPAndPort`：IPv6 加方括号。 */
export function joinIPAndPort(ip: string, port: string | number): string {
  const formatted = formatIP(ip);
  if (isIPv6(formatted)) return `[${formatted}]:${port}`;
  return `${formatted}:${port}`;
}

/**
 * 复刻原版 `getConnectIP(connect_ip, ip_type)`：
 * `connect_ip` 可能是逗号分隔多 IP，按 ip_type 取首个匹配项。
 * 找不到返回 `undefined`。
 */
export function getConnectIP(connectIp: string | null | undefined, ipType: IpType): string | undefined {
  const list = String(connectIp ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(formatIP);
  return list.find((ip) => {
    if (ipType === IpType.ipv4) return isIPv4(ip);
    if (ipType === IpType.ipv6) return isIPv6(ip);
    return true; // auto
  });
}

/**
 * 生成 WAIT_LISTEN 监听地址。
 *
 * ⚠️ 原版格式为 `<listen_ip>:WAIT_LISTEN<range>`（**无花括号**）：
 *   `':WAIT_LISTEN20000-30000'`。agent 反汇编中前缀常量恰为 12 字节
 *   `:WAIT_LISTEN`，端口段由 addr 直接透传给 `utils.parsePortRange`。
 * 这与 `crypto/node-config.ts#waitListenPlaceholder`（加了 `{}`）**不一致**；
 * 为保证与原版 agent 字节级兼容，本模块一律输出无花括号形态。
 */
export function waitListenAddr(prefix: string, portRange: string | null | undefined): string {
  return `${prefix}:${WAIT_LISTEN}${portRange ?? ""}`;
}

/* ================================================================== */
/* 工具：uuid v5（relayx dialer metadata.key 用）                      */
/* ================================================================== */

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  return Buffer.from(hex, "hex");
}

function bytesToUuid(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * uuid v5（SHA-1）。
 * 复刻原版 `v5(SITE_URL, v5.URL)` —— 即 `uuidv5(name = siteUrl, namespace = URL)`。
 */
export function uuidv5(name: string, namespace: string = UUID_NAMESPACE_URL): string {
  const ns = uuidToBytes(namespace);
  const hash = createHash("sha1").update(Buffer.concat([ns, Buffer.from(name, "utf8")])).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(b);
}

/* ================================================================== */
/* 隧道筛选 / 限速合并（复刻原版）                                      */
/* ================================================================== */

/**
 * 节点组归属或显式准入与购买无关；历史 UserPlan 存在时暂保留额度限制。
 * 无套餐的新用户可使用自有节点组（后续迁移到 CapabilityPolicy）。
 */
export function filterAvailableTunnels(
  tunnels: AvailableTunnel[],
  inNodeGroupId?: number,
  outNodeGroupId?: number,
): AvailableTunnel[] {
  const available: AvailableTunnel[] = [];
  const userTunnelCount: Record<number, number> = {};

  const filtered = tunnels.filter((tunnel) => {
    if (!hasAuthorizedTopology(tunnel)) return false;
    if (inNodeGroupId && !canUseTunnelGroup(tunnel, inNodeGroupId, "in")) return false;
    if (outNodeGroupId && !canUseTunnelGroup(tunnel, outNodeGroupId, "out")) return false;
    return true;
  });

  for (const tunnel of filtered) {
    const userId = tunnel.user_id;
    const userPlan = tunnel.user?.user_plan;
    const trafficUsed = userPlan?.traffic_used ?? 0;
    const maxTunnels = userPlan?.max_tunnels ?? userPlan?.plan?.max_tunnels ?? null;
    const traffic = userPlan?.traffic ?? userPlan?.plan?.traffic ?? null;
    const used = userTunnelCount[userId] ?? 0;
    if (maxTunnels != null && used >= maxTunnels) continue;
    if (traffic != null && trafficUsed >= traffic) continue;
    userTunnelCount[userId] = used + 1;
    available.push(tunnel);
  }
  return available;
}

/** Missing group/owner data fails closed. Purchases never grant shared group access. */
export function canUseTunnelGroup(tunnel: AvailableTunnel, groupId: number, kind: "in" | "out"): boolean {
  const group = kind === "in" ? tunnel.in_node_group : tunnel.out_node_group;
  if (!group || group.id !== groupId) return false;
  return isNodeGroupGranted(tunnel.user_id, group, kind, tunnel.user?.node_group_grants ?? [], tunnel.workspace_id, tunnel.user?.personal_workspace?.id);
}

/** Reject the whole tunnel when any primary or multi-hop group is not authorized. */
export function hasAuthorizedTopology(tunnel: AvailableTunnel): boolean {
  if (!canUseTunnelGroup(tunnel, tunnel.in_node_group_id, "in")) return false;
  if (tunnel.out_node_group_id && !canUseTunnelGroup(tunnel, tunnel.out_node_group_id, "out")) return false;
  return (tunnel.tunnel_chains ?? []).every((chain) =>
    chain.node_group?.id === chain.node_group_id &&
    chain.node_group.node_type === chain.node_type &&
    isNodeGroupGranted(tunnel.user_id, chain.node_group, chain.node_type, tunnel.user?.node_group_grants ?? [], tunnel.workspace_id, tunnel.user?.personal_workspace?.id)
  );
}

function minLimit(a: number | null | undefined, b: number | null | undefined): number | undefined {
  const av = typeof a === "number" ? a : undefined;
  const bv = typeof b === "number" ? b : undefined;
  if (av !== undefined && bv !== undefined) return Math.min(av, bv);
  return av ?? bv;
}

/**
 * 复刻原版 `computeAllLimits(allTunnels, limitScope)`。
 * `limitScope === "tunnel"` → 每隧道限速器（`climiter-<id>` / `limiter-<id>`）；
 * 否则按用户限速器（`climiter-u<userId>` / `limiter-u<userId>`）。
 */
export function computeAllLimits(
  allTunnels: AvailableTunnel[],
  limitScope?: string,
): Map<number, TunnelLimit> {
  const result = new Map<number, TunnelLimit>();
  for (const t of allTunnels) {
    const plan = t.user?.user_plan?.plan;
    if (limitScope === "tunnel") {
      const ipLimit = minLimit(t.ip_limit, plan?.ip_limit);
      const clientLimit = minLimit(t.client_limit, plan?.client_limit);
      const bandwidthLimit = minLimit(t.bandwidth_limit, plan?.bandwidth_limit);
      result.set(t.id, {
        ip_limit: ipLimit,
        client_limit: clientLimit,
        bandwidth_limit: bandwidthLimit,
        climiter_name: ipLimit ? `climiter-${t.id}` : undefined,
        limiter_name: bandwidthLimit ? `limiter-${t.id}` : undefined,
      });
      continue;
    }
    const ipLimit = plan?.ip_limit ?? undefined;
    const clientLimit = plan?.client_limit ?? undefined;
    const bandwidthLimit = plan?.bandwidth_limit ?? undefined;
    result.set(t.id, {
      ip_limit: ipLimit,
      client_limit: clientLimit,
      bandwidth_limit: bandwidthLimit,
      climiter_name: ipLimit ? `climiter-u${t.user_id}` : undefined,
      limiter_name: bandwidthLimit ? `limiter-u${t.user_id}` : undefined,
    });
  }
  return result;
}

/* ================================================================== */
/* 工具：读 Redis / 系统配置                                           */
/* ================================================================== */

/** 出口端口缓存（`tunnel:out_listen`）。Redis 不可用时返回空表（退化为无出口链路）。 */
export async function loadOutListens(): Promise<OutListens> {
  try {
    return (await redis.hgetall(OUT_LISTEN_KEY)) as OutListens;
  } catch {
    return {};
  }
}

function getOutListenFromCache(outListens: OutListens, nodeId: number, type: string): string | null {
  const v = outListens[`${nodeId}:${type}`];
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.length > 0 ? s : null;
}

/** 观测周期：系统配置 `OBSERVER_PERIOD`（如 `"5"`）→ `"5s"`。 */
export async function loadObserverPeriod(override?: string): Promise<string> {
  const raw = (override ?? (await systemConfig.getConfig("OBSERVER_PERIOD"))) ?? DEFAULT_OBSERVER_PERIOD;
  const trimmed = String(raw).trim();
  if (trimmed === "") return DEFAULT_OBSERVER_PERIOD;
  return trimmed.endsWith("s") ? trimmed : `${trimmed}s`;
}

/* ================================================================== */
/* 复刻：链路（tunnel_chains → hops）                                  */
/* ================================================================== */

interface Hop {
  name: string;
  selector?: { strategy: LoadBalanceType };
  nodes: unknown[];
}

/**
 * 复刻原版 `getTunnelChainsFromTunnel`：把 `tunnel.tunnel_chains` 展开为
 * `{ in_hops, out_hops }`，每个 hop 的节点用 `tunnel:out_listen` 缓存拼 addr。
 */
export function getTunnelChainsFromTunnel(
  tunnel: AvailableTunnel,
  outListens: OutListens,
): { in_hops: Hop[]; out_hops: Hop[] } {
  const inHops: Hop[] = [];
  const outHops: Hop[] = [];
  const ipType = tunnel.ip_type;
  for (const chain of tunnel.tunnel_chains ?? []) {
    const nodes = (chain.node_group?.nodes ?? [])
      .map((node) => {
        const port = getOutListenFromCache(outListens, node.id, TunnelType.tcp);
        if (!port) return null;
        const connectIp = getConnectIP(node.connect_ip, ipType);
        if (!connectIp) return null;
        return {
          name: node.node_id,
          addr: joinIPAndPort(connectIp, port),
          connector: { type: "relay", metadata: { nodelay: true } },
          dialer: { type: "tcp" },
          metadata: { weight: node.weight.toString(), backup: node.backup },
        };
      })
      .filter((n) => n !== null);

    const hop: Hop = {
      name: `hop-${chain.id}`,
      selector: { strategy: chain.node_group.load_balance_type },
      nodes: sortByWeightDesc(nodes),
    };
    if (chain.node_type === NodeType.in) inHops.push(hop);
    else outHops.push(hop);
  }
  return { in_hops: inHops, out_hops: outHops };
}

/** 复刻原版 `lodash.orderBy(nodes, "metadata.weight", "desc")`（weight 为字符串数字）。 */
function sortByWeightDesc<T>(nodes: T[]): T[] {
  return [...nodes].sort((a, b) => {
    const aw = Number((a as { metadata?: { weight?: string } })?.metadata?.weight ?? 0);
    const bw = Number((b as { metadata?: { weight?: string } })?.metadata?.weight ?? 0);
    return bw - aw;
  });
}

/* ================================================================== */
/* 复刻：入口（in）节点配置                                            */
/* ================================================================== */

export interface InConfigInput {
  inNodeGroupId: number;
  portRange: string | null;
  allowListenProtocol: boolean;
  allTunnels: AvailableTunnel[];
  outListens: OutListens;
  tunnelLimits: Map<number, TunnelLimit>;
  siteUrl: string;
  observerPeriod: string;
  /** 入口组 bypass 配置（原版二次查库；此处按需透传，缺省则跳过 bypass 段）。 */
  bypass?: { type: string; list: string[]; admission: boolean };
}

/**
 * 复刻原版 `getInNodeConfig`。
 * `observers` 恒非空（见文件头 ②）。
 */
export function buildInNodeConfig(input: InConfigInput): NodeConfig {
  const { inNodeGroupId, portRange, allowListenProtocol, allTunnels, outListens, tunnelLimits } = input;
  const observerPeriod = input.observerPeriod;

  const services: ServiceConfig[] = [];
  const chains: { name: string; hops: Hop[] }[] = [];
  const climiters = new Map<string, { name: string; limits: string[] }>();
  const limiters = new Map<string, { name: string; limits: string[] }>();
  const admissions: { name: string; whitelist: boolean; matchers: string[] }[] = [];

  const bypassList = input.bypass?.list ?? [];
  const bypassName = `bypass-${inNodeGroupId}`;
  const hasBypass = bypassList.length > 0;
  const isAdmissionEnabled = input.bypass?.admission ?? false;

  const filtered = allTunnels.filter((t) => t.in_node_group_id === inNodeGroupId);
  const tunnels = filterAvailableTunnels(filtered, inNodeGroupId);
  const portForwardTunnels = tunnels.filter((t) => t.category === TunnelCategory.port_forward);

  for (const tunnel of portForwardTunnels) {
    const listenIp = tunnel.listen_ip || "";
    const listenAddress = tunnel.listen_port
      ? `${listenIp}:${tunnel.listen_port}`
      : waitListenAddr(listenIp, portRange);

    const ipType = tunnel.ip_type;
    const name = `${tunnel.id}`;
    const outChainNodes: unknown[] = [];
    const fwdProtocol = normalizeProtocol(tunnel.forward_addresses_protocol);
    const fwdMode = resolveForwarderMode(tunnel.forward_addresses_protocol);

    let forwarder: { nodes: unknown[]; selector: { strategy: LoadBalanceType } } | undefined;
    if (fwdMode === "plain") {
      forwarder = {
        nodes: normalizeForwardAddresses(tunnel.forward_addresses)
          .slice()
          .sort((a, b) => b.weight - a.weight)
          .map((fa) => ({
            name: fa.address,
            addr: fa.address,
            filter: fa.host ? { host: fa.host } : undefined,
            metadata: { weight: fa.weight.toString() },
          })),
        selector: { strategy: tunnel.load_balance_type },
      };
    }

    if (tunnel.out_node_group_id) {
      for (const node of tunnel.out_node_group?.nodes ?? []) {
        const port = getOutListenFromCache(outListens, node.id, tunnel.tunnel_type);
        if (!port) continue;
        const connectIp = getConnectIP(node.connect_ip, ipType);
        if (!connectIp) continue;
        outChainNodes.push({
          name: node.node_id,
          addr: joinIPAndPort(connectIp, port),
          connector: {
            type: tunnel.tunnel_type === TunnelType.udp ? "ssu" : "relay",
            metadata: { nodelay: true },
          },
          dialer: {
            type: tunnel.tunnel_type,
            ...(tunnel.tunnel_type === TunnelType.relayx
              ? { metadata: { key: uuidv5(input.siteUrl), host: safeHost(input.siteUrl) } }
              : undefined),
          },
          metadata: { weight: node.weight.toString(), backup: node.backup },
        });
      }
    }

    const limits = tunnelLimits.get(tunnel.id);
    const ipLimit = limits?.ip_limit;
    const bandwidthLimit = limits?.bandwidth_limit;
    const clientLimit = limits?.client_limit;
    const climiter = limits?.climiter_name;
    if (climiter && ipLimit && !climiters.has(climiter)) {
      climiters.set(climiter, { name: climiter, limits: [`$ ${ipLimit}`] });
    }
    const limiter = limits?.limiter_name;
    if (limiter && bandwidthLimit && !limiters.has(limiter)) {
      limiters.set(limiter, {
        name: limiter,
        limits: [`$ ${bandwidthLimit / 8}MB ${bandwidthLimit / 8}MB`],
      });
    }

    const baseService = {
      addr: listenAddress,
      climiter,
      limiter,
      observer: DEFAULT_OBSERVER_NAME,
      forwarder,
      metadata: {
        enableStats: true,
        "observer.resetTraffic": true,
        "observer.period": observerPeriod,
        maxClients: clientLimit != null ? clientLimit.toString() : undefined,
      },
    } as const;

    let handlerType: string | undefined;
    let username: string | undefined;
    let password: string | undefined;
    if (tunnel.listen_protocol !== null && tunnel.listen_protocol !== undefined && allowListenProtocol) {
      const lp = normalizeProtocol(tunnel.listen_protocol);
      if (lp.type) {
        handlerType = lp.type;
        username = lp.username;
        password = lp.password;
      }
    }

    const { in_hops, out_hops } = getTunnelChainsFromTunnel(tunnel, outListens);
    const hops: Hop[] = in_hops;
    if (outChainNodes.length > 0) {
      hops.push({
        name: `hop-out-${name}`,
        selector: {
          strategy: tunnel.out_node_group?.load_balance_type
            ? tunnel.out_node_group.load_balance_type
            : tunnel.load_balance_type,
        },
        nodes: sortByWeightDesc(outChainNodes),
      });
    }
    if (out_hops.length > 0) hops.push(...out_hops);
    if (fwdMode === "proxy") {
      hops.push({
        name: `hop-forwarder-${name}`,
        selector: { strategy: tunnel.load_balance_type },
        nodes: normalizeForwardAddresses(tunnel.forward_addresses).map((fa) => ({
          name: fa.address,
          addr: fa.address,
          filter: fa.host ? { host: fa.host } : undefined,
          connector: {
            type: fwdProtocol.type,
            auth: { username: fwdProtocol.username, password: fwdProtocol.password },
            metadata:
              fwdProtocol.type === "socks5" ? { notls: true, relay: "udp" } : undefined,
          },
          dialer: { type: "tcp" },
          metadata: { weight: fa.weight.toString(), backup: false },
        })),
      });
    }

    chains.push({ name, hops });

    const blockProtocols = tunnel.in_node_group_block_protocols;
    const sniffing = blockProtocols ? true : undefined;
    const whitelistIps = tunnel.user?.user_plan?.whitelist_ips;
    const hasAdmission = isAdmissionEnabled && !!whitelistIps && whitelistIps.length > 0;
    const admissionName = hasAdmission ? `admission-${name}` : undefined;
    if (hasAdmission) {
      admissions.push({ name: `admission-${name}`, whitelist: true, matchers: whitelistIps! });
    }

    const bypass = hasBypass ? bypassName : undefined;

    if (handlerType === "wireguard") {
      const lp = listenProtocolRecord(tunnel.listen_protocol);
      services.push({
        name: `wg-${name}`,
        bypass,
        admission: admissionName,
        handler: {
          type: "tungo",
          chain: hops.length > 0 ? name : undefined,
          metadata: {
            sniffing,
            "sniffing.fallback": sniffing ? true : undefined,
            "block.protocol": blockProtocols ?? undefined,
          },
        },
        listener: {
          type: "wireguard",
          metadata: {
            privateKey: str(lp.privateKey),
            mtu: String(num(lp.mtu) ?? 1420),
            logLevel: "verbose",
            peers: (Array.isArray(lp.peers) ? lp.peers : []).map((peer, index) => {
              const p = asRecord(peer) ?? {};
              return {
                publicKey: str(p.publicKey),
                allowedIPs: normalizeWireGuardPeerAllowedIPs(p.allowedIPs, index),
                presharedKey: str(p.presharedKey),
                persistentKeepalive:
                  num(p.persistentKeepalive) != null ? String(p.persistentKeepalive) : undefined,
              };
            }),
          },
        },
        ...baseService,
      } as ServiceConfig);
    } else if (handlerType === "vless") {
      const lp = listenProtocolRecord(tunnel.listen_protocol);
      services.push({
        name: `tcp-${name}`,
        bypass,
        admission: admissionName,
        handler: {
          type: "vless",
          chain: hops.length > 0 ? name : undefined,
          metadata: {
            users: { [username || DEFAULT_VLESS_USER]: lp.uuid ?? undefined },
            sniffing,
          },
        },
        listener: {
          type: "reality",
          metadata: {
            privateKey: str(lp.privateKey),
            dest: normalizeRealityDest(lp.dest),
            shortId: str(lp.shortId),
          },
        },
        ...baseService,
      } as ServiceConfig);
    } else if (handlerType === "mieru") {
      const lp = listenProtocolRecord(tunnel.listen_protocol);
      if (!lp.username || !lp.password) continue;
      services.push({
        name: `mieru-${name}`,
        bypass,
        admission: admissionName,
        handler: {
          type: "mieru",
          chain: hops.length > 0 ? name : undefined,
          metadata: {
            sniffing,
            "sniffing.fallback": sniffing ? true : undefined,
            "block.protocol": blockProtocols ?? undefined,
          },
        },
        listener: {
          type: "mieru",
          metadata: {
            users: { [String(lp.username)]: lp.password },
            mtu: num(lp.mtu) ?? DEFAULT_MIERU_MTU,
            protocol: str(lp.transportProtocol) ?? DEFAULT_MIERU_TRANSPORT_PROTOCOL,
          },
        },
        ...baseService,
      } as ServiceConfig);
    } else if (handlerType === "openvpn") {
      const lp = listenProtocolRecord(tunnel.listen_protocol);
      services.push({
        name: `ovpn-${name}`,
        bypass,
        admission: admissionName,
        handler: {
          type: "tungo",
          chain: hops.length > 0 ? name : undefined,
          metadata: {
            sniffing,
            "sniffing.fallback": sniffing ? true : undefined,
            "block.protocol": blockProtocols ?? undefined,
          },
        },
        listener: {
          type: "openvpn",
          metadata: {
            udp: typeof lp.udp === "boolean" ? lp.udp : false,
            ca: str(lp.ca),
            cert: str(lp.cert),
            key: str(lp.key),
            tlsCrypt: str(lp.tlsCrypt),
            server: str(lp.server) ?? DEFAULT_OPENVPN_SERVER,
            cipher: str(lp.cipher) ?? DEFAULT_OPENVPN_CIPHER,
            auth: str(lp.auth) ?? DEFAULT_OPENVPN_AUTH,
            mtu: String(num(lp.mtu) ?? DEFAULT_OPENVPN_MTU),
          },
        },
        ...baseService,
      } as ServiceConfig);
    } else {
      if (tunnel.tunnel_type !== TunnelType.udp) {
        services.push({
          name: `tcp-${name}`,
          bypass,
          admission: admissionName,
          handler: {
            type: handlerType ? handlerType : "tcp",
            chain: hops.length > 0 ? name : undefined,
            metadata: {
              sniffing,
              "block.protocol": blockProtocols ?? undefined,
              proxyProtocol: tunnel.proxy_protocol ? "1" : undefined,
              udp: handlerType === "socks5" ? true : undefined,
            },
            auth: username && password ? { username, password } : undefined,
          },
          listener: { type: "tcp" },
          ...baseService,
        } as ServiceConfig);
      }
      services.push({
        name: `udp-${name}`,
        bypass,
        admission: admissionName,
        handler: {
          type: handlerType ? (handlerType === "ss" ? "ssu" : handlerType) : "udp",
          chain: hops.length > 0 ? name : undefined,
          auth: username && password ? { username, password } : undefined,
        },
        listener: { type: "udp", metadata: { keepalive: true } },
        ...baseService,
      } as ServiceConfig);
    }
  }

  if (tunnels.some((t) => t.category === TunnelCategory.remote_port_forward)) {
    const tunnelTypes = new Set(tunnels.map((t) => t.tunnel_type));
    for (const tunnelType of tunnelTypes) {
      services.push({
        name: tunnelType,
        bypass: hasBypass ? bypassName : undefined,
        addr: waitListenAddr("", portRange),
        handler: {
          type: tunnelType === TunnelType.udp ? "ssu" : "relay",
          metadata: { bind: true, nodelay: true },
        },
        listener: {
          type: tunnelType,
          metadata: { keepalive: tunnelType === TunnelType.udp ? true : undefined },
        },
      } as ServiceConfig);
    }
  }

  const existsInChains = filterAvailableTunnels(allTunnels).some((t) =>
    (t.tunnel_chains ?? []).some(
      (c) => c.node_group_id === inNodeGroupId && c.node_group?.node_type === NodeType.in,
    ),
  );
  if (existsInChains) {
    services.push({
      name: "chain",
      bypass: hasBypass ? bypassName : undefined,
      addr: waitListenAddr("", portRange),
      listener: { type: "tcp" },
      handler: { type: "relay", metadata: { nodelay: true } },
      metadata: {
        enableStats: true,
        "observer.resetTraffic": true,
        "observer.period": observerPeriod,
      },
    } as ServiceConfig);
  }

  const bypasses = hasBypass
    ? [
        {
          name: bypassName,
          whitelist: input.bypass?.type === "whitelist",
          matchers: bypassList,
        },
      ]
    : [];

  const config: NodeConfig = {
    log: { level: DEFAULT_LOG_LEVEL },
    tls: {
      validity: DEFAULT_TLS_VALIDITY,
      commonName: safeHost(input.siteUrl),
      organization: safeHost(input.siteUrl),
    },
    services,
    chains,
    climiters: Array.from(climiters.values()),
    limiters: Array.from(limiters.values()),
    bypasses,
    admissions,
    // ② observers 必须非空
    observers: [
      {
        name: DEFAULT_OBSERVER_NAME,
        plugin: { type: "http", addr: observerEndpoint(input.siteUrl) },
      },
    ],
  };
  return config;
}

/* ================================================================== */
/* 复刻：出口（out）节点配置                                           */
/* ================================================================== */

export interface OutConfigInput {
  outNodeGroupId: number;
  portRange: string | null;
  allTunnels: AvailableTunnel[];
  outListens: OutListens;
  tunnelLimits: Map<number, TunnelLimit>;
  siteUrl: string;
  /** 出口组「协议封堵」列表（原版二次查库）。 */
  blockProtocols?: unknown;
}

/**
 * 复刻原版 `getOutNodeConfig`。
 * ⚠️ 原版出口配置**不含 `observers` / `bypasses` / `admissions` 字段**（见文件头）。
 */
export function buildOutNodeConfig(input: OutConfigInput): NodeConfig {
  const { outNodeGroupId, portRange, allTunnels, outListens, tunnelLimits } = input;
  const services: ServiceConfig[] = [];
  const chains: { name: string; hops: Hop[] }[] = [];
  const climiters = new Map<string, { name: string; limits: string[] }>();
  const limiters = new Map<string, { name: string; limits: string[] }>();

  const blockProtocols = input.blockProtocols;
  const filtered = allTunnels.filter((t) => t.out_node_group_id === outNodeGroupId);
  const tunnels = filterAvailableTunnels(filtered, undefined, outNodeGroupId);
  const portForwardTunnels = tunnels.filter((t) => t.category === TunnelCategory.port_forward);
  const tunnelTypes = new Set<TunnelType>(portForwardTunnels.map((t) => t.tunnel_type));

  const existsInChains = filterAvailableTunnels(allTunnels).some((t) =>
    (t.tunnel_chains ?? []).some(
      (c) => c.node_group_id === outNodeGroupId && c.node_group?.node_type === NodeType.out,
    ),
  );
  if (existsInChains) tunnelTypes.add(TunnelType.tcp);

  const sniffing = blockProtocols ? true : undefined;
  for (const tunnelType of tunnelTypes) {
    services.push({
      name: tunnelType,
      addr: waitListenAddr("", portRange),
      handler: {
        type: tunnelType === TunnelType.udp ? "ssu" : "relay",
        metadata: {
          sniffing,
          "block.protocol": blockProtocols ?? undefined,
          nodelay: true,
        },
      },
      listener: {
        type: tunnelType,
        metadata: {
          ...(tunnelType === TunnelType.udp ? { keepalive: true } : undefined),
          ...(tunnelType === TunnelType.relayx ? { key: uuidv5(input.siteUrl) } : undefined),
        },
      },
    } as ServiceConfig);
  }

  const remoteTunnels = tunnels.filter((t) => t.category === TunnelCategory.remote_port_forward);
  for (const tunnel of remoteTunnels) {
    const listenIp = tunnel.listen_ip || "";
    const listenAddress = tunnel.listen_port
      ? `${listenIp}:${tunnel.listen_port}`
      : waitListenAddr(listenIp, portRange);
    const ipType = tunnel.ip_type;
    const name = `${tunnel.id}`;
    const chainNodes: unknown[] = [];
    for (const node of tunnel.in_node_group?.nodes ?? []) {
      const port = getOutListenFromCache(outListens, node.id, tunnel.tunnel_type);
      if (!port) continue;
      const connectIp = getConnectIP(node.connect_ip, ipType);
      if (!connectIp) continue;
      chainNodes.push({
        name: node.node_id,
        addr: joinIPAndPort(connectIp, port),
        connector: { type: "relay", metadata: { nodelay: true } },
        dialer: {
          type: tunnel.tunnel_type,
          ...(tunnel.tunnel_type === TunnelType.relayx
            ? { metadata: { key: uuidv5(input.siteUrl), host: safeHost(input.siteUrl) } }
            : undefined),
        },
        metadata: { weight: node.weight.toString(), backup: node.backup },
      });
    }
    chains.push({
      name,
      hops: [
        {
          name,
          selector: { strategy: tunnel.load_balance_type },
          nodes: sortByWeightDesc(chainNodes),
        },
      ],
    });

    const limits = tunnelLimits.get(tunnel.id);
    const ipLimit = limits?.ip_limit;
    const bandwidthLimit = limits?.bandwidth_limit;
    const clientLimit = limits?.client_limit;
    const climiter = limits?.climiter_name;
    if (climiter && ipLimit && !climiters.has(climiter)) {
      climiters.set(climiter, { name: climiter, limits: [`$ ${ipLimit}`] });
    }
    const limiter = limits?.limiter_name;
    if (limiter && bandwidthLimit && !limiters.has(limiter)) {
      limiters.set(limiter, {
        name: limiter,
        limits: [`$ ${bandwidthLimit / 8}MB ${bandwidthLimit / 8}MB`],
      });
    }

    const forwarder = {
      nodes: normalizeForwardAddresses(tunnel.forward_addresses)
        .slice()
        .sort((a, b) => b.weight - a.weight)
        .map((fa) => ({
          name: `${name}-${fa.address}`,
          addr: fa.address,
          filter: fa.host ? { host: fa.host } : undefined,
          metadata: { weight: fa.weight.toString() },
        })),
      selector: { strategy: tunnel.load_balance_type },
    };
    const baseService = {
      addr: listenAddress,
      climiter,
      limiter,
      forwarder,
      metadata: {
        maxClients: clientLimit != null ? clientLimit.toString() : undefined,
      },
    } as const;

    if (tunnel.tunnel_type !== TunnelType.udp) {
      services.push({
        name: `rtcp-${name}`,
        handler: { type: "rtcp" },
        listener: { type: "rtcp", chain: name },
        ...baseService,
      } as ServiceConfig);
    }
    services.push({
      name: `rudp-${name}`,
      handler: { type: "rudp" },
      listener: { type: "rudp", chain: name },
      ...baseService,
    } as ServiceConfig);
  }

  const config: NodeConfig = {
    log: { level: DEFAULT_LOG_LEVEL },
    tls: {
      validity: DEFAULT_TLS_VALIDITY,
      commonName: safeHost(input.siteUrl),
      organization: safeHost(input.siteUrl),
    },
    chains,
    climiters: Array.from(climiters.values()),
    limiters: Array.from(limiters.values()),
    services,
  };
  return config;
}

/* ================================================================== */
/* 复刻：getNodeConfig 分派 + 数据拉取                                 */
/* ================================================================== */

/** 复刻原版 `getNodeConfig(node_group_id, node_type, ...)` 的二分派。 */
export function buildNodeConfigByType(
  nodeType: NodeType,
  inInput: InConfigInput,
  outInput: OutConfigInput,
): NodeConfig {
  switch (nodeType) {
    case NodeType.in:
      return buildInNodeConfig(inInput);
    case NodeType.out:
      return buildOutNodeConfig(outInput);
    default:
      throw new TypeError(`config-generator: unsupported node_type ${String(nodeType)}`);
  }
}

/** 拉取单节点组的内联 bypass 配置。 */
async function loadGroupBypass(groupId: number): Promise<InConfigInput["bypass"]> {
  const g = await db.nodeGroup.findUnique({
    where: { id: groupId },
    select: { bypass_type: true, bypass_list: true, admission: true },
  });
  if (!g) return undefined;
  const list = Array.isArray(g.bypass_list) ? (g.bypass_list as unknown[]).map(String) : [];
  return { type: String(g.bypass_type), list, admission: Boolean(g.admission) };
}

/** 拉取出口组的「协议封堵」列表。 */
async function loadGroupBlockProtocols(groupId: number): Promise<unknown> {
  const g = await db.nodeGroup.findUnique({
    where: { id: groupId },
    select: { block_protocols: true },
  });
  return g?.block_protocols ?? undefined;
}

/**
 * 复刻原版 `getAllAvailableTunnels`：拉取「有效」隧道（active 状态 + 用户 active +
 * 套餐未过期）并展开生成配置所需的关系。
 *
 * 不依赖 License 或购买；按节点组所有权/显式准入过滤。
 */
export async function loadAvailableTunnels(): Promise<AvailableTunnel[]> {
  const rows = await db.tunnel.findMany({
    include: {
      user: {
        include: {
          node_group_grants: { where: { active: true } },
          personal_workspace: { select: { id: true } },
          user_plan: {
            include: {
              plan: { include: { node_groups: true } },
            },
          },
        },
      },
      out_node_group: {
        include: { nodes: { where: { status: "active" }, orderBy: { id: "asc" } } },
      },
      in_node_group: {
        include: { nodes: { where: { status: "active" }, orderBy: { id: "asc" } } },
      },
      tunnel_chains: {
        orderBy: { id: "asc" },
        include: {
          node_group: {
            include: { nodes: { where: { status: "active" }, orderBy: { id: "asc" } } },
          },
        },
      },
    },
    orderBy: { id: "asc" },
    where: {
      status: "active",
      user: { status: "active" },
    },
  });

  // in 节点组「协议封堵」列表需要按组补齐（原版在 getInNodeConfig 内二次查库）。
  const blockProtocolsByGroup = new Map<number, unknown>();
  const blockProtocols = await db.nodeGroup.findMany({
    select: { id: true, block_protocols: true },
  });
  for (const g of blockProtocols) blockProtocolsByGroup.set(g.id, g.block_protocols ?? undefined);

  return (rows as unknown as AvailableTunnel[]).filter(hasAuthorizedTopology).map((t) => ({
    ...t,
    in_node_group_block_protocols: blockProtocolsByGroup.get(t.in_node_group_id),
  }));
}

/* ================================================================== */
/* 公共入口                                                           */
/* ================================================================== */

/**
 * 生成指定节点组的**明文**配置（含线上 JSON 与指纹）。
 *
 * 这是 socket 层 / config-pusher 调用的入口：拿到 {@link GeneratedNodeConfig} 后，
 *   · `encryptNodeConfig(result.config)`（或 `buildConfigFrame`）→ 加密下发；
 *   · `result.fingerprint` 与 Redis 里 `node_group:config_hash` 比对 → 增量去重；
 *   · `result.json` 可直接入库 / 打日志。
 *
 * 加密与 Socket.IO 帧封装**不**在本函数内做（见文件头 ①）。
 *
 * @example
 *   const { config, json, fingerprint } = await generateNodeConfig(groupId);
 */
export async function generateNodeConfig(
  nodeGroupId: number,
  options: GenerateNodeConfigOptions = {},
): Promise<GeneratedNodeConfig> {
  const siteUrl = options.siteUrl ?? env.siteUrl;

  const group = await db.nodeGroup.findUnique({
    where: { id: nodeGroupId },
    select: { id: true, node_type: true, port_range: true, allow_listen_protocol: true },
  });
  if (!group) {
    throw new Error(`config-generator: node group ${nodeGroupId} not found`);
  }

  const [observerPeriod, limitScope, allTunnels, outListens] = await Promise.all([
    loadObserverPeriod(options.observerPeriod),
    options.limitScope ?? systemConfig.getConfig("LIMIT_SCOPE"),
    options.allTunnels ?? loadAvailableTunnels(),
    options.outListens ?? loadOutListens(),
  ]);

  const tunnelLimits = options.tunnelLimits ?? computeAllLimits(allTunnels, limitScope ?? undefined);

  let config: NodeConfig;
  if (group.node_type === NodeType.in) {
    config = buildInNodeConfig({
      inNodeGroupId: group.id,
      portRange: group.port_range ?? null,
      allowListenProtocol: Boolean(group.allow_listen_protocol),
      allTunnels,
      outListens,
      tunnelLimits,
      siteUrl,
      observerPeriod,
      bypass: await loadGroupBypass(group.id),
    });
  } else {
    config = buildOutNodeConfig({
      outNodeGroupId: group.id,
      portRange: group.port_range ?? null,
      allTunnels,
      outListens,
      tunnelLimits,
      siteUrl,
      blockProtocols: await loadGroupBlockProtocols(group.id),
    });
  }

  const json = serializeNodeConfig(config);
  const fingerprint = sha256Hex(json);

  return { nodeGroupId: group.id, nodeType: group.node_type, config, json, fingerprint };
}

/**
 * 一次性生成「所有存活节点组」的配置（复刻 `pushNodeConfig` 的调度语义）。
 * 存活判定：非 `backup` 且近期有心跳（这里按「组内存在 active 节点」近似）。
 */
export async function generateAllNodeConfigs(): Promise<GeneratedNodeConfig[]> {
  const groups = await db.nodeGroup.findMany({
    select: { id: true },
    where: { nodes: { some: { status: "active" } } },
  });
  const shared = await loadAvailableTunnels().catch(() => [] as AvailableTunnel[]);
  const outListens = await loadOutListens();
  const limitScope = (await systemConfig.getConfig("LIMIT_SCOPE")) ?? undefined;
  const tunnelLimits = computeAllLimits(shared, limitScope);
  const observerPeriod = await loadObserverPeriod();

  const results: GeneratedNodeConfig[] = [];
  for (const g of groups) {
    try {
      results.push(
        await generateNodeConfig(g.id, {
          allTunnels: shared,
          outListens,
          limitScope,
          tunnelLimits,
          observerPeriod,
        }),
      );
    } catch {
      /* 单组失败不影响其余 */
    }
  }
  return results;
}

/* ================================================================== */
/* 常量 / 依赖注入小工具                                               */
/* ================================================================== */

/** WireGuard 默认客户端 allowedIPs（原版常量）。 */
export const DEFAULT_WIREGUARD_CLIENT_ALLOWED_IPS = ["0.0.0.0/0"] as const;
/** openvpn 默认参数（原版常量）。 */
export const DEFAULT_OPENVPN_CIPHER = "AES-256-GCM";
export const DEFAULT_OPENVPN_AUTH = "SHA256";
export const DEFAULT_OPENVPN_MTU = 1500;
export const DEFAULT_OPENVPN_SERVER = "10.8.0.0/24";
/** vless 默认用户名 / mieru 默认参数（原版常量）。 */
export const DEFAULT_VLESS_USER = "user";
export const DEFAULT_MIERU_MTU = 1400;
export const DEFAULT_MIERU_TRANSPORT_PROTOCOL = "tcp";

/** 复刻原版 `normalizeWireGuardPeerAllowedIPs`。 */
export function normalizeWireGuardPeerAllowedIPs(allowedIPs: unknown, peerIndex: number): string[] {
  const values = (Array.isArray(allowedIPs) ? allowedIPs : [])
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean)
    .filter((v) => v !== "0.0.0.0/0" && v !== "::/0");
  return values.length > 0 ? values : [`10.66.0.${peerIndex + 2}/32`];
}

/** 复刻原版 `normalizeRealityDest`（缺省缺省 dest 时给出合法回退）。 */
export function normalizeRealityDest(dest: unknown): string {
  const s = str(dest);
  return s ?? "www.microsoft.com:443";
}

/** `new URL(siteUrl).hostname`，非法 URL 时回退 `127.0.0.1`。 */
export function safeHost(siteUrl: string): string {
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return "127.0.0.1";
  }
}

/** 明文 JSON 的 sha256 hex（供增量去重）。 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
