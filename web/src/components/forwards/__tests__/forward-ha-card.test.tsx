/**
 * task-16 的 Web 消费面：`ForwardHaPanel`（纯展示）+ 取数守卫 + mock 契约。
 *
 * 这个文件守的是**读法**，不是像素。形状取自在隔离环境里跑真实后端跑出来的响应
 * （`GET /api/forwards/1/ha` 的真实 200 / 404 / 400 体，见 task-16 报告）。
 *
 * 六条纪律在这里被钉住：
 *
 *   1. **策略 `false` 只能说「平台未启用自动迁移」**：`FAILOVER_POLICY` 缺省即关
 *      （生产缺省就是两个 `false`），所以渲染分支里不许出现"已启用 / 已保护 / 已容灾 /
 *      不会中断 / 业务不中断"这类承诺或反向吹嘘；
 *   2. **期望（首选入口）与事实（当前归属 / 连接 / 准入）分成三块**，各有独立 testid；
 *      `can_be_preferred=true` 的节点可以是**离线**甚至**维护中**的 —— 写入路径规则与
 *      "此刻能不能接管"是两件事；
 *   3. **候选三态可分**：`available` / `none` / `unavailable` 各有独立 testid，
 *      `unavailable` 的渲染里**不得**出现 `none` 的文案（"读不到" ≠ "没有"）；
 *   4. **策略 `parse_error` 必须如实呈现**（"配置坏了" ≠ "运维没开"）；
 *   5. **切 Workspace 丢弃晚到响应**（成功与失败都丢）；
 *   6. mock 与真实端点同形（含 PUT 的三条拒绝码与"策略缺省即关"）。
 *
 * 跑法（web 目录）：bun test src/components/forwards/__tests__/forward-ha-card.test.tsx
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import {
  FORWARD_HA_POLL_MS,
  forwardHaErrorInfo,
  PREFERRED_INGRESS_ERROR_CODES,
  type ForwardHaProjection,
} from "@/lib/api/forward-ha";
import {
  candidateKind,
  createHaScopeGuard,
  ForwardHaPanel,
  haGate,
  haPollIntervalMs,
  HA_DENIED,
  HA_LOADING,
  loadHaState,
  optionOf,
  policyEnabled,
  preferredCandidates,
  type ForwardHaState,
} from "@/components/forwards/forward-ha-card";
import { handleForwardHaMock, resetForwardHaMock } from "@/mocks/handlers/forward-ha";
import { getStore, resetStore } from "@/mocks/state";
import { ApiError } from "@/lib/api/core";
import { getDictionary } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import type { MockAuthedRouteContext, MockResponse } from "@/mocks/runtime";

/* ================================================================== */
/* 真实形状的样本（取自隔离环境里的真实响应，逐字）                        */
/* ================================================================== */

const NODE_OPTION = (over: Partial<ForwardHaProjection["ingress_members"]["nodes"][number]>) => ({
  node_id: 1,
  name: "ha16-node-a",
  role: "ingress",
  node_group_id: 1,
  is_active_ingress: true,
  is_preferred: false,
  is_failback_target: false,
  can_be_preferred: true,
  preference_rejection: null,
  connection: "online",
  lifecycle: "active",
  accepts_new_business: true,
  admission_rejection: null,
  can_take_over: false,
  takeover_rejection: "current_owner",
  failover_rank: null,
  ...over,
});

/** 真实缺省响应：策略两个都关、有偏好为空、候选 available（隔离环境里 node b 在线）。 */
const PROJECTION: ForwardHaProjection = {
  forward_id: 1,
  preferred_ingress_node_id: null,
  active_ingress_node_id: 1,
  policy: { auto_failover: false, auto_failback: false, parse_error: null },
  failover_candidate: { status: "available", node_id: 2, reason: null },
  // 平台缺省（生产缺省）：两个开关都关，所以"回切目标已记录但不会被自动执行"。
  member_priority: { source: "platform_rule_node_id_asc", custom_order_supported: false },
  failback: {
    auto_failback: false,
    target_node_id: null,
    preferred_ingress_node_id: null,
    progress: { healthy_checks: 0, required_checks: 3, met: false },
  },
  ingress_members: {
    status: "ok",
    nodes: [
      NODE_OPTION({}),
      NODE_OPTION({
        node_id: 2,
        name: "ha16-node-b",
        is_active_ingress: false,
        can_take_over: true,
        takeover_rejection: null,
        failover_rank: 1,
      }),
    ],
  },
};

/** 有偏好且平台开了自动回切：回切目标是 node b，进度 2/3。 */
const WITH_FAILBACK: ForwardHaProjection = {
  ...PROJECTION,
  preferred_ingress_node_id: 2,
  failback: {
    auto_failback: true,
    target_node_id: 2,
    preferred_ingress_node_id: 2,
    progress: { healthy_checks: 2, required_checks: 3, met: false },
  },
  ingress_members: {
    status: "ok",
    nodes: [
      NODE_OPTION({}),
      NODE_OPTION({
        node_id: 2,
        name: "ha16-node-b",
        is_active_ingress: false,
        is_preferred: true,
        is_failback_target: true,
        can_take_over: true,
        takeover_rejection: null,
        failover_rank: 1,
      }),
    ],
  },
};

const data = (projection: ForwardHaProjection): ForwardHaState => ({ status: "data", projection });

const render = (state: ForwardHaState, locale: Locale = "zh", props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <I18nProvider locale={locale} dict={getDictionary(locale)}>
      <ForwardHaPanel
        state={state}
        onReload={() => {}}
        onSetPreferred={() => {}}
        {...(props as object)}
      />
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

/**
 * 承诺/吹嘘词纪律。这一组词是**结论**，面板拿不到它们的证据：
 * 说"已容灾 / 不会中断"就是把"平台可能迁移"吹成"业务不中断"。
 */
function expectNoPromiseWords(text: string): void {
  for (const forbidden of ["已容灾", "不会中断", "业务不中断", "不中断", "已保护", "已完成容灾"]) {
    expect(text).not.toContain(forbidden);
  }
}

/** 策略关闭时**不得**被说成启用（这是本任务最核心的一条）。 */
function expectPolicyOffNotClaimedEnabled(text: string): void {
  expect(text).toContain("平台未启用自动迁移");
  expect(text).not.toContain("平台已启用自动迁移");
  expect(text).not.toContain("已启用自动回切");
}

/* ================================================================== */
/* ① 策略真值：false ≠ 已启用                                            */
/* ================================================================== */

describe("策略真值：false 一律是「平台未启用自动迁移」", () => {
  test("两个开关都 false（生产缺省）⇒ 明确说未启用，且不出现任何承诺词", () => {
    const html = render(data(PROJECTION));
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-policy-off"');
    expect(html).not.toContain('data-testid="forward-ha-policy-on"');
    expectPolicyOffNotClaimedEnabled(text);
    expectNoPromiseWords(text);
    expect(text).toContain("缺省即关");
  });

  test("开关打开时如实说明它开了什么，并明确不做预告", () => {
    const html = render(
      data({
        ...PROJECTION,
        policy: { auto_failover: true, auto_failback: true, parse_error: null },
      }),
    );
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-policy-on"');
    expect(text).toContain("auto_failover");
    expect(text).toContain("auto_failback");
    expect(text).toContain("短暂中断");
    expectNoPromiseWords(text);
  });

  test("配置坏了：fail-closed 成 false，但 parse_error 必须如实带出", () => {
    const html = render(
      data({
        ...PROJECTION,
        policy: { auto_failover: false, auto_failback: false, parse_error: "Expected '}'" },
      }),
    );
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-policy-parse-error"');
    expect(text).toContain("配置坏了");
    expect(text).toContain("不是「运维没开」");
    expectPolicyOffNotClaimedEnabled(text);
  });

  test("policyEnabled 只看真值：两个 false 就是 false", () => {
    expect(policyEnabled({ auto_failover: false, auto_failback: false, parse_error: null })).toBe(false);
    expect(policyEnabled({ auto_failover: true, auto_failback: false, parse_error: "x" })).toBe(true);
  });
});

/* ================================================================== */
/* ② 期望 vs 事实                                                       */
/* ================================================================== */

describe("期望（首选入口）与事实（当前归属 / 连接 / 准入）分开", () => {
  test("没有偏好时说「没有偏好」，并声明它只是期望", () => {
    const html = render(data(PROJECTION));
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-preferred-none"');
    expect(html).toContain('data-testid="forward-ha-active"');
    expect(text).toContain("首选只是期望");
    expect(text).toContain("不会立刻改归属");
  });

  test("有偏好时显示名称，同时照旧显示归属事实", () => {
    const html = render(
      data({
        ...PROJECTION,
        preferred_ingress_node_id: 2,
        ingress_members: {
          status: "ok",
          nodes: [
            NODE_OPTION({}),
            NODE_OPTION({ node_id: 2, name: "ha16-node-b", is_active_ingress: false, is_preferred: true }),
          ],
        },
      }),
    );
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-preferred-set"');
    expect(text).toContain("ha16-node-b");
    expect(text).toContain("首选入口（期望）");
    expect(text).toContain("当前归属入口（事实）");
  });

  test("offline + maintenance 的节点**仍然可以**被设为首选，但事实栏如实写出来", () => {
    const html = render(
      data({
        ...PROJECTION,
        active_ingress_node_id: null,
        policy: { auto_failover: false, auto_failback: false, parse_error: null },
        failover_candidate: { status: "none", node_id: null, reason: null },
        ingress_members: {
          status: "ok",
          nodes: [
            NODE_OPTION({
              connection: "offline",
              lifecycle: "maintenance",
              accepts_new_business: false,
              admission_rejection: "node_in_maintenance",
              is_active_ingress: false,
            }),
          ],
        },
      }),
    );
    const text = visibleText(html);
    // 写入路径规则（同组 + ingress 角色）与"此刻能不能接管"是两件事：
    expect(html).toContain('data-testid="forward-ha-set-1"');
    expect(html).not.toContain('data-testid="forward-ha-option-rejected-1"');
    expect(text).toContain("连接：离线");
    expect(text).toContain("不接受新业务（node_in_maintenance）");
    expect(text).toContain("维护中");
    // 没有归属入口 = "没有"，不是"未知"
    expect(html).toContain('data-testid="forward-ha-active-none"');
    expect(text).toContain("不是「未知」，而是「没有」");
  });

  test("角色不符的节点不能设为首选，并给出与后端同词表的原因码", () => {
    const html = render(
      data({
        ...PROJECTION,
        ingress_members: {
          status: "ok",
          nodes: [NODE_OPTION({ role: "egress", can_be_preferred: false, preference_rejection: "role_mismatch" })],
        },
      }),
    );
    expect(html).toContain('data-testid="forward-ha-option-rejected-1"');
    expect(html).not.toContain('data-testid="forward-ha-set-1"');
    expect(visibleText(html)).toContain("不可设为首选（role_mismatch）");
  });

  test("preferredCandidates / optionOf 是纯函数（按 id 升序、只管行内数据）", () => {
    expect(preferredCandidates(PROJECTION).map((n) => n.node_id)).toEqual([1, 2]);
    expect(optionOf(PROJECTION, 2)?.name).toBe("ha16-node-b");
    expect(optionOf(PROJECTION, 99)).toBeNull();
    expect(optionOf(PROJECTION, null)).toBeNull();
    expect(preferredCandidates({ ...PROJECTION, ingress_members: { status: "unavailable", nodes: [] } })).toEqual([]);
  });
});

/* ================================================================== */
/* ③ 候选三态                                                           */
/* ================================================================== */

describe("候选三态各有独立呈现：available / none / unavailable", () => {
  test("available：说的是「合格」，并明确它不是「已迁移」", () => {
    const html = render(data(PROJECTION));
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-candidate-available"');
    expect(html).not.toContain('data-testid="forward-ha-candidate-none"');
    expect(html).not.toContain('data-testid="forward-ha-candidate-unavailable"');
    expect(text).toContain("有一台此刻合格的候选入口");
    expect(text).toContain("合格 ≠ 已经迁移");
    expectNoPromiseWords(text);
  });

  test("none：确实没有合格候选，并且不把它说成「这条转发无法高可用」", () => {
    const html = render(
      data({
        ...PROJECTION,
        failover_candidate: { status: "none", node_id: null, reason: null },
      }),
    );
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-candidate-none"');
    expect(html).not.toContain('data-testid="forward-ha-candidate-available"');
    expect(html).not.toContain('data-testid="forward-ha-candidate-unavailable"');
    expect(text).toContain("现在没有可接管的候选入口");
    expect(text).toContain("这一次判定");
    expect(text).not.toContain("无法高可用（");
  });

  test("unavailable：只说「没读到」，绝不退化成「没有候选」", () => {
    const html = render(
      data({
        ...PROJECTION,
        failover_candidate: { status: "unavailable", node_id: null, reason: "candidate_query_failed" },
      }),
    );
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-candidate-unavailable"');
    expect(html).not.toContain('data-testid="forward-ha-candidate-none"');
    expect(html).not.toContain('data-testid="forward-ha-candidate-available"');
    expect(text).toContain("没有读到");
    expect(text).toContain("candidate_query_failed");
    expect(text).toContain("不等于「没有候选」");
    expect(text).not.toContain("现在没有可接管的候选入口");
  });

  test("成员列表读不到：它自己是一个降级态，且不影响候选事实的呈现", () => {
    const html = render(
      data({
        ...PROJECTION,
        ingress_members: { status: "unavailable", nodes: [] },
      }),
    );
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-members-unavailable"');
    expect(text).toContain("也不代表这个入口组里没有成员");
    expect(html).toContain('data-testid="forward-ha-candidate-available"');
    // 「读不到」不许退化成「没有成员」。
    expect(html).not.toContain('data-testid="forward-ha-members-empty"');
  });

  test("candidateKind 逐字透传服务端状态（不在这里做任何映射/归一）", () => {
    expect(candidateKind({ status: "available", node_id: 2, reason: null })).toBe("available");
    expect(candidateKind({ status: "none", node_id: null, reason: null })).toBe("none");
    expect(candidateKind({ status: "unavailable", node_id: null, reason: "x" })).toBe("unavailable");
  });
});

/* ================================================================== */
/* ③b 入口成员与优先级 / 恢复后切回（task-38，行为参照 ForwardX）        */
/* ================================================================== */

describe("入口成员：次序、能否接管、以及三个不同的态", () => {
  test("成员按平台次序展示名次，并区分「能不能当首选」与「此刻能不能接管」", () => {
    const html = render(data(PROJECTION));
    const text = visibleText(html);
    // 现任：名次为 —（它不是接管者），但它是可被替换的首选目标
    expect(html).toContain('data-testid="forward-ha-rank-1"');
    expect(html).toContain('data-testid="forward-ha-rank-2"');
    expect(html).toContain('data-testid="forward-ha-option-takeover-1"');
    expect(text).toContain("此刻不可接管（current_owner）");
    expect(text).toContain("此刻可接管（平台次序第 1 位）");
    // 顺序来源如实写明"不是自定义顺序"
    expect(html).toContain('data-testid="forward-ha-members-order-source"');
    expect(text).toContain("按这条转发自定义顺序尚未提供");
  });

  test("有成员但没有一台能接管：这是独立的第三态（不是「没有成员」）", () => {
    const html = render(
      data({
        ...PROJECTION,
        failover_candidate: { status: "none", node_id: null, reason: null },
        ingress_members: {
          status: "ok",
          nodes: [
            NODE_OPTION({ can_take_over: false, takeover_rejection: "node_not_online" }),
            NODE_OPTION({
              node_id: 2,
              name: "ha16-node-b",
              is_active_ingress: false,
              connection: "offline",
              can_take_over: false,
              takeover_rejection: "node_not_online",
            }),
          ],
        },
      }),
    );
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-members-no-takeover"');
    expect(text).toContain("有成员，但此刻没有一台能接管");
    expect(html).not.toContain('data-testid="forward-ha-members-empty"');
    expect(html).not.toContain('data-testid="forward-ha-members-unavailable"');
  });

  test("组里确实没有成员：与「读不到」「没有合格候选」都不同", () => {
    const html = render(
      data({
        ...PROJECTION,
        failover_candidate: { status: "none", node_id: null, reason: null },
        ingress_members: { status: "ok", nodes: [] },
      }),
    );
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-members-empty"');
    expect(text).toContain("这个入口节点组里没有任何成员");
    expect(html).not.toContain('data-testid="forward-ha-members-unavailable"');
    expect(html).not.toContain('data-testid="forward-ha-members-no-takeover"');
  });

  test("成员的非入口角色仍可被识别为「不可当首选」（与接管判定分开）", () => {
    const html = render(
      data({
        ...PROJECTION,
        ingress_members: {
          status: "ok",
          nodes: [
            NODE_OPTION({
              role: "egress",
              can_be_preferred: false,
              preference_rejection: "role_mismatch",
              can_take_over: false,
              takeover_rejection: "role_mismatch",
            }),
          ],
        },
      }),
    );
    const text = visibleText(html);
    expect(text).toContain("不可设为首选（role_mismatch）");
    expect(text).toContain("此刻不可接管（role_mismatch）");
  });
});

describe("恢复后切回：平台开关真值 + 进度，且不许说成「已保护」", () => {
  test("平台未启用自动回切：明确说「不会被自动切回」，即使首选已记录", () => {
    const html = render(
      data({
        ...PROJECTION,
        preferred_ingress_node_id: 2,
        failback: {
          auto_failback: false,
          target_node_id: 2,
          preferred_ingress_node_id: 2,
          progress: { healthy_checks: 1, required_checks: 3, met: false },
        },
      }),
    );
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-failback-switch"');
    expect(text).toContain("平台未启用自动回切");
    expect(text).toContain("首选只是被记录下来的期望");
    expect(text).toContain("连续健康 1/3 次");
    expect(text).toContain("未满足");
    expectNoPromiseWords(text);
  });

  test("平台已启用自动回切：说清「会尝试切回」，并回显进度与阈值", () => {
    const html = render(data(WITH_FAILBACK));
    const text = visibleText(html);
    expect(text).toContain("平台已启用自动回切");
    expect(text).toContain("连续健康 2/3 次");
    expect(text).toContain("本卡片只回显计数与阈值，不预告迁移什么时候发生");
    expect(html).toContain('data-testid="forward-ha-option-failback-2"');
    expectNoPromiseWords(text);
  });

  test("没有首选入口 ⇒ 回切没有目标（不是「进度为 0」）", () => {
    const html = render(data(PROJECTION));
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-failback-no-target"');
    expect(text).toContain("回切没有目标");
    expect(html).not.toContain('data-testid="forward-ha-failback-progress"');
  });

  test("en 文案同样区分「已启用/未启用回切」", () => {
    const off = visibleText(render(data(PROJECTION), "en"));
    expect(off).toContain("Automatic failback is not enabled");
    const on = visibleText(render(data(WITH_FAILBACK), "en"));
    expect(on).toContain("Automatic failback is enabled");
  });
});

/* ================================================================== */
/* ④ 取数：loading / denied / error / 守卫                              */
/* ================================================================== */

describe("取数状态与作用域守卫", () => {
  test("loading / denied 各有独立 testid，且都不读库（纯渲染）", () => {
    expect(render(HA_LOADING)).toContain('data-testid="forward-ha-loading"');
    const denied = render(HA_DENIED);
    expect(denied).toContain('data-testid="forward-ha-denied"');
    expect(visibleText(denied)).toContain("没有查看高可用事实的权限");
  });

  test("取不到：不许说成「没有高可用」，并回显后端 code", () => {
    const html = render({
      status: "error",
      error: forwardHaErrorInfo(new ApiError(500, "boom", { code: "internal_error" })),
    });
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-unavailable"');
    expect(text).toContain("既不能说明平台会迁移，也不能说明不会迁移");
    expect(text).toContain("internal_error");
    expectNoPromiseWords(text);
  });

  test("写入失败：原因码映射成可读解释，并保留原文", () => {
    const html = render(data(PROJECTION), "zh", {
      writeError: { code: PREFERRED_INGRESS_ERROR_CODES.preferred_role_mismatch, message: "该节点的角色不能作为入口", layer: "failover" },
    });
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-ha-write-error"');
    expect(text).toContain("首选入口没有写入成功");
    expect(text).toContain("该节点的角色不能作为入口"); // 后端原文照旧保留
    expect(text).toContain("该节点的角色不能作为入口（需要 ingress 或 both）");
  });

  test("守卫：claim 之后旧令牌作废，invalidate 让在途请求过期", () => {
    const guard = createHaScopeGuard();
    const first = guard.claim();
    expect(guard.isCurrent(first)).toBe(true);
    const second = guard.claim();
    expect(guard.isCurrent(first)).toBe(false);
    guard.invalidate();
    expect(guard.isCurrent(second)).toBe(false);
  });

  test("切走后，上一个空间的晚到**成功**响应被丢弃", async () => {
    const guard = createHaScopeGuard();
    let resolveLate: (value: ForwardHaProjection) => void = () => {};
    const token = guard.claim();
    const pending = loadHaState({
      forwardId: 1,
      token,
      guard,
      read: () => new Promise<ForwardHaProjection>((resolve) => (resolveLate = resolve)),
    });
    guard.claim();
    resolveLate(PROJECTION);
    expect((await pending).applied).toBe(false);
  });

  test("切走后，上一个空间的晚到**失败**也不许显示", async () => {
    const guard = createHaScopeGuard();
    let rejectLate: (error: unknown) => void = () => {};
    const token = guard.claim();
    const pending = loadHaState({
      forwardId: 1,
      token,
      guard,
      read: () => new Promise<ForwardHaProjection>((_resolve, reject) => (rejectLate = reject)),
    });
    guard.invalidate();
    rejectLate(new ApiError(404, "端口转发不存在", { code: "not_found" }));
    const late = await pending;
    expect(late.applied).toBe(false);
    expect(late.state.status === "error" && late.state.error.code).toBe("not_found");
  });

  test("权限未读出时不当作无权（wait），也不发请求", () => {
    expect(haGate({ hasReadPermission: false, permissionsLoading: true })).toBe("wait");
    expect(haGate({ hasReadPermission: false, permissionsLoading: false })).toBe("denied");
    expect(haGate({ hasReadPermission: true, permissionsLoading: false })).toBe("load");
  });

  test("轮询：只有 data 才刷新（30s），错误/无权不自动重试", () => {
    expect(FORWARD_HA_POLL_MS).toBe(30_000);
    expect(haPollIntervalMs(data(PROJECTION))).toBe(FORWARD_HA_POLL_MS);
    expect(haPollIntervalMs(HA_LOADING)).toBeNull();
    expect(haPollIntervalMs(HA_DENIED)).toBeNull();
    expect(haPollIntervalMs({ status: "error", error: { code: "x", message: "y", layer: null } })).toBeNull();
  });
});

/* ================================================================== */
/* ⑤ en 文案不漏中文，且同样不含承诺词                                   */
/* ================================================================== */

describe("en 文案", () => {
  test("没有未翻译的中文", () => {
    const text = visibleText(render(data(PROJECTION), "en"));
    expect(/[\u4e00-\u9fa5]/.test(text)).toBe(false);
    expect(text).toContain("Automatic migration is not enabled");
    expect(text).toContain("Preferred ingress (expectation)");
    expect(text).toContain("Current owner ingress (fact)");
  });

  test("en 的分支同样没有承诺词", () => {
    const cases: ForwardHaState[] = [
      data(PROJECTION),
      data({ ...PROJECTION, policy: { auto_failover: true, auto_failback: true, parse_error: null } }),
      data({ ...PROJECTION, failover_candidate: { status: "none", node_id: null, reason: null } }),
      data({ ...PROJECTION, failover_candidate: { status: "unavailable", node_id: null, reason: "candidate_query_failed" } }),
      HA_DENIED,
    ];
    for (const state of cases) {
      const text = visibleText(render(state, "en"));
      expect(text).not.toContain("no downtime");
      expect(text).not.toContain("protected");
      expect(text).not.toContain("is resilient");
    }
  });
});

/* ================================================================== */
/* ⑥ mock：与真实端点同形（含 PUT 的三条拒绝码）                          */
/* ================================================================== */

const mockCtx = (method: string, seg: string[], body?: unknown): MockAuthedRouteContext => {
  const db = getStore();
  return {
    method,
    clean: seg.join("/"),
    seg,
    q: undefined,
    db,
    user: db.user,
    req: { body, cookie: "tunex_session=u1", query: {} },
    scopeId: db.workspaces.find((w) => w.personal_user_id === db.user.id)?.id,
  };
};

const call = async (method: string, seg: string[], body?: unknown): Promise<{ status: number; body: any }> => {
  const res = (await handleForwardHaMock(mockCtx(method, seg, body))) as MockResponse | null;
  expect(res).not.toBeNull();
  return { status: res!.status, body: res!.body };
};

describe("mock：GET /forwards/:id/ha 与 PUT /forwards/:id/preferred-ingress", () => {
  beforeEach(() => {
    resetStore();
    resetForwardHaMock();
  });

  test("缺省策略即关；候选按同一口径算出 none（组内节点都还没上报）", async () => {
    const res = await call("GET", ["forwards", "1", "ha"]);
    expect(res.status).toBe(200);
    const body = res.body as ForwardHaProjection;
    expect(Object.keys(body).sort()).toEqual([
      "active_ingress_node_id",
      "failback",
      "failover_candidate",
      "forward_id",
      "ingress_members",
      "member_priority",
      "policy",
      "preferred_ingress_node_id",
    ]);
    expect(body.policy).toEqual({ auto_failover: false, auto_failback: false, parse_error: null });
    expect(body.preferred_ingress_node_id).toBeNull();
    expect(body.failover_candidate).toEqual({ status: "none", node_id: null, reason: null });
    const options = body.ingress_members as { status: "ok"; nodes: ForwardHaProjection["ingress_members"]["nodes"] };
    expect(options.status).toBe("ok");
    // 种子行：role=ingress（组方向兜底）⇒ 能设为首选；但还没上报 ⇒ 事实是 waiting
    for (const node of options.nodes) {
      expect(node.can_be_preferred).toBe(true);
      expect(node.connection).toBe("waiting");
      expect(node.accepts_new_business).toBe(false);
      expect(node.admission_rejection).toBe("node_waiting_install");
    }
  });

  test("策略坏 JSON ⇒ 两个 false + parse_error（与后端同一 fail-closed 口径）", async () => {
    getStore().systemConfig.push({ name: "FAILOVER_POLICY", value: "{not json" } as never);
    const res = await call("GET", ["forwards", "1", "ha"]);
    const body = res.body as ForwardHaProjection;
    expect(body.policy.auto_failover).toBe(false);
    expect(body.policy.auto_failback).toBe(false);
    expect(typeof body.policy.parse_error).toBe("string");
  });

  test("有节点真上报过（online）⇒ 候选 available，且不是现任那一台", async () => {
    const db = getStore();
    const ingressId = (await call("GET", ["forwards", "1", "ha"])).body.active_ingress_node_id;
    const other = db.nodes.find((n) => n.node_group_id === 1 && n.id !== ingressId)!;
    other.has_credential = true;
    other.credential_revoked = false;
    other.status = "active";
    other.last_seen_at = new Date() as never;
    const body = (await call("GET", ["forwards", "1", "ha"])).body as ForwardHaProjection;
    expect(body.failover_candidate).toEqual({ status: "available", node_id: other.id, reason: null });
  });

  test("PUT 设为首选 → GET 回读；清除（null）后回到没有偏好", async () => {
    const set = await call("PUT", ["forwards", "1", "preferred-ingress"], { node_id: 2 });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ tunnel_id: 1, preferred_ingress_node_id: 2 });
    expect((await call("GET", ["forwards", "1", "ha"])).body.preferred_ingress_node_id).toBe(2);
    // 偏好是**期望**：现任归属不受影响
    const projection = (await call("GET", ["forwards", "1", "ha"])).body as ForwardHaProjection;
    expect(projection.active_ingress_node_id).not.toBe(2);
    const cleared = await call("PUT", ["forwards", "1", "preferred-ingress"], { node_id: null });
    expect(cleared.body.preferred_ingress_node_id).toBeNull();
    expect((await call("GET", ["forwards", "1", "ha"])).body.preferred_ingress_node_id).toBeNull();
  });

  test("PUT 拒绝码与后端同源：不存在 / 跨组 / 角色不符 / 形状非法", async () => {
    const missing = await call("PUT", ["forwards", "1", "preferred-ingress"], { node_id: 999 });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("preferred_not_found");

    const db = getStore();
    const foreign = db.nodes.find((n) => n.node_group_id !== 1)!;
    const crossGroup = await call("PUT", ["forwards", "1", "preferred-ingress"], { node_id: foreign.id });
    expect(crossGroup.status).toBe(400);
    expect(crossGroup.body.code).toBe("preferred_node_group_mismatch");

    // 同组但角色不是入口：临时把一台组内节点的 role 改成 egress
    const inGroup = db.nodes.find((n) => n.node_group_id === 1)!;
    inGroup.role = "egress";
    const roleMismatch = await call("PUT", ["forwards", "1", "preferred-ingress"], { node_id: inGroup.id });
    expect(roleMismatch.status).toBe(400);
    expect(roleMismatch.body.code).toBe("preferred_role_mismatch");

    const badShape = await call("PUT", ["forwards", "1", "preferred-ingress"], { node_id: "2" });
    expect(badShape.status).toBe(400);
    expect(badShape.body.code).toBe("invalid_input");
  });

  test("转发不存在 ⇒ 404；与本文件无关的路径 ⇒ null（交给后面的 handler）", async () => {
    expect((await call("GET", ["forwards", "999", "ha"])).status).toBe(404);
    expect(await handleForwardHaMock(mockCtx("GET", ["forwards", "1", "latency"]))).toBeNull();
    expect(await handleForwardHaMock(mockCtx("POST", ["forwards", "1", "ha"]))).toBeNull();
    expect(await handleForwardHaMock(mockCtx("GET", ["nodes", "1", "ha"]))).toBeNull();
  });
});
