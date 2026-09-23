import Link from "next/link";
import { cookies } from "next/headers";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { TunnelDetail } from "@/components/tunnels/tunnel-detail";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { serverT } from "@/lib/server-i18n";
import type { TrafficPoint, Tunnel } from "@/lib/types";

/** 隧道详情页（异步服务端组件）：预取隧道 + 近 14 天流量，交互交给 TunnelDetail 客户端组件 */
export default async function TunnelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  const cookie = (await cookies()).toString();
  const { t } = await serverT();

  let tunnel: Tunnel | null = null;
  let traffic: TrafficPoint[] = [];
  if (Number.isFinite(numericId) && numericId > 0) {
    tunnel = await api.tunnels.detail(numericId, cookie).catch(() => null);
    if (tunnel) {
      traffic = await api.tunnels.traffic(numericId, 14, cookie).catch(() => [] as TrafficPoint[]);
    }
  }

  if (!tunnel) {
    return (
      <AppShell title={t("common.notFound")} subtitleKey="tunnel.detailSubtitle" activeHref="/tunnels" showToaster={false}>
        <Card>
          <CardHeader>
            <CardTitle>{t("tunnel.notFound")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" asChild>
              <Link href="/tunnels">
                <ArrowLeft className="size-4" />
                {t("tunnel.backToList")}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell title={tunnel.name} subtitleKey="tunnel.detailSubtitle" activeHref="/tunnels" showToaster={false}>
      <TunnelDetail tunnel={tunnel} traffic={traffic} />
    </AppShell>
  );
}
