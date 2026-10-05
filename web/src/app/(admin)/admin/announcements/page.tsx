import { cookies } from "next/headers";
import { Suspense } from "react";
import { AppShell, shellI18n } from "@/components/app-shell";
import { localizedLabel } from "@/lib/nav";
import { api } from "@/lib/api";
import { normalizeAnnouncements } from "@/lib/announcements";
import { AnnouncementAdmin } from "@/components/admin/announcement-admin";
import type { Locale } from "@/lib/i18n";

/**
 * `/admin/announcements` —— 平台公告（V5-WP18.5，Admin Console）。
 *
 * ── 取数失败不抛 ──
 * 与 `/admin/route-profiles` 同一取向：外壳先响应，列表在 `Suspense` 里取；失败时把后端
 * 原因渲染出来。这一条在这里尤其重要 —— `/admin/announcements` 的 RBAC 资源键由 **WP18.6**
 * 登记，在那之前非超管访问会拿到 403（fail-closed）。把 403 渲染成"权限不足"，比渲染成
 * "还没有公告"诚实得多。
 *
 * ── 作用域 ──
 * 这个页面只管**平台**公告（`scope_kind="platform"`，对所有人可见）。租户侧公告走
 * `/api/announcements`（复用 `settings:read/manage`），本期前端只做用户侧最小展示。
 */
async function AnnouncementsBody({ locale }: { locale: Locale }) {
  const cookie = (await cookies()).toString();
  try {
    const rows = await api.admin.announcements.list(cookie);
    return <AnnouncementAdmin initial={normalizeAnnouncements(rows)} locale={locale} />;
  } catch (e) {
    return (
      <p className="text-sm text-[var(--destructive)]" data-testid="announcement-admin-error">
        {e instanceof Error ? e.message : "公告加载失败"}
      </p>
    );
  }
}

export default async function AdminAnnouncementsPage() {
  const { locale } = await shellI18n();
  return (
    <AppShell
      title={localizedLabel(locale, "admin.announcements", "公告管理", "Announcements")}
      subtitle={localizedLabel(
        locale,
        "admin.announcementsSubtitle",
        "平台公告：写给所有人的内容（纯文本；站内 + 本安装已打开的渠道）",
        "Platform announcements: content for everyone (plain text; in-app + enabled channels)",
      )}
      adminMode
      showToaster={false}
    >
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-[var(--muted)]" />}>
        <AnnouncementsBody locale={locale} />
      </Suspense>
    </AppShell>
  );
}
