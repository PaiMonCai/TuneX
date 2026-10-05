/**
 * V5-WP18.5 —— 管理端公告（发布 / 撤回）的渲染断言。
 *
 * 钉住三件事（都是"用户真正会看到什么"）：
 *   ① 表单与列表的入口都在（testid），空标题/空正文时**发不出去**（disabled）；
 *   ② 正文是**纯文本**渲染（`<script>` 被转义），已撤回的行标出来且不能再撤回；
 *   ③ 不出现原始 i18n key（`announcements.admin.`）—— 词条缺失时 `t()` 会回落成 key，
 *      只有真的渲染一遍才看得见。
 *
 * 跑法（web 目录）：bun test src/components/admin/__tests__/announcement-admin.test.tsx
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import { getDictionary } from "@/lib/i18n";
import { AnnouncementAdmin } from "@/components/admin/announcement-admin";
import type { Announcement } from "@/lib/announcements";

function row(over: Partial<Announcement> = {}): Announcement {
  return {
    id: 1,
    scope_kind: "platform",
    workspace_id: null,
    type: "normal",
    title: "维护通知",
    body: "今晚 22:00 起维护十分钟。",
    published_at: "2026-10-05T09:00:00.000Z",
    revoked_at: null,
    dismissed: false,
    dismissed_at: null,
    ...over,
  };
}

/**
 * 取某个 testid 所在的**开标签**（`disabled` 的位置由 React 决定，不能假设它在 testid 之后：
 * 实测 `disabled=""` 渲染在 `data-testid` **前面**）。所以按标签取出来再判断属性。
 */
function tagWith(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  if (at < 0) return "";
  const start = html.lastIndexOf("<", at);
  const end = html.indexOf(">", at);
  return html.slice(start, end + 1);
}

/**
 * 是否**真的**带了 `disabled` 属性。不能用 `tag.includes("disabled")`：
 * Tailwind 的类名里就有 `disabled:pointer-events-none`，那是假阳性（实测踩过）。
 */
const isDisabled = (tag: string): boolean => /(?:^|\s)disabled(?:=""|="true"|\s|>)/.test(tag);

const render = (rows: Announcement[], locale: "zh" | "en" = "zh") =>
  renderToStaticMarkup(
    <I18nProvider locale={locale} dict={getDictionary(locale)}>
      <AnnouncementAdmin initial={rows} locale={locale} />
    </I18nProvider>,
  );

describe("管理端公告：表单 + 列表（纯文本）", () => {
  test("表单与列表入口都在，且文案不是原始 key", () => {
    const html = render([row()]);
    for (const id of ["announcement-admin", "announcement-type", "announcement-title", "announcement-body", "announcement-publish", "announcement-row-1", "announcement-revoke-1"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).not.toContain("announcements.admin.");
    expect(html).toContain("发布平台公告");
  });

  test("标题/正文为空时发布按钮不可点（前端只做提示，真正的拒绝在后端）", () => {
    const html = render([]);
    expect(isDisabled(tagWith(html, "announcement-publish"))).toBe(true);
    expect(html).toContain("还没有平台公告");
  });

  test("正文里的 HTML 被转义成文本（与用户侧同一条纪律）", () => {
    const html = render([row({ body: "<script>alert(1)</script>" })]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("弹窗带类型标记；已撤回的行标出来且撤回按钮禁用", () => {
    const html = render([
      row({ id: 2, type: "popup", title: "重要公告" }),
      row({ id: 3, title: "旧的", revoked_at: "2026-10-05T10:00:00.000Z" }),
    ]);
    expect(html).toContain("重要公告");
    expect(html).toContain('data-testid="announcement-revoked-3"');
    expect(isDisabled(tagWith(html, "announcement-revoke-3"))).toBe(true);
    // 活跃那条仍可撤回。
    expect(isDisabled(tagWith(html, "announcement-revoke-2"))).toBe(false);
  });

  test("英文词条同样存在（不是硬编码中文）", () => {
    const html = render([row()], "en");
    expect(html).toContain("Publish a platform announcement");
    expect(html).toContain("Revoke");
    expect(html).not.toContain("发布平台公告");
  });

  test("坏载荷不会把页面打崩（只渲染能认出来的行）", () => {
    const html = render([{ id: "x" } as unknown as Announcement, row({ id: 9, title: "好的" })]);
    expect(html).toContain("好的");
    expect(html).not.toContain("announcement-row-x");
  });
});
