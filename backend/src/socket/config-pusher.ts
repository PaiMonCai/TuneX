/**
 * 节点配置推送 — Fernet 加密 + Socket.IO 下发 + 增量去重
 *
 * 协议事实（与原版一致）：
 *   - config 下发格式: 42["config","<fernet>"]——裸字符串，不是数组
 *   - 推送到 room `node_group/${groupId}`
 *
 * ── 增量去重（与原版一致）──
 * 原版 `TunnelService.pushNodeConfig` 用 Redis `node_group:config_hash`（hash，
 * field=groupId）记录上次下发的**明文 JSON 的 sha256**（`config-generator` 已产出
 * `fingerprint`），仅当指纹变化时才 emit。
 *
 * 本模块的语义：
 *   · 默认路径（不传 `force`）：指纹与缓存一致 → 直接跳过 `emit`，**不加密、不下发**；
 *     指纹变化或缓存缺失 → 下发并把新指纹写入缓存。
 *   · `force: true`：跳过比对强制下发（节点 register 上线首推必须拿到配置），
 *     但**仍会把当前指纹写入缓存**，保证后续非强制调用能正确去重。
 *
 * 为什么必须保留 force：去重基于「内容指纹」，无法区分「同一份配置推给首次连上的
 * 新节点」——若 register 也走默认去重，重连节点在配置未变时将永远收不到配置。
 *
 * ── fail-open ──
 * Redis 不可用时**一律放行**（`shouldPush` 视为变化、`markConfigPushed` 静默失败），
 * 配置可达性优先于省流：宁可能重复推送，也不能因缓存故障让节点拿不到配置。
 */
import { generateNodeConfig } from "./config-generator.ts";
import { fernetEncryptWith } from "../services/license-sign.ts";
import { redis } from "../redis.ts";
import { configKey } from "../crypto/keys.ts";

/** 指纹缓存（Redis hash），与原版键名一致：field=groupId，value=明文 JSON 的 sha256。 */
export const NODE_GROUP_CONFIG_HASH_KEY = "node_group:config_hash";

export interface PushNodeConfigOptions {
  /** 跳过去重，强制下发（节点 register / 上线首推时使用）。 */
  force?: boolean;
}

/**
 * 读取某节点组上次下发的指纹；缓存缺失/不可用返回 null。
 * （Redis 故障时也返回 null，等价于「未推送过」——调用方按需 fail-open。）
 */
export async function getPushedFingerprint(groupId: number): Promise<string | null> {
  try {
    return await redis.hget(NODE_GROUP_CONFIG_HASH_KEY, String(groupId));
  } catch {
    return null;
  }
}

/**
 * 记录某节点组本次下发的指纹。写失败只打日志、不抛出（fail-open）。
 * @returns 是否写入成功。
 */
export async function markConfigPushed(groupId: number, fingerprint: string): Promise<boolean> {
  try {
    await redis.hset(NODE_GROUP_CONFIG_HASH_KEY, String(groupId), fingerprint);
    return true;
  } catch (e) {
    console.warn(
      `[config-push] failed to record fingerprint for group ${groupId}:`,
      (e as Error)?.message ?? e,
    );
    return false;
  }
}

/** 清除某节点组的指纹缓存（节点组删除/重置时使用）。 */
export async function clearConfigFingerprint(groupId: number): Promise<void> {
  try {
    await redis.hdel(NODE_GROUP_CONFIG_HASH_KEY, String(groupId));
  } catch {
    /* 忽略缓存删除失败 */
  }
}

/**
 * 是否应下发：指纹变化（含缓存缺失）→ true。
 * Redis 不可用 fail-open：视为变化，强制推送。
 */
async function shouldPush(groupId: number, fingerprint: string): Promise<boolean> {
  try {
    const old = await redis.hget(NODE_GROUP_CONFIG_HASH_KEY, String(groupId));
    return old !== fingerprint;
  } catch {
    return true;
  }
}

/**
 * 推送配置到指定节点组的所有节点。
 * 如果 Socket.IO 未初始化，静默返回 false。
 *
 * @returns 实际是否发生了下发（默认路径上去重命中时为 false）。
 */
export async function pushNodeConfig(
  groupId: number,
  options: PushNodeConfigOptions = {},
): Promise<boolean> {
  const io = (globalThis as Record<string, unknown>).__io as
    | { to: (room: string) => { emit: (event: string, ...args: unknown[]) => void } }
    | undefined;
  if (!io) return false;

  const config = await generateNodeConfig(groupId);
  // config 是 GeneratedNodeConfig{nodeGroupId,nodeType,config,json,fingerprint}；
  // 下发的是其中的 json 字段（gost 配置本体），指纹是明文 JSON 的 sha256。

  // 增量去重：默认路径下指纹未变则跳过（不加密、不下发）。
  if (!options.force) {
    const changed = await shouldPush(groupId, config.fingerprint);
    if (!changed) return false;
  }

  const encrypted = fernetEncryptWith(configKey(), config.json);
  io.to(`node_group/${groupId}`).emit("config", encrypted);

  // 记录指纹（供下次去重）；force 路径同样落缓存，写失败不阻断下发。
  await markConfigPushed(groupId, config.fingerprint);
  return true;
}
