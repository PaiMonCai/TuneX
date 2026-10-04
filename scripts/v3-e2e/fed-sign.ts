#!/usr/bin/env bun
/**
 * V5.5 Federation —— 门禁/运维用的**署名请求**小工具（WP14）。
 *
 * 为什么不自己实现一份签名：那会立刻变成"第二份密码学实现"。这里只做三件事：
 *   1. 用产品自己的 `services/federation/identity.ts` 取出并解封本机私钥；
 *   2. 用产品自己的 `services/federation/signing.ts` 生成签名头；
 *   3. 把「URL + 头 + body」打印成 JSON，交给 shell / python 去发。
 *
 * 它**不**发请求：发送语义（超时/重试/错误分类）属于 `services/federation/client.ts`，
 * 门禁要的是"能精确指定 message_id 与 body 的一次请求"，因此这里只产出发送物料。
 *
 * 用法（必须在**目标面板自己的容器**里跑，因为它要读那个面板的 DB 与 AUTH_SECRET）：
 *
 *   docker cp scripts/v3-e2e/fed-sign.ts wp14-panel:/tmp/fed-sign.ts
 *   docker exec -w /app wp14-panel bun /tmp/fed-sign.ts \
 *     --url http://panel:3000 --method POST --path /api/federation/v1/ping --body '{}'
 *   # 可选：--message-id <固定 id>（重放/幂等场景必须固定）
 *   #       --ttl 60 --issued-offset 0（时钟偏移场景用）
 *
 * 输出（stdout，单行 JSON）：
 *   {"url":"...","headers":{...},"body":"..."}
 * 失败时非零退出并打印 {"error":"..."}。
 *
 * 安全：只打印**签名头与 body**；私钥不出现、也不落盘（seal.ts 的密文在库里）。
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

// 模块根目录：默认 /app（面板镜像里的仓库位置）。用 TUNEX_SRC_DIR 指向别的 checkout 即可复用。
const srcDir = (process.env.TUNEX_SRC_DIR ?? "/app/src").replace(/\/+$/, "");
const { loadSigningKey } = await import(`${srcDir}/services/federation/identity.ts`);
const { buildSignatureHeaders } = await import(`${srcDir}/services/federation/signing.ts`);

const { identity, privateJwk } = await loadSigningKey().catch((e: unknown) => {
  fail(`cannot load panel identity: ${e instanceof Error ? e.message : String(e)}`);
});

const headers = await buildSignatureHeaders({
  identity,
  privateJwk,
  body,
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
