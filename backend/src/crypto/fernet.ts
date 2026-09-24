/**
 * TuneX — Fernet 实现（AES-128-CBC + HMAC-SHA256）
 *
 * 零外部依赖：只用 node:crypto（也可被 Bun / Node 22+ 直接运行）。
 *
 * ── 线格式（与 Python `cryptography.fernet.Fernet` 逐字节互操作，已实测）──
 *
 *   token = base64url( BASIC || MAC )
 *   BASIC = 0x80 || timestamp_8B_大端 || iv_16B || AES-128-CBC-PKCS7(明文)
 *   MAC   = HMAC-SHA256(signing_key, BASIC)            // 32 字节
 *
 *   密钥（Fernet key，44 字符 base64url，含 `=` 填充）解码后 32 字节：
 *     signing_key    = key[0:16]    // HMAC-SHA256 签名密钥
 *     encryption_key = key[16:32]   // AES-128-CBC 加密密钥
 *
 * ── 与 Python 参考实现的三个必须对齐的细节（易踩坑）──
 *
 * 1. **base64 输出带 `=` 填充**。Python 用的是 `base64.urlsafe_b64encode`，
 *    它**保留填充**。所以标准 Fernet token 以 `gAAAAA...` 开头且以 `=` / `==` 结尾。
 *    编码时保留填充（与参考实现字节一致）；解码时宽容（有无填充、`-_` 或 `+/` 都接受）。
 * 2. **AES 侧不交给 node 自动去填充**。本库显式 `setAutoPadding(false)` + 手动 PKCS7，
 *    以便对填充错误给出确定性错误而非 OpenSSL 的模糊报错。
 * 3. **PKCS7 是块级全填充**：明文长度为 16 的整数倍时**追加一整块** 0x10（不是零填充）。
 *
 * 时间戳语义与 Python 一致：无符号 8 字节大端；`ttl` 判定为
 * `now > timestamp + ttl` 时过期（对齐 Python `_decrypt_data`）。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Fernet 版本字节。 */
export const FERNET_VERSION = 0x80;
/** AES-128 块长度 / IV 长度。 */
export const FERNET_BLOCK_SIZE = 16;
/** signing key 长度（HMAC-SHA256 密钥）。 */
export const FERNET_SIGNING_KEY_BYTES = 16;
/** encryption key 长度（AES-128）。 */
export const FERNET_ENCRYPTION_KEY_BYTES = 16;
/** Fernet key 解码后的总长度。 */
export const FERNET_KEY_BYTES = 32;
/** 最小合法 token 原始字节数：version(1) + ts(8) + iv(16) + 一个密文块(16) + mac(32)。 */
export const FERNET_MIN_TOKEN_BYTES = 1 + 8 + 16 + 16 + 32; // 73

const B64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64 字符 → 6 bit 值。同时接受标准字母表的 `+` / `/`（RFC 4648 §5 双向宽容）。 */
const B64_LOOKUP: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i++) t[B64URL_ALPHABET.charCodeAt(i)] = i;
  t['+'.charCodeAt(0)] = 62;
  t['/'.charCodeAt(0)] = 63;
  return t;
})();

/**
 * Fernet 解密失败 / token 非法的统一错误。
 * 所有失败路径都抛这个类型，便于调用方 `instanceof` 判定。
 */
export class InvalidToken extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid-token') {
    super(message);
    this.name = 'InvalidToken';
    this.code = code;
  }
}

/** base64url 编码。`padded=true`（默认）与 Python `urlsafe_b64encode` 字节一致。 */
export function base64UrlEncode(data: Uint8Array, padded = true): string {
  let out = '';
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const full = buf.length - (buf.length % 3);
  for (let i = 0; i < full; i += 3) {
    const n = (buf[i]! << 16) | (buf[i + 1]! << 8) | buf[i + 2]!;
    out +=
      B64URL_ALPHABET[(n >>> 18) & 0x3f]! +
      B64URL_ALPHABET[(n >>> 12) & 0x3f]! +
      B64URL_ALPHABET[(n >>> 6) & 0x3f]! +
      B64URL_ALPHABET[n & 0x3f]!;
  }
  const rem = buf.length - full;
  if (rem === 1) {
    const n = buf[full]! << 16;
    out += B64URL_ALPHABET[(n >>> 18) & 0x3f]! + B64URL_ALPHABET[(n >>> 12) & 0x3f]!;
    if (padded) out += '==';
  } else if (rem === 2) {
    const n = (buf[full]! << 16) | (buf[full + 1]! << 8);
    out +=
      B64URL_ALPHABET[(n >>> 18) & 0x3f]! +
      B64URL_ALPHABET[(n >>> 12) & 0x3f]! +
      B64URL_ALPHABET[(n >>> 6) & 0x3f]!;
    if (padded) out += '=';
  }
  return out;
}

/**
 * base64url 解码（宽容模式）：
 *  - 填充可选：`abc=` 与 `abc` 都接受
 *  - 字母表混用可接受：`-`/`_` 与 `+`/`/` 都接受
 *    （**必须**支持 `/`：真实下发的 config 密钥 `KV/JjKrj8...` 里就有 `/`）
 *  - 非法字符 / 非法填充位置 / `len % 4 === 1` → 抛 InvalidToken
 */
export function base64UrlDecode(input: string | Uint8Array): Buffer {
  let s: string;
  if (typeof input === 'string') {
    s = input;
  } else {
    s = Buffer.from(input).toString('latin1');
  }
  s = s.trim();

  const eq = s.indexOf('=');
  let body = s;
  let pad = 0;
  if (eq !== -1) {
    body = s.slice(0, eq);
    pad = s.length - eq;
    if (pad > 2) throw new InvalidToken(`base64: too much padding (${pad})`, 'bad-base64');
    if (s.slice(eq) !== '='.repeat(pad)) {
      throw new InvalidToken('base64: padding must be trailing only', 'bad-base64');
    }
    // 带填充时，长度必须是 4 的倍数且与实际数据长度自洽。
    if (s.length % 4 !== 0) {
      throw new InvalidToken('base64: padded length must be a multiple of 4', 'bad-base64');
    }
    if (pad === 2 && body.length % 4 !== 2) {
      throw new InvalidToken('base64: invalid `==` padding', 'bad-base64');
    }
    if (pad === 1 && body.length % 4 !== 3) {
      throw new InvalidToken('base64: invalid `=` padding', 'bad-base64');
    }
  }

  if (body.length % 4 === 1) {
    throw new InvalidToken('base64: invalid length', 'bad-base64');
  }

  const out = Buffer.allocUnsafe(Math.floor((body.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    const v = c < 128 ? B64_LOOKUP[c]! : -1;
    if (v < 0) {
      throw new InvalidToken(
        `base64: invalid character ${JSON.stringify(body[i])} at ${i}`,
        'bad-base64',
      );
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** PKCS7 填充（块级全填充：整块时追加 16 个 0x10）。 */
export function pkcs7Pad(data: Uint8Array, blockSize = FERNET_BLOCK_SIZE): Buffer {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const padLen = blockSize - (buf.length % blockSize);
  const out = Buffer.alloc(buf.length + padLen, padLen);
  buf.copy(out, 0);
  return out;
}

/** PKCS7 去填充。填充字节必须全部等于 padLen，否则抛 InvalidToken。 */
export function pkcs7Unpad(data: Uint8Array, blockSize = FERNET_BLOCK_SIZE): Buffer {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length === 0 || buf.length % blockSize !== 0) {
    throw new InvalidToken('pkcs7: data is not a whole number of blocks', 'bad-padding');
  }
  const padLen = buf[buf.length - 1]!;
  if (padLen === 0 || padLen > blockSize || padLen > buf.length) {
    throw new InvalidToken('pkcs7: invalid padding length', 'bad-padding');
  }
  // 恒定时间风格：不提前 return，避免通过时序区分"填错在第几位"。
  let bad = 0;
  for (let i = 0; i < padLen; i++) bad |= buf[buf.length - 1 - i]! ^ padLen;
  if (bad !== 0) throw new InvalidToken('pkcs7: corrupted padding bytes', 'bad-padding');
  return buf.subarray(0, buf.length - padLen);
}

/** 解析 Fernet key：接受 32 字节原始值或 44 字符 base64url 字符串。 */
export function parseFernetKey(key: string | Uint8Array): Buffer {
  let raw: Buffer;
  if (typeof key === 'string') {
    const trimmed = key.trim();
    if (trimmed.length === 0) throw new InvalidToken('fernet key: empty', 'bad-key');
    raw = base64UrlDecode(trimmed);
  } else {
    raw = Buffer.from(key);
  }
  if (raw.length !== FERNET_KEY_BYTES) {
    throw new InvalidToken(
      `fernet key: expected ${FERNET_KEY_BYTES} bytes after base64url decode, got ${raw.length}`,
      'bad-key',
    );
  }
  return raw;
}

export interface FernetEncryptOptions {
  /** 覆盖 token 时间戳（Unix 秒）。仅供确定性测试使用。 */
  now?: number;
  /** 覆盖 IV（16 字节）。仅供确定性测试使用 —— 复用 IV 会致命地削弱安全性。 */
  iv?: Uint8Array;
}

export interface FernetDecryptOptions {
  /** 可选的 TTL（秒）。超过该年龄的 token 视为过期并抛 InvalidToken。 */
  ttl?: number | null;
  /** 覆盖"当前时间"（Unix 秒）。仅供确定性测试使用。 */
  now?: number;
}

/**
 * 标准 Fernet。与 Python `cryptography.fernet.Fernet` 双向互操作。
 *
 * ```ts
 * const f = new Fernet(key);           // key = 44 字符 base64url 或 32 字节
 * const token = f.encrypt('hello');    // base64url 字符串
 * const buf   = f.decrypt(token);      // Buffer
 * const text  = f.decryptToString(token);
 * ```
 */
export class Fernet {
  readonly signingKey: Buffer;
  readonly encryptionKey: Buffer;

  constructor(key: string | Uint8Array) {
    const raw = parseFernetKey(key);
    this.signingKey = raw.subarray(0, FERNET_SIGNING_KEY_BYTES);
    this.encryptionKey = raw.subarray(FERNET_SIGNING_KEY_BYTES, FERNET_KEY_BYTES);
  }

  /** 生成一个新的随机 Fernet key（base64url 字符串，含填充）。 */
  static generateKey(): string {
    return base64UrlEncode(randomBytes(FERNET_KEY_BYTES));
  }

  /** 该 token 是否可被本密钥验证（只验 HMAC，不解密、不判 TTL）。 */
  static isValidToken(token: string | Uint8Array, key: string | Uint8Array): boolean {
    try {
      new Fernet(key).verify(token);
      return true;
    } catch {
      return false;
    }
  }

  /** 加密。返回 base64url token（含 `=` 填充，与 Python 输出格式一致）。 */
  encrypt(plaintext: string | Uint8Array, opts: FernetEncryptOptions = {}): string {
    const pt = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
    const ts = opts.now ?? currentUnixSeconds();
    if (!Number.isInteger(ts) || ts < 0 || ts > 0xffffffffffffffff) {
      throw new InvalidToken(`fernet: bad timestamp ${ts}`, 'bad-timestamp');
    }
    const iv = opts.iv ? Buffer.from(opts.iv) : randomBytes(FERNET_BLOCK_SIZE);
    if (iv.length !== FERNET_BLOCK_SIZE) {
      throw new InvalidToken(`fernet: iv must be ${FERNET_BLOCK_SIZE} bytes`, 'bad-iv');
    }

    const tsBuf = Buffer.alloc(8);
    tsBuf.writeBigUInt64BE(BigInt(ts));

    const cipher = createCipheriv('aes-128-cbc', this.encryptionKey, iv);
    cipher.setAutoPadding(false); // 手动 PKCS7，见文件头说明
    const ciphertext = Buffer.concat([cipher.update(pkcs7Pad(pt)), cipher.final()]);

    const basic = Buffer.concat([Buffer.from([FERNET_VERSION]), tsBuf, iv, ciphertext]);
    const mac = createHmac('sha256', this.signingKey).update(basic).digest();
    return base64UrlEncode(Buffer.concat([basic, mac]));
  }

  /**
   * 只验证 HMAC（不 AES 解密）。用于廉价地判断"这个 token 是不是我签的"。
   * 返回 `{ timestamp }`（Unix 秒）。失败抛 InvalidToken。
   */
  verify(token: string | Uint8Array): { timestamp: number; iv: Buffer; ciphertext: Buffer } {
    const data = decodeTokenBytes(token);
    if (data.length < FERNET_MIN_TOKEN_BYTES) {
      throw new InvalidToken(
        `fernet: token too short (${data.length} < ${FERNET_MIN_TOKEN_BYTES})`,
        'too-short',
      );
    }
    const expected = createHmac('sha256', this.signingKey).update(data.subarray(0, -32)).digest();
    const actual = data.subarray(-32);
    if (!constantTimeEqual(expected, actual)) {
      throw new InvalidToken('fernet: HMAC verification failed', 'bad-mac');
    }
    const timestamp = Number(data.subarray(1, 9).readBigUInt64BE());
    return {
      timestamp,
      iv: data.subarray(9, 25),
      ciphertext: data.subarray(25, data.length - 32),
    };
  }

  /** 解密。失败（HMAC 不对 / 填充坏 / TTL 过期）一律抛 InvalidToken。 */
  decrypt(token: string | Uint8Array, opts: FernetDecryptOptions = {}): Buffer {
    const { timestamp, iv, ciphertext } = this.verify(token);
    const now = opts.now ?? currentUnixSeconds();
    const ttl = opts.ttl ?? null;
    if (ttl !== null) {
      if (!Number.isFinite(ttl) || ttl < 0) {
        throw new InvalidToken(`fernet: bad ttl ${ttl}`, 'bad-ttl');
      }
      // 对齐 Python：`timestamp + ttl < time.time()` → 过期
      if (timestamp + ttl < now) {
        throw new InvalidToken('fernet: token expired (ttl exceeded)', 'expired');
      }
    }
    let padded: Buffer;
    try {
      const decipher = createDecipheriv('aes-128-cbc', this.encryptionKey, iv);
      decipher.setAutoPadding(false);
      padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new InvalidToken('fernet: AES-CBC decryption failed', 'bad-ciphertext');
    }
    return pkcs7Unpad(padded);
  }

  /** 解密为 UTF-8 字符串。 */
  decryptToString(token: string | Uint8Array, opts: FernetDecryptOptions = {}): string {
    return this.decrypt(token, opts).toString('utf8');
  }

  /** 读取 token 内嵌的签发时间戳（Unix 秒），**不做** HMAC 校验。 */
  static tokenTimestamp(token: string | Uint8Array): number {
    const data = decodeTokenBytes(token);
    if (data.length < 9) throw new InvalidToken('fernet: token too short', 'too-short');
    if (data[0] !== FERNET_VERSION) {
      throw new InvalidToken(`fernet: bad version byte 0x${data[0]!.toString(16)}`, 'bad-version');
    }
    return Number(data.subarray(1, 9).readBigUInt64BE());
  }
}

/** 读取 token 内嵌签发时间戳（不校验 HMAC）。等价于 `Fernet.tokenTimestamp`。 */
export function fernetTokenTimestamp(token: string | Uint8Array): number {
  return Fernet.tokenTimestamp(token);
}

/** 解密 token 的原始字节，并做版本字节校验（对齐 Python `_get_unverified_token_data`）。 */
function decodeTokenBytes(token: string | Uint8Array): Buffer {
  let data: Buffer;
  if (typeof token === 'string') {
    data = base64UrlDecode(token);
  } else if (Buffer.isBuffer(token)) {
    data = token;
  } else {
    data = Buffer.from(token);
  }
  if (data.length === 0) throw new InvalidToken('fernet: empty token', 'empty');
  if (data[0] !== FERNET_VERSION) {
    throw new InvalidToken(
      `fernet: bad version byte 0x${data[0]!.toString(16)} (expected 0x80)`,
      'bad-version',
    );
  }
  return data;
}

/** 恒定时间比较（先比长度，长度不同直接 false —— 长度本身不是秘密）。 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(
    Buffer.isBuffer(a) ? a : Buffer.from(a),
    Buffer.isBuffer(b) ? b : Buffer.from(b),
  );
}

/** 当前 Unix 秒。 */
export function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
