/**
 * Persistent identity for this Panel's federation endpoint.
 *
 * The Panel id is installation-stable. Signing keys are stored only in sealed
 * form; failure to decrypt an existing key is fatal and must never regenerate a
 * different identity silently. Creating identity material does not enable
 * federation.
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
