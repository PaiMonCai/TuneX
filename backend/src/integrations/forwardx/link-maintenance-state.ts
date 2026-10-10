import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalConfigDigest } from "./core-contract.ts";
import { LinkMaintenancePreviewSchema, LINK_MAINTENANCE_PREVIEW_MS } from "./link-maintenance.ts";
import { LinkResourceError } from "../../services/link-errors.ts";

export const LINK_MAINTENANCE_HOLD_MS = 300_000;
export const LINK_MAINTENANCE_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MaintenanceStatusSchema = z.enum(["awaiting_executor", "cancelled", "invalidated", "expired"]);
export type MaintenanceStatus = z.infer<typeof MaintenanceStatusSchema>;
export const LinkMaintenanceCommitSchema = LinkMaintenancePreviewSchema.extend({
  idempotency_key: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  receipt: z.string().min(1).max(2048),
}).strict();
export const LinkMaintenanceCancelSchema = z.object({ expected_state_version: z.number().int().positive().max(2_147_483_646) }).strict();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const ReceiptClaimsSchema = z.object({ version: z.literal(1), workspace_id: z.number().int().positive(),
  link_id: z.number().int().positive(), state_token: hash, request_digest: hash,
  issued_at: z.number().int().nonnegative().safe(), expires_at: z.number().int().nonnegative().safe() }).strict();
type ReceiptBinding = Pick<z.infer<typeof ReceiptClaimsSchema>, "workspace_id" | "link_id" | "state_token" | "request_digest">;

export function maintenanceRequestDigest(input: unknown): string {
  return canonicalConfigDigest(LinkMaintenancePreviewSchema.parse(input));
}
function receiptMac(body: string, secret: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new LinkResourceError("link_seal_key_required", 503);
  // Separate purpose from transport-key sealing. This attests freshness, never authorization.
  return createHmac("sha256", Buffer.from(secret, "hex")).update("tunex:link-maintenance:receipt:v1:" + body).digest();
}
export function signMaintenanceReceipt(binding: ReceiptBinding, secret: string, now: Date): string {
  const claims = ReceiptClaimsSchema.parse({ version: 1, ...binding, issued_at: now.getTime(),
    expires_at: now.getTime() + LINK_MAINTENANCE_PREVIEW_MS });
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return "lm1." + body + "." + receiptMac(body, secret).toString("hex");
}
export function verifyMaintenanceReceipt(receipt: string, binding: ReceiptBinding, secret: string, now: Date) {
  const invalid = () => new LinkResourceError("link_maintenance_preview_invalid");
  if (receipt.length > 2048 || !/^lm1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(receipt)) throw invalid();
  const [, body, signature] = receipt.split(".");
  if (!timingSafeEqual(receiptMac(body!, secret), Buffer.from(signature!, "hex"))) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")); } catch { throw invalid(); }
  const result = ReceiptClaimsSchema.safeParse(parsed);
  if (!result.success) throw invalid();
  const claims = result.data;
  if (Object.entries(binding).some(([key, value]) => claims[key as keyof typeof claims] !== value)
    || claims.expires_at - claims.issued_at !== LINK_MAINTENANCE_PREVIEW_MS || claims.issued_at > now.getTime() + 5_000) throw invalid();
  if (claims.expires_at <= now.getTime()) throw new LinkResourceError("link_maintenance_preview_expired");
  return claims;
}
export function maintenanceTransition(status: MaintenanceStatus, version: number, expected: number,
  next: Exclude<MaintenanceStatus, "awaiting_executor">) {
  if (version !== expected || version >= 2_147_483_647) throw new LinkResourceError("link_maintenance_state_conflict");
  if (status !== "awaiting_executor") throw new LinkResourceError("link_maintenance_terminal");
  return { status: next, state_version: version + 1, active_link_id: null };
}
