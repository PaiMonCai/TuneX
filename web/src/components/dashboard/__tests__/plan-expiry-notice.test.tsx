/**
 * V5-WP20-5 —— 到期/宽限提示的**渲染断言**（`plan-expiry-notice.tsx`）。
 *
 * 为什么值得单测一个这么小的组件：它是「到期降级**可观测**」这条交付物里唯一由用户看到的部分。
 * 纯逻辑（`composeEffectivePolicy` / `buildUsageExpiryView`）在 backend 侧已有 17 条断言，
 * 但「宽限期内到底显示了什么」只有渲染一遍才知道。
 *
 * 钉住三件事：
 *   ① 正常情况下**什么都不渲染**（不打扰用户）；
 *   ② 宽限内渲染后端给的文案 + 宽限截止点（F3：宽限期内仍放行，所以只提示不拦截）；
 *   ③ **文案来自后端**：组件里不出现任何硬编码的拒绝中文 —— 抄一份就是第二处口径。
 *
 * 跑法（web 目录）：bun test src/components/dashboard/__tests__/plan-expiry-notice.test.tsx
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanExpiryNotice } from "@/components/dashboard/plan-expiry-notice";

const BACKEND_MESSAGE = "工作空间的能力策略已到期，请管理员重新发放";

const view = (over: Partial<NonNullable<Parameters<typeof PlanExpiryNotice>[0]["expiry"]>> = {}) => ({
  policy_expires_at: null,
  in_grace: false,
  grace_expires_at: null,
  deny_scope: false,
  deny_reason: null,
  deny_message: null,
  ...over,
});

/** 剥掉块注释与行注释：守卫看的是**代码**，注释是解释。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'])\/\/[^\n]*/g, "$1");
}

const render = (expiry: Parameters<typeof PlanExpiryNotice>[0]["expiry"]) =>
  renderToStaticMarkup(<PlanExpiryNotice expiry={expiry} expiresLabel="到期时间" />);

describe("PlanExpiryNotice：什么时候渲染", () => {
  test("正常（无宽限、未被拒）⇒ 什么都不渲染", () => {
    expect(render(view())).toBe("");
    expect(render(view({ policy_expires_at: "2026-11-04T05:30:00.000Z" }))).toBe("");
    expect(render(null)).toBe("");
  });

  test("宽限内 ⇒ 渲染文案 + 宽限截止点（提示而非拦截）", () => {
    const html = render(
      view({
        in_grace: true,
        grace_expires_at: "2026-10-08T05:30:00.000Z",
        deny_reason: "policy_expired",
        deny_message: BACKEND_MESSAGE,
      }),
    );
    expect(html).toContain('data-testid="plan-expiry-notice"');
    expect(html).toContain(BACKEND_MESSAGE); // 逐字来自后端
    expect(html).toContain("到期时间");
    expect(html).toContain("2026");
  });

  test("fail-closed（deny_scope）⇒ 渲染文案，且不再显示宽限截止点", () => {
    const html = render(
      view({ deny_scope: true, deny_reason: "no_active_policy", deny_message: BACKEND_MESSAGE }),
    );
    expect(html).toContain(BACKEND_MESSAGE);
    expect(html).not.toContain("到期时间："); // 没有宽限窗口时不给一个假的截止点
  });

  test("文案缺失时给空字符串而不是 undefined（不渲染出 'undefined'）", () => {
    const html = render(view({ in_grace: true, grace_expires_at: "2026-10-08T05:30:00.000Z" }));
    expect(html).not.toContain("undefined");
    expect(html).toContain('data-testid="plan-expiry-notice"');
  });
});

describe("PlanExpiryNotice：拒绝文案只有后端一份", () => {
  test("组件源码里没有硬编码的拒绝中文（否则后端改词后前端永远显示旧那句）", () => {
    // 守卫必须**先剥注释**：否则它会惩罚写解释性注释的人（而注释恰恰最有价值）。
    // 这也是 Lead 对门禁判据的立场：要么去注释后匹配，要么用真实解析。
    const code = stripComments(readFileSync(new URL("../plan-expiry-notice.tsx", import.meta.url), "utf8"));
    expect(code).not.toContain(BACKEND_MESSAGE);
    expect(code).not.toContain("已到期");
    expect(code).not.toContain("已用流量达到策略额度上限");
    // 只允许从 props 渲染
    expect(code).toContain("expiry.deny_message");
    // 自检：剥离没把整个文件吃掉（否则上面全是假绿）
    expect(code).toContain("export function PlanExpiryNotice");
  });
});
