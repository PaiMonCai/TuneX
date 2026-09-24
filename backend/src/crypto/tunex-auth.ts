/**
 * TuneX — tunex-auth 数据面认证
 *
 * 复刻原版 dialer/listener 的隧道 token 方案（逆向确认，见报告 02/03）。
 *
 * ── 56 字节 token 布局（验收标准要求显式断言）──
 *
 *   offset  0..16   nonce          16 字节随机数
 *   offset 16..24   timestamp       8 字节 **UnixNano** 大端（不是 Unix 秒！）
 *   offset 24..56   mac            32 字节 HMAC-SHA256
 *   ────────────────────────────────────────────
 *   合计 56 字节
 *
 *   首字节 bit0 = **会话复用标志**（`or $0x1` 置位 / `and $0xfffffffe` 清零，
 *   见 dialer 报告 §1 0x1132a1a / 0x1132a41）。
 *   ⚠️ 报告正文同时出现了"MSB 翻转"的说法，但反汇编掩码 `0x1` / `0xfffffffe`
 *   明确操作的是 **bit 0（LSB）**。本库按指令字面实现 bit0，并把常量暴露出来，
 *   以便与原版二进制对齐时一键切换。
 *
 * ── 密钥派生 ──
 *
 *   authKey = HKDF-SHA256(secret, salt = nil, info = "tunex-auth-v1", L = 32)
 *   mac     = HMAC-SHA256(authKey, nonce ‖ timestamp)
 *
 * ── 校验链（listener 侧 serveHTTP）──
 *
 *   1. `Authorization: Bearer <base64(56B)>` 前缀
 *   2. 原始长度必须 = 56 字节
 *   3. 时间窗 |now - ts| ≤ 300s
 *   4. HMAC 恒定时间比较
 *   5. replay cache（128 槽滑动窗口）—— 时间窗内同 nonce 二次出现 → "token replay"
 */

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  TUNEX_AUTH_HKDF_INFO,
  TUNEX_AUTH_TOKEN_BYTES,
  TUNEX_AUTH_TOKEN_OFFSETS,
  TUNEX_AUTH_WINDOW_SECONDS,
} from './keys.ts';

export const TOKEN_BYTES = TUNEX_AUTH_TOKEN_BYTES; // 56
export const OFFSETS = TUNEX_AUTH_TOKEN_OFFSETS;
export const HKDF_INFO = TUNEX_AUTH_HKDF_INFO;
export const DEFAULT_WINDOW_SECONDS = TUNEX_AUTH_WINDOW_SECONDS;

/**
 * 会话复用标志在首字节中的位号。
 * 反汇编掩码为 `0x1` / `0xfffffffe` → bit 0（LSB）。
 */
export const REUSE_FLAG_BIT = 0;

const NANOS_PER_SECOND = 1_000_000_000n;
const MAX_INT64 = 9223372036854775807n;

/** 32 字节 authKey。 */
export type AuthKey = Uint8Array;

/**
 * HKDF-SHA256 派生 authKey。
 * @param secret 节点组 token（`node_group.token`）
 * @param info   HKDF info（默认 `tunex-auth-v1`）
 */
export function deriveAuthKey(secret: string | Uint8Array, info: string = HKDF_INFO): Buffer {
  const ikm = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (ikm.length === 0) throw new TypeError('tunex-auth: secret must not be empty');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));
}

export interface BuildTokenOptions {
  /** authKey（32 字节）。与 `secret` 二选一，`authKey` 优先。 */
  authKey?: string | Uint8Array;
  /** secret（节点组 token）。未给 authKey 时用它派生。 */
  secret?: string | Uint8Array;
  /** 是否置会话复用标志（首字节 bit0）。默认 false。 */
  reuse?: boolean;
  /** 覆盖 UnixNano 时间戳（bigint）。默认取当前时间。 */
  timestampNanos?: bigint;
  /** 覆盖 16 字节 nonce。默认随机。仅供确定性测试。 */
  nonce?: Uint8Array;
}

/** 当前 UnixNano。 */
export function currentUnixNanos(): bigint {
  // Date.now() 只有毫秒精度 —— 对 ±300s 的窗口判定绰绰有余。
  return BigInt(Date.now()) * 1_000_000n;
}

function resolveAuthKey(opts: { authKey?: string | Uint8Array; secret?: string | Uint8Array }): Buffer {
  if (opts.authKey !== undefined) {
    const k = typeof opts.authKey === 'string' ? Buffer.from(opts.authKey, 'utf8') : Buffer.from(opts.authKey);
    if (k.length === 0) throw new TypeError('tunex-auth: authKey must not be empty');
    return k;
  }
  if (opts.secret !== undefined) return deriveAuthKey(opts.secret);
  throw new TypeError('tunex-auth: either authKey or secret is required');
}

/**
 * 构造 56 字节 token。
 *
 * ```ts
 * const token = buildTunexToken({ secret: nodeGroupToken });
 * // → Authorization: Bearer <base64(token)>
 * ```
 */
export function buildTunexToken(opts: BuildTokenOptions): Buffer {
  const authKey = resolveAuthKey(opts);
  const reuse = opts.reuse ?? false;

  let nonce: Buffer;
  if (opts.nonce !== undefined) {
    nonce = Buffer.from(opts.nonce);
    if (nonce.length !== 16) {
      throw new TypeError(`tunex-auth: nonce must be 16 bytes, got ${nonce.length}`);
    }
  } else {
    nonce = randomBytes(16);
  }
  // 复用标志：置位/清零首字节 bit0（不影响其余随机位）
  if (reuse) {
    nonce[0] = nonce[0]! | (1 << REUSE_FLAG_BIT);
  } else {
    nonce[0] = nonce[0]! & ~(1 << REUSE_FLAG_BIT) & 0xff;
  }

  const tsNanos = opts.timestampNanos ?? currentUnixNanos();
  if (typeof tsNanos !== 'bigint') {
    throw new TypeError('tunex-auth: timestampNanos must be a bigint');
  }
  if (tsNanos < 0n || tsNanos > MAX_INT64) {
    throw new RangeError(`tunex-auth: timestampNanos ${tsNanos} out of int64 range`);
  }
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigInt64BE(tsNanos);

  const signingInput = Buffer.concat([nonce, tsBuf]);
  const mac = createHmac('sha256', authKey).update(signingInput).digest();

  const token = Buffer.concat([nonce, tsBuf, mac]);
  /* c8 ignore next */
  if (token.length !== TOKEN_BYTES) {
    throw new Error(`tunex-auth: internal — built token has ${token.length} bytes, expected ${TOKEN_BYTES}`);
  }
  return token;
}

/** 读取 token 内嵌的 UnixNano 时间戳（不校验 HMAC）。 */
export function tokenTimestampNanos(token: Uint8Array): bigint {
  const buf = Buffer.isBuffer(token) ? token : Buffer.from(token);
  if (buf.length < OFFSETS.timestamp + 8) {
    throw new TypeError('tunex-auth: token too short to read timestamp');
  }
  return buf.readBigInt64BE(OFFSETS.timestamp);
}

/** 读取会话复用标志（首字节 bit0）。 */
export function tokenReuseFlag(token: Uint8Array): boolean {
  const buf = Buffer.isBuffer(token) ? token : Buffer.from(token);
  if (buf.length < 1) throw new TypeError('tunex-auth: empty token');
  return (buf[0]! & (1 << REUSE_FLAG_BIT)) !== 0;
}

/** 读取 nonce（16 字节）。 */
export function tokenNonce(token: Uint8Array): Buffer {
  const buf = Buffer.isBuffer(token) ? token : Buffer.from(token);
  return Buffer.from(buf.subarray(OFFSETS.nonce, OFFSETS.nonce + 16));
}

// ─────────────────────────────── replay cache ───────────────────────────────

/**
 * replay cache 接口。默认提供内存实现 {@link InMemoryReplayCache}；
 * 多实例部署可实现一个 Redis 版本（`SET NX EX` 语义）并注入。
 */
export interface ReplayCache {
  /**
   * 记录一个 (nonce, timestamp) 并判断是否重放。
   * @returns `true` 表示"首次出现（接受）"，`false` 表示重放（拒绝）
   */
  checkAndRemember(nonce: Uint8Array, timestampNanos: bigint, nowNanos?: bigint): boolean;
  /** 清空。 */
  reset(): void;
  /** 当前缓存的 nonce 条数。 */
  readonly size: number;
}

export interface ReplayCacheOptions {
  /** 槽位数。原版为 128。 */
  slots?: number;
  /** 时间窗（纳秒）。原版 ±300s。 */
  windowNanos?: bigint;
  /** 单槽最大条目数（防内存 DoS）。超出后拒绝新条目。 */
  maxEntriesPerSlot?: number;
}

interface ReplaySlot {
  epoch: bigint;
  seen: Set<string>;
}

/**
 * 内存 replay cache —— 复刻原版 `*[128]replay.block` 环形桶 + 时间窗推进清空。
 *
 * 设计：把时间轴按 `slotWidth = windowNanos` 切成桶，环形复用 128 个槽。
 * 判定重放时，检查所有与 `[ts - window, ts + window]` 区间相交的槽
 * （最多 3 个），避免"桶边界刚好把同一时间窗切成两半"漏判。
 */
export class InMemoryReplayCache implements ReplayCache {
  readonly slots: number;
  readonly windowNanos: bigint;
  readonly maxEntriesPerSlot: number;
  private readonly _slots: ReplaySlot[];

  constructor(opts: ReplayCacheOptions = {}) {
    const slots = opts.slots ?? 128;
    if (!Number.isInteger(slots) || slots < 2) {
      throw new TypeError(`tunex-auth: slots must be an integer ≥ 2, got ${slots}`);
    }
    this.slots = slots;
    this.windowNanos = opts.windowNanos ?? BigInt(DEFAULT_WINDOW_SECONDS) * NANOS_PER_SECOND;
    this.maxEntriesPerSlot = opts.maxEntriesPerSlot ?? 4096;
    this._slots = Array.from({ length: slots }, () => ({ epoch: -1n, seen: new Set<string>() }));
  }

  private indexOf(tNanos: bigint): number {
    // 负时间不会出现（UnixNano ≥ 0）；用 BigInt 取模再转 number。
    const idx = (tNanos / this.windowNanos) % BigInt(this.slots);
    return Number(idx);
  }

  private bucketFor(tNanos: bigint): ReplaySlot {
    const i = this.indexOf(tNanos);
    let slot = this._slots[i]!;
    const epoch = tNanos / this.windowNanos;
    if (slot.epoch !== epoch) {
      // 时间窗推进 —— 清空该槽（等价原版 advanceReplayLocked 的过旧块清理）
      slot.epoch = epoch;
      slot.seen.clear();
    }
    return slot;
  }

  checkAndRemember(nonce: Uint8Array, timestampNanos: bigint, _nowNanos?: bigint): boolean {
    if (typeof timestampNanos !== 'bigint') {
      throw new TypeError('tunex-auth: timestampNanos must be a bigint');
    }
    const key = Buffer.from(nonce).toString('hex');
    const w = this.windowNanos;

    // 收集与 [ts-w, ts+w] 相交的桶
    const candidates: ReplaySlot[] = [];
    const startEpoch = (timestampNanos - w) / w;
    const endEpoch = (timestampNanos + w) / w;
    for (let e = startEpoch; e <= endEpoch; e++) {
      const i = Number(((e % BigInt(this.slots)) + BigInt(this.slots)) % BigInt(this.slots));
      const slot = this._slots[i]!;
      if (slot.epoch === e) candidates.push(slot);
    }
    for (const slot of candidates) {
      if (slot.seen.has(key)) return false; // 重放
    }

    const target = this.bucketFor(timestampNanos);
    if (target.seen.size >= this.maxEntriesPerSlot) {
      // 槽满：拒绝（fail-closed，宁可误拒也不漏放重放）
      return false;
    }
    target.seen.add(key);
    return true;
  }

  reset(): void {
    for (const s of this._slots) {
      s.epoch = -1n;
      s.seen.clear();
    }
  }

  get size(): number {
    let n = 0;
    for (const s of this._slots) n += s.seen.size;
    return n;
  }
}

// ─────────────────────────────── verification ───────────────────────────────

export type VerifyFailureReason =
  | 'malformed-header'
  | 'bad-base64'
  | 'bad-length'
  | 'bad-mac'
  | 'outside-window'
  | 'replay';

export interface VerifySuccess {
  ok: true;
  /** 原始 56 字节 token。 */
  token: Buffer;
  /** 内嵌 UnixNano 时间戳。 */
  timestampNanos: bigint;
  /** 距 now 的秒差（可为负）。 */
  skewSeconds: number;
  /** 会话复用标志。 */
  reuse: boolean;
  /** 16 字节 nonce。 */
  nonce: Buffer;
}

export interface VerifyFailure {
  ok: false;
  reason: VerifyFailureReason;
  message: string;
}

export type VerifyResult = VerifySuccess | VerifyFailure;

/** 解析 `Authorization` 头 → token 原始字节。 */
export function parseAuthorizationHeader(header: string | null | undefined): Buffer {
  if (!header || typeof header !== 'string') {
    throw new Error('tunex-auth: missing Authorization header');
  }
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) throw new Error('tunex-auth: Authorization must be `Bearer <token>`');
  const b64 = m[1]!.trim();
  let raw: Buffer;
  // 与原版一致：base64 标准字母表（Go base64.StdEncoding，带 `=` 填充）
  try {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error('non-base64 char');
    raw = Buffer.from(b64, 'base64');
  } catch {
    throw new Error('tunex-auth: token is not valid base64');
  }
  return raw;
}

/** 编码 `Authorization: Bearer ...` 头值（Go base64.StdEncoding，带填充）。 */
export function encodeAuthorizationHeader(token: Uint8Array): string {
  return `Bearer ${Buffer.from(token).toString('base64')}`;
}

/** 恒定时间比较两个 32 字节 mac。 */
function macEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface VerifyTokenOptions {
  /** authKey（32 字节）。与 `secret` 二选一。 */
  authKey?: string | Uint8Array;
  /** secret（节点组 token）。 */
  secret?: string | Uint8Array;
  /** 时间窗（秒）。默认 300。 */
  windowSeconds?: number;
  /** 覆盖"当前时间"（UnixNano）。仅供测试。 */
  nowNanos?: bigint;
  /** replay cache。省略则**跳过重放检查**（仅做密码学校验）。 */
  replay?: ReplayCache;
}

/**
 * 校验 token。**永不抛异常**——所有失败都通过 `{ok:false, reason}` 返回，
 * 便于 listener 侧直接把失败映射成 serveNotFound（对探测者不泄露失败原因）。
 */
export function verifyTunexToken(
  token: string | Uint8Array,
  opts: VerifyTokenOptions,
): VerifyResult {
  try {
    let raw: Buffer;
    if (typeof token === 'string') {
      try {
        raw = parseAuthorizationHeader(token);
      } catch (err) {
        // 也可能调用方直接传了裸 base64（无 Bearer 前缀）
        try {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(token.trim())) throw new Error('x');
          raw = Buffer.from(token.trim(), 'base64');
        } catch {
          return { ok: false, reason: 'malformed-header', message: (err as Error).message };
        }
      }
    } else {
      raw = Buffer.from(token);
    }

    if (raw.length !== TOKEN_BYTES) {
      return {
        ok: false,
        reason: 'bad-length',
        message: `tunex-auth: token must be ${TOKEN_BYTES} bytes, got ${raw.length}`,
      };
    }

    const authKey = resolveAuthKey(opts);

    const nonce = raw.subarray(OFFSETS.nonce, OFFSETS.nonce + 16);
    const tsBuf = raw.subarray(OFFSETS.timestamp, OFFSETS.timestamp + 8);
    const tsNanos = tsBuf.readBigInt64BE();
    const macGiven = raw.subarray(OFFSETS.mac, OFFSETS.mac + 32);

    const expectedMac = createHmac('sha256', authKey)
      .update(Buffer.concat([nonce, tsBuf]))
      .digest();

    const window = opts.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
    const nowNanos = opts.nowNanos ?? currentUnixNanos();
    const windowNanos = BigInt(Math.round(window)) * NANOS_PER_SECOND;
    const delta = tsNanos - nowNanos;
    const absDelta = delta < 0n ? -delta : delta;
    const outsideWindow = absDelta > windowNanos;

    // 恒定时间：先算完 mac 比较再统一决定失败原因，避免早期返回的时序差
    const macOk = macEqual(expectedMac, macGiven);

    if (!macOk) {
      return { ok: false, reason: 'bad-mac', message: 'tunex-auth: token MAC mismatch' };
    }
    if (outsideWindow) {
      return {
        ok: false,
        reason: 'outside-window',
        message:
          `tunex-auth: token outside ±${window}s window ` +
          `(skew ${Number(delta) / 1e9}s)`,
      };
    }

    if (opts.replay) {
      const fresh = opts.replay.checkAndRemember(Buffer.from(nonce), tsNanos, nowNanos);
      if (!fresh) {
        return { ok: false, reason: 'replay', message: 'tunex-auth: token replay' };
      }
    }

    return {
      ok: true,
      token: raw,
      timestampNanos: tsNanos,
      skewSeconds: Number(delta) / 1e9,
      reuse: tokenReuseFlag(raw),
      nonce: Buffer.from(nonce),
    };
  } catch (err) {
    return { ok: false, reason: 'bad-length', message: String((err as Error)?.message ?? err) };
  }
}

/**
 * 一体化入口：解析 `Authorization` 头 → 校验 → （可选）重放检查。
 * 这是 listener `serveHTTP` 里 `validateToken(auth)` 的对应实现。
 */
export function authenticateTunexRequest(
  authorizationHeader: string | null | undefined,
  opts: VerifyTokenOptions,
): VerifyResult {
  return verifyTunexToken(authorizationHeader ?? '', opts);
}

/** 便捷：只问"这个 token 现在是否有效"（不关心失败原因）。 */
export function isTunexTokenValid(
  token: string | Uint8Array,
  opts: VerifyTokenOptions,
): boolean {
  return verifyTunexToken(token, opts).ok;
}
