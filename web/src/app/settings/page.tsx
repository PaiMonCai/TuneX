import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { SettingsBody } from "@/components/settings/settings-body";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { serverT } from "@/lib/server-i18n";
import type { User } from "@/lib/types";

/** 设置页（异步服务端组件）：服务端取用户资料，客户端组件负责表单与 toast */
export default async function SettingsPage() {
  const cookie = (await cookies()).toString();
  const { t } = await serverT();
  const user = await api.settings.profile(cookie).catch(() => null as User | null);

  return (
    <AppShell titleKey="settings.title" subtitleKey="settings.subtitle" activeHref="/settings">
      {user ? (
        <SettingsBody user={user} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t("common.notFound")}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-[var(--muted-foreground)]">{t("settings.profileFailed")}</CardContent>
        </Card>
      )}
    </AppShell>
  );
}
