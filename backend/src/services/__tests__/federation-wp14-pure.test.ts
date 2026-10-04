/**
 * V5.5 WP14 —— 联邦信任层的**纯**断言（不连库、不发网络请求）。
 *
 * 连库/跨进程那部分（握手落库、回执幂等、撤销级联）由 `tests/federation-*.test.mjs`
 * 与 Gate V5-G5 覆盖。这里钉住的是最容易被"顺手改一下"改坏的判定：签名时间窗、
 * 公钥集合的解析边界、密封原语、错误码的重试语义。它们的共同点是**错了不会立刻报错**，
 * 只会让某一次跨面板调用悄悄放行或拒绝。
 */
import { describe, expect, test } from "bun:test";
import { importJWK } from "jose";

import { deriveSealKey, sealSecret, secretEquals, unsealSecret } from "../federation/seal.ts";
import { keyIdFor, generatePanelKeyPair } from "../federation/keys.ts";
import {
  HDR,
  MAX_MESSAGE_TTL_SECONDS,
  buildSignatureHeaders,
  checkTimeWindow,
  findUsableKey,
  isKeyUsable,
  parsePeerKeys,
  type PeerKeyRecord,
} from "../federation/signing.ts";
import {
  computeHandshakeProof,
  generateInvitationToken,
  hashInvitationToken,
  invitationTokenEquals,
  verifyHandshakeProof,
} from "../federation/tokens.ts";
import { classifyHttpError, isRetryableStatus, normalizePeerEndpoint } from "../federation/transport.ts";
import { federationErrorBody, federationStatus, isRetryableFederationError } from "../federation/errors.ts";
import { sanitizeFederationAuditDetail } from "../federation/audit.ts";

const KEY_A = deriveSealKey("unit-test-secret-a");
const KEY_B = deriveSealKey("unit-test-secret-b");

describe("WP14 seal: 私钥只以密文落地", () => {
  test("roundtrip returns the original plaintext", () => {
    const plain = JSON.stringify({ kty: "OKP", crv: "Ed25519", d: "secret-material" });
    expect(unsealSecret(sealSecret(plain, KEY_A), KEY_A)).toBe(plain);
  });

  test("the same plaintext seals to different ciphertexts (random IV)", () => {
    expect(sealSecret("same", KEY_A)).not.toBe(sealSecret("same", KEY_A));
  });

  test("a different master secret cannot open it", () => {
    const sealed = sealSecret("top-secret", KEY_A);
    expect(() => unsealSecret(sealed, KEY_B)).toThrow();
  });

  test("tampering with the ciphertext is detected (GCM tag)", () => {
    const sealed = sealSecret("top-secret", KEY_A);
    const parts = sealed.split(".");
    const ct = Buffer.from(parts[2]!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    ct[0] = ct[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], ct.toString("base64url"), parts[3]].join(".");
    expect(() => unsealSecret(tampered, KEY_A)).toThrow();
  });

  test("malformed input fails closed instead of returning junk", () => {
    for (const bad of ["", "nope", "v2.a.b.c", "v1.only-three", "v1.a.b.c.d"]) {
      expect(() => unsealSecret(bad, KEY_A)).toThrow();
    }
  });

  test("secretEquals is length-safe", () => {
    expect(secretEquals("abc", "abc")).toBe(true);
    expect(secretEquals("abc", "abd")).toBe(false);
    expect(secretEquals("abc", "abcd")).toBe(false);
  });
});

describe("WP14 identity: 公钥指纹", () => {
  test("key_id is derived from the public key and is stable", async () => {
    const kp = await generatePanelKeyPair();
    expect(kp.key_id).toBe(keyIdFor(kp.public_jwk));
    expect(kp.key_id).toHaveLength(16);
  });

  test("two keypairs never share a key_id", async () => {
    const [a, b] = await Promise.all([generatePanelKeyPair(), generatePanelKeyPair()]);
    expect(a.key_id).not.toBe(b.key_id);
  });
});

describe("WP14 signing: 公钥集合解析 fail-closed", () => {
  const good: PeerKeyRecord = {
    key_id: "abc123",
    jwk: { kty: "OKP", crv: "Ed25519", x: "AAAA" },
    state: "active",
    not_after: null,
  };

  test("accepts a well-formed list", () => {
    expect(parsePeerKeys([good])).toHaveLength(1);
  });

  test("any malformed entry invalidates the whole list", () => {
    // 不"跳过坏条目继续用剩下的"：那会让一次被篡改的公钥表变成静默的部分信任。
    expect(parsePeerKeys([good, { key_id: 1 }])).toEqual([]);
    expect(parsePeerKeys([{ ...good, state: "whatever" }])).toEqual([]);
    expect(parsePeerKeys([{ ...good, jwk: null }])).toEqual([]);
    expect(parsePeerKeys([{ ...good, key_id: "" }])).toEqual([]);
    expect(parsePeerKeys("not-an-array")).toEqual([]);
    expect(parsePeerKeys(null)).toEqual([]);
  });
});

describe("WP14 signing: 轮转宽限期", () => {
  const now = Date.parse("2026-10-05T02:00:00Z");
  const retiring = (notAfter: string | null): PeerKeyRecord => ({
    key_id: "old",
    jwk: { kty: "OKP", crv: "Ed25519", x: "AAAA" },
    state: "retiring",
    not_after: notAfter,
  });

  test("a retiring key keeps verifying until its deadline", () => {
    expect(isKeyUsable(retiring(new Date(now + 3_600_000).toISOString()), now)).toBe(true);
    expect(isKeyUsable(retiring(new Date(now - 1).toISOString()), now)).toBe(false);
  });

  test("retired keys never verify again", () => {
    expect(isKeyUsable({ ...retiring(null), state: "retired" }, now)).toBe(false);
  });

  test("lookup is by key_id AND usability", () => {
    const keys = [retiring(new Date(now - 1).toISOString())];
    expect(findUsableKey(keys, "old", now)).toBeNull();
  });
});

describe("WP14 signing: 时间窗", () => {
  const now = Date.parse("2026-10-05T02:00:00Z");
  const nowSec = Math.floor(now / 1000);

  test("a fresh request passes", () => {
    expect(checkTimeWindow({ issuedAt: nowSec - 5, expiresAt: nowSec + 55, nowMs: now }).ok).toBe(true);
  });

  test("an expired message reports expiry, not a clock problem", () => {
    // 报成 clock_skew 会把"对端积压了消息"误导成"对端时钟不对"，排查方向完全不同。
    const v = checkTimeWindow({ issuedAt: nowSec - 600, expiresAt: nowSec - 540, nowMs: now });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("message_expired");
  });

  test("a future timestamp within the 60s tolerance is accepted", () => {
    expect(checkTimeWindow({ issuedAt: nowSec + 59, expiresAt: nowSec + 119, nowMs: now }).ok).toBe(true);
  });

  test("a future timestamp beyond the tolerance is rejected as clock_skew", () => {
    const v = checkTimeWindow({ issuedAt: nowSec + 61, expiresAt: nowSec + 121, nowMs: now });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("clock_skew");
  });

  test("a non-positive or over-long window is malformed", () => {
    expect(checkTimeWindow({ issuedAt: nowSec, expiresAt: nowSec, nowMs: now }).ok).toBe(false);
    const v = checkTimeWindow({ issuedAt: nowSec, expiresAt: nowSec + MAX_MESSAGE_TTL_SECONDS + 1, nowMs: now });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("message_malformed");
    expect(checkTimeWindow({ issuedAt: Number.NaN, expiresAt: nowSec + 10, nowMs: now }).ok).toBe(false);
  });
});

describe("WP14 signing: 出站签名头", () => {
  test("headers carry the panel identity and a signature over the exact body", async () => {
    const kp = await generatePanelKeyPair();
    const body = JSON.stringify({ hello: "world" });
    const headers = await buildSignatureHeaders({
      identity: { panel_id: "p-1", key_id: kp.key_id, public_jwk: kp.public_jwk },
      privateJwk: kp.private_jwk,
      body,
      messageId: "msg-1",
      nowMs: Date.parse("2026-10-05T02:00:00Z"),
    });
    expect(headers[HDR.panelId]).toBe("p-1");
    expect(headers[HDR.keyId]).toBe(kp.key_id);
    expect(headers[HDR.messageId]).toBe("msg-1");
    // TTL 默认 60s，且被上限夹住
    expect(Number(headers[HDR.expiresAt]) - Number(headers[HDR.issuedAt])).toBeLessThanOrEqual(MAX_MESSAGE_TTL_SECONDS);

    const { compactVerify } = await import("jose");
    const res = await compactVerify(headers[HDR.signature]!, await importJWK(kp.public_jwk, "EdDSA"));
    expect(new TextDecoder().decode(res.payload)).toBe(body);
  });

  test("an empty body is still signed (empty-body requests cannot be swapped)", async () => {
    const kp = await generatePanelKeyPair();
    const headers = await buildSignatureHeaders({
      identity: { panel_id: "p-1", key_id: kp.key_id, public_jwk: kp.public_jwk },
      privateJwk: kp.private_jwk,
      body: "",
      messageId: "msg-2",
    });
    const { compactVerify } = await import("jose");
    const res = await compactVerify(headers[HDR.signature]!, await importJWK(kp.public_jwk, "EdDSA"));
    expect(res.payload.byteLength).toBe(0);
  });
});

describe("WP14 trust: 握手 proof", () => {
  const fields = { panel_id: "panel-b", key_id: "kid-1", public_jwk: { kty: "OKP", crv: "Ed25519", x: "BBBB" } };

  test("the responder's proof verifies with the shared token", () => {
    const token = generateInvitationToken();
    expect(verifyHandshakeProof(token, fields, computeHandshakeProof(token, fields))).toBe(true);
  });

  test("a different token cannot produce the same proof", () => {
    const token = generateInvitationToken();
    const other = generateInvitationToken();
    expect(verifyHandshakeProof(other, fields, computeHandshakeProof(token, fields))).toBe(false);
  });

  test("swapping the public key invalidates the proof", () => {
    const token = generateInvitationToken();
    const proof = computeHandshakeProof(token, fields);
    expect(verifyHandshakeProof(token, { ...fields, public_jwk: { ...fields.public_jwk, x: "CCCC" } }, proof)).toBe(false);
  });

  test("a missing or non-string proof is refused", () => {
    const token = generateInvitationToken();
    expect(verifyHandshakeProof(token, fields, undefined)).toBe(false);
    expect(verifyHandshakeProof(token, fields, 123)).toBe(false);
  });

  test("token hashing is stable and comparison is constant-time safe", () => {
    const token = generateInvitationToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(hashInvitationToken(token)).toBe(hashInvitationToken(token));
    expect(hashInvitationToken(token)).toHaveLength(64);
    expect(invitationTokenEquals(hashInvitationToken(token), hashInvitationToken(token))).toBe(true);
    expect(invitationTokenEquals(hashInvitationToken(token), hashInvitationToken(token).slice(0, 63))).toBe(false);
  });
});

describe("WP14 client: endpoint 与错误分类", () => {
  test("only a clean origin/path is accepted", () => {
    expect(normalizePeerEndpoint("https://panel.example.com:8443").ok).toBe(true);
    expect(normalizePeerEndpoint("http://panel-b:3000/base").ok).toBe(true);
    expect(normalizePeerEndpoint("https://user:pw@panel.example.com").ok).toBe(false);
    expect(normalizePeerEndpoint("https://panel.example.com?x=1").ok).toBe(false);
    expect(normalizePeerEndpoint("file:///etc/passwd").ok).toBe(false);
    expect(normalizePeerEndpoint("not a url").ok).toBe(false);
  });

  test("a structured peer error keeps its code", () => {
    expect(classifyHttpError(409, { code: "grant_not_active", message: "paused" }).code).toBe("grant_not_active");
    expect(classifyHttpError(429, { code: "quota_exhausted" }).code).toBe("quota_exhausted");
  });

  test("unstructured statuses are classified, never guessed as success", () => {
    expect(classifyHttpError(401, null).code).toBe("signature_invalid");
    expect(classifyHttpError(403, null).code).toBe("signature_invalid");
    expect(classifyHttpError(404, null).code).toBe("lease_not_found");
    expect(classifyHttpError(503, "<html>boom</html>").code).toBe("internal_error");
  });
});

describe("WP14 errors: 重试语义", () => {
  test("only transport/timing problems are retryable", () => {
    expect(isRetryableFederationError("peer_unreachable")).toBe(true);
    expect(isRetryableFederationError("clock_skew")).toBe(true);
    // 这两条重试多少次结果都一样：把它们标成可重试等于让调用方空转。
    expect(isRetryableFederationError("peer_revoked")).toBe(false);
    expect(isRetryableFederationError("grant_scope_violation")).toBe(false);
    expect(isRetryableFederationError("signature_invalid")).toBe(false);
  });

  test("status codes are layered, not all 500", () => {
    expect(federationStatus("federation_disabled")).toBe(403);
    expect(federationStatus("grant_scope_violation")).toBe(403);
    expect(federationStatus("quota_exhausted")).toBe(429);
    expect(federationStatus("unsupported_topology")).toBe(422);
    expect(federationStatus("peer_unreachable")).toBe(502);
    expect(federationStatus("internal_error")).toBe(500);
  });

  test("the error body always carries peer id and correlation id", () => {
    const body = federationErrorBody("peer_unknown", "nope", "panel-x");
    expect(body.peer_panel_id).toBe("panel-x");
    expect(body.correlation_id.length).toBeGreaterThan(8);
    expect(body.retryable).toBe(false);
  });
});

describe("WP14 audit: metadata 清洗", () => {
  test("nested objects are dropped, scalars kept, strings truncated", () => {
    const cleaned = sanitizeFederationAuditDetail({
      lease_ref: "abc",
      epoch: 3,
      ok: true,
      nope: null as unknown as string,
      nested: { secret: "x" } as unknown as string,
      long: "y".repeat(400),
    })!;
    expect(cleaned.lease_ref).toBe("abc");
    expect(cleaned.epoch).toBe(3);
    expect(cleaned.ok).toBe(true);
    expect("nested" in cleaned).toBe(false);
    expect((cleaned.long as string).length).toBe(191);
  });

  test("an empty detail becomes null rather than an empty object", () => {
    expect(sanitizeFederationAuditDetail({ only: { deep: 1 } as unknown as string })).toBeNull();
    expect(sanitizeFederationAuditDetail(null)).toBeNull();
  });
});
