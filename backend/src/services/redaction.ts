/**
 * WP11C —— 诊断/Support Bundle 的脱敏（纯函数）。
 *
 * 这份逻辑存在的唯一理由是：**诊断产物会离开控制面**（下载、贴进工单、发邮件）。
 * 一旦漏掉一处凭据，泄漏就是永久且不可撤回的。因此这里的原则是「宁可多删」：
 *
 *   · 先按**键名**删（token / password / secret / credential / cookie / authorization…），
 *     键名匹配不区分大小写、也匹配 snake_case / kebab-case / camelCase；
 *   · 再按**值形状**删（PEM 私钥块、Bearer/JWT、长 base64/hex 串、URL 内嵌凭据）；
 *   · 多层结构递归处理，数组、嵌套对象、字符串化的 JSON（日志行里常见）都覆盖；
 *   · 结果带**截断与条数上限**，避免"脱敏产物"本身变成一条新的泄漏面（超大载荷）。
 *
 * 与"只信任采集白名单"的关系：白名单决定**取什么**，脱敏决定**写出去长什么样**。
 * 两者都要有——白名单会随功能扩张而放松，脱敏是最后一道确定性防线。
 */

/** 命中即整值替换的键名（小写、去掉分隔符后比较）。 */
const SECRET_KEY_PATTERNS: readonly string[] = [
  "token",
  "accesstoken",
  "refreshtoken",
  "enrollmenttoken",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "apikey",
  "apisecret",
  "authorization",
  "auth",
  "cookie",
  "setcookie",
  "session",
  "sessionid",
  "credential",
  "nodecredential",
  "privatekey",
  "signature",
  "passphrase",
  "bearer",
  "smtp pass",
  "smtppass",
  "databaseurl",
  "redisurl",
  "dsn",
];

/** 混合字符类才像不透明令牌；单字符类的长串（长单词、长路径）不是。 */
function looksLikeOpaqueToken(match: string): boolean {
  return /[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match);
}

/** 值的形状命中即整体替换（与键名无关）。 */
const VALUE_PATTERNS: readonly { name: string; re: RegExp; classify?: (match: string) => boolean }[] = [
  { name: "pem_private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { name: "basic_auth", re: /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  { name: "url_credentials", re: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/g },
  { name: "long_hex", re: /\b[0-9a-fA-F]{32,}\b/g },
  // Requiring mixed character classes is what keeps this from eating ordinary
  // diagnostic text: a 40-character lowercase word, a long path or a hex-less
  // identifier is not a credential, and over-redacting them makes the bundle
  // useless for the operator it is written for.
  //
  // The class check runs in `classify` rather than as lookaheads: lookaheads
  // anchored on `[^\s]*` rescan the rest of the string at every position, which
  // turned a 4KB value into milliseconds and a bundle into seconds.
  { name: "long_base64_like", re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, classify: looksLikeOpaqueToken },
];

export const REDACTED = "[REDACTED]";

/** 单个字符串值的长度上限（脱敏后的产物不该比诊断事实还长）。 */
export const REDACTED_STRING_MAX = 1000;
/** 正则阶段处理的输入上限；超出部分本来也会被截断。 */
const PATTERN_INPUT_MAX = REDACTED_STRING_MAX * 8;
/** 单次脱敏最多处理多少个键/元素，防止病态结构打爆 CPU。 */
export const REDACT_ITEM_LIMIT = 200;
/** 递归深度上限。 */
export const REDACT_DEPTH_LIMIT = 6;

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 键名是否属于「整值都是秘密」。 */
export function isSecretKey(key: string): boolean {
  const k = normalizedKey(key);
  if (k === "") return false;
  return SECRET_KEY_PATTERNS.some((pattern) => {
    const p = normalizedKey(pattern);
    // 前缀匹配：`node_credential_hash`、`x-auth-token` 这类派生键同样要命中。
    return k === p || k.startsWith(p) || k.endsWith(p) || k.includes(p);
  });
}

/**
 * `key: value` / `key=value` pairs inside free text.
 *
 * Diagnostic text is full of them (`token=CANARY`, `"node_credential":"cred-x"`),
 * and a secret under a telling key must be removed even when the string is not
 * parseable JSON as a whole.
 */
const TEXT_KEY_VALUE_RE = /(["']?)([A-Za-z0-9_.-]{2,64})\1\s*[:=]\s*(["']?)([^\s"',;}\]]{4,})\3/g;

/** 对一段文本做形状脱敏（键名无关 + 键值对）。 */
export function redactText(value: string): string {
  // Bound the input before any pattern runs. Everything past the output cap is
  // going to be truncated anyway, and letting a 1MB value reach the regexes is
  // how a diagnostic artefact becomes a CPU amplifier.
  let out = value.length > PATTERN_INPUT_MAX ? value.slice(0, PATTERN_INPUT_MAX) : value;
  // Shape rules run FIRST. `Authorization: Bearer <token>` is the reason: a
  // key/value rule applied first would consume the `Bearer` marker and leave the
  // token itself untouched — a leak that looks redacted.
  for (const { name, re, classify } of VALUE_PATTERNS) {
    out = out.replace(re, (match, ...groups) => {
      if (classify && !classify(match)) return match;
      // Preserve a scheme prefix (e.g. `mysql://`) so the reader still knows
      // what kind of endpoint this was, without the credentials.
      if (name === "url_credentials" && typeof groups[0] === "string") {
        return `${groups[0]}${REDACTED}@`;
      }
      return REDACTED;
    });
  }
  // Key/value pairs last, and never over an endpoint: `dsn=mysql://…` must keep
  // its scheme so the reader still knows what kind of endpoint failed. With the
  // shape pass already done, the credentials inside it are gone by now.
  out = out.replace(TEXT_KEY_VALUE_RE, (match, quote, key, _valueQuote, captured) =>
    isSecretKey(String(key)) && !String(captured).includes("://")
      ? `${quote}${key}${quote}: ${REDACTED}`
      : match);
  return truncate(out);
}

function truncate(out: string): string {
  if (out.length > REDACTED_STRING_MAX) {
    return `${out.slice(0, REDACTED_STRING_MAX)}…[truncated]`;
  }
  return out;
}

/**
 * 递归脱敏任意结构。
 *
 * 字符串值会先尝试按 JSON 解析一次：日志/诊断产物里经常出现"字符串里塞了一段
 * JSON"，只按纯文本替换会漏掉其中的键值对。
 */
/**
 * Values the caller KNOWS are secret (the node credential, the auth secret, a
 * session token it just minted). Exact-match removal is the only rule that can
 * catch an opaque string: no pattern can tell a canary from legitimate data, and
 * pretending otherwise is how a "redacted" bundle leaks.
 */
export interface RedactOptions {
  knownSecrets?: readonly string[];
}

function scrubKnownSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4 && out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

export function redact(value: unknown, depth = 0, options: RedactOptions = {}): unknown {
  if (depth > REDACT_DEPTH_LIMIT) return "[TRUNCATED:depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactStringValue(value, options, depth);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, REDACT_ITEM_LIMIT).map((item) => redact(item, depth + 1, options));
    if (value.length > REDACT_ITEM_LIMIT) items.push(`[TRUNCATED:items>${REDACT_ITEM_LIMIT}]`);
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, REDACT_ITEM_LIMIT)) {
      const safeFlag = (key === "has_credential" || key === "credential_revoked") && typeof entry === "boolean";
      out[key] = safeFlag ? entry : isSecretKey(key) ? REDACTED : redact(entry, depth + 1, options);
    }
    if (entries.length > REDACT_ITEM_LIMIT) out["_truncated"] = `keys>${REDACT_ITEM_LIMIT}`;
    return out;
  }
  // Functions / symbols never belong in a diagnostic payload.
  return "[UNSERIALIZABLE]";
}

function redactStringValue(value: string, options: RedactOptions = {}, depth = 0): string {
  value = scrubKnownSecrets(value, options.knownSecrets ?? []);
  const trimmed = value.trim();
  // Only attempt JSON parsing on something that clearly looks like a structure:
  // parsing every string would rewrite ordinary text (e.g. "123").
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        return JSON.stringify(redact(parsed, depth + 1, options));
      }
    } catch {
      // Not JSON after all: fall through to text-level redaction.
    }
  }
  return redactText(value);
}

/** 脱敏后的 JSON 文本（导出 Support Bundle 时用同一份逻辑，避免两条路径漂移）。 */
export function redactToJson(value: unknown, pretty = true, options: RedactOptions = {}): string {
  return JSON.stringify(redact(value, 0, options), null, pretty ? 2 : 0);
}
