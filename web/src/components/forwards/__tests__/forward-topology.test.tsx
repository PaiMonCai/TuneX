/**
 * R3-B1 —— Forward 链路（topology 首个 Web 消费点）+ F11「累计流量」换源。
 *
 * 这个文件守的是**读法**，不是像素：后端这条只读投影里最容易读错的地方
 * （DIRECT 的空 segments 是设计结论、`observed_at: null` = 没有任何节点上报过、
 * `diag` 三态不可合并、取不到不得说成"正常"、累计流量为空不是 `0 B`）在这里逐条
 * 钉住，用的是**真实响应样本**（scratch 集成拓扑 2026-10-06T16:40Z 抓到的
 * DIRECT / RELAY 两条响应，见 `docs/agent/forward-observability-recon.md` §1.1）。
 *
 * 取数路径的行为（切 Workspace 丢弃晚到响应）用**真实导出的取数函数**断言，
 * 不做源码字符串扫描：源码扫描只会证明"文件里有这几个字"，不会证明行为。
 *
 * 跑法（web 目录）：bun test src/components/forwards/__tests__/forward-topology.test.tsx
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import {
  ForwardLedgerTotal,
  ForwardTopologyPanel,
  createTopologyScopeGuard,
  deniedTopologyState,
  loadTopologyState,
  resetTopologyState,
  topologyErrorInfo,
  topologyGate,
  type ForwardTopologyState,
} from "@/components/forwards/forward-topology";
import {
  ledgerDayKey,
  summarizeForwardLedger,
  type ForwardTopology,
} from "@/lib/api/forwards";
import { ApiError } from "@/lib/api/core";
import { getDictionary } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import { formatBytes } from "@/lib/utils";
import type { TrafficPoint } from "@/lib/types";

/* ================================================================== */
/* 真实样本与渲染工具                                                    */
/* ================================================================== */

/** `GET /api/forwards/1/topology` 的真实响应（DIRECT，逐字）。 */
const DIRECT_REAL: ForwardTopology = {
  forward_id: 1,
  mode: "direct",
  segments: [],
  observed_at: null,
  stale_segments: 0,
};

/**
 * `GET /api/forwards/2/topology` 的真实响应（RELAY，逐字）。
 *
 * 这一份特别有信息量：一端 `running: false` + `revision: null`（节点这次没报它），
 * 另一端 `running: true` + `revision: 1`（报过、且与期望一致），而 `observed_at` 有值、
 * `stale_segments: 1`。三种事实必须分别说出来，不能被合并成一句"某端不对"。
 */
const RELAY_REAL: ForwardTopology = {
  forward_id: 2,
  mode: "relay",
  segments: [
    {
      segment: "ingress_to_egress",
      from: {
        node_id: 1,
        node_key: "Integration-IN-A-NODE",
        runtime_id: "tunex-2-relay",
        running: false,
        revision: null,
        diag: null,
      },
      to: {
        node_id: 2,
        node_key: "Integration-OUT-A-NODE",
        runtime_id: "tunex-2-egress",
        running: true,
        revision: 1,
        diag: null,
      },
      hop: { host: "172.33.20.20", port: 22000 },
      expected_revision: 1,
    },
  ],
  observed_at: "2026-10-06T16:40:19.946Z",
  stale_segments: 1,
};

const ok = (topology: ForwardTopology): ForwardTopologyState => ({
  status: "ok",
  topology,
  error: null,
});

const render = (state: ForwardTopologyState, locale: Locale = "zh") =>
  renderToStaticMarkup(
    <I18nProvider locale={locale} dict={getDictionary(locale)}>
      <ForwardTopologyPanel state={state} />
    </I18nProvider>,
  );

const renderLedger = (
  points: readonly TrafficPoint[],
  options?: { locale?: Locale; now?: Date },
) =>
  renderToStaticMarkup(
    <I18nProvider
      locale={options?.locale ?? "zh"}
      dict={getDictionary(options?.locale ?? "zh")}
    >
      <ForwardLedgerTotal points={points} now={options?.now} />
    </I18nProvider>,
  );

/** 用户可见文本（去掉标签/属性，避免把 `data-testid` 里的词当成文案）。 */
const visibleText = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/**
 * 取某个 testid 元素的**渲染后文本**（同名元素会有多个：RELAY 的两端各一份）。
 *
 * 用它来断言「两件事分别表述」：只有在 DOM 层把 `running` 与 `revision` 分成两个
 * 元素，才谈得上"不吞并"；把整段文本揉成一句再比较是证明不了的。
 */
const testidTexts = (html: string, testid: string): string[] => {
  const pattern = new RegExp(`data-testid="${testid}"[^>]*>([^<]*)<`, "g");
  return [...html.matchAll(pattern)].map((match) => (match[1] ?? "").trim());
};

/**
 * 结论词纪律：界面不得出现「可达 / 健康 / 一切正常」这类**我们拿不到证据的结论**。
 *
 * 注意 `不代表正常` 是规范明确要求出现的否定短语（recon §5 第 4 条），所以这里不是
 * 简单禁掉「正常」二字，而是要求：把该否定短语挖掉之后，文本里**不再**出现「正常」。
 */
function expectNoHealthyClaims(text: string): void {
  for (const forbidden of ["可达", "健康", "链路正常", "运行正常", "一切正常"]) {
    expect(text).not.toContain(forbidden);
  }
  const withoutRequiredNegation = text.replace(/不代表正常/g, "");
  expect(withoutRequiredNegation).not.toContain("正常");
}

/* ================================================================== */
/* 四种状态                                                             */
/* ================================================================== */

describe("链路卡片：四种状态的呈现互不混淆", () => {
  test("loading：只有加载态，不出现结论", () => {
    const html = render(resetTopologyState());
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-topology-loading"');
    expect(text).toContain("正在读取链路");
    expect(html).not.toContain('data-testid="forward-topology-unavailable"');
    expect(html).not.toContain('data-testid="forward-topology-direct"');
    expectNoHealthyClaims(text);
  });

  test("denied：没有 forward:read ⇒ 说权限，不说链路结论（请求根本没发）", () => {
    const html = render(deniedTopologyState());
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-topology-denied"');
    expect(text).toContain("权限不足");
    expect(html).not.toContain('data-testid="forward-topology-unavailable"');
    expectNoHealthyClaims(text);
  });

  test("取不到：独立 testid + 后端 code 与原文 + 不自动重试 + 不得说成正常", () => {
    const error = new ApiError(409, "该中继转发还没有出口节点，无法诊断", {
      error: "该中继转发还没有出口节点，无法诊断",
      code: "no_egress_runtime",
      error_layer: "resource_scope",
    });
    const html = render({ status: "error", topology: null, error: topologyErrorInfo(error) });
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-topology-unavailable"');
    expect(text).toContain("取不到");
    expect(text).toContain("不代表正常");
    expect(text).toContain("no_egress_runtime");
    expect(text).toContain("该中继转发还没有出口节点，无法诊断");
    expect(text).toContain("不会自动重试");
    // 「不重试」必须是**行为上**没有重试入口，而不只是文案：这张卡片里没有任何按钮。
    expect(html).not.toContain("<button");
    expectNoHealthyClaims(text);
  });

  test("取不到：没有后端错误体时如实说「—」，不猜一个原因", () => {
    const html = render({
      status: "error",
      topology: null,
      error: topologyErrorInfo(new Error("Failed to fetch")),
    });
    expect(visibleText(html)).toContain("Failed to fetch");
    expect(visibleText(html)).toContain("—");
  });

  test("全状态：en 文案同样不出现 healthy / reachable / normal 之类结论词", () => {
    const states: ForwardTopologyState[] = [
      resetTopologyState(),
      deniedTopologyState(),
      { status: "error", topology: null, error: { code: "not_found", message: "端口转发不存在" } },
      ok(DIRECT_REAL),
      ok(RELAY_REAL),
    ];
    for (const state of states) {
      const text = visibleText(render(state, "en"));
      for (const forbidden of ["healthy", "reachable", "normal", "all good"]) {
        expect(text.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  /**
   * en 下不得漏出中文文案（含标点/括号这类"小地方"：它们正是搬字典时最容易漏的）。
   * `denied` 态复用仓库共有的 `PERMISSION_DENIED` 常量（它本身是中文，forward-detail
   * 也这么用），所以这一条只覆盖本模块自己拥有文案的状态。
   */
  test("en：本模块自己的文案不含中文（避免 en 界面里漏出中文）", () => {
    const states: ForwardTopologyState[] = [
      resetTopologyState(),
      { status: "error", topology: null, error: { code: "not_found", message: "forward not found" } },
      ok(DIRECT_REAL),
      ok(RELAY_REAL),
      ok({
        ...RELAY_REAL,
        segments: [
          {
            ...RELAY_REAL.segments[0]!,
            from: {
              ...RELAY_REAL.segments[0]!.from,
              diag: { protocol: "udp", facts: { drops: 0 }, truncated: true },
            },
          },
        ],
      }),
    ];
    for (const state of states) {
      expect(visibleText(render(state, "en"))).not.toMatch(/[\u4e00-\u9fff]/);
    }
    const ledgerEn = visibleText(
      renderLedger(
        [{ date: "2026-09-21", traffic: 1024, traffic_cost: 0 }],
        { locale: "en", now: new Date("2026-10-07T02:00:00Z") },
      ),
    );
    expect(ledgerEn).not.toMatch(/[\u4e00-\u9fff]/);
    const emptyLedgerEn = visibleText(
      renderLedger([{ date: "2026-09-21", traffic: 0, traffic_cost: 0 }], {
        locale: "en",
        now: new Date("2026-10-07T02:00:00Z"),
      }),
    );
    expect(emptyLedgerEn).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

/* ================================================================== */
/* DIRECT / RELAY                                                      */
/* ================================================================== */

describe("DIRECT：segments 为空是设计结论，不是缺数据", () => {
  test("画成「入口 → 目标（直连）」并明说没有节点间跳、不做连通性验证", () => {
    const html = render(ok(DIRECT_REAL));
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-topology-direct"');
    expect(text).toContain("入口节点 → 目标（直连）");
    expect(text).toContain("没有节点之间的跳");
    expect(text).toContain("设计结论");
    expect(text).toContain("不是缺数据");
    expect(text).toContain("不验证连通性");
    // 不得退化成空态：没有「暂无/无数据」这类缺数据文案，也没有任何节点间段。
    expect(text).not.toContain("暂无");
    expect(text).not.toContain("无数据");
    expect(html).not.toContain('data-testid="forward-topology-segment"');
    expect(text).not.toContain("取不到");
    expectNoHealthyClaims(text);
  });

  test("DIRECT 的 observed_at: null 读成「没有任何节点上报过」", () => {
    const text = visibleText(render(ok(DIRECT_REAL)));
    expect(text).toContain("没有任何节点上报过");
    expect(text).not.toContain("不是链路检查时刻");
  });
});

describe("RELAY：逐段 from → hop → to，且各事实分别表述", () => {
  test("真实样本：链路两端与下一跳逐字呈现", () => {
    const html = render(ok(RELAY_REAL));
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-topology-chain"');
    expect(text).toContain("Integration-IN-A-NODE → 172.33.20.20:22000 → Integration-OUT-A-NODE");
    expect(text).toContain("tunex-2-relay");
    expect(text).toContain("tunex-2-egress");
    expectNoHealthyClaims(text);
  });

  test("running 与 revision 是两件事：一边没报、一边报了且收敛", () => {
    const text = visibleText(render(ok(RELAY_REAL)));
    expect(text).toContain("最近一次上报里有这条 runtime");
    expect(text).toContain("最近一次上报里没有这条 runtime");
    expect(text).toContain("上报 revision 1 = 期望 1");
    expect(text).toContain("上报里没有这条 runtime 的 revision：未知，不是 0");
  });

  test("running:false 与 revision 不一致同时出现时，各自成句、互不吞并", () => {
    const stale: ForwardTopology = {
      forward_id: 9,
      mode: "relay",
      segments: [
        {
          segment: "ingress_to_egress",
          from: {
            node_id: 1,
            node_key: "hk-in-01",
            runtime_id: "tunex-9-relay",
            running: false,
            revision: 2,
            diag: null,
          },
          to: {
            node_id: 2,
            node_key: "jp-out-01",
            runtime_id: "tunex-9-egress",
            running: true,
            revision: 3,
            diag: null,
          },
          hop: { host: "5.6.7.21", port: 22000 },
          expected_revision: 3,
        },
      ],
      observed_at: "2026-10-06T16:40:19.946Z",
      stale_segments: 1,
    };
    const html = render(ok(stale));
    const running = testidTexts(html, "forward-topology-running");
    const revision = testidTexts(html, "forward-topology-revision");
    expect(running.length).toBe(2);
    expect(revision.length).toBe(2);

    // 起点：没在上报里出现 + revision 与期望不一致 —— 两个**不同元素**里的两句话。
    expect(running[0]).toContain("最近一次上报里没有这条 runtime");
    expect(revision[0]).toContain("上报 revision 2 ≠ 期望 3");
    expect(running[0]).not.toContain("revision");
    expect(revision[0]).not.toContain("最近一次上报");

    // 终点：在跑 + 与期望一致。
    expect(running[1]).toContain("最近一次上报里有这条 runtime");
    expect(revision[1]).toContain("上报 revision 3 = 期望 3");
  });

  test("expected_revision 缺失时说未知，不拿 0 冒充", () => {
    const noExpected: ForwardTopology = {
      ...RELAY_REAL,
      segments: [{ ...RELAY_REAL.segments[0]!, expected_revision: null }],
    };
    const text = visibleText(render(ok(noExpected)));
    expect(text).toContain("期望 revision 未知");
    expect(text).not.toContain("期望 0");
  });

  test("hop 缺失时不编地址", () => {
    const noHop: ForwardTopology = {
      ...RELAY_REAL,
      segments: [{ ...RELAY_REAL.segments[0]!, hop: null }],
    };
    const text = visibleText(render(ok(noHop)));
    expect(text).toContain("配置里没有可展示的下一跳地址");
    expect(text).not.toContain("172.33.20.20");
  });

  test("observed_at 有值：说的是「参与节点最新上报时刻」，不是链路检查时刻", () => {
    const text = visibleText(render(ok(RELAY_REAL)));
    expect(text).toContain("不是链路检查时刻");
    expect(text).not.toContain("没有任何节点上报过");
  });

  test("stale_segments > 0 时给出可断言的数字", () => {
    expect(visibleText(render(ok(RELAY_REAL)))).toContain("有 1 段属于");
    const clean = { ...RELAY_REAL, stale_segments: 0 };
    expect(visibleText(render(ok(clean)))).not.toContain("段属于");
  });
});

/* ================================================================== */
/* diag 三态                                                            */
/* ================================================================== */

describe("diag 三态：null / 空 facts / 有键，必须互不相同", () => {
  const withDiag = (
    diag: ForwardTopology["segments"][number]["from"]["diag"],
  ): ForwardTopology => {
    const base = RELAY_REAL.segments[0]!;
    // 两端都给同一份 diag：三态的比较必须在**受控**的输入上做，否则另一端
    // 残留的 `null` 会把"两种态不同"这个结论搅浑。
    return {
      ...RELAY_REAL,
      segments: [{ ...base, from: { ...base.from, diag }, to: { ...base.to, diag } }],
    };
  };

  test("三个 testid 各自出现且文案两两不同", () => {
    const noneHtml = render(ok(withDiag(null)));
    const emptyHtml = render(ok(withDiag({ protocol: "udp", facts: {}, truncated: false })));
    const factsHtml = render(
      ok(withDiag({ protocol: "udp", facts: { drops: 0 }, truncated: false })),
    );

    expect(noneHtml).toContain('data-testid="forward-topology-diag-none"');
    expect(emptyHtml).toContain('data-testid="forward-topology-diag-empty"');
    expect(factsHtml).toContain('data-testid="forward-topology-diag-facts"');

    const texts = [noneHtml, emptyHtml, factsHtml].map(visibleText);
    expect(texts[0]).not.toBe(texts[1]);
    expect(texts[1]).not.toBe(texts[2]);
    expect(texts[0]).not.toBe(texts[2]);
  });

  test("null 明确不等于「没有丢包」", () => {
    const text = visibleText(render(ok(withDiag(null))));
    expect(text).toContain("没有");
    expect(text).toContain("不等于");
    expect(text).toContain("没有丢包");
  });

  test("空 facts 说的是「报了但没有标量事实」，与 null 不同", () => {
    const text = visibleText(render(ok(withDiag({ protocol: "tls", facts: {}, truncated: false }))));
    expect(text).toContain("{}");
    expect(text).toContain("没有任何标量事实");
    expect(text).not.toContain("没有（null）");
  });

  test("有键：drops: 0 真的渲染出来，未知键原样透传，protocol 一并显示", () => {
    const text = visibleText(
      render(
        ok(
          withDiag({
            protocol: "udp",
            facts: { drops: 0, mappings: 3, idle_timeout_seconds: 60, future_key: "x" },
            truncated: false,
          }),
        ),
      ),
    );
    expect(text).toContain("drops: 0");
    expect(text).toContain("mappings: 3");
    expect(text).toContain("idle_timeout_seconds: 60");
    expect(text).toContain("future_key: x");
    expect(text).toContain("协议诊断（UDP）");
  });

  test("truncated 必须显式说出来（有界化不能静默）", () => {
    const text = visibleText(
      render(ok(withDiag({ protocol: "udp", facts: { drops: 0 }, truncated: true }))),
    );
    expect(text).toContain("有界化");
  });
});

/* ================================================================== */
/* 取数行为：切 Workspace 重置三态、丢弃晚到响应                          */
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

describe("取数：作用域守卫与晚到响应", () => {
  test("claim 之后旧令牌一律作废（切 Workspace / 换转发、以及卸载）", () => {
    const guard = createTopologyScopeGuard();
    const first = guard.claim();
    expect(guard.isCurrent(first)).toBe(true);
    const second = guard.claim();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    guard.invalidate();
    expect(guard.isCurrent(second)).toBe(false);
  });

  test("切 Workspace 后，上一个空间的晚到响应必须被丢弃（连错误也不许显示）", async () => {
    const guard = createTopologyScopeGuard();
    const slow = deferred<ForwardTopology>();
    const tokenForWorkspaceA = guard.claim();
    const pending = loadTopologyState({
      forwardId: 2,
      token: tokenForWorkspaceA,
      guard,
      read: () => slow.promise,
    });
    // 用户在请求在途时切到另一个工作空间。
    const tokenForWorkspaceB = guard.claim();
    slow.resolve(RELAY_REAL);
    const late = await pending;
    expect(late.applied).toBe(false);
    expect(guard.isCurrent(tokenForWorkspaceA)).toBe(false);
    expect(guard.isCurrent(tokenForWorkspaceB)).toBe(true);
  });

  test("晚到的**失败**同样被丢弃（旧空间的失败提示会误导用户）", async () => {
    const guard = createTopologyScopeGuard();
    const slow = deferred<ForwardTopology>();
    const stale = guard.claim();
    const pending = loadTopologyState({
      forwardId: 2,
      token: stale,
      guard,
      read: () => slow.promise,
    });
    guard.claim(); // 切走
    slow.reject(new Error("boom"));
    const late = await pending;
    expect(late.applied).toBe(false);
    expect(late.state.status).toBe("error");
  });

  test("当前令牌的结果会落地，并带上后端的 code + 原文", async () => {
    const guard = createTopologyScopeGuard();
    const token = guard.claim();
    const failed = await loadTopologyState({
      forwardId: 2,
      token,
      guard,
      read: () => {
        throw new ApiError(409, "该中继转发还没有出口节点，无法诊断", {
          code: "no_egress_runtime",
        });
      },
    });
    expect(failed.applied).toBe(true);
    expect(failed.state.status).toBe("error");
    expect(failed.state.error?.code).toBe("no_egress_runtime");
    expect(failed.state.error?.message).toBe("该中继转发还没有出口节点，无法诊断");
  });

  test("resetTopologyState 把三态一起清掉（loading 且没有残留证据）", () => {
    const reset = resetTopologyState();
    expect(reset.status).toBe("loading");
    expect(reset.topology).toBeNull();
    expect(reset.error).toBeNull();
  });

  test("权限还在加载时不能渲染成「无权限」（否则每次进详情页都先看到一句假指控）", () => {
    // permissionsLoading 期间 can("forward:read") 一定是 false，但它不等于「无权」。
    expect(topologyGate({ hasReadPermission: false, permissionsLoading: true })).toBe("wait");
    expect(topologyGate({ hasReadPermission: true, permissionsLoading: true })).toBe("wait");
    expect(topologyGate({ hasReadPermission: false, permissionsLoading: false })).toBe("denied");
    expect(topologyGate({ hasReadPermission: true, permissionsLoading: false })).toBe("load");
  });
});

/* ================================================================== */
/* F11：累计流量必须来自归档账本                                          */
/* ================================================================== */

describe("F11 累计流量：归档账本口径 + 窗口 + 归档延迟", () => {
  /** scratch 集成拓扑的真实响应（无流量流过：补零后的稠密窗口）。 */
  const DENSE_ZERO_WINDOW: TrafficPoint[] = [
    { date: "2026-10-05", traffic: 0, traffic_cost: 0 },
    { date: "2026-10-06", traffic: 0, traffic_cost: 0 },
    { date: "2026-10-07", traffic: 0, traffic_cost: 0 },
  ];

  /** mock 种子里的真实账本点（forward 3，非零）。 */
  const NONZERO_WINDOW: TrafficPoint[] = [
    { date: "2026-09-21", traffic: 16_597_901_115, traffic_cost: 15.458 },
    { date: "2026-09-22", traffic: 10_996_190_020, traffic_cost: 10.241 },
    { date: "2026-09-23", traffic: 19_269_370_774, traffic_cost: 17.946 },
  ];

  test("空窗口 ⇒ 「无数据」，而不是 0 B（0 B 是一个测量结论）", () => {
    const html = renderLedger(DENSE_ZERO_WINDOW, {
      now: new Date("2026-10-06T17:00:00Z"),
    });
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ledger-no-data"');
    expect(text).toContain("无数据");
    expect(text).not.toContain("0 B");
    expect(html).not.toContain('data-testid="forward-ledger-value"');
    expect(text).toContain("没有任何流量记录");
  });

  test("有数据 ⇒ 显示账本合计，并与窗口/归档延迟同屏", () => {
    const html = renderLedger(NONZERO_WINDOW, { now: new Date("2026-10-07T02:00:00Z") });
    const text = visibleText(html);
    const expectedTotal = NONZERO_WINDOW.reduce((sum, p) => sum + p.traffic, 0);
    expect(html).toContain('data-testid="forward-ledger-value"');
    expect(text).toContain(formatBytes(expectedTotal));
    expect(text).not.toContain("无数据");
    expect(text).toContain("2026-09-21 ~ 2026-09-23");
    expect(text).toContain("3 天");
    expect(text).toContain("Asia/Shanghai 日界");
    expect(text).toContain("每 10 分钟");
    expect(text).toContain("不完整日");
    expect(text).toContain("没有实时速率");
    expect(text).toContain("归档账本");
    expect(text).toContain("legacy traffic");
  });

  test("窗口里包含今天时也必须把「今天是不完整日」说出来", () => {
    const text = visibleText(
      renderLedger(DENSE_ZERO_WINDOW, { now: new Date("2026-10-06T17:00:00Z") }),
    );
    expect(text).toContain("今天是不完整日");
  });
});

describe("summarizeForwardLedger：换源后的口径是纯函数，可单独断言", () => {
  test("has_data 只认真实非零流量；全零窗口不算有数据", () => {
    expect(summarizeForwardLedger([]).has_data).toBe(false);
    expect(
      summarizeForwardLedger([
        { date: "2026-10-05", traffic: 0, traffic_cost: 0 },
        { date: "2026-10-06", traffic: 0, traffic_cost: 0 },
      ]).has_data,
    ).toBe(false);
    expect(
      summarizeForwardLedger([
        { date: "2026-10-05", traffic: 0, traffic_cost: 0 },
        { date: "2026-10-06", traffic: 1024, traffic_cost: 0 },
      ]).has_data,
    ).toBe(true);
  });

  test("合计、窗口端点与天数来自账本本身", () => {
    const summary = summarizeForwardLedger([
      { date: "2026-09-21", traffic: 1_000, traffic_cost: 0.5 },
      { date: "2026-09-22", traffic: 2_500, traffic_cost: 1.25 },
    ]);
    expect(summary.total_bytes).toBe(3_500);
    expect(summary.total_cost).toBe(1.75);
    expect(summary.from).toBe("2026-09-21");
    expect(summary.to).toBe("2026-09-22");
    expect(summary.days).toBe(2);
  });

  test("includes_today 按 Asia/Shanghai 日界判定（UTC+8，不是浏览器本地时区）", () => {
    const endingToday = [
      { date: "2026-10-06", traffic: 0, traffic_cost: 0 },
      { date: "2026-10-07", traffic: 0, traffic_cost: 0 },
    ];
    const endingYesterday = [
      { date: "2026-10-05", traffic: 0, traffic_cost: 0 },
      { date: "2026-10-06", traffic: 0, traffic_cost: 0 },
    ];
    // 2026-10-06T17:00:00Z = 上海 2026-10-07 01:00 ⇒ 「今天」是 10-07。
    const now = new Date("2026-10-06T17:00:00Z");
    expect(summarizeForwardLedger(endingToday, { now }).includes_today).toBe(true);
    expect(summarizeForwardLedger(endingYesterday, { now }).includes_today).toBe(false);
    // 同一个时刻在 UTC 里还是 10-06：如果实现偷懒用了 UTC/本地时区，上面两行会同时翻转。
    expect(summarizeForwardLedger(endingYesterday, { now: new Date("2026-10-06T03:00:00Z") })
      .includes_today).toBe(true);
  });

  test("ledgerDayKey 在上海日界的边界上换日", () => {
    expect(ledgerDayKey(new Date("2026-10-06T15:59:59Z"))).toBe("2026-10-06");
    expect(ledgerDayKey(new Date("2026-10-06T16:00:00Z"))).toBe("2026-10-07");
  });
});
