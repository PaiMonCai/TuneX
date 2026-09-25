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

export default async function ForwardDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  const cookie = (await cookies()).toString();
  const { t } = await serverT();

  let forward: Tunnel | null = null;
  let traffic: TrafficPoint[] = [];
  if (Number.isFinite(numericId) && numericId > 0) {
    forward = await api.tunnels.detail(numericId, cookie).catch(() => null);
    if (forward) {
      traffic = await api.tunnels.traffic(numericId, 14, cookie).catch(() => [] as TrafficPoint[]);
    }
  }

  if (!forward) {
    return (
      <AppShell title={t("common.notFound")} subtitleKey="forward.detailSubtitle" activeHref="/forwards" showToaster={false}>
        <Card>
          <CardHeader>
            <CardTitle>{t("forward.notFound")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" asChild>
              <Link href="/forwards">
                <ArrowLeft className="size-4" />
                {t("forward.backToList")}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell title={forward.name} subtitleKey="forward.detailSubtitle" activeHref="/forwards" showToaster={false}>
      <TunnelDetail tunnel={forward} traffic={traffic} />
    </AppShell>
  );
}
