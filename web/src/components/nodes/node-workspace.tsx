"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Copy, Link2, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, getActiveWorkspace } from "@/lib/api";
import { NodeDiagnostics } from "@/components/nodes/node-diagnostics";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { PERMISSION_DENIED } from "@/lib/workspace-permissions";
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
import { Input, Label } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { NodeBinding, NodeEnrollmentIssued, NodeGroup, NodeRole, UserNode } from "@/lib/types";
import { userNodeStatus } from "@/lib/node-status";

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
  const { t, locale } = useI18n();
  const { currentId, permissions, permissionsLoading, can } = useWorkspace();
  const canRead = can("node:read");
  const canManage = can("node:manage");
  const nodeSeq = useRef(0);
  const bindingSeq = useRef(0);
  const [nodes, setNodes] = useState<UserNode[]>([]);
  const [groups, setGroups] = useState<NodeGroup[]>([]);
  const [selectedIngressId, setSelectedIngressId] = useState<number | null>(null);
  const [bindings, setBindings] = useState<NodeBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [groupsLoadFailed, setGroupsLoadFailed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [nodeId, setNodeId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [nodeRole, setNodeRole] = useState<NodeRole>("ingress");
  const [install, setInstall] = useState<NodeEnrollmentIssued | null>(null);
  const [bindOpen, setBindOpen] = useState(false);
  const [bindEgressId, setBindEgressId] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * V4-WP8：Dashboard 待办里「查看节点」的目标 —— `?focus=<id>`。
   *
   * 待办条目必须能落到**具体那一行**上：只说「去看节点」而把用户丢到一屏节点
   * 最上面，等于让用户自己找那个已经出问题的节点。这里只做定位/高亮，
   * 不参与任何状态判定（三层状态依旧全部来自后端投影）。
   */
  const [focusId, setFocusId] = useState<number | null>(null);

  const selectedIngress = nodes.find((node) => Number(node.id) === selectedIngressId) ?? null;
  const ingressNodes = nodes.filter(isIngress);
  const availableEgress = useMemo(() => {
    const bound = new Set(bindings.map((binding) => Number(binding.egress_node_id)));
    return nodes.filter(
      (node) => isEgress(node) && Number(node.id) !== selectedIngressId && !bound.has(Number(node.id)),
    );
  }, [nodes, bindings, selectedIngressId]);

  async function loadNodes() {
    const ticket = ++nodeSeq.current;
    const scope = currentId;
    setNodes([]); setGroups([]); setGroupsLoadFailed(false);
    if (!canRead) { setLoading(false); return; }
    setLoading(true);
    try {
      const [nodeRows, groupRows] = await Promise.all([
        api.nodes.list(),
        canManage ? api.nodeGroups.list({ page: 1, page_size: 100 }).catch(() => {
          setGroupsLoadFailed(true);
          return { data: [] };
        }) : Promise.resolve({ data: [] }),
      ]);
      if (ticket !== nodeSeq.current || scope !== getActiveWorkspace()) return;
      setNodes(nodeRows);
      setGroups(groupRows.data);
      const ingressRows = nodeRows.filter(isIngress);
      setSelectedIngressId((current) => {
        if (current && ingressRows.some((node) => Number(node.id) === current)) return current;
        return ingressRows[0] ? Number(ingressRows[0].id) : null;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("node.bindingsLoadFailed"));
    } finally {
      if (ticket === nodeSeq.current) setLoading(false);
    }
  }

  async function loadBindings(id: number | null) {
    const ticket = ++bindingSeq.current;
    const scope = currentId;
    setBindings([]);
    if (!id || !canRead) {
      setBindings([]);
      return;
    }
    try {
      const rows = await api.nodes.bindings(id);
      if (ticket === bindingSeq.current && scope === getActiveWorkspace()) setBindings(rows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.noData"));
    }
  }

  useEffect(() => {
    void loadNodes();
    // V4-WP8：`/nodes?focus=<id>` 来自 Dashboard 待办。只认数字，不猜其它形态；
    // 读到后滚动到那张卡片并高亮（找不到就什么也不做，不报错）。
    const requested = new URLSearchParams(window.location.search).get("focus");
    if (requested && /^\d+$/.test(requested)) setFocusId(Number(requested));
    return () => { nodeSeq.current++; bindingSeq.current++; };
  }, [currentId, permissions]);

  useEffect(() => {
    if (focusId === null || loading) return;
    const target = document.getElementById(`node-${focusId}`);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusId, loading]);

  useEffect(() => {
    void loadBindings(selectedIngressId);
    return () => { bindingSeq.current++; };
  }, [selectedIngressId, currentId, permissions]);

  useEffect(() => { setInstall(null); setCreateOpen(false); setBindOpen(false); setSelectedIngressId(null); }, [currentId, permissions]);

  useEffect(() => {
    if (!createOpen || groupId || groups.length === 0) return;
    const first = groups[0]!;
    setGroupId(String(first.id));
    setNodeRole(first.node_type === "out" ? "egress" : "ingress");
  }, [createOpen, groupId, groups]);

  async function createNode() {
    if (!canManage) { toast.error(PERMISSION_DENIED); return; }
    const gid = Number(groupId);
    if (!nodeId.trim() || !Number.isInteger(gid)) {
      toast.error(t("node.createRequired"));
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
      toast.error(err instanceof Error ? err.message : t("node.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function regenerateInstaller(node: UserNode) {
    if (!canManage) { toast.error(PERMISSION_DENIED); return; }
    setBusy(true);
    try {
      setInstall(await api.nodes.enrollment(node.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("node.installerFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function copyInstaller() {
    if (!canManage) { toast.error(PERMISSION_DENIED); return; }
    if (!install) return;
    try {
      await navigator.clipboard.writeText(install.install_command);
      toast.success(t("node.copySuccess"));
    } catch {
      toast.error(t("node.copyFailed"));
    }
  }

  async function bindEgress() {
    if (!canManage) { toast.error(PERMISSION_DENIED); return; }
    if (!selectedIngressId || !bindEgressId) return;
    setBusy(true);
    try {
      await api.nodes.bindEgress(selectedIngressId, Number(bindEgressId));
      setBindOpen(false);
      setBindEgressId("");
      toast.success(t("node.bindSuccess"));
      await loadBindings(selectedIngressId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("node.bindFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function unbindEgress(egressId: number) {
    if (!canManage) { toast.error(PERMISSION_DENIED); return; }
    if (!selectedIngressId) return;
    setBusy(true);
    try {
      await api.nodes.unbindEgress(selectedIngressId, egressId);
      toast.success(t("node.unbindSuccess"));
      await loadBindings(selectedIngressId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("node.unbindFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (permissionsLoading) return <p>{t("common.loading")}</p>;
  if (!canRead) return <p role="alert">{PERMISSION_DENIED}</p>;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--muted-foreground)]">
          {loading ? t("common.loading") : nodes.length + " 个节点 · " + ingressNodes.length + " 个入口"}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href="/forwards">
              <ArrowLeftRight className="size-4" />
              {t("common.forwards")}
            </Link>
          </Button>
          <Button disabled={!canManage || groupsLoadFailed} onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            {t("node.create")}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {nodes.map((node) => {
          const selected = Number(node.id) === selectedIngressId;
          // V4-WP8：来自 Dashboard 待办的定位目标（只影响高亮/滚动，不参与判定）。
          const focused = Number(node.id) === focusId;
          // V4-WP8 §13.4.1：三层状态（Connection / Lifecycle / Admission）
          // 全部来自后端投影，本组件只翻译成徽章 —— 不读 last_seen_at、
          // 不比 90s 窗口、不推准入（那是 routes/nodes.ts 的 projectUserNode
          // 与 services/node-lifecycle.ts 的唯一职责）。
          const status = userNodeStatus(locale, node);
          return (
            <Card
              key={String(node.id)}
              id={`node-${node.id}`}
              data-focused={focused ? "true" : undefined}
              className={
                focused
                  ? "ring-2 ring-[var(--destructive)]"
                  : selected
                    ? "ring-2 ring-[var(--ring)]"
                    : ""
              }
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
                    <p className="mt-1 font-mono text-[10px] text-[var(--muted-foreground)]">
                      Agent: {node.agent_id}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge variant={status.connection.variant} data-testid={`node-connection-${node.id}`}>
                      {status.connection.label}
                    </Badge>
                    {status.lifecycle ? (
                      <Badge variant={status.lifecycle.variant} data-testid={`node-lifecycle-${node.id}`}>
                        {status.lifecycle.label}
                      </Badge>
                    ) : null}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {status.admission ? (
                  <p
                    className="text-xs text-[var(--muted-foreground)]"
                    data-testid={`node-admission-${node.id}`}
                  >
                    {status.admission.label}
                    {status.admission.reason ? ` — ${status.admission.reason}` : ""}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="outline">{roleLabel(node.role, t)}</Badge>
                  {node.port_range_min && node.port_range_max ? (
                    <Badge variant="outline">{node.port_range_min}-{node.port_range_max}</Badge>
                  ) : null}
                  <Badge variant="outline">{node.version}</Badge>
                </div>
                <div className="flex flex-wrap gap-2">
                  {isIngress(node) ? (
                    <Button
                      size="sm"
                      variant={selected ? "default" : "outline"}
                      onClick={() => setSelectedIngressId(Number(node.id))}
                    >
                      {t("node.bindings")}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="outline" onClick={() => void regenerateInstaller(node)} disabled={busy || !canManage}>
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
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">{selectedIngress.node_id} · {t("node.bindings")}</CardTitle>
                <CardDescription>{t("node.bindingInfraHint")}</CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/forwards?ingress_node_id=${selectedIngress.id}`}>
                    <ArrowLeftRight className="size-3.5" />
                    {t("node.viewForwards")}
                  </Link>
                </Button>
                <Button disabled={!canManage} size="sm" variant="outline" onClick={() => setBindOpen(true)}>
                  <Link2 className="size-3.5" />
                  {t("node.bindEgress")}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {bindings.map((binding) => (
              <div
                key={String(binding.id)}
                className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] p-3"
              >
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
              <p className="py-6 text-center text-sm text-[var(--muted-foreground)] md:col-span-2 xl:col-span-3">
                {t("node.noBindings")}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={createOpen && canManage} onOpenChange={setCreateOpen}>
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
                  const group = groups.find((row) => String(row.id) === value);
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
              <div className="text-xs text-[var(--muted-foreground)]">
                Agent ID: <span className="font-mono">{install.agent_id}</span>
              </div>
              <div className="rounded-md border border-[var(--border)] bg-[var(--muted)] p-3 font-mono text-xs break-all">
                {install.install_command}
              </div>
              <Button onClick={() => void copyInstaller()}>
                <Copy className="size-4" />
                {t("common.copy")}
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* V4-WP11C/WP11B：诊断 / 支持包 / 升级命令。只读 + 生成脚本，不改运行态。 */}
      {selectedIngress ? (
        <NodeDiagnostics nodeId={selectedIngress.id} nodeKey={selectedIngress.node_id} />
      ) : null}

      <Dialog open={bindOpen && canManage} onOpenChange={setBindOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("node.bindEgress")}</DialogTitle>
            <DialogDescription>{selectedIngress?.node_id ?? ""}</DialogDescription>
          </DialogHeader>
          <Select value={bindEgressId} onValueChange={setBindEgressId}>
            <SelectTrigger><SelectValue placeholder={t("forward.chooseEgress")} /></SelectTrigger>
            <SelectContent>
              {availableEgress.map((node) => (
                <SelectItem key={String(node.id)} value={String(node.id)}>
                  {node.node_id} · {node.connect_ip ?? t("node.waiting")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {availableEgress.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">{t("node.noBindings")}</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBindOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={() => void bindEgress()} disabled={busy || !bindEgressId}>{t("common.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
