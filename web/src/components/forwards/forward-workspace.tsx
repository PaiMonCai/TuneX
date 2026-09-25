"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, MoreHorizontal, Plus, Route, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Input, Label } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import type { NodeBinding, PortForward, UserNode } from "@/lib/types";

type ForwardModeFilter = "all" | "direct" | "relay";

function isIngress(node: UserNode) {
  return node.role === "ingress" || node.role === "both";
}

export function ForwardWorkspace() {
  const { t } = useI18n();
  const [nodes, setNodes] = useState<UserNode[]>([]);
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [bindings, setBindings] = useState<Record<number, NodeBinding[]>>({});
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [modeFilter, setModeFilter] = useState<ForwardModeFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"direct" | "relay">("direct");
  const [name, setName] = useState("");
  const [ingressId, setIngressId] = useState("");
  const [egressId, setEgressId] = useState("");
  const [listenPort, setListenPort] = useState("");
  const [targetHost, setTargetHost] = useState("");
  const [targetPort, setTargetPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<number | null>(null);

  const ingressNodes = useMemo(() => nodes.filter(isIngress), [nodes]);
  const selectedBindings = ingressId ? bindings[Number(ingressId)] ?? [] : [];

  async function load() {
    setLoading(true);
    try {
      const [nodeRows, forwardRows] = await Promise.all([
        api.nodes.list(),
        api.forwards.list(),
      ]);
      const ingressRows = nodeRows.filter(isIngress);
      const rows = await Promise.all(
        ingressRows.map(async (node) => ({
          id: Number(node.id),
          bindings: await api.nodes.bindings(node.id),
        })),
      );
      const bindingMap: Record<number, NodeBinding[]> = {};
      for (const row of rows) bindingMap[row.id] = row.bindings;
      setNodes(nodeRows);
      setBindings(bindingMap);
      setForwards(forwardRows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("forward.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return forwards.filter((forward) => {
      if (modeFilter !== "all" && forward.mode !== modeFilter) return false;
      if (!q) return true;
      const fields = [
        forward.name,
        forward.ingress_node?.node_id ?? "",
        forward.egress_node?.node_id ?? "",
        forward.target_host ?? "",
        String(forward.target_port ?? ""),
        String(forward.listen_port ?? ""),
      ];
      return fields.some((field) => field.toLowerCase().includes(q));
    });
  }, [forwards, keyword, modeFilter]);

  function openCreate(mode: "direct" | "relay") {
    const firstIngress = ingressNodes[0];
    setCreateMode(mode);
    setName("");
    setIngressId(firstIngress ? String(firstIngress.id) : "");
    setEgressId("");
    setListenPort("");
    setTargetHost("");
    setTargetPort("");
    setCreateOpen(true);
  }

  async function createForward() {
    const ingress = Number(ingressId);
    const targetPortNum = Number(targetPort);
    const listenPortNum = listenPort ? Number(listenPort) : null;
    if (!name.trim() || !Number.isInteger(ingress) || !targetHost.trim() || !targetPort) {
      toast.error(t("forward.createFailed"));
      return;
    }
    if (
      !Number.isInteger(targetPortNum) ||
      targetPortNum < 1 ||
      targetPortNum > 65535 ||
      (listenPortNum !== null && (!Number.isInteger(listenPortNum) || listenPortNum < 1 || listenPortNum > 65535))
    ) {
      toast.error(t("forward.createFailed"));
      return;
    }
    if (createMode === "relay" && !egressId) {
      toast.error(t("forward.chooseEgress"));
      return;
    }

    setBusy(true);
    try {
      await api.forwards.create({
        mode: createMode,
        ingress_node_id: ingress,
        name: name.trim(),
        listen_port: listenPortNum,
        target_host: targetHost.trim(),
        target_port: targetPortNum,
        egress_node_id: createMode === "relay" ? Number(egressId) : null,
      });
      toast.success(t("forward.createSuccess"));
      setCreateOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("forward.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function runAction(forward: PortForward, action: "retry" | "suspend" | "resume") {
    setActionBusy(Number(forward.id));
    try {
      await api.forwards.action(forward.id, action);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("forward.loadFailed"));
    } finally {
      setActionBusy(null);
    }
  }

  async function removeForward(forward: PortForward) {
    if (!confirm(t("forward.deleteConfirm").replace("{name}", forward.name))) return;
    setActionBusy(Number(forward.id));
    try {
      await api.forwards.remove(forward.id);
      toast.success(t("forward.deleteSuccess"));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("forward.loadFailed"));
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={modeFilter === "all" ? "default" : "outline"}
            onClick={() => setModeFilter("all")}
          >
            {t("forward.all")}
          </Button>
          <Button
            size="sm"
            variant={modeFilter === "direct" ? "default" : "outline"}
            onClick={() => setModeFilter("direct")}
          >
            {t("forward.direct")}
          </Button>
          <Button
            size="sm"
            variant={modeFilter === "relay" ? "default" : "outline"}
            onClick={() => setModeFilter("relay")}
          >
            {t("forward.relay")}
          </Button>
          <Input
            className="h-9 w-64"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={t("forward.searchPlaceholder")}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => openCreate("direct")}>
            <Plus className="size-4" />
            {t("forward.createDirect")}
          </Button>
          <Button onClick={() => openCreate("relay")}>
            <Route className="size-4" />
            {t("forward.createRelay")}
          </Button>
        </div>
      </div>

      {!loading && forwards.length === 0 && !keyword && modeFilter === "all" ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ArrowLeftRight className="size-5" />
                {t("forward.createDirect")}
              </CardTitle>
              <CardDescription>{t("forward.directDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => openCreate("direct")}>{t("forward.createDirect")}</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Route className="size-5" />
                {t("forward.createRelay")}
              </CardTitle>
              <CardDescription>{t("forward.relayDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => openCreate("relay")}>{t("forward.createRelay")}</Button>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("common.name")}</TableHead>
                <TableHead>{t("forward.mode")}</TableHead>
                <TableHead>{t("forward.ingressNode")}</TableHead>
                <TableHead>{t("forward.egressNode")}</TableHead>
                <TableHead>{t("forward.listenPort")}</TableHead>
                <TableHead>{t("forward.target")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead>{t("common.createdAt")}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={9} className="h-24 text-center text-[var(--muted-foreground)]">
                    {t("common.loading")}
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableEmpty colSpan={9} text={t("common.noData")} />
              ) : (
                filtered.map((forward) => (
                  <TableRow key={String(forward.id)}>
                    <TableCell className="font-medium">
                      <Link href={"/forwards/" + forward.id} className="hover:underline">
                        {forward.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={forward.mode === "relay" ? "outline" : "secondary"}>
                        {forward.mode === "relay" ? t("forward.relay") : t("forward.direct")}
                      </Badge>
                    </TableCell>
                    <TableCell>{forward.ingress_node?.node_id ?? forward.ingress_node_id}</TableCell>
                    <TableCell>{forward.egress_node?.node_id ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">:{forward.listen_port ?? "auto"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {forward.target_host ?? "—"}{forward.target_port ? ":" + forward.target_port : ""}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge
                          variant={
                            forward.apply_status === "active"
                              ? "success"
                              : forward.apply_status === "error"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {forward.apply_status ?? "pending"}
                        </Badge>
                        {forward.apply_error ? (
                          <span className="max-w-52 truncate text-xs text-[var(--destructive)]">
                            {forward.apply_error}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-[var(--muted-foreground)]">
                      {formatDateTime(forward.created_at)}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" disabled={actionBusy === Number(forward.id)}>
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {forward.apply_status === "error" ? (
                            <DropdownMenuItem onClick={() => void runAction(forward, "retry")}>
                              {t("forward.retry")}
                            </DropdownMenuItem>
                          ) : null}
                          {forward.apply_status === "active" ? (
                            <DropdownMenuItem onClick={() => void runAction(forward, "suspend")}>
                              {t("forward.suspend")}
                            </DropdownMenuItem>
                          ) : null}
                          {forward.apply_status === "suspended" ? (
                            <DropdownMenuItem onClick={() => void runAction(forward, "resume")}>
                              {t("forward.resume")}
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem className="text-[var(--destructive)]" onClick={() => void removeForward(forward)}>
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
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {createMode === "relay" ? t("forward.createRelay") : t("forward.createDirect")}
            </DialogTitle>
            <DialogDescription>
              {createMode === "relay" ? t("forward.relayDesc") : t("forward.directDesc")}
            </DialogDescription>
          </DialogHeader>

          {ingressNodes.length === 0 ? (
            <div className="rounded-md border border-[var(--border)] p-4 text-sm text-[var(--muted-foreground)]">
              {t("forward.noIngress")}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <Field label={t("common.name")}>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="web-hk" />
              </Field>
              <Field label={t("forward.ingressNode")}>
                <Select
                  value={ingressId}
                  onValueChange={(value) => {
                    setIngressId(value);
                    setEgressId("");
                  }}
                >
                  <SelectTrigger><SelectValue placeholder={t("forward.chooseIngress")} /></SelectTrigger>
                  <SelectContent>
                    {ingressNodes.map((node) => (
                      <SelectItem key={String(node.id)} value={String(node.id)}>
                        {node.node_id} · {node.connect_ip ?? t("node.waiting")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              {createMode === "relay" ? (
                <Field label={t("forward.egressNode")}>
                  {selectedBindings.length === 0 ? (
                    <div className="rounded-md border border-dashed border-[var(--border)] p-3 text-sm text-[var(--muted-foreground)]">
                      <div>{t("forward.noBoundEgress")}</div>
                      <div className="mt-1 text-xs">{t("forward.bindFirstHint")}</div>
                      <Button className="mt-3" size="sm" variant="outline" asChild>
                        <Link href="/nodes">{t("common.nodes")}</Link>
                      </Button>
                    </div>
                  ) : (
                    <Select value={egressId} onValueChange={setEgressId}>
                      <SelectTrigger><SelectValue placeholder={t("forward.chooseEgress")} /></SelectTrigger>
                      <SelectContent>
                        {selectedBindings.map((binding) => (
                          <SelectItem key={String(binding.egress_node_id)} value={String(binding.egress_node_id)}>
                            {binding.egress_node.node_id} · {binding.egress_node.connect_ip ?? t("node.waiting")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              ) : null}

              <Field label={t("forward.listenPort")} hint={t("forward.autoPort")}>
                <Input
                  inputMode="numeric"
                  value={listenPort}
                  onChange={(event) => setListenPort(event.target.value)}
                  placeholder="20001"
                />
              </Field>
              <Field label={t("forward.targetHost")}>
                <Input value={targetHost} onChange={(event) => setTargetHost(event.target.value)} placeholder="example.com" />
              </Field>
              <Field label={t("forward.targetPort")}>
                <Input
                  inputMode="numeric"
                  value={targetPort}
                  onChange={(event) => setTargetPort(event.target.value)}
                  placeholder="443"
                />
              </Field>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t("common.cancel")}</Button>
            <Button
              onClick={() => void createForward()}
              disabled={
                busy ||
                ingressNodes.length === 0 ||
                (createMode === "relay" && selectedBindings.length === 0)
              }
            >
              {createMode === "relay" ? t("forward.createRelay") : t("forward.createDirect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-[var(--muted-foreground)]">{hint}</p> : null}
    </div>
  );
}
