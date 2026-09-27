"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Field, ToggleRow } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OptionSelect } from "@/components/ui/option-select";
import { AdminToolbar, ConfirmDeleteDialog, FormDialog, RowActions, useForm } from "@/components/admin/admin-ui";
// V4-WP7 §13.4.3：安装等待闭环复用详情页同一个组件（含轮询与阶段文案），
// 列表页的「创建节点」流程与详情页的「重新安装」走同一份实现。
import { NodeInstallWaiting } from "@/components/admin/node-install-waiting";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { NODE_ROLES, STATUS_OPTIONS } from "@/lib/constants";
import { formatBytes, formatDateTime, strOf, toNumOrNull } from "@/lib/utils";
// V4-WP6 §13.4.4：健康徽章/文案。词条放在独立的 node-health-i18n.ts（与 WP9 的
// i18n.ts 编辑区完全不相交），避免两个并行分支在同一处收口。
import {
  connectionBadgeVariant,
  healthBadgeVariant,
  lifecycleBadgeVariant,
  normalizeHealthSummary,
  EMPTY_HEALTH_SUMMARY,
} from "@/lib/node-health";
// V4-WP7 §13.4.2/§13.4.3：生命周期概览与安装闭环计数（判定全部来自后端）。
import { LIFECYCLE_ORDER, installPhase, type InstallPhase } from "@/lib/node-lifecycle";
import { nodeHealthText, reasonTitle, type NodeHealthText } from "@/lib/node-health-i18n";
import { nodeLifecycleText } from "@/lib/node-lifecycle-i18n";
import type { Locale } from "@/lib/i18n";
import type {
  Node,
  NodeEnrollmentIssued,
  NodeGroup,
  NodeHealthSummary,
  NodeHealthValue,
  NodeHealthView,
  NodeInput,
  NodeLifecycleView,
  NodeRole,
  Paginated,
} from "@/lib/types";

/** 生命周期词条的键（node-health-i18n 的 lifecycle 表）。 */
type LifecycleKey = keyof NodeHealthText["lifecycle"];

/** 四态顺序固定：healthy → warning → error → unknown（与概览条一致）。 */
const HEALTH_ORDER: NodeHealthValue[] = ["healthy", "warning", "error", "unknown"];

interface NodeForm {
  node_id: string;
  connect_ip: string;
  node_group_id: string;
  role: Node["role"];
  weight: string;
  version: string;
  status: Node["status"];
  backup: boolean;
  dns_status: boolean;
  custom_line: string;
  order_by: string;
}

const EMPTY: NodeForm = {
  node_id: "",
  connect_ip: "",
  node_group_id: "",
  role: null,
  weight: "1",
  version: "unknown",
  status: "active",
  backup: false,
  dns_status: false,
  custom_line: "",
  order_by: "1000",
};

function toForm(n: Node): NodeForm {
  return {
    node_id: n.node_id,
    connect_ip: n.connect_ip ?? "",
    node_group_id: String(n.node_group_id),
    role: n.role ?? null,
    weight: strOf(n.weight),
    version: n.version,
    status: n.status,
    backup: n.backup,
    dns_status: n.dns_status,
    custom_line: n.custom_line ?? "",
    order_by: strOf(n.order_by),
  };
}

function toPayload(f: NodeForm): NodeInput {
  return {
    node_id: f.node_id.trim(),
    connect_ip: f.connect_ip.trim() || null,
    node_group_id: Number(f.node_group_id),
    role: f.role ?? null,
    weight: toNumOrNull(f.weight) ?? 1,
    version: f.version.trim() || "unknown",
    status: f.status,
    backup: f.backup,
    dns_status: f.dns_status,
    custom_line: f.custom_line.trim() || null,
    order_by: toNumOrNull(f.order_by) ?? 1000,
  };
}

/**
 * v3 角色列：null = 尚未声明（存量行），显式渲染而不是隐藏
 */
function RoleBadge({ role, t }: { role: Node["role"]; t: (k: string) => string }) {
  if (!role) return <Badge variant="muted">{t("admin.nodeRoleUndeclared")}</Badge>;
  const variant = role === "ingress" ? "success" : role === "egress" ? "default" : "outline";
  return <Badge variant={variant}>{role}</Badge>;
}

/**
 * V4-WP7 §13.4.2 列表生命周期列。
 *
 * 只用**后端已合成的结论**（`/admin/node/health` 的 `NodeHealthView`，WP6 已
 * 把 lifecycle 投影进视图），前端不自行判定。`active` 是绝大多数节点的常态，
 * 列表里默认不渲染它的徽章（否则一屏全是「使用中」噪声），只显示非 active 的
 * 调整态——但列本身始终存在，且 `-` 表示「拿不到结论」而不是「正常」。
 */
function NodeLifecycleCell({ view, locale, dashLabel }: { view?: NodeHealthView; locale: Locale; dashLabel: string }) {
  if (!view) return <Badge variant="muted" data-testid="node-lifecycle-no-data">{dashLabel}</Badge>;
  const txt = nodeLifecycleText(locale);
  const lifecycle = view.lifecycle as LifecycleKey;
  return (
    <span className="flex items-center gap-1.5" data-testid="node-lifecycle-cell">
      <Badge variant={lifecycleBadgeVariant(view.lifecycle)} data-testid={`node-lifecycle-${view.lifecycle}`}>
        {txt.lifecycle[lifecycle] ?? view.lifecycle}
      </Badge>
    </span>
  );
}

/**
 * V4-WP6 §13.4.4 列表健康列：四态徽章 + 悬浮显示 reasons 摘要。
 *
 * 列表只用**后端已合成的结论**（`/admin/node/health`）：这里不做任何阈值
 * 判断，也不展开 reasons 细节——「为什么」在详情页的健康卡里看。
 * 取不到时渲染「-」而不是绿色：把「没有数据」显示成健康，是这类面板最危险
 * 的 bug（后端没上线/请求失败都会被读成「全部正常」）。
 */
function NodeHealthCell({ view, locale, dashLabel }: { view?: NodeHealthView; locale: Locale; dashLabel: string }) {
  if (!view) return <Badge variant="muted" data-testid="node-health-no-data">{dashLabel}</Badge>;
  const txt = nodeHealthText(locale);
  const tooltip = view.reasons.map((r) => reasonTitle(locale, r.code, r.message)).join("\n");
  return (
    <span className="flex items-center gap-1.5" data-testid="node-health-cell">
      <Badge variant={healthBadgeVariant(view.health)} data-testid={`node-health-${view.health}`}>
        {txt.health[view.health]}
      </Badge>
      {/* 连接态与健康正交：offline 只是「连不上」，不在这里画成故障 */}
      <Badge variant={connectionBadgeVariant(view.connection)} data-testid={`node-connection-${view.connection}`}>
        {txt.connection[view.connection] ?? view.connection}
      </Badge>
      {view.lifecycle !== "active" && (
        <Badge variant={lifecycleBadgeVariant(view.lifecycle)} data-testid={`node-lifecycle-${view.lifecycle}`}>
          {txt.lifecycle[view.lifecycle as LifecycleKey] ?? view.lifecycle}
        </Badge>
      )}
      {tooltip && <span className="hidden" data-testid="node-health-reasons-tooltip">{tooltip}</span>}
    </span>
  );
}

export function AdminNodesManager({
  initialData,
  nodeGroups,
}: {
  initialData: Paginated<Node>;
  nodeGroups: NodeGroup[];
}) {
  const { t, locale } = useI18n();
  const txt = nodeHealthText(locale);
  const lifetxt = nodeLifecycleText(locale);
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  /**
   * V4-WP6：全量健康视图（node_id → view）+ 四态计数。
   *
   * 单独一次 `/admin/node/health`（不经列表分页）：`summary` 是**过滤前全量**
   * 口径，列表页因此能显示「有几个节点 error」而不必先把所有节点拉全。
   */
  const [health, setHealth] = useState<Record<number, NodeHealthView>>({});
  const [healthSummary, setHealthSummary] = useState<NodeHealthSummary>(EMPTY_HEALTH_SUMMARY);
  const [editing, setEditing] = useState<Node | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Node | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [install, setInstall] = useState<NodeEnrollmentIssued | null>(null);
  /**
   * V4-WP7 §13.4.3：安装等待闭环。
   *
   * `installNode` 是「这次安装等的是哪个节点」——命令对话框同时承载生成与
   * 轮询，而轮询要读该节点的 lifecycle 视图（`connection`）。为它单独拉一次
   * `/admin/node/:id/lifecycle` 是必要的：`/admin/node/health` 是列表口径的
   * 批量视图，用它判断「刚创建的节点上线没有」会把「还没出现在列表里」读成
   * 「离线」。
   */
  const [installNode, setInstallNode] = useState<Node | null>(null);
  const [installView, setInstallView] = useState<NodeLifecycleView | null>(null);
  /**
   * 安装闭环计数：等待安装 / 已安装掉线 / 其他。
   *
   * 从全量健康视图派生（health 里已有 connection 与 lifecycle）：只做计数，
   * **不重算判定**。这两个数字是 V4-WP8 Dashboard 的前置面（「有多少台在等
   * 安装」），本期先在列表页给出可见性。
   */
  const installCounts = ((): Record<InstallPhase, number> => {
    const counts: Record<InstallPhase, number> = { awaiting_install: 0, online: 0, installed_offline: 0, unknown: 0 };
    // 只读 connection：`deriveConnection` 返回 waiting 的充要条件就是「没有凭据」，
    // 所以这里不必再取 has_credential（health 视图也不下发它）。
    for (const v of Object.values(health) as NodeHealthView[]) {
      counts[installPhase({ connection: v.connection })] += 1;
    }
    return counts;
  })();
  const { form, set, setForm } = useForm<NodeForm>(EMPTY);
  const router = useRouter();

  async function load(kw = keyword) {
    setLoading(true);
    try {
      setData(await api.admin.nodes({ page: 1, page_size: 20, keyword: kw || undefined }));
      // 列表变了健康列也要跟着变（新建节点是 unknown、改角色可能变成 warning），
      // 否则用户会看到「刚改的东西没反应」。
      void loadHealth();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.deleteFailed"));
    } finally {
      setLoading(false);
    }
  }

  /**
   * 取全量健康视图。
   *
   * 失败**不弹 toast**：health 是列表的增强列，`/admin/node/health` 在旧后端
   * 上不存在（404）时页面应当照常可用——只是健康列显示「-」。把增强数据
   * 的失败升格成用户可见的错误会让人以为节点管理坏了。
   */
  const loadHealth = useCallback(async () => {
    try {
      const res = await api.admin.nodeHealthList();
      const map: Record<number, NodeHealthView> = {};
      for (const v of res.data) map[v.node_id] = v;
      setHealth(map);
      setHealthSummary(normalizeHealthSummary(res.summary));
    } catch {
      setHealth({});
      setHealthSummary(EMPTY_HEALTH_SUMMARY);
    }
  }, []);

  // 首屏拉一次全量巡检；列表 CRUD 后由 load() 的调用点各自刷新（此处不重复订阅）。
  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY, node_group_id: nodeGroups[0] ? String(nodeGroups[0].id) : "" });
    setOpen(true);
  }

  function openEdit(n: Node) {
    setEditing(n);
    setForm(toForm(n));
    setOpen(true);
  }

  async function submit() {
    const payload = toPayload(form);
    if (!payload.node_id || !payload.node_group_id) {
      toast.error(t("admin.saveFailed"));
      return;
    }
    setPending(true);
    try {
      if (editing) {
        await api.admin.updateNode(editing.id, payload);
        toast.success(t("admin.updateSuccess", { name: payload.node_id }));
      } else {
        const created = await api.admin.createNode(payload);
        const enrollment = await api.admin.createNodeEnrollment(created.id);
        setInstall(enrollment);
        // V4-WP7 §13.4.3：创建后立刻进入安装等待闭环（而不是复制完命令就结束）。
        setInstallNode(created);
        setInstallView(null);
        void api.admin
          .nodeLifecycle(created.id)
          .then(setInstallView)
          .catch(() => undefined);
        toast.success(t("admin.createSuccess", { name: payload.node_id }));
      }
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.saveFailed"));
    } finally {
      setPending(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.admin.removeNode(deleteTarget.id);
      toast.success(t("admin.deleteSuccess", { name: deleteTarget.node_id }));
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  const rows = groupFilter === "all" ? data.data : data.data.filter((n) => String(n.node_group_id) === groupFilter);

  return (
    <div className="flex flex-col gap-4" data-testid="admin-nodes">
      <AdminToolbar
        keyword={keyword}
        onKeywordChange={setKeyword}
        onSearch={() => load()}
        onRefresh={() => load()}
        loading={loading}
        total={data.total}
        onCreate={openCreate}
        createTestId="create-node-btn"
      />

      <div className="flex flex-wrap items-center gap-2">
        {/* V4-WP6 §13.4.4：全量四态概览。summary 来自 /admin/node/health，
            **过滤前**口径 —— 这里只是把它摆出来，不在前端重算计数。 */}
        <span className="text-xs text-[var(--muted-foreground)]">{txt.fleetSummaryLabel}</span>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="nodes-health-summary">
          {HEALTH_ORDER.map((h) => (
            <Badge key={h} variant={healthBadgeVariant(h)} data-testid={`nodes-health-summary-${h}`}>
              {txt.health[h]} {healthSummary[h]}
            </Badge>
          ))}
        </div>
      </div>

      {/* V4-WP7 §13.4.3：安装闭环概览。两个数字直接来自全量健康视图的 connection
          （waiting = 尚未安装；offline = 装过但掉线），前端不另算在线判定。 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5" data-testid="nodes-install-summary">
          <Badge variant="muted" data-testid="nodes-install-awaiting">
            {lifetxt.installPhase.awaiting_install} {installCounts.awaiting_install}
          </Badge>
          <Badge variant="outline" data-testid="nodes-install-offline">
            {lifetxt.installPhase.installed_offline} {installCounts.installed_offline}
          </Badge>
          <Badge variant="success" data-testid="nodes-install-online">
            {lifetxt.installPhase.online} {installCounts.online}
          </Badge>
        </div>
      </div>

      {/* V4-WP7 §13.4.2：生命周期概览（维护/停用/退役）。同样消费后端结论，
          `active` 不计入——它是常态，摆出来只会稀释异常信号。 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5" data-testid="nodes-lifecycle-summary">
          {LIFECYCLE_ORDER.filter((l) => l !== "active").map((l) => {
            const count = Object.values(health as Record<number, NodeHealthView>).filter((v) => v.lifecycle === l).length;
            return (
              <Badge key={l} variant={lifecycleBadgeVariant(l)} data-testid={`nodes-lifecycle-summary-${l}`}>
                {lifetxt.lifecycle[l]} {count}
              </Badge>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--muted-foreground)]">{t("fields.nodeGroup")}</span>
        <Select value={groupFilter} onValueChange={setGroupFilter}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder={t("admin.selectPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common.unlimited")}</SelectItem>
            {nodeGroups.map((g) => (
              <SelectItem key={g.id} value={String(g.id)}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>{t("fields.nodeId")}</TableHead>
              <TableHead>{t("fields.connectIp")}</TableHead>
              <TableHead>{t("fields.nodeGroup")}</TableHead>
              <TableHead>{t("admin.nodeRole")}</TableHead>
              <TableHead data-testid="nodes-health-column">{txt.listHealthColumn}</TableHead>
              {/* V4-WP7：生命周期列（与健康列并列，因为两者正交：维护中的在线节点是常态） */}
              <TableHead data-testid="nodes-lifecycle-column">{lifetxt.listLifecycleColumn}</TableHead>
              <TableHead>{t("fields.weight")}</TableHead>
              <TableHead>{t("fields.version")}</TableHead>
              <TableHead>{t("tunnel.traffic")}</TableHead>
              <TableHead>{t("common.status")}</TableHead>
              <TableHead className="text-right">{t("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && data.data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="h-24 text-center text-[var(--muted-foreground)]">
                  {t("common.loading")}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableEmpty colSpan={12} text={t("common.noData")} />
            ) : (
              rows.map((n) => (
                <TableRow key={n.id}>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/admin/nodes/${n.id}`} className="underline hover:text-[var(--primary)]" data-testid="node-row-link">
                      {n.id}
                    </Link>
                  </TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/admin/nodes/${n.id}`} className="hover:text-[var(--primary)]">
                      {n.node_id}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{n.connect_ip ?? t("node.waiting")}</TableCell>
                  <TableCell className="text-xs">{n.node_group?.name ?? n.node_group_id}</TableCell>
                  <TableCell>
                    <RoleBadge role={n.role ?? null} t={t} />
                  </TableCell>
                  <TableCell>
                    <NodeHealthCell view={health[n.id]} locale={locale} dashLabel={txt.noHealthData} />
                  </TableCell>
                  <TableCell>
                    <NodeLifecycleCell view={health[n.id]} locale={locale} dashLabel={txt.noHealthData} />
                  </TableCell>
                  <TableCell className="text-xs">{n.weight}</TableCell>
                  <TableCell className="text-xs">{n.version}</TableCell>
                  <TableCell className="text-xs">{formatBytes(n.traffic ?? 0)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`size-2 rounded-full ${n.online ? "bg-[var(--success)]" : "bg-[var(--muted-foreground)]"}`}
                      />
                      <Badge variant={n.status === "active" ? "success" : "muted"}>{n.status}</Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    <RowActions
                      onEdit={() => openEdit(n)}
                      onDelete={() => setDeleteTarget(n)}
                      extra={
                        <Button size="sm" variant="ghost" asChild={false} onClick={() => router.push(`/admin/nodes/${n.id}`)}>
                          {t("admin.nodeDetailTitle")}
                        </Button>
                      }
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={
          editing
            ? t("admin.editTitle", { name: t("admin.nodes") })
            : t("admin.createTitle", { name: t("admin.nodes") })
        }
        onSubmit={submit}
        submitLabel={t("common.save")}
        pending={pending}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("fields.nodeId")}>
            <Input value={form.node_id} onChange={(e) => set("node_id", e.target.value)} required data-testid="node-id" />
          </Field>
          <Field label={t("fields.connectIp")}>
            <Input
              value={form.connect_ip}
              onChange={(e) => set("connect_ip", e.target.value)}
              placeholder={t("node.waiting")}
              data-testid="node-ip"
            />
          </Field>
          <Field label={t("fields.nodeGroup")}>
            <Select value={form.node_group_id} onValueChange={(v) => set("node_group_id", v)}>
              <SelectTrigger data-testid="node-group-select">
                <SelectValue placeholder={t("admin.selectPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {nodeGroups.map((g) => (
                  <SelectItem key={g.id} value={String(g.id)}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("fields.nodeRole")} hint={t("admin.nodeRoleHint")}>
            <Select
              value={form.role === null ? "__unset__" : form.role}
              onValueChange={(v) => set("role", (v === "__unset__" ? null : v) as NodeRole | null)}
            >
              <SelectTrigger data-testid="node-role-select">
                <SelectValue placeholder={t("admin.nodeRoleUndeclared")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unset__">{t("admin.nodeRoleUndeclared")}</SelectItem>
                {NODE_ROLES.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.zh}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("fields.version")}>
            <Input value={form.version} onChange={(e) => set("version", e.target.value)} placeholder="1.8.4" />
          </Field>
          <Field label={t("fields.weight")}>
            <Input type="number" min={1} value={form.weight} onChange={(e) => set("weight", e.target.value)} />
          </Field>
          <Field label={t("fields.orderBy")}>
            <Input type="number" value={form.order_by} onChange={(e) => set("order_by", e.target.value)} />
          </Field>
          <Field label={t("common.status")}>
            <OptionSelect
              value={form.status}
              onValueChange={(v) => set("status", v as Node["status"])}
              options={STATUS_OPTIONS}
              locale={locale}
            />
          </Field>
          <Field label={t("common.remark")} hint={t("common.optional")}>
            <Input value={form.custom_line} onChange={(e) => set("custom_line", e.target.value)} placeholder="HKIX 优化" />
          </Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <ToggleRow label={t("fields.backup")} checked={form.backup} onCheckedChange={(v) => set("backup", v)} />
          <ToggleRow label={t("fields.dnsStatus")} checked={form.dns_status} onCheckedChange={(v) => set("dns_status", v)} />
        </div>
        {editing && (
          <p className="text-xs text-[var(--muted-foreground)]">
            {t("common.updatedAt")}: {formatDateTime(editing.updated_at)}
          </p>
        )}
      </FormDialog>

      {/* V4-WP7 §13.4.3：安装等待闭环。
          旧实现是「弹出命令 → 复制 → 关闭」，用户复制完就再也不知道装没装上。
          现在复用详情页同一个组件：命令 + 轮询 `connection` 直到 online，
          并区分「已安装掉线」（连接问题）与「还在装」（继续等）。
          判定只在后端（`deriveConnection`），这里不重算在线。 */}
      {installNode && (
        <NodeInstallWaiting
          nodeId={installNode.id}
          view={installView}
          onViewChange={setInstallView}
          initialEnrollment={install}
          open={Boolean(install)}
          onOpenChange={(open) => {
            if (!open) {
              setInstall(null);
              setInstallNode(null);
              setInstallView(null);
              // 安装可能改变连接/准入，关闭时刷新两处概览
              void loadHealth();
            }
          }}
          autoStart
        />
      )}

      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title={t("common.delete")}
        description={t("admin.deleteConfirm", { name: deleteTarget?.node_id ?? "" })}
        onConfirm={confirmDelete}
        pending={deleting}
      />
    </div>
  );
}
