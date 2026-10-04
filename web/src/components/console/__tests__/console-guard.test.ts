/**
 * WP13.5A Console Boundary — 前端 guard 单测（纯函数，无浏览器 / 无 docker）。
 *
 * 最重要的一条：**前端 guard 不是授权**（§9.4.1 要求 3）。
 * `/api/auth/me` 只返回 `super_admin`，不返回 `admin_roles`，而后端存在「有后台角色的 admin」，
 * 因此前端**绝不能**用 `super_admin === false` 把用户重定向走 —— 那会误伤合法管理员，
 * 并把前端猜测变成事实授权。下面的回归测试把这个结论钉死。
 *
 * 跑法（web 目录）：bun test src/components/console/__tests__/
 */
import { test, expect, describe } from "bun:test";
import {
  LOGIN_PATH,
  USER_HOME_PATH,
  adminAccessState,
  consoleHomePath,
  guardConsoleAccess,
} from "@/components/console/console-guard";

describe("guardConsoleAccess：只做「未登录 → /login」", () => {
  test("未登录访问 User Console → 重定向 /login", () => {
    expect(guardConsoleAccess({ surface: "user", authenticated: false })).toEqual({
      action: "redirect",
      to: LOGIN_PATH,
      reason: "unauthenticated",
    });
  });

  test("未登录访问 Admin Console → 重定向 /login（与用户端同一入口，不泄露 admin 存在性）", () => {
    expect(guardConsoleAccess({ surface: "admin", authenticated: false })).toEqual({
      action: "redirect",
      to: LOGIN_PATH,
      reason: "unauthenticated",
    });
  });

  test("已登录 → 一律渲染（不因角色做任何重定向）", () => {
    expect(guardConsoleAccess({ surface: "user", authenticated: true })).toEqual({ action: "render", surface: "user" });
    expect(guardConsoleAccess({ surface: "admin", authenticated: true })).toEqual({ action: "render", surface: "admin" });
    expect(guardConsoleAccess({ surface: "auth", authenticated: true })).toEqual({ action: "render", surface: "auth" });
    expect(guardConsoleAccess({ surface: "public", authenticated: true })).toEqual({ action: "render", surface: "public" });
  });

  test("认证页 / 落地页不因登录状态重定向（保持既有行为）", () => {
    for (const surface of ["auth", "public"] as const) {
      expect(guardConsoleAccess({ surface, authenticated: false }).action).toBe("render");
    }
  });

  test("回归：super_admin=false 的会话不会被前端踢走（角色管理员的场景）", () => {
    // 会话形状来自 /api/auth/me：只有 super_admin，没有 admin_roles。
    // 因此「是否允许进 admin」在前端是判不了的 → 必须渲染，交给后端 RBAC。
    const sessionWithoutAdminRoles = { super_admin: false };
    expect(adminAccessState(sessionWithoutAdminRoles)).toBe("delegated");
    // guardConsoleAccess 的入参里根本没有角色/权限字段：已登录就渲染。
    const decision = guardConsoleAccess({ surface: "admin", authenticated: true });
    expect(decision.action).toBe("render");
    // 反例守门：任何「按角色重定向」的实现都必须改这里的签名，届时该测试会失败
    expect(Object.keys(decision)).toEqual(["action", "surface"]);
  });
});

describe("adminAccessState：只用于展示，不用于拦截", () => {
  test("超管 / 非超管 / 空会话的区分", () => {
    expect(adminAccessState({ super_admin: true })).toBe("super_admin");
    expect(adminAccessState({ super_admin: false })).toBe("delegated");
    expect(adminAccessState(null)).toBe("delegated");
    expect(adminAccessState(undefined)).toBe("delegated");
    expect(adminAccessState({})).toBe("delegated");
  });
});

describe("consoleHomePath：控制台切换保持既有 URL", () => {
  test("User / Admin / Auth 的落点", () => {
    expect(consoleHomePath("user")).toBe(USER_HOME_PATH);
    expect(consoleHomePath("user")).toBe("/dashboard");
    expect(consoleHomePath("admin")).toBe("/admin");
    expect(consoleHomePath("auth")).toBe(LOGIN_PATH);
    expect(consoleHomePath("public")).toBe("/dashboard");
  });
});
