/**
 * V4-WP6 — Agent 上报契约（遥测段）离线测试。
 *
 * 验收口径（`DEVELOPMENT.md` §13.4.4「状态报告至少覆盖」的逐条落地）：
 *   · 形状校验 fail-closed：给错了类型的遥测字段必须被拒（而不是静默丢字段），
 *     否则「面板显示 0 内存」比「面板显示未知」更危险；
 *   · 缺失 ≠ 0：旧 Agent 不报的字段落 NULL（health 判 unknown），
 *     空对象/空数组才是「现在是空的」这个有意义的事实；
 *   · `started_at` / `last_error_at` 的 0 视为「没有这个事实」→ NULL，
 *     不能变成 1970-01-01（会让 UI 显示「错误发生在 56 年前」）；
 *   · 超长 hostname 被拦（避免 MySQL 严格模式 500 连带丢掉整份上报）；
 *   · 未知字段一律容忍（协议演进：先加后删）。
 *
 * ── 与 node-credential.test.ts 的加载顺序 ──
 * 本文件只 import 被测模块的**纯函数**（validateStateReport / telemetryColumns），
 * 不发任何 DB/Redis 请求。`node-state.ts` 顶层 import `db.ts` 与
 * `node-credential.ts`（后者 import `redis.ts`）：bun 的文件加载顺序是字母序，
 * `node-credential.test.ts` 先于本文件把这两个模块的替身注册进进程级注册表，
 * 因此这里拿到的是已求值的模块实例（其 db/redis 绑定指向替身）。
 * 本文件刻意**不**注册自己的 mock.module——再注册一次不同形状的替身会把
 * 先加载文件的用例打挂（见 lifecycle-db-stub.ts 顶部说明）。
 */
import { test, expect, describe } from "bun:test";
import { Prisma } from "@prisma/client";
import { telemetryColumns, validateStateReport, targetKeyOf } from "../node-state.ts";

/** 一份最小的合法上报（含 WP7 既有字段）。 */
const BASE = {
  version: "1.4.0",
  role: "BOTH",
  reported_revision: 12,
};

/* ------------------------------------------------------------------ */
/* 校验：fail-closed                                                   */
/* ------------------------------------------------------------------ */

describe("validateStateReport — 遥测段形状校验", () => {
  test("完整遥测载荷通过，字段原样带出", () => {
    const r = validateStateReport({
      ...BASE,
      known_revision: 12,
      started_at: 1_700_000_000,
      hostname: "node-a",
      os: "linux",
      arch: "amd64",
      runtime_counts: { direct: 2, relay_ingress: 1, relay_egress: 1, total: 4 },
      host: {
        cpu_count: 4,
        load1: 0.42,
        load5: 0.3,
        load15: 0.2,
        memory_total_bytes: 8_000_000_000,
        memory_used_bytes: 2_000_000_000,
        disk_path: "/",
        disk_total_bytes: 100_000_000_000,
        disk_free_bytes: 40_000_000_000,
        host_uptime_seconds: 86_400,
        process_rss_bytes: 42_000_000,
      },
      error_count: 3,
      last_error_at: 1_700_000_100,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.known_revision).toBe(12);
    expect(r.report.hostname).toBe("node-a");
    expect(r.report.os).toBe("linux");
    expect(r.report.arch).toBe("amd64");
    expect(r.report.error_count).toBe(3);
    expect(r.report.runtime_counts).toEqual({ direct: 2, relay_ingress: 1, relay_egress: 1, total: 4 });
    expect(r.report.host?.cpu_count).toBe(4);
  });

  test("只报一部分遥测也合法（协议演进：Agent 可以逐步补齐）", () => {
    expect(validateStateReport({ ...BASE, hostname: "only-host" }).ok).toBe(true);
    expect(validateStateReport({ ...BASE, runtime_counts: {} }).ok).toBe(true);
    expect(validateStateReport({ ...BASE, host: {} }).ok).toBe(true);
    expect(validateStateReport({ ...BASE, error_count: 0 }).ok).toBe(true);
  });

  test("坏形状一律拒绝（fail-closed，不静默丢字段）", () => {
    for (const bad of [
      { known_revision: "12" },
      { known_revision: -1 },
      { known_revision: 1.5 },
      { started_at: "1700000000" },
      { started_at: -1 },
      { hostname: 42 },
      { os: null },
      { arch: ["amd64"] },
      { runtime_counts: [] },
      { runtime_counts: { direct: "2" } },
      { runtime_counts: { unknown_kind: 1 } }, // 未知**种类**不是未知字段：计数种类是枚举
      { host: "linux" },
      { host: { cpu_count: "4" } },
      { host: { memory_used_bytes: -1 } },
      { host: { load1: "0.4" } },
      { host: { load1: Number.NaN } },
      { host: { disk_path: 5 } },
      { error_count: "3" },
      { last_error_at: "1700000100" },
    ]) {
      const r = validateStateReport({ ...BASE, ...bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBeTruthy();
    }
  });

  test("hostname 超长被拦（MySQL 严格模式 500 会连带丢掉隧道与端口）", () => {
    expect(validateStateReport({ ...BASE, hostname: "x".repeat(255) }).ok).toBe(true);
    const tooLong = validateStateReport({ ...BASE, hostname: "x".repeat(256) });
    expect(tooLong.ok).toBe(false);
  });

  test("os / arch 的上限按列宽（VarChar(32)）而不是共用一个 255", () => {
    // 列的宽度由迁移 20261010000000 决定：os/arch 是 VarChar(32)。
    // 共用 255 的话，40 字符的 os 会通过校验、再被 MySQL 严格模式
    // `ERROR 1406 (22001) Data too long` 拒掉 → 整份上报 500。
    expect(validateStateReport({ ...BASE, os: "x".repeat(32), arch: "x".repeat(32) }).ok).toBe(true);
    expect(validateStateReport({ ...BASE, os: "x".repeat(33) }).ok).toBe(false);
    expect(validateStateReport({ ...BASE, arch: "x".repeat(33) }).ok).toBe(false);
    expect(validateStateReport({ ...BASE, os: "x".repeat(255) }).ok).toBe(false);
  });

  test("未知顶层字段继续容忍（与 WP7 同一口径）", () => {
    expect(validateStateReport({ ...BASE, future_telemetry: { a: 1 } }).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 映射：缺失 ≠ 0                                                      */
/* ------------------------------------------------------------------ */

describe("telemetryColumns — 载荷 → 列", () => {
  test("全缺失 → 全部 null/JsonNull（旧 Agent 不上报，面板按未知处理）", () => {
    const r = validateStateReport(BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cols = telemetryColumns(r.report);
    expect(cols.known_revision).toBeNull();
    expect(cols.agent_started_at).toBeNull();
    expect(cols.hostname).toBeNull();
    expect(cols.os).toBeNull();
    expect(cols.arch).toBeNull();
    expect(cols.error_count).toBeNull();
    expect(cols.last_error_at).toBeNull();
    // JSON 列：未上报用 Prisma.JsonNull（SQL NULL 语义），不是 `{}`——
    // `{}` 会被读成「有采样但字段全缺」，与「旧 Agent 根本不报」混为一谈。
    expect(cols.runtime_counts).toBe(Prisma.JsonNull);
    expect(cols.host_metrics).toBe(Prisma.JsonNull);
  });

  test("unix 秒 → Date（面板侧统一用 Date 存，展示时再格式化）", () => {
    const r = validateStateReport({ ...BASE, started_at: 1_700_000_000, last_error_at: 1_700_000_500 });
    if (!r.ok) throw new Error("should pass");
    const cols = telemetryColumns(r.report);
    expect(cols.agent_started_at).toBeInstanceOf(Date);
    expect(cols.agent_started_at!.getTime()).toBe(1_700_000_000_000);
    expect(cols.last_error_at!.getTime()).toBe(1_700_000_500_000);
  });

  test("0 / 缺失的时间戳 → null（不变成 1970-01-01）", () => {
    const zero = validateStateReport({ ...BASE, started_at: 0, last_error_at: 0 });
    if (!zero.ok) throw new Error("should pass");
    const cols = telemetryColumns(zero.report);
    expect(cols.agent_started_at).toBeNull();
    expect(cols.last_error_at).toBeNull();
  });

  test("0 是合法计数（error_count=0 表示「确实没出错」，与未知不同）", () => {
    const r = validateStateReport({ ...BASE, error_count: 0 });
    if (!r.ok) throw new Error("should pass");
    expect(telemetryColumns(r.report).error_count).toBe(0);
  });

  test("空对象 vs 缺失：空对象保留为 JSON（「现在是空的」是事实）", () => {
    const r = validateStateReport({ ...BASE, runtime_counts: {}, host: {} });
    if (!r.ok) throw new Error("should pass");
    const cols = telemetryColumns(r.report);
    expect(cols.runtime_counts).toEqual({});
    expect(cols.host_metrics).toEqual({});
  });

  test("映射逐字段（不丢字段、不改名）", () => {
    const r = validateStateReport({
      ...BASE,
      known_revision: 7,
      hostname: "h",
      os: "linux",
      arch: "amd64",
      error_count: 2,
      runtime_counts: { direct: 1 },
      host: { cpu_count: 8 },
    });
    if (!r.ok) throw new Error("should pass");
    expect(telemetryColumns(r.report)).toEqual({
      known_revision: 7,
      agent_started_at: null,
      hostname: "h",
      os: "linux",
      arch: "amd64",
      runtime_counts: { direct: 1 },
      host_metrics: { cpu_count: 8 },
      error_count: 2,
      last_error_at: null,
      // V4-WP11B: an Agent that reports no negotiation facts keeps them NULL —
      // "never told us" must stay distinguishable from "supports nothing".
      // capabilities is a JSON column, so "absent" is Prisma.JsonNull.
      control_protocol_version: null,
      capabilities: Prisma.JsonNull,
      // V5-WP1: the same rule for the v2 manifest — an old Agent that never
      // reported one must stay NULL, never an empty object (an empty object
      // would read as "I implement nothing" and fail every dispatch closed).
      capability_manifest: Prisma.JsonNull,
    });
  });
});

/**
 * V4-WP11B regression: a Go nil slice marshals to `null`, and every RELAY
 * ingress tunnel has no targets of its own. Treating that as a type error made
 * those nodes' state reports permanently 400 — losing telemetry and health for
 * exactly the nodes that relay traffic. Absent and null describe the same fact.
 */
describe("state report tolerates null where a field is optional", () => {
  test("a RELAY tunnel with targets:null is accepted, not rejected", () => {
    const r = validateStateReport({
      ...BASE,
      tunnels: [{ id: "tunex-2-relay", mode: "RELAY", targets: null, next_hop: "10.0.0.1:22001" }],
    });
    expect(r.ok).toBe(true);
  });

  test("targets:[] and an absent targets key stay accepted too", () => {
    for (const targets of [[], undefined]) {
      const r = validateStateReport({
        ...BASE,
        tunnels: [{ id: "tunex-2-relay", mode: "RELAY", ...(targets === undefined ? {} : { targets }) }],
      });
      expect(r.ok).toBe(true);
    }
  });

  test("a wrong non-null shape is still rejected", () => {
    for (const targets of ["none", 7, { host: "x" }, [1]]) {
      const r = validateStateReport({ ...BASE, tunnels: [{ id: "t", mode: "DIRECT", targets }] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("bad_tunnels");
    }
  });
});

/* ================================================================== */
/* V5-WP5-A3：协议专属诊断随上报一同穿过                              */
/* ================================================================== */

/**
 * Agent 侧新增的 `diag` 是**每个隧道条目上的附加字段**，面板必须原样收下：
 *
 *   · 校验层不能因为「出现了没见过的字段」拒绝整份上报 —— 那会让整个节点的遥测
 *     和健康一起消失（`bad_tunnels` 是整份 400），代价远大于收益；
 *   · 也不能把它投影丢掉：证书到期时间与握手失败次数是运维在 TLS 前端出问题时
 *     唯一能看的东西，而它们只存在于 Agent 观测到的那一刻。
 *
 * 这条契约靠「容忍未知字段」实现，因此必须被测试钉住：有人为了「严格」加一条
 * 白名单，就会把这两个字段连同整份上报一起拒掉。
 */
describe("protocol diagnostics ride through the state report (V5-WP5-A3)", () => {
  const base = {
    agent_id: "agent-1",
    node_id: "WP14-IN-A-NODE",
    ts: 1_800_000_000,
    host: { cpu_cores: 2, mem_total: 512, agent_version: "1.0.0" },
  };

  test("a tunnel carrying a tls diag block is accepted", () => {
    const result = validateStateReport({
      ...base,
      tunnels: [
        {
          id: "tunex-1-direct",
          mode: "DIRECT",
          ingress_port: 21000,
          revision: 3,
          protocol: "tls",
          diag: {
            protocol: "tls",
            cert_subject: "CN=site.example",
            cert_not_after: 1_893_456_000,
            cert_rotations: 2,
            handshake_failures: 7,
            last_handshake_error: "tls: first record does not look like a TLS handshake",
            last_handshake_error_at: 1_800_000_100,
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("a ws diag block is accepted, and a diag-less tunnel stays valid", () => {
    const result = validateStateReport({
      ...base,
      tunnels: [
        { id: "tunex-2-direct", mode: "DIRECT", ingress_port: 21001, revision: 1, protocol: "ws", diag: { protocol: "ws", upgrade_refused: 4 } },
        { id: "tunex-3-direct", mode: "DIRECT", ingress_port: 21002, revision: 1, protocol: "tcp" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("a malformed diag block does not invalidate the whole report", () => {
    // 诊断是**信息**：形状不对也只是这条信息没用，不能因此让整个节点的上报
    // 消失。这与 capability manifest 的 fail-closed 不同 —— 那份是准入依据，
    // 这份是观测结果，误判的代价方向相反。
    const result = validateStateReport({
      ...base,
      tunnels: [{ id: "tunex-4-direct", mode: "DIRECT", ingress_port: 21003, revision: 1, diag: "not-an-object" }],
    });
    expect(result.ok).toBe(true);
  });
});

/* ================================================================== */
/* V5.2 WP5：目标观测上报（Observation 是事实，不是 desired）             */
/* ================================================================== */

describe("target observations ride the state report (V5.2 WP5)", () => {
  const base = {
    agent_id: "agent-1",
    node_id: "WP14-OUT-A-NODE",
    ts: 1_800_000_000,
    host: { cpu_cores: 2, mem_total: 512, agent_version: "1.0.0" },
  };
  const entry = (over: Record<string, unknown> = {}) => ({
    host: "10.0.0.5",
    port: 8080,
    reachable: true,
    latency_ms: 12,
    consecutive_success: 7,
    consecutive_failure: 0,
    success_rate: 1,
    last_observed_at: 1_800_000_000,
    observation_source: "3/tcp_connect",
    ...over,
  });

  test("the validated report KEEPS the observations (the whitelist trap)", () => {
    // 这条断言防的是本文件上文注释里写的那个陷阱：字段校验通过、但没列进
    // 返回白名单 → 静默丢失，症状是"上报 200、投影永远为空"。
    const result = validateStateReport({ ...base, target_observations: [entry()] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.target_observations).toHaveLength(1);
    expect(result.report.target_observations?.[0]).toMatchObject({
      host: "10.0.0.5",
      port: 8080,
      reachable: true,
      latency_ms: 12,
      success_rate: 1,
      observation_source: "3/tcp_connect",
    });
  });

  test("a malformed ENTRY is dropped, not the whole report", () => {
    // 观测是**附加证据**：一条坏记录只是那一条没用。若照 tunnels 的严格度让整份
    // 上报 400，一个观测字段的类型错误就会把节点的遥测、健康、隧道列表一起黑掉。
    const result = validateStateReport({
      ...base,
      tunnels: [{ id: "tunex-1-direct", mode: "DIRECT", ingress_port: 21000, revision: 1 }],
      target_observations: [
        entry(),
        entry({ port: 0 }),
        entry({ reachable: "yes" }),
        entry({ last_observed_at: 0 }),
        entry({ observation_source: "" }),
        "not-an-object",
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.target_observations).toHaveLength(1);
    // 隧道列表不受影响：这两件事的失败域必须分开。
    expect(result.report.tunnels).toHaveLength(1);
  });

  test("a non-array payload is a rejection, because it is a different claim", () => {
    // 「不是数组」与「数组里有坏记录」不是同一件事：前者说明上报方对契约的理解
    // 就是错的，后者只是一条记录坏了。
    const result = validateStateReport({ ...base, target_observations: { host: "x" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad_target_observations");
  });

  test("an unreachable target reports NO latency, never zero", () => {
    // 0 是"瞬间可达"，不是"没有测量"。两者混用会让面板把"连不上"显示成"极快"。
    const result = validateStateReport({
      ...base,
      target_observations: [entry({ reachable: false, latency_ms: 0 })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.target_observations?.[0]?.latency_ms).toBeNull();
  });

  test("an agent that reports nothing leaves the projection alone (`undefined` ≠ empty)", () => {
    // 这个区别是要害：字段存在且为空数组 = "我会观测，此刻没有观测"；
    // 字段不存在 = "我没有观测能力"。把后者当空集会清空整张投影，
    // 把"没有证据"伪造成"刚观测过且什么都没有"。
    const result = validateStateReport({ ...base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.target_observations).toBeUndefined();
  });

  test("host is normalised so one target has one identity", () => {
    const result = validateStateReport({
      ...base,
      target_observations: [entry({ host: "  Example.COM.  " })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.target_observations?.[0]?.host).toBe("example.com");
    expect(targetKeyOf("Example.COM.", 443)).toBe("example.com:443");
    expect(targetKeyOf("[::1]", 443)).toBe("::1:443");
    expect(targetKeyOf("", 443)).toBeNull();
    expect(targetKeyOf("host", 0)).toBeNull();
  });

  test("no `observation_age` on the wire — age is derived by the reader", () => {
    const result = validateStateReport({
      ...base,
      target_observations: [entry({ observation_age: 5 } as never)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.report.target_observations?.[0] as unknown as Record<string, unknown>;
    expect(first.observation_age).toBeUndefined();
  });
});
