"use client";

import { ConsoleErrorSurface } from "@/components/console/error-surface";

/**
 * 应用级受控错误面（Next 16.3 的 `error.js` 约定）。
 *
 * 在这一层之前，全站**没有任何** `error.tsx`：任何页面级异常（包括普通账号点进
 * `/admin` 撞到的后端 403）都会落到 Next 的默认错误屏 —— 没有原因、没有回去路径，
 * 用户分不清「没权限」和「服务挂了」。
 *
 * 已安装版本的写法以此为准：**`retry`**（v16.3.0 起稳定；旧的 `unstable_retry` /
 * `reset` 语义不同：`reset` 只清错误态、不重新取数）。`error.js` 必须是客户端组件，
 * 且**不**包住同层的 `layout.js` —— 需要连根布局一起兜住的场景由 `global-error.js` 负责，
 * 本页刻意不越界。
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <ConsoleErrorSurface scope="app" error={error} retry={retry} />;
}
