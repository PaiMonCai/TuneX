/**
 * V5.2 §7（WP5/WP6）—— 目标健康面的契约与渲染不变量。
 *
 * 这份测试盯的是三件**契约要求**（不是界面口味）：
 *
 *   A. 镜像不许漂移：五个状态、19 个理由码、严重度全序、stale 阈值、`host:port`
 *      归一化，全部直接读 `backend/src/**` 的源码比对。后端改契约而前端没跟上 →
 *      这里立刻红。
 *   B. 五态必须各自可辨，且 `unknown` **永远不能读成健康**：徽标文案/变体/附加 class
 *      两两不同；`unknown` 的 label 与 hint 里必须出现「没有证据」；只有
 *      `healthy` 允许用 `success` 变体。三个展示归类函数是**穷尽 switch、没有
 *      default** —— 契约加第六个状态时它们会编译失败，而不是画出错的徽标。
 *   C. 事实必须能支撑「信不信这个结论」：观测年龄（客户端现算）、过期标注、
 *      连续失败/成功、成功率、抖动标记、以及**两个观测者都摊开**（并且不出现任何
 *      平均值）。不健康的目标必须仍然在表里，且**不能**看起来被移除或停用
 *      （期望状态列仍显示它自己的值）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import { TargetHealthBadge } from "@/components/admin/target-health-badge";
import {
  PoolTargetHealthView,
  healthStateCounts,
} from "@/components/admin/pool-target-health";
import { getDictionary, makeT } from "@/lib/i18n";
import {
  TARGET_HEALTH_REASONS,
  TARGET_HEALTH_REASON_TEXT,
  TARGET_HEALTH_SEVERITY_ORDER,
  TARGET_HEALTH_STALE_AFTER_MS,
  TARGET_HEALTH_STATES,
  TARGET_HEALTH_STATE_TEXT,
  buildTargetHealthRows,
  evidenceAgeMs,
  formatObservationAge,
  targetHealthBadgeClass,
  targetHealthBadgeVariant,
  targetHealthFreshness,
  targetHealthReasonText,
  targetHealthStateHint,
  targetHealthStateLabel,
  targetHealthVerdict,
  targetKeyOf,
  type TargetHealthState,
  type TargetHealthTargetView,
  type TargetPoolHealth,
} from "@/lib/target-health";
import type { EgressPool, EgressTarget } from "@/lib/types";

const WEB = (relative: string) =>
  readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");
const BACKEND = (relative: string) =>
  readFileSync(new URL(`../../../../../backend/${relative}`, import.meta.url), "utf8");

const MIRROR = WEB("lib/target-health.ts");
const BADGE = WEB("components/admin/target-health-badge.tsx");
const PANEL = WEB("components/admin/pool-target-health.tsx");

const render = (node: React.ReactElement, locale: "zh" | "en" = "zh") =>
  renderToStaticMarkup(
    <I18nProvider locale={locale} dict={getDictionary(locale)}>
      {node}
    </I18nProvider>,
  );

/* ================================================================== */
/* 夹具：与后端 `TargetHealthView` 同形的五态视图                        */
/* ================================================================== */

const NOW = Date.parse("2026-10-04T10:00:00.000Z");

function observerFixture(over: Record<string, unknown> = {}) {
  return {
    observer: { node_id: 6, probe: "tcp_connect" },
    observer_label: "6:tcp_connect",
    state: "healthy" as TargetHealthState,
    evidence: true,
    usable: true,
    stale: false,
    age_ms: 5_000,
    reasons: ["healthy_retained"] as string[],
    reachable: true,
    latency_ms: 40,
    consecutive_success: 8,
    consecutive_failure: 0,
    success_rate: 0.98,
    last_observed_at: new Date(NOW - 5_000).toISOString(),
    ...over,
  } as unknown as TargetHealthTargetView["observers"][number];
}

function targetFixture(over: Record<string, unknown> = {}): TargetHealthTargetView {
  return {
    target: "10.0.0.1:80",
    state: "healthy",
    reasons: [] as TargetHealthTargetView["reasons"],
    flapping: false,
    observers: [observerFixture()],
    facts: {
      evidence: true,
      observers: 1,
      fresh_observers: 1,
      stale_observers: 0,
      unusable_observers: 0,
      worst_observer: { node_id: 6, probe: "tcp_connect" },
      reachable: true,
      latency_ms: 40,
      consecutive_success: 8,
      consecutive_failure: 0,
      success_rate: 0.98,
      last_observed_at: new Date(NOW - 5_000).toISOString(),
      age_ms: 5_000,
      disagreement: false,
    },
    recent_flips: [],
    ...over,
  } as TargetHealthTargetView;
}

/** 五态各一条目标的池视图（全部带观测者，便于断言「两个都显示」）。 */
function fiveStatePool(): TargetPoolHealth {
  const makings: Array<[string, TargetHealthState, boolean]> = [
    ["10.0.0.1:80", "healthy", false],
    ["10.0.0.2:80", "degraded", false],
    ["10.0.0.3:80", "unhealthy", true],
    ["10.0.0.4:80", "recovering", false],
    ["10.0.0.5:80", "unknown", false],
  ];
  return {
    targets: makings.map(([target, state, disagreement]) => {
      const second = observerFixture({
        observer: { node_id: 9, probe: "tcp_connect" },
        observer_label: "9:tcp_connect",
        state: state === "unhealthy" ? "healthy" : state,
        consecutive_failure: state === "unhealthy" ? 0 : undefined,
        consecutive_success: state === "unhealthy" ? 11 : undefined,
        success_rate: state === "unhealthy" ? 0.96 : undefined,
      });
      const observers =
        state === "unknown"
          ? []
          : disagreement
            ? [
                observerFixture({
                  state: "unhealthy",
                  reachable: false,
                  latency_ms: null,
                  consecutive_success: 0,
                  consecutive_failure: 4,
                  success_rate: 0.4,
                }),
                second,
              ]
            : state === "recovering"
              ? [observerFixture({ state: "recovering", consecutive_success: 1, success_rate: 0.5 })]
              : [observerFixture({ state })];
      const facts = {
        ...targetFixture().facts,
        observers: observers.length,
        fresh_observers: observers.length,
        evidence: observers.length > 0,
        disagreement,
        consecutive_failure: state === "unhealthy" ? 4 : 0,
        success_rate: state === "unhealthy" ? 0.4 : 0.98,
      };
      return targetFixture({
        target,
        state,
        reasons: [
          state === "unknown" ? "no_observation" : "healthy_retained",
        ] as TargetHealthTargetView["reasons"],
        flapping: state === "unhealthy",
        observers,
        facts,
      });
    }),
    observers: [6, 9],
    observed_at: new Date(NOW).toISOString(),
  };
}

const pool = (targets: Array<Partial<EgressTarget>>, id = 2): Pick<EgressPool, "id" | "name" | "targets"> => ({
  id,
  name: "sg-relay-pool",
  targets: targets.map((over, index) => ({
    id: index + 1,
    pool_id: id,
    host: "10.0.0.1",
    port: 80,
    weight: 1,
    order_by: index * 10,
    remark: null,
    status: "active" as const,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  })) as EgressTarget[],
});

/* ================================================================== */
/* A. 镜像不许漂移                                                      */
/* ================================================================== */

function backendArray(source: string, name: string): string[] {
  const body = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(source)?.[1];
  expect(body, `${name} 必须在后端源码里`).toBeTruthy();
  return [...(body ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

describe("A. 契约镜像：状态 / 理由码 / 全序 / stale 阈值 / 目标键", () => {
  const backendSynthesis = BACKEND("src/services/target-health.ts");

  test("五个状态逐字等于后端 TARGET_HEALTH_STATES", () => {
    expect([...TARGET_HEALTH_STATES]).toEqual(
      backendArray(backendSynthesis, "TARGET_HEALTH_STATES"),
    );
    expect([...TARGET_HEALTH_STATES]).toEqual([
      "unknown",
      "healthy",
      "degraded",
      "unhealthy",
      "recovering",
    ]);
  });

  test("19 个理由码逐字等于后端 TARGET_HEALTH_REASONS", () => {
    expect([...TARGET_HEALTH_REASONS]).toEqual(
      backendArray(backendSynthesis, "TARGET_HEALTH_REASONS"),
    );
    // 每个码都必须有人话，且两种语言都不为空（漏一个码是**编译错误**，
    // 这里再钉一次运行时事实：没有空文案）
    for (const reason of TARGET_HEALTH_REASONS) {
      for (const locale of ["zh", "en"] as const) {
        const text = targetHealthReasonText(reason, locale);
        expect(text, `${locale}:${reason}`).not.toBe(reason);
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("严重度全序与后端一致（unknown < healthy < recovering < degraded < unhealthy）", () => {
    expect([...TARGET_HEALTH_SEVERITY_ORDER]).toEqual(
      backendArray(backendSynthesis, "TARGET_HEALTH_SEVERITY_ORDER"),
    );
  });

  test("stale 阈值 = 后端 3 × 上报周期（展示期重算用的镜像）", () => {
    const thresholds = BACKEND("src/services/target-health-thresholds.ts");
    const num = (name: string) =>
      Number(new RegExp(`${name}: ([0-9_]+)`).exec(thresholds)?.[1]?.replace(/_/g, ""));
    expect(num("STALE_AFTER_MS")).toBe(TARGET_HEALTH_STALE_AFTER_MS);
    expect(num("STALE_AFTER_MULTIPLIER")! * num("REPORT_INTERVAL_MS")!).toBe(
      TARGET_HEALTH_STALE_AFTER_MS,
    );
  });

  test("targetKeyOf 的归一化规则与后端 node-state.ts 同源", () => {
    const nodeState = BACKEND("src/services/node-state.ts");
    const body = /export function targetKeyOf\(host: string, port: number\): string \| null \{([\s\S]*?)\n\}/.exec(
      nodeState,
    )?.[1];
    expect(body).toBeTruthy();
    // 后端的三步归一化：trim+lowercase、去掉结尾点、去掉方括号
    expect(body).toContain("trim()");
    expect(body).toContain("toLowerCase()");
    expect(body).toContain(".replace(/\\.$/, \"\")");
    expect(body).toContain(".replace(/^\\[|\\]$/g, \"\")");
    // 行为等价（前端这份必须给出同样的键，否则期望目标与观测行会静默错位）
    expect(targetKeyOf(" 10.30.0.11 ", 8080)).toBe("10.30.0.11:8080");
    expect(targetKeyOf("10.30.0.11.", 8080)).toBe("10.30.0.11:8080");
    expect(targetKeyOf("[::1]", 443)).toBe("::1:443");
    expect(targetKeyOf("Host.EXAMPLE", 80)).toBe("host.example:80");
    expect(targetKeyOf("", 80)).toBeNull();
    expect(targetKeyOf("h", 0)).toBeNull();
    expect(targetKeyOf("h", 70000)).toBeNull();
  });
});

/* ================================================================== */
/* B. 五态可辨 + unknown 永不读成健康                                    */
/* ================================================================== */

describe("B. 五态各自可辨，且 unknown 只能读成「没有证据」", () => {
  test("每个状态的徽标文案两两不同，且只有 healthy 用 success 变体", () => {
    const labels = new Set<string>();
    const variants = new Set<string>();
    for (const state of TARGET_HEALTH_STATES) {
      for (const locale of ["zh", "en"] as const) {
        const label = targetHealthStateLabel(state, locale);
        expect(label.trim().length, `${locale}:${state}`).toBeGreaterThan(0);
        labels.add(`${locale}:${label}`);
        // hint 必须说明「这个状态是什么意思」，不能是空话
        expect(targetHealthStateHint(state, locale).length).toBeGreaterThan(8);
      }
      variants.add(targetHealthBadgeVariant(state));
    }
    expect(labels.size).toBe(TARGET_HEALTH_STATES.length * 2);
    // 变体 + 附加 class 组合两两不同（degraded 与 unknown 都走 outline，
    // 靠 class 区分，所以这里比较组合）
    const looks = new Set(
      TARGET_HEALTH_STATES.map((state) => `${targetHealthBadgeVariant(state)}|${targetHealthBadgeClass(state)}`),
    );
    expect(looks.size).toBe(TARGET_HEALTH_STATES.length);
    // 只有「健康」允许长得像成功
    expect(
      TARGET_HEALTH_STATES.filter((state) => targetHealthBadgeVariant(state) === "success"),
    ).toEqual(["healthy"]);
  });

  test("unknown 的标签与定义都表达「没有证据」，且绝不**声称**健康", () => {
    for (const locale of ["zh", "en"] as const) {
      const label = targetHealthStateLabel("unknown", locale);
      const hint = targetHealthStateHint("unknown", locale);
      // 徽标文字本身必须表达「没有证据」，而且不能出现「健康」这个词
      expect(label).toMatch(locale === "zh" ? /证据/ : /evidence/i);
      expect(label).not.toMatch(locale === "zh" ? /健康/ : /healthy/i);
      // 定义里必须**明确否认**健康（否定式出现「健康」是对的：它说的是「不是健康」）
      expect(hint).toMatch(
        locale === "zh" ? /既不是健康|不是健康/ : /neither healthy|not healthy/i,
      );
      expect(hint).not.toMatch(locale === "zh" ? /是健康的/ : /is healthy/i);
    }
    // 渲染出来的徽标：可见文案与 aria-label 都不得含「健康」字样
    const html = render(<TargetHealthBadge state="unknown" />, "zh");
    expect(html).toContain('data-target-health="unknown"');
    expect(html).toContain("无观测证据");
    expect(html).not.toContain(">健康<");
    expect(html).not.toContain("健康</span>");
  });

  test("结论归类：unknown 是单独一档，不与「需要注意」或「好」混同", () => {
    expect(targetHealthVerdict("unknown")).toBe("no-evidence");
    expect(targetHealthVerdict("healthy")).toBe("ok");
    expect(targetHealthVerdict("recovering")).toBe("attention");
    expect(targetHealthVerdict("degraded")).toBe("attention");
    expect(targetHealthVerdict("unhealthy")).toBe("attention");
    const buckets = new Set(TARGET_HEALTH_STATES.map((state) => targetHealthVerdict(state)));
    expect(buckets.size).toBe(3);
  });

  test("展示归类是穷尽 switch、没有 default：加第六个状态会是编译错误", () => {
    // 三个函数的源码都必须列全五个 case，且不得出现 default 兜底
    for (const fn of ["targetHealthBadgeVariant", "targetHealthBadgeClass", "targetHealthVerdict"]) {
      const start = MIRROR.indexOf(`export function ${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      const body = MIRROR.slice(start, MIRROR.indexOf("\n}", start));
      for (const state of TARGET_HEALTH_STATES) {
        expect(body, `${fn} 缺 ${state}`).toContain(`case "${state}":`);
      }
      expect(body, `${fn} 不得有 default`).not.toMatch(/\bdefault:/);
    }
    // 文案表用 Record<TargetHealthState, …>：漏一个状态同样是编译错误
    expect(MIRROR).toContain("Record<\n  TargetHealthState,");
    expect(Object.keys(TARGET_HEALTH_STATE_TEXT).sort()).toEqual([...TARGET_HEALTH_STATES].sort());
    expect(Object.keys(TARGET_HEALTH_REASON_TEXT).sort()).toEqual([...TARGET_HEALTH_REASONS].sort());
    // 徽标组件本身不许自己写状态判断（必须走那三个穷尽函数）。
    // 注释里会**提到**这种反模式（说明为什么禁止），所以先剥注释再断言代码。
    expect(BADGE).toContain("targetHealthBadgeVariant(state)");
    const badgeCode = BADGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(badgeCode).not.toContain('state === "healthy"');
    expect(badgeCode).not.toMatch(/switch \(state\)/);
  });

  test("五态的徽标静态渲染两两不同（data-target-health + 变体 + class）", () => {
    const html = new Map(
      TARGET_HEALTH_STATES.map((state) => [state, render(<TargetHealthBadge state={state} />)]),
    );
    for (const [state, markup] of html) {
      expect(markup).toContain(`data-target-health="${state}"`);
      expect(markup).toContain(targetHealthStateLabel(state, "zh"));
    }
    expect(new Set(html.values()).size).toBe(TARGET_HEALTH_STATES.length);
  });
});

/* ================================================================== */
/* C. 事实：年龄 / 过期 / 观测者 / 不健康目标仍可见                        */
/* ================================================================== */

describe("C. 证据事实：年龄现算、过期标注、两个观测者都摊开", () => {
  test("age 以 observed_at 为锚用本地时钟重算（不落库、不冻结）", () => {
    const observedAt = new Date(NOW).toISOString();
    // 后端在 observed_at 那一刻算出的 age 是 5s
    expect(evidenceAgeMs(5_000, observedAt, NOW)).toBe(5_000);
    // 页面挂到 2 分钟后：同一条证据应该被读成 125s，而不是继续显示 5s
    expect(evidenceAgeMs(5_000, observedAt, NOW + 120_000)).toBe(125_000);
    // 缺 age 事实 → null（「不知道」不得当成新鲜）
    expect(evidenceAgeMs(null, observedAt, NOW)).toBeNull();
    // observed_at 不可解析 / 时钟回拨 → 不缩小 age（宁可显得旧）
    expect(evidenceAgeMs(5_000, "not-a-date", NOW)).toBe(5_000);
    expect(evidenceAgeMs(5_000, observedAt, NOW - 60_000)).toBe(5_000);
  });

  test("过期判定与 §7 同口径（严格大于），null 是「未知」而不是「新鲜」", () => {
    expect(targetHealthFreshness(TARGET_HEALTH_STALE_AFTER_MS)).toBe("fresh");
    expect(targetHealthFreshness(TARGET_HEALTH_STALE_AFTER_MS + 1)).toBe("stale");
    expect(targetHealthFreshness(null)).toBe("unknown");
    expect(targetHealthFreshness(0)).toBe("fresh");
    // 人读时长：null 不许渲染成 0
    expect(formatObservationAge(null, "zh")).toBe("未知");
    expect(formatObservationAge(5_000, "zh")).toContain("5");
    expect(formatObservationAge(120_000, "en")).toContain("2m");
  });

  test("页面挂久后证据被标为过期（客户端现算，而不是沿用后端那一刻的结论）", () => {
    const health = fiveStatePool();
    const fresh = render(
      <PoolTargetHealthView pool={pool([{ host: "10.0.0.1", port: 80 }])} health={health} status="ready" now={NOW} />,
    );
    expect(fresh).toContain("证据新鲜");
    expect(fresh).toContain('data-testid="target-health-last-observed"');
    expect(fresh).toContain("最近观测时刻");
    expect(fresh).not.toContain('data-testid="target-health-stale"');

    const aged = render(
      <PoolTargetHealthView
        pool={pool([{ host: "10.0.0.1", port: 80 }])}
        health={health}
        status="ready"
        now={NOW + TARGET_HEALTH_STALE_AFTER_MS + 1_000}
      />,
    );
    expect(aged).toContain('data-testid="target-health-stale"');
    expect(aged).toContain("证据已过期（等同于没有证据）");
  });

  test("五态池一次渲染里：五态齐全、汇总各计一次、顺序是契约全序（坏消息先）", () => {
    const targets = ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5"].map((host) => ({
      host,
      port: 80,
    }));
    const health = fiveStatePool();
    const html = render(
      <PoolTargetHealthView pool={pool(targets)} health={health} status="ready" now={NOW} />,
    );
    // 五个状态各自渲染出自己的徽标（没有 unknown 被吞掉、也没有被画成 healthy）
    for (const state of TARGET_HEALTH_STATES) {
      expect(html, state).toContain(`data-target-health="${state}"`);
    }
    const order = [...html.matchAll(/data-testid="target-health-count-(\w+)"/g)].map(
      (match) => match[1],
    );
    expect(order).toEqual(["unhealthy", "degraded", "recovering", "healthy", "unknown"]);
    const rows = buildTargetHealthRows(targets, health);
    expect(healthStateCounts(rows)).toEqual({
      unknown: 1,
      healthy: 1,
      degraded: 1,
      unhealthy: 1,
      recovering: 1,
    });
  });

  test("两个观测者都显示，并且不出现任何平均值", () => {
    const health: TargetPoolHealth = {
      targets: [targetFixture({ target: "10.0.0.1:80", state: "unhealthy" })],
      observers: [6, 9],
      observed_at: new Date(NOW).toISOString(),
    };
    const one = observerFixture({
      state: "unhealthy",
      reachable: false,
      latency_ms: null,
      consecutive_success: 0,
      consecutive_failure: 4,
      success_rate: 0.4,
    });
    const two = observerFixture({
      observer: { node_id: 9, probe: "tcp_connect" },
      observer_label: "9:tcp_connect",
      reachable: true,
      latency_ms: 120,
      consecutive_success: 11,
      consecutive_failure: 0,
      success_rate: 0.96,
    });
    health.targets[0]!.observers = [one, two];
    health.targets[0]!.facts = {
      ...health.targets[0]!.facts,
      observers: 2,
      disagreement: true,
      consecutive_failure: 4,
      success_rate: 0.4,
    };
    const html = render(
      <PoolTargetHealthView pool={pool([{ host: "10.0.0.1", port: 80 }])} health={health} status="ready" now={NOW} />,
    );
    // 两条观测都在（标签 + 各自的结论）
    expect(html).toContain("6:tcp_connect");
    expect(html).toContain("9:tcp_connect");
    // 两条观测者明细都在（不是合成成一条），且各自带自己的结论徽标
    expect((html.match(/data-testid="target-health-observer-/g) ?? []).length).toBe(2);
    const observerBlock = html.slice(
      html.indexOf('data-testid="target-health-observers"'),
      html.indexOf('data-testid="target-health-disagreement"'),
    );
    expect(observerBlock).toContain('data-target-health="unhealthy"');
    expect(observerBlock).toContain('data-target-health="healthy"');
    expect(html).toContain("不可达");
    expect(html).toContain("96%");
    // 「已取最坏、未做平均」必须说出来
    expect(html).toContain('data-testid="target-health-disagreement"');
    expect(html).toContain("未做平均");
    // 平均值 (0.4+0.96)/2 = 68% 不得出现在页面上
    expect(html).not.toContain("68%");
    // 「结论不一致」只在目标层说一次（不是每个观测者行重复一遍）
    expect((html.match(/未做平均/g) ?? []).length).toBe(1);
    // 观测方节点也必须可见（空数组时另有说明）
    expect(html).toContain("节点 6, 9");
  });

  test("不健康的目标仍然在表里，且不被画成「已移除 / 已停用」", () => {
    const targets = [
      { host: "10.0.0.1", port: 80, status: "active" as const },
      { host: "10.0.0.2", port: 80, status: "active" as const },
      { host: "10.0.0.3", port: 80, status: "active" as const },
    ];
    const health: TargetPoolHealth = {
      targets: targets.map((target, index) =>
        targetFixture({
          target: `${target.host}:${target.port}`,
          state: (["healthy", "degraded", "unhealthy"] as const)[index] ?? "unknown",
          facts: { ...targetFixture().facts, evidence: true },
        }),
      ),
      observers: [6],
      observed_at: new Date(NOW).toISOString(),
    };
    const html = render(
      <PoolTargetHealthView pool={pool(targets)} health={health} status="ready" now={NOW} />,
    );
    // 三行都在（不因为状态被过滤）
    expect((html.match(/data-testid="target-health-row-reported-/g) ?? []).length).toBe(3);
    expect(html).toContain('data-target-health="unhealthy"');
    // 期望状态列仍然是 active（观测不会把它改成 inactive、也不呈现为已移除）
    expect(html).not.toContain("inactive");
    expect(html).not.toContain("已删除");
    // 这一块里没有任何写入口（观测没有删除权）
    expect(html).not.toContain("删除目标");
    expect(PANEL).not.toContain("removeTarget");
    expect(PANEL).not.toContain("api.admin.removeTarget");
    // 汇总计数：五态各计一次，且 «无证据» 单独一档
    const rows = buildTargetHealthRows(targets, health);
    expect(healthStateCounts(rows)).toEqual({
      unknown: 0,
      healthy: 1,
      degraded: 1,
      unhealthy: 1,
      recovering: 0,
    });
  });

  test("行集由期望清单决定：缺行按「没有证据」，多出来的观测行也不隐藏", () => {
    const targets = [
      { host: "10.0.0.1", port: 80 },
      { host: "10.0.0.2", port: 80 },
    ];
    const health: TargetPoolHealth = {
      targets: [
        targetFixture({ target: "10.0.0.1:80" }),
        // 期望清单里没有这一条（期望刚刚变化）
        targetFixture({ target: "10.0.0.9:80", state: "unknown" }),
      ],
      observers: [6],
      observed_at: new Date(NOW).toISOString(),
    };
    const html = render(
      <PoolTargetHealthView pool={pool(targets)} health={health} status="ready" now={NOW} />,
    );
    // 期望里的 10.0.0.2:80 没有健康行 → 按未知渲染并留在表里
    expect(html).toContain("target-health-row-missing-10.0.0.2:80");
    expect(html).toContain('data-testid="target-health-missing"');
    expect(html).toContain("服务端未返回该目标的健康视图");
    // 期望外的观测行也显示（收到的事实不静默丢弃）
    expect(html).toContain("target-health-row-unexpected-10.0.0.9:80");
    // 行序照期望清单
    const order = [...html.matchAll(/data-testid="target-health-row-(\w+)-([^"]+)"/g)].map(
      (match) => match[2],
    );
    expect(order.slice(0, 2)).toEqual(["10.0.0.1:80", "10.0.0.2:80"]);
  });

  test("连接用的是归一化后的 target 键（大小写/结尾点/方括号不影响匹配）", () => {
    const rows = buildTargetHealthRows(
      [{ host: "10.30.0.11.", port: 8080 }, { host: "[::1]", port: 443 }],
      {
        targets: [
          targetFixture({ target: "10.30.0.11:8080" }),
          targetFixture({ target: "::1:443" }),
        ],
      },
    );
    expect(rows.map((row) => row.kind)).toEqual(["reported", "reported"]);
  });

  test("「没有事实」不被渲染成一串 0/—：无证据目标明说没有可用事实", () => {
    const health: TargetPoolHealth = {
      targets: [targetFixture({ target: "10.0.0.1:80", state: "unknown", observers: [] })],
      observers: [],
      observed_at: new Date(NOW).toISOString(),
    };
    // 真实后端对未观测目标给的是「全 null 的 facts」：界面不得把它显示成 0 或一整行破折号
    health.targets[0]!.facts = {
      ...health.targets[0]!.facts,
      evidence: false,
      observers: 0,
      fresh_observers: 0,
      reachable: null,
      latency_ms: null,
      consecutive_success: null,
      consecutive_failure: null,
      success_rate: null,
      age_ms: null,
      last_observed_at: null,
      worst_observer: null,
      disagreement: false,
    };
    const html = render(
      <PoolTargetHealthView pool={pool([{ host: "10.0.0.1", port: 80 }])} health={health} status="ready" now={NOW} />,
    );
    expect(html).toContain('data-testid="target-health-no-facts"');
    expect(html).toContain("没有可用的观测事实");
    // 绝对时刻与相对年龄并排（缺 last_observed_at 时不渲染这一格）
    expect(html).not.toContain('data-testid="target-health-last-observed"');
    expect(html).toContain("没有任何节点观测过这个目标");
    // 契约定义必须可见（灰徽标不足以说明「这不是故障也不是健康」）
    expect(html).toContain('data-testid="target-health-no-evidence"');
    expect(html).toContain("既不是健康，也不是故障");
    // 不出现「连续失败: 0」这类把缺失当零的渲染
    expect(html).not.toContain("连续失败: 0");
  });

  test("没有任何观测者时，池级说明必须说清「所有目标都只能是无证据」", () => {
    const health: TargetPoolHealth = {
      targets: [targetFixture({ target: "10.0.0.1:80", state: "unknown", observers: [] })],
      observers: [],
      observed_at: new Date(NOW).toISOString(),
    };
    const html = render(
      <PoolTargetHealthView pool={pool([{ host: "10.0.0.1", port: 80 }])} health={health} status="ready" now={NOW} />,
    );
    expect(html).toContain("没有任何节点参与观测");
    // 一条 healthy 都没有：未知绝不能被画成健康
    expect(html).not.toContain('data-target-health="healthy"');
  });

  test("取数三态分开：loading / error 都不会渲染成「没有目标」", () => {
    const loading = render(
      <PoolTargetHealthView pool={pool([{ host: "10.0.0.1", port: 80 }])} health={null} status="loading" />,
    );
    expect(loading).toContain('data-testid="target-health-loading"');
    expect(loading).not.toContain("该池还没有目标");

    const failed = render(
      <PoolTargetHealthView
        pool={pool([{ host: "10.0.0.1", port: 80 }])}
        health={null}
        status="error"
        error="boom"
      />,
    );
    expect(failed).toContain('data-testid="target-health-error"');
    expect(failed).toContain("boom");
    // 读不到观测时，期望目标仍然列出来（按未知），而不是空表
    expect(failed).toContain("target-health-row-missing-10.0.0.1:80");

    const empty = render(
      <PoolTargetHealthView pool={pool([])} health={{ targets: [], observers: [], observed_at: new Date(NOW).toISOString() }} status="ready" />,
    );
    expect(empty).toContain("该池还没有目标");
  });
});

/* ================================================================== */
/* D. 词条与接线                                                        */
/* ================================================================== */

describe("D. 词条与接线", () => {
  test("界面词条中英齐备（状态/理由码文案在镜像模块，其余在 admin.targetHealth）", () => {
    const keys = [
      "title",
      "hint",
      "loading",
      "failed",
      "refresh",
      "stateLabel",
      "snapshotAt",
      "snapshotAge",
      "age",
      "lastObserved",
      "stale",
      "fresh",
      "ageUnknown",
      "flapping",
      "consecutiveFailure",
      "consecutiveSuccess",
      "successRate",
      "latency",
      "reachable",
      "unreachable",
      "reachableUnknown",
      "observers",
      "observersNone",
      "disagreement",
      "reasons",
      "missingRow",
      "unexpectedRow",
      "desiredStatusTitle",
      "desiredStatus",
      "noFacts",
      "noObservingNodes",
      "empty",
      "retry",
    ] as const;
    for (const locale of ["zh", "en"] as const) {
      const dict = getDictionary(locale).admin as Record<string, unknown>;
      const group = dict.targetHealth as Record<string, unknown> | undefined;
      expect(group, `${locale}.admin.targetHealth`).toBeTruthy();
      const t = makeT(getDictionary(locale));
      for (const key of keys) {
        expect(typeof group?.[key], `${locale}.${key}`).toBe("string");
        expect((group?.[key] as string).length, `${locale}.${key}`).toBeGreaterThan(0);
        expect(t(`admin.targetHealth.${key}`), `${locale}.${key}`).not.toBe(
          `admin.targetHealth.${key}`,
        );
      }
    }
  });

  test("接线：池面板引用了健康块；api 用的是后端的真实路径（单数 node）", () => {
    const panel = WEB("components/admin/node-egress-pools-panel.tsx");
    expect(panel).toContain("<PoolTargetHealth pool={pool} />");
    const api = WEB("lib/api.ts");
    expect(api).toContain("poolTargetHealth: (poolId: ID, cookie?: string)");
    expect(api).toContain("/admin/node/pools/${poolId}/health");
    expect(api).not.toContain("/admin/nodes/${poolId}/health");
  });

  test("端点路径与响应字段逐字对齐后端路由（后端改路由 → 这里红）", () => {
    const routes = BACKEND("src/routes/node-admin.ts");
    // 路径（单数 node；api.ts 侧会加 `/api` 前缀与信封解包）
    expect(routes).toContain('nodeAdminRoutes.get("/node/pools/:poolId/health"');
    // 响应字段：{ targets, observers, observed_at }
    expect(routes).toContain("targets: result.health.targets");
    expect(routes).toContain("observers: result.health.observers");
    expect(routes).toContain("observed_at: result.health.now.toISOString()");
    // 镜像里的响应类型就是这三个字段（多一个字段就必须两边一起加）
    const typeBody = /export interface TargetPoolHealth \{([\s\S]*?)\n\}/.exec(MIRROR)?.[1] ?? "";
    const fields = [...typeBody.matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1]);
    expect(fields.sort()).toEqual(["observers", "observed_at", "targets"].sort());
  });
});
