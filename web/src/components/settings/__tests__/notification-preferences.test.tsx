/**
 * 切片 N1 —— 用户域「通知偏好」的行为测试。
 *
 * 分两层，因为本仓没有 happy-dom / testing-library（组件测试一律走 `renderToStaticMarkup`）：
 *
 *  A. **时序层**：直接驱动 `createPreferencesController()`（注入式编排 + 受控 promise），
 *     证明三态、400/503 分开、全量替换、以及"工作空间切换时晚到响应被丢弃"。
 *     这些是**行为**断言，不是"源码里出现过某个字符串"。
 *  B. **呈现层**：静态渲染 `NotificationPreferencesBody`，逐分支断言页面说了什么。
 *     重点钉死 R4-A 的 G9：6 个类别里**只有 `announcement` 今天真的会投递**，
 *     不得把 6 类渲染成等价可用；`degraded` 不许折叠成"全部未静音"。
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import { getDictionary } from "@/lib/i18n";
import { ApiError } from "@/lib/api";
import { createPermissionRequestFence } from "@/lib/workspace-permissions";
import {
  NotificationPreferencesBody,
  classifyLoadFailure,
  classifySaveFailure,
  createPreferencesController,
  isMuted,
  normalizeMutes,
  readSaveEcho,
  sameMuteSet,
  setMuted,
  sortMutes,
} from "@/components/settings/notification-preferences";
import type {
  MutePair,
  PreferencesSave,
  PreferencesSnapshot,
  PreferencesView,
} from "@/components/settings/notification-preferences";
import { notificationText } from "@/lib/notification-i18n";

/* ================================================================== */
/* 工具                                                                */
/* ================================================================== */

const CHANNELS = ["email", "webhook", "telegram"];
const CATEGORIES = ["node", "forward", "reconcile_finding", "workspace_event", "federation_event", "announcement"];

function payload(mutes: MutePair[] = []) {
  return { mutes, channels: [...CHANNELS], categories: [...CATEGORIES] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(options: {
  fetch: () => Promise<ReturnType<typeof payload>>;
  save?: (mutes: readonly MutePair[]) => Promise<unknown>;
}) {
  const snapshots: PreferencesSnapshot[] = [];
  const controller = createPreferencesController({
    fence: createPermissionRequestFence(),
    fetchPreferences: options.fetch,
    savePreferences: options.save ?? (async () => ({ mutes: null })),
    onChange: (snapshot) => snapshots.push(snapshot),
    fallbackLoadMessage: "取不到通知偏好",
    fallbackSaveMessage: "保存请求失败",
  });
  const last = () => snapshots[snapshots.length - 1]!;
  return { controller, snapshots, last };
}

/** 让在途 promise 的 then 回调先跑一轮（受控推进，不用真实计时器）。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/* ================================================================== */
/* A. 时序层                                                           */
/* ================================================================== */

describe("N1 时序：三态与「取不到 ≠ 全部未静音」", () => {
  test("装载成功：闭集与清单都来自服务端，草稿=已保存（dirty=false）", async () => {
    const { controller, last } = harness({ fetch: async () => payload([{ channel_kind: "email", category: "announcement" }]) });
    await controller.load();
    const snapshot = last();
    expect(snapshot.view.kind).toBe("ready");
    const view = snapshot.view as Extract<PreferencesView, { kind: "ready" }>;
    expect(view.channels).toEqual(CHANNELS);
    expect(view.categories).toEqual(CATEGORIES);
    expect(view.mutes).toEqual([{ channel_kind: "email", category: "announcement" }]);
    expect(snapshot.dirty).toBe(false);
  });

  test("装载失败（503 storage_error）：进入 degraded，且**没有任何开关状态**", async () => {
    const { controller, last } = harness({
      fetch: async () => {
        throw new ApiError(503, "免打扰存储暂时不可用", { code: "storage_error" });
      },
    });
    await controller.load();
    const snapshot = last();
    expect(snapshot.view.kind).toBe("degraded");
    const view = snapshot.view as Extract<PreferencesView, { kind: "degraded" }>;
    expect(view.code).toBe("storage_error");
    // 关键：degraded 视图里既没有 channels/categories，也没有任何"未静音"的清单。
    expect(Object.prototype.hasOwnProperty.call(view, "mutes")).toBe(false);
  });

  test("装载失败（网络错误）：同样是 degraded，但 code 明确区分", async () => {
    const { controller, last } = harness({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await controller.load();
    expect((last().view as Extract<PreferencesView, { kind: "degraded" }>).code).toBe("network_error");
  });

  test("装载失败 → 重试成功后回到 ready（三态可以自愈）", async () => {
    let attempt = 0;
    const { controller, last } = harness({
      fetch: async () => {
        attempt += 1;
        if (attempt === 1) throw new ApiError(503, "down", { code: "storage_error" });
        return payload();
      },
    });
    await controller.load();
    expect(last().view.kind).toBe("degraded");
    await controller.load();
    expect(last().view.kind).toBe("ready");
  });
});

describe("N1 时序：保存是「全量替换」，400 与 503 是两个状态", () => {
  test("保存提交整份清单（顺序确定化），成功后采用服务端回显", async () => {
    const saved: MutePair[][] = [];
    const { controller, last } = harness({
      fetch: async () => payload([{ channel_kind: "email", category: "node" }]),
      save: async (mutes) => {
        saved.push([...mutes]);
        // 回显里塞一个重复项：服务端回显是**已落库**真相，页面采用它时必须先归一化。
        return { mutes: [...mutes, mutes[0]!] };
      },
    });
    await controller.load();
    controller.setMuted("telegram", "announcement", true);
    controller.setMuted("email", "announcement", true);
    expect(last().dirty).toBe(true);
    await controller.save();

    // 提交的是**整份**清单（不是增量），且按 (渠道, 类别) 排序。
    expect(saved).toEqual([
      [
        { channel_kind: "email", category: "announcement" },
        { channel_kind: "email", category: "node" },
        { channel_kind: "telegram", category: "announcement" },
      ],
    ]);
    const view = last().view as Extract<PreferencesView, { kind: "ready" }>;
    expect(view.mutes).toEqual([
      { channel_kind: "email", category: "announcement" },
      { channel_kind: "email", category: "node" },
      { channel_kind: "telegram", category: "announcement" },
    ]);
    expect(last().save.kind).toBe("saved");
    expect(last().dirty).toBe(false);
  });

  test("400 unknown_category ⇒ rejected（页面过期，重试无意义）；草稿原样保留", async () => {
    const { controller, last } = harness({
      fetch: async () => payload(),
      save: async () => {
        throw new ApiError(400, "免打扰清单不合法", { code: "unknown_category" });
      },
    });
    await controller.load();
    controller.setMuted("email", "announcement", true);
    await controller.save();
    const save = last().save as Extract<PreferencesSave, { kind: "rejected" }>;
    expect(save.kind).toBe("rejected");
    expect(save.code).toBe("unknown_category");
    // 草稿没被吃掉：用户的选择还在，dirty 仍为 true。
    expect((last().view as Extract<PreferencesView, { kind: "ready" }>).mutes).toEqual([
      { channel_kind: "email", category: "announcement" },
    ]);
    expect(last().dirty).toBe(true);
  });

  test("503 storage_error ⇒ unavailable（可重试）；重试成功后 saved", async () => {
    let attempt = 0;
    const { controller, last } = harness({
      fetch: async () => payload(),
      save: async (mutes) => {
        attempt += 1;
        if (attempt === 1) throw new ApiError(503, "免打扰存储暂时不可用", { code: "storage_error" });
        return { mutes: [...mutes] };
      },
    });
    await controller.load();
    controller.setMuted("telegram", "forward", true);
    await controller.save();
    expect(last().save.kind).toBe("unavailable");
    expect(last().dirty).toBe(true);
    await controller.save();
    expect(last().save.kind).toBe("saved");
    expect(last().dirty).toBe(false);
  });

  test("回显无法辨认时不谎报「清单被清空」：保留本地意图", async () => {
    const { controller, last } = harness({
      fetch: async () => payload([{ channel_kind: "email", category: "node" }]),
      save: async () => ({ ok: true }),
    });
    await controller.load();
    await controller.save();
    expect(last().save.kind).toBe("saved");
    expect((last().view as Extract<PreferencesView, { kind: "ready" }>).mutes).toEqual([
      { channel_kind: "email", category: "node" },
    ]);
  });
});

describe("N1 时序：切换工作空间时丢弃晚到响应（不重取、不改作用域）", () => {
  test("装载在途时切换：晚到答案被丢弃，并且重新发起一次（否则永远停在 loading）", async () => {
    const first = deferred<ReturnType<typeof payload>>();
    const second = deferred<ReturnType<typeof payload>>();
    let calls = 0;
    const { controller, last } = harness({
      fetch: async () => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
    });
    const loading = controller.load();
    expect(last().view.kind).toBe("loading");

    // 切换工作空间：作废在途请求（这一步不改任何作用域，也不把旧答案算到新上下文）
    controller.onContextChanged();
    await flush();
    expect(calls).toBe(2);

    // 第一份答案晚到：必须被丢弃（视图仍是 loading，而不是"已就绪"）
    first.resolve(payload([{ channel_kind: "email", category: "announcement" }]));
    await loading;
    await flush();
    expect(last().view.kind).toBe("loading");

    second.resolve(payload());
    await flush();
    const view = last().view as Extract<PreferencesView, { kind: "ready" }>;
    expect(view.kind).toBe("ready");
    expect(view.mutes).toEqual([]);
  });

  test("已就绪时切换：不重取（用户级偏好跨空间不变），只丢弃在途写入的回执", async () => {
    const pendingSave = deferred<unknown>();
    let fetches = 0;
    const { controller, last } = harness({
      fetch: async () => {
        fetches += 1;
        return payload();
      },
      save: async () => pendingSave.promise,
    });
    await controller.load();
    expect(fetches).toBe(1);
    controller.setMuted("email", "node", true);
    const saving = controller.save();
    expect(last().save.kind).toBe("saving");

    controller.onContextChanged();
    await flush();
    // 不重取
    expect(fetches).toBe(1);
    // 也不停在"正在保存"（否则按钮永远禁用）
    expect(last().save.kind).toBe("idle");
    // 草稿保留：写入可能已经落库，界面如实显示"还有未保存的更改"，用户可以再存一次（幂等全量替换）
    expect(last().dirty).toBe(true);

    pendingSave.resolve({ mutes: [{ channel_kind: "email", category: "node" }] });
    await saving;
    await flush();
    expect(last().save.kind).toBe("idle");
  });

  test("卸载（dispose）后到达的回执同样被丢弃", async () => {
    const pending = deferred<ReturnType<typeof payload>>();
    const { controller, last } = harness({ fetch: () => pending.promise });
    const loading = controller.load();
    controller.dispose();
    pending.resolve(payload([{ channel_kind: "email", category: "announcement" }]));
    await loading;
    await flush();
    expect(last().view.kind).toBe("loading");
  });
});

describe("N1 纯函数：三元组集合运算", () => {
  test("setMuted 是显式设置（幂等），不是取反", () => {
    const base: MutePair[] = [{ channel_kind: "email", category: "node" }];
    expect(setMuted(base, "email", "node", true)).toEqual(base);
    expect(setMuted(base, "email", "node", false)).toEqual([]);
    expect(setMuted(base, "email", "announcement", true)).toEqual([
      { channel_kind: "email", category: "node" },
      { channel_kind: "email", category: "announcement" },
    ]);
    expect(isMuted(base, "email", "node")).toBe(true);
    expect(isMuted(base, "telegram", "node")).toBe(false);
  });

  test("sameMuteSet 忽略顺序，但不容忍重复项造成的差异", () => {
    const a: MutePair[] = [
      { channel_kind: "email", category: "node" },
      { channel_kind: "telegram", category: "forward" },
    ];
    expect(sameMuteSet(a, [...a].reverse())).toBe(true);
    expect(sameMuteSet(a, [a[0]!])).toBe(false);
  });

  test("normalizeMutes 丢掉形状非法的项并去重（不把脏数据当偏好提交）", () => {
    expect(normalizeMutes([{ channel_kind: "email", category: "node" }, { channel_kind: "email", category: "node" }, null, {}, { channel_kind: "", category: "node" }, "x"])).toEqual([
      { channel_kind: "email", category: "node" },
    ]);
  });

  test("readSaveEcho：只有真的带回清单才算回显", () => {
    expect(readSaveEcho({ mutes: [{ channel_kind: "email", category: "node" }] })).toEqual([
      { channel_kind: "email", category: "node" },
    ]);
    expect(readSaveEcho({ mutes: [] })).toEqual([]);
    expect(readSaveEcho({ ok: true })).toBeNull();
    expect(readSaveEcho(null)).toBeNull();
  });

  test("sortMutes 让同一份意图两次提交得到同一个请求体", () => {
    const a: MutePair[] = [
      { channel_kind: "telegram", category: "node" },
      { channel_kind: "email", category: "forward" },
    ];
    expect(sortMutes(a)).toEqual(sortMutes([...a].reverse()));
  });

  test("失败分档：只有 400 是「不被接受」，其余（503/网络）都是「这次没写成」", () => {
    expect(classifySaveFailure(new ApiError(400, "bad", { code: "unknown_channel_kind" }), "fallback")).toMatchObject({
      kind: "rejected",
      code: "unknown_channel_kind",
    });
    expect(classifySaveFailure(new ApiError(503, "down", { code: "storage_error" }), "fallback")).toMatchObject({
      kind: "unavailable",
      code: "storage_error",
    });
    expect(classifySaveFailure(new TypeError("Failed to fetch"), "fallback")).toMatchObject({
      kind: "unavailable",
      code: "network_error",
    });
    expect(classifyLoadFailure(new ApiError(503, "down", { code: "storage_error" }), "fallback")).toMatchObject({
      code: "storage_error",
    });
    expect(classifyLoadFailure(new ApiError(500, "boom", null), "fallback")).toMatchObject({ code: "http_500" });
  });

  test("服务端返回闭集之外的偏好：不静默丢弃，标成 unrepresentable 并原样提交", async () => {
    const submitted: MutePair[][] = [];
    const { controller, last } = harness({
      fetch: async () => ({
        mutes: [{ channel_kind: "email", category: "brand_new_category" }],
        channels: [...CHANNELS],
        categories: [...CATEGORIES],
      }),
      save: async (mutes) => {
        submitted.push([...mutes]);
        return { mutes: [...mutes] };
      },
    });
    await controller.load();
    const view = last().view as Extract<PreferencesView, { kind: "ready" }>;
    expect(view.unrepresentable).toEqual([{ channel_kind: "email", category: "brand_new_category" }]);
    expect(view.mutes).toEqual([{ channel_kind: "email", category: "brand_new_category" }]);
    // 全量替换：那条本页无法表示的偏好必须原样提交，绝不能顺手把用户静音的那一类放开。
    controller.setMuted("telegram", "announcement", true);
    await controller.save();
    expect(submitted).toEqual([
      [
        { channel_kind: "email", category: "brand_new_category" },
        { channel_kind: "telegram", category: "announcement" },
      ],
    ]);
    expect(last().save.kind).toBe("saved");
  });
});

/* ================================================================== */
/* B. 呈现层                                                           */
/* ================================================================== */

const noop = () => undefined;

function renderBody(over: {
  view?: PreferencesView;
  save?: PreferencesSave;
  dirty?: boolean;
  locale?: "zh" | "en";
} = {}): string {
  const locale = over.locale ?? "zh";
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { locale, dict: getDictionary(locale) },
      createElement(NotificationPreferencesBody as never, {
        view: over.view ?? { kind: "ready", channels: [...CHANNELS], categories: [...CATEGORIES], mutes: [], unrepresentable: [] },
        save: over.save ?? { kind: "idle" },
        dirty: over.dirty ?? false,
        onToggle: noop,
        onSave: noop,
        onRetry: noop,
      }),
    ),
  );
}

/** 某个 testid 所在元素的 HTML 片段（用于读 `aria-checked` / `disabled`）。 */
function cellHtml(html: string, cell: string): string {
  const at = html.indexOf(`data-testid="notification-cell-${cell}"`);
  expect(at).toBeGreaterThan(-1);
  const end = html.indexOf('data-testid="notification-cell-', at + 10);
  return html.slice(at, end === -1 ? undefined : end);
}

describe("N1 呈现：只渲染服务端下发的闭集 + 如实标注哪一类今天会投递", () => {
  test("矩阵的行列来自入参（服务端），不是硬编码副本", () => {
    const html = renderBody({
      view: {
        kind: "ready",
        channels: ["telegram"],
        categories: ["announcement"],
        mutes: [],
        unrepresentable: [],
      },
    });
    expect(html).toContain('data-testid="notification-channel-telegram"');
    expect(html).toContain('data-testid="notification-cell-telegram-announcement"');
    // 服务端没下发的渠道/类别一个都不许出现（本页没有自己的副本）。
    expect(html).not.toContain('data-testid="notification-channel-email"');
    expect(html).not.toContain('data-testid="notification-cell-telegram-node"');
  });

  test("服务端新增的未知类别/渠道照样渲染，并如实标注「状态未知」", () => {
    const html = renderBody({
      view: {
        kind: "ready",
        channels: ["email", "matrix"],
        categories: ["node", "brand_new"],
        mutes: [],
        unrepresentable: [],
      },
    });
    expect(html).toContain('data-testid="notification-cell-email-brand_new"');
    expect(html).toContain('data-testid="notification-channel-matrix"');
    expect(html).toContain("状态未知");
    // 未知值本身也要显示出来（不能只显示一个占位符）
    expect(html).toContain("brand_new");
  });

  test("6 个类别里**只有 announcement** 被说成「今天会投递」", () => {
    const html = renderBody();
    const liveCount = (html.match(/今天会投递/g) ?? []).length;
    // 3 个渠道 × 1 个 announcement 类别 = 3 处（每个渠道各一行）
    expect(liveCount).toBe(3);
    expect(html).toContain("尚未接线"); // node / forward
    expect(html).toContain("尚未实现"); // reconcile_finding / workspace_event / federation_event
    // 逐类核对：node / forward 绝不能与"今天会投递"同格
    expect(cellHtml(html, "email-node")).not.toContain("今天会投递");
    expect(cellHtml(html, "email-forward")).not.toContain("今天会投递");
    expect(cellHtml(html, "email-reconcile_finding")).not.toContain("今天会投递");
    expect(cellHtml(html, "email-announcement")).toContain("今天会投递");
  });

  test("webhook 被如实标成机器通道（不参与面向你的推送）", () => {
    const html = renderBody();
    const start = html.indexOf('data-testid="notification-channel-webhook"');
    const end = html.indexOf('data-testid="notification-channel-telegram"', start);
    const section = html.slice(start, end === -1 ? undefined : end);
    expect(section).toContain("机器通道"); // 渠道角色徽章
    expect(section).toContain("不参与面向你的推送"); // 渠道说明
    expect(section).toContain("有意未把 webhook 接入投递注册表");
  });

  test("文案不暗示订阅、也不推断 Telegram 已绑定", () => {
    const html = renderBody();
    expect(html).not.toContain("订阅");
    expect(html).not.toContain("已绑定");
    expect(html).not.toContain("已订阅");
    // tg_id 的现状要讲清楚：自由填写、未经校验。
    expect(html).toContain("未经校验");
    expect(html).toContain("tg_id");
  });

  test("开关状态来自服务端清单：已静音的显示「已静音」且 aria-checked=true", () => {
    const html = renderBody({
      view: {
        kind: "ready",
        channels: [...CHANNELS],
        categories: [...CATEGORIES],
        mutes: [{ channel_kind: "email", category: "announcement" }],
        unrepresentable: [],
      },
    });
    expect(cellHtml(html, "email-announcement")).toContain('aria-checked="true"');
    expect(cellHtml(html, "email-announcement")).toContain("已静音");
    expect(cellHtml(html, "telegram-announcement")).toContain('aria-checked="false"');
    expect(cellHtml(html, "telegram-announcement")).toContain("未静音");
  });

  test("服务端返回闭集之外的偏好：页面明说无法表示，不画开关也不隐藏", () => {
    const html = renderBody({
      view: {
        kind: "ready",
        channels: [...CHANNELS],
        categories: [...CATEGORIES],
        mutes: [{ channel_kind: "email", category: "brand_new" }],
        unrepresentable: [{ channel_kind: "email", category: "brand_new" }],
      },
    });
    expect(html).toContain('data-testid="notification-preferences-unrepresentable"');
    expect(html).toContain("brand_new");
    expect(html).not.toContain('data-testid="notification-cell-email-brand_new"');
  });

  test("闭集为空：明说「不是全部未静音」，而不是渲染一个空矩阵", () => {
    const html = renderBody({ view: { kind: "ready", channels: [], categories: [...CATEGORIES], mutes: [], unrepresentable: [] } });
    expect(html).toContain('data-testid="notification-preferences-empty"');
    expect(html).not.toContain('data-testid="notification-closed-set-hint"');
  });
});

describe("N1 呈现：degraded 与两个保存失败分支互不冒充", () => {
  test("degraded：没有任何开关、不出现「未静音」，并给出重试", () => {
    const html = renderBody({ view: { kind: "degraded", code: "storage_error", message: "免打扰存储暂时不可用" } });
    expect(html).toContain('data-testid="notification-preferences-degraded"');
    expect(html).toContain('data-testid="notification-preferences-retry"');
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("未静音");
    expect(html).toContain("这不代表「你什么都没静音」");
  });

  test("400 rejected 与 503 unavailable 是两块不同的提示（一个要刷新，一个可重试）", () => {
    const rejected = renderBody({ save: { kind: "rejected", code: "unknown_category", message: "免打扰清单不合法" } });
    expect(rejected).toContain('data-testid="notification-save-rejected"');
    expect(rejected).not.toContain('data-testid="notification-save-unavailable"');
    expect(rejected).toContain("刷新后重新选择");
    expect(rejected).toContain("服务端不认识其中的类别");

    const unavailable = renderBody({ save: { kind: "unavailable", code: "storage_error", message: "免打扰存储暂时不可用" } });
    expect(unavailable).toContain('data-testid="notification-save-unavailable"');
    expect(unavailable).not.toContain('data-testid="notification-save-rejected"');
    expect(unavailable).toContain('data-testid="notification-save-retry"');
    expect(unavailable).toContain("可以稍后重试");
  });

  test("保存成功：出现「保存 ≠ 会收到」的说明，且不给用户「已订阅」的错觉", () => {
    const html = renderBody({ save: { kind: "saved" } });
    expect(html).toContain('data-testid="notification-save-saved"');
    expect(html).toContain("不会让尚未接线的类别开始推送");
    expect(html).not.toContain("订阅");
  });

  test("有未保存更改时给出提示", () => {
    expect(renderBody({ dirty: true })).toContain("有未保存的更改");
    expect(renderBody({ dirty: false })).not.toContain("有未保存的更改");
  });

  test("英文分支同样是「只标注真实状态」", () => {
    const html = renderBody({ locale: "en" });
    expect(html).toContain("Delivered today");
    expect(html).toContain("Not wired yet");
    expect(html).toContain("Not implemented");
    expect(html).not.toContain("subscrib");
  });
});

describe("N1 i18n：中英两份表的键集一致", () => {
  test("zh / en 顶层键与嵌套键完全对齐（少一个键就是一处渲染出裸 key）", () => {
    const zh = notificationText("zh") as unknown as Record<string, unknown>;
    const en = notificationText("en") as unknown as Record<string, unknown>;
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(zh)) {
      const left = zh[key];
      const right = en[key];
      if (left && typeof left === "object" && right && typeof right === "object") {
        expect({ key, keys: Object.keys(left as object).sort() }).toEqual({
          key,
          keys: Object.keys(right as object).sort(),
        });
      }
    }
    // 关键：三态文案在两份表里都存在（缺一个就会渲染出 undefined）
    for (const locale of ["zh", "en"] as const) {
      const text = notificationText(locale);
      for (const state of ["live", "pending_wiring", "no_derivation", "unknown"] as const) {
        expect(text.categoryDeliveryTitle[state]).toBeTruthy();
        expect(text.categoryDeliveryNote[state]).toBeTruthy();
      }
    }
  });
});

/* ================================================================== */
/* C. mock 与真实后端同形（经 mock 分发 + api 客户端的载荷辨认）          */
/* ================================================================== */

describe("N1 mock：与真实后端同形状，且经分发可到达", () => {
  test("GET 形状 = 真机实测形状 `{data:{mutes,channels,categories}}`（含闭集）", async () => {
    const { handleMock } = await import("@/mocks/handler");
    const { sessionCookieValue } = await import("@/mocks/runtime");
    const res = await handleMock("GET", "announcements/preferences", {
      cookie: sessionCookieValue(1),
      query: {},
    } as never);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { mutes: [], channels: [...CHANNELS], categories: [...CATEGORIES] },
    });
  });

  test("PUT 全量替换 + 回显；未知渠道/类别/非数组各自 400（不是一个笼统的失败）", async () => {
    const { handleMock } = await import("@/mocks/handler");
    const { sessionCookieValue } = await import("@/mocks/runtime");
    const call = (method: string, body?: unknown, userId = 1) =>
      handleMock(method, "announcements/preferences", {
        cookie: sessionCookieValue(userId),
        query: {},
        ...(body === undefined ? {} : { body }),
      } as never) as Promise<{ status: number; body: unknown }>;

    const ok = await call("PUT", { mutes: [{ channel_kind: "email", category: "announcement" }] });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ data: { mutes: [{ channel_kind: "email", category: "announcement" }] } });

    // 全量替换：再 PUT 一份新清单，旧的那条必须消失（不是合并）
    const replaced = await call("PUT", { mutes: [{ channel_kind: "telegram", category: "forward" }] });
    expect(replaced.body).toEqual({ data: { mutes: [{ channel_kind: "telegram", category: "forward" }] } });
    const readBack = await call("GET");
    expect((readBack.body as { data: { mutes: MutePair[] } }).data.mutes).toEqual([
      { channel_kind: "telegram", category: "forward" },
    ]);

    expect((await call("PUT", { mutes: [{ channel_kind: "slack", category: "announcement" }] })).body).toMatchObject({
      code: "unknown_channel_kind",
    });
    expect((await call("PUT", { mutes: [{ channel_kind: "email", category: "nope" }] })).body).toMatchObject({
      code: "unknown_category",
    });
    expect((await call("PUT", { mutes: "x" })).body).toMatchObject({ code: "not_an_array" });

    // 用户级：换一个用户读到的不是同一个人的偏好（mock 与真实后端一样按会话用户分片）
    const other = await call("GET", undefined, 2);
    expect((other.body as { data: { mutes: MutePair[] } }).data.mutes).toEqual([]);

    // 存储不可用分支：显式的假故障注入点，且只冒充"存储不可用"这一类
    const degraded = await handleMock("GET", "announcements/preferences", {
      cookie: sessionCookieValue(1),
      query: { mock_error: "storage_error" },
    } as never) as { status: number; body: unknown };
    expect(degraded.status).toBe(503);
    expect(degraded.body).toMatchObject({ code: "storage_error" });
  });

  test("载荷辨认：两种信封都收，畸形一律判「取不出来」（绝不退回空清单）", async () => {
    const { readPreferencesPayload } = await import("@/lib/api/announcements");
    // 真实模式：core 已解包（裸载荷）
    expect(readPreferencesPayload({ mutes: [], channels: ["email"], categories: ["announcement"] })).toEqual({
      mutes: [],
      channels: ["email"],
      categories: ["announcement"],
    });
    // mock 模式：core 不解包（带一层 `{data}`）
    expect(
      readPreferencesPayload({ data: { mutes: [{ channel_kind: "email", category: "announcement" }], channels: [], categories: [] } }),
    ).toEqual({ mutes: [{ channel_kind: "email", category: "announcement" }], channels: [], categories: [] });
    // 畸形：抛错（上层进入 degraded），而不是假装"什么都没静音"
    expect(() => readPreferencesPayload({ mutes: [] })).toThrow();
    expect(() => readPreferencesPayload(null)).toThrow();
  });
});
