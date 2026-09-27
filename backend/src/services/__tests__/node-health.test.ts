/**
 * V4-WP6 — Node health synthesis 离线单测（不连 DB / Redis / 网络）。
 *
 * 验收口径（`DEVELOPMENT.md` §13.4.4）：
 *   1. 四态语义：healthy / warning / error / unknown，且**各自有明确触发面**；
 *   2. `Offline` 是 Connection 状态，**不等价于 Health=error**（§13.4.4 末句）；
 *   3. `unknown` 覆盖「尚未安装 / 没有足够报告」，且**不**与故障混为一谈；
 *   4. 缺字段 = 未知 ≠ 0：旧 Agent 不报内存/负载时不得判资源超限；
 *   5. 单次历史错误降级 warning，持续错误才是 error；
 *   6. 版本落后用可比对的数字段判定，不可判定时给 info 而不是谎报落后；
 *   7. 理由码稳定（UI 靠它给下一步动作），严重度排序稳定。
 *
 * ── 为什么这些用例都用注入的 `now` ──
 * 判定涉及「上报是否过期 / 错误是否仍在持续」两类时间窗口。用真实时钟会让
 * 用例在写完之后失效（WP5 的固定时刻延时炸弹教训），因此一律注入 NOW 并把
 * 事实按相对偏移构造。
 */
import { test, expect, describe } from "bun:test";
import {
  HEALTH_THRESHOLDS,
  NODE_HEALTHS,
  isVersionOlder,
  parseHostMetrics,
  parseReportedRuntimes,
  parseRuntimeCounts,
  resourceReasons,
  synthesiseHealth,
  type HealthInput,
  type HostMetrics,
  type TelemetrySnapshot,
} from "../node-health.ts";

/** 固定「现在」，所有时间事实相对它构造（不读真实时钟）。 */
const NOW = new Date("2026-01-01T12:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

/** 一份「一切正常」的快照：在线、新鲜、无错误、revision 一致。 */
function healthySnapshot(over: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return {
    version: "1.4.0",
    role: "BOTH",
    reported_revision: 10,
    known_revision: 10,
    tunnels: [],
    used_ports: [],
    last_error: null,
    error_count: 0,
    last_error_at: null,
    agent_started_at: at(-3600_000),
    hostname: "node-a",
    os: "linux",
    arch: "amd64",
    runtime_counts: { direct: 0, relay_ingress: 0, relay_egress: 0, total: 0 },
    host_metrics: null,
    reported_at: at(-5_000),
    ...over,
  };
}

/** 一份「在线且事实齐全」的基础输入。 */
function input(over: Partial<HealthInput> = {}): HealthInput {
  return {
    status: "active",
    last_seen_at: at(-5_000),
    has_credential: true,
    credential_revoked: false,
    node_role: "both",
    node_version: "1.4.0",
    snapshot: healthySnapshot(),
    now: NOW,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* 1. 四态基本语义                                                     */
/* ------------------------------------------------------------------ */

describe("health 四态", () => {
  test("事实齐全且一致 → healthy，且没有任何理由", () => {
    const r = synthesiseHealth(input());
    expect(r.health).toBe("healthy");
    expect(r.connection).toBe("online");
    expect(r.reasons).toEqual([]);
    expect(r.flags.reports_fresh).toBe(true);
    expect(r.flags.revision_in_sync).toBe(true);
    expect(r.flags.agent_errors_ongoing).toBe(false);
    expect(r.flags.resources_ok).toBe(true);
  });

  test("四态枚举与 §13.4.1 完全一致", () => {
    expect([...NODE_HEALTHS]).toEqual(["healthy", "warning", "error", "unknown"]);
  });

  test("reason 严重度排序稳定（error → warning → info）", () => {
    const r = synthesiseHealth(
      input({
        snapshot: healthySnapshot({
          error_count: 3,
          last_error_at: at(-10_000),
          last_error: "apply_failed",
          host_metrics: { memory_total_bytes: 100, memory_used_bytes: 95 },
        }),
      }),
    );
    const severities = r.reasons.map((x) => x.severity);
    const rank = { error: 0, warning: 1, info: 2 } as const;
    const sorted = [...severities].sort((a, b) => rank[a] - rank[b]);
    expect(severities).toEqual(sorted);
    expect(r.health).toBe("error");
  });
});

/* ------------------------------------------------------------------ */
/* 2. unknown：尚未安装 / 没有足够报告                                 */
/* ------------------------------------------------------------------ */

describe("unknown — 没有足够事实", () => {
  test("尚未签发凭据（waiting）→ unknown + no_credential（不是 error）", () => {
    const r = synthesiseHealth(
      input({ has_credential: false, snapshot: null, last_seen_at: null }),
    );
    expect(r.connection).toBe("waiting");
    expect(r.health).toBe("unknown");
    expect(r.reasons.map((x) => x.code)).toEqual(["no_credential"]);
    expect(r.reasons[0].severity).toBe("info");
  });

  test("从未上报（无快照）→ unknown + never_reported", () => {
    const r = synthesiseHealth(input({ snapshot: null }));
    expect(r.health).toBe("unknown");
    expect(r.reasons.map((x) => x.code)).toEqual(["never_reported"]);
    expect(r.flags.reports_fresh).toBe(false);
  });

  test("快照存在但 reported_at 为空 → 仍按「从未上报」处理", () => {
    const r = synthesiseHealth(input({ snapshot: healthySnapshot({ reported_at: null }) }));
    expect(r.health).toBe("unknown");
    expect(r.reasons[0].code).toBe("never_reported");
  });
});

/* ------------------------------------------------------------------ */
/* 3. Offline ≠ error（§13.4.4 明文）                                  */
/* ------------------------------------------------------------------ */

describe("offline 是连接状态，不是健康故障", () => {
  test("status=inactive 且无其它事实 → unknown，不是 error", () => {
    const r = synthesiseHealth(input({ status: "inactive" }));
    expect(r.connection).toBe("offline");
    expect(r.health).toBe("unknown");
    expect(r.reasons.map((x) => x.code)).toEqual(["connection_offline"]);
  });

  test("心跳超窗（>90s）→ offline + unknown", () => {
    const r = synthesiseHealth(input({ last_seen_at: at(-120_000) }));
    expect(r.connection).toBe("offline");
    expect(r.health).toBe("unknown");
  });

  test("凭据已撤销 → offline（revoke 不是「还在等安装」）", () => {
    const r = synthesiseHealth(input({ credential_revoked: true }));
    expect(r.connection).toBe("offline");
    expect(r.health).toBe("unknown");
  });

  test("掉线但上次上报仍有告警 → unknown 且**保留** warning 理由（不抹平）", () => {
    const r = synthesiseHealth(
      input({
        status: "inactive",
        snapshot: healthySnapshot({ host_metrics: { memory_total_bytes: 100, memory_used_bytes: 95 } }),
      }),
    );
    expect(r.health).toBe("unknown");
    expect(r.reasons.map((x) => x.code)).toContain("resource_memory_high");
  });

  test("掉线 + 持续错误 → error（故障理由压过连接状态）", () => {
    const r = synthesiseHealth(
      input({
        status: "inactive",
        snapshot: healthySnapshot({ error_count: 1, last_error_at: at(-1_000), last_error: "boom" }),
      }),
    );
    expect(r.health).toBe("error");
    expect(r.reasons.some((x) => x.code === "agent_errors_ongoing")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 4. error：持续错误 / 关键 runtime 不可用                             */
/* ------------------------------------------------------------------ */

describe("error — 持续错误与关键 runtime 不可用", () => {
  test("窗口内仍有错误 → error + agent_errors_ongoing（带累计次数与消息）", () => {
    const r = synthesiseHealth(
      input({
        snapshot: healthySnapshot({
          error_count: 7,
          last_error_at: at(-30_000),
          last_error: "apply:apply_failed tunex-1-direct: dial tcp: refused",
        }),
      }),
    );
    expect(r.health).toBe("error");
    const reason = r.reasons.find((x) => x.code === "agent_errors_ongoing")!;
    expect(reason.severity).toBe("error");
    expect(reason.message).toContain("7");
    expect(reason.detail).toContain("dial tcp");
    expect(r.flags.agent_errors_ongoing).toBe(true);
  });

  test("错误窗口边界：恰好在窗口内 = 持续，超出 = 历史", () => {
    const inside = synthesiseHealth(
      input({ snapshot: healthySnapshot({ error_count: 1, last_error_at: at(-HEALTH_THRESHOLDS.errorRecentMs) }) }),
    );
    expect(inside.health).toBe("error");

    const outside = synthesiseHealth(
      input({ snapshot: healthySnapshot({ error_count: 1, last_error_at: at(-HEALTH_THRESHOLDS.errorRecentMs - 1) }) }),
    );
    expect(outside.health).toBe("warning");
    expect(outside.reasons.map((x) => x.code)).toContain("agent_errors_historical");
  });

  test("desired active 但快照里没有该 runtime → error + runtime_missing", () => {
    const r = synthesiseHealth(
      input({
        desired: [
          { label: "网站入口", runtime_id: "tunex-1-direct", wants_active: true, config_revision: 3 },
        ],
      }),
    );
    expect(r.health).toBe("error");
    const reason = r.reasons.find((x) => x.code === "runtime_missing")!;
    expect(reason.severity).toBe("error");
    // 面向用户的文案里用 Forward 名，不暴露内部 runtime id。
    expect(reason.message).toContain("网站入口");
    expect(reason.message).not.toContain("tunex-1-direct");
    expect(reason.detail).toBe("tunex-1-direct");
  });

  test("desired 未要求运行（inactive）且快照没有 → 不判 missing（这是正确状态）", () => {
    const r = synthesiseHealth(
      input({
        desired: [
          { label: "停用的转发", runtime_id: "tunex-2-direct", wants_active: false, config_revision: 4 },
        ],
      }),
    );
    expect(r.health).toBe("healthy");
  });

  test("apply_status=error → error + forward_apply_error（附错误原文）", () => {
    const r = synthesiseHealth(
      input({
        desired: [
          {
            label: "转发 A",
            runtime_id: "tunex-3-direct",
            wants_active: true,
            config_revision: 5,
            apply_status: "error",
            apply_error: "port already in use",
          },
        ],
      }),
    );
    expect(r.health).toBe("error");
    const reason = r.reasons.find((x) => x.code === "forward_apply_error")!;
    expect(reason.detail).toBe("port already in use");
  });
});

/* ------------------------------------------------------------------ */
/* 5. warning：在线但落后 / 历史错误 / 版本 / 资源                       */
/* ------------------------------------------------------------------ */

describe("warning — 在线但有需要关注的事实", () => {
  test("applied revision 落后于 desired → warning + runtime_revision_behind", () => {
    const r = synthesiseHealth(
      input({
        snapshot: healthySnapshot({
          tunnels: [{ id: "tunex-4-direct", mode: "DIRECT", revision: 2 }],
          reported_revision: 2,
          known_revision: 6,
        }),
        desired: [
          { label: "转发 B", runtime_id: "tunex-4-direct", wants_active: true, config_revision: 6 },
        ],
      }),
    );
    expect(r.health).toBe("warning");
    const reason = r.reasons.find((x) => x.code === "runtime_revision_behind")!;
    expect(reason.detail).toBe("2 < 6");
    expect(r.flags.revision_in_sync).toBe(false);
  });

  test("runtime 存在且 revision 一致 → 不判落后", () => {
    const r = synthesiseHealth(
      input({
        snapshot: healthySnapshot({
          tunnels: [{ id: "tunex-4-direct", mode: "DIRECT", revision: 6 }],
        }),
        desired: [
          { label: "转发 B", runtime_id: "tunex-4-direct", wants_active: true, config_revision: 6 },
        ],
      }),
    );
    expect(r.health).toBe("healthy");
    expect(r.flags.revision_in_sync).toBe(true);
  });

  test("多个 Forward 落后时每一条都出理由（不合并成一条模糊告警）", () => {
    const r = synthesiseHealth(
      input({
        snapshot: healthySnapshot({ tunnels: [] }),
        desired: [
          { label: "A", runtime_id: "tunex-1-direct", wants_active: true, config_revision: 1 },
          { label: "B", runtime_id: "tunex-2-direct", wants_active: true, config_revision: 1 },
        ],
      }),
    );
    // 两条都缺 runtime → 两条 error 理由（不是一条「有 2 个问题」）。
    expect(r.reasons.filter((x) => x.code === "runtime_missing")).toHaveLength(2);
  });

  test("Agent 版本落后 → warning + agent_version_behind", () => {
    const r = synthesiseHealth(
      input({ snapshot: healthySnapshot({ version: "1.3.9" }), expected_agent_version: "1.4.0" }),
    );
    expect(r.health).toBe("warning");
    expect(r.reasons.map((x) => x.code)).toContain("agent_version_behind");
  });

  test("版本相等 / 更新 → 不判落后", () => {
    expect(
      synthesiseHealth(input({ snapshot: healthySnapshot({ version: "1.4.0" }), expected_agent_version: "1.4.0" })).health,
    ).toBe("healthy");
    expect(
      synthesiseHealth(input({ snapshot: healthySnapshot({ version: "1.5.0" }), expected_agent_version: "1.4.0" })).health,
    ).toBe("healthy");
  });

  test("版本不可判定（unknown）→ info 而不是谎报落后", () => {
    const r = synthesiseHealth(
      input({ snapshot: healthySnapshot({ version: "unknown" }), expected_agent_version: "1.4.0" }),
    );
    expect(r.health).toBe("healthy"); // info 不升级 health
    expect(r.reasons.map((x) => x.code)).toEqual(["agent_version_unknown"]);
  });

  test("未配置期望版本时不判版本（无基线就没有「落后」）", () => {
    const r = synthesiseHealth(input({ snapshot: healthySnapshot({ version: "0.0.1" }) }));
    expect(r.health).toBe("healthy");
  });

  test("上报过期（> 错误窗口）→ warning + report_stale", () => {
    const r = synthesiseHealth(input({ snapshot: healthySnapshot({ reported_at: at(-200_000) }) }));
    expect(r.health).toBe("warning");
    expect(r.reasons.map((x) => x.code)).toContain("report_stale");
    expect(r.flags.reports_fresh).toBe(false);
  });

  test("自报角色与面板角色不一致 → warning（不覆盖面板设置）", () => {
    const r = synthesiseHealth(
      input({ snapshot: healthySnapshot({ role: "INGRESS" }), node_role: "both" }),
    );
    expect(r.health).toBe("warning");
    expect(r.reasons.map((x) => x.code)).toContain("role_mismatch");
  });

  test("角色大小写/空白不构成不一致（面板小写、Agent 大写是正常形态）", () => {
    const r = synthesiseHealth(input({ snapshot: healthySnapshot({ role: " BOTH " }), node_role: "both" }));
    expect(r.reasons).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 6. 资源阈值：只在字段真实存在时判定                                   */
/* ------------------------------------------------------------------ */

describe("资源阈值 — 未知字段绝不参与判定", () => {
  test("内存接近阈值 → warning + resource_memory_high", () => {
    const r = synthesiseHealth(
      input({ snapshot: healthySnapshot({ host_metrics: { memory_total_bytes: 1000, memory_used_bytes: 900 } }) }),
    );
    expect(r.health).toBe("warning");
    expect(r.reasons.map((x) => x.code)).toContain("resource_memory_high");
    expect(r.flags.resources_ok).toBe(false);
  });

  test("恰好等于阈值 → 告警（>= 语义，边界可断言）", () => {
    const metrics: HostMetrics = { memory_total_bytes: 100, memory_used_bytes: 85 };
    expect(resourceReasons(metrics, HEALTH_THRESHOLDS).map((x) => x.code)).toEqual(["resource_memory_high"]);
  });

  test("低于阈值 → 无理由", () => {
    const metrics: HostMetrics = { memory_total_bytes: 100, memory_used_bytes: 84 };
    expect(resourceReasons(metrics, HEALTH_THRESHOLDS)).toEqual([]);
  });

  test("只有 total 没有 used（旧 Agent 只报一半）→ 不判定", () => {
    expect(resourceReasons({ memory_total_bytes: 100 }, HEALTH_THRESHOLDS)).toEqual([]);
    expect(resourceReasons({ disk_total_bytes: 100 }, HEALTH_THRESHOLDS)).toEqual([]);
  });

  test("内存总量为 0（坏采样）→ 不判定，不产生 NaN 比例", () => {
    expect(resourceReasons({ memory_total_bytes: 0, memory_used_bytes: 0 }, HEALTH_THRESHOLDS)).toEqual([]);
  });

  test("磁盘使用率从 total/free 推导（free 是可用空间）", () => {
    const high: HostMetrics = { disk_total_bytes: 1000, disk_free_bytes: 100, disk_path: "/data" };
    const reasons = resourceReasons(high, HEALTH_THRESHOLDS);
    expect(reasons.map((x) => x.code)).toEqual(["resource_disk_high"]);
    expect(reasons[0].detail).toBe("/data");

    const ok: HostMetrics = { disk_total_bytes: 1000, disk_free_bytes: 500 };
    expect(resourceReasons(ok, HEALTH_THRESHOLDS)).toEqual([]);
  });

  test("free 超过 total（异常内核/容器）→ 使用率钳到 0，不给负数告警", () => {
    expect(resourceReasons({ disk_total_bytes: 100, disk_free_bytes: 500 }, HEALTH_THRESHOLDS)).toEqual([]);
  });

  test("负载按每核判定（同样的 load1 在核心多的机器上不告警）", () => {
    const small: HostMetrics = { cpu_count: 2, load1: 4 };
    const big: HostMetrics = { cpu_count: 16, load1: 4 };
    expect(resourceReasons(small, HEALTH_THRESHOLDS).map((x) => x.code)).toEqual(["resource_load_high"]);
    expect(resourceReasons(big, HEALTH_THRESHOLDS)).toEqual([]);
  });

  test("cpu_count 缺失时不判负载（无法知道「每核」是多少）", () => {
    expect(resourceReasons({ load1: 99 }, HEALTH_THRESHOLDS)).toEqual([]);
  });

  test("资源告警只到 warning，绝不单独升级为 error", () => {
    const r = synthesiseHealth(
      input({
        snapshot: healthySnapshot({
          host_metrics: { memory_total_bytes: 100, memory_used_bytes: 100, disk_total_bytes: 100, disk_free_bytes: 0, cpu_count: 1, load1: 50 },
        }),
      }),
    );
    expect(r.health).toBe("warning");
    expect(r.reasons.every((x) => x.severity === "warning")).toBe(true);
  });

  test("阈值可覆盖（部署方可调，不必改常量）", () => {
    const metrics: HostMetrics = { memory_total_bytes: 100, memory_used_bytes: 20 };
    expect(resourceReasons(metrics, { ...HEALTH_THRESHOLDS, memoryUsedRatio: 0.1 })).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 7. 形状解析：坏形状丢弃而不是猜                                       */
/* ------------------------------------------------------------------ */

describe("形状解析", () => {
  test("parseHostMetrics 只收已知键，坏类型忽略", () => {
    const got = parseHostMetrics({
      cpu_count: 4,
      load1: 0.5,
      memory_total_bytes: "8G", // 字符串：忽略而不是猜
      disk_path: "/",
      unknown_future_key: 1,
    });
    expect(got).toEqual({ cpu_count: 4, load1: 0.5, disk_path: "/" });
  });

  test("parseHostMetrics：非对象 / 空对象 → null", () => {
    expect(parseHostMetrics(null)).toBeNull();
    expect(parseHostMetrics([])).toBeNull();
    expect(parseHostMetrics("x")).toBeNull();
    expect(parseHostMetrics({})).toBeNull();
  });

  test("parseRuntimeCounts：只收四个已知计数，空对象 → null", () => {
    expect(parseRuntimeCounts({ direct: 1, relay_ingress: 2, relay_egress: 0, total: 3 })).toEqual({
      direct: 1,
      relay_ingress: 2,
      relay_egress: 0,
      total: 3,
    });
    expect(parseRuntimeCounts({})).toBeNull();
    expect(parseRuntimeCounts({ direct: "1" })).toBeNull();
  });

  test("parseReportedRuntimes：缺 id 的条目丢弃，坏形状整体按空列表", () => {
    expect(parseReportedRuntimes([{ id: "a", mode: "DIRECT" }, { mode: "DIRECT" }, null, "x"])).toEqual([
      { id: "a", mode: "DIRECT", ingress_port: null, egress_port: null, revision: null },
    ]);
    expect(parseReportedRuntimes("nope")).toEqual([]);
    expect(parseReportedRuntimes(null)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 8. 版本比较                                                          */
/* ------------------------------------------------------------------ */

describe("isVersionOlder", () => {
  test("数字段逐段比较", () => {
    expect(isVersionOlder("1.3.9", "1.4.0")).toBe(true);
    expect(isVersionOlder("1.4.0", "1.4.0")).toBe(false);
    expect(isVersionOlder("1.10.0", "1.9.0")).toBe(false); // 数字比较，不是字符串
    expect(isVersionOlder("2.0.0", "1.99.99")).toBe(false);
  });

  test("前缀 v / 空白容错", () => {
    expect(isVersionOlder("v1.2.0", " 1.3.0 ")).toBe(true);
  });

  test("段数不同：1.2 < 1.2.1，1.2.1 不旧于 1.2", () => {
    expect(isVersionOlder("1.2", "1.2.1")).toBe(true);
    expect(isVersionOlder("1.2.1", "1.2")).toBe(false);
  });

  test("预发布后缀按字典序（够用即可，不引 semver 库）", () => {
    expect(isVersionOlder("1.4.0-rc1", "1.4.0")).toBe(true);
  });

  test("无法判定 → null（unknown / 空 / 非数字起头）", () => {
    expect(isVersionOlder("unknown", "1.4.0")).toBeNull();
    expect(isVersionOlder("", "1.4.0")).toBeNull();
    expect(isVersionOlder(null, "1.4.0")).toBeNull();
    expect(isVersionOlder("latest", "1.4.0")).toBeNull();
  });
});
