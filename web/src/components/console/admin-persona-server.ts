import { cache } from "react";
import { get } from "@/lib/api/core";
import { getSession } from "@/components/console/session";
import { adminPersonaOf, type AdminPersonaReading } from "@/components/console/admin-persona";

/**
 * 服务端读取当前账号的**平台管理视角**（供顶栏入口分流用）。
 *
 * 两次取数、零新增后端：
 *
 * 1. 会话（`GET /api/auth/me`，与 shell 共用同一次请求 —— `getSession` 由 React
 *    `cache` 去重）。`/me` 返回 `super_admin` 布尔值但**不返回** `admin_roles`
 *    （见 `backend/src/routes/auth.ts` 的 `publicUser`），所以它只能回答「是超管」。
 * 2. 不是超管时，才去读已存在、Web 此前零消费的 `GET /api/auth/permissions`，
 *    回答「有没有委派后台角色」。**只有这一个补充问题**，不是第二套权限体系：
 *    每个资源的 read/write 仍然只由后端 `adminPermissionGuard` 裁决。
 *
 * 任何一步失败 → `unknown`（fail-open 展示入口），理由见 `admin-persona.ts` 文件头。
 */
export const readAdminPersona = cache(async (): Promise<AdminPersonaReading> => {
  const session = await getSession();
  if (!session) return "unknown";
  if (session.user.super_admin === true) return "super_admin";
  try {
    return adminPersonaOf(await get<unknown>("/auth/permissions", undefined, session.cookie));
  } catch {
    return "unknown";
  }
});
