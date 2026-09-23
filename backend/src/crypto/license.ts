/**
 * TuneX — License 自签模块
 *
 * 原版 agent（v0.13.22）的 license 校验**全部在客户端**（逆向实测）：
 *   解密 Fernet(license_key, token) → `License.expired_at` 未过期
 *                                   → `License.site_url` 与 `-s` 参数一致
 *                                   → `License.type` ∈ {business, personal}
 * 这三项全过则日志打印 `License loaded successfully`，然后开始收 config。
 *
 * 因为原版把 license 密钥硬编码在客户端（上游设计缺陷），服务端可以无限期自签 license；
 * TuneX 已移除该固定密钥，改为每个部署独立的 `TUNEX_LICENSE_KEY`。
 *
 * ── 三个实测踩坑（每一条都曾让真实 agent 崩溃）──
 *
 * ① `expired_at` **必须是 int64 数字**，不能是 ISO 8601 字符串。
 *    传 `"2099-12-31T23:59:59.000Z"` → agent 进程 panic：
 *      `cannot unmarshal string into Go struct field License.expired_at of type int64`
 *    （socket.go:35）
 *
 * ② `site_url` **必须与 agent 启动时的 `-s` 值逐字节一致**。
 *    不一致 → agent panic：`License site_url ... does not match server ...`（socket.go:49）。
 *    本库无法替你校验（它不知道 agent 的 `-s`），**调用方必须保证**：
 *      license.siteUrl === config.SITE_URL === agent `-s` 参数
 *    建议只从一个地方取 SITE_URL（如 `env.siteUrl`），任何地方都不要另写字符串字面量。
 *
 * ③ `type` 只能是 `"business"` / `"personal"`；写 `"pro"` 之类的值会被拒。
 */

import { Fernet, InvalidToken, currentUnixSeconds } from './fernet.ts';
import { licenseKey } from './keys.ts';

/** License 类型枚举（对齐服务端源码 / agent Go 结构体）。 */
export type LicenseType = 'business' | 'personal';

/** 合法 LicenseType 全集。 */
export const LICENSE_TYPES: readonly LicenseType[] = ['business', 'personal'] as const;

/** int64 边界（agent 侧字段是 Go int64）。 */
export const INT64_MAX = 9223372036854775807n;
export const INT64_MIN = -9223372036854775808n;

/** 已解密的 license 明文结构（**键序即线上字节序**，不可随意调整）。 */
export interface LicensePayload {
  expired_at: number;
  type: LicenseType;
  site_url: string;
}

export interface SignLicenseInput {
  /**
   * 到期时间，**Unix 秒**（Go int64）。
   *
   * 接受 `number` 或 `bigint`：
   *  - `number` 必须是**安全整数**（`Number.isSafeInteger`）。超出 2^53-1 会因
   *    IEEE754 精度丢位，序列化出的数字与入参不符 → 直接抛错而不是静默写错。
   *  - 需要超过 2^53-1 的极端未来时间时传 `bigint`（按精确十进制数字序列化）。
   */
  expiredAt: number | bigint;
  type: LicenseType;
  /** **必须等于 agent 的 `-s` 参数**（见文件头 ②）。 */
  siteUrl: string;
}

export interface VerifyLicenseOptions {
  /** license 密钥。默认取环境变量 `TUNEX_LICENSE_KEY`。 */
  key?: string;
  /** 校验 TTL / 过期（默认 `false`：license 是否过期由调用方决定是否拒绝）。 */
  checkExpiry?: boolean;
  /** 覆盖"当前时间"（Unix 秒）。仅供测试。 */
  now?: number;
}

export interface VerifiedLicense {
  /** 原始 payload（键名与 agent 结构体一致：snake_case）。 */
  payload: LicensePayload;
  /** 到期时间（Unix 秒）。 */
  expiredAt: number;
  type: LicenseType;
  siteUrl: string;
  /** Fernet token 内嵌的签发时间（Unix 秒）。 */
  issuedAt: number;
  /** 按 `now` 判定的是否已过期。 */
  expired: boolean;
  /** token 里 `site_url` 是否与期望值一致（未传 `expectedSiteUrl` 时为 `true`）。 */
  siteUrlMatches: boolean;
}

/** 把 int64 值转为精确十进制字符串（用于手工拼 JSON，避免精度丢失）。 */
function toExactIntString(value: number | bigint): string {
  if (typeof value === 'bigint') {
    if (value > INT64_MAX || value < INT64_MIN) {
      throw new RangeError(`license: expiredAt ${value} out of int64 range`);
    }
    return value.toString(10);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`license: expiredAt must be a number or bigint, got ${typeof value}`);
  }
  if (!Number.isInteger(value)) {
    throw new TypeError(`license: expiredAt must be an integer (Unix seconds), got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `license: expiredAt ${value} exceeds Number.MAX_SAFE_INTEGER — pass a bigint instead, ` +
        `otherwise JSON precision loss would silently sign a different timestamp`,
    );
  }
  return value.toString(10);
}

/**
 * 序列化 license payload 为**线上字节级 JSON**（紧凑、无空格、固定键序）。
 *
 * 键序：`expired_at`, `type`, `site_url` —— 与 Python 参考实现
 * `/tmp/e2e/server.py` 的 `make_license()` 以及 agent 结构体声明序一致。
 * 手工拼接而非 `JSON.stringify`，只为让 `expired_at` 输出精确的 int64 十进制数字。
 */
export function serializeLicensePayload(input: SignLicenseInput): string {
  const expiredAt = toExactIntString(input.expiredAt);
  if (!LICENSE_TYPES.includes(input.type)) {
    throw new TypeError(
      `license: type must be one of ${LICENSE_TYPES.join(' | ')}, got ${JSON.stringify(input.type)}`,
    );
  }
  if (typeof input.siteUrl !== 'string' || input.siteUrl.length === 0) {
    throw new TypeError('license: siteUrl must be a non-empty string');
  }
  return (
    `{"expired_at":${expiredAt},` +
    `"type":${JSON.stringify(input.type)},` +
    `"site_url":${JSON.stringify(input.siteUrl)}}`
  );
}

/**
 * 签发 license（Fernet token）。
 *
 * ```ts
 * const token = signLicense({
 *   expiredAt: Math.floor(Date.now() / 1000) + 30 * 86400,
 *   type: 'business',
 *   siteUrl: process.env.SITE_URL!,   // 必须与 agent -s 一致
 * });
 * socket.emit('...'); // 放进 430[{license: token, site_url, type, now}]
 * ```
 *
 * @param input 见 {@link SignLicenseInput}
 * @param keyUpToNow license 密钥（默认 `TUNEX_LICENSE_KEY`）。仅测试用。
 */
export function signLicense(input: SignLicenseInput, key?: string): string {
  const plaintext = serializeLicensePayload(input);
  return new Fernet(key ?? licenseKey()).encrypt(plaintext);
}

/** 解析已解密的 license 明文（严格校验字段类型，模拟 agent 的结构体反序列化）。 */
export function parseLicensePayload(plaintext: string | Uint8Array): LicensePayload {
  const text =
    typeof plaintext === 'string' ? plaintext : Buffer.from(plaintext).toString('utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new InvalidToken(`license: payload is not valid JSON (${(err as Error).message})`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidToken('license: payload must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  // ── expired_at：复刻 agent 的类型严格性（字符串会让真实 agent panic）──
  const expiredAt = obj['expired_at'];
  if (typeof expiredAt !== 'number' || !Number.isFinite(expiredAt)) {
    throw new InvalidToken(
      `license: expired_at must be a JSON number (int64), got ${JSON.stringify(expiredAt)} — ` +
        `an ISO-8601 string makes the Go agent panic`,
    );
  }
  if (!Number.isInteger(expiredAt)) {
    throw new InvalidToken(`license: expired_at must be an integer, got ${expiredAt}`);
  }
  if (obj['type'] !== undefined && !LICENSE_TYPES.includes(obj['type'] as LicenseType)) {
    throw new InvalidToken(
      `license: type must be one of ${LICENSE_TYPES.join(' | ')}, got ${JSON.stringify(obj['type'])}`,
    );
  }
  if (obj['site_url'] !== undefined && typeof obj['site_url'] !== 'string') {
    throw new InvalidToken('license: site_url must be a string');
  }
  return {
    expired_at: expiredAt,
    // 原版结构体无 omitempty，缺省时是零值空串
    type: (obj['type'] as LicenseType | undefined) ?? ('personal' as LicenseType),
    site_url: (obj['site_url'] as string | undefined) ?? '',
  };
}

/**
 * 解密并验证 license token。
 *
 * - HMAC 不对 / 版本字节错 / 填充坏 → 抛 {@link InvalidToken}
 * - `checkExpiry: true` 时过期 → 抛 {@link InvalidToken}（`code === 'license-expired'`）
 * - `siteUrl` 不匹配**不抛错**，通过 `siteUrlMatches` 返回（调用方决定策略：
 *   register 校验链里应作为拒绝理由，因为原版 agent 自己会panic）
 */
export function verifyLicense(
  token: string | Uint8Array,
  opts: VerifyLicenseOptions & { expectedSiteUrl?: string } = {},
): VerifiedLicense {
  const f = new Fernet(opts.key ?? licenseKey());
  const plaintext = f.decryptToString(token);
  const payload = parseLicensePayload(plaintext);
  const now = opts.now ?? currentUnixSeconds();
  const expired = payload.expired_at < now;
  if (opts.checkExpiry && expired) {
    throw new InvalidToken(
      `license: expired at ${payload.expired_at} (now ${now})`,
      'license-expired',
    );
  }
  return {
    payload,
    expiredAt: payload.expired_at,
    type: payload.type,
    siteUrl: payload.site_url,
    issuedAt: Fernet.tokenTimestamp(token),
    expired,
    siteUrlMatches:
      opts.expectedSiteUrl === undefined ? true : payload.site_url === opts.expectedSiteUrl,
  };
}

/** register ACK 中与 license 相关的四件套（实测线上格式，`430[...]` 的载荷）。 */
export interface RegisterAckLicense {
  license: string;
  site_url: string;
  type: LicenseType;
  now: number;
}

/**
 * 直接构造 register ACK 的载荷 —— `register` handler 可直接用。
 *
 * 实测 ACK 线格式：`430[{license, site_url, type, now}]`
 * （帧前缀 `43` + ackId `0`，**不是** `440[...]` —— `44` 是 Socket.IO 的 ERROR 包）
 *
 * `now` 用于 agent 的时钟同步（数据面 token 的 ±300s 窗口依赖它）。
 */
export function buildRegisterAck(
  input: SignLicenseInput,
  opts: { key?: string; now?: number } = {},
): RegisterAckLicense {
  return {
    license: signLicense(input, opts.key),
    site_url: input.siteUrl,
    type: input.type,
    now: opts.now ?? currentUnixSeconds(),
  };
}

/** 常见 license 有效期：按天计算到期 Unix 秒（便捷函数）。 */
export function expiryFromDays(days: number, from: number = currentUnixSeconds()): number {
  if (!Number.isFinite(days)) throw new TypeError('license: days must be finite');
  return from + Math.round(days * 86400);
}
