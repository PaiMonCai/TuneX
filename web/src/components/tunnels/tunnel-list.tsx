"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Copy, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableEmpty } from "@/components/ui/table";
import { Badge } from "@/components/ui/card";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { TunnelCreateDialog } from "./tunnel-create-dialog";
import type { NodeGroup, Paginated, Tunnel } from "@/lib/types";

export function TunnelList() {
  const { t } = useI18n();
  const router = useRouter();
  const [data, setData] = useState<Paginated<Tunnel> | null>(null);
  const [loading, setLoading] = useState(true);
  const [openCreate, setOpenCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Tunnel | null>(null);
  const [nodeGroups, setNodeGroups] = useState<NodeGroup[]>([]);

  async function load() {
    setLoading(true);
    try {
      const [res, ng] = await Promise.all([
        api.tunnels.list({ page: 1, page_size: 20 }),
        api.nodeGroups.list({ page: 1, page_size: 100 }),
      ]);
      setData(res);
      setNodeGroups(ng.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function onDelete() {
    if (!deleteTarget) return;
    try {
      await api.tunnels.remove(deleteTarget.id);
      toast.success(t("tunnel.deleteSuccess"));
      setDeleteTarget(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    }
  }

  async function onCreated() {
    setOpenCreate(false);
    load();
    router.refresh();
  }

  async function copyListen(tun: Tunnel) {
    const text = `${tun.listen_ip ?? "*"}:${tun.listen_port}`;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${t("common.copied")} ${text}`);
    } catch {
      toast.error(text);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <span>{data ? `共 ${data.total} 条` : "加载中…"}</span>
        </div>
        <Button size="sm" onClick={() => setOpenCreate(true)} data-testid="create-tunnel-btn">
          <Plus className="size-4" />
          {t("tunnel.createButton")}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("common.name")}</TableHead>
              <TableHead>{t("tunnel.tunnelType")}</TableHead>
              <TableHead>{t("tunnel.listenAddress")}</TableHead>
              <TableHead>{t("tunnel.forward")}</TableHead>
              <TableHead>{t("tunnel.traffic")}</TableHead>
              <TableHead>{t("common.status")}</TableHead>
              <TableHead>{t("common.createdAt")}</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-[var(--muted-foreground)]">
                  {t("common.loading")}
                </TableCell>
              </TableRow>
            ) : !data || data.data.length === 0 ? (
              <TableEmpty colSpan={7} text={t("tunnel.empty")} />
            ) : (
              data.data.map((tun) => (
                <TableRow key={tun.id}>
                  <TableCell className="font-medium">
                    <Link href={`/tunnels/${tun.id}`} className="hover:underline">
                      {tun.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{tun.tunnel_type}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <button onClick={() => copyListen(tun)} className="flex items-center gap-1 hover:text-[var(--primary)]">
                      {tun.listen_ip ?? "*"}:{tun.listen_port ?? "-"}
                      <Copy className="size-3 opacity-50" />
                    </button>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-[var(--muted-foreground)]">
                    {tun.forward_addresses.join(", ")}
                  </TableCell>
                  <TableCell className="text-xs">{formatBytes(tun.traffic)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <span className={`size-2 rounded-full ${tun.online ? "bg-[var(--success)]" : "bg-[var(--muted-foreground)]"}`} />
                    </div>
                    <Badge className="mt-0.5" variant={tun.status === "active" ? "success" : "muted"}>
                      {tun.status === "active" ? t("common.active") : t("common.inactive")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-[var(--muted-foreground)]">
                    {formatDateTime(tun.created_at)}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/tunnels/${tun.id}`}>{t("common.edit")}</Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-[var(--destructive)]"
                          onClick={() => setDeleteTarget(tun)}
                        >
                          <Trash2 className="size-4" />
                          {t("common.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <TunnelCreateDialog open={openCreate} onOpenChange={setOpenCreate} nodeGroups={nodeGroups} onCreated={onCreated} />

      <Dialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("common.delete")}</DialogTitle>
            <DialogDescription>{t("tunnel.deleteConfirm")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={onDelete}>
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
