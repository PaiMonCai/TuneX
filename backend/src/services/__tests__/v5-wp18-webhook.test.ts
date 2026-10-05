/**
 * V5-WP18.3 —— Webhook 渠道 + 出站 SSRF 边界（`services/notification-webhook.ts`，契约 §F9 / §7 DoD5）。
 *
 * 覆盖的行为（除了最后一组走本机回环的**真实** socket，全部离线、零真实出站）：
 *   A. **部署级开关默认关**（Lead 裁决 O4 追加约束）：关着时 `not_configured` + 零出站；
 *      只有显式 `=true` 才算打开。
 *   B. **非 https 拒收**（F9.1）：生产一律拒；非生产还要**再**显式开 `..._ALLOW_HTTP=true`；
 *      枚举外协议（file/javascript）一律拒。
 *   C. **private / loopback / link-local / multicast / ULA / CGNAT / 保留段**（F9.2）：
 *      字面量直接拒；域名解析到这些地址**同样拒**，且**零出站**。
 *   D. **禁止重定向**（F9.3）：3xx 全家族 → `rejected_target`，且**只请求一次**（没有跟随）。
 *   E. **超长 / 畸形 URL**（契约 §6 的 WP18.3 要求）：超长、`https://`、非字符串、带凭据、
 *      `localhost` 形态 → 一律拒 + 零出站。
 *   F. **DNS rebinding 的两道防线**：解析结果**全部**必须是公网地址（一个内网就拒）；
 *      解析失败/空结果 → `rejected_target`（不重试）。
 *   G. **凭据不落账本**（F5 / 18.2 的 `target` 列注释）：账本写脱敏形态，出站用的是完整
 *      URL（注入传输断言），错误摘要里出现的 URL 也被脱敏。
 *   H. **传输层实证**（本机回环，真实 socket）：连接的是**已校验的 IP**（Host/SNI 仍是域名）、
 *      只发一次、只读响应头、3xx 不跟随。这是 F9.4「解析一次并连接到该解析结果」的可执行证据。
 *   I. 载荷（中性 JSON 信封，v1）与请求头纪律（CRLF 注入就地抛错）。
 *   J. 静态守卫：本模块**不得**改回 `fetch`（那会静默失去 IP 固定 —— 功能照常、安全属性消失）。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp18-webhook.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AttentionItem } from "../attention.ts";
import {
  IMPLEMENTED_CHANNEL_KINDS,
  deliverNotificationFacts,
  renderNotificationText,
  type LedgerClaimResult,
  type NewNotificationDelivery,
  type NotificationCooldownStore,
  type NotificationDeliveryPatch,
  type NotificationLedgerStore,
} from "../notification-delivery.ts";
import { deriveNotificationFacts, workspaceNotificationScope, type NotificationFact } from "../notification-facts.ts";
import {
  WEBHOOK_ALLOW_HTTP_ENV,
  WEBHOOK_ENABLED_ENV,
  WEBHOOK_RESPONSE_HEAD_MAX,
  WEBHOOK_TARGET_MAX,
  buildWebhookPayload,
  buildWebhookRequestHead,
  classifyWebhookAddress,
  createPinnedSocketTransport,
  createWebhookChannel,
  isPermittedWebhookAddress,
  isWebhookChannelEnabled,
  isWebhookInsecureHttpAllowed,
  parseWebhookStatusLine,
  parseWebhookTarget,
  redactWebhookDetail,
  redactWebhookTarget,
  resolveWebhookTarget,
  webhookTlsServername,
  type ResolvedAddress,
  type WebhookAddressClass,
  type WebhookTargetRejection,
  type WebhookTransport,
} from "../notification-webhook.ts";

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const FACT: NotificationFact = {
  scope: workspaceNotificationScope(7),
  source_kind: "node",
  source_id: "11",
  reason_code: "connection_offline",
  severity: "warning",
  resource_type: "node",
  resource_id: "11",
  resource_name: "hk-in-01",
  occurred_at: "2026-01-01T11:58:00.000Z",
  window_start: "2026-01-01T11:55:00.000Z",
  dedupe_key: "b".repeat(64),
  detail_code: null,
};

/** 真实 18.1 核心派生（幂等键不由测试手写）。 */
function deriveOne(): NotificationFact {
  const item: AttentionItem = {
    kind: "node",
    id: 11,
    name: "hk-in-01",
    severity: "warning",
    reason_code: "connection_offline",
    retryable: null,
  };
  const { facts } = deriveNotificationFacts({
    scope: workspaceNotificationScope(7),
    seeds: [{ item, occurred_at: new Date("2026-01-01T11:58:00.000Z") }],
  });
  return facts[0]!;
}

interface Row extends NewNotificationDelivery {
  id: number;
  settled: NotificationDeliveryPatch | null;
}

function memoryLedger() {
  const rows: Row[] = [];
  let nextId = 1;
  const store: NotificationLedgerStore = {
    async claim(row): Promise<LedgerClaimResult> {
      if (rows.some((r) => r.dedupe_key === row.dedupe_key && r.channel_kind === row.channel_kind)) {
        return { ok: false, duplicate: true };
      }
      const id = nextId++;
      rows.push({ ...row, id, settled: null });
      return { ok: true, id };
    },
    async settle(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error("row missing");
      row.settled = patch;
    },
  };
  return { store, rows };
}

function memoryCooldown(): NotificationCooldownStore {
  const keys = new Set<string>();
  return {
    async acquire(key) {
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    },
  };
}

/** 出站替身：**只记调用**，不联网（DoD5 的"零出站"断言靠它）。 */
function recordingTransport(response: { status: number; location?: string | null } = { status: 200 }) {
  const calls: { url: string; address: string; body: string; headers: Record<string, string> }[] = [];
  const transport: WebhookTransport = async (request) => {
    calls.push({
      url: request.url.toString(),
      address: request.address.address,
      body: request.body,
      headers: { ...request.headers },
    });
    return { status: response.status, location: response.location ?? null };
  };
  return { transport, calls };
}

/**
 * 一个**真的公网**地址。不能用 203.0.113.x / 198.51.100.x（文档段）——分类器把它们判成
 * `reserved` 并拒绝（比契约列出的更严，见 `classifyIpv4`），用它做夹具会把"该拒的"当成"该放"。
 * `93.184.216.34` 属于 example.com 的实数段。
 */
const PUBLIC_ADDRESS: readonly ResolvedAddress[] = [{ address: "93.184.216.34", family: 4 }];

function depsOf(over: {
  ledger: NotificationLedgerStore;
  channel: ReturnType<typeof createWebhookChannel>;
  targets: readonly string[];
}) {
  return {
    ledger: over.ledger,
    channels: [over.channel],
    cooldown: memoryCooldown(),
    resolveTargets: () => over.targets,
    sleep: async () => {},
    random: () => 0,
    onWarn: () => {},
  };
}

/** 固定解析器：域名 → 一组地址（DNS 层在测试里完全可控）。 */
function resolverReturning(addresses: readonly ResolvedAddress[]) {
  return async () => addresses;
}

/* ------------------------------------------------------------------ */
/* A. 部署级开关（默认关）                                              */
/* ------------------------------------------------------------------ */

describe("A. 部署级开关默认关（O4 追加约束）", () => {
  test("只有显式 =true 才算打开；缺省/其它值一律关", () => {
    expect(isWebhookChannelEnabled({})).toBe(false);
    expect(isWebhookChannelEnabled({ [WEBHOOK_ENABLED_ENV]: "1" })).toBe(false);
    expect(isWebhookChannelEnabled({ [WEBHOOK_ENABLED_ENV]: "TRUE" })).toBe(false);
    expect(isWebhookChannelEnabled({ [WEBHOOK_ENABLED_ENV]: "true" })).toBe(true);
  });

  test("开关关着时：not_configured + 零出站 + 账本留一行失败记录", async () => {
    const ledger = memoryLedger();
    const send = recordingTransport();
    const channel = createWebhookChannel({
      enabled: () => false,
      transport: send.transport,
      resolve: resolverReturning(PUBLIC_ADDRESS),
    });

    const outcomes = await deliverNotificationFacts(
      [FACT],
      depsOf({ ledger: ledger.store, channel, targets: ["https://hooks.example.com/services/T/B/secret"] }),
    );

    expect(outcomes[0]!.status).toBe("failed");
    expect(outcomes[0]!.reason).toBe("not_configured");
    expect(send.calls.length).toBe(0);
    expect(ledger.rows[0]!.settled?.failure_reason).toBe("not_configured");
  });
});

/* ------------------------------------------------------------------ */
/* B. 非 https（F9.1）                                                  */
/* ------------------------------------------------------------------ */

describe("B. 目标协议（F9.1）", () => {
  test("生产环境：http:// 一律拒（连显式开关都不看）", () => {
    expect(isWebhookInsecureHttpAllowed({ NODE_ENV: "production", [WEBHOOK_ALLOW_HTTP_ENV]: "true" })).toBe(false);
    const check = parseWebhookTarget("http://hooks.example.com/hook", {
      allowInsecureHttp: isWebhookInsecureHttpAllowed({ NODE_ENV: "production", [WEBHOOK_ALLOW_HTTP_ENV]: "true" }),
    });
    expect(check).toEqual({ ok: false, reason: "insecure_protocol_disallowed" });
  });

  test("非生产但没显式开：仍然拒（'非生产'不是放行理由）", () => {
    expect(isWebhookInsecureHttpAllowed({ NODE_ENV: "development" })).toBe(false);
    expect(parseWebhookTarget("http://hooks.example.com/hook", { allowInsecureHttp: false })).toEqual({
      ok: false,
      reason: "insecure_protocol_disallowed",
    });
  });

  test("非生产 **且** 显式开：http:// 放行（开发栈可用）", () => {
    const allow = isWebhookInsecureHttpAllowed({
      NODE_ENV: "development",
      [WEBHOOK_ALLOW_HTTP_ENV]: "true",
    });
    expect(allow).toBe(true);
    expect(parseWebhookTarget("http://hooks.example.com/hook", { allowInsecureHttp: allow }).ok).toBe(true);
  });

  test("协议白名单外的形态（file / javascript / gopher）一律拒", () => {
    for (const target of ["file:///etc/passwd", "javascript:alert(1)", "gopher://x/1", "ftp://x/y"]) {
      expect(parseWebhookTarget(target, { allowInsecureHttp: true })).toEqual({
        ok: false,
        reason: "unsupported_protocol",
      });
    }
  });

  test("http 目标在生产形态的渠道上：validateConfig 拒 + send 零出站", async () => {
    const send = recordingTransport();
    const channel = createWebhookChannel({
      enabled: () => true,
      allowInsecureHttp: () => false,
      transport: send.transport,
      resolve: resolverReturning(PUBLIC_ADDRESS),
    });
    expect(channel.validateConfig({ target: "http://hooks.example.com/hook" })).toEqual({
      ok: false,
      reason: "rejected_target",
    });
    const result = await channel.send(renderNotificationText(FACT), "http://hooks.example.com/hook");
    expect(result.reason).toBe("rejected_target");
    expect(send.calls.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* C. 地址分类（F9.2）：字面量                                           */
/* ------------------------------------------------------------------ */

describe("C. 地址分类：private / loopback / link-local / multicast / ULA / CGNAT（F9.2）", () => {
  const cases: readonly (readonly [string, WebhookAddressClass])[] = [
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback"],
    ["::1", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "link_local"], // 云元数据
    ["fe80::1", "link_local"],
    ["fc00::1", "unique_local"],
    ["fd12:3456::1", "unique_local"],
    ["100.64.0.1", "shared"], // CGNAT（比契约列出的更严）
    ["224.0.0.1", "multicast"],
    ["ff02::1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["192.0.2.1", "reserved"],
    ["198.51.100.7", "reserved"],
    ["203.0.113.7", "reserved"],
    ["2001:db8::1", "reserved"],
    ["::ffff:10.0.0.1", "private"], // IPv4-mapped：经典绕过
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:169.254.169.254", "link_local"],
    ["64:ff9b::a00:1", "reserved"], // NAT64 包裹 10.0.0.1
    ["::1.2.3.4", "reserved"], // IPv4-compatible（RFC 4291 废弃形态）
    ["8.8.8.8", "public"],
    ["2606:4700::1111", "public"],
    ["not-an-ip", "not_ip"],
    ["", "not_ip"],
    ["0177.0.0.1", "not_ip"], // 八进制历史写法：不认（不猜它是不是 127.0.0.1）
    ["127.1", "not_ip"], // 短写形态同理
  ];

  test("逐条分类（只有 public 才是目的地）", () => {
    for (const [address, expected] of cases) {
      expect({ address, class: classifyWebhookAddress(address) }).toEqual({ address, class: expected });
    }
    expect(isPermittedWebhookAddress("169.254.169.254")).toBe(false);
    expect(isPermittedWebhookAddress("8.8.8.8")).toBe(true);
  });

  test("字面量内网目标：validateConfig 拒 + send 零出站", async () => {
    const send = recordingTransport();
    const channel = createWebhookChannel({
      enabled: () => true,
      transport: send.transport,
      resolve: resolverReturning(PUBLIC_ADDRESS),
    });
    for (const target of [
      "https://127.0.0.1/hook",
      "https://10.0.0.1/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/hook",
      "https://[fc00::1]/hook",
      "https://[fe80::1]/hook",
      "https://[::ffff:10.0.0.1]/hook",
      "https://192.168.0.10/hook",
    ]) {
      expect({ target, check: channel.validateConfig({ target }) }).toEqual({
        target,
        check: { ok: false, reason: "rejected_target" },
      });
      const result = await channel.send(renderNotificationText(FACT), target);
      expect({ target, reason: result.reason }).toEqual({ target, reason: "rejected_target" });
    }
    expect(send.calls.length).toBe(0);
  });

  test("公网字面量目标放行（放行面不为空：否则上面全是假通过）", () => {
    const channel = createWebhookChannel({
      enabled: () => true,
      transport: recordingTransport().transport,
      resolve: resolverReturning(PUBLIC_ADDRESS),
    });
    expect(channel.validateConfig({ target: "https://8.8.8.8/hook" })).toEqual({ ok: true });
  });
});

/* ------------------------------------------------------------------ */
/* D. 重定向（F9.3）                                                    */
/* ------------------------------------------------------------------ */

describe("D. 禁止重定向（F9.3）", () => {
  test("3xx 全家族 → rejected_target，且只出站一次（没有跟随）", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const send = recordingTransport({ status, location: "https://evil.example.com/next" });
      const channel = createWebhookChannel({
        enabled: () => true,
        transport: send.transport,
        resolve: resolverReturning(PUBLIC_ADDRESS),
      });
      const result = await channel.send(renderNotificationText(FACT), "https://hooks.example.com/services/T/B/x");
      expect({ status, sent: result.sent, reason: result.reason }).toEqual({
        status,
        sent: false,
        reason: "rejected_target",
      });
      expect({ status, calls: send.calls.length }).toEqual({ status, calls: 1 });
      // 目标 URL 不出现在摘要里（F5：凭据不落账本）
      expect(result.detail ?? "").not.toContain("services/T/B/x");
    }
  });

  test("非 2xx/3xx（4xx/5xx）→ transport_error（可重试的传输类失败）", async () => {
    for (const status of [400, 404, 429, 500, 502]) {
      const send = recordingTransport({ status });
      const channel = createWebhookChannel({
        enabled: () => true,
        transport: send.transport,
        resolve: resolverReturning(PUBLIC_ADDRESS),
      });
      const result = await channel.send(renderNotificationText(FACT), "https://hooks.example.com/services/T/B/x");
      expect({ status, reason: result.reason }).toEqual({ status, reason: "transport_error" });
    }
  });

  test("2xx → sent", async () => {
    const send = recordingTransport({ status: 204 });
    const channel = createWebhookChannel({
      enabled: () => true,
      transport: send.transport,
      resolve: resolverReturning(PUBLIC_ADDRESS),
    });
    expect(await channel.send(renderNotificationText(FACT), "https://hooks.example.com/services/T/B/x")).toEqual({
      sent: true,
    });
  });
});

/* ------------------------------------------------------------------ */
/* E. 超长 / 畸形 URL                                                   */
/* ------------------------------------------------------------------ */

describe("E. 超长 / 畸形 URL 一律拒（零出站）", () => {
  test("超长的 path / 整串超上限", () => {
    const long = `https://hooks.example.com/${"a".repeat(WEBHOOK_TARGET_MAX)}`;
    expect(parseWebhookTarget(long)).toEqual({ ok: false, reason: "too_long" });
    expect(parseWebhookTarget(`https://hooks.example.com/${"a".repeat(WEBHOOK_TARGET_MAX - 30)}`).ok).toBe(true);
  });

  test("畸形 / 空 / 非字符串", () => {
    const expected: readonly (readonly [unknown, WebhookTargetRejection])[] = [
      ["not a url", "malformed_url"],
      ["https://", "malformed_url"],
      ["://x", "malformed_url"],
      ["https:///hook", "malformed_url"], // 空 authority：不允许解析器静默吞掉多余斜杠
      ["", "empty"],
      ["   ", "empty"],
      [null, "not_a_string"],
      [undefined, "not_a_string"],
      [42, "not_a_string"],
      [{ url: "https://x" }, "not_a_string"],
    ];
    for (const [input, reason] of expected) {
      expect({ input, check: parseWebhookTarget(input as string) }).toEqual({
        input,
        check: { ok: false, reason },
      });
    }
  });

  test("URL 内嵌凭据 / localhost 形态", () => {
    expect(parseWebhookTarget("https://user:pass@hooks.example.com/hook")).toEqual({
      ok: false,
      reason: "credentials_in_url",
    });
    for (const target of ["https://localhost/hook", "https://a.localhost/hook"]) {
      expect(parseWebhookTarget(target)).toEqual({ ok: false, reason: "blocked_hostname" });
    }
  });

  test("渠道层：超长/畸形目标 → rejected_target + 零出站", async () => {
    const send = recordingTransport();
    const channel = createWebhookChannel({
      enabled: () => true,
      transport: send.transport,
      resolve: resolverReturning(PUBLIC_ADDRESS),
    });
    for (const target of [`https://hooks.example.com/${"a".repeat(WEBHOOK_TARGET_MAX)}`, "not a url", ""]) {
      const result = await channel.send(renderNotificationText(FACT), target);
      expect({ target: target.slice(0, 12), reason: result.reason }).toEqual({
        target: target.slice(0, 12),
        reason: "rejected_target",
      });
    }
    expect(send.calls.length).toBe(0);
  });

  test("端口 0 → 拒（URL 解析器放行，但这不是有效目标）", () => {
    expect(parseWebhookTarget("https://hooks.example.com:0/hook")).toEqual({ ok: false, reason: "invalid_port" });
    expect(parseWebhookTarget("https://hooks.example.com:8443/hook").ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* F. DNS 解析结果全量校验（F9.2 / F9.4）                                */
/* ------------------------------------------------------------------ */

describe("F. 解析结果全量校验：任一内网即拒（零出站）", () => {
  test("域名解析到 private / loopback / link-local → rejected_target + 零出站", async () => {
    for (const address of [
      { address: "10.0.0.5", family: 4 },
      { address: "127.0.0.1", family: 4 },
      { address: "169.254.169.254", family: 4 },
      { address: "fc00::1", family: 6 },
    ]) {
      const send = recordingTransport();
      const channel = createWebhookChannel({
        enabled: () => true,
        transport: send.transport,
        resolve: resolverReturning([address]),
      });
      const result = await channel.send(renderNotificationText(FACT), "https://hooks.example.com/services/T/B/x");
      expect({ address: address.address, reason: result.reason }).toEqual({
        address: address.address,
        reason: "rejected_target",
      });
      expect(send.calls.length).toBe(0);
    }
  });

  test("多地址（轮询 DNS）里有一个内网 → 整体拒（不靠运气）", async () => {
    const send = recordingTransport();
    const channel = createWebhookChannel({
      enabled: () => true,
      transport: send.transport,
      resolve: resolverReturning([
        { address: "203.0.113.9", family: 4 },
        { address: "192.168.10.10", family: 4 },
      ]),
    });
    const result = await channel.send(renderNotificationText(FACT), "https://hooks.example.com/x");
    expect(result.reason).toBe("rejected_target");
    expect(send.calls.length).toBe(0);
    // 直接对解析器入口断言：结论同样成立（不含渠道层逻辑）
    expect(
      await resolveWebhookTarget("https://hooks.example.com/x", {
        resolve: resolverReturning([
          { address: "203.0.113.9", family: 4 },
          { address: "192.168.10.10", family: 4 },
        ]),
      }),
    ).toEqual({ ok: false, reason: "forbidden_address" });
  });

  test("解析失败 / 空结果 → rejected_target（不重试），且不是 transport_error", async () => {
    const send = recordingTransport();
    for (const resolve of [
      async () => {
        throw new Error("getaddrinfo ENOTFOUND hooks.example.com");
      },
      async () => [],
    ]) {
      const channel = createWebhookChannel({ enabled: () => true, transport: send.transport, resolve });
      const result = await channel.send(renderNotificationText(FACT), "https://hooks.example.com/x");
      expect(result.reason).toBe("rejected_target");
    }
    expect(send.calls.length).toBe(0);
  });

  test("解析通过时使用**解析结果**（第一个地址）而不是再解析一次", async () => {
    const send = recordingTransport();
    const channel = createWebhookChannel({
      enabled: () => true,
      transport: send.transport,
      resolve: resolverReturning([
        { address: "93.184.216.34", family: 4 },
        { address: "93.184.216.35", family: 4 },
      ]),
    });
    await channel.send(renderNotificationText(FACT), "https://hooks.example.com/x");
    expect(send.calls.length).toBe(1);
    expect(send.calls[0]!.address).toBe("93.184.216.34");
    expect(send.calls[0]!.url).toContain("hooks.example.com");
  });
});

/* ------------------------------------------------------------------ */
/* G. 脱敏：凭据不落账本 / 不进错误摘要                                  */
/* ------------------------------------------------------------------ */

describe("G. 目标脱敏（F5 / 18.2 target 列注释）", () => {
  const slack = "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX";

  test("脱敏形态：保留 origin，丢掉 path/query，附稳定短摘要", () => {
    const masked = redactWebhookTarget(slack);
    expect(masked.startsWith("https://hooks.slack.com/***")).toBe(true);
    expect(masked).not.toContain("T00000000");
    expect(masked).not.toContain("XXXX");
    // 稳定 + 可区分
    expect(redactWebhookTarget(slack)).toBe(masked);
    expect(redactWebhookTarget(`${slack}2`)).not.toBe(masked);
    // 查询串里的 token 同样不落
    const withQuery = redactWebhookTarget("https://hooks.example.com/hook?token=supersecret");
    expect(withQuery).not.toContain("supersecret");
    // 不可解析的形态也不落原文
    expect(redactWebhookTarget("not a url at all")).not.toContain("not a url at all");
  });

  test("错误摘要里出现的 URL 被换成脱敏形态", () => {
    const detail = redactWebhookDetail(`webhook failed: request to ${slack} failed`, slack);
    expect(detail).not.toContain("XXXX");
    expect(detail).toContain("***");
  });

  test("端到端：账本落脱敏目标，出站用完整 URL", async () => {
    const ledger = memoryLedger();
    const send = recordingTransport();
    const channel = createWebhookChannel({
      enabled: () => true,
      transport: send.transport,
      resolve: resolverReturning(PUBLIC_ADDRESS),
    });
    const outcomes = await deliverNotificationFacts(
      [deriveOne()],
      depsOf({ ledger: ledger.store, channel, targets: [slack] }),
    );
    expect(outcomes[0]!.status).toBe("sent");
    expect(ledger.rows[0]!.target).toBe(redactWebhookTarget(slack));
    expect(ledger.rows[0]!.target).not.toContain("XXXX");
    // 出站用的仍是完整目标（否则根本发不到对方的 hook）
    expect(send.calls[0]!.url).toBe(slack);
  });

  test("传输层抛出的错误也不把 URL 带进账本", async () => {
    const ledger = memoryLedger();
    const channel = createWebhookChannel({
      enabled: () => true,
      resolve: resolverReturning(PUBLIC_ADDRESS),
      transport: async (request) => {
        throw new Error(`connect ECONNREFUSED ${request.url.toString()}`);
      },
    });
    const outcomes = await deliverNotificationFacts(
      [deriveOne()],
      depsOf({ ledger: ledger.store, channel, targets: [slack] }),
    );
    expect(outcomes[0]!.status).toBe("failed");
    expect(ledger.rows[0]!.settled?.error ?? "").not.toContain("XXXX");
    expect(ledger.rows[0]!.settled?.error ?? "").toContain("***");
  });
});

/* ------------------------------------------------------------------ */
/* H. 传输层实证（本机回环，真实 socket）                                */
/* ------------------------------------------------------------------ */

interface LoopbackServer {
  readonly port: number;
  readonly requests: { method: string; url: string; host: string; contentType: string; body: string }[];
  close(): Promise<void>;
  setResponse(status: number, headers?: Record<string, string>): void;
}

async function startLoopbackServer(): Promise<LoopbackServer> {
  let response: { status: number; headers: Record<string, string> } = { status: 200, headers: {} };
  const requests: LoopbackServer["requests"] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        host: req.headers.host ?? "",
        contentType: req.headers["content-type"] ?? "",
        body,
      });
      res.writeHead(response.status, response.headers);
      res.end("ignored");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    setResponse(status, headers = {}) {
      response = { status, headers };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("H. 传输层：连的是已校验 IP，只发一次，不跟随重定向", () => {
  const servers: LoopbackServer[] = [];
  afterEach(async () => {
    while (servers.length > 0) await servers.pop()!.close();
  });
  async function server(): Promise<LoopbackServer> {
    const s = await startLoopbackServer();
    servers.push(s);
    return s;
  }

  test("Host/SNI 用域名，连接固定到已校验的 IP（DNS 里根本没有这个域名）", async () => {
    const s = await server();
    const transport = createPinnedSocketTransport();
    const response = await transport({
      // 域名故意不可解析：能连上就证明"连的是传入的 IP"，不是系统 DNS 的结果。
      url: new URL(`http://webhook-probe.invalid:${s.port}/services/T/B/x?k=v`),
      address: { address: "127.0.0.1", family: 4 },
      headers: {},
      body: '{"probe":true}',
      timeoutMs: 5_000,
    });
    expect(response.status).toBe(200);
    expect(s.requests.length).toBe(1);
    expect(s.requests[0]!.method).toBe("POST");
    expect(s.requests[0]!.url).toBe("/services/T/B/x?k=v");
    expect(s.requests[0]!.host).toBe(`webhook-probe.invalid:${s.port}`);
    expect(s.requests[0]!.contentType).toBe("application/json");
    expect(s.requests[0]!.body).toBe('{"probe":true}');
  });

  test("3xx：只读响应头、不做第二个请求（Location 只是被带回来，绝不跟随）", async () => {
    const s = await server();
    s.setResponse(302, { location: "http://127.0.0.1:1/evil" });
    const transport = createPinnedSocketTransport();
    const response = await transport({
      url: new URL(`http://webhook-probe.invalid:${s.port}/hook`),
      address: { address: "127.0.0.1", family: 4 },
      headers: {},
      body: "{}",
      timeoutMs: 5_000,
    });
    expect(response).toEqual({ status: 302, location: "http://127.0.0.1:1/evil" });
    // 只发了一次请求：跟随重定向的实现会在这里出现第二次（打到 127.0.0.1:1 之后失败/或打到本机）
    expect(s.requests.length).toBe(1);
  });

  test("连接失败收敛成抛出（渠道层再折叠成 transport_error，不挂住投递循环）", async () => {
    const transport = createPinnedSocketTransport();
    await expect(
      transport({
        url: new URL("http://webhook-probe.invalid:1/hook"),
        address: { address: "127.0.0.1", family: 4 },
        headers: {},
        body: "{}",
        timeoutMs: 500,
      }),
    ).rejects.toThrow();
  });

  test("响应头超过上限 → 抛出（不把内存交给对端）", async () => {
    const s = await server();
    s.setResponse(200, { "x-pad": "p".repeat(WEBHOOK_RESPONSE_HEAD_MAX + 100) });
    const transport = createPinnedSocketTransport();
    await expect(
      transport({
        url: new URL(`http://webhook-probe.invalid:${s.port}/hook`),
        address: { address: "127.0.0.1", family: 4 },
        headers: {},
        body: "{}",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow();
  });

  test("状态行/响应头解析是纯函数（畸形输入不猜）", () => {
    expect(parseWebhookStatusLine("HTTP/1.1 200 OK")).toBe(200);
    expect(parseWebhookStatusLine("HTTP/1.1 302 Found")).toBe(302);
    expect(parseWebhookStatusLine("HTTP/2 200 OK")).toBe(null);
    expect(parseWebhookStatusLine("garbage")).toBe(null);
    expect(parseWebhookStatusLine("HTTP/1.1 999 Weird")).toBe(null);
  });

  test("SNI 只对域名发；IP 字面量（含带方括号的 IPv6）不发", () => {
    expect(webhookTlsServername("hooks.example.com")).toBe("hooks.example.com");
    // URL.hostname 对 IPv6 是带方括号的，而 isIP() 不认方括号 —— 这一条就是防那个坑
    expect(webhookTlsServername("[2606:4700::1111]")).toBe(undefined);
    expect(webhookTlsServername("2606:4700::1111")).toBe(undefined);
    expect(webhookTlsServername("8.8.8.8")).toBe(undefined);
    expect(webhookTlsServername("")).toBe(undefined);
  });
});

/* ------------------------------------------------------------------ */
/* I. 载荷与请求头纪律                                                  */
/* ------------------------------------------------------------------ */

describe("I. 载荷与请求头", () => {
  test("中性 JSON 信封（v1）：字段固定、内容来自渲染、不含目标/凭据", () => {
    const rendered = renderNotificationText(FACT);
    const payload = JSON.parse(buildWebhookPayload(rendered)) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["source", "subject", "text", "version"]);
    expect(payload.version).toBe(1);
    expect(payload.source).toBe("tunex");
    expect(payload.subject).toBe(rendered.subject);
    expect(payload.text).toBe(rendered.text);
    expect(payload.text).toContain("connection_offline");
    expect(JSON.stringify(payload)).not.toContain("hooks.example.com");
  });

  test("请求头：Host 用域名、Content-Length 按字节数、CRLF 出现即抛错", () => {
    const head = buildWebhookRequestHead({
      url: new URL("https://hooks.example.com/a%20b?x=1"),
      address: { address: "203.0.113.9", family: 4 },
      headers: {},
      body: "中", // 3 字节
      timeoutMs: 1_000,
    });
    expect(head.startsWith("POST /a%20b?x=1 HTTP/1.1\r\n")).toBe(true);
    expect(head).toContain("\r\nHost: hooks.example.com\r\n");
    expect(head).toContain("\r\nContent-Length: 3\r\n");
    expect(head.endsWith("\r\n\r\n")).toBe(true);

    expect(() =>
      buildWebhookRequestHead({
        url: new URL("https://hooks.example.com/hook"),
        address: { address: "203.0.113.9", family: 4 },
        headers: { "x-evil": "a\r\nInjected: 1" },
        body: "{}",
        timeoutMs: 1_000,
      }),
    ).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* J. 静态守卫                                                          */
/* ------------------------------------------------------------------ */

describe("J. 静态守卫：出站实现不得改回 fetch", () => {
  const source = readFileSync(new URL("../notification-webhook.ts", import.meta.url), "utf8");

  test("模块内不出现 fetch( —— IP 固定是安全属性，不是可选优化", () => {
    expect(source.includes("fetch(")).toBe(false);
    expect(source.includes("createPinnedSocketTransport")).toBe(true);
  });

  test("webhook 已登记为实现渠道（telegram 在 WP18.4 登记）", () => {
    expect(IMPLEMENTED_CHANNEL_KINDS).toEqual(["email", "webhook", "telegram"]);
    expect(IMPLEMENTED_CHANNEL_KINDS.includes("webhook")).toBe(true);
  });
});
