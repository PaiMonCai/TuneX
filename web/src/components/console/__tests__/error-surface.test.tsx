/**
 * R2-C —— 受控错误面（`error.tsx`）的行为测试。
 *
 * 缺陷背景：全站此前**没有任何 `error.tsx`**，于是普通账号点进 `/admin` 撞到的后端 403
 * 会落到 Next 默认错误页 —— 用户分不清「没权限」与「服务挂了」，也没有回去/重试的路。
 * 这个文件钉住：
 *
 *   1. **只有拿到真实状态码才说 403/401/404**；拿不到时的文案里**不能出现 500 / 服务器错误**
 *      （服务端抛出的错误详情不会下发到浏览器，编一个状态码就是在撒谎）；
 *   2. **后台错误面**在「账号确认没有后台角色」时说清那是权限问题（依据同一条后端权限读数），
 *      且**不**声称拿到了 403；
 *   3. **不白屏**：两个 scope 都渲染出标题 + 重试 + 返回路径（返回目标不同）；
 *   4. **写法跟已安装的 Next 16.3 指南**：`retry`（v16.3.0 起稳定），不是 `unstable_retry`/`reset`。
 *
 * 跑法（web 目录）：bun test src/components/console/__tests__/error-surface.test.tsx
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import {
  ConsoleErrorSurface,
  errorDigestOf,
  errorServerMessageOf,
  errorStatusOf,
  errorSurfaceView,
  errorToneOf,
  type ErrorSurfaceFacts,
} from "@/components/console/error-surface";
import { I18nProvider } from "@/components/providers";
import { getDictionary } from "@/lib/i18n";
import { ApiError } from "@/lib/api/core";

const facts = (over: Partial<ErrorSurfaceFacts> = {}): ErrorSurfaceFacts => ({
  scope: "app",
  status: null,
  persona: "unknown",
  digest: null,
  serverMessage: null,
  ...over,
});

/** 在真机上这类错误的 status 到不了浏览器：抄一个「只有摘要」的情况。 */
const opaqueError = () => Object.assign(new Error("An error occurred in the Server Components render."), {
  digest: "1234567890",
});

describe("错误面的事实提取：不猜状态码", () => {
  test("ApiError 的真实状态被保留；没有状态的错误 → null（不是 500）", () => {
    expect(errorStatusOf(new ApiError(403, "无权访问该功能"))).toBe(403);
    expect(errorStatusOf(opaqueError())).toBeNull();
    expect(errorStatusOf(new Error("boom"))).toBeNull();
    expect(errorStatusOf("nope")).toBeNull();
  });

  test("digest / 服务端消息只在真的存在时读出", () => {
    expect(errorDigestOf(opaqueError())).toBe("1234567890");
    expect(errorDigestOf(new Error("boom"))).toBeNull();
    expect(errorDigestOf(Object.assign(new Error("x"), { digest: "  " }))).toBeNull();
    expect(errorServerMessageOf(new ApiError(403, "无权访问该功能"))).toBe("无权访问该功能");
    expect(errorServerMessageOf(new Error(""))).toBeNull();
  });

  test("基调只由真实事实决定", () => {
    expect(errorToneOf(facts({ status: 403 }))).toBe("denied");
    expect(errorToneOf(facts({ status: 401 }))).toBe("unauthenticated");
    expect(errorToneOf(facts({ status: 404 }))).toBe("missing");
    expect(errorToneOf(facts({ status: 500 }))).toBe("unknown");
    expect(errorToneOf(facts({ status: null }))).toBe("unknown");
    // 后台 + 权限读数确认为成员：可解释的权限问题（不依赖 status）
    expect(errorToneOf(facts({ scope: "admin", status: null, persona: "member" }))).toBe("denied");
    // 用户域不因为 persona 是成员就改变口径
    expect(errorToneOf(facts({ scope: "app", status: null, persona: "member" }))).toBe("unknown");
  });
});

describe("错误面文案：403 与「未知」各自说真话", () => {
  test("403：说权限不足，并给出联系人，而不是「服务器错误」", () => {
    const view = errorSurfaceView(facts({ status: 403, serverMessage: "无权访问该功能" }));
    expect(view.tone).toBe("denied");
    expect(view.title).toContain("权限");
    expect(view.hint).toContain("超级管理员");
    expect(view.details).toContain("服务端状态：403");
    expect(view.details).toContain("服务端消息：无权访问该功能");
    expect(JSON.stringify(view)).not.toContain("500");
    expect(JSON.stringify(view)).not.toContain("服务器错误");
  });

  test("未知：如实说没有拿到原因，不冒充 500，并给出摘要编号", () => {
    const view = errorSurfaceView(facts({ status: null, digest: "abc123" }));
    expect(view.tone).toBe("unknown");
    expect(view.hint).toContain("重试");
    expect(view.details).toContain("摘要编号：abc123");
    expect(JSON.stringify(view)).not.toContain("500");
    expect(JSON.stringify(view)).not.toContain("服务器错误");
    // 也不能反向暗示「一切正常」
    expect(view.title).not.toContain("正常");
  });

  test("后台 + 成员：把权限读数当作事实说出来（不声称拿到了 403）", () => {
    const view = errorSurfaceView(facts({ scope: "admin", persona: "member" }));
    expect(view.tone).toBe("denied");
    expect(view.title).toContain("权限");
    expect(view.details.join(" | ")).toContain("super_admin=false");
    expect(view.details).not.toContain("服务端状态：403");
  });

  test("后台 + 委派/超管/取不到：三种读数互不相同，且都不说「没有权限」", () => {
    const delegated = errorSurfaceView(facts({ scope: "admin", persona: "delegated" }));
    const superAdmin = errorSurfaceView(facts({ scope: "admin", persona: "super_admin" }));
    const unknown = errorSurfaceView(facts({ scope: "admin", persona: "unknown" }));
    const lines = [delegated, superAdmin, unknown].map((view) => view.details.join(" | "));
    expect(new Set(lines).size).toBe(3);
    for (const view of [delegated, superAdmin, unknown]) {
      expect(view.tone).toBe("unknown");
      expect(view.details.join(" | ")).not.toContain("super_admin=false");
    }
    expect(unknown.details.join(" | ")).toContain("取不到不等于没有权限");
  });

  test("英文文案同样不出现 500 / server error", () => {
    const view = errorSurfaceView(facts({ status: null, digest: "x" }), "en");
    expect(view.title).toBe("This page failed to load");
    expect(JSON.stringify(view)).not.toContain("500");
    expect(JSON.stringify(view).toLowerCase()).not.toContain("server error");
  });
});

describe("错误面渲染：不白屏，有重试与返回", () => {
  const render = (scope: "app" | "admin", error: Error & { digest?: string }, withProvider: boolean) =>
    renderToStaticMarkup(
      withProvider ? (
        <I18nProvider locale="zh" dict={getDictionary("zh")}>
          <ConsoleErrorSurface scope={scope} error={error} retry={() => undefined} />
        </I18nProvider>
      ) : (
        <ConsoleErrorSurface scope={scope} error={error} retry={() => undefined} />
      ),
    );

  test("应用级：渲染标题、重试、返回首页；原始错误仍打到 console（不吞）", () => {
    const html = render("app", opaqueError(), true);
    expect(html).toContain('data-testid="console-error-surface"');
    expect(html).toContain('data-error-scope="app"');
    expect(html).toContain('data-error-tone="unknown"');
    expect(html).toContain('data-testid="console-error-title"');
    expect(html).toContain('data-testid="console-error-retry"');
    expect(html).toContain('data-testid="console-error-back"');
    expect(html).toContain('href="/"');
    expect(html).toContain("摘要编号：1234567890");
    expect(html).not.toContain("500");
  });

  test("后台：返回控制台（/dashboard），并且不因为「读数取不到」断言没有权限", () => {
    const html = render("admin", new ApiError(403, "无权访问该功能"), true);
    expect(html).toContain('data-error-scope="admin"');
    expect(html).toContain('data-error-tone="denied"');
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain("服务端状态：403");
    // 静态渲染里权限读数还没回来（客户端 effect 才取）→ 不得先下结论
    expect(html).not.toContain("super_admin=false");
  });

  test("Provider 缺失也能渲染（错误可能就发生在 Provider 内部）", () => {
    const html = render("app", new Error("boom"), false);
    expect(html).toContain('data-testid="console-error-surface"');
    expect(html).not.toContain('data-testid="console-error-retry"></');
  });

  test("登录失效（401）额外给「去登录」入口", () => {
    const html = render("app", new ApiError(401, "Unauthorized"), true);
    expect(html).toContain('data-error-tone="unauthenticated"');
    expect(html).toContain('data-testid="console-error-signin"');
    expect(html).toContain('href="/login"');
  });
});

describe("error.tsx 的写法以已安装的 Next 16.3 指南为准", () => {
  const appError = readFileSync(new URL("../../../app/error.tsx", import.meta.url), "utf8");
  const adminError = readFileSync(new URL("../../../app/(admin)/error.tsx", import.meta.url), "utf8");

  test("两个错误面都用稳定版 `retry` prop（不是 unstable_retry / reset 的用法）", () => {
    for (const source of [appError, adminError]) {
      expect(source).toContain("retry: () => void");
      expect(source).toContain("retry={retry}");
      // 只断言**用法**：注释里提到过那两个旧名字是刻意的（说明为什么不用它们）。
      expect(source).not.toContain("unstable_retry:");
      expect(source).not.toContain("unstable_retry=");
      expect(source).not.toContain("reset: () => void");
      expect(source).not.toContain("reset={");
    }
  });

  test("error.js 是客户端组件（Next 的硬要求）", () => {
    expect(appError.trimStart().startsWith('"use client"')).toBe(true);
    expect(adminError.trimStart().startsWith('"use client"')).toBe(true);
  });

  test("不是把 403 渲染成 500 的实现：源码里没有 500 的兜底文案", () => {
    for (const source of [appError, adminError]) {
      expect(source).not.toContain("500");
      expect(source).not.toContain("服务器错误");
    }
  });
});
