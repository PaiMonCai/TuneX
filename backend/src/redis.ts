import Redis from "ioredis";
import { env } from "./env.ts";
import {
  GLOBAL_SCOPE,
  aliveGroupsKey,
  configHashKey,
  nodeRegisterBlockKey,
  observerBufferKey,
  outListenKey,
  parsePortLeaseLockKey,
  portLeaseLockKey,
  portLeaseLockPattern,
  registerBlockKey,
  scopedKey,
  trafficBufferPrefix,
  trafficBufferKey,
} from "./tenant-scope.ts";

export const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on("error", (e) => {
  console.error("[redis] error:", e?.message ?? e);
});

/*
 * ── TEN-02：键空间规范 ──
 *
 * 所有 TuneX 自己的 key 都必须带 `ws:<scope>:` 前缀，由 tenant-scope.ts 的
 * {@link scopedKey} 统一生成；本文件只是把各资源位包装成具名工厂，业务代码
 * **不允许**再手拼键名（手拼就是上个周期里 `register_block:` / `alive_groups`
 * / `sysinfo:` / `node_group:config_hash` 四种裸名风格并存、互相覆盖的根源）。
 *
 * 段位判定规则：**键的值是否描述某个 workspace 的资产**。
 *
 *   ws:<workspaceId>:...   租户数据。心跳、离线标记、出口端口表、流量缓冲、
 *                          observer 回传原文、v3 端口租约锁（WP1）——
 *                          内容属于某个 workspace。
 *   ws:global:...          平台共享数据。值只描述「平台侧/账户侧」的东西：
 *                          node_group.token 防爆破键（token 全局唯一）、
 *                          license 快照（实例级配置）、支付回调留痕、
 *                          JWT sub 映射（一个用户可属多个 workspace）、
 *                          冒充票据（token 全局唯一）、节点凭据防爆破键
 *                          （身份解析前发生，此时还不知道租户归属）。
 *
 * 注意「全局」在这里是显式选择（调用方显式传 0 或不传），而不是漏写 scope 的
 * 结果：漏写 scope 与「这就是全局键」在裸名时代无法区分，那正是本任务要堵的洞。
 *
 * BullMQ 的 `bull:*` 是第三方命名空间，不属于本规范。
 */

export {
  scopedKey,
  parseScopedKey,
  scopedPattern,
  scopeId,
  scopeTag,
  GLOBAL_SCOPE,
  GLOBAL_SCOPE_TAG,
  configHashKey,
  outListenKey,
  trafficBufferPrefix,
  trafficBufferKey,
  observerBufferKey,
  aliveGroupsKey,
  registerBlockKey,
  nodeRegisterBlockKey,
  nodeScope,
  portLeaseLockKey,
  portLeaseLockPattern,
  parsePortLeaseLockKey,
  socketRoom,
} from "./tenant-scope.ts";

/**
 * 应用使用的 Redis 键位（全部经 {@link scopedKey} 生成）。
 */
export const RedisKeys = {
  /* ---- 平台共享（ws:global） ---- */

  /** License 快照（实例级配置，不随租户变化）。 */
  license: scopedKey(GLOBAL_SCOPE, "license"),

  /**
   * 节点注册防爆破键。`node_group.token` 本身全局唯一（uuid），
   * 已隐含租户归属，故无需再加 workspace 段（加 scope 反而需要先解析 token→组）。
   */
  registerBlock: (groupToken: string) => registerBlockKey(groupToken),

  /** 观测回传缓冲键（按 workspace 分段，见 {@link observerBufferKey}）。 */
  observerBuffer: (scope?: number | null) => observerBufferKey(scope),

  /** 支付网关回调原文留痕（按网关 id；审计用，值只含回调报文）。 */
  payCallback: (paymentId: string) => scopedKey(GLOBAL_SCOPE, "pay", "callback", paymentId),

  /** 限流计数键（identity 已含 `user:<id>` / `ip:<addr>`，值只是计数）。 */
  rateLimit: (ruleName: string, identity: string) =>
    scopedKey(GLOBAL_SCOPE, "ratelimit", ruleName, identity),

  /** 节点组配置指纹缓存（hash，field=groupId，value=明文配置 JSON 的 sha256）。 */
  nodeGroupConfigHash: (scope?: number | null) => configHashKey(scope),

  /** 近期有心跳的节点组 id 集合（set；成员只有整数 id）。 */
  aliveNodeGroups: (scope?: number | null) => aliveGroupsKey(scope),

  /**
   * v3 端口租约抢占锁（WP1，`ws:<scope>:node_port_lease:lock:<nodeId>:<port>`）。
   *
   * 只用于**短事务并发协调**：端口所有权的长期真相是 DB 的
   * `UNIQUE(node_id, port)`，锁丢失由 DB unique 兜底。见
   * {@link portLeaseLockKey} 的三条使用约束（必带 TTL 等）。
   */
  portLeaseLock: (scope: number | null | undefined, nodeId: string, port: number) =>
    portLeaseLockKey(scope, nodeId, port),

  /** v3 端口租约锁扫描（WP3 reconciler 对账孤儿锁用）。 */
  portLeaseLockScan: (scope?: number | null) => portLeaseLockPattern(scope),

  /**
   * v3 节点凭据注册防爆破键（`ws:global:node_register_block:<fingerprint>`）。
   *
   * global 段的理由同 {@link RedisKeys.registerBlock}：防爆破发生在身份解析
   * 之前，还不知道节点属于哪个租户；键值只描述「这次失败尝试」。
   */
  nodeRegisterBlock: (credentialFingerprint: string) =>
    nodeRegisterBlockKey(credentialFingerprint),

  /* ---- 账户数据（user 段，不属于任何单个 workspace） ---- */

  /** JWT sub → user.id 映射缓存：`ws:global:user:<sub>:id`。 */
  userSub: (sub: string) => scopedKey(GLOBAL_SCOPE, "user", sub, "id"),

  /** 超管冒充票据（token → user.id，TTL 2h）。 */
  impersonation: (token: string) => scopedKey(GLOBAL_SCOPE, "impersonation", token),

  /** 充值订单单用户互斥锁：`ws:global:topup:order:<userId>`。 */
  topupOrderLock: (userId: number) => scopedKey(GLOBAL_SCOPE, "topup", "order", userId),
} as const;

/** observer 队列长度上限：无人消费的队列不设上限就是 Redis 内存泄漏。 */
export const OBSERVER_BUFFER_MAX = 500;

export async function redisPing(): Promise<boolean> {
  try {
    const r = await redis.ping();
    return r === "PONG";
  } catch {
    return false;
  }
}
