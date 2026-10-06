/**
 * Looking Glass 面板的**行为测试**：真实函数 + 真实 JSX 渲染 + 真实 mock 分发。
 *
 * 夹具用的是**真机抓到的真实响应**（scratch Panel，见本文件里的 `REAL_*`），不是编的形状。
 *
 * 钉住六件事：
 *   ① `enabled:false` = "平台未开启这项诊断"（说出开关名），**不是**"测试失败"；
 *   ② **取不到状态 ≠ 没开启**：载荷读不出来 ⇒ 独立分支，绝不落进 disabled；
 *   ③ `platform_admin_override` 是**例外**，要写明是例外；
 *   ④ 能力边界（`tcp_connect`、目标条数、超时上下限）全部读服务端 `caps`，界面不硬编码；
 *   ⑤ 发起是写操作 ⇒ 固定告知副作用；"未发起" / "已发起（在途）" / "发起了但没拿到结果"
 *      / "被拒绝（没发包）" 四个状态可区分，且 ACK 超时**不许**说成"没有发出"；
 *   ⑥ mock 与真机同路径同码；mock 走到下发时**如实报 `agent_failed`**，绝不伪造 `reachable`。
 *
 * 跑法（web 目录）：bun test src/components/nodes/__tests__/looking-glass-panel.test.tsx
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import { getDictionary } from "@/lib/i18n";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";
import {
  LOOKING_GLASS_CODES,
  lookingGlassFailureKind,
  lookingGlassReportFromPayload,
  lookingGlassStatusFromPayload,
  type LookingGlassStatus,
} from "@/lib/api/looking-glass";
import {
  LookingGlassPanelBody,
  lookingGlassCopy,
  lookingGlassPhase,
  refusalReasonText,
  resultStatusText,
  type LookingGlassPhase,
  type LookingGlassPanelProps,
  type LookingGlassRunState,
} from "@/components/nodes/looking-glass-panel";
import { createPermissionRequestFence } from "@/lib/workspace-permissions";

/* ================================================================== */
/* 真机夹具（scratch Panel 实测，逐字）                                  */
/* ================================================================== */

const REAL_STATUS = {
  enabled: false,
  switch_env: "LOOKING_GLASS_ENABLED",
  platform_admin_override: true,
  method: "tcp_connect",
  caps: {
    max_targets: 4,
    max_pinned_addresses: 4,
    default_timeout_ms: 3000,
    max_timeout_ms: 5000,
    // task-42：闭集扩到 5 种（tcp_connect + ICMP echo + 无特权路径跟踪）。
    methods: ["tcp_connect", "ping", "ping6", "traceroute", "traceroute6"],
    // 本版本明确不提供的方法 + 原因（服务端回显，前端**列出并说明**）。
    unavailable_methods: [
      {
        method: "mtr",
        reason:
          "镜像里没有 mtr 二进制；且 mtr 默认需要 raw socket（CAP_NET_RAW），生产 caps 下不可用 —— 所以我们不做它，而不是假装支持",
      },
      { method: "mtr6", reason: "同 mtr：无二进制 + 依赖 raw socket（CAP_NET_RAW）" },
    ],
  },
  targets: "public-only（私网/回环/链路本地/多播/保留段一律拒绝）",
  caveats: [
    "这是从该节点发出的主动探测（tcp_connect / ping / ping6）：连上或收到回包只证明 L3/L4 可达，不证明对端业务可用。",
    "域名由面板解析、节点只拨固定地址：因此它不能回答「节点侧 DNS 能否解析该域名」。",
    "ping/ping6 由节点在容器内调用镜像自带的 ping 二进制（非特权 ICMP），依赖节点内核允许非特权 ICMP；ping6 还需要节点自身有 IPv6 出网路径 —— 没有时结果是 unreachable，那不是方法未实现。",
    "traceroute / traceroute6 由节点调用 iputils 的 tracepath 实现（非特权：UDP 探测 + ICMP 超时回包），因此没有放开 CAP_NET_RAW；目标家族没有出网路径时它是 send failed，属真实网络事实。",
    "不含 mtr / mtr6：镜像里没有该二进制，且它默认需要 raw socket（CAP_NET_RAW）—— 生产安装用 --cap-drop ALL --cap-add NET_BIND_SERVICE。（busybox 的 traceroute 同样因 raw socket 被拒，我们用它之外的无特权路径。）",
    "不含 UDP：datagram 没有可靠探测来源，本版本不产生该事实。",
    "不含 HTTP：重定向/降级/凭据是另一份威胁模型，本版本不做。",
    "结果不含任何数据面载荷与凭据；每次发起与拒绝都会写审计。",
  ],

};

const REAL_REPORT = {
  node: { id: 1, node_key: "Integration-IN-A-NODE" },
  generated_at: "2026-10-06T18:05:42.813Z",
  method: "tcp_connect",
  entry: { enabled: false, admin_override: true },
  requested: [{ host: "1.1.1.1", port: 443 }],
  pinned: [{ address: "1.1.1.1", port: 443 }],
  pinned_by_host: [{ host: "1.1.1.1", addresses: ["1.1.1.1"] }],
  results: [{ address: "1.1.1.1", port: 443, status: "reachable", elapsed_ms: 2 }],
  caveats: REAL_STATUS.caveats,
};

/** 夹具默认 enabled=true（与 `phase: "ready"` 自洽）；关闭态的用例显式覆盖。 */
function status(over: Partial<LookingGlassStatus> = {}): LookingGlassStatus {
  const parsed = lookingGlassStatusFromPayload({ ...REAL_STATUS, enabled: true, ...over });
  if (!parsed.ok) throw new Error(`夹具不可读：${parsed.message}`);
  return parsed.value;
}

function render(node: React.ReactNode, locale: "zh" | "en" = "zh") {
  return renderToStaticMarkup(<I18nProvider locale={locale} dict={getDictionary(locale)}>{node}</I18nProvider>);
}

const noop = () => undefined;

function body(over: Partial<LookingGlassPanelProps> = {}) {
  const props: LookingGlassPanelProps = {
    phase: "ready" as LookingGlassPhase,
    status: status(),
    failureMessage: null,
    locale: "zh",
    targets: [{ host: "", port: 0 }],
    timeoutMs: "",
    run: { kind: "idle" } as LookingGlassRunState,
    onTargetChange: noop,
    onAddTarget: noop,
    onRemoveTarget: noop,
    onTimeoutChange: noop,
    onRun: noop,
    onRetryStatus: noop,
    ...over,
  };
  return render(<LookingGlassPanelBody {...props} />);
}

/* ================================================================== */
/* 载荷读取：fail-closed                                                */
/* ================================================================== */

describe("形状读取：读不出来 ≠ 没开启", () => {
  test("真机 status 载荷逐字段读对（caps 全部来自服务端）", () => {
    const parsed = lookingGlassStatusFromPayload(REAL_STATUS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.enabled).toBe(false);
    expect(parsed.value.switch_env).toBe("LOOKING_GLASS_ENABLED");
    expect(parsed.value.platform_admin_override).toBe(true);
    expect(parsed.value.method).toBe("tcp_connect");
    expect(parsed.value.caps).toEqual(REAL_STATUS.caps);
    expect(parsed.value.caveats).toHaveLength(8);
  });

  test("enabled 缺失/非布尔 ⇒ 整份判不可读（**不许**当成 false=未开启）", () => {
    const missing = lookingGlassStatusFromPayload({ ...REAL_STATUS, enabled: undefined });
    expect(missing.ok).toBe(false);
    const wrongType = lookingGlassStatusFromPayload({ ...REAL_STATUS, enabled: "false" });
    expect(wrongType.ok).toBe(false);
  });

  test("caps / caveats 缺失 ⇒ 不可读（上限读不出来就不能显示表单）", () => {
    expect(lookingGlassStatusFromPayload({ ...REAL_STATUS, caps: undefined }).ok).toBe(false);
    expect(lookingGlassStatusFromPayload({ ...REAL_STATUS, caps: { max_targets: 4 } }).ok).toBe(false);
    expect(lookingGlassStatusFromPayload({ ...REAL_STATUS, caveats: "x" }).ok).toBe(false);
    expect(lookingGlassStatusFromPayload(null).ok).toBe(false);
  });

  test("真机 report 载荷读对；未知结果状态**原样保留**（不降级成 reachable）", () => {
    const parsed = lookingGlassReportFromPayload(REAL_REPORT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.results[0]).toEqual({ address: "1.1.1.1", port: 443, status: "reachable", elapsed_ms: 2 });
    expect(parsed.value.entry).toEqual({ enabled: false, admin_override: true });
    expect(parsed.value.pinned_by_host[0]!.addresses).toEqual(["1.1.1.1"]);

    const unknown = lookingGlassReportFromPayload({
      ...REAL_REPORT,
      results: [{ address: "1.1.1.1", port: 443, status: "quantum", elapsed_ms: 1 }],
    });
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    expect(unknown.value.results[0]!.status).toBe("quantum");
  });

  test("report 缺关键字段 ⇒ 不可读（不把残缺报告当成一次成功）", () => {
    expect(lookingGlassReportFromPayload({ ...REAL_REPORT, generated_at: undefined }).ok).toBe(false);
    expect(lookingGlassReportFromPayload({ ...REAL_REPORT, results: [{ address: "1.1.1.1", port: 443, status: "reachable" }] }).ok).toBe(false);
    expect(lookingGlassReportFromPayload({ ...REAL_REPORT, results: [{ address: "1.1.1.1", port: 443, status: "reachable", elapsed_ms: null }] }).ok).toBe(false);
  });
});

/* ================================================================== */
/* 五态                                                                */
/* ================================================================== */

describe("五态互不冒充", () => {
  test("可读 + enabled=true ⇒ ready；enabled=false 分管理员例外与未开启", () => {
    expect(lookingGlassPhase(status({ enabled: true }), true)).toBe("ready");
    expect(lookingGlassPhase(status({ enabled: false, platform_admin_override: true }), true)).toBe("admin_override");
    expect(lookingGlassPhase(status({ enabled: false, platform_admin_override: false }), true)).toBe("disabled");
  });

  test("不可读 ⇒ unavailable（**不是** disabled）；还没读到 ⇒ loading", () => {
    expect(lookingGlassPhase(null, false)).toBe("unavailable");
    expect(lookingGlassPhase(null, true)).toBe("loading");
  });

  test("渲染：未开启分支说出开关名，并明确「这不是测试失败、没有发过包」", () => {
    const html = body({ phase: "disabled", status: status({ platform_admin_override: false }) });
    expect(html).toContain('data-testid="looking-glass-disabled"');
    expect(html).toContain("LOOKING_GLASS_ENABLED");
    expect(html).toContain("这不是测试失败");
    expect(html).toContain("没有向任何目标发过包");
    expect(html).not.toContain('data-testid="looking-glass-form"');
  });

  test("渲染：取不到状态是独立分支，带原句与重试，且不说「未开启/暂无数据」", () => {
    const html = body({ phase: "unavailable", status: null, failureMessage: "响应缺少布尔字段 enabled" });
    expect(html).toContain('data-testid="looking-glass-status-unavailable"');
    expect(html).toContain('data-testid="looking-glass-retry-status"');
    expect(html).toContain("响应缺少布尔字段 enabled");
    expect(html).toContain("这不等于「平台未开启」");
    expect(html).not.toContain("暂无数据");
    expect(html).not.toContain('data-testid="looking-glass-disabled"');
  });

  test("渲染：权限不足是第三种分支（不是未开启、不是取不到）", () => {
    const html = body({ phase: "permission_denied", status: null, failureMessage: "当前工作空间角色无权读取节点" });
    expect(html).toContain('data-testid="looking-glass-permission-denied"');
    expect(html).toContain("node:read");
    expect(html).not.toContain('data-testid="looking-glass-disabled"');
    expect(html).not.toContain('data-testid="looking-glass-status-unavailable"');
  });

  test("渲染：管理员例外显式标注为例外，并说明普通成员看不到入口", () => {
    const html = body({ phase: "admin_override" });
    expect(html).toContain('data-testid="looking-glass-admin-override"');
    expect(html).toContain('data-testid="looking-glass-admin-override-detail"');
    expect(html).toContain("例外");
    expect(html).toContain("普通成员");
    expect(html).toContain('data-testid="looking-glass-form"');
  });

  test("禁词纪律：取不到 / 未开启 / 权限不足 / 超时无结果 四类文案里不出现「正常/健康/可达」", () => {
    const branches = [
      body({ phase: "unavailable", status: null }),
      body({ phase: "disabled", status: status({ platform_admin_override: false }) }),
      body({ phase: "permission_denied", status: null }),
      body({ run: { kind: "refused", failure: "issued_without_result", code: "ack_timeout", message: "节点没有在预算内回报" } }),
      body({ run: { kind: "refused", failure: "not_issued", code: "target_not_public", message: "目标不是公网单播" } }),
    ];
    for (const html of branches) {
      for (const word of ["正常", "健康", "可达"]) expect(html).not.toContain(word);
    }
  });
});

/* ================================================================== */
/* 能力边界来自服务端                                                    */
/* ================================================================== */

describe("能力边界读 caps，不硬编码", () => {
  test("条数与超时上限照服务端显示（换成 2 / 1111 / 2222 也跟着变）", () => {
    const html = body({
      status: status({ caps: { max_targets: 2, max_pinned_addresses: 2, default_timeout_ms: 1111, max_timeout_ms: 2222, methods: ["tcp_connect"] } }),
    });
    expect(html).toContain("最多 2 个目标");
    expect(html).toContain("1111ms");
    expect(html).toContain("2222ms");
    expect(html).not.toContain("多个目标；单次超时 3000ms");
  });

  test("达到上限就不再给「再加一个目标」；未达上限才给", () => {
    const atLimit = body({ targets: [{ host: "a", port: 1 }, { host: "b", port: 2 }], status: status({ caps: { ...REAL_STATUS.caps, max_targets: 2 } }) });
    expect(atLimit).not.toContain('data-testid="looking-glass-add-target"');
    const below = body({ targets: [{ host: "a", port: 1 }] });
    expect(below).toContain('data-testid="looking-glass-add-target"');
  });

  test("方法与目标范围的口径都说出来（只支持 tcp_connect、只允许公网单播）", () => {
    const html = body();
    expect(html).toContain('data-testid="looking-glass-method"');
    expect(html).toContain("tcp_connect");
    expect(html).toContain('data-testid="looking-glass-scope"');
    expect(html).toContain("只允许公网单播目标");
  });

  test("服务端 caveats 条数与本地结论不一致时，把原始声明也列出来（漂移可见）", () => {
    const same = body();
    expect(same).not.toContain('data-testid="looking-glass-raw-caveats"');

    const drifted = body({ status: status({ caveats: [...REAL_STATUS.caveats, "新增的第五条口径声明"] }) });
    expect(drifted).toContain('data-testid="looking-glass-raw-caveats"');
    expect(drifted).toContain("新增的第五条口径声明");
  });

  test("本地结论覆盖每一条服务端结论（方法集变了，口径也必须跟着变）", () => {
    const copy = lookingGlassCopy("zh");
    // 条数必须与 `LOOKING_GLASS_CAVEATS` 一致：不一致时面板会把服务端原文也列出来（漂移可见），
    // 而"本地文案悄悄落后于服务端"正是这个功能最容易骗人的地方。
    expect(copy.caveats).toHaveLength(8);
    expect(copy.caveats[0]).toContain("L3/L4");
    expect(copy.caveats[1]).toContain("面板解析");
    // task-42：加了 ICMP 与路径跟踪之后，"不含 UDP/ICMP" 就是错话 —— 现在要分别说清它们。
    expect(copy.caveats[2]).toContain("ICMP");
    expect(copy.caveats[3]).toContain("tracepath");
    expect(copy.caveats[4]).toContain("mtr");
    expect(copy.caveats[5]).toContain("UDP");
    expect(copy.caveats[6]).toContain("HTTP");
    expect(copy.caveats[7]).toContain("审计");
    expect(lookingGlassCopy("en").caveats).toHaveLength(8);
  });
});

/* ================================================================== */
/* 发起：写操作 + 四种状态                                              */
/* ================================================================== */

describe("写操作告知与「发起状态」四分", () => {
  test("固定告知副作用（真实 TCP 连接 + 写审计）", () => {
    const html = body();
    expect(html).toContain('data-testid="looking-glass-write-warning"');
    expect(html).toContain("写操作");
    expect(html).toContain("TCP 连接");
    expect(html).toContain("审计");
  });

  test("未发起：显式说「本轮还没有发起过」（不是失败、也不是成功）", () => {
    const html = body({ run: { kind: "idle" } });
    expect(html).toContain('data-testid="looking-glass-idle"');
    expect(html).toContain("还没有发起过测试");
    expect(html).not.toContain('data-testid="looking-glass-report"');
  });

  test("在途：按钮进入等待态且被禁用（与「未发起」不同）", () => {
    const html = body({ run: { kind: "running" } });
    expect(html).toContain('data-running="true"');
    expect(html).toContain("已发起，等待节点回报");
    expect(html).not.toContain('data-testid="looking-glass-idle"');
  });

  test("被拒绝：区分「没有发包」与「发起了但没拿到结果」", () => {
    const notIssued = body({ run: { kind: "refused", failure: "not_issued", code: "target_not_public", message: "目标不是公网单播" } });
    expect(notIssued).toContain('data-failure="not_issued"');
    expect(notIssued).toContain("没有发出任何测试");
    expect(notIssued).toContain("发包之前");
    expect(notIssued).toContain('data-testid="looking-glass-refused-reason"');

    const timeout = body({ run: { kind: "refused", failure: "issued_without_result", code: "ack_timeout", message: "节点没有在预算内回报" } });
    expect(timeout).toContain('data-failure="issued_without_result"');
    expect(timeout).toContain("没有拿到可用结果");
    expect(timeout).toContain("无法确认");
    expect(timeout).not.toContain("没有发出任何测试");
  });

  test("未知拒绝码：说清「不猜有没有发包」，并原样显示原句", () => {
    const html = body({ run: { kind: "refused", failure: "unknown", code: "brand_new_code", message: "某种新拒绝" } });
    expect(html).toContain('data-failure="unknown"');
    expect(html).toContain("不在已知集合里");
    expect(html).toContain("某种新拒绝");
    expect(html).toContain('data-testid="looking-glass-refused-code"');
  });

  test("本地校验（没填目标）不给「服务端原因」那一行", () => {
    const html = body({ run: { kind: "refused", failure: "not_issued", code: null, message: "没有可用的目标（地址与端口必填）：本面板没有发出任何请求。" } });
    expect(html).toContain("没有发出");
    expect(html).not.toContain('data-testid="looking-glass-refused-reason"');
  });

  test("分类器：发包前的拒绝 vs 下发后的失败 各归各位，未知码不猜", () => {
    for (const code of ["looking_glass_disabled", "looking_glass_busy", "not_found", "target_not_public", "too_many_targets", "invalid_port", "method_not_supported", "timeout_out_of_range", "audit_unavailable", "upgrade_required", "permission_denied"]) {
      expect(`${code}:${lookingGlassFailureKind(code)}`).toBe(`${code}:not_issued`);
    }
    for (const code of ["ack_timeout", "agent_failed", "incomplete_result", "invalid_result"]) {
      expect(`${code}:${lookingGlassFailureKind(code)}`).toBe(`${code}:issued_without_result`);
    }
    expect(lookingGlassFailureKind("who_knows")).toBe("unknown");
    expect(lookingGlassFailureKind(null)).toBe("unknown");
  });

  test("拒绝码 → 人话：已知码有说法，未知码返回 null（不编）", () => {
    expect(refusalReasonText("zh", LOOKING_GLASS_CODES.targetNotPublic)).toContain("公网单播");
    expect(refusalReasonText("zh", LOOKING_GLASS_CODES.busy)).toContain("在途");
    expect(refusalReasonText("zh", "brand_new_code")).toBeNull();
    expect(refusalReasonText("zh", null)).toBeNull();
    expect(refusalReasonText("en", LOOKING_GLASS_CODES.targetNotPublic)).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe("结果渲染：真机报告 + 未知状态不降级", () => {
  function reportBody(results: Record<string, unknown>[]) {
    const parsed = lookingGlassReportFromPayload({ ...REAL_REPORT, results });
    if (!parsed.ok) throw new Error(parsed.message);
    return body({ run: { kind: "report", report: parsed.value } });
  }

  function realReport() {
    const parsed = lookingGlassReportFromPayload(REAL_REPORT);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.value;
  }

  test("真机报告：地址、状态、耗时、面板钉死地址、管理员例外都呈现", () => {
    const html = body({ run: { kind: "report", report: realReport() } });
    expect(html).toContain('data-testid="looking-glass-report"');
    expect(html).toContain("1.1.1.1:443");
    expect(html).toContain("TCP 握手完成");
    expect(html).toContain("2 ms");
    expect(html).toContain('data-testid="looking-glass-pinned"');
    expect(html).toContain("1.1.1.1 → 1.1.1.1");
    expect(html).toContain("本次因管理员例外而执行");
  });

  test("七个闭集状态各有说法且互不相同", () => {
    const statuses = ["reachable", "refused", "timeout", "dns_error", "invalid_target", "error", "unsupported"];
    const texts = statuses.map((s) => resultStatusText("zh", { address: "1.1.1.1", port: 443, status: s, elapsed_ms: 1 }));
    expect(new Set(texts).size).toBe(statuses.length);
    expect(texts[0]).toContain("L3/L4");
    expect(texts[1]).toContain("主动拒绝");
    expect(texts[2]).toContain("死线");
  });

  test("未知结果状态：明说未知并带上原值，绝不显示成某一种成功", () => {
    const html = reportBody([{ address: "1.1.1.1", port: 443, status: "quantum", elapsed_ms: 3 }]);
    expect(html).toContain("quantum");
    expect(html).toContain("本界面不猜它的含义");
    expect(html).not.toContain("TCP 握手完成");
  });

  test("超时是一个「有结果」的状态（与 ACK 超时是两件事）", () => {
    expect(resultStatusText("zh", { address: "1.1.1.1", port: 443, status: "timeout", elapsed_ms: 3000 })).toContain("没有应答");
    expect(lookingGlassFailureKind("timeout")).toBe("unknown"); // 它不是拒绝码，是结果状态
  });

  test("en 渲染无中文，且没有 healthy/reachable 这类结论词", () => {
    const html = render(
      <LookingGlassPanelBody
        phase="ready"
        status={status()}
        failureMessage={null}
        locale="en"
        targets={[{ host: "", port: 0 }]}
        timeoutMs=""
        run={{ kind: "idle" }}
        onTargetChange={noop}
        onAddTarget={noop}
        onRemoveTarget={noop}
        onTimeoutChange={noop}
        onRun={noop}
        onRetryStatus={noop}
      />,
      "en",
    );
    expect(html).not.toMatch(/[\u4e00-\u9fff]/);
    expect(html.toLowerCase()).not.toContain("healthy");
    expect(html).toContain("audited");
  });
});

/* ================================================================== */
/* 切 Workspace：结构性丢弃在途响应                                      */
/* ================================================================== */

describe("切 Workspace 丢弃晚到响应（与既有栅栏同一实现）", () => {
  test("作废后的在途结果不写状态", () => {
    const fence = createPermissionRequestFence();
    const ticket = fence.next();
    fence.next(); // 切了 Workspace
    expect(fence.current(ticket)).toBe(false);
  });
});

/* ================================================================== */
/* mock：与真机同路径同码；不伪造探测结果                                 */
/* ================================================================== */

describe("mock：同路径同码 + 拒绝伪造探测结果", () => {
  const OWNER = "tunex_session=u1"; // super_admin（真机夹具同样是 super_admin）
  const MEMBER = "tunex_session=u3"; // member：有 node:read，但非平台管理员

  async function call<T>(method: string, path: string, options: { body?: unknown; cookie?: string; workspaceId?: number } = {}) {
    const res = await handleMock(method, path, {
      cookie: options.cookie ?? OWNER,
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    return res as { status: number; body: T };
  }

  beforeEach(() => {
    resetStore();
  });

  test("status 与真机同形：缺省关闭 + 管理员例外 + caps/caveats 逐字", async () => {
    // mock 层返回的是**未包一层 data 的载荷**（与其它 handler 一致，客户端 `unwrapData` 两种都认）。
    const res = await call<typeof REAL_STATUS>("GET", "looking-glass/status");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.switch_env).toBe("LOOKING_GLASS_ENABLED");
    expect(res.body.platform_admin_override).toBe(true);
    expect(res.body.method).toBe("tcp_connect");
    expect(res.body.caps).toEqual(REAL_STATUS.caps);
    expect(res.body.caveats).toEqual(REAL_STATUS.caveats);
  });

  test("非平台管理员：开关关闭 ⇒ 403 looking_glass_disabled（与真机同码同层）", async () => {
    const res = await call<{ code: string; error_layer: string }>("POST", "looking-glass/nodes/1/tests", {
      cookie: MEMBER,
      body: { targets: [{ host: "1.1.1.1", port: 443 }] },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("looking_glass_disabled");
    expect(res.body.error_layer).toBe("capability");
  });

  test("目标校验与真机同码：私网 / 端口 / 方法 / 超时 / 条数 / 重复 / 节点", async () => {
    const cases: { body: unknown; status: number; code: string }[] = [
      { body: { targets: [{ host: "10.0.0.1", port: 443 }] }, status: 400, code: "target_not_public" },
      { body: { targets: [{ host: "127.0.0.1", port: 80 }] }, status: 400, code: "target_not_public" },
      { body: { targets: [{ host: "1.1.1.1", port: 0 }] }, status: 400, code: "invalid_port" },
      { body: { targets: [{ host: "1.1.1.1", port: 443 }], method: "udp" }, status: 400, code: "method_not_supported" },
      { body: { targets: [{ host: "1.1.1.1", port: 443 }], timeout_ms: 99999 }, status: 400, code: "timeout_out_of_range" },
      { body: { targets: Array.from({ length: 5 }, (_, i) => ({ host: `1.1.1.${i + 1}`, port: 443 })) }, status: 400, code: "too_many_targets" },
      { body: { targets: [] }, status: 400, code: "too_many_targets" },
      { body: { targets: [{ host: "1.1.1.1", port: 443 }, { host: "1.1.1.1", port: 443 }] }, status: 400, code: "duplicate_target" },
    ];
    for (const entry of cases) {
      const res = await call<{ code: string }>("POST", "looking-glass/nodes/1/tests", { body: entry.body });
      expect(`${JSON.stringify(entry.body)} -> ${res.status}/${res.body.code}`).toBe(
        `${JSON.stringify(entry.body)} -> ${entry.status}/${entry.code}`,
      );
    }
    const missing = await call<{ code: string }>("POST", "looking-glass/nodes/999999/tests", {
      body: { targets: [{ host: "1.1.1.1", port: 443 }] },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("not_found");
  });

  test("合法目标走到下发 ⇒ 502 agent_failed，且**响应里没有任何结果行**（不伪造 reachable）", async () => {
    const res = await call<{ code: string; error: string }>("POST", "looking-glass/nodes/1/tests", {
      body: { targets: [{ host: "1.1.1.1", port: 443 }] },
    });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("agent_failed");
    expect(res.body.error).toContain("不伪造");
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("reachable");
    expect(raw).not.toContain("results");
    expect(raw).not.toContain("pinned");
  });

  test("单飞：同一节点第二次立即发起 ⇒ 409 looking_glass_busy", async () => {
    await call("POST", "looking-glass/nodes/1/tests", { body: { targets: [{ host: "1.1.1.1", port: 443 }] } });
    const second = await call<{ code: string }>("POST", "looking-glass/nodes/1/tests", {
      body: { targets: [{ host: "1.1.1.1", port: 443 }] },
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("looking_glass_busy");
  });

  test("作用域外 ⇒ 404（不区分「不存在」与「不是你的」）", async () => {
    // u3 不是工作空间 1 的成员：与真机 `resolveWorkspaceAccess` 同一道门。
    const res = await call<{ code: string }>("POST", "looking-glass/nodes/1/tests", {
      cookie: "tunex_session=u3",
      workspaceId: 1,
      body: { targets: [{ host: "1.1.1.1", port: 443 }] },
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
    expect(JSON.stringify(res.body)).not.toContain("reachable");
  });
});
