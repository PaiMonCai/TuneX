/**
 * `ui/dialog` 关闭按钮的**无障碍文案**测试（渲染，无浏览器、无 jsdom、无新依赖）。
 *
 * 背景（真实浏览器实测 + 读源码）：
 *   `DialogContent` 原来把关闭按钮的可访问名称写死成英文
 *   `<span className="sr-only">Close</span>`，中文界面下屏幕阅读器读到的仍是
 *   "Close"。图标按钮没有可见文字，这个 `sr-only` 文案**就是**它的可访问名称，
 *   所以写死等于所有对话框在中文界面下都念错。
 *
 * ── 测法 ──
 * Radix `Portal` 在静态渲染下不产出 DOM（`DialogContent` 整段渲不出来），所以
 * 这里直接渲染被 `DialogContent` 使用的 `DialogCloseButton`，外面只包 `Dialog`
 * （Radix Root，不经过 Portal）——真实 primitive、真实文案解析，能被
 * `renderToStaticMarkup` 断言。
 *
 * 跑法（web 目录）：bun test src/components/ui/__tests__/dialog.test.tsx
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import { Dialog, DialogCloseButton } from "@/components/ui/dialog";
import type { Locale } from "@/lib/i18n";
import { en, zh } from "@/lib/i18n/dictionaries";

/** 关闭按钮真实 DOM：`Dialog`（Root）提供 Radix 上下文；Portal 不参与，故可静态渲染。 */
function renderClose(node: ReactNode, locale?: Locale): string {
  const tree = <Dialog open>{node}</Dialog>;
  if (!locale) return renderToStaticMarkup(tree);
  return renderToStaticMarkup(
    <I18nProvider locale={locale} dict={locale === "en" ? en : zh}>{tree}</I18nProvider>,
  );
}

/** 取出 sr-only 里的文案（= 图标按钮的可访问名称）。 */
function srOnlyText(html: string): string {
  return (html.match(/<span class="sr-only">([\s\S]*?)<\/span>/) ?? ["", ""])[1]!;
}

function dictText(locale: Locale, key: string): string {
  const dict: Record<string, Record<string, string>> = locale === "en" ? en : zh;
  return dict.common![key]!;
}

describe("对话框关闭按钮：文案跟随当前语言", () => {
  test("中文界面读到「关闭」，不再是写死的英文 Close", () => {
    const html = renderClose(<DialogCloseButton />, "zh");
    expect(srOnlyText(html)).toBe(zh.common.close);
    expect(srOnlyText(html)).toBe("关闭");
    expect(srOnlyText(html)).not.toBe("Close");
    // 仍然是 Radix 的 Close：真实 <button type="button">，图标 + sr-only 文案。
    expect(html).toContain('<button type="button"');
    expect(html).toMatch(/class="sr-only">关闭</);
  });

  test("英文界面读到 Close（词典真的被用上，不是两边写同一句）", () => {
    const html = renderClose(<DialogCloseButton />, "en");
    expect(srOnlyText(html)).toBe(en.common.close);
    expect(srOnlyText(html)).toBe("Close");
    expect(zh.common.close).not.toBe(en.common.close);
  });

  test("两本字典的关闭文案都非空、不产生裸 key", () => {
    for (const locale of ["zh", "en"] as const) {
      const text = dictText(locale, "close");
      expect(text).not.toBe("close");
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  test("显式 label 覆盖语言；空白 label 不会渲染出空标签", () => {
    expect(srOnlyText(renderClose(<DialogCloseButton label="关闭并停止等待" />, "zh"))).toBe(
      "关闭并停止等待",
    );
    // 传空白时必须回落语言文案，而不是渲染空的可访问名称。
    expect(srOnlyText(renderClose(<DialogCloseButton label="   " />, "zh"))).toBe(zh.common.close);
    expect(srOnlyText(renderClose(<DialogCloseButton label="" />, "en"))).toBe(en.common.close);
  });
});

describe("没有 I18nProvider 时的安全行为", () => {
  test("不抛错（旧实现用会抛错的 useI18n 就会让整棵子树崩掉）", () => {
    let html = "";
    const render = () => {
      html = renderClose(<DialogCloseButton />);
    };
    expect(render).not.toThrow();
    expect(html).toContain("<button");
  });

  test("回落默认语言文案：非空，也不是裸 key", () => {
    const text = srOnlyText(renderClose(<DialogCloseButton />));
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).not.toBe("common.close");
    // DEFAULT_LOCALE = zh：无 Provider 时给出产品默认语言，而不是英文硬编码。
    expect(text).toBe(zh.common.close);
    expect(text).not.toBe("Close");
  });
});

/* ================================================================== */
/* 接线（源码级断言：DialogContent 在 Portal 内，静态渲染拿不到 DOM）      */
/* ================================================================== */

const uiDir = fileURLToPath(new URL("..", import.meta.url));
const dialogSource = readFileSync(new URL("../dialog.tsx", import.meta.url), "utf8");

describe("接线：DialogContent 用同一个关闭按钮，且 ui/ 没有别的写死英文", () => {
  test("DialogContent 渲染 DialogCloseButton，不再自带写死文案", () => {
    expect(dialogSource).toContain("<DialogCloseButton />");
    // 旧实现：<span className="sr-only">Close</span>
    expect(dialogSource).not.toMatch(/sr-only">\s*[A-Za-z]/);
  });

  test("ui/ 全部 primitive 都没有写死的英文 sr-only / aria-label", () => {
    const files = readdirSync(uiDir).filter((name) => name.endsWith(".tsx"));
    expect(files.length).toBeGreaterThan(5);
    for (const name of files) {
      const src = readFileSync(`${uiDir}/${name}`, "utf8");
      expect(src).not.toMatch(/sr-only">\s*[A-Za-z]/);
      expect(src).not.toMatch(/aria-label="[A-Za-z]/);
    }
  });
});
