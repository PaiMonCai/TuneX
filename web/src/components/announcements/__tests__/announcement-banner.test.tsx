/**
 * V5-WP18.5 —— 公告展示：**纯文本渲染**与三态（契约 §F6.6 / §9.5 / DoD7）。
 *
 * 为什么要真渲染而不是扫源码：DoD7 的实质是"正文里的 HTML 不会被执行"，
 * 只有真的渲染一遍、看到 `<script>` 被转义成 `&lt;script&gt;`，才算证明了它。
 * 扫"全仓零 `dangerouslySetInnerHTML`"（由后端契约测试执行，且**去注释后**再匹配）
 * 只是**必要条件**，并不等于"渲染安全"（比如有人把正文塞进 `title` 属性又自己拼字符串）。
 *
 * `next/navigation` 的 `useRouter` 在静态渲染里没有 app-router 上下文，
 * 因此按 bun 的模块替身注入一个只实现 `refresh()` 的路由。
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { AnnouncementBanner } = await import("../announcement-banner");
const { I18nProvider } = await import("@/components/providers");
const { getDictionary } = await import("@/lib/i18n");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");

interface Row {
  id: number;
  scope_kind: "platform" | "workspace";
  workspace_id: number | null;
  type: string;
  title: string;
  body: string;
  published_at: string;
  revoked_at: string | null;
  dismissed: boolean;
  dismissed_at: string | null;
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: 1,
    scope_kind: "platform",
    workspace_id: null,
    type: "normal",
    title: "维护通知",
    body: "今晚 22:00 起维护。",
    published_at: "2026-10-05T09:00:00.000Z",
    revoked_at: null,
    dismissed: false,
    dismissed_at: null,
    ...over,
  };
}

const render = (announcements: unknown, locale: "zh" | "en" = "zh") =>
  renderToStaticMarkup(
    createElement(
      I18nProvider,
      { locale, dict: getDictionary(locale) },
      createElement(AnnouncementBanner as never, { announcements: announcements as never }),
    ),
  );

describe("公告展示：纯文本 + 三态", () => {
  test("标题/正文/发布时间渲染出来，按钮与容器带 testid", () => {
    const html = render([row()]);
    expect(html).toContain('data-testid="announcement-banner"');
    expect(html).toContain("维护通知");
    expect(html).toContain("今晚 22:00 起维护。");
    expect(html).toContain('data-testid="announcement-dismiss-1"');
    // 词条存在（没渲染成 `announcements.dismiss` 这种原始 key）。
    expect(html).not.toContain("announcements.");
  });

  test("正文里的 HTML **被转义**成文本（DoD7 的实质断言）", () => {
    const html = render([row({ body: '<script>alert(1)</script><img src=x onerror=alert(2)>' })]);
    // 没有可执行标签：`<script>` / `<img` 都不该作为标签出现在标记里。
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    // 而是转义成实体 —— 用户看到的仍然是他输入的那串字符。
    expect(html).toContain("&lt;script&gt;");
  });

  test("已读的不显示；弹窗排在最前面并带标记", () => {
    const html = render([
      row({ id: 2, title: "已读的", dismissed: true, dismissed_at: "2026-10-05T10:00:00.000Z" }),
      row({ id: 3, title: "普通公告", published_at: "2026-10-05T09:00:00.000Z" }),
      row({ id: 4, type: "popup", title: "重要公告", published_at: "2026-10-04T09:00:00.000Z" }),
    ]);
    expect(html).not.toContain("已读的");
    expect(html).toContain("重要公告");
    expect(html).toContain("普通公告");
    // 弹窗优先：位置在普通公告之前。
    expect(html.indexOf("重要公告")).toBeLessThan(html.indexOf("普通公告"));
    expect(html).toContain("重要");
  });

  test("已撤回的不显示（即便 dismissed=false）", () => {
    const html = render([row({ title: "撤回的", revoked_at: "2026-10-05T11:00:00.000Z" })]);
    expect(html).not.toContain("撤回的");
  });

  test("空列表 / 坏载荷 → 什么都不渲染（且不抛错：坏行不该把整页拖进 error boundary）", () => {
    expect(render([])).toBe("");
    expect(render([{ id: "x" }, null, 42])).toBe("");
    expect(render("boom")).toBe("");
    // 好坏混在一起：好的照常显示，坏的静默丢弃。
    const mixed = render([null, row({ id: 9, title: "好的那条" }), { id: "x" }]);
    expect(mixed).toContain("好的那条");
    expect(mixed.match(/data-testid="announcement-dismiss-/g)?.length).toBe(1);
  });

  test("取不到（null）→ 明说取不到，而不是「暂无公告」", () => {
    const html = render(null);
    expect(html).toContain('data-testid="announcement-degraded"');
    expect(html).toContain("公告暂时取不到");
    // 关键：不得把"取不到"渲染成"没有公告"。
    expect(html).not.toContain("暂无");
  });

  test("英文词条同样存在（不是硬编码中文）", () => {
    const html = render([row()], "en");
    expect(html).toContain("Got it");
    expect(html).not.toContain("知道了");
  });
});
