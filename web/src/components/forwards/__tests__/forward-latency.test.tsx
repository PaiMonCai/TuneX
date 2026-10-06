/**
 * D6 端点的 Web 消费面（Forward 详情第三块卡片：延迟历史）。
 *
 * 这个文件守的是**读法**，不是像素。用真实响应样本（scratch 集成拓扑
 * 2026-10-06T17:08Z 抓到的 DIRECT / RELAY 两条 200、以及 409 / 400 / 404 的错误体）钉住：
 *
 *   1. `status` 四态是唯一判据：`ok` / `no_samples` / `no_observer` / `ambiguous_target`
 *      各有独立 testid 与文案，**不能**都渲染成「没有数据」（它们都可能是空序列）；
 *   2. `latency_ms: null` = 那一次没有测得 ⇒ 折线**断开**，不补 0、不插值
 *      （真实档案里 97 个点中 62 个 null、7 个真 0 —— 两者必须能分辨）；
 *   3. **409 `raw_window_expired` ≠ 200 `no_samples`**：前者是"档案里没有那段原始样本"，
 *      后者是"那段时间没有观测"；
 *   4. `truncated: true` 显式呈现（截断过的线不许冒充完整曲线）；
 *   5. 维度只在服务端推导：请求体里**没有** `node_id` / `target_key`；
 *   6. 取不到时文案不出现「正常 / 健康 / 可达」；切 Workspace 丢弃晚到响应。
 *
 * 跑法（web 目录）：bun test src/components/forwards/__tests__/forward-latency.test.tsx
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import {
  ForwardLatencyPanel,
  createLatencyScopeGuard,
  deniedLatencyState,
  latencyChartGeometry,
  latencyErrorInfo,
  latencyGate,
  latencyPollIntervalMs,
  loadLatencyState,
  resetLatencyState,
  type ForwardLatencyState,
  type LatencyQuery,
} from "@/components/forwards/forward-latency";
import {
  LATENCY_POLL_MS,
  LATENCY_WINDOW_MAX_HOURS,
  type ForwardLatencyPoint,
  type ForwardLatencyResponse,
} from "@/lib/api/forwards";
import { ApiError } from "@/lib/api/core";
import { getDictionary } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";

/* ================================================================== */
/* 真实样本                                                             */
/* ================================================================== */

/** `GET /api/forwards/1/latency?granularity=sample&hours=1` 的真实响应（DIRECT，逐字）。 */
const DIRECT_NO_OBSERVER: ForwardLatencyResponse = {
  forward_id: 1,
  mode: "direct",
  granularity: "sample",
  window: { from: "2026-10-06T16:08:56.636Z", to: "2026-10-06T17:08:56.636Z", hours: 1 },
  dimension: null,
  status: "no_observer",
  reason: "direct_not_observed",
  series: [],
  truncated: false,
};

/**
 * `GET /api/forwards/2/latency?granularity=sample&hours=1` 的真实形状（RELAY，`ok`）。
 *
 * 点值取自真实响应：真实的 97 个点里有 62 个 `latency_ms: null`（那一次没有测得）和
 * 7 个真的 `0`。这里保留这两种点，正是为了让"null 不补零、0 不是缺失"两条断言有意义。
 */
const RELAY_OK: ForwardLatencyResponse = {
  forward_id: 2,
  mode: "relay",
  granularity: "sample",
  window: { from: "2026-10-06T16:08:57.017Z", to: "2026-10-06T17:08:57.017Z", hours: 1 },
  dimension: { observer_node_id: 2, target_key: "target-b:3030" },
  status: "ok",
  reason: null,
  series: [
    point("2026-10-06T16:09:17.000Z", 0),
    point("2026-10-06T16:09:51.000Z", 1),
    point("2026-10-06T16:10:21.000Z", null),
    point("2026-10-06T16:10:51.000Z", 3),
    point("2026-10-06T16:11:29.000Z", null),
    point("2026-10-06T16:12:01.000Z", 0),
    point("2026-10-06T16:12:31.000Z", 12),
  ],
  truncated: false,
};

/**
 * `GET /api/forwards/2/latency?granularity=hour&hours=24` 的真实响应（维度成立，但窗口内零样本）。
 *
 * 抓取于 2026-10-06T17:08Z；此后同一个 URL 开始返回 `ok`（小时桶随观测累积出了一条）——
 * 也就是说 `no_samples` 是**时间性**的：窗口成立、维度成立，只是那一刻档案里还没有桶。
 * 这正是它必须与 409「档案里已经没有那段样本」分开的理由。
 */
const RELAY_NO_SAMPLES: ForwardLatencyResponse = {
  forward_id: 2,
  mode: "relay",
  granularity: "hour",
  window: { from: "2026-10-05T17:08:57.190Z", to: "2026-10-06T17:08:57.190Z", hours: 24 },
  dimension: { observer_node_id: 2, target_key: "target-b:3030" },
  status: "no_samples",
  reason: null,
  series: [],
  truncated: false,
};

/** 多目标：与后端 `ambiguous_target` 的响应形状逐字段同形（只给数量，不给目标清单）。 */
const RELAY_AMBIGUOUS: ForwardLatencyResponse = {
  forward_id: 3,
  mode: "relay",
  granularity: "sample",
  window: { from: "2026-10-06T16:08:57.352Z", to: "2026-10-06T17:08:57.352Z", hours: 1 },
  dimension: null,
  status: "ambiguous_target",
  reason: "multiple_targets",
  candidate_targets: 3,
  series: [],
  truncated: false,
};

function point(at: string, latency_ms: number | null): ForwardLatencyPoint {
  return {
    at,
    latency_ms,
    samples: 1,
    successes: latency_ms === null ? 0 : 1,
    failures: latency_ms === null ? 1 : 0,
    latency_min_ms: latency_ms,
    latency_max_ms: latency_ms,
    observation_source: "Integration-OUT-A-NODE/tcp_connect",
  };
}

const data = (response: ForwardLatencyResponse): ForwardLatencyState => ({
  status: "data",
  query: { granularity: response.granularity, hours: response.window.hours },
  response,
  error: null,
});

const render = (state: ForwardLatencyState, locale: Locale = "zh") =>
  renderToStaticMarkup(
    <I18nProvider locale={locale} dict={getDictionary(locale)}>
      <ForwardLatencyPanel state={state} />
    </I18nProvider>,
  );

const visibleText = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const countOf = (html: string, needle: string) => html.split(needle).length - 1;

/**
 * 结论词纪律：界面不得出现「正常 / 健康 / 可达」这类我们拿不到证据的结论。
 *
 * 与拓扑卡片不同，本模块的文案里**连否定式**都不含这三个词（不写「不代表正常」），
 * 所以这里可以直接按字面断言，不需要挖掉例外短语。
 */
function expectNoVerdictWords(text: string): void {
  for (const forbidden of ["正常", "健康", "可达"]) {
    expect(text).not.toContain(forbidden);
  }
}

/* ================================================================== */
/* 四态：status 是唯一判据                                              */
/* ================================================================== */

describe("四态各有独立呈现（都不许退化成「没有数据」）", () => {
  test("ok：画折线 + 回显服务端窗口与维度", () => {
    const html = render(data(RELAY_OK));
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-latency-ok"');
    expect(html).toContain('data-testid="forward-latency-chart"');
    expect(text).toContain("target-b:3030");
    expect(text).toContain("#2");
    expect(html).toContain('data-testid="forward-latency-server-window"');
    expectNoVerdictWords(text);
  });

  test("no_samples：说的是数据缺口，不是 0 ms、也不是画不出来", () => {
    const html = render(data(RELAY_NO_SAMPLES));
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-latency-no-samples"');
    expect(text).toContain("no_samples");
    expect(text).toContain("数据缺口");
    expect(text).toContain("不是 0 ms");
    expect(html).not.toContain('data-testid="forward-latency-chart"');
    expectNoVerdictWords(text);
  });

  test("no_observer：按构造没有维度（DIRECT），并给原因", () => {
    const html = render(data(DIRECT_NO_OBSERVER));
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-latency-no-observer"');
    expect(text).toContain("no_observer");
    // 原因码原样映射成人话，而不是吞成一句「无数据」。
    expect(html).toContain('data-testid="forward-latency-reason"');
    expect(text).toContain("DIRECT");
    expect(html).toContain('data-testid="forward-latency-dimension-none"');
    expectNoVerdictWords(text);
  });

  test("ambiguous_target：拒绝猜，并给出候选数量", () => {
    const html = render(data(RELAY_AMBIGUOUS));
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-latency-ambiguous"');
    expect(text).toContain("ambiguous_target");
    expect(text).toContain("3");
    expect(text).toContain("拒绝猜");
    expectNoVerdictWords(text);
  });

  test("四态的渲染文本两两不同（同一段「没有数据」文案会掩盖真相）", () => {
    const texts = [
      render(data(RELAY_OK)),
      render(data(RELAY_NO_SAMPLES)),
      render(data(DIRECT_NO_OBSERVER)),
      render(data(RELAY_AMBIGUOUS)),
    ].map(visibleText);
    for (let i = 0; i < texts.length; i += 1) {
      for (let j = i + 1; j < texts.length; j += 1) {
        expect(texts[i]).not.toBe(texts[j]);
      }
    }
  });

  test("federated_egress 原因也给得出人话（不是只有 DIRECT 一种原因）", () => {
    const fed = { ...DIRECT_NO_OBSERVER, reason: "federated_egress" as const };
    const text = visibleText(render(data(fed)));
    expect(text).toContain("联邦");
  });
});

/* ================================================================== */
/* 409 ≠ no_samples，400 window_too_long ≠ 一般错误                      */
/* ================================================================== */

describe("409 raw_window_expired 与 200 no_samples 是两个 UI 状态", () => {
  const expiredState = (): ForwardLatencyState => ({
    status: "error",
    query: { granularity: "sample", hours: 24 },
    response: null,
    error: latencyErrorInfo(
      new ApiError(
        409,
        "该窗口的原始样本已按保留期清理（原始层只覆盖最近 24 小时）；改用 granularity=hour 或把窗口前移",
        {
          error: "该窗口的原始样本已按保留期清理（原始层只覆盖最近 24 小时）；改用 granularity=hour 或把窗口前移",
          code: "raw_window_expired",
          error_layer: "retention",
        },
      ),
    ),
  });

  test("409 用独立 testid，且明说它不是「那段时间没有观测」", () => {
    const html = render(expiredState());
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-latency-window-expired"');
    expect(html).not.toContain('data-testid="forward-latency-no-samples"');
    expect(text).toContain("raw_window_expired");
    expect(text).toContain("保留期");
    expect(text).toContain("no_samples");
    expect(text).toContain("不是");
    expectNoVerdictWords(text);
  });

  test("409 给可执行的下一步（改用小时平均），而不只是错误原文", () => {
    const html = render(expiredState());
    expect(html).toContain('data-testid="forward-latency-retention-action"');
    expect(html).toContain('data-testid="forward-latency-switch-hour"');
    expect(visibleText(html)).toContain("改用小时平均");
  });

  test("window_too_long：回显服务端上限，并明说服务端不会静默截短", () => {
    const state: ForwardLatencyState = {
      status: "error",
      query: { granularity: "sample", hours: 48 },
      response: null,
      error: latencyErrorInfo(
        new ApiError(400, "sample 粒度最多读 24 小时窗口（服务端硬上限）", {
          error: "sample 粒度最多读 24 小时窗口（服务端硬上限）",
          code: "window_too_long",
          error_layer: "input",
          data: { max_hours: 24, granularity: "sample" },
        }),
      ),
    };
    const html = render(state);
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-latency-unavailable"');
    expect(html).toContain('data-testid="forward-latency-window-too-long"');
    expect(text).toContain("window_too_long");
    expect(text).toContain("24");
    expect(text).toContain("不会静默截短");
    expectNoVerdictWords(text);
  });

  test("一般错误：后端 code + 原文，且明说不会自动重试", () => {
    const state: ForwardLatencyState = {
      status: "error",
      query: { granularity: "hour", hours: 24 },
      response: null,
      error: latencyErrorInfo(
        new ApiError(404, "端口转发不存在", { error: "端口转发不存在", code: "not_found" }),
      ),
    };
    const text = visibleText(render(state));
    expect(text).toContain("not_found");
    expect(text).toContain("端口转发不存在");
    expect(text).toContain("不会自动重试");
    expectNoVerdictWords(text);
  });

  test("loading / denied 也不出现结论词", () => {
    expectNoVerdictWords(visibleText(render(resetLatencyState({ granularity: "sample", hours: 1 }))));
    expectNoVerdictWords(visibleText(render(deniedLatencyState({ granularity: "sample", hours: 1 }))));
  });
});

/* ================================================================== */
/* null ≠ 0：折线断开，标度不被缺失点拉扯                                */
/* ================================================================== */

describe("latency_ms: null 只断口，绝不补零/插值", () => {
  test("几何：null 把序列切成多段，且不产生 0 值点", () => {
    const geometry = latencyChartGeometry([
      point("2026-10-06T16:00:00Z", 10),
      point("2026-10-06T16:00:30Z", null),
      point("2026-10-06T16:01:00Z", 20),
    ]);
    expect(geometry.runs.length).toBe(2);
    expect(geometry.nullCount).toBe(1);
    expect(geometry.zeroCount).toBe(0);
    const all = geometry.runs.flat();
    expect(all.map((p) => p.latency_ms)).toEqual([10, 20]);
    expect(all.some((p) => p.latency_ms === 0)).toBe(false);
    // y 标度只由可测点决定：缺失点不许把标度拉到 0。
    expect(geometry.minMs).toBe(10);
    expect(geometry.maxMs).toBe(20);
  });

  test("几何：真 0 与 null 分开计数", () => {
    const geometry = latencyChartGeometry([
      point("2026-10-06T16:00:00Z", 0),
      point("2026-10-06T16:00:30Z", null),
      point("2026-10-06T16:01:00Z", 30),
    ]);
    expect(geometry.zeroCount).toBe(1);
    expect(geometry.nullCount).toBe(1);
    // 0 是真的测到了：它必须留在折线里（而 null 不许留下任何点）。
    expect(geometry.runs.flat().map((p) => p.latency_ms)).toEqual([0, 30]);
  });

  test("全部缺失 ⇒ 没有折线可画（不是一条贴着 0 的直线）", () => {
    const geometry = latencyChartGeometry([
      point("2026-10-06T16:00:00Z", null),
      point("2026-10-06T16:00:30Z", null),
    ]);
    expect(geometry.runs.length).toBe(0);
    expect(geometry.nullCount).toBe(2);
  });

  test("渲染：null 处 SVG 里出现多条折线（断开），且文案分别说清 null 与 0", () => {
    const html = render(data(RELAY_OK));
    // RELAY_OK 的真实点序列是 0,1,null,3,null,0,12 ⇒ 3 段折线。
    expect(countOf(html, 'data-testid="forward-latency-run"')).toBe(3);
    const text = visibleText(html);
    expect(text).toContain("2 个点没有测得延迟");
    expect(text).toContain("不补 0");
    expect(text).toContain("2 个点是真的 0 ms");
    expect(text).toContain("不是缺失");
  });

  test("渲染：整段可测时只有一条折线（不因实现细节被切成多段）", () => {
    const html = render(
      data({
        ...RELAY_OK,
        series: [point("2026-10-06T16:00:00Z", 4), point("2026-10-06T16:00:30Z", 9)],
      }),
    );
    expect(countOf(html, 'data-testid="forward-latency-run"')).toBe(1);
  });
});

/* ================================================================== */
/* truncated                                                            */
/* ================================================================== */

describe("truncated: true 必须显式呈现", () => {
  test("截断时打出横幅并说明它不是完整曲线", () => {
    const html = render(data({ ...RELAY_OK, truncated: true }));
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-latency-truncated"');
    expect(text).toContain("truncated: true");
    expect(text).toContain("不是完整曲线");
  });

  test("没有截断时不出现横幅", () => {
    expect(render(data(RELAY_OK))).not.toContain('data-testid="forward-latency-truncated"');
  });
});

/* ================================================================== */
/* 维度：服务端推导，客户端不传                                          */
/* ================================================================== */

describe("维度是服务端事实", () => {
  test("请求体只有 granularity 与窗口（没有 node_id / target_key）", async () => {
    const guard = createLatencyScopeGuard();
    const seen: LatencyQuery[] = [];
    const token = guard.claim();
    const result = await loadLatencyState({
      forwardId: 2,
      query: { granularity: "sample", hours: 1 },
      token,
      guard,
      read: async (_id, query) => {
        seen.push(query);
        return RELAY_OK;
      },
    });
    expect(result.applied).toBe(true);
    expect(seen.length).toBe(1);
    expect(Object.keys(seen[0]!).sort()).toEqual(["granularity", "hours"]);
  });

  test("维度回显 + 说明这条线是「某节点看某目标」", () => {
    const text = visibleText(render(data(RELAY_OK)));
    expect(text).toContain("观测节点 #2");
    expect(text).toContain("target-b:3030");
    expect(text).toContain("不是整条转发的端到端延迟");
  });
});

/* ================================================================== */
/* 取数行为：切 Workspace、轮询节流                                       */
/* ================================================================== */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("取数：切 Workspace 丢弃晚到响应", () => {
  test("守卫：claim 之后旧令牌作废，invalidate 让在途请求过期", () => {
    const guard = createLatencyScopeGuard();
    const first = guard.claim();
    expect(guard.isCurrent(first)).toBe(true);
    const second = guard.claim();
    expect(guard.isCurrent(first)).toBe(false);
    guard.invalidate();
    expect(guard.isCurrent(second)).toBe(false);
  });

  test("切走后，上一个空间的晚到**成功**响应被丢弃", async () => {
    const guard = createLatencyScopeGuard();
    const slow = deferred<ForwardLatencyResponse>();
    const stale = guard.claim();
    const pending = loadLatencyState({
      forwardId: 2,
      query: { granularity: "sample", hours: 1 },
      token: stale,
      guard,
      read: () => slow.promise,
    });
    guard.claim();
    slow.resolve(RELAY_OK);
    expect((await pending).applied).toBe(false);
  });

  test("切走后，上一个空间的晚到**409** 也不许显示（旧空间的 409 会误导用户）", async () => {
    const guard = createLatencyScopeGuard();
    const slow = deferred<ForwardLatencyResponse>();
    const stale = guard.claim();
    const pending = loadLatencyState({
      forwardId: 2,
      query: { granularity: "sample", hours: 24 },
      token: stale,
      guard,
      read: () => slow.promise,
    });
    guard.invalidate();
    slow.reject(new ApiError(409, "原始样本已清理", { code: "raw_window_expired" }));
    const late = await pending;
    expect(late.applied).toBe(false);
    expect(late.state.error?.code).toBe("raw_window_expired");
  });

  test("权限未读出时不当作无权（wait），也不发请求", () => {
    expect(latencyGate({ hasReadPermission: false, permissionsLoading: true })).toBe("wait");
    expect(latencyGate({ hasReadPermission: false, permissionsLoading: false })).toBe("denied");
    expect(latencyGate({ hasReadPermission: true, permissionsLoading: false })).toBe("load");
  });
});

describe("轮询：不快于观测节拍，且只轮询会变的状态", () => {
  test("间隔常量 = 观测节拍 30s", () => {
    expect(LATENCY_POLL_MS).toBe(30_000);
    expect(LATENCY_POLL_MS).toBeGreaterThanOrEqual(30_000);
  });

  test("ok / no_samples 轮询；no_observer / ambiguous_target / 错误 / 无权 不轮询", () => {
    expect(latencyPollIntervalMs(data(RELAY_OK))).toBe(LATENCY_POLL_MS);
    expect(latencyPollIntervalMs(data(RELAY_NO_SAMPLES))).toBe(LATENCY_POLL_MS);
    // 结构事实：30 秒后问一次不会改变答案，轮询只会白耗面板与 DB。
    expect(latencyPollIntervalMs(data(DIRECT_NO_OBSERVER))).toBeNull();
    expect(latencyPollIntervalMs(data(RELAY_AMBIGUOUS))).toBeNull();
    expect(
      latencyPollIntervalMs({
        status: "error",
        query: { granularity: "sample", hours: 1 },
        response: null,
        error: { code: "raw_window_expired", message: "x", layer: "retention", maxHours: null },
      }),
    ).toBeNull();
    expect(latencyPollIntervalMs(deniedLatencyState({ granularity: "sample", hours: 1 }))).toBeNull();
    expect(latencyPollIntervalMs(resetLatencyState({ granularity: "sample", hours: 1 }))).toBeNull();
  });

  test("窗口上限常量与后端同源（sample 24h / hour 720h）", () => {
    expect(LATENCY_WINDOW_MAX_HOURS.sample).toBe(24);
    expect(LATENCY_WINDOW_MAX_HOURS.hour).toBe(720);
  });
});

/* ================================================================== */
/* en 不漏中文                                                           */
/* ================================================================== */

describe("en 文案", () => {
  test("本模块自有文案不含中文，且不含 healthy/reachable/normal", () => {
    const states: ForwardLatencyState[] = [
      resetLatencyState({ granularity: "sample", hours: 1 }),
      data(RELAY_OK),
      data(RELAY_NO_SAMPLES),
      data(DIRECT_NO_OBSERVER),
      data(RELAY_AMBIGUOUS),
      {
        status: "error",
        query: { granularity: "sample", hours: 1 },
        response: null,
        error: { code: "raw_window_expired", message: "raw window expired", layer: "retention", maxHours: null },
      },
    ];
    for (const state of states) {
      const text = visibleText(render(state, "en"));
      expect(text).not.toMatch(/[\u4e00-\u9fff]/);
      for (const forbidden of ["healthy", "reachable", "normal"]) {
        expect(text.toLowerCase()).not.toContain(forbidden);
      }
    }
  });
});

/* ================================================================== */
/* mock 与真实契约同形                                                   */
/* ================================================================== */

describe("mock：GET /forwards/:id/latency 与真实端点同形", () => {
  const call = async (id: number, query: Record<string, unknown>) => {
    resetStore();
    return (await handleMock("GET", `forwards/${id}/latency`, {
      cookie: "tunex_session=u1",
      query,
    })) as { status: number; body: unknown };
  };

  test("DIRECT 转发 ⇒ 200 + no_observer/direct_not_observed，且不给 dimension", async () => {
    const res = await call(1, { granularity: "sample", hours: 1 });
    const body = res.body as ForwardLatencyResponse;
    expect(res.status).toBe(200);
    expect(body.mode).toBe("direct");
    expect(body.status).toBe("no_observer");
    expect(body.reason).toBe("direct_not_observed");
    expect(body.dimension).toBeNull();
    expect(body.series).toEqual([]);
    expect(body.truncated).toBe(false);
    expect(Object.keys(body).sort()).toEqual([
      "dimension",
      "forward_id",
      "granularity",
      "mode",
      "reason",
      "series",
      "status",
      "truncated",
      "window",
    ]);
  });

  test("多目标出口池 ⇒ ambiguous_target + 只给候选数量", async () => {
    const res = await call(3, { granularity: "sample", hours: 1 });
    const body = res.body as ForwardLatencyResponse;
    expect(body.status).toBe("ambiguous_target");
    expect(body.reason).toBe("multiple_targets");
    expect(body.candidate_targets).toBeGreaterThan(1);
    // 拒绝猜：不给维度、不给序列。
    expect(body.dimension).toBeNull();
    expect(body.series).toEqual([]);
  });

  test("sample 窗口超过 24h ⇒ 400 window_too_long + data.max_hours（不静默截短）", async () => {
    const res = await call(2, { granularity: "sample", hours: 48 });
    expect(res.status).toBe(400);
    const body = res.body as { code: string; data: { max_hours: number } };
    expect(body.code).toBe("window_too_long");
    expect(body.data.max_hours).toBe(24);
  });

  test("sample 窗口落在原始保留期之外 ⇒ 409 raw_window_expired（不是 200 空序列）", async () => {
    const res = await call(2, {
      granularity: "sample",
      from: "2026-10-04T00:00:00Z",
      to: "2026-10-04T01:00:00Z",
    });
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe("raw_window_expired");
  });

  test("缺窗口参数 ⇒ 400 missing_window（不给一个默认窗口假装成功）", async () => {
    const res = await call(2, { granularity: "sample" });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("missing_window");
  });

  test("粒度词表只有 sample/hour", async () => {
    const res = await call(2, { granularity: "day", hours: 1 });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("invalid_granularity");
  });

  test("不存在的转发 ⇒ 404（不假装成空的 no_samples）", async () => {
    const res = await call(999999, { granularity: "hour", hours: 24 });
    expect(res.status).toBe(404);
  });
});
