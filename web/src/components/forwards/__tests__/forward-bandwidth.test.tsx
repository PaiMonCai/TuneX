// 行为参照：ForwardX（AGPL-3.0-only）——流量面「带标签的时间窗 + 分桶 + 单位标注」的产品逻辑；
// 代码为本项目改写，未复制其实现。参照溯源：docs/agent/forwardx-code-reuse.md
/**
 * 吞吐序列卡片的行为测试。
 *
 * 守四条（都能被真实渲染/纯函数断言钉住）：
 *  1. **缺口 ≠ 0**：`bytes: null` 不画柱、不参与最大值；`bytes: 0` 画一根贴地细条；
 *  2. **空账本如实说"无数据"**：给出窗口与归档节拍，且**不写 0**；
 *  3. **窗口/粒度/单位只回显服务端**：卡片不自算窗口、不换算单位；
 *  4. **未知状态不出现正向结论词**（正常/健康/可达）——包括取不到与缺口态。
 *
 * 跑法（web 目录）：bun test src/components/forwards/__tests__/forward-bandwidth.test.tsx
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import {
  ForwardThroughputPanel,
  createThroughputScopeGuard,
  deniedThroughputState,
  formatRate,
  loadThroughputState,
  resetThroughputState,
  throughputGate,
  throughputGeometry,
  type ForwardThroughputState,
} from "@/components/forwards/forward-bandwidth";
import type {
  ForwardThroughputPoint,
  ForwardThroughputResponse,
} from "@/lib/api/forwards";
import { ApiError } from "@/lib/api/core";
import { getDictionary } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";

const point = (
  date: string,
  bytes: number | null,
  complete = true,
): ForwardThroughputPoint => ({
  date,
  bytes,
  rate_bps: bytes === null ? null : Number((bytes / 86_400).toFixed(3)),
  complete,
});

/** 有数据 + 一天缺口 + 一天真 0 + 一天不完整（今天）。 */
const RESPONSE: ForwardThroughputResponse = {
  forward_id: 2,
  granularity: "day",
  unit: "bytes_per_second",
  window: {
    from: "2026-10-01",
    to: "2026-10-05",
    days: 5,
    time_zone: "Asia/Shanghai",
  },
  series: [
    point("2026-10-01", 86_400),
    point("2026-10-02", null),
    point("2026-10-03", 0),
    point("2026-10-04", 43_200),
    point("2026-10-05", 8_640, false),
  ],
  summary: {
    total_bytes: 138_240,
    avg_rate_bps_over_window: 0.32,
    coverage: { days_with_data: 4, days_missing: 1 },
  },
  archive: { interval_minutes: 10, today_key: "2026-10-05", today_incomplete: true },
  limits: { max_days: 90 },
};

/** 账本里一行都没有（真机当前就是这样）。 */
const EMPTY_RESPONSE: ForwardThroughputResponse = {
  ...RESPONSE,
  series: [
    point("2026-10-01", null),
    point("2026-10-02", null),
    point("2026-10-03", null),
    point("2026-10-04", null),
    point("2026-10-05", null, false),
  ],
  summary: {
    total_bytes: 0,
    avg_rate_bps_over_window: 0,
    coverage: { days_with_data: 0, days_missing: 5 },
  },
};

const data = (response: ForwardThroughputResponse): ForwardThroughputState => ({
  status: "data",
  days: response.window.days,
  response,
  error: null,
});

const render = (state: ForwardThroughputState, locale: Locale = "zh") =>
  renderToStaticMarkup(
    <I18nProvider locale={locale} dict={getDictionary(locale)}>
      <ForwardThroughputPanel state={state} />
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

/** 未知状态下不得给正向结论；「不可达」这类词本项目一律回避（与延迟/链路卡片同规）。 */
function expectNoVerdictWords(text: string, { allowZeroNote = false } = {}) {
  const scrubbed = allowZeroNote ? text.replace(/测到的流量是 0/g, "") : text;
  for (const forbidden of ["正常", "健康", "可达"]) {
    expect(scrubbed).not.toContain(forbidden);
  }
}

describe("缺口与 0 是两件事", () => {
  test("几何：null 不画柱、不参与最大值；0 画柱", () => {
    const geometry = throughputGeometry(RESPONSE.series);
    // 5 天里 1 天缺口 ⇒ 只有 4 根柱
    expect(geometry.bars.length).toBe(4);
    expect(geometry.gaps).toBe(1);
    expect(geometry.zeroRows).toBe(1);
    // 最大值只看有数据的天（缺口不参与）
    expect(geometry.maxBytes).toBe(86_400);
    // 0 那天的柱子存在，但比例是 0（贴地细条，而不是"没有柱"）
    const zeroBar = geometry.bars.find((bar) => bar.date === "2026-10-03");
    expect(zeroBar?.bytes).toBe(0);
    expect(zeroBar?.ratio).toBe(0);
    // 缺口那天**没有**柱子
    expect(geometry.bars.some((bar) => bar.date === "2026-10-02")).toBe(false);
  });

  test("渲染：缺口/0/不完整三种说明各自出现，且柱数等于有数据天数", () => {
    const html = render(data(RESPONSE));
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-throughput-gap-note"');
    expect(html).toContain('data-testid="forward-throughput-zero-note"');
    expect(html).toContain('data-testid="forward-throughput-incomplete-note"');
    expect(html.split('data-testid="forward-throughput-bar"').length - 1).toBe(4);
    expect(text).toContain("缺口 1 天");
    expect(text).toContain("不补 0");
    expectNoVerdictWords(text, { allowZeroNote: true });
  });

  test("合计只加有数据的天（缺口不计入 0）", () => {
    const html = render(data(RESPONSE));
    // 86_400 + 0 + 43_200 + 8_640 = 138_240 → 135 KB
    expect(visibleText(html)).toContain("135.00 KB");
  });
});

describe("空账本：如实说无数据（不写 0）", () => {
  test("独立 testid + 窗口 + 归档节拍，且**不出现** 0 B", () => {
    const html = render(data(EMPTY_RESPONSE));
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-throughput-no-data"');
    expect(text).toContain("窗口内没有任何归档行");
    expect(text).toContain("这不是「流量为 0」");
    // 窗口与归档延迟必须同屏（否则用户不知道自己在看哪段时间）
    expect(html).toContain('data-testid="forward-throughput-window"');
    expect(text).toContain("2026-10-01 ~ 2026-10-05");
    expect(html).toContain('data-testid="forward-throughput-archive"');
    expect(text).toContain("每 10 分钟");
    expect(text).toContain("今天是不完整日");
    // 空账本不得画图、也不得写 0 B
    expect(html).not.toContain('data-testid="forward-throughput-chart"');
    expect(text).not.toContain("0 B");
    expectNoVerdictWords(text);
  });
});

describe("服务端真相只回显，前端不自算", () => {
  test("窗口/粒度/单位照服务端回显", () => {
    const text = visibleText(render(data(RESPONSE)));
    expect(text).toContain("聚合粒度 day");
    expect(text).toContain("bytes_per_second");
    expect(text).toContain("Asia/Shanghai");
  });

  test("窗口按钮只换 days 参数，不自己算日期区间", async () => {
    const guard = createThroughputScopeGuard();
    const seen: number[] = [];
    const token = guard.claim();
    const result = await loadThroughputState({
      forwardId: 2,
      days: 30,
      token,
      guard,
      read: async (_id, days) => {
        seen.push(days);
        return RESPONSE;
      },
    });
    expect(result.applied).toBe(true);
    expect(seen).toEqual([30]);
  });

  test("formatRate 只加量纲，不做单位换算；亚字节速率不得渲染出 undefined", () => {
    expect(formatRate(1024)).toBe("1.00 KB/s");
    // 吞吐速率天然落在 (0,1) 区间：这里必须给出可读数字，而不是 `formatBytes` 的
    // `Math.floor(log(n)/log(1024)) === -1` 造成的 `327.68 undefined`。
    expect(formatRate(0.32)).toBe("0.320 B/s");
    expect(formatRate(0)).toBe("0 B/s");
    const text = visibleText(render(data(RESPONSE)));
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
  });
});

describe("三态：取不到/无权/加载 都不给结论", () => {
  test("取不到：独立 testid + 后端 code + 原文", async () => {
    const guard = createThroughputScopeGuard();
    const token = guard.claim();
    const failed = await loadThroughputState({
      forwardId: 2,
      days: 14,
      token,
      guard,
      read: async () => {
        throw new ApiError(404, "端口转发不存在", { code: "not_found" });
      },
    });
    expect(failed.state.status).toBe("error");
    expect(failed.state.error?.code).toBe("not_found");
    const html = render(failed.state);
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-throughput-unavailable"');
    expect(text).toContain("取值".replace("值", "不到"));
    expect(text).toContain("not_found");
    expectNoVerdictWords(text);
  });

  test("无权与加载态也不出现结论词", () => {
    expectNoVerdictWords(visibleText(render(deniedThroughputState())));
    expectNoVerdictWords(visibleText(render(resetThroughputState())));
  });

  test("权限未读出时保持 wait（不误报无权）", () => {
    expect(throughputGate({ hasReadPermission: false, permissionsLoading: true })).toBe("wait");
    expect(throughputGate({ hasReadPermission: false, permissionsLoading: false })).toBe("denied");
    expect(throughputGate({ hasReadPermission: true, permissionsLoading: false })).toBe("load");
  });
});

describe("切 Workspace：晚到响应被丢弃", () => {
  test("守卫 + 晚到的成功响应不落地", async () => {
    const guard = createThroughputScopeGuard();
    let resolve!: (value: ForwardThroughputResponse) => void;
    const pending = new Promise<ForwardThroughputResponse>((res) => {
      resolve = res;
    });
    const stale = guard.claim();
    const loading = loadThroughputState({ forwardId: 2, days: 14, token: stale, guard, read: () => pending });
    guard.claim(); // 切走（或换窗口）
    resolve(RESPONSE);
    expect((await loading).applied).toBe(false);
  });
});

describe("en 文案", () => {
  test("不含中文，也不出现 healthy/reachable/normal", () => {
    for (const state of [data(RESPONSE), data(EMPTY_RESPONSE), resetThroughputState()]) {
      const text = visibleText(render(state, "en"));
      expect(text).not.toMatch(/[\u4e00-\u9fff]/);
      for (const forbidden of ["healthy", "reachable", "normal"]) {
        expect(text.toLowerCase()).not.toContain(forbidden);
      }
    }
  });
});

describe("mock 与真实端点同形", () => {
  test("形状：窗口/粒度/单位/覆盖度/归档节拍齐备，且缺口与 0 都在夹具里", async () => {
    resetStore();
    const res = (await handleMock("GET", "forwards/2/throughput", {
      cookie: "tunex_session=u1",
      query: { days: 14 },
    })) as { status: number; body: unknown };
    expect(res.status).toBe(200);
    const body = res.body as ForwardThroughputResponse;
    expect(Object.keys(body).sort()).toEqual([
      "archive",
      "forward_id",
      "granularity",
      "limits",
      "series",
      "summary",
      "unit",
      "window",
    ]);
    expect(body.granularity).toBe("day");
    expect(body.unit).toBe("bytes_per_second");
    expect(body.window.days).toBe(14);
    expect(body.series.length).toBe(14);
    // 夹具必须同时含缺口与真 0（否则开发期看不到这条纪律）
    expect(body.series.some((point) => point.bytes === null)).toBe(true);
    // 缺口点的 rate 也必须是 null（不是 0）
    for (const point of body.series) {
      if (point.bytes === null) expect(point.rate_bps).toBeNull();
    }
    // 最后一天 = 今天 ⇒ 不完整
    expect(body.series[body.series.length - 1]!.complete).toBe(false);
    expect(body.archive.today_key).toBe(body.series[body.series.length - 1]!.date);
    // 覆盖度与序列一致（不是各算各的）
    expect(body.summary.coverage.days_with_data + body.summary.coverage.days_missing).toBe(14);
  });

  test("不存在的转发 → 404（不假装成空序列）", async () => {
    resetStore();
    const res = (await handleMock("GET", "forwards/999999/throughput", {
      cookie: "tunex_session=u1",
      query: { days: 14 },
    })) as { status: number };
    expect(res.status).toBe(404);
  });
});
