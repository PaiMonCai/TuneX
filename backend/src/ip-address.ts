/**
 * 规范 IPv4 字面量的唯一写法：四段十进制、无前导零。
 *
 * 前导零是**写法变体**的核心：`0177.0.0.1` 在有的解析器里是八进制（=127.0.0.1），
 * 在另一些里直接报错。我们不做那种解释，直接判成"非规范地址写法"并拒绝。
 * `2130706433` / `0x7f000001` / `127.1` 同理（见 `looksLikeAddressLiteralVariant`）。
 */
export function parseCanonicalIPv4(text: string): number | null {
  const match = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(text);
  if (!match) return null;
  let value = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

export function formatIPv4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;

/**
 * 严格 IPv6 解析（RFC 4291 文本形式），产出 16 字节。
 *
 * 为什么自己写而不是用平台 API：**分类必须在字节上做**（私网判断、映射形式、前缀匹配），
 * 而各平台 API 对"哪个字符串算合法"的宽容度不同（是否接受 zone id、是否接受 `<v4>`
 * 尾段、是否折叠 `::`）。这里只要一种解释，并且有与 Go `netip` 共享的测试向量。
 *
 * 拒绝：zone id（`%eth0`）、多个 `::`、组数不为 8（无 `::` 时）、组数 ≥8（有 `::` 时）、
 * 空组（非 `::` 位置）、非十六进制字符、尾部 IPv4 段非规范 IPv4。
 */
export function parseIPv6(text: string): Uint8Array | null {
  const raw = text.trim();
  if (raw === "" || raw.length > 45) return null;
  if (raw.includes("%")) return null; // zone id：绝不拨带 zone 的地址
  if (!raw.includes(":")) return null;
  const marker = raw.indexOf("::");
  if (marker !== -1 && raw.indexOf("::", marker + 1) !== -1) return null;

  const head = marker === -1 ? raw : raw.slice(0, marker);
  const tail = marker === -1 ? "" : raw.slice(marker + 2);
  const headBytes = parseIPv6Groups(head === "" ? [] : head.split(":"), false);
  const tailBytes = parseIPv6Groups(tail === "" ? [] : tail.split(":"), true);
  if (headBytes === null || tailBytes === null) return null;
  const total = headBytes.length + tailBytes.length;
  if (marker === -1) {
    if (total !== 16) return null;
  } else if (total >= 16) {
    // `::` 至少要代表一个 16 位组；`1:2:3:4:5:6:7:8::` 这种是非法的。
    return null;
  }
  const bytes = new Uint8Array(16);
  bytes.set(headBytes, 0);
  bytes.set(tailBytes, 16 - tailBytes.length);
  return bytes;
}

function parseIPv6Groups(groups: string[], allowIPv4Tail: boolean): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    if (group === "") return null;
    if (allowIPv4Tail && i === groups.length - 1 && group.includes(".")) {
      const embedded = parseCanonicalIPv4(group);
      if (embedded === null) return null;
      out.push((embedded >>> 24) & 0xff, (embedded >>> 16) & 0xff, (embedded >>> 8) & 0xff, embedded & 0xff);
      continue;
    }
    if (!IPV6_GROUP.test(group)) return null;
    const value = Number.parseInt(group, 16);
    out.push((value >> 8) & 0xff, value & 0xff);
  }
  return out;
}

/** 小写、无前导零、压缩最长零段的规范文本（可被 `netip.ParseAddr` 逐字接受）。 */
export function formatIPv6(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new TypeError("IPv6 必须是 16 字节");
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);

  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= groups.length; i += 1) {
    if (i < groups.length && groups[i] === 0) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      const len = i - runStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(":");
  const left = groups.slice(0, bestStart).map((g) => g.toString(16)).join(":");
  const right = groups.slice(bestStart + bestLen).map((g) => g.toString(16)).join(":");
  return `${left}::${right}`;
}
