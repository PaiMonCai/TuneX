/**
 * V5.5 Federation —— 对称封装（新造件，见契约 §2.1）。
 *
 * 为什么需要它：`backend/src/crypto/` 只有数据面 HMAC token 工具，per-install
 * Fernet key（`TUNEX_CONFIG_KEY`）在 V4 WP15 已被删除，所以「私钥只以密文落地」
 * 这件事没有现成实现可用。
 *
 * 用的是**标准原语**，不是自创密码学：
 *   · 密钥派生：HKDF-SHA256(AUTH_SECRET, info="tunex-federation-v1") —— AUTH_SECRET
 *     是启动强制项（env.ts），每个安装独立（调用方传 secret 进来）；
 *   · 加密：AES-256-GCM，随机 12 字节 IV，认证标签随密文一起存。
 *
 * 密文格式（单行字符串，便于直接落库）：
 *   `v1.<iv-b64url>.<ciphertext-b64url>.<tag-b64url>`
 *
 * 这里**只**做封装/解封，不碰数据库、不做任何裁决：解封失败一律抛错（fail-closed），
 * 调用方不得用「解不开就当空」的方式降级。
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/** HKDF info：换个用途就换 info，绝不共用同一把派生密钥。 */
export const FEDERATION_SEAL_INFO = "tunex-federation-v1";
/** HKDF salt 固定值：密钥材料的熵来自 AUTH_SECRET，salt 只需域分离。 */
const HKDF_SALT = Buffer.from("tunex-federation-salt-v1", "utf8");
const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/**
 * 从主密钥派生封装密钥。**显式传入** secret：本模块刻意不 import env.ts ——
 * 那样会让"没有 AUTH_SECRET 的纯单测"在 import 阶段就炸（`requireSecret` 在模块
 * 求值时抛）。安装级密钥的读取放在 identity.ts（那一层本来就连库）。
 * 32 字节输出 = AES-256。
 */
export function deriveSealKey(secret: string): Buffer {
  const out = hkdfSync("sha256", Buffer.from(secret, "utf8"), HKDF_SALT, Buffer.from(FEDERATION_SEAL_INFO, "utf8"), KEY_BYTES);
  return Buffer.from(out);
}

/** 封装明文。返回可直接落库的单行字符串。 */
export function sealSecret(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error("federation: seal key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, b64url(iv), b64url(ct), b64url(tag)].join(".");
}

/**
 * 解封。任何结构/密钥/认证失败都抛错 —— 调用方必须把它当"数据不可用"，
 * 而不是"没有数据"（静默降级会让一次密钥损坏变成一次静默的身份重建）。
 */
export function unsealSecret(sealed: string, key: Buffer): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("federation: unsupported sealed secret format");
  const iv = fromB64url(parts[1]!);
  const ct = fromB64url(parts[2]!);
  const tag = fromB64url(parts[3]!);
  if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error("federation: malformed sealed secret");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * 常量时间比较（用于一次性 token 的哈希比对；与 node-credential 的同名工具同口径，
 * 不 import 它是为了不把「凭据」和「密钥封装」两件事耦在一起）。
 */
export function secretEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
