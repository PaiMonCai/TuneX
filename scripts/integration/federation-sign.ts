#!/usr/bin/env bun
/**
 * Federation signed-request helper for Integration and operations.
 *
 * Produces the exact signed material consumed by the Panel's Federation verifier.
 */
const args = process.argv.slice(2);

function arg(name: string, fallback: string | null = null): string | null {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? fallback : v;
}

function fail(message: string): never {
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

const url = arg("url", "http://panel:3000")!;
const method = (arg("method", "POST") ?? "POST").toUpperCase();
const path = arg("path");
const bodyArg = arg("body", "");
const messageId = arg("message-id");
const ttl = Number(arg("ttl", "60"));
const issuedOffset = Number(arg("issued-offset", "0"));

if (!path) fail("--path is required");
if (!path.startsWith("/")) fail("--path must start with /");

let body = bodyArg ?? "";
if (body.length > 0) {
  try {
    body = JSON.stringify(JSON.parse(body));
  } catch {
    fail("--body must be valid JSON");
  }
}

// The unified production image keeps backend sources under /app/backend/src.
// TUNEX_SRC_DIR remains available for local/alternate image layouts.
const srcDir = (process.env.TUNEX_SRC_DIR ?? "/app/backend/src").replace(/\/+$/, "");
const { loadSigningKey } = await import(`${srcDir}/services/federation/identity.ts`);
const { buildSignatureHeaders } = await import(`${srcDir}/services/federation/signing.ts`);

const { identity, privateJwk } = await loadSigningKey().catch((e: unknown) => {
  fail(`cannot load panel identity: ${e instanceof Error ? e.message : String(e)}`);
});

const headers = await buildSignatureHeaders({
  identity,
  privateJwk,
  body,
  method,
  path,
  messageId: messageId ?? crypto.randomUUID(),
  nowMs: Date.now() + issuedOffset * 1000,
  ttlSeconds: Number.isFinite(ttl) ? ttl : 60,
});

process.stdout.write(
  `${JSON.stringify({
    url: `${url.replace(/\/+$/, "")}${path}`,
    method,
    headers: { ...headers, "content-type": "application/json" },
    body,
  })}\n`,
);
