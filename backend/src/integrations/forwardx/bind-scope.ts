import { isIP } from "node:net";

export type LeaseProtocol = "tcp" | "udp" | "unknown";

/** Unknown facts reserve both socket namespaces; defaults belong to the API. */
export function leaseProtocol(value: unknown): LeaseProtocol {
  if (typeof value !== "string") return "unknown";
  switch (value.trim().toLowerCase()) {
    case "tcp": case "tls": case "ws": return "tcp";
    case "udp": return "udp";
    default: return "unknown";
  }
}

export function protocolsOverlap(a: unknown, b: unknown): boolean {
  const left = leaseProtocol(a), right = leaseProtocol(b);
  return left === "unknown" || right === "unknown" || left === right;
}

/** Canonical scope keys. Generic IPv4/IPv6 wildcard listeners may be dual stack. */
export function normalizeBindScope(value: unknown): string {
  if (typeof value !== "string") return "*";
  let host = value.trim();
  if (host.length > 2 && host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "" || host === "*" || host === "0.0.0.0") return "*";
  const zoneAt = host.indexOf("%");
  const address = zoneAt < 0 ? host : host.slice(0, zoneAt);
  const zone = zoneAt < 0 ? "" : host.slice(zoneAt);
  if (isIP(address) === 6) {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    if (canonical === "::") return "*";
    const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
    if (mapped) {
      const hi = parseInt(mapped[1]!, 16), lo = parseInt(mapped[2]!, 16);
      return normalizeBindScope(`${hi >>> 8}.${hi & 255}.${lo >>> 8}.${lo & 255}`);
    }
    return canonical + zone;
  }
  // Keep DNS's root dot and unknown hosts; do not resolve or widen them silently.
  return host.toLowerCase();
}

export function bindScopesOverlap(a: unknown, b: unknown): boolean {
  const left = normalizeBindScope(a), right = normalizeBindScope(b);
  if (left === "*" || right === "*") return true;
  const leftIP = left.split("%", 1)[0]!, rightIP = right.split("%", 1)[0]!;
  if (!isIP(leftIP) || !isIP(rightIP)) return true;
  return leftIP === rightIP;
}
