import { Suspense } from "react";
import { AppShell, shellI18n } from "@/components/app-shell";
import { localizedLabel } from "@/lib/nav";
import { NotificationChannelsManager } from "@/components/admin/notification-channels-manager";

/**
 * `/admin/notification-channels` —— **平台级通知渠道配置**（切片 N2-UI）。
 *
 * ── 为什么是**独立目录**，而不是塞进 `admin/[segment]` ──
 * `[segment]` 的动态段有自己的白名单（未知段走 `notFound()`）；把新页挂成它的一个新段，
 * 就等于把一个"只会读投影"的通用资源页当成"可写凭据"的配置页 —— 两者的交互与风险面完全不同。
 * 独立目录同时避免了"新段没登记 ⇒ 静默回落成别的页面"这一类地址栏与内容互相矛盾的旧问题。
 *
 * ── 权限 ──
 * 由后端 RBAC 把关（资源键 `notification_channels`，见 `backend/src/permissions.ts`）：
 * 非超管按 read/write 分级。本页**不做乐观隐藏**：读不到就渲染后端给的原因
 * （403 有独立的一态，绝不折叠成"暂无渠道"），写操作被拒时也把原因原样显示。
 *
 * ── 为什么不在这里 SSR 取数 ──
 * 页面要同时知道"渠道状态"与"当前会话在该资源键上的能力"（后者来自 `/auth/permissions`），
 * 而两者都只对**当前会话**有意义；放在客户端容器里可以让"读失败/权限未知"走同一套三态，
 * 而不是让外壳先替用户下一个结论。
 */
export default async function AdminNotificationChannelsPage() {
  const { locale } = await shellI18n();
  return (
    <AppShell
      title={localizedLabel(locale, "admin.notificationChannels", "通知渠道", "Notification channels")}
      subtitle={localizedLabel(
        locale,
        "admin.notificationChannelsSubtitle",
        "平台级渠道凭据与投递状态：凭据只写不读，保存成功 ≠ 会被投递",
        "Platform channel credentials and delivery state: credentials are write-only, and saving does not mean delivery",
      )}
      adminMode
    >
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-[var(--muted)]" />}>
        <NotificationChannelsManager />
      </Suspense>
    </AppShell>
  );
}
