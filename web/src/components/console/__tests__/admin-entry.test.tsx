/**
 * R2-C —— 顶栏「管理后台」入口的 **persona 分流**（行为 + 契约，不靠源码字符串冒充）。
 *
 * 缺陷背景：入口曾经对**所有登录用户**无条件渲染，普通用户点进去 → `/api/admin/*`
 * 403 → 当时全站没有任何 `error.tsx` → Next 默认错误页。这个文件钉住三件事：
 *
 *   1. **判据来自后端真实权限视图**（`GET /api/auth/permissions`）：模块读的路径必须
 *      命中 `backend/src/routes/auth.ts` 真实声明的路由，且载荷形状（`super_admin` /
 *      `roles`）与后端逐字段一致；
 *   2. **委派管理员不会被藏掉**：`roles` 非空（super_admin=false）必须算作可进入后台，
 *      「只看一个布尔字段」是这条修复最容易犯的错；
 *   3. **读数缺失 = unknown ≠ member**：取不到就 fail-open 保留入口（点进去有受控错误面），
 *      绝不把一次失败当成「你不是管理员」。
 *
 * 跑法（web 目录）：bun test src/components/console/__tests__/admin-entry.test.ts
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

// WorkspaceSwitcher（顶栏子件）会调 `useRouter()`：单测里没有 App Router 运行时，
// 这里只替身「刷新」这一个副作用，不替身被测的分支逻辑。
mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { Topbar } from "@/components/topbar";
import { I18nProvider } from "@/components/providers";
import { WorkspaceContext, type WorkspaceContextValue } from "@/components/workspace/workspace-context";
import {
  ADMIN_PERSONA_UNKNOWN,
  adminPersonaOf,
  canEnterAdminConsole,
  parseAdminPermissions,
  type AdminPersonaReading,
} from "@/components/console/admin-persona";
import { getDictionary } from "@/lib/i18n";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";

const backend = (relative: string) =>
  readFileSync(new URL(`../../../../../backend/${relative}`, import.meta.url), "utf8");

/** 与既有 mock 测试同口径的会话 cookie。 */
const session = (userId: number) => `tunex_session=u${userId}`;

/* ================================================================== */
/* 1. 判据：后端真实权限视图的形状与路径                                   */
/* ================================================================== */

describe("persona 判据来自后端真实权限视图", () => {
  test("读的路径命中 backend 真实声明的路由（不是前端猜的 URL）", () => {
    const source = readFileSync(new URL("../admin-persona-server.ts", import.meta.url), "utf8");
    const path = /"(\/auth\/permissions)"/.exec(source)?.[1] ?? null;
    expect(path).toBe("/auth/permissions");
    // 后端声明：authRoutes.get("/permissions" ...)（挂载在 /api/auth 下）
    expect(backend("src/routes/auth.ts")).toContain('authRoutes.get("/permissions"');
  });

  test("形状与后端一致：super_admin + roles[{id,name,permissions}]", () => {
    const source = backend("src/routes/auth.ts");
    expect(source).toContain("super_admin: user.super_admin");
    expect(source).toContain("id: r.id, name: r.name, permissions: r.permissions");
  });

  test("形状不认识 / 缺字段 → unknown（不猜 super_admin=false）", () => {
    expect(parseAdminPermissions({ roles: [] })).toBeNull();
    expect(adminPersonaOf({ roles: [] })).toBe(ADMIN_PERSONA_UNKNOWN);
    expect(adminPersonaOf(null)).toBe(ADMIN_PERSONA_UNKNOWN);
    expect(adminPersonaOf("nope")).toBe(ADMIN_PERSONA_UNKNOWN);
    expect(adminPersonaOf({ super_admin: "true", roles: [] })).toBe(ADMIN_PERSONA_UNKNOWN);
  });

  test("super_admin=true → super_admin；有委派角色 → delegated；两者皆无 → member", () => {
    expect(adminPersonaOf({ super_admin: true, roles: [] })).toBe("super_admin");
    expect(adminPersonaOf({ super_admin: false, roles: [{ id: 3, name: "finance", permissions: {} }] })).toBe("delegated");
    expect(adminPersonaOf({ super_admin: false, roles: [] })).toBe("member");
    // 坏行不算角色：既不是 delegated，也不因为坏行变成 unknown
    expect(adminPersonaOf({ super_admin: false, roles: [{}, null, 7] })).toBe("member");
  });

  test("入口可见性：只有确认为 member 才隐藏；unknown fail-open", () => {
    const readings: AdminPersonaReading[] = ["super_admin", "delegated", "member", ADMIN_PERSONA_UNKNOWN];
    expect(readings.map(canEnterAdminConsole)).toEqual([true, true, false, true]);
  });
});

/* ================================================================== */
/* 2. mock 与真实后端同形（否则开发期看不到真实分流）                       */
/* ================================================================== */

describe("mock GET /auth/permissions 与真实后端同形", () => {
  beforeEach(() => {
    resetStore();
  });

  const call = (cookie: string | undefined) =>
    handleMock("GET", "auth/permissions", { query: {}, cookie } as never);

  test("demo（super_admin）→ super_admin=true 且带 super_admin 角色", async () => {
    const res = await call(session(1));
    expect(res.status).toBe(200);
    const data = (res.body as { data: unknown }).data;
    expect(parseAdminPermissions(data)).not.toBeNull();
    expect(adminPersonaOf(data)).toBe("super_admin");
    const parsed = parseAdminPermissions(data)!;
    expect(parsed.roles.map((role) => role.name)).toEqual(["super_admin"]);
  });

  test("普通账号 → super_admin=false 且 roles 为空（前端据此隐藏入口）", async () => {
    const res = await call(session(2));
    expect(res.status).toBe(200);
    const data = (res.body as { data: unknown }).data;
    expect(adminPersonaOf(data)).toBe("member");
  });

  test("未登录 → 401（权限读数不是公开信息）", async () => {
    const res = await call(undefined);
    expect(res.status).toBe(401);
  });
});

/* ================================================================== */
/* 3. 顶栏入口的实际渲染                                                  */
/* ================================================================== */

const workspaceStub: WorkspaceContextValue = {
  workspaces: [],
  current: null,
  currentId: null,
  role: null,
  kind: null,
  me: null,
  canManage: false,
  permissions: null,
  permissionsLoading: false,
  can: () => false,
  canForward: () => false,
  loading: false,
  error: null,
  select: () => undefined,
  createTeam: async () => null,
  refresh: async () => undefined,
};

const renderTopbar = (showAdminEntry: boolean) =>
  renderToStaticMarkup(
    <I18nProvider locale="zh" dict={getDictionary("zh")}>
      <WorkspaceContext.Provider value={workspaceStub}>
        <Topbar title="仪表盘" console="user" showAdminEntry={showAdminEntry} />
      </WorkspaceContext.Provider>
    </I18nProvider>,
  );

describe("顶栏管理后台入口按 persona 渲染", () => {
  test("可进入后台：渲染 /admin 入口", () => {
    const html = renderTopbar(true);
    expect(html).toContain('data-testid="topbar-admin-entry"');
    expect(html).toContain('href="/admin"');
  });

  test("确认为成员：不渲染入口（也不再有一个点进去必 403 的按钮）", () => {
    const html = renderTopbar(false);
    expect(html).not.toContain('data-testid="topbar-admin-entry"');
    expect(html).not.toContain('href="/admin"');
  });

  test("缺省 fail-open：不传 prop 时入口仍在（unknown 不该被当成成员）", () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="zh" dict={getDictionary("zh")}>
        <WorkspaceContext.Provider value={workspaceStub}>
          <Topbar title="仪表盘" console="user" />
        </WorkspaceContext.Provider>
      </I18nProvider>,
    );
    expect(html).toContain('data-testid="topbar-admin-entry"');
  });

  test("UserShell 真的把 persona 接到了入口上（否则这次修复会被一次重构悄悄移除）", () => {
    const shell = readFileSync(new URL("../user-shell.tsx", import.meta.url), "utf8");
    expect(shell).toContain("readAdminPersona()");
    expect(shell).toContain("showAdminEntry={canEnterAdminConsole(persona)}");
  });
});
