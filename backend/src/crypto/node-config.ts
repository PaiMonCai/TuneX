/**
 * TuneX — 节点配置生成（gost config JSON）+ Fernet 加密下发
 *
 * 复刻的是原版 `getNodeConfig(nodeGroup)` 的输出形状与**线上字节**。
 * 生成的 JSON 用 **config 密钥**（`TUNEX_CONFIG_KEY`）加密后，通过
 * `42["config","<密文>"]` 下发（载荷是**裸字符串**，不是数组 —— 见下）。
 *
 * ── 三条实测踩坑（每条都让原版 agent 崩过）──
 *
 * ① 载荷是**裸字符串**：`42["config","<密文>"]`。
 *    发成 `42["config",["<密文>"]]` → agent panic：
 *      `interface {} is []interface {}, not string`（config.go:26）
 *
 * ② `observers` **必须非空**。空数组时 agent 在 config.go:41 空指针崩溃
 *    （它假定至少有一个 observer）。本模块的 buildNodeConfig 会强制注入一个
 *    default observer，即使调用方传空也不允许生成非法配置。
 *
 * ③ 想触发 `listen` 事件（agent 动态选端口后回传实际端口）必须用
 *    `WAIT_LISTEN{port_range}` 占位符；固定端口不触发。见 {@link waitListenPlaceholder}。
 *
 * ── ASCII 安全序列化 ──
 * 本模块的 `stableStringify` 不转义非 ASCII：与 Go `encoding/json`（输出裸 UTF-8）
 * 和 Python `json.dumps(..., ensure_ascii=False)` 逐字节一致。`JSON.stringify` 会
 * 输出 `\uXXXX`，导致密文不同（解密后语义相同，但字节不一致，测试向量会对不上）。
 */

import { Fernet } from './fernet.ts';
import { configKey } from './keys.ts';

/** gost 配置根对象（只列出本项目用到的字段；其余字段可自由透传）。 */
export interface NodeConfig {
  log?: { level?: string; format?: string; output?: string } & Record<string, unknown>;
  tls?: { validity?: string; commonName?: string; organization?: string } & Record<string, unknown>;
  services?: ServiceConfig[];
  chains?: unknown[];
  climiters?: unknown[];
  limiters?: unknown[];
  bypasses?: unknown[];
  admissions?: unknown[];
  /** ⚠️ 必须非空（见文件头 ②）。 */
  observers?: ObserverConfig[];
  [key: string]: unknown;
}

export interface ServiceConfig {
  name: string;
  addr: string;
  handler?: { type?: string; metadata?: Record<string, unknown> } & Record<string, unknown>;
  listener?: { type?: string; metadata?: Record<string, unknown> } & Record<string, unknown>;
  observer?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ObserverConfig {
  name: string;
  plugin?: { type?: string; addr?: string } & Record<string, unknown>;
  [key: string]: unknown;
}

/** 观测插件默认 `observer.period`。实测原版用 5s。 */
export const DEFAULT_OBSERVER_PERIOD = '5s';
/** 观测插件默认名称。 */
export const DEFAULT_OBSERVER_NAME = 'observer';
/** WAIT_LISTEN 占位符前缀（agent 看到它才动态选端口并回发 listen 事件）。 */
export const WAIT_LISTEN_PREFIX = 'WAIT_LISTEN';

export interface BuildConfigOptions {
  /** SITE_URL。observer 插件地址 = `${siteUrl}/api/tunnel/observer`。 */
  siteUrl: string;
  /** 服务列表（隧道映射）。 */
  services?: ServiceConfig[];
  /** 观测周期（默认 `5s`）。 */
  observerPeriod?: string;
  /** 是否给每个 service 加 `enableStats` + `observer.resetTraffic`（默认 true）。 */
  enableStats?: boolean;
  /** log.level（默认 `fatal`，与实测一致 —— 减少 agent 噪声日志）。 */
  logLevel?: string;
  /** tls 段（默认 `{validity:'8760h', commonName:'127.0.0.1', organization:'127.0.0.1'}`）。 */
  tls?: NodeConfig['tls'];
  /** 额外字段透传覆盖（chain/climiter/limiter...）。 */
  extra?: Partial<NodeConfig>;
}

/** 观测插件的 HTTP 端点（agent POST 观测数据的地址）。 */
export function observerEndpoint(siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, '');
  return `${base}/api/tunnel/observer`;
}

/**
 * 生成 `WAIT_LISTEN{port_range}` 占位地址。
 *
 * agent 见到含该占位符的 addr 会：在 `port_range` 内动态选一个空闲端口监听，
 * 然后通过 `listen` 事件把**实际端口**回传给服务端 → 服务端回写 `tunnel.listen_port`。
 *
 * @example
 *   waitListenPlaceholder('20000-30000')  // ':WAIT_LISTEN{20000-30000}' 之类的形态由调用方拼
 */
export function waitListenPlaceholder(portRange: string): string {
  return `${WAIT_LISTEN_PREFIX}{${portRange}}`;
}

/**
 * 构建节点配置对象。
 *
 * `observers` 永远非空：若调用方未提供，自动注入指向 `siteUrl` 的 default observer；
 * 若调用方显式传了 `observers: []`，会抛错而不是生成会让 agent 崩溃的配置。
 */
export function buildNodeConfig(opts: BuildConfigOptions): NodeConfig {
  if (!opts.siteUrl) throw new TypeError('buildNodeConfig: siteUrl is required');
  const observers = opts.extra?.observers;
  if (Array.isArray(observers) && observers.length === 0) {
    throw new TypeError(
      'buildNodeConfig: observers must not be empty — the original agent panics (nil deref) ' +
        'when it receives a config with zero observers (config.go:41)',
    );
  }

  const meta: Record<string, unknown> = {};
  if (opts.enableStats !== false) {
    meta['enableStats'] = true;
    meta['observer.resetTraffic'] = true;
    meta['observer.period'] = opts.observerPeriod ?? DEFAULT_OBSERVER_PERIOD;
  }

  const services = (opts.services ?? []).map((svc) => {
    const merged: ServiceConfig = {
      name: svc.name,
      addr: svc.addr,
      handler: {
        type: svc.handler?.type ?? 'tcp',
        metadata: { ...meta, ...(svc.handler?.metadata ?? {}) },
        ...(svc.handler ?? {}),
      },
      listener: { type: svc.listener?.type ?? 'tcp', ...(svc.listener ?? {}) },
      observer: svc.observer ?? DEFAULT_OBSERVER_NAME,
      metadata: { ...meta, ...(svc.metadata ?? {}) },
    };
    return merged;
  });

  const config: NodeConfig = {
    log: { level: opts.logLevel ?? 'fatal' },
    tls: opts.tls ?? {
      validity: '8760h',
      commonName: '127.0.0.1',
      organization: '127.0.0.1',
    },
    services,
    chains: [],
    climiters: [],
    limiters: [],
    bypasses: [],
    admissions: [],
    observers:
      Array.isArray(observers) && observers.length > 0
        ? observers
        : [
            {
              name: DEFAULT_OBSERVER_NAME,
              plugin: { type: 'http', addr: observerEndpoint(opts.siteUrl) },
            },
          ],
    ...(opts.extra ?? {}),
  };
  return config;
}

/**
 * 生成单个 service（隧道映射）—— 便捷包装，供 pushNodeConfig 拼 services 用。
 *
 * @param name service 名（隧道侧 `tcp-<tunnelId>` / `udp-<tunnelId>`）
 * @param addr 监听地址。固定端口写 `:18123`；动态端口写 `:${waitListenPlaceholder(range)}`
 */
export function buildService(
  name: string,
  addr: string,
  opts: {
    protocol?: 'tcp' | 'udp';
    observerPeriod?: string;
    metadata?: Record<string, unknown>;
  } = {},
): ServiceConfig {
  const proto = opts.protocol ?? 'tcp';
  const meta = {
    enableStats: true,
    'observer.resetTraffic': true,
    'observer.period': opts.observerPeriod ?? DEFAULT_OBSERVER_PERIOD,
    ...(opts.metadata ?? {}),
  };
  return {
    name,
    addr,
    handler: { type: proto, metadata: { ...meta } },
    listener: { type: proto },
    observer: DEFAULT_OBSERVER_NAME,
    metadata: { ...meta },
  };
}

/**
 * 复刻 Go `json.dumps` / `encoding/json` 的**紧凑**序列化：
 *  - 无空格分隔符 `,` `:`
 *  - 非 ASCII 字符**原样输出 UTF-8**（不 `\uXXXX`）
 *  - 只转义 JSON 必需的控制字符 / `"` / `\`
 *  - key 顺序 = 对象属性插入顺序
 */
export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError('stableStringify: cannot serialize non-finite number');
    }
    return JSON.stringify(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value); // JS 只转义必需字符，非 ASCII 保留
  if (t === 'bigint') return (value as bigint).toString(10);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v === undefined ? null : v)).join(',') + ']';
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v === undefined) continue; // 与 JSON.stringify 一致：undefined 属性被丢弃
      parts.push(JSON.stringify(k) + ':' + stableStringify(v));
    }
    return '{' + parts.join(',') + '}';
  }
  // undefined / function / symbol
  throw new TypeError(`stableStringify: unsupported value type ${t}`);
}

/** 序列化节点配置为线上 JSON 字符串（紧凑、ASCII 安全）。 */
export function serializeNodeConfig(config: NodeConfig): string {
  return stableStringify(config);
}

/**
 * 生成证书下发用的 Fernet 密文（config token）。
 * 返回的字符串直接放进 `42["config","<这里>"]`。
 */
export function encryptNodeConfig(config: NodeConfig | string, key?: string): string {
  const json = typeof config === 'string' ? config : serializeNodeConfig(config);
  return new Fernet(key ?? configKey()).encrypt(json);
}

/**
 * 构造下发的 Socket.IO 帧：`42["config","<fernet密文>"]`。
 *
 * ⚠️ 返回的是**完整帧字符串**（含 `42` 前缀），可直接 `socket.send(frame)`。
 * 若你的 socket.io 封装已带 `emit('config', payload)` 语义，用
 * {@link encryptNodeConfig} 只取密文即可。
 */
export function buildConfigFrame(config: NodeConfig | string, key?: string): string {
  const token = encryptNodeConfig(config, key);
  // 裸字符串载荷（不是数组）—— 见文件头 ①
  return `42${JSON.stringify(['config', token])}`;
}

/** 解密下发的 config（服务端自检 / 测试用）。 */
export function decryptNodeConfig<T = NodeConfig>(
  token: string | Uint8Array,
  key?: string,
): T {
  return JSON.parse(new Fernet(key ?? configKey()).decryptToString(token)) as T;
}

/**
 * 计算配置指纹（sha256 hex），供 `pushNodeConfig` 的增量去重使用。
 * 只对**明文 JSON** 求 hash（密文每次都不同，不能用来去重）。
 */
export async function configFingerprint(config: NodeConfig | string): Promise<string> {
  const json = typeof config === 'string' ? config : serializeNodeConfig(config);
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(json, 'utf8').digest('hex');
}
