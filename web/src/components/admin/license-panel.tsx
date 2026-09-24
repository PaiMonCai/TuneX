import { BadgeCheck, ShieldAlert, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { serverT } from "@/lib/server-i18n";
import { formatDateTime } from "@/lib/utils";
import type { LicenseInfo } from "@/lib/types";

/** epoch 秒 → 本地时间字符串（后端 license.expired_at 为秒） */
function formatExpiry(v: unknown): string | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return formatDateTime(new Date(n * 1000));
}

const TYPE_META: Record<string, { badge: "success" | "default" | "muted"; icon: typeof ShieldCheck; key: string }> = {
  business: { badge: "success", icon: ShieldCheck, key: "admin.licenseBusiness" },
  personal: { badge: "default", icon: BadgeCheck, key: "admin.licensePersonal" },
  none: { badge: "muted", icon: ShieldAlert, key: "admin.licenseNone" },
};

/**
 * License 授权面板（服务端组件，只读）。
 * 说明：本实现的 license 由 env + Redis 覆盖模拟，后台仅展示，不提供在线激活
 * （激活属于服务端运维动作），因此这里刻意不放置任何写操作。
 */
export async function AdminLicensePanel({ license }: { license: LicenseInfo }) {
  const { t } = await serverT();
  const type = String(license.type ?? "none");
  const meta = TYPE_META[type] ?? TYPE_META.none;
  const Icon = meta.icon;
  const expiry = formatExpiry(license.expired_at);
  const siteUrl = typeof license.site_url === "string" ? license.site_url : "-";

  return (
    <div className="flex flex-col gap-5" data-testid="admin-license">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Icon className="size-5" />
              {t("admin.license")}
            </CardTitle>
            <CardDescription>{t("admin.licenseType")}</CardDescription>
          </div>
          <Badge variant={meta.badge}>{t(meta.key)}</Badge>
        </CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              <TableRow>
                <TableCell className="w-40 text-[var(--muted-foreground)]">{t("admin.licenseType")}</TableCell>
                <TableCell className="font-medium">
                  <span className="font-mono">{type}</span>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-[var(--muted-foreground)]">{t("admin.licenseExpire")}</TableCell>
                <TableCell className="font-medium">{expiry ?? t("admin.licenseUnlimited")}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-[var(--muted-foreground)]">{t("admin.licenseSite")}</TableCell>
                <TableCell className="font-mono text-xs">{siteUrl}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="field-hint">{t("admin.readOnlyHint")}</p>
    </div>
  );
}
