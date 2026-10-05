/**
 * V5-WP18.4 —— 通知渠道凭据的**封装层**（契约 F5 / R5）。
 *
 * ── 为什么不直接用 `federation/seal.ts` 的那把密钥 ──
 * `seal.ts` 自己写着「换个用途就换 info，绝不共用同一把派生密钥」。共用派生密钥的代价是
 * **一次泄漏等于两处泄漏**：联邦私钥的封装密钥一旦被拿到，通知 bot token 也一并暴露。
 * 所以这里：
 *   · **info 独立** —— `tunex-notification-v1`（联邦是 `tunex-federation-v1`，DDNS 是 `tunex-ddns-v1`）；
 *   · **salt 也独立** —— 域分离有两重（salt + info），不依赖"两边记得用同一个 salt"这种约定；
 *   · **AES-GCM 封装格式复用** `sealSecret()` / `unsealSecret()` —— 密文形态（`v1.<iv>.<ct>.<tag>`）
 *     与解析/校验逻辑只有一份，本模块不重写密码学。
 *
 * 与 `ddns-binding.ts` 的差异（有意）：那边 `sealSecretKey ?? process.env.AUTH_SECRET ?? ""`
 * 允许空串继续派生。这里**空主密钥直接抛错**：AUTH_SECRET 是启动强制项（`env.ts` 的
 * `requireSecret`），拿空串派生的密钥去封凭据，只会把"配置错误"变成"一堆解不开的密文"。
 *
 * ── fail-closed 的方向（C3 / F5）──
 * 解封失败**抛错**，不返回 null、不返回空串：调用方必须显式决定"报错"还是"降级"，
 * 而"降级成没有 token"会把一次密钥轮换错误变成静默的长期不投递。
 * 渠道层把它折叠成一条可见的 `secret_unreadable` 失败记录（见 `notification-telegram.ts`）。
 */
import { hkdfSync } from "node:crypto";
import { sealSecret, unsealSecret } from "./federation/seal.ts";

/** 本用途的 HKDF info（**新值**，绝不与联邦/DDNS 共用）。 */
export const NOTIFICATION_SEAL_INFO = "tunex-notification-v1";
/** 固定 salt：熵来自 AUTH_SECRET，salt 只做域分离（与 info 双重分离）。 */
const HKDF_SALT = Buffer.from("tunex-notification-salt-v1", "utf8");
/** AES-256-GCM 的密钥长度：改这个数字就是换算法，必须显式评审。 */
const KEY_BYTES = 32;
/** 密文长度上限：`secret_enc` 列不可能无限长，超限说明调用方写错了东西。 */
export const NOTIFICATION_SECRET_MAX_CHARS = 4_096;
/** 明文长度上限（bot token / webhook 密钥这类东西不会超过它）。 */
export const NOTIFICATION_SECRET_PLAINTEXT_MAX = 1_024;

/** 主密钥缺失/为空 = 配置错误（不是"没有凭据"），直接抛。 */
function requireMasterSecret(secret: string): string {
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new Error("notification seal: master secret (AUTH_SECRET) is required and must not be empty");
  }
  return secret;
}

/**
 * 从主密钥派生通知用途的封装密钥。
 * **显式传入** secret（与 `seal.ts` 同取向）：本模块不 import `env.ts`，
 * 这样没有 AUTH_SECRET 的纯单测不会在 import 阶段就炸。
 */
export function deriveNotificationSealKey(secret: string): Buffer {
  const master = requireMasterSecret(secret);
  const out = hkdfSync("sha256", Buffer.from(master, "utf8"), HKDF_SALT, Buffer.from(NOTIFICATION_SEAL_INFO, "utf8"), KEY_BYTES);
  return Buffer.from(out);
}

/** 封装明文（唯一落库入口；明文只在此处出现一次）。 */
export function sealNotificationSecret(plaintext: string, masterSecret: string): string {
  if (typeof plaintext !== "string" || plaintext === "") {
    throw new Error("notification seal: plaintext is required");
  }
  if (plaintext.length > NOTIFICATION_SECRET_PLAINTEXT_MAX) {
    throw new Error("notification seal: plaintext too long");
  }
  return sealSecret(plaintext, deriveNotificationSealKey(masterSecret));
}

/**
 * 解封。**任何失败都抛错**，且错误消息刻意**不含**密文或明文
 * （错误会经渠道层落进投递账本的 `error` 列 —— 那里不该出现凭据的任何形态）。
 */
export function unsealNotificationSecret(sealed: string, masterSecret: string): string {
  if (typeof sealed !== "string" || sealed === "" || sealed.length > NOTIFICATION_SECRET_MAX_CHARS) {
    throw new Error("notification seal: malformed ciphertext");
  }
  try {
    return unsealSecret(sealed, deriveNotificationSealKey(masterSecret));
  } catch {
    // 不把原始异常往上抛：它可能带上密文片段（`seal.ts` 的错误里没有密文，但这是别人的实现，
    // 不该由本模块替它保证）。
    throw new Error("notification seal: cannot unseal stored secret");
  }
}

/**
 * 部署面主密钥（`AUTH_SECRET`）。与 `ddns-binding.ts` 同形：可注入（单测）+ 缺省读 env。
 * 只读不缓存：env 在进程内不变，缓存只会让单测之间的替身互相污染。
 */
export function notificationSealMasterSecret(env: Record<string, string | undefined> = process.env): string {
  return env.AUTH_SECRET ?? "";
}
