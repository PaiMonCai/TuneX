"use client";

import { ConsoleErrorSurface } from "@/components/console/error-surface";

/**
 * Admin Console 的受控错误面。
 *
 * 比应用级更多一件事：它会额外读一次 `GET /api/auth/permissions`（同一个后端权限视图，
 * Web 此前零消费），从而把「这个账号不是后台用户」这件事**说清楚** —— 普通账号用地址栏
 * 直接访问 `/admin` 时，服务端 403 的真实状态码到不了浏览器（Next 只转发摘要），
 * 没有这一次读数就只能含糊地说「加载失败」，用户会以为平台故障。
 *
 * 这只是文案依据，**不是**权限判定，也**不**隐藏任何入口：能不能进 `/admin/*` 的每一段
 * 仍然只由后端 `adminPermissionGuard` 裁决。
 */
export default function AdminConsoleError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <ConsoleErrorSurface scope="admin" error={error} retry={retry} />;
}
