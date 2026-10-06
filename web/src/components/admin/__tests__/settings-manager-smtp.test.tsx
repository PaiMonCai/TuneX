/**
 * N-F1 / N-F3 —— 管理端「系统设置」页的两条真话收口：
 *
 *  - **N-F1**：SMTP 不在这个页面配置（邮件读部署级环境变量）。页面**必须说清为什么不在这里**
 *    （给出变量名 + 文档入口 + "历史行会被忽略"），而不是让表单静默消失——静默移除会让运维
 *    找不到地方配。
 *  - **N-F3**：凭据类配置项（后端只回 `value: ""` + `secret_configured`）此前**无法显示"已配置"**，
 *    页面只有一个空输入框。现在显示"已配置 / 未配置"，且输入框是**只写不读**（非受控、不回填）。
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import { getDictionary } from "@/lib/i18n";
import { AdminSettingsManager } from "@/components/admin/settings-manager";
import type { SystemConfigItem } from "@/lib/types";

function item(over: Partial<SystemConfigItem> & { name: string }): SystemConfigItem {
  return {
    id: 1,
    value: "",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function html(rows: SystemConfigItem[], locale: "zh" | "en" = "zh"): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { locale, dict: getDictionary(locale) },
      createElement(AdminSettingsManager as never, { initialData: rows }),
    ),
  );
}

function tagOf(source: string, testid: string): string {
  const at = source.indexOf(`data-testid="${testid}"`);
  expect(at).toBeGreaterThan(-1);
  return source.slice(source.lastIndexOf("<", at), source.indexOf(">", at));
}

/** testid 所在元素「开标签 + 文本」的片段（徽章的文字在开标签之后，只取开标签会漏掉它）。 */
function elementText(source: string, testid: string): string {
  const at = source.indexOf(`data-testid="${testid}"`);
  expect(at).toBeGreaterThan(-1);
  const end = source.indexOf("</", at);
  return source.slice(at, end === -1 ? at + 200 : end);
}

const BASE_ROWS = [
  item({ id: 1, name: "SITE_NAME", value: "TuneX" }),
  item({ id: 2, name: "RESEND_API_KEY", value: "", secret_configured: true }),
  item({ id: 3, name: "CHATWOOT_TOKEN", value: "", secret_configured: false }),
];

describe("N-F1 页面：说清 SMTP 为什么不在管理端", () => {
  test("部署级说明卡存在，且给出具体变量名、文档入口与「历史行会被忽略」", () => {
    const page = html(BASE_ROWS);
    expect(page).toContain('data-testid="smtp-deployment-note"');
    for (const name of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_SECURE"]) {
      expect(page).toContain(name);
    }
    expect(page).toContain("部署级配置");
    expect(page).toContain("docs/production-deploy.md");
    expect(page).toContain('data-testid="smtp-deployment-history"');
    expect(page).toContain("忽略");
    expect(page).toContain("不改写");
  });

  test("即使后端（或旧 mock）仍然下发 SMTP_*，页面也不渲染成可编辑项（纵深防御）", () => {
    const page = html([
      ...BASE_ROWS,
      item({ id: 9, name: "SMTP_HOST", value: "smtp.legacy.example" }),
      item({ id: 10, name: "SMTP_PASS", value: "", secret_configured: true }),
    ]);
    expect(page).not.toContain('data-testid="config-SMTP_HOST"');
    expect(page).not.toContain('data-testid="config-SMTP_PASS"');
    expect(page).not.toContain("smtp.legacy.example");
    // 而那两行仍然"存在过"这件事由说明卡交代
    expect(page).toContain('data-testid="smtp-deployment-note"');
  });

  test("英文分支同样给出变量名与文档入口", () => {
    const page = html(BASE_ROWS, "en");
    expect(page).toContain("deployment-level configuration");
    expect(page).toContain("SMTP_PASS");
    expect(page).toContain("docs/production-deploy.md");
  });
});

describe("N-F3 凭据只写不读：显示「已配置/未配置」，输入框不回填", () => {
  test("secret_configured=true → 已配置；false → 未配置（两者可分）", () => {
    const page = html(BASE_ROWS);
    expect(elementText(page, "config-secret-state-RESEND_API_KEY")).toContain("已配置");
    expect(elementText(page, "config-secret-state-CHATWOOT_TOKEN")).toContain("未配置");
    // 已配置的行**不得**把值渲染出来（后端只回空串）
    expect(tagOf(page, "config-RESEND_API_KEY")).not.toContain("value=");
    expect(tagOf(page, "config-RESEND_API_KEY")).toContain('type="password"');
  });

  test("非凭据项仍然照旧：可编辑输入框带当前值", () => {
    const page = html(BASE_ROWS);
    expect(tagOf(page, "config-SITE_NAME")).toContain('value="TuneX"');
    expect(page).not.toContain('data-testid="config-secret-state-SITE_NAME"');
  });

  test("凭据项的输入框是**非受控**且不预填（只写不读的可执行形式）", () => {
    const page = html([item({ id: 1, name: "CHATWOOT_TOKEN", value: "", secret_configured: true })]);
    const tag = tagOf(page, "config-CHATWOOT_TOKEN");
    expect(tag).toContain('type="password"');
    expect(tag).not.toContain("value=");
    expect(page).toContain("写入新值（不回显）");
  });
});
