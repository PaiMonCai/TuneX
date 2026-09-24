import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { WorkspaceMembers } from "@/components/workspace/workspace-members";
import { serverT } from "@/lib/server-i18n";

/**
 * 工作空间管理页（TEN-01）：当前 workspace 的成员列表、邀请、移除/退出。
 * 页面外壳沿用 AppShell（登录态守卫 + 侧边栏），数据由客户端组件按
 * `x-workspace-id` 作用域拉取——切换空间后同一页自动刷新成新空间的成员。
 */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverT();
  return { title: t("workspace.title") };
}

export default function WorkspaceSettingsPage() {
  return (
    <AppShell titleKey="workspace.title" subtitleKey="workspace.subtitle" activeHref="/settings">
      <WorkspaceMembers />
    </AppShell>
  );
}
