import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(secret: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error("link_seal_key_required");
  return Buffer.from(secret, "hex");
}
const context = (workspaceId: number, linkId: number, generation: number) =>
  Buffer.from(`tunex-link-transport/v1/${workspaceId}/${linkId}/${generation}`, "utf8");

/** An independent installation key, never AUTH_SECRET or a node credential. */
export function sealLinkTransportKey(transportKey: string, sealKey: string,
  workspaceId: number, linkId: number, generation: number): string {
  if (!/^[0-9a-f]{64}$/i.test(transportKey)) throw new Error("invalid_transport_key");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(sealKey), nonce);
  cipher.setAAD(context(workspaceId, linkId, generation));
  const encrypted = Buffer.concat([cipher.update(transportKey, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), encrypted.toString("base64url"),
    cipher.getAuthTag().toString("base64url")].join(".");
}

export function unsealLinkTransportKey(sealed: string, sealKey: string,
  workspaceId: number, linkId: number, generation: number): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("invalid_link_credential");
  const nonce = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[3]!, "base64url");
  if (nonce.length !== 12 || tag.length !== 16) throw new Error("invalid_link_credential");
  const decipher = createDecipheriv("aes-256-gcm", key(sealKey), nonce);
  decipher.setAAD(context(workspaceId, linkId, generation));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[2]!, "base64url")),
    decipher.final()]).toString("utf8");
  if (!/^[0-9a-f]{64}$/i.test(plaintext)) throw new Error("invalid_link_credential");
  return plaintext;
}

export function newLinkTransportKey(): string { return randomBytes(32).toString("hex"); }
