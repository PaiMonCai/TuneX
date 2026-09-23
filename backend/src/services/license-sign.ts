import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { env } from "../env.ts";
import { licenseKey } from "../crypto/keys.ts";

const LICENSE_SECRET = env.licenseSecret;


export interface LicensePayload {
  expiredAt: number;
  type: string;
  siteUrl?: string;
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function pkcs7Pad(data: Buffer, blockSize: number): Buffer {
  const padLen = blockSize - (data.length % blockSize);
  const pad = Buffer.alloc(padLen, padLen);
  return Buffer.concat([data, pad]);
}

function fernetEncrypt(key: string, plaintext: string): string {
  const keyBytes = base64urlDecode(key);
  const signingKey = keyBytes.subarray(0, 16);
  const encryptionKey = keyBytes.subarray(16, 32);
  
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", encryptionKey, iv);
  cipher.setAutoPadding(false); // 手动 PKCS7，避免双重 padding
  const padded = pkcs7Pad(Buffer.from(plaintext, "utf8"), 16);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  
  const encoded = Buffer.concat([
    Buffer.from([0x80]),
    timestamp,
    iv,
    ciphertext,
  ]);
  
  const hmac = createHmac("sha256", signingKey);
  hmac.update(encoded);
  const sig = hmac.digest();
  
  const final = Buffer.concat([encoded, sig]);
  return base64urlEncode(final);
}

export function fernetEncryptWith(key: string, plaintext: string): string {
  return fernetEncrypt(key, plaintext);
}

export function signLicense(payload: LicensePayload): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", LICENSE_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function signLicenseForAgent(payload: LicensePayload): string {
  return fernetEncrypt(licenseKey(), JSON.stringify({
    expired_at: payload.expiredAt,
    type: payload.type,
    site_url: payload.siteUrl,
  }));
}

export function verifyLicense(token: string): LicensePayload | null {
  const [header, body, sig] = token.split(".");
  if (!header || !body || !sig) return null;
  const expected = createHmac("sha256", LICENSE_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  if (sig !== expected) return null;
  return JSON.parse(Buffer.from(body, "base64url").toString());
}
