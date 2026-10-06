/**
 * WP11C —— 脱敏层的负向测试。
 *
 * 每个用例都是一次"如果这条漏了会怎样"：凭据会随诊断产物离开控制面，
 * 泄漏不可撤回。因此断言写的是**产物里不得出现原始机密**，而不是"等于某个
 * 替换后的字符串"（后者会随实现细节变化而失去意义）。
 */
import { describe, expect, test } from "bun:test";
import {
  REDACTED,
  REDACT_ITEM_LIMIT,
  REDACTED_STRING_MAX,
  isSecretKey,
  redact,
  redactText,
  redactToJson,
} from "../redaction.ts";

/** 断言序列化产物里不含任何机密片段。 */
function assertNoSecrets(payload: unknown, secrets: readonly string[], context: string) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const secret of secrets) {
    if (text.includes(secret)) {
      throw new Error(`${context}: leaked ${JSON.stringify(secret)} in ${text.slice(0, 400)}`);
    }
  }
}

describe("key-based redaction", () => {
  test("covers the shapes credentials actually arrive in", () => {
    for (const key of [
      "token",
      "access_token",
      "accessToken",
      "X-Auth-Token",
      "password",
      "passwd",
      "smtp_pass",
      "clientSecret",
      "api_key",
      "apiKeyHash",
      "Authorization",
      "cookie",
      "set-cookie",
      "node_credential_hash",
      "nodeCredential",
      "privateKey",
      "DATABASE_URL",
      "redis_url",
      "session",
    ]) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  test("does not swallow ordinary diagnostic field names", () => {
    for (const key of [
      "node_id",
      "agent_id",
      "status",
      "revision",
      "listen_port",
      "target_host",
      "capabilities",
      "apply_error_code",
      "elapsed_ms",
    ]) {
      expect(isSecretKey(key)).toBe(false);
    }
  });

  test("nested objects and arrays are redacted at every depth", () => {
    const payload = {
      node: { node_id: "hk-in-01", node_credential_hash: "deadbeefdeadbeefdeadbeefdeadbeef" },
      headers: [{ authorization: "Bearer abcdefghijklmnop" }, { cookie: "access=zzz" }],
      keep: { status: "reachable" },
    };
    const out = redact(payload) as Record<string, any>;
    assertNoSecrets(out, ["deadbeefdeadbeefdeadbeefdeadbeef", "abcdefghijklmnop", "access=zzz"], "nested");
    expect(out.node.node_credential_hash).toBe(REDACTED);
    expect(out.headers[0].authorization).toBe(REDACTED);
    expect(out.keep.status).toBe("reachable");
  });
});

describe("value-shape redaction", () => {
  const privateKey = [
    "-----BEGIN OPENSSH PRIVATE KEY-----", // secret-scan:allow — intentional fake redaction fixture
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");

  test("PEM private keys never survive", () => {
    const out = redactText(`key material:\n${privateKey}\ndone`);
    expect(out).not.toContain("b3BlbnNzaC1rZXktdjE");
    expect(out).toContain(REDACTED);
  });

  test("bearer/basic tokens, JWTs and their bare forms never survive", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const samples = [
      `Authorization: Bearer ${jwt}`,
      `Authorization: Basic dXNlcjpwYXNz`,
      `token=${jwt}`,
      `Bearer shorttoken12345678`,
    ];
    for (const sample of samples) {
      const out = redactText(sample);
      assertNoSecrets(out, [jwt, "dXNlcjpwYXNz", "shorttoken12345678"], `shape:${sample.slice(0, 24)}`);
    }
  });

  test("credentials embedded in a URL keep the scheme but lose the secret", () => {
    const out = redactText("dsn=mysql://root:sup3rs3cret@mysql:3306/tunex");
    expect(out).not.toContain("sup3rs3cret");
    expect(out).toContain("mysql://");
    expect(out).toContain(`${REDACTED}@`);
  });

  test("long hex and base64 blobs are removed even without a telling key name", () => {
    const hex = "a".repeat(64);
    const b64 = "QWxsd29ya2FuZG5vcGxheWFiY2RlZmdoaWprbG1ub3A=";
    const out = redactText(`checksum ${hex} blob ${b64}`);
    assertNoSecrets(out, [hex, b64], "blob");
  });

  test("ordinary short values and normal text survive untouched", () => {
    const text = "node hk-in-01 status=active revision=7 port=21001";
    expect(redactText(text)).toBe(text);
  });
});

describe("structured payloads", () => {
  test("a JSON document inside a string is parsed and redacted", () => {
    const inner = JSON.stringify({ node_credential: "cred-abcdefghijklmnop", status: "ok" });
    const out = redact(`report: ${inner}`) as string;
    assertNoSecrets(out, ["cred-abcdefghijklmnop"], "embedded json");
    expect(out).toContain("status");
  });

  test("an unparseable brace-wrapped string is still text-redacted", () => {
    const out = redact(`{not really json: Bearer abcdefghijklmnop}`) as string;
    assertNoSecrets(out, ["abcdefghijklmnop"], "pseudo json");
  });

  test("deep structures are bounded instead of recursed forever", () => {
    let deep: unknown = { value: "leaf" };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    const out = JSON.stringify(redact(deep));
    expect(out).toContain("TRUNCATED:depth");
  });

  test("wide structures are bounded and the truncation is visible", () => {
    const wide = Object.fromEntries(
      Array.from({ length: REDACT_ITEM_LIMIT + 25 }, (_v, i) => [`field_${i}`, i]),
    );
    const out = redact(wide) as Record<string, unknown>;
    expect(Object.keys(out).length).toBeLessThanOrEqual(REDACT_ITEM_LIMIT + 1);
    expect(out["_truncated"]).toContain(String(REDACT_ITEM_LIMIT));
  });

  test("very long strings are truncated so the artefact cannot become the leak", () => {
    const out = redactText("x".repeat(REDACTED_STRING_MAX * 3));
    expect(out.length).toBeLessThan(REDACTED_STRING_MAX + 32);
    expect(out).toContain("[truncated]");
  });

  test("functions and symbols are not serialized into diagnostics", () => {
    const out = redact({ fn: () => "x", ok: 1 } as never) as Record<string, unknown>;
    expect(out.fn).toBe("[UNSERIALIZABLE]");
    expect(out.ok).toBe(1);
  });

  test("redactToJson and redact share one implementation", () => {
    const payload = { password: "hunter2", node_id: "n1" };
    const json = redactToJson(payload);
    assertNoSecrets(json, ["hunter2"], "json export");
    expect(JSON.parse(json)).toEqual({ password: REDACTED, node_id: "n1" });
  });

  test("null and primitive inputs pass through", () => {
    expect(redact(null)).toBeNull();
    expect(redact(7)).toBe(7);
    expect(redact(true)).toBe(true);
  });
});

describe("defence in depth", () => {
  test("a whitelisted-but-unexpected field still gets value-shape redaction", () => {
    // Even if a future collector loosens the key whitelist, a PEM in an
    // innocuous field must not escape.
    const out = redact({
      note: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----", // secret-scan:allow — intentional fake redaction fixture
    }) as Record<string, string>;
    expect(out.note).toBe(REDACTED);
  });

  test("a known credential cannot survive anywhere in a bundle", () => {
    // The collector KNOWS which values are credentials (it holds the node
    // credential and the auth secret). Exact-match removal is the only rule that
    // can catch an opaque string: no pattern distinguishes a canary from
    // legitimate data, and claiming otherwise is how a "redacted" bundle leaks.
    const canary = "CANARY-2f8a1c9e-DO-NOT-LEAK";
    const bundle = {
      node: { version: "0.13.22", last_error: `auth failed with Bearer ${canary}` },
      desired: { tunnels: [{ id: "t1", note: `token=${canary}` }] },
      nested: { deep: { deeper: { value: canary } } },
      plain: canary,
    };
    const out = redact(bundle, 0, { knownSecrets: [canary] });
    assertNoSecrets(out, [canary], "canary bundle with known secrets");
    // Non-secret facts must survive: a bundle that says nothing is not evidence.
    const text = JSON.stringify(out);
    expect(text).toContain("0.13.22");
    expect(text).toContain("t1");
  });

  test("a credential-shaped value is removed even when its key is innocuous", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const out = redact({ note: `handshake failed with ${jwt}` }) as Record<string, string>;
    assertNoSecrets(out, [jwt], "shape rule under an innocuous key");
  });

  test("ordinary diagnostic text is not over-redacted", () => {
    // Over-redaction is its own failure: an operator-facing bundle that blanks
    // normal values cannot be used to diagnose anything.
    const samples = [
      "/var/lib/tunex-agent/desired-lkg.json",
      "upstream target-a:3030 refused the connection after 3 retries with timeout",
      "https://panel.internal/api/internal/node/desired?node=3",
      "550e8400-e29b-41d4-a716-446655440000",
      "apply_status=active applied_revision=7 config_revision=7",
      "hk-in-01 connect_ip=172.31.10.20 listen_ip=0.0.0.0",
    ];
    for (const value of samples) {
      expect(redact(value)).toBe(value);
    }
  });

  test("a long hex or mixed-class blob IS treated as a credential (documented trade-off)", () => {
    // A 32+ character hex run is the shape of a hash or a node credential, and
    // no rule can tell it from legitimate data. Blanking it is the deliberate
    // direction of this trade-off; the known-secret list covers the rest.
    const sha = "a".repeat(64);
    expect(redact(sha)).toBe(REDACTED);
    expect(redact(`sha256=${sha}`)).not.toContain(sha);
  });
});
