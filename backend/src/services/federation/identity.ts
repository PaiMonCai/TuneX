/**
 * V5.5 Federation —— 本 Panel 身份（WP14，契约 §2.1）。
 *
 * 事实：本仓库此前**不存在**任何「本机实例身份 / 公钥」概念（Lead 调研已核实）。
 * 这里新建的是一份**身份**，不是第二份业务真相：它只回答「我是谁、我用哪把钥匙签名」。
 *
 * 三条硬约束：
 *   1. 私钥只以密文落地（seal.ts），永不进入 API 响应 / 审计 / 诊断 / Support Bundle；
 *   2. `panel_id` 稳定（卸载重装才变）；每次读取都返回同一个值；
 *   3. 私钥解不开 = 身份不可用（抛错），**不得**静默重新生成 —— 静默重建身份
 *      会让所有已有 peer 的信任指向一个已经不存在的 Panel，且外面看不出来。
 */
import { importJWK, type JWK } from "jose";
import { db } from "../../db.ts";
import { env } from "../../env.ts";
import { deriveSealKey, sealSecret, unsealSecret } from "./seal.ts";
import { generatePanelKeyPair, keyIdFor, type PanelKeyPair } from "./keys.ts";

// 纯原语在 keys.ts / tokens.ts（不依赖 env 与 DB），这里原样再导出，
// 让调用方只需要认识 identity.ts 一个入口。
export { generatePanelKeyPair, keyIdFor };
export type { PanelKeyPair };

/** 安装级封装密钥：HKDF(AUTH_SECRET)。只在真正需要落库/解封私钥时才求值。 */
export function installSealKey(): Buffer {
  return deriveSealKey(env.authSecret);
}

export interface PanelIdentity {
  panel_id: string;
  key_id: string;
  public_jwk: JWK;
}

let cached: PanelIdentity | null = null;

/** 仅测试用：清掉进程内身份缓存。 */
export function resetPanelIdentityCache(): void {
  cached = null;
}

function toIdentity(row: { panel_id: string; key_id: string; public_key: unknown }): PanelIdentity {
  return { panel_id: row.panel_id, key_id: row.key_id, public_jwk: row.public_key as JWK };
}

async function loadRow() {
  return db.federationSetting.findFirst({ orderBy: { id: "asc" } });
}

/** 读取身份；不存在返回 null（**不**隐式创建）。 */
export async function getPanelIdentity(): Promise<PanelIdentity | null> {
  if (cached) return cached;
  const row = await loadRow();
  if (!row) return null;
  cached = toIdentity(row);
  return cached;
}

/**
 * 幂等确保身份存在。首次调用生成密钥对并落库（enabled 保持默认 false ——
 * 生成身份不等于开启联邦，开启必须是管理员的显式动作）。
 */
export async function ensurePanelIdentity(): Promise<PanelIdentity> {
  const existing = await loadRow();
  if (existing) {
    cached = toIdentity(existing);
    return cached;
  }
  const keys = await generatePanelKeyPair();
  const row = await db.federationSetting.create({
    data: {
      panel_id: crypto.randomUUID(),
      key_id: keys.key_id,
      private_key_enc: sealSecret(JSON.stringify(keys.private_jwk), installSealKey()),
      public_key: keys.public_jwk as never,
      enabled: false,
    },
  });
  cached = toIdentity(row);
  return cached;
}

/** 取出可用的签名密钥（解封私钥）。身份缺失或私钥损坏都会抛错。 */
export async function loadSigningKey(): Promise<{ identity: PanelIdentity; privateJwk: JWK }> {
  const row = await loadRow();
  if (!row) throw new Error("federation: panel identity is not initialised");
  const identity = toIdentity(row);
  cached = identity;
  const privateJwk = JSON.parse(unsealSecret(row.private_key_enc, installSealKey())) as JWK;
  return { identity, privateJwk };
}

/** 写入新密钥（轮转的提交步骤；调用方负责先让所有 peer 接受新公钥）。 */
export async function commitPanelKey(keys: PanelKeyPair): Promise<PanelIdentity> {
  const row = await loadRow();
  if (!row) throw new Error("federation: panel identity is not initialised");
  const updated = await db.federationSetting.update({
    where: { id: row.id },
    data: {
      key_id: keys.key_id,
      private_key_enc: sealSecret(JSON.stringify(keys.private_jwk), installSealKey()),
      public_key: keys.public_jwk as never,
    },
  });
  cached = toIdentity(updated);
  return cached;
}

export async function isFederationEnabled(): Promise<boolean> {
  const row = await loadRow();
  return row?.enabled === true;
}

export async function setFederationEnabled(enabled: boolean): Promise<void> {
  await ensurePanelIdentity();
  const row = await loadRow();
  if (!row) throw new Error("federation: panel identity is not initialised");
  await db.federationSetting.update({ where: { id: row.id }, data: { enabled } });
}

/** 把 JWK 导入为可验签的 key（供 peer 侧使用；解析失败抛错，调用方 fail-closed）。 */
export async function importVerifyKey(jwk: JWK) {
  return importJWK(jwk, "EdDSA");
}
