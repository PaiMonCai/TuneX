/**
 * V5.5 Federation —— 身份密钥的**纯**原语（不连库、不读 env）。
 *
 * 单独成文件的原因：`identity.ts` 需要数据库与进程环境，而这些函数本身是纯粹
 * 的密钥操作。测试要能在没有 DB / 没有 AUTH_SECRET 的环境里断言指纹与密钥形状，
 * 就必须让它们不经过 env.ts（那里的 `requireSecret` 会在 import 时就抛）。
 */
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, type JWK } from "jose";

export interface PanelKeyPair {
  key_id: string;
  public_jwk: JWK;
  private_jwk: JWK;
}

/** 生成一对 Ed25519 签名密钥。 */
export async function generatePanelKeyPair(): Promise<PanelKeyPair> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const public_jwk = await exportJWK(publicKey);
  const private_jwk = await exportJWK(privateKey);
  return { key_id: keyIdFor(public_jwk), public_jwk, private_jwk };
}

/** key_id = sha256(公钥 x 值) 前 16 hex。peer 侧用同一定义算指纹，两边必须一致。 */
export function keyIdFor(publicJwk: JWK): string {
  const material = typeof publicJwk.x === "string" ? publicJwk.x : JSON.stringify(publicJwk);
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}
