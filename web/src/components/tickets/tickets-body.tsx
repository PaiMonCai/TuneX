"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableEmpty } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { formatDateTime } from "@/lib/utils";
import type { Paginated, Ticket } from "@/lib/types";

export function TicketsBody() {
  const { t } = useI18n();
  const [data, setData] = useState<Paginated<Ticket> | null>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);

  async function load() {
    const r = await api.tickets.list({ page: 1, page_size: 20 });
    setData(r);
  }

  useEffect(() => {
    load().catch((e) => toast.error(e instanceof Error ? e.message : t("common.ticketLoadFailed")));
  }, []);

  async function submit() {
    if (!title.trim() || !content.trim()) {
      toast.error(t("common.ticketRequired"));
      return;
    }
    setPending(true);
    try {
      await api.tickets.create({ title: title.trim(), content: content.trim() });
      toast.success(t("common.ticketCreated"));
      setTitle("");
      setContent("");
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.ticketCreateFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="size-4" />
          {t("common.ticketNew")}
        </Button>
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>{t("common.ticketsList")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("common.ticketTitle")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead>{t("common.createdAt")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data || data.data.length === 0 ? (
                <TableEmpty colSpan={3} text={t("common.noData")} />
              ) : (
                data.data.map((tk) => (
                  <TableRow key={tk.id}>
                    <TableCell className="font-medium">{tk.title}</TableCell>
                    <TableCell>
                      <Badge variant={tk.status === "open" ? "default" : "muted"}>
                        {tk.status === "open" ? t("common.ticketOpen") : t("common.ticketClosed")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-[var(--muted-foreground)]">{formatDateTime(tk.created_at)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("common.ticketNew")}</DialogTitle>
            <DialogDescription>{t("common.ticketDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>{t("common.ticketTitle")}</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t("common.ticketContent")}</Label>
              <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={5} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submit} disabled={pending}>
              {t("common.ticketSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
