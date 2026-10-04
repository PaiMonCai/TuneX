/**
 * V5.5 Federation —— 一次性 token 与握手 proof 的**纯**原语。
 *
 * 复用 `node-enrollment` 的取向：明文只出现一次，库里只存 sha256。
 * 这里额外定义了握手 proof（见下），它是"对面真的是它"的唯一依据。
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { JWK } from "jose";

export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function invitationTokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * proof 的密钥：HKDF-SHA256(token) —— 只有拿到带外 token 的两端才推得出来。
 *
 * 为什么需要它：握手请求本身没有签名（信任尚未建立）。如果响应没有 proof，
 * 一个能在网络路径上应答的中间人就能用自己的公钥冒充 B，而 A 无从分辨。
 * 让 B 证明"我知道这次邀请 token"就把信任锚在了带外渠道上。
 */
function handshakeProofKey(token: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(token, "utf8"),
      Buffer.from("tunex-federation-handshake", "utf8"),
      Buffer.from("tunex-federation-handshake-v1", "utf8"),
      32,
    ),
  );
}

export interface HandshakeFields {
  panel_id: string;
  key_id: string;
  public_jwk: JWK;
}

export function computeHandshakeProof(token: string, fields: HandshakeFields): string {
  const canonical = JSON.stringify([fields.panel_id, fields.key_id, fields.public_jwk.x ?? null, fields.public_jwk.crv ?? null]);
  return createHmac("sha256", handshakeProofKey(token)).update(canonical, "utf8").digest("base64url");
}

export function verifyHandshakeProof(token: string, fields: HandshakeFields, proof: unknown): boolean {
  if (typeof proof !== "string" || proof.length === 0) return false;
  return invitationTokenEquals(computeHandshakeProof(token, fields), proof);
}
