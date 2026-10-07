/**
 * V5-WP19-D —— Looking Glass 的面板侧证据（安全边界 + 编排 + 线形守卫）。
 *
 * 契约：`docs/v5-wp19-latency-observability-contract.md` §3 D7 / §5 WP19-D / §7 G19.9–G19.13。
 *
 * ── 这份测试在钉什么 ──
 * 这不是"功能好不好用"的测试，而是**这个功能能不能被用来扫内网**的测试。每一组都对应
 * 契约里的一条边界，并且都在**发包之前**断言（`issue` 替身记录"有没有下发过命令"）：
 *
 *   1. 地址向量表（与 Go 侧 `lookingglass_test.go` 的同一张表逐条对应）；
 *   2. 写法变体一律拒绝，**且不进入解析器**（解析器替身记录调用次数 = 0）；
 *   3. 域名解析到私网 ⇒ 整请求拒绝（"别名域名打内网"）；
 *   4. 默认关闭 + 明确拒绝（不是空结果）+ 管理员例外必须留审计痕迹；
 *   5. 跨租户节点 → 404 且零下发；
 *   6. 单节点单飞（并发第二条拒绝、失败也释放、TTL 兜底）；
 *   7. 未广告动作 → 入队前拒绝（旧 Agent 不会收到一条它不认识的命令）；
 *   8. 结果必须**恰好覆盖**请求集合，且出现解析痕迹 ⇒ 整份拒绝；
 *   9. 源码级"重建边界"守卫（新动作要穿过五个逐字段重建处，少一个就静默失效）。
 *
 * ── 不做的断言（明确写下来，免得下一个人以为覆盖了）──
 *   · 没有真实 Agent / 真实公网目标：端到端条目（G19.9 的"Agent 侧零执行"在真拓扑上）
 *     由 `scripts/v3-e2e` 的 Gate 承担；本文件覆盖到"拒绝发生在发包之前"的替身层。
 *   · 不做 DNS 行为测试（替身解析器不模拟真实 DNS）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOOKING_GLASS_CAVEATS,
  LOOKING_GLASS_CODES,
  LOOKING_GLASS_DEFAULT_TIMEOUT_MS,
  LOOKING_GLASS_MAX_PINNED_ADDRESSES,
  LOOKING_GLASS_MAX_REQUESTED_TARGETS,
  LOOKING_GLASS_MAX_TIMEOUT_MS,
  LOOKING_GLASS_METHODS,
  LookingGlassLocks,
  classifyRequestedHost,
  classifyTargetAddress,
  decideLookingGlassEntry,
  lookingGlassAckWaitMs,
  lookingGlassEnabledFromEnv,
  looksLikeAddressLiteralVariant,
  normalizeLookingGlassResults,
  parseCanonicalIPv4,
  parseIPv6,
  planLookingGlassTargets,
  runLookingGlass,
  type LookingGlassAuditRow,
  type LookingGlassDeps,
  type LookingGlassIssueInput,
} from "../../looking-glass.ts";
import {
  dequeueAgentCommand,
  enqueueAgentCommand,
  storeAgentCommandAck,
  type CommandBusStore,
} from "../../agent-command-bus.ts";
import {
  ACTION_PAYLOAD_KEYS,
  ACTION_SPECS,
  COMMAND_ACTIONS,
  LOOKING_GLASS_MAX_TARGETS,
  LOOKING_GLASS_MAX_TIMEOUT_MS as WIRE_MAX_TIMEOUT_MS,
  createCommand,
  validatePayload,
} from "../../control-protocol/index.ts";

/* ================================================================== */
/* 替身                                                                */
/* ================================================================== */

interface Harness {
  deps: LookingGlassDeps;
  audits: LookingGlassAuditRow[];
  issues: LookingGlassIssueInput[];
  resolveCalls: string[];
  nodeLookups: Array<{ nodeId: number; workspaceId: number }>;
}

const WORKSPACE_ID = 1;
const NODE_ID = 7;

function harness(overrides: Partial<LookingGlassDeps> = {}, opts: { resolveTo?: string[]; issueResults?: unknown } = {}): Harness {
  const audits: LookingGlassAuditRow[] = [];
  const issues: LookingGlassIssueInput[] = [];
  const resolveCalls: string[] = [];
  const nodeLookups: Array<{ nodeId: number; workspaceId: number }> = [];
  const deps: LookingGlassDeps = {
    enabled: () => true,
    async resolve(host: string) {
      resolveCalls.push(host);
      return opts.resolveTo ?? ["93.184.216.34"];
    },
    async loadNode(nodeId: number, workspaceId: number) {
      nodeLookups.push({ nodeId, workspaceId });
      return workspaceId === WORKSPACE_ID && nodeId === NODE_ID ? { id: NODE_ID, node_key: "node-a" } : null;
    },
    async capabilityFacts() {
      return {
        protocolVersion: 2,
        // task-42：方法级能力标注与动作一起上报（agent 只为**真能执行**的方法标注）。
        capabilities: [
          "apply_tunnel",
          "looking_glass",
          "looking_glass:ping",
          "looking_glass:ping6",
          "looking_glass:traceroute",
          "looking_glass:traceroute6",
        ],
        capabilitiesMalformed: false,
        manifest: null,
        manifestMalformed: false,
      };
    },
    async issue(input: LookingGlassIssueInput) {
      issues.push(input);
      if (opts.issueResults !== undefined) return { ok: true, results: opts.issueResults };
      return {
        ok: true,
        results: input.targets.map((t) => ({
          host: t.address,
          port: t.port,
          status: "reachable",
          elapsed_ms: 12,
        })),
      };
    },
    async audit(row: LookingGlassAuditRow) {
      audits.push(row);
      return true;
    },
    locks: new LookingGlassLocks(),
    now: () => new Date("2026-10-05T09:00:00.000Z"),
    ...overrides,
  };
  return { deps, audits, issues, resolveCalls, nodeLookups };
}

function run(input: Record<string, unknown>, h: Harness) {
  return runLookingGlass(
    {
      nodeId: NODE_ID,
      workspaceId: WORKSPACE_ID,
      actorUserId: 42,
      isPlatformAdmin: false,
      targets: [{ host: "93.184.216.34", port: 443 }],
      ...input,
    },
    h.deps,
  );
}

/* ================================================================== */
/* 1. 地址向量表（与 Go 侧同一张表）                                     */
/* ================================================================== */

interface AddressVector {
  literal: string;
  allow: boolean;
  why: string;
}

/**
 * **必须与 `agent/internal/diag/lookingglass_test.go:lookingGlassVectors` 逐条一致。**
 *
 * 两侧是同一份策略的两处实现（面板判一次、Agent 再判一次），所以"同一张向量表跑两遍"
 * 就是这份安全边界的一致性证据。只断言 allow/deny：面报的拒绝理由文案可以不同
 * （两侧解析器不同），但**放行/拒绝这一位不同就是漏洞**。
 */
const ADDRESS_VECTORS: readonly AddressVector[] = [
  { literal: "93.184.216.34", allow: true, why: "公网 IPv4" },
  { literal: "1.1.1.1", allow: true, why: "公网 DNS" },
  { literal: "8.8.8.8", allow: true, why: "公网 DNS" },
  { literal: "172.15.255.255", allow: true, why: "172.16/12 下界之外" },
  { literal: "172.32.0.0", allow: true, why: "172.16/12 上界之外" },
  { literal: "100.63.255.255", allow: true, why: "100.64/10 下界之外" },
  { literal: "100.128.0.0", allow: true, why: "100.64/10 上界之外" },
  { literal: "198.17.255.255", allow: true, why: "198.18/15 下界之外" },
  { literal: "198.20.0.0", allow: true, why: "198.18/15 上界之外" },
  { literal: "192.0.1.0", allow: true, why: "192.0.0/24 之外" },
  { literal: "223.255.255.255", allow: true, why: "最大公网单播" },
  { literal: "2606:4700::1111", allow: true, why: "公网 IPv6" },
  { literal: "2001:4860:4860::8888", allow: true, why: "公网 IPv6" },
  { literal: "2a00:1450:4001::1", allow: true, why: "公网 IPv6" },
  { literal: "::ffff:93.184.216.34", allow: true, why: "IPv4 映射公网地址（还原后为公网）" },

  { literal: "10.0.0.1", allow: false, why: "10/8 私网" },
  { literal: "10.255.255.255", allow: false, why: "10/8 上界" },
  { literal: "172.16.0.0", allow: false, why: "172.16/12 下界" },
  { literal: "172.31.255.255", allow: false, why: "172.16/12 上界" },
  { literal: "192.168.0.1", allow: false, why: "192.168/16 私网" },
  { literal: "192.168.255.255", allow: false, why: "192.168/16 上界" },
  { literal: "127.0.0.1", allow: false, why: "环回" },
  { literal: "127.255.255.255", allow: false, why: "127/8 上界" },
  { literal: "169.254.1.1", allow: false, why: "链路本地" },
  { literal: "169.254.169.254", allow: false, why: "云元数据端点" },
  { literal: "0.0.0.0", allow: false, why: "0/8 本网络" },
  { literal: "0.1.2.3", allow: false, why: "0/8 内" },
  { literal: "0.255.255.255", allow: false, why: "0/8 上界" },
  { literal: "224.0.0.1", allow: false, why: "多播" },
  { literal: "239.255.255.255", allow: false, why: "多播上界" },
  { literal: "240.0.0.1", allow: false, why: "240/4 保留" },
  { literal: "255.255.255.255", allow: false, why: "广播" },
  { literal: "100.64.0.1", allow: false, why: "CGNAT" },
  { literal: "100.127.255.255", allow: false, why: "CGNAT 上界" },
  { literal: "192.0.0.1", allow: false, why: "IETF 协议保留" },
  { literal: "192.0.2.1", allow: false, why: "TEST-NET-1" },
  { literal: "192.88.99.1", allow: false, why: "6to4 中继任播" },
  { literal: "198.18.0.1", allow: false, why: "基准测试" },
  { literal: "198.51.100.1", allow: false, why: "TEST-NET-2" },
  { literal: "203.0.113.1", allow: false, why: "TEST-NET-3" },

  { literal: "::1", allow: false, why: "环回" },
  { literal: "::", allow: false, why: "未指定" },
  { literal: "fe80::1", allow: false, why: "链路本地" },
  { literal: "febf:ffff::1", allow: false, why: "fe80::/10 上界" },
  { literal: "fc00::1", allow: false, why: "ULA" },
  { literal: "fd12:3456::1", allow: false, why: "ULA（fd00::/8）" },
  { literal: "ff02::1", allow: false, why: "多播" },
  { literal: "fec0::1", allow: false, why: "站点本地（已废弃）" },
  { literal: "2001:db8::1", allow: false, why: "文档用" },
  { literal: "3fff::1", allow: false, why: "文档用（RFC 9637）" },
  { literal: "100::1", allow: false, why: "丢弃专用" },
  { literal: "2002:0a00:0001::1", allow: false, why: "6to4（内嵌 10.0.0.1）" },
  { literal: "2002:5db8:d822::1", allow: false, why: "6to4（内嵌公网也整段拒绝）" },
  { literal: "2001::1", allow: false, why: "Teredo" },
  { literal: "64:ff9b::a00:1", allow: false, why: "NAT64（内嵌 10.0.0.1）" },
  { literal: "5f00::1", allow: false, why: "SRv6 SID" },
  { literal: "2001:10::1", allow: false, why: "ORCHID" },

  { literal: "::ffff:127.0.0.1", allow: false, why: "IPv4 映射环回" },
  { literal: "::FFFF:127.0.0.1", allow: false, why: "映射形式大小写变体" },
  { literal: "::ffff:10.0.0.1", allow: false, why: "IPv4 映射私网" },
  { literal: "::ffff:192.168.1.1", allow: false, why: "IPv4 映射私网" },
  { literal: "::ffff:0.0.0.0", allow: false, why: "IPv4 映射 0 段" },
  { literal: "2130706433", allow: false, why: "十进制 127.0.0.1" },
  { literal: "0177.0.0.1", allow: false, why: "八进制写法" },
  { literal: "0x7f.0.0.1", allow: false, why: "十六进制写法" },
  { literal: "0x7f000001", allow: false, why: "十六进制整数写法" },
  { literal: "127.1", allow: false, why: "短形式" },
  { literal: "127.0.0.1.", allow: false, why: "尾点形式" },
  { literal: "1.2.3.4.5", allow: false, why: "段数过多" },
  { literal: "[::1]", allow: false, why: "方括号形式" },
  { literal: "[2606:4700::1111]", allow: false, why: "方括号形式（即使是公网）" },
  { literal: "fe80::1%eth0", allow: false, why: "带 zone id" },
  { literal: "fe80::1%25eth0", allow: false, why: "带百分号编码 zone" },
  { literal: "", allow: false, why: "空串" },
  { literal: "   ", allow: false, why: "全空白" },
  { literal: "例え.テスト", allow: false, why: "非 ASCII" },
];

describe("WP19-D 地址白名单（与 Go 侧同一张向量表）", () => {
  for (const vector of ADDRESS_VECTORS) {
    test(`classifyTargetAddress(${JSON.stringify(vector.literal)}) → ${vector.allow ? "允许" : "拒绝"}（${vector.why}）`, () => {
      const verdict = classifyTargetAddress(vector.literal);
      expect(verdict.ok, `${vector.literal}: ${vector.why}`).toBe(vector.allow);
      if (verdict.ok) {
        // 放行的地址必须是**规范字面量**，且不含方括号/zone。
        expect(verdict.address).not.toContain("[");
        expect(verdict.address).not.toContain("%");
        expect(classifyTargetAddress(verdict.address).ok).toBe(true);
      } else {
        // 拒绝必须有机器可判定的 code，而不是一句人读的话。
        expect(verdict.code).toBe(
          vector.literal === "127.0.0.1" || vector.literal.startsWith("::ffff:127")
            ? LOOKING_GLASS_CODES.targetNotPublic
            : verdict.code,
        );
      }
    });
  }

  test("向量表本身不是空转：允许/拒绝两侧都够厚", () => {
    expect(ADDRESS_VECTORS.filter((v) => v.allow).length).toBeGreaterThanOrEqual(14);
    expect(ADDRESS_VECTORS.filter((v) => !v.allow).length).toBeGreaterThanOrEqual(60);
  });
});

/* ================================================================== */
/* 2. 写法变体：拒绝且**不进入解析器**                                   */
/* ================================================================== */

/**
 * 这一组是"写法变体"防线的核心断言。
 *
 * 光断言"拒绝了"不够：真正的危险是**被解析器解释**（glibc 的 getaddrinfo 历史上把
 * `2130706433` 解释成 127.0.0.1，也接受八进制与短形式）。因此这里用一个**记录调用的
 * 解析器替身**，断言这些字符串根本没被送去解析：0 次调用。
 */
describe("WP19-D 写法变体：拒绝且不进入解析器", () => {
  const VARIANTS = [
    "2130706433", // 十进制
    "0177.0.0.1", // 八进制
    "0x7f.0.0.1", // 十六进制
    "0x7f000001", // 十六进制整数
    "127.1", // 短形式
    "127.0.0.1.", // 尾点
    "1.2.3.4.5", // 段数过多
    "127.0.0.01", // 前导零
  ];

  for (const variant of VARIANTS) {
    test(`${variant} 被拒绝，且解析器调用次数为 0`, async () => {
      const h = harness();
      const plan = await planLookingGlassTargets([{ host: variant, port: 80 }], { resolve: h.deps.resolve });
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.code).toBe(LOOKING_GLASS_CODES.addressNotCanonical);
      expect(h.resolveCalls).toEqual([]);
      expect(looksLikeAddressLiteralVariant(variant)).toBe(true);
    });
  }

  test("私网字面量同样不进解析器（且理由必须是 target_not_public，不是 invalid_hostname）", async () => {
    const h = harness();
    const plan = await planLookingGlassTargets([{ host: " 10.0.0.1 ", port: 80 }], { resolve: h.deps.resolve });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe(LOOKING_GLASS_CODES.targetNotPublic);
    expect(h.resolveCalls).toEqual([]);
  });

  test("正常域名才会进解析器（对照组，证明上面的 0 次不是替身坏了）", async () => {
    const h = harness();
    const plan = await planLookingGlassTargets([{ host: "example.com", port: 443 }], { resolve: h.deps.resolve });
    expect(plan.ok).toBe(true);
    expect(h.resolveCalls).toEqual(["example.com"]);
  });

  test("含空白/URL 字符的输入被拒（不给「解析一个 URL」的机会）", async () => {
    const h = harness();
    for (const bad of ["http://127.0.0.1", "93.184.216.34/24", "a b.com", "a\tb.com", "user@host.com"]) {
      const plan = await planLookingGlassTargets([{ host: bad, port: 80 }], { resolve: h.deps.resolve });
      expect(plan.ok).toBe(false);
    }
    expect(h.resolveCalls).toEqual([]);
  });

  test("特殊用途域名（.local/.localhost/.internal/.test）拒绝且不解析", async () => {
    const h = harness();
    for (const name of ["printer.local", "foo.localhost", "svc.internal", "x.test", "y.invalid", "z.home.arpa"]) {
      const plan = await planLookingGlassTargets([{ host: name, port: 80 }], { resolve: h.deps.resolve });
      expect(plan.ok, name).toBe(false);
      if (!plan.ok) expect(plan.code, name).toBe(LOOKING_GLASS_CODES.specialUseName);
    }
    expect(h.resolveCalls).toEqual([]);
  });
});

/* ================================================================== */
/* 3. 域名解析到私网 ⇒ 整请求拒绝                                        */
/* ================================================================== */

describe("WP19-D 别名域名打内网", () => {
  test("解析到私网地址 ⇒ 整请求拒绝，且零下发", async () => {
    const h = harness({}, { resolveTo: ["10.1.2.3"] });
    const plan = await run({ targets: [{ host: "internal.example.com", port: 443 }] }, h);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe(LOOKING_GLASS_CODES.targetNotPublic);
      expect(plan.status).toBe(400);
    }
    expect(h.issues).toEqual([]);
    // 拒绝也要留审计（这正是"有人在探内网"的信号）。
    const refused = h.audits.filter((a) => a.action === "looking_glass.test_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0].code).toBe(LOOKING_GLASS_CODES.targetNotPublic);
  });

  test("解析结果里混有私网 ⇒ 整请求拒绝（不是跳过私网那条）", async () => {
    const h = harness({}, { resolveTo: ["93.184.216.34", "169.254.169.254"] });
    const result = await run({ targets: [{ host: "mixed.example.com", port: 443 }] }, h);
    expect(result.ok).toBe(false);
    expect(h.issues).toEqual([]);
  });

  test("解析器返回非字符串 ⇒ 拒绝（不让坏替身变成坏事实）", async () => {
    const h = harness({}, { resolveTo: [42 as unknown as string] });
    const result = await run({ targets: [{ host: "x.example.com", port: 443 }] }, h);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(LOOKING_GLASS_CODES.resolverInvalid);
  });

  test("解析失败 ⇒ 明确拒绝而且**不退回**「让节点自己解析」", async () => {
    const h = harness({
      async resolve() {
        throw new Error("getaddrinfo ENOTFOUND x.example.com");
      },
    });
    const result = await run({ targets: [{ host: "x.example.com", port: 443 }] }, h);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(LOOKING_GLASS_CODES.targetUnresolved);
    expect(h.issues).toEqual([]);
  });

  test("解析出的地址数超过上限 ⇒ 拒绝而不是截断", async () => {
    const h = harness({}, { resolveTo: ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9"] });
    const result = await run({ targets: [{ host: "many.example.com", port: 443 }] }, h);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(LOOKING_GLASS_CODES.tooManyAddresses);
    expect(h.issues).toEqual([]);
  });
});

/* ================================================================== */
/* 4. 默认关闭 + 管理员例外                                              */
/* ================================================================== */

describe("WP19-D 部署级开关（默认关）", () => {
  test("开关解析：只有显式真值算开，拼写错误等于关", () => {
    for (const on of ["1", "true", "TRUE", " true ", "yes", "on", "On"]) {
      expect(lookingGlassEnabledFromEnv(on), on).toBe(true);
    }
    for (const off of [undefined, null, "", "0", "false", "no", "off", "ture", "enable", "2", "truee"]) {
      expect(lookingGlassEnabledFromEnv(off), String(off)).toBe(false);
    }
  });

  test("关闭 + 普通成员 ⇒ 403 明确拒绝（code/error_layer 都在），且零下发", async () => {
    const h = harness({ enabled: () => false });
    const result = await run({}, h);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe(LOOKING_GLASS_CODES.disabled);
      expect(result.error_layer).toBe("capability");
      // 明确拒绝 = 有话说，而不是"空结果"。
      expect(result.message).toContain("默认关闭");
      expect(result.message).toContain("LOOKING_GLASS_ENABLED");
    }
    expect(h.issues).toEqual([]);
  });

  test("关闭时的拒绝也写审计（谁在关着的部署上试过）", async () => {
    const h = harness({ enabled: () => false });
    await run({}, h);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].action).toBe("looking_glass.test_refused");
    expect(h.audits[0].code).toBe(LOOKING_GLASS_CODES.disabled);
    expect(h.audits[0].actor_user_id).toBe(42);
  });

  test("关闭 + 平台管理员 ⇒ 可用，但审计必须带 admin_override（D7④ 的前提）", async () => {
    const h = harness({ enabled: () => false });
    const result = await run({ isPlatformAdmin: true }, h);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.entry).toEqual({ enabled: false, admin_override: true });
    const issued = h.audits.find((a) => a.action === "looking_glass.test_issued");
    expect(issued?.admin_override).toBe(true);
  });

  test("开启时没有「管理员例外」这回事（admin_override 恒为 false）", async () => {
    const h = harness();
    const result = await run({ isPlatformAdmin: true }, h);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.entry.admin_override).toBe(false);
  });

  test("decideLookingGlassEntry 的三态是完整的（纯函数）", () => {
    expect(decideLookingGlassEntry({ enabled: true, isPlatformAdmin: false })).toEqual({
      allow: true,
      admin_override: false,
    });
    expect(decideLookingGlassEntry({ enabled: false, isPlatformAdmin: true })).toEqual({
      allow: true,
      admin_override: true,
    });
    expect(decideLookingGlassEntry({ enabled: false, isPlatformAdmin: false }).allow).toBe(false);
  });
});

/* ================================================================== */
/* 5. 跨租户                                                            */
/* ================================================================== */

describe("WP19-D 跨租户拒绝", () => {
  test("节点不属于本 workspace ⇒ 404，零下发，审计留痕", async () => {
    // 替身按 (nodeId, workspaceId) 判定：workspace 2 拿不到 workspace 1 的节点。
    const h = harness();
    const result = await runLookingGlass(
      { nodeId: NODE_ID, workspaceId: 2, actorUserId: 42, isPlatformAdmin: false, targets: [{ host: "93.184.216.34", port: 443 }] },
      h.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.code).toBe(LOOKING_GLASS_CODES.notFound);
      expect(result.error_layer).toBe("resource_scope");
    }
    expect(h.issues).toEqual([]);
    expect(h.resolveCalls).toEqual([]); // 连解析都不做：跨租户输入不触发任何网络活动
    expect(h.audits[0].action).toBe("looking_glass.test_refused");
  });

  test("节点查询按 (nodeId, workspaceId) 成对进行（传参本身就可断言）", async () => {
    const h = harness();
    await run({}, h);
    expect(h.nodeLookups).toEqual([{ nodeId: NODE_ID, workspaceId: WORKSPACE_ID }]);
  });
});

/* ================================================================== */
/* 6. 单节点单飞                                                        */
/* ================================================================== */

describe("WP19-D 单节点单飞（fail-closed）", () => {
  test("同一节点第二条并发请求被拒，第一条不受影响", async () => {
    const locks = new LookingGlassLocks();
    expect(locks.claim(1, 1000).ok).toBe(true);
    expect(locks.claim(1, 1001).ok).toBe(false);
    expect(locks.claim(2, 1001).ok).toBe(true); // 不同节点互不影响
    locks.release(1);
    expect(locks.claim(1, 1002).ok).toBe(true);
  });

  test("在途第二条请求 → 409 looking_glass_busy，零下发", async () => {
    const locks = new LookingGlassLocks();
    locks.claim(NODE_ID, Date.parse("2026-10-05T09:00:00.000Z"));
    const h = harness({ locks });
    const result = await run({}, h);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.code).toBe(LOOKING_GLASS_CODES.busy);
    }
    expect(h.issues).toEqual([]);
  });

  test("成功路径结束后释放（下一次请求可以跑）", async () => {
    const locks = new LookingGlassLocks();
    const h = harness({ locks });
    expect((await run({}, h)).ok).toBe(true);
    expect(locks.isHeld(NODE_ID, Date.parse("2026-10-05T09:00:00.000Z"))).toBe(false);
    expect((await run({}, h)).ok).toBe(true);
  });

  test("失败路径（能力拒绝/下发失败）也必须释放，否则节点被永久锁死", async () => {
    const locks = new LookingGlassLocks();
    const h = harness({
      locks,
      async capabilityFacts() {
        return {
          protocolVersion: 1,
          capabilities: ["apply_tunnel"],
          capabilitiesMalformed: false,
          manifest: null,
          manifestMalformed: false,
        };
      },
    });
    const first = await run({}, h);
    expect(first.ok).toBe(false);
    expect(locks.size()).toBe(0);
  });

  test("锁有 TTL：崩溃的请求不会永久拒掉该节点", () => {
    const locks = new LookingGlassLocks(1000);
    expect(locks.claim(9, 5000).ok).toBe(true);
    expect(locks.claim(9, 5500).ok).toBe(false);
    expect(locks.claim(9, 6000).ok).toBe(true); // TTL 到期后接管
  });
});

/* ================================================================== */
/* 7. 能力协商：未广告 ⇒ 入队前拒绝                                      */
/* ================================================================== */

describe("WP19-D 未广告动作（旧 Agent）", () => {
  function factsAdvertise(actions: string[] | null) {
    return {
      protocolVersion: 1,
      capabilities: actions,
      capabilitiesMalformed: false,
      manifest: null,
      manifestMalformed: false,
    };
  }

  test("能力清单里没有 looking_glass ⇒ 拒绝且**零下发**（不让调用者等超时）", async () => {
    const h = harness({ capabilityFacts: async () => factsAdvertise(["apply_tunnel", "diagnose_tunnel"]) });
    const result = await run({}, h);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.code).toBe("upgrade_required");
      expect(result.error_layer).toBe("runtime_admission");
      expect(result.message).toContain("looking_glass");
    }
    expect(h.issues).toEqual([]);
  });

  test("从未上报能力（旧 Agent）⇒ 同样拒绝（新动作不在 baseline 里）", async () => {
    const h = harness({ capabilityFacts: async () => factsAdvertise(null) });
    const result = await run({}, h);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("upgrade_required");
    expect(h.issues).toEqual([]);
  });

  test("能力上报坏形状 / 读不出来 ⇒ fail-closed（不是当成 baseline 放行）", async () => {
    const h = harness({
      async capabilityFacts() {
        return {
          protocolVersion: null,
          capabilities: null,
          capabilitiesMalformed: true,
          manifest: null,
          manifestMalformed: false,
        };
      },
    });
    const result = await run({}, h);
    expect(result.ok).toBe(false);
    expect(h.issues).toEqual([]);
  });

  test("广告了就能下发（对照组）", async () => {
    const h = harness();
    expect((await run({}, h)).ok).toBe(true);
    expect(h.issues).toHaveLength(1);
  });
});

/* ================================================================== */
/* 8. 结果完整性与脱敏                                                  */
/* ================================================================== */

describe("WP19-D 结果必须恰好覆盖请求集合", () => {
  const pinned = [{ address: "93.184.216.34", port: 443 }];

  test("少一条 ⇒ incomplete_result（半个结果会被读成「没问题」）", () => {
    const out = normalizeLookingGlassResults([], pinned);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe(LOOKING_GLASS_CODES.incompleteResult);
  });

  test("多一条（节点自己扫了别的地址）⇒ 拒绝", () => {
    const out = normalizeLookingGlassResults(
      [
        { host: "93.184.216.34", port: 443, status: "reachable", elapsed_ms: 1 },
        { host: "1.1.1.1", port: 443, status: "reachable", elapsed_ms: 1 },
      ],
      pinned,
    );
    expect(out.ok).toBe(false);
  });

  test("重复报告同一地址 ⇒ 拒绝", () => {
    const out = normalizeLookingGlassResults(
      [
        { host: "93.184.216.34", port: 443, status: "reachable", elapsed_ms: 1 },
        { host: "93.184.216.34", port: 443, status: "reachable", elapsed_ms: 1 },
      ],
      pinned,
    );
    expect(out.ok).toBe(false);
  });

  test("出现 resolved_ip ⇒ 整份拒绝（说明节点做了名称解析，边界被绕过）", () => {
    const out = normalizeLookingGlassResults(
      [{ host: "93.184.216.34", port: 443, status: "reachable", elapsed_ms: 1, resolved_ip: "93.184.216.34" }],
      pinned,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("resolved_ip");
  });

  test("状态必须是闭集；未知状态拒绝", () => {
    const bad = normalizeLookingGlassResults(
      [{ host: "93.184.216.34", port: 443, status: "probably_fine", elapsed_ms: 1 }],
      pinned,
    );
    expect(bad.ok).toBe(false);
    const good = normalizeLookingGlassResults(
      [{ host: "93.184.216.34", port: 443, status: "refused", elapsed_ms: 3 }],
      pinned,
    );
    expect(good.ok).toBe(true);
  });

  test("未知字段不进结果（逐字段重建，节点不能往面板产物里塞东西）", () => {
    const out = normalizeLookingGlassResults(
      [
        {
          host: "93.184.216.34",
          port: 443,
          status: "reachable",
          elapsed_ms: 2,
          detail: "connected",
          // 节点想塞进来的东西：
          credential: "node-credential-should-never-appear",
          payload: "GET / HTTP/1.1",
        },
      ],
      pinned,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(Object.keys(out.results[0]).sort()).toEqual(["address", "detail", "elapsed_ms", "port", "status"]);
      expect(JSON.stringify(out.results)).not.toContain("credential");
      expect(JSON.stringify(out.results)).not.toContain("GET /");
    }
  });

  test("detail 被截断到 160 字符（与 Agent 侧同一上限）", () => {
    const out = normalizeLookingGlassResults(
      [{ host: "93.184.216.34", port: 443, status: "error", elapsed_ms: 1, detail: "x".repeat(500) }],
      pinned,
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.results[0].detail?.length).toBe(160);
  });

  test("编排层：节点返回不完整结果 ⇒ 502 且不回给调用者半个成功", async () => {
    const h = harness({}, { issueResults: [] });
    const result = await run({}, h);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.code).toBe(LOOKING_GLASS_CODES.incompleteResult);
    }
    const completed = h.audits.filter((a) => a.action === "looking_glass.test_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].code).toBe(LOOKING_GLASS_CODES.incompleteResult);
  });

  test("编排层：成功报告带口径声明与钉死地址映射", async () => {
    const h = harness({}, { resolveTo: ["93.184.216.34", "93.184.216.35"] });
    const result = await run({ targets: [{ host: "example.com", port: 443 }] }, h);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.method).toBe("tcp_connect");
      expect(result.report.requested).toEqual([{ host: "example.com", port: 443 }]);
      expect(result.report.pinned.map((t) => t.address)).toEqual(["93.184.216.34", "93.184.216.35"]);
      expect(result.report.pinned_by_host).toEqual([{ host: "example.com", addresses: ["93.184.216.34", "93.184.216.35"] }]);
      expect(result.report.caveats).toEqual(LOOKING_GLASS_CAVEATS);
      // 口径里必须写清"这不证明业务可用"与"不测节点侧 DNS"。
      expect(result.report.caveats.join(" ")).toContain("不证明对端业务可用");
      expect(result.report.caveats.join(" ")).toContain("节点侧 DNS");
    }
  });
});

/* ================================================================== */
/* 9. 线形（控制协议）与上限                                             */
/* ================================================================== */

describe("WP19-D 控制协议线形", () => {
  test("looking_glass 进了动作白名单，且是只读、node 资源、无 revision 门槛", () => {
    expect((COMMAND_ACTIONS as readonly string[]).includes("looking_glass")).toBe(true);
    expect(ACTION_SPECS.looking_glass.mutating).toBe(false);
    expect(ACTION_SPECS.looking_glass.minRevision).toBe(0);
    expect(ACTION_SPECS.looking_glass.resources).toEqual(["node"]);
  });

  test("payload 键集是封闭的（多了就拒）", () => {
    expect([...ACTION_PAYLOAD_KEYS.looking_glass].sort()).toEqual(["method", "targets", "timeout_ms"]);
    expect(
      validatePayload("looking_glass", {
        method: "tcp_connect",
        targets: [{ address: "93.184.216.34", port: 443 }],
        host: "example.com",
      }),
    ).toMatch(/未定义字段/);
  });

  test("payload 校验：方法闭集 / 目标必填非空 / 上限 / 只接受字面地址", () => {
    expect(validatePayload("looking_glass", { method: "tcp_connect", targets: [] })).toMatch(/非空/);
    // 闭集纪律不变：**未知**方法必须被拒（这里用 ForwardX 有、我们明确不提供的
    // traceroute —— 它在 caps.unavailable_methods 里有原因，不是"漏了"）。
    expect(validatePayload("looking_glass", { method: "traceroute", targets: [{ address: "1.1.1.1", port: 1 }] })).toMatch(/method/);
    // task-40 扩进来的两种 ICMP 方法必须**通过**线形校验（否则面板发不出去）。
    expect(validatePayload("looking_glass", { method: "ping", targets: [{ address: "1.1.1.1", port: 1 }] })).toBeNull();
    expect(validatePayload("looking_glass", { method: "ping6", targets: [{ address: "2606:4700:4700::1111", port: 1 }] })).toBeNull();
    expect(validatePayload("looking_glass", { method: "tcp_connect", targets: [] })).toBeTruthy();
    expect(
      validatePayload("looking_glass", { method: "tcp_connect", targets: [{ address: "example.com", port: 443 }] }),
    ).toMatch(/字面 IP/);
    expect(
      validatePayload("looking_glass", { method: "tcp_connect", targets: [{ address: "1.1.1.1", port: 0 }] }),
    ).toMatch(/port/);
    const tooMany = Array.from({ length: LOOKING_GLASS_MAX_TARGETS + 1 }, (_, i) => ({ address: "1.1.1.1", port: 100 + i }));
    expect(validatePayload("looking_glass", { method: "tcp_connect", targets: tooMany })).toMatch(/上限/);
    expect(validatePayload("looking_glass", { method: "tcp_connect", targets: [{ address: "1.1.1.1", port: 80 }], timeout_ms: 999999 })).toMatch(/timeout_ms/);
    // 合法形状必须过（否则上面的"拒绝"断言可能只是因为整个 action 不可用）。
    expect(
      validatePayload("looking_glass", {
        method: "tcp_connect",
        targets: [{ address: "93.184.216.34", port: 443 }],
        timeout_ms: 3000,
      }),
    ).toBeNull();
  });

  test("线形上限必须 ≥ 服务层上限（否则合法请求会在本地被拒）", () => {
    expect(LOOKING_GLASS_MAX_TARGETS).toBeGreaterThanOrEqual(LOOKING_GLASS_MAX_REQUESTED_TARGETS);
    expect(WIRE_MAX_TIMEOUT_MS).toBeGreaterThanOrEqual(LOOKING_GLASS_MAX_TIMEOUT_MS);
  });

  test("createCommand 能构造 looking_glass 信封（动作 ↔ payload 配对正确）", () => {
    const envelope = createCommand({
      action: "looking_glass",
      resource: "node",
      resource_id: "node-7",
      revision: 0,
      payload: { method: "tcp_connect", targets: [{ address: "93.184.216.34", port: 443 }] },
    });
    expect(envelope.action).toBe("looking_glass");
    expect(envelope.resource).toBe("node");
    // 只读动作不得进入变更路径。
    expect(ACTION_SPECS.looking_glass.mutating).toBe(false);
  });

  test("编排层上限：目标数 / 方法 / 超时 / 重复目标", async () => {
    const h = harness();
    const tooMany = await run(
      { targets: Array.from({ length: LOOKING_GLASS_MAX_REQUESTED_TARGETS + 1 }, (_, i) => ({ host: "93.184.216.34", port: 100 + i })) },
      h,
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.code).toBe(LOOKING_GLASS_CODES.tooManyTargets);

    // 未知/本版本不提供的方法：`mtr` 正是 `LOOKING_GLASS_UNAVAILABLE_METHODS` 里的那个
    // （镜像无二进制 + 默认需 raw socket）——用它钉"闭集之外必须拒"。
    // （`traceroute` 自 task-42 起**在闭集内**，正向验证见下面那条独立测试。）
    const badMethod = await run({ method: "mtr" }, h);
    expect(badMethod.ok).toBe(false);
    if (!badMethod.ok) expect(badMethod.code).toBe(LOOKING_GLASS_CODES.methodNotSupported);

    const badTimeout = await run({ timeoutMs: 60_000 }, h);
    expect(badTimeout.ok).toBe(false);
    if (!badTimeout.ok) expect(badTimeout.code).toBe(LOOKING_GLASS_CODES.timeoutOutOfRange);

    const dup = await run({ targets: [{ host: "93.184.216.34", port: 80 }, { host: "93.184.216.34", port: 80 }] }, h);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe(LOOKING_GLASS_CODES.duplicateTarget);

    const empty = await run({ targets: [] }, h);
    expect(empty.ok).toBe(false);

    // 所有拒绝都发生在发包之前。
    expect(h.issues).toEqual([]);
  });

  test("task-40：ICMP 方法进闭集后，编排层真的把它**送下去**（不是认识但拒绝）", async () => {
    // 单独一个 harness：上面那条测试要断言"拒绝都发生在发包之前"，而这里**会**发包。
    // 家族匹配与目标策略由 agent 侧再判一次（那边有"先全校验再发第一个包"的纪律）。
    const h = harness();
    const icmp = await run({ method: "ping" }, h);
    expect(icmp.ok).toBe(true);
  });

  test("task-42：面板支持但该节点没上报方法能力 ⇒ 直接拒，且一条指令都不下发", async () => {
    const h = harness({
      async capabilityFacts() {
        return {
          protocolVersion: 2,
          // 只上报动作本身，**没有**方法级标注 ⇒ 该节点做不到 ping/traceroute。
          capabilities: ["apply_tunnel", "looking_glass"],
          capabilitiesMalformed: false,
          manifest: null,
          manifestMalformed: false,
        };
      },
    });
    const r = await run({ method: "traceroute" }, h);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(LOOKING_GLASS_CODES.methodUnavailableOnNode);
    // 关键：连"尝试下发"都没有 —— 不发注定失败的指令。
    expect(h.issues).toEqual([]);

    // 反向：`tcp_connect` 不需要方法级标注（它由动作本身表达），同一条事实下仍可下发。
    const tcp = await run({ method: "tcp_connect" }, h);
    expect(tcp.ok).toBe(true);
  });

  test("等 ACK 的总预算 = per-attempt × 地址数 + 余量，封顶 20s", () => {
    expect(lookingGlassAckWaitMs(LOOKING_GLASS_DEFAULT_TIMEOUT_MS, 1)).toBe(8000);
    expect(lookingGlassAckWaitMs(LOOKING_GLASS_DEFAULT_TIMEOUT_MS, 4)).toBe(17000);
    expect(lookingGlassAckWaitMs(LOOKING_GLASS_MAX_TIMEOUT_MS, 4)).toBe(20000); // 封顶
  });

  test("纯函数解析器：规范 IPv4 / IPv6 的正反例", () => {
    expect(parseCanonicalIPv4("93.184.216.34")).toBe(0x5db8d822);
    expect(parseCanonicalIPv4("0177.0.0.1")).toBeNull();
    expect(parseCanonicalIPv4("256.0.0.1")).toBeNull();
    expect(parseCanonicalIPv4("1.2.3")).toBeNull();
    expect(parseIPv6("2606:4700::1111")).not.toBeNull();
    expect(parseIPv6("2606:4700:::1111")).toBeNull();
    expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIPv6("::")).not.toBeNull();
    expect(parseIPv6("fe80::1%eth0")).toBeNull();
  });
});

/* ================================================================== */
/* 10. 审计纪律（不落载荷）                                              */
/* ================================================================== */

describe("WP19-D 审计纪律", () => {
  test("发起与完成各写一条，目标只记「地址:端口」，不含任何载荷", async () => {
    const h = harness();
    await run({}, h);
    expect(h.audits.map((a) => a.action)).toEqual(["looking_glass.test_issued", "looking_glass.test_completed"]);
    for (const row of h.audits) {
      expect(row.targets).toEqual(["93.184.216.34:443"]);
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain("credential");
      expect(serialized).not.toContain("token");
      // 审计里记的是目标与方法/结果码，不是探测产物本身。
      expect(Object.keys(row.detail ?? {})).not.toContain("payload");
    }
  });

  test("审计写不进去 ⇒ 拒绝发起（没有记录的主动探测不成立）", async () => {
    const h = harness({
      async audit() {
        return false;
      },
    });
    const result = await run({}, h);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.code).toBe(LOOKING_GLASS_CODES.auditUnavailable);
    }
    expect(h.issues).toEqual([]);
  });

  test("审计抛异常不允许把请求变成成功（fail-closed）", async () => {
    const h = harness({
      async audit() {
        throw new Error("audit db down");
      },
    });
    const result = await run({}, h);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(LOOKING_GLASS_CODES.auditUnavailable);
    expect(h.issues).toEqual([]);
  });

  test("审计里的 targets 是**钉死后的地址**（拒绝时是请求原文，便于追查）", async () => {
    const h = harness({}, { resolveTo: ["93.184.216.34"] });
    await run({ targets: [{ host: "example.com", port: 443 }] }, h);
    const issued = h.audits.find((a) => a.action === "looking_glass.test_issued");
    expect(issued?.targets).toEqual(["93.184.216.34:443"]);
    expect(issued?.detail?.requested).toEqual(["example.com:443"]);
  });
});

/* ================================================================== */
/* 11. 源码级"重建边界"守卫                                             */
/* ================================================================== */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface Boundary {
  readonly site: string;
  readonly file: string;
  readonly anchor: string;
  readonly required: readonly string[];
}

const WINDOW = 20;

/**
 * 新动作要穿过的边界（来自 ① 的踩坑清单：五个"逐字段重建"处，少一个的症状是
 * **每层都正常、控制面全绿、而面板永远读到 null**）。
 *
 * 本 WP 的取巧之处：**结果复用既有 ACK 字段 `results`**（`diagnose_tunnel` 已经把它
 * 走通了），因此 ACK 回程不需要新增字段——这本身就是"少加一个会漏的边界"的决策。
 * 但命令下行需要一个新兄弟字段（`looking_glass`），所以下行链的每一处都必须被钉住。
 */
const BOUNDARIES: readonly Boundary[] = [
  {
    site: "① 面板动作白名单",
    file: "services/control-protocol/types.ts",
    anchor: "looking_glass: { mutating: false",
    required: ["resources: [\"node\"]", "minRevision: 0"],
  },
  {
    site: "② 面板 payload 封闭键集",
    file: "services/control-protocol/validator.ts",
    anchor: "looking_glass: new Set([",
    required: ["method", "targets", "timeout_ms"],
  },
  {
    site: "③ 入 Redis 前的重建（命令体带上新兄弟字段）",
    file: "services/agent-command-bus.ts",
    anchor: "looking_glass?: QueuedLookingGlassRequest",
    required: ["method: string", "targets:", "address: string"],
  },
  {
    site: "③′ enqueue 真的把它放进队列项",
    file: "services/agent-command-bus.ts",
    anchor: "...(lookingGlass ? { looking_glass: lookingGlass } : {})",
    required: ["queued_at"],
  },
  {
    site: "③″ 下发函数把 payload 传进 enqueue（而不是只放在信封里）",
    file: "services/agent-command-bus.ts",
    anchor: "const lookingGlassRequest: QueuedLookingGlassRequest = {",
    required: ["method: input.method", "targets: payload.targets", "enqueueAgentCommand("],
  },
  {
    site: "④ HTTP 出站：命令对象整块透传（不是逐字段重建）",
    file: "routes/internal-node.ts",
    anchor: "const command = await dequeueAgentCommand",
    required: ["c.json({ data: { command } })"],
  },
  {
    site: "⑤ ACK 回程：HTTP 入口必须继续带 results",
    file: "routes/internal-node.ts",
    anchor: "await storeAgentCommandAck(auth.scope",
    required: ["results"],
  },
  {
    site: "⑥ ACK 入 Redis：looking_glass 的覆盖性校验不能漏",
    file: "services/agent-command-bus.ts",
    anchor: "const probeLike = pending.action === \"diagnose_tunnel\"",
    required: ["looking_glass"],
  },
  {
    site: "⑦ Agent 侧：分派臂调用 diag.LookingGlass 并回填 results",
    file: "../../agent/internal/control/client.go",
    anchor: "case ActionLookingGlass:",
    required: ["diag.LookingGlass", "ack.Results"],
  },
  {
    site: "⑧ Agent 侧：线形字段与面板一致（looking_glass 兄弟字段）",
    file: "../../agent/internal/control/client.go",
    anchor: "LookingGlass *diag.LookingGlassRequest",
    required: ["json:\"looking_glass,omitempty\""],
  },
  {
    site: "⑨ Agent 侧：动作被广告（否则面板永远不下发）",
    file: "../../agent/internal/control/protocol.go",
    anchor: "ActionLookingGlass = \"looking_glass\"",
    required: ["advertisedActions", "ActionLookingGlass,"],
  },
];

function windowOf(file: string, anchor: string): string {
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const at = lines.findIndex((l) => l.includes(anchor));
  expect(at, `${file} 里找不到锚点：${anchor}`).toBeGreaterThanOrEqual(0);
  return lines.slice(at, at + WINDOW).join("\n");
}

describe("WP19-D 源码级守卫：新动作要穿过每个逐字段重建处", () => {
  for (const boundary of BOUNDARIES) {
    test(`${boundary.site} 仍然带着它`, () => {
      const text = windowOf(boundary.file, boundary.anchor);
      for (const needle of boundary.required) {
        expect(text, `${boundary.site} 的窗口里缺少 ${needle}`).toContain(needle);
      }
    });
  }

  test("守卫不是空转：每个锚点唯一存在", () => {
    for (const boundary of BOUNDARIES) {
      const lines = readFileSync(join(ROOT, boundary.file), "utf8").split("\n");
      const hits = lines.filter((l) => l.includes(boundary.anchor)).length;
      expect(hits, `${boundary.file} 里锚点「${boundary.anchor}」出现 ${hits} 次（应为 1）`).toBe(1);
    }
  });

  test("面板侧不得自己拨目标（SSRF 边界：面板是控制面，不是探测代理）", () => {
    const text = readFileSync(join(ROOT, "services/looking-glass.ts"), "utf8");
    const executable = text
      .split("\n")
      .map((line) => {
        const cut = line.indexOf("//");
        return cut >= 0 ? line.slice(0, cut) : line;
      })
      .join("\n");
    for (const forbidden of ["fetch(", "node:net", "node:http", "node:https"]) {
      expect(executable, `looking-glass.ts 不得出现 ${forbidden}`).not.toContain(forbidden);
    }
    // 唯一的出站解析调用必须是 DNS。
    expect(executable).toContain("node:dns/promises");
  });
});

/* ================================================================== */
/* 12. 命令总线：新动作的兄弟字段 + ACK 覆盖性                            */
/* ================================================================== */

describe("WP19-D 命令总线（兄弟字段与 ACK 覆盖性）", () => {
  function memoryStore() {
    const values = new Map<string, string>();
    const lists = new Map<string, string[]>();
    const store: CommandBusStore = {
      async get(key) {
        return values.get(key) ?? null;
      },
      async del(key) {
        const had = values.delete(key);
        lists.delete(key);
        return had ? 1 : 0;
      },
      async push(key, value) {
        const list = lists.get(key) ?? [];
        list.push(value);
        lists.set(key, list);
      },
      async set(key, value) {
        values.set(key, value);
      },
      async setIfAbsent(key, value) {
        if (values.has(key)) return null;
        values.set(key, value);
        return "OK";
      },
      async shift(key) {
        const list = lists.get(key) ?? [];
        return list.shift() ?? null;
      },
    };
    return { store, values, lists };
  }

  async function enqueueOne(store: CommandBusStore, targets = [{ address: "93.184.216.34", port: 443 }]) {
    const envelope = createCommand({
      action: "looking_glass",
      resource: "node",
      resource_id: "node-7",
      revision: 0,
      payload: { method: "tcp_connect", targets },
    });
    await enqueueAgentCommand(7, envelope, null, store, undefined, { resolveScope: async () => 1 }, {
      method: "tcp_connect",
      targets,
      timeout_ms: 3000,
    });
    return envelope;
  }

  test("命令体带着 looking_glass 兄弟字段穿过队列（字段名与 Agent 侧一致）", async () => {
    const { store, lists } = memoryStore();
    await enqueueOne(store);
    const raw = [...lists.values()][0]?.[0] ?? "";
    expect(raw).toContain("\"looking_glass\"");
    expect(raw).toContain("\"tcp_connect\"");
    expect(raw).toContain("93.184.216.34");
    // 队列里必须是**钉死的地址**，不能是域名（Agent 不做解析）。
    expect(raw).not.toContain("example.com");

    const dequeued = await dequeueAgentCommand(1, 7, store);
    expect(dequeued?.looking_glass).toEqual({
      method: "tcp_connect",
      targets: [{ address: "93.184.216.34", port: 443 }],
      timeout_ms: 3000,
    });
    // 信封里的 payload 也带着同一个形状（两处不能漂移）。
    expect((dequeued?.envelope as { payload: { targets: unknown[] } }).payload.targets).toEqual([
      { address: "93.184.216.34", port: 443 },
    ]);
  });

  test("ACK 恰好覆盖 ⇒ 接受（走的是既有 results 字段，没有新增 ACK 字段）", async () => {
    const { store, values } = memoryStore();
    const envelope = await enqueueOne(store);
    await storeAgentCommandAck(1, 7, {
      command_id: envelope.command_id,
      action: "looking_glass",
      ok: true,
      applied_revision: 0,
      results: [{ host: "93.184.216.34", port: 443, status: "reachable", elapsed_ms: 4 }],
    }, store);
    const stored = [...values.values()].find((v) => v.includes("reachable"));
    expect(stored).toBeDefined();
    expect(stored).toContain("93.184.216.34");
  });

  test("ACK 漏报一个目标 ⇒ 拒绝（半个结果会被读成「没问题」）", async () => {
    const { store } = memoryStore();
    const envelope = await enqueueOne(store, [
      { address: "93.184.216.34", port: 443 },
      { address: "1.1.1.1", port: 443 },
    ]);
    await expect(
      storeAgentCommandAck(1, 7, {
        command_id: envelope.command_id,
        ok: true,
        applied_revision: 0,
        results: [{ host: "93.184.216.34", port: 443, status: "reachable", elapsed_ms: 4 }],
      }, store),
    ).rejects.toThrow(/missing target|results for/);
  });

  test("ACK 报告未请求的地址 ⇒ 拒绝（节点不能自己扩大扫描面）", async () => {
    const { store } = memoryStore();
    const envelope = await enqueueOne(store);
    await expect(
      storeAgentCommandAck(1, 7, {
        command_id: envelope.command_id,
        ok: true,
        applied_revision: 0,
        results: [{ host: "8.8.8.8", port: 53, status: "reachable", elapsed_ms: 4 }],
      }, store),
    ).rejects.toThrow(/unrequested target/);
  });

  test("ok=true 但没有 results ⇒ 拒绝（不许把「没答案」当成「没问题」）", async () => {
    const { store } = memoryStore();
    const envelope = await enqueueOne(store);
    await expect(
      storeAgentCommandAck(1, 7, {
        command_id: envelope.command_id,
        ok: true,
        applied_revision: 0,
      }, store),
    ).rejects.toThrow(/returned no results/);
  });
});
