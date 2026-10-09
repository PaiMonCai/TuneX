import { isIP } from "node:net";
import { z } from "zod";
import { parseCanonicalIPv4, formatIPv4, parseIPv6, formatIPv6 } from "../../ip-address.ts";

/** Strict literal CIDRs, masked before storage/digests. Never resolve DNS or
 * unmap IPv6: doing either would silently change the trusted address family.
 * IPv4-mapped IPv6 literals are rejected, matching the runner trust contract. */
export function canonicalTrustedCIDR(value: string): string | null {
  const parts = value.split("/");
  if (parts.length !== 2 || !/^[1-9][0-9]*$/.test(parts[1]!)) return null;
  const [address, prefixText] = parts as [string, string];
  if (address.includes("%")) return null;
  const family = isIP(address), prefix = Number(prefixText);
  if (!family || prefixText !== String(prefix) || prefix > (family === 4 ? 32 : 128)) return null;
  if (family === 4) {
    const parsed = parseCanonicalIPv4(address);
    if (parsed === null) return null;
    const size = 2 ** (32 - prefix);
    return formatIPv4(parsed - parsed % size) + "/" + prefix;
  }
  const bytes = parseIPv6(address);
  if (!bytes || bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return null;
  for (let i = 0; i < bytes.length; i++) {
    const bits = Math.min(8, Math.max(0, prefix - i * 8));
    bytes[i] = bytes[i]! & (256 - 2 ** (8 - bits));
  }
  return formatIPv6(bytes) + "/" + prefix;
}
const trustedCIDR = z.string().min(3).max(64).transform((value, ctx) => {
  const network = canonicalTrustedCIDR(value);
  if (network === null) {
    ctx.addIssue({ code: "custom", message: "invalid_trusted_cidr" });
    return z.NEVER;
  }
  return network;
});
export const LinkClientSourceSchema = z.object({
  version: z.literal(1),
  receive_proxy: z.boolean(),
  trusted_cidrs: z.array(trustedCIDR).max(32),
  send_proxy: z.enum(["off", "v1", "v2"]),
}).strict().superRefine((source, ctx) => {
  const seen = new Set<string>();
  source.trusted_cidrs.forEach((network, index) => {
    if (seen.has(network)) ctx.addIssue({ code: "custom", path: ["trusted_cidrs", index], message: "duplicate_trusted_cidr" });
    seen.add(network);
  });
  if (source.receive_proxy !== (source.trusted_cidrs.length > 0))
    ctx.addIssue({ code: "custom", path: ["trusted_cidrs"], message: "client_source_trust_required" });
});
export type LinkClientSource = z.infer<typeof LinkClientSourceSchema>;
export function persistedLinkClientSource(raw: unknown): LinkClientSource | undefined {
  return raw == null ? undefined : LinkClientSourceSchema.parse(raw);
}

/** Shared API/compiler combination gate, including explicit disabled configs. */
export function validateLinkClientSourceBinding(binding: {
  protocol: string;
  client_source?: LinkClientSource;
  target_set?: { strategy: string };
}, ctx: z.RefinementCtx): void {
  if ((binding.client_source || binding.target_set?.strategy === "ip_hash") && binding.protocol !== "tcp")
    ctx.addIssue({ code: "custom", path: ["protocol"], message: "link_client_source_tcp_only" });
  if (binding.target_set?.strategy === "ip_hash" && !binding.client_source)
    ctx.addIssue({ code: "custom", path: ["client_source"], message: "link_client_source_required" });
}
