"use client";

/**
 * V4-WP7 §13.4.2/§13.4.3 —— 生命周期取数与动作（客户端）。
 *
 * 分工：
 *   · 本组件取数、提交、把服务端拒绝**原样**交给展示层；
 *   · `NodeLifecyclePanel` 只渲染，不发请求；
 *   · `NodeInstallWaiting` 只负责安装轮询闭环。
 *
 * ── 失败语义 ──
 * 取数失败**保留上一份视图**（只提示）：生命周期接口挂掉不该把已经拿到的
 * 依赖统计与按钮一并抹成空态，否则「接口故障」看起来像「节点没问题」。
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { lifecycleErrorInfo } from "@/lib/node-lifecycle";
import { NodeLifecyclePanel } from "@/components/admin/node-lifecycle-panel";
import { NodeInstallWaiting } from "@/components/admin/node-install-waiting";
import { nodeLifecycleText } from "@/lib/node-lifecycle-i18n";
import type {
  ID,
  NodeImpact,
  NodeLifecycleConditionCode,
  NodeLifecycleValue,
  NodeLifecycleView,
  NodeRoleCheckResult,
} from "@/lib/types";

/** 生命周期变更后通知父组件（详情页据此刷新基础信息/健康卡）。 */
export type LifecycleChangeHandler = (view: NodeLifecycleView) => void;

export interface NodeLifecycleManagerProps {
  nodeId: ID;
  /** 服务端预取的视图（SSR 时传入；缺省则客户端首屏拉取）。 */
  initial?: NodeLifecycleView | null;
  /**
   * 节点行上已保存的维护/停用原因（`lifecycle_note`）。
   *
   * 刻意由父组件传入而不是本组件再拉一次节点：详情页已经持有节点行，重复请求
   * 会让「卡片显示的备注」和「页头的基础信息」有短暂不一致的时间窗。删除/变更
   * 后父组件的 `onChanged` 会刷新它。
   */
  currentNote?: string | null;
  onChanged?: LifecycleChangeHandler;
  /**
   * 角色 / 端口区间的**待提交**输入（只含真正改过的字段）。
   *
   * 由父组件在用户改动角色表单时传入，本组件去问后端 `checkRoleChange` 的
   * 结论——判定规则只在服务端有一份，前端不做「BOTH→EGRESS 是否可行」的
   * 推断（§13.4.3 硬要求）。
   *
   * 语义与后端的 query 一致：**缺省 = 不改**。`null`/`undefined` = 没有任何
   * 待提交改动（此时不发请求，也不显示检查结论）。
   */
  roleCheckInput?: { nextRole?: string; portMin?: number; portMax?: number } | null;
  /** 父组件希望在成功删除后离开详情页。 */
  onDeleted?: (id: ID) => void;
}

export function NodeLifecycleManager({
  nodeId,
  initial = null,
  currentNote = null,
  onChanged,
  roleCheckInput = null,
  onDeleted,
}: NodeLifecycleManagerProps) {
  const { locale } = useI18n();
  const txt = nodeLifecycleText(locale);

  const [view, setView] = useState<NodeLifecycleView | null>(initial);
  const [loading, setLoading] = useState(initial === null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ condition: NodeLifecycleConditionCode | null; message: string } | null>(
    null,
  );
  const [impact, setImpact] = useState<NodeImpact | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [roleCheck, setRoleCheck] = useState<NodeRoleCheckResult | null>(null);
  const [roleCheckPending, setRoleCheckPending] = useState(false);
  const [note, setNote] = useState("");
  const [applying, setApplying] = useState<NodeLifecycleValue | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);

  /** 视图 + 依赖统计一起刷新：两者都描述同一时刻的节点，分开刷新会出现「按钮按新态、计数按旧态」。 */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextView, nextImpact] = await Promise.all([
        api.admin.nodeLifecycle(nodeId),
        api.admin.nodeImpact(nodeId),
      ]);
      setView(nextView);
      setImpact(nextImpact.impact);
      setImpactError(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : txt.loadFailed);
      // 依赖统计单独失败时不影响视图（反之亦然），但要如实标注
      setImpactError((prev) => prev ?? (e instanceof Error ? e.message : txt.impactLoadFailed));
    } finally {
      setLoading(false);
    }
  }, [nodeId, txt.loadFailed, txt.impactLoadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 角色/端口收缩检查：把候选值问一遍后端（只读、缓存友好，故不去抖）。
   *
   * 依赖刻意拆成**基本类型**而不是 `roleCheckInput` 对象：上游每次渲染都可能
   * 造一个新对象，用对象做依赖会让这个 effect 每帧都重跑，把只读检查变成请求
   * 风暴。上游也只传真正改过的字段（见 node-detail-manager 的 memo）。
   */
  const nextRole = roleCheckInput?.nextRole ?? null;
  const portMin = roleCheckInput?.portMin ?? null;
  const portMax = roleCheckInput?.portMax ?? null;
  useEffect(() => {
    if (nextRole === null && (portMin === null || portMax === null)) {
      setRoleCheck(null);
      return;
    }
    let cancelled = false;
    setRoleCheckPending(true);
    const query: { next_role?: string; port_min?: number; port_max?: number } = {};
    if (nextRole !== null) query.next_role = nextRole;
    if (portMin !== null && portMax !== null) {
      query.port_min = portMin;
      query.port_max = portMax;
    }
    void api.admin
      .nodeImpact(nodeId, query)
      .then((res) => {
        if (!cancelled) setRoleCheck(res.role_check);
      })
      .catch(() => {
        // 检查失败**不**放行也不报错阻塞：留 null 让面板不显示结论，
        // 真正的写入仍由服务端裁决（前端预览从来不是安全边界）。
        if (!cancelled) setRoleCheck(null);
      })
      .finally(() => {
        if (!cancelled) setRoleCheckPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId, nextRole, portMin, portMax]);

  const apply = useCallback(
    async (lifecycle: NodeLifecycleValue, nextNote: string | null) => {
      setApplying(lifecycle);
      setRefusal(null);
      try {
        const res = await api.admin.setNodeLifecycle(nodeId, { lifecycle, note: nextNote });
        setView(res.view);
        onChanged?.(res.view);
        setNote("");
        toast.success(txt.lifecycle[lifecycle]);
        // 生命周期变了，准入与删除闸门都可能变，依赖统计也一起刷新
        void load();
      } catch (e) {
        const info = lifecycleErrorInfo(e);
        setRefusal({ condition: info.condition, message: info.message || txt.lifecycleChangeFailed });
      } finally {
        setApplying(null);
      }
    },
    [nodeId, onChanged, load, txt.lifecycle, txt.lifecycleChangeFailed],
  );

  const remove = useCallback(async () => {
    setDeleting(true);
    setRefusal(null);
    try {
      await api.admin.deleteNodeLifecycle(nodeId);
      toast.success(txt.deleteSuccess);
      setConfirmOpen(false);
      onDeleted?.(nodeId);
    } catch (e) {
      const info = lifecycleErrorInfo(e);
      // 服务端裁决优先：把 409 的 condition + dependencies 原样呈现，
      // 而不是只弹一句「删除失败」。
      setRefusal({ condition: info.condition, message: info.message });
      if (info.dependencies) setImpact(info.dependencies);
      setConfirmOpen(false);
    } finally {
      setDeleting(false);
    }
  }, [nodeId, onDeleted, txt.deleteSuccess]);

  return (
    <NodeLifecyclePanel
      view={view}
      loading={loading}
      error={error}
      refusal={refusal}
      impact={impact}
      impactError={impactError}
      roleCheck={roleCheck}
      roleCheckPending={roleCheckPending}
      note={note}
      currentNote={currentNote}
      onNoteChange={setNote}
      onApply={apply}
      onDelete={remove}
      onRefresh={() => void load()}
      applying={applying}
      deleting={deleting}
      confirmOpen={confirmOpen}
      onConfirmOpenChange={setConfirmOpen}
      nodeId={nodeId}
    >
      <NodeInstallWaiting
        nodeId={nodeId}
        view={view}
        onViewChange={(next) => {
          setView(next);
          onChanged?.(next);
        }}
        open={installOpen}
        onOpenChange={setInstallOpen}
        // 详情页同样补上闭环：等待中的节点在别处装好后，这里应当自己变绿，
        // 而不是要求用户手动刷新才发现（§13.4.3 的缺口正是在详情页最刺眼）。
        autoStart
      />
    </NodeLifecyclePanel>
  );
}
