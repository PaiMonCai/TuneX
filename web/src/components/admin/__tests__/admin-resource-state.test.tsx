/**
 * R2-C / D5 —— 管理端「没有权限」不再显示成「暂无数据」。
 *
 * 缺陷背景：`admin-resource-list.tsx` 的 `safe()` / `safeValue()` 把任何失败 `catch`
 * 成空列表或 `{ type: "none" }`，于是：
 *   - 403（后台角色没有该资源键）与「这个列表真的是空的」在界面上**完全一样**；
 *   - license 取不到 → 显示「未授权（none）」—— 那是另一条结论，不只是缺数据。
 *
 * 这个文件钉住：失败**保留原因**（状态码 + 后端消息 + 是哪一次读取），页面渲染可解释的
 * 受控提示卡；空数组只可能来自一次**成功**的读取。
 *
 * 跑法（web 目录）：bun test src/components/admin/__tests__/admin-resource-state.test.tsx
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import {
  AdminResourceUnavailableCard,
  classifyAdminLoadError,
  loadAdminResource,
} from "@/components/admin/admin-resource-state";
import { ApiError } from "@/lib/api/core";
import type { Paginated } from "@/lib/types";

const render = (failure: Parameters<typeof AdminResourceUnavailableCard>[0]["failure"], locale: "zh" | "en" = "zh") =>
  renderToStaticMarkup(<AdminResourceUnavailableCard segment="nodes" failure={failure} locale={locale} />);

const silence = () => {
  const original = console.error;
  console.error = () => undefined;
  return () => {
    console.error = original;
  };
};

describe("失败分类：403 / 401 / 其它 三种含义不合并", () => {
  test("403 = 没有权限（保留后端消息），不是「取不到」", () => {
    const failure = classifyAdminLoadError(new ApiError(403, "无权访问该功能"), "节点列表");
    expect(failure).toEqual({ kind: "denied", status: 403, message: "无权访问该功能", what: "节点列表" });
  });

  test("401 = 会话失效（与 403 分开，因为处理方式不同）", () => {
    const failure = classifyAdminLoadError(new ApiError(401, "Unauthorized"), "用户列表");
    expect(failure.kind).toBe("unauthenticated");
    expect(failure.status).toBe(401);
  });

  test("5xx / 网络层异常 = 取不到（状态码不知道就不填）", () => {
    expect(classifyAdminLoadError(new ApiError(503, "boom"), "系统配置")).toEqual({
      kind: "error",
      status: 503,
      message: "boom",
      what: "系统配置",
    });
    expect(classifyAdminLoadError(new TypeError("Failed to fetch"), "License 信息")).toEqual({
      kind: "error",
      status: null,
      message: "Failed to fetch",
      what: "License 信息",
    });
    expect(classifyAdminLoadError("weird", "审计日志")).toEqual({
      kind: "error",
      status: null,
      message: null,
      what: "审计日志",
    });
  });
});

describe("取数结果：失败不折叠成空列表", () => {
  test("成功（含空数组）→ ok:true，数据原样下发", async () => {
    const loaded = await loadAdminResource<Paginated<{ id: number }>>("节点列表", Promise.resolve({ data: [], total: 0, page: 1, page_size: 20 }));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.data.total).toBe(0);
  });

  test("403 → ok:false + denied（**不是**一个空的 Paginated）", async () => {
    const restore = silence();
    try {
      const loaded = await loadAdminResource<Paginated<{ id: number }>>(
        "节点列表",
        Promise.reject(new ApiError(403, "无权访问该功能")),
      );
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.failure.kind).toBe("denied");
        expect(loaded.failure.status).toBe(403);
        expect(loaded.failure.what).toBe("节点列表");
      }
      // 关键回归：结果里不存在一个「像空数据」的载荷
      expect(Object.keys(loaded)).toEqual(["ok", "failure"]);
    } finally {
      restore();
    }
  });

  test("license 取不到 → 保留失败，而不是 { type: \"none\" }", async () => {
    const restore = silence();
    try {
      const loaded = await loadAdminResource("License 信息", Promise.reject(new ApiError(500, "boom")));
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.failure.kind).toBe("error");
      expect(JSON.stringify(loaded)).not.toContain("none");
    } finally {
      restore();
    }
  });
});

describe("受控提示卡的呈现", () => {
  test("403：说权限、给出联系人、附上失败读取与后端消息，且不出现「暂无数据」", () => {
    const html = render(classifyAdminLoadError(new ApiError(403, "无权访问该功能"), "节点组列表"));
    expect(html).toContain('data-testid="admin-resource-unavailable"');
    expect(html).toContain('data-admin-load-failure="denied"');
    expect(html).toContain("权限");
    expect(html).toContain("超级管理员");
    expect(html).toContain("失败的读取：节点组列表");
    expect(html).toContain("服务端状态：403");
    expect(html).toContain("服务端消息：无权访问该功能");
    expect(html).toContain('data-testid="admin-resource-retry"');
    expect(html).toContain('href="/admin/nodes"');
    // 卡片显式把自己与「空数据」区分开（这是这次修复的语义本身）
    expect(html).toContain("不是「暂无数据」");
    expect(html).not.toContain("No data");
  });

  test("其它失败：明说「这不等于没有数据」，并保留状态码", () => {
    const html = render(classifyAdminLoadError(new ApiError(503, "service unavailable"), "系统配置"));
    expect(html).toContain('data-admin-load-failure="error"');
    expect(html).toContain("不等于");
    expect(html).toContain("服务端状态：503");
  });

  test("会话失效：与权限不足的文案不同（否则用户不知道该去登录）", () => {
    const denied = render(classifyAdminLoadError(new ApiError(403, "无权"), "用户列表"));
    const expired = render(classifyAdminLoadError(new ApiError(401, "Unauthorized"), "用户列表"));
    expect(expired).toContain("401");
    expect(expired).not.toEqual(denied);
  });

  test("英文文案同样把权限与空数据分开", () => {
    const html = render(classifyAdminLoadError(new ApiError(403, "Forbidden"), "Node list"), "en");
    expect(html).toContain("permission");
    expect(html).not.toContain("No data");
  });
});

describe("页面接线：失败路径真的不再喂空列表给 manager", () => {
  const listSource = readFileSync(new URL("../admin-resource-list.tsx", import.meta.url), "utf8");
  const readonlySource = readFileSync(new URL("../admin-readonly-loader.tsx", import.meta.url), "utf8");

  test("admin-resource-list 不再有「失败回落空列表」的 safe()/safeValue()", () => {
    expect(listSource).not.toContain("function safe<");
    expect(listSource).not.toContain("function safeValue<");
    expect(listSource).not.toContain("catch(() => ({ ...EMPTY");
    expect(listSource).not.toContain('{ type: "none" }');
  });

  test("每个 segment 都走 loadAdminResource，并在失败时渲染受控提示卡", () => {
    expect(listSource.match(/loadAdminResource</g)?.length).toBeGreaterThanOrEqual(9);
    expect(listSource).toContain("<AdminResourceUnavailable");
    // 只读资源（tunnels / orders / tickets）曾经同样把失败折叠成 EMPTY
    expect(readonlySource).not.toContain("initial = EMPTY");
    expect(readonlySource).toContain("loadAdminResource<");
    expect(readonlySource).toContain("<AdminResourceUnavailable");
  });
});
