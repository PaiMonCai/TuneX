/**
 * 节点配置推送 — Fernet 加密 + Socket.IO 下发
 *
 * 协议事实（与原版一致）：
 *   - config 下发格式: 42["config","<fernet>"]——裸字符串，不是数组
 *   - Fernet 密钥与原版相同，生产环境应改为配置注入
 *   - 推送到 room `node_group/${groupId}`
 *
 * ── 增量去重（与原版一致）──
 * 原版 `TunnelService.pushNodeConfig` 用 Redis `node_group:config_hash`（hash，
 * field=groupId）记录上次下发的**明文 JSON 的 sha256**，仅当指纹变化时才 emit。
 * 本模块复刻该语义：{@link pushNodeConfig} 默认去重；节点 register 需强制下发，
 * 传 `{ force: true }`（否则重连节点若配置未变将拿不到配置）。
 *
 * Redis 不可用时**fail-open**（照样推送），保证配置可达性优先于省流。
 */
import { generateNodeConfig } from "./config-generator.ts";
import { fernetEncryptWith } from "../services/license-sign.ts";
import { redis } from "../redis.ts";
import { configKey } from "../crypto/keys.ts";


/** 指纹缓存（Redis hash），与原版键名一致。 */
export const NODE_GROUP_CONFIG_HASH_KEY = "node_group:config_hash";

export interface PushNodeConfigOptions {
  /** 跳过去重，强制下发（节点 register / 上线首推时使用）。 */
  force?: boolean;
}

/**
 * 推送配置到指定节点组的所有节点。
 * 如果 Socket.IO 未初始化，静默返回。
 *
 * @returns 实际是否发生了下发（去重命中时为 false）。
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
  if (!options.force) {
    const changed = await shouldPush(groupId, config.fingerprint);
    if (!changed) return false;
  }

  const encrypted = fernetEncryptWith(configKey(), config.json);
  const room = `node_group/${groupId}`;
  io.to(room).emit("config", encrypted);

  // 记录指纹（供下次去重）；写失败不阻断下发。
  await rememberFingerprint(groupId, config.fingerprint);
  return true;
}

/** 指纹是否变化（Redis 不可用时 fail-open：视为变化，强制推送）。 */
async function shouldPush(groupId: number, fingerprint: string): Promise<boolean> {
  try {
    const old = await redis.hget(NODE_GROUP_CONFIG_HASH_KEY, String(groupId));
    return old !== fingerprint;
  } catch {
    return true;
  }
}

async function rememberFingerprint(groupId: number, fingerprint: string): Promise<void> {
  try {
    await redis.hset(NODE_GROUP_CONFIG_HASH_KEY, String(groupId), fingerprint);
  } catch {
    /* 忽略缓存写失败 */
  }
}
