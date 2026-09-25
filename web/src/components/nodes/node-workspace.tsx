"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, Link2, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type {
  NodeBinding,
  NodeEnrollmentIssued,
  NodeGroup,
  NodeRole,
  PortForward,
  UserNode,
} from "@/lib/types";

function roleLabel(role: NodeRole | null | undefined, t: (key: string) => string) {
  if (role === "ingress") return t("node.ingress");
  if (role === "egress") return t("node.egress");
  if (role === "both") return t("node.both");
  return "—";
}

function isIngress(node: UserNode) {
  return node.role === "ingress" || node.role === "both";
}

function isEgress(node: UserNode) {
  return node.role === "egress" || node.role === "both";
}

export function NodeWorkspace() {
  const { t } = useI18n();
  const [nodes, setNodes] = useState<UserNode[]>([]);
  const [groups, setGroups] = useState<NodeGroup[]>([]);
  const [selectedIngressId, setSelectedIngressId] = useState<number | null>(null);
  const [bindings, setBindings] = useState<NodeBinding[]>([]);
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [nodeId, setNodeId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [nodeRole, setNodeRole] = useState<NodeRole>("ingress");

  const [install, setInstall] = useState<NodeEnrollmentIssued | null>(null);

  const [bindOpen, setBindOpen] = useState(false);
  const [bindEgressId, setBindEgressId] = useState("");

  const [forwardOpen, setForwardOpen] = useState(false);
  const [forwardName, setForwardName] = useState("");
  const [listenPort, setListenPort] = useState("");
  const [targetHost, setTargetHost] = useState("");
  const [targetPort, setTargetPort] = useState("");
  const [forwardEgressId, setForwardEgressId] = useState("direct");
  const [busy, setBusy] = useState(false);

  const selectedIngress = nodes.find((n) => Number(n.id) === selectedIngressId) ?? null;

  const availableEgress = useMemo(() => {
    const bound = new Set(bindings.map((b) => Number(b.egress_node_id)));
    return nodes.filter(
      (n) => isEgress(n) && Number(n.id) !== selectedIngressId && !bound.has(Number(n.id)),
    );
  }, [nodes, bindings, selectedIngressId]);

  async function loadNodes() {
    setLoading(true);
    try {
      const [nodeRows, groupRows] = await Promise.all([
        api.nodes.list(),
        api.nodeGroups.list({ page: 1, page_size: 100 }),
      ]);
      setNodes(nodeRows);
      setGroups(groupRows.data);
      const ingressRows = nodeRows.filter(isIngress);
      setSelectedIngressId((current) => {
        if (current && ingressRows.some((n) => Number(n.id) === current)) return current;
        return ingressRows[0] ? Number(ingressRows[0].id) : null;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载节点失败");
    } finally {
      setLoading(false);
    }
  }

  async function loadIngressDetail(id: number | null) {
    if (!id) {
      setBindings([]);
      setForwards([]);
      return;
    }
    try {
      const [bindingRows, forwardRows] = await Promise.all([
        api.nodes.bindings(id),
        api.nodes.forwards(id),
      ]);
      setBindings(bindingRows);
      setForwards(forwardRows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载入口节点失败");
    }
  }

  useEffect(() => {
    void loadNodes();
  }, []);

  useEffect(() => {
    void loadIngressDetail(selectedIngressId);
  }, [selectedIngressId]);

  useEffect(() => {
    if (!createOpen || groupId || groups.length === 0) return;
    const first = groups[0]!;
    setGroupId(String(first.id));
    setNodeRole(first.node_type === "out" ? "egress" : "ingress");
  }, [createOpen, groupId, groups]);

  async function createNode() {
    const gid = Number(groupId);
    if (!nodeId.trim() || !Number.isInteger(gid)) {
      toast.error("请填写节点 ID 并选择节点组");
      return;
    }
    setBusy(true);
    try {
      const created = await api.nodeGroups.provisionNode(gid, {
        node_id: nodeId.trim(),
        role: nodeRole,
      });
      setCreateOpen(false);
      setInstall(created.enrollment);
      setNodeId("");
      setGroupId("");
      toast.success(t("node.createSuccess"));
      await loadNodes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建节点失败");
    } finally {
      setBusy(false);
    }
  }

  async function regenerateInstaller(node: UserNode) {
    setBusy(true);
    try {
      setInstall(await api.nodes.enrollment(node.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "生成安装命令失败");
    } finally {
      setBusy(false);
    }
  }

  async function copyInstaller() {
    if (!install) return;
    try {
      await navigator.clipboard.writeText(install.install_command);
      toast.success(t("node.copySuccess"));
    } catch {
      toast.error("复制失败，请手动复制");
    }
  }

  async function bindEgress() {
    if (!selectedIngressId || !bindEgressId) return;
    setBusy(true);
    try {
      await api.nodes.bindEgress(selectedIngressId, Number(bindEgressId));
      setBindOpen(false);
      setBindEgressId("");
      toast.success(t("node.bindSuccess"));
      await loadIngressDetail(selectedIngressId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "绑定出口失败");
    } finally {
      setBusy(false);
    }
  }

  async function unbindEgress(egressId: number) {
    if (!selectedIngressId) return;
    setBusy(true);
    try {
      await api.nodes.unbindEgress(selectedIngressId, egressId);
      toast.success(t("node.unbindSuccess"));
      await loadIngressDetail(selectedIngressId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "解除绑定失败");
    } finally {
      setBusy(false);
    }
  }

  async function createForward() {
    if (!selectedIngressId || !forwardName.trim() || !targetHost.trim() || !targetPort) {
      toast.error("请填写名称和目标地址");
      return;
    }
    const targetPortNum = Number(targetPort);
    const listenPortNum = listenPort ? Number(listenPort) : null;
    if (
      !Number.isInteger(targetPortNum) ||
      targetPortNum < 1 ||
      targetPortNum > 65535 ||
      (listenPortNum !== null && (!Number.isInteger(listenPortNum) || listenPortNum < 1 || listenPortNum > 65535))
    ) {
      toast.error("端口必须在 1-65535 之间");
      return;
    }
    setBusy(true);
    try {
      await api.nodes.createForward(selectedIngressId, {
        name: forwardName.trim(),
        listen_port: listenPortNum,
        target_host: targetHost.trim(),
        target_port: targetPortNum,
        egress_node_id: forwardEgressId === "direct" ? null : Number(forwardEgressId),
      });
      setForwardOpen(false);
      setForwardName("");
      setListenPort("");
      setTargetHost("");
      setTargetPort("");
      setForwardEgressId("direct");
      toast.success(t("node.forwardCreated"));
      await loadIngressDetail(selectedIngressId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建端口转发失败");
      await loadIngressDetail(selectedIngressId);
    } finally {
      setBusy(false);
    }
  }

  async function forwardAction(forward: PortForward, action: "retry" | "suspend" | "resume") {
    if (!selectedIngressId) return;
    setBusy(true);
    try {
      await api.nodes.forwardAction(selectedIngressId, forward.id, action);
      await loadIngressDetail(selectedIngressId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function removeForward(forward: PortForward) {
    if (!selectedIngressId || !confirm(`确认删除「${forward.name}」？`)) return;
    setBusy(true);
    try {
      await api.nodes.removeForward(selectedIngressId, forward.id);
      await loadIngressDetail(selectedIngressId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  const ingressNodes = nodes.filter(isIngress);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--muted-foreground)]">
          {loading ? t("common.loading") : `${nodes.length} 个节点 · ${ingressNodes.length} 个入口`}
        </p>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          {t("node.create")}
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {nodes.map((node) => {
          const selected = Number(node.id) === selectedIngressId;
          return (
            <Card
              key={String(node.id)}
              className={selected ? "ring-2 ring-[var(--ring)]" : ""}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Server className="size-4" />
                      {node.node_id}
                    </CardTitle>
                    <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                      {node.connect_ip ?? t("node.waiting")}
                    </p>
                  </div>
                  <Badge variant={node.online ? "success" : "secondary"}>
                    {node.online ? t("common.online") : node.registered ? t("common.offline") : t("node.waiting")}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="outline">{roleLabel(node.role, t)}</Badge>
                  {node.port_range_min && node.port_range_max ? (
                    <Badge variant="outline">{node.port_range_min}-{node.port_range_max}</Badge>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {isIngress(node) ? (
                    <Button
                      size="sm"
                      variant={selected ? "default" : "outline"}
                      onClick={() => setSelectedIngressId(Number(node.id))}
                    >
                      {t("node.forwards")}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="outline" onClick={() => void regenerateInstaller(node)} disabled={busy}>
                    <RefreshCw className="size-3.5" />
                    {node.registered ? t("node.reinstall") : t("node.install")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
        {!loading && nodes.length === 0 ? (
          <Card className="md:col-span-2 xl:col-span-3">
            <CardContent className="py-10 text-center text-sm text-[var(--muted-foreground)]">
              {t("node.createHint")}
            </CardContent>
          </Card>
        ) : null}
      </div>

      {selectedIngress ? (
        <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">{t("node.bindings")}</CardTitle>
                <Button size="sm" variant="outline" onClick={() => setBindOpen(true)}>
                  <Link2 className="size-3.5" />
                  {t("node.bindEgress")}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {bindings.map((binding) => (
                <div key={String(binding.id)} className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] p-2.5">
                  <div>
                    <div className="text-sm font-medium">{binding.egress_node.node_id}</div>
                    <div className="text-xs text-[var(--muted-foreground)]">
                      {binding.egress_node.connect_ip ?? t("node.waiting")}
                    </div>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => void unbindEgress(Number(binding.egress_node_id))}
                    disabled={busy}
                    aria-label={t("common.delete")}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              {bindings.length === 0 ? (
                <p className="py-4 text-center text-xs text-[var(--muted-foreground)]">{t("node.noBindings")}</p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">{selectedIngress.node_id} · {t("node.forwards")}</CardTitle>
                  <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                    {t("node.directHint")} {t("node.relayHint")}
                  </p>
                </div>
                <Button size="sm" onClick={() => setForwardOpen(true)}>
                  <Plus className="size-3.5" />
                  {t("node.addForward")}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {forwards.map((forward) => (
                <div key={String(forward.id)} className="rounded-md border border-[var(--border)] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{forward.name}</span>
                        <Badge variant={forward.mode === "relay" ? "outline" : "secondary"}>
                          {forward.mode.toUpperCase()}
                        </Badge>
                        <Badge variant={forward.apply_status === "active" ? "success" : forward.apply_status === "error" ? "destructive" : "secondary"}>
                          {forward.apply_status ?? "pending"}
                        </Badge>
                      </div>
                      <div className="mt-1 font-mono text-xs text-[var(--muted-foreground)]">
                        :{forward.listen_port ?? "auto"} → {forward.egress_node ? `${forward.egress_node.node_id} → ` : ""}
                        {forward.target_host}:{forward.target_port}
                      </div>
                      {forward.apply_error ? (
                        <div className="mt-1 text-xs text-[var(--destructive)]">{forward.apply_error}</div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {forward.apply_status === "error" ? (
                        <Button size="sm" variant="outline" onClick={() => void forwardAction(forward, "retry")} disabled={busy}>
                          重试
                        </Button>
                      ) : null}
                      {forward.apply_status === "active" ? (
                        <Button size="sm" variant="outline" onClick={() => void forwardAction(forward, "suspend")} disabled={busy}>
                          暂停
                        </Button>
                      ) : null}
                      {forward.apply_status === "suspended" ? (
                        <Button size="sm" variant="outline" onClick={() => void forwardAction(forward, "resume")} disabled={busy}>
                          恢复
                        </Button>
                      ) : null}
                      <Button size="icon" variant="ghost" onClick={() => void removeForward(forward)} disabled={busy} aria-label={t("common.delete")}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
              {forwards.length === 0 ? (
                <p className="py-8 text-center text-sm text-[var(--muted-foreground)]">{t("node.noForwards")}</p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("node.create")}</DialogTitle>
            <DialogDescription>{t("node.createHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Field label="节点 ID">
              <Input value={nodeId} onChange={(e) => setNodeId(e.target.value)} placeholder="hk-edge-01" />
            </Field>
            <Field label="节点组">
              <Select
                value={groupId}
                onValueChange={(value) => {
                  setGroupId(value);
                  const group = groups.find((g) => String(g.id) === value);
                  if (group) setNodeRole(group.node_type === "out" ? "egress" : "ingress");
                }}
              >
                <SelectTrigger><SelectValue placeholder="请选择节点组" /></SelectTrigger>
                <SelectContent>
                  {groups.map((group) => (
                    <SelectItem key={String(group.id)} value={String(group.id)}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("common.role")}>
              <Select value={nodeRole} onValueChange={(value) => setNodeRole(value as NodeRole)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ingress">{t("node.ingress")}</SelectItem>
                  <SelectItem value="egress">{t("node.egress")}</SelectItem>
                  <SelectItem value="both">{t("node.both")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={() => void createNode()} disabled={busy}>{t("common.create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(install)} onOpenChange={(open) => !open && setInstall(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("node.installTitle")}</DialogTitle>
            <DialogDescription>{t("node.installHint")}</DialogDescription>
          </DialogHeader>
          {install ? (
            <div className="flex flex-col gap-3">
              <div className="rounded-md border border-[var(--border)] bg-[var(--muted)] p-3 font-mono text-xs break-all">
                {install.install_command}
              </div>
              <div className="text-xs text-[var(--muted-foreground)]">
                {install.node_key} · expires {new Date(install.expires_at).toLocaleString()}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setInstall(null)}>{t("common.done")}</Button>
            <Button onClick={() => void copyInstaller()}>
              <Copy className="size-4" />
              {t("common.copy")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bindOpen} onOpenChange={setBindOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("node.bindEgress")}</DialogTitle>
            <DialogDescription>只有绑定后的出口才能被该入口的端口转发选择。</DialogDescription>
          </DialogHeader>
          <Select value={bindEgressId} onValueChange={setBindEgressId}>
            <SelectTrigger><SelectValue placeholder="选择出口节点" /></SelectTrigger>
            <SelectContent>
              {availableEgress.map((node) => (
                <SelectItem key={String(node.id)} value={String(node.id)}>
                  {node.node_id} · {node.connect_ip ?? t("node.waiting")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBindOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={() => void bindEgress()} disabled={busy || !bindEgressId}>{t("common.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={forwardOpen} onOpenChange={setForwardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("node.addForward")}</DialogTitle>
            <DialogDescription>{forwardEgressId === "direct" ? t("node.directHint") : t("node.relayHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Field label={t("common.name")}>
              <Input value={forwardName} onChange={(e) => setForwardName(e.target.value)} placeholder="web-8080" />
            </Field>
            <Field label={t("node.listenPort")} hint={t("node.autoPort")}>
              <Input inputMode="numeric" value={listenPort} onChange={(e) => setListenPort(e.target.value)} placeholder="20001" />
            </Field>
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <Field label={t("node.targetHost")}>
                <Input value={targetHost} onChange={(e) => setTargetHost(e.target.value)} placeholder="10.0.0.20" />
              </Field>
              <Field label={t("node.targetPort")}>
                <Input inputMode="numeric" value={targetPort} onChange={(e) => setTargetPort(e.target.value)} placeholder="8080" />
              </Field>
            </div>
            <Field label={t("node.optionalEgress")}>
              <Select value={forwardEgressId} onValueChange={setForwardEgressId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct">DIRECT · 不使用出口</SelectItem>
                  {bindings.map((binding) => (
                    <SelectItem key={String(binding.id)} value={String(binding.egress_node_id)}>
                      RELAY · {binding.egress_node.node_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForwardOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={() => void createForward()} disabled={busy}>{t("common.create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-[var(--muted-foreground)]">{hint}</p> : null}
    </div>
  );
}
