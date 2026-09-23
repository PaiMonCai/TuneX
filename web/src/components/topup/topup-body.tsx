"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableEmpty } from "@/components/ui/table";
import { Badge } from "@/components/ui/card";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { formatDateTime, formatMoney } from "@/lib/utils";
import type { Paginated, TopupOrder } from "@/lib/types";

const QUICK_AMOUNTS = [10, 50, 100, 200, 500];

export function TopupBody() {
  const { t } = useI18n();
  const router = useRouter();
  const [amount, setAmount] = useState("50");
  const [paymentId, setPaymentId] = useState("");
  const [payments, setPayments] = useState<{ id: number; name: string; method: string }[]>([]);
  const [history, setHistory] = useState<Paginated<TopupOrder> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.topups.payments().then(setPayments).catch(() => {});
    api.topups.list({ page: 1, page_size: 10 }).then(setHistory).catch(() => {});
  }, []);

  async function submit() {
    const a = Number(amount);
    if (!(a >= 1)) {
      toast.error(t("topup.minAmount"));
      return;
    }
    if (!paymentId) {
      toast.error(t("topup.payMethod"));
      return;
    }
    setLoading(true);
    try {
      const order = await api.topups.create(a, Number(paymentId));
      toast.success(t("topup.success"));
      if (order.pay_url) window.open(order.pay_url, "_blank");
      api.topups.list({ page: 1, page_size: 10 }).then(setHistory);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("topup.failed"));
    } finally {
      setLoading(false);
    }
  }

  const statusVariant = (s: string) => (s === "success" ? "success" : s === "pending" ? "default" : "muted");
  const statusLabel = (s: string) =>
    s === "success" ? t("topup.statusSuccess") : s === "pending" ? t("topup.statusPending") : t("topup.statusCancelled");

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle>{t("topup.title")}</CardTitle>
          <CardDescription>{t("topup.activityHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>{t("topup.amount")}</Label>
            <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
            <div className="mt-1 flex flex-wrap gap-2">
              {QUICK_AMOUNTS.map((q) => (
                <Button key={q} variant="outline" size="sm" onClick={() => setAmount(String(q))}>
                  ¥{q}
                </Button>
              ))}
            </div>
            <p className="text-xs text-[var(--muted-foreground)]">
              {t("topup.bonus")}: {formatMoney(Number(amount) >= 100 ? Number(amount) * 0.05 : 0)}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t("topup.payMethod")}</Label>
            <Select value={paymentId} onValueChange={setPaymentId}>
              <SelectTrigger>
                <SelectValue placeholder="选择支付方式" />
              </SelectTrigger>
              <SelectContent>
                {payments.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={submit} disabled={loading}>
            {t("topup.submit")}
          </Button>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>{t("topup.history")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("topup.orderNo")}</TableHead>
                <TableHead>{t("common.price")}</TableHead>
                <TableHead>{t("common.bonus")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead>{t("common.createdAt")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {!history || history.data.length === 0 ? (
                <TableEmpty colSpan={6} text={t("common.noData")} />
              ) : (
                history.data.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-mono text-xs">{o.order_id}</TableCell>
                    <TableCell>{formatMoney(o.price)}</TableCell>
                    <TableCell>{o.bonus > 0 ? `+${formatMoney(o.bonus)}` : "-"}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(o.status) as "default"}>{statusLabel(o.status)}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-[var(--muted-foreground)]">{formatDateTime(o.created_at)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => navigator.clipboard.writeText(o.order_id)}
                        >
                          <Copy className="size-3.5" />
                        </Button>
                        {o.status === "pending" && o.pay_url && (
                          <Button variant="ghost" size="icon" asChild>
                            <a href={o.pay_url} target="_blank" rel="noreferrer">
                              <ExternalLink className="size-3.5" />
                            </a>
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
