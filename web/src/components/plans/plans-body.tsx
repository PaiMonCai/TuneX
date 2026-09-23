"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Check, Infinity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/card";
import { Separator } from "@/components/ui/card";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { BILLING_CYCLES } from "@/lib/constants";
import { formatMoney } from "@/lib/utils";
import type { Plan } from "@/lib/types";

export function PlansBody() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.plans.list({ status: "active", page_size: 50 })
      .then((r) => setPlans(r.data))
      .catch((e) => toast.error(e instanceof Error ? e.message : "加载失败"))
      .finally(() => setLoading(false));
  }, []);

  async function buy(plan: Plan) {
    try {
      await api.plans.purchase(plan.id);
      toast.success(t("plan.buySuccess"));
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("plan.buyFailed"));
    }
  }

  const cycleLabel = (c: string) => BILLING_CYCLES.find((x) => x.value === c)?.[locale === "zh" ? "zh" : "en"] ?? c;

  if (loading) return <div className="h-96 animate-pulse rounded-lg bg-[var(--muted)]" />;

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {plans.map((plan) => {
        const outOfStock = plan.stock !== null && plan.stock <= 0;
        return (
          <Card key={plan.id} className={plan.original_price ? "border-[var(--primary)]/40" : ""}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{plan.name}</CardTitle>
                {plan.original_price && (
                  <Badge variant="success">-{Math.round((1 - plan.price / (plan.original_price ?? plan.price)) * 100)}%</Badge>
                )}
              </div>
              <CardDescription>{plan.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-bold">{formatMoney(plan.price)}</span>
                <span className="text-sm text-[var(--muted-foreground)]">/ {cycleLabel(plan.billing_cycle)}</span>
              </div>
              <Separator />
              <ul className="flex flex-col gap-1.5 text-sm">
                <Feature ok label={`${t("plan.maxTunnels")}: ${plan.max_tunnels ?? t("plan.unlimited")}`} />
                <Feature ok label={`${t("plan.traffic")}: ${plan.traffic ? `${plan.traffic} GB` : t("plan.unlimited")}`} />
                <Feature ok label={`${t("plan.bandwidth")}: ${bandwidth(plan.bandwidth_limit)}`} />
                <Feature ok label={`${t("plan.clientLimit")}: ${plan.client_limit ?? t("plan.unlimited")}`} />
                <Feature ok label={`${t("plan.ipLimit")}: ${plan.ip_limit ?? t("plan.unlimited")}`} />
                <Feature ok={plan.allow_custom_in_node_group} label={t("plan.allowCustomInNodeGroup") ?? "自定义入口节点组"} />
                <Feature ok={plan.allow_custom_out_node_group} label={t("plan.allowCustomOutNodeGroup") ?? "自定义出口节点组"} />
              </ul>
            </CardContent>
            <CardFooter>
              <Button className="w-full" disabled={outOfStock} onClick={() => buy(plan)}>
                {outOfStock ? t("plan.stockOut") : t("plan.buy")}
              </Button>
            </CardFooter>
          </Card>
        );
      })}
    </div>
  );
}

function bandwidth(v: number | null) {
  if (!v) return "不限";
  return v >= 1000 ? `${v / 1000} Gbps` : `${v} Mbps`;
}

function Feature({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      {ok ? (
        <Check className="size-4 text-[var(--success)]" />
      ) : (
        <span className="size-4 rounded-full border border-[var(--muted-foreground)]/40" />
      )}
      <span className={ok ? "text-[var(--foreground)]" : "text-[var(--muted-foreground)]"}>{label}</span>
    </li>
  );
}
