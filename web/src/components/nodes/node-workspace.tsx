"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Link2, Plus, RefreshCw, RotateCw, Server, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, getActiveWorkspace } from "@/lib/api";
import { nodeGroupApiErrorInfo } from "@/lib/api/nodeGroups";
import { NodeDiagnostics } from "@/components/nodes/node-diagnostics";
import { NodeUpgradeCard } from "@/components/nodes/node-upgrade-card";
import { LookingGlassPanel } from "@/components/nodes/looking-glass-panel";
import { NodeGroupCreateDialog } from "@/components/nodes/node-group-create-dialog";
import {
  NodeCreationConfirm,
  NodeGroupPrerequisite,
  NodeOnboarding,
  NodeReadonlyEmptyState,
  buildRegenerateConfirm,
} from "@/components/nodes/node-onboarding";
import { NodeInstallRegenerateConfirm } from "@/components/admin/node-install-waiting";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { createPermissionRequestFence, PERMISSION_DENIED } from "@/lib/workspace-permissions";
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
import { installPhase, type InstallPhase } from "@/lib/node-lifecycle";
import { userNodeStatus } from "@/lib/node-status";
import {
  canSubmitNodeCreation,
  checkNodeIdDuplicate,
  createUserOnboardingAdapters,
  mergeOnboardingViews,
  nodeCreateDisabledReasonKey,
  nodeCreationBlockedReasonKey,
  nodeGroupPrerequisitePersona,
  nodeGroupState,
  nodeListState,
  nodeOnboardingTargetFromProvision,
  operationIsStale,
  scopeIsCurrent,
  type NodeGroupState,
  type NodeOnboardingTarget,
  type OnboardingOperation,
  type OnboardingScope,
  type UserNodeOnboardingView,
  userNodeOnboardingView,
} from "@/lib/node-onboarding";

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
  const canCreateForward = can("forward:create");
  /**
   * 单调 fence：每类异步操作各一条。响应回来先比对 ticket + 作用域，
   * 过期的直接丢弃（不 setState、不 toast、更不显示命令）——**catch / finally
   * 也要过这道闸**：旧作用域的错误提示与「解锁新请求的 busy」是同一类越界。
   */
  const nodeSeq = useRef(createPermissionRequestFence());
  const groupSeq = useRef(createPermissionRequestFence());
  const bindingSeq = useRef(createPermissionRequestFence());
  const enrollmentSeq = useRef(createPermissionRequestFence());
  const scopeEpochRef = useRef(0);
  const lastInstallPhase = useRef<InstallPhase | null>(null);
  const reloadNodesRef = useRef<() => void>(() => {});
  const [scopeEpoch, setScopeEpoch] = useState(0);
  const [nodes, setNodes] = useState<UserNode[]>([]);
  const [nodesLoading, setNodesLoading] = useState(true);
  const [nodesFailed, setNodesFailed] = useState(false);
  const [nodesRead, setNodesRead] = useState(false);
  const [groups, setGroups] = useState<NodeGroup[]>([]);
  /** 初值就按「能不能管理」给：可管理用户不会先闪一下 `false` 的「无组」空态。 */
  const [groupsLoading, setGroupsLoading] = useState(() => canManage);
  const [groupsFailed, setGroupsFailed] = useState(false);
  const [selectedIngressId, setSelectedIngressId] = useState<number | null>(null);
  const [bindings, setBindings] = useState<NodeBinding[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createConfirmOpen, setCreateConfirmOpen] = useState(false);
  /** R2 自助建组：页面级与「创建节点」对话框同一处入口，成功后 refetch 组列表。 */
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [nodeId, setNodeId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [nodeRole, setNodeRole] = useState<NodeRole>("ingress");
  /**
   * 页面级的接入状态：**命令与等待都挂在这里**，而不是挂在对话框上。
   * 关掉命令对话框只是不再显示它；等待继续，重开还是同一条命令。
   */
  const [onboarding, setOnboarding] = useState<NodeOnboardingTarget | null>(null);
  const [onboardingView, setOnboardingView] = useState<UserNodeOnboardingView | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [factsBusy, setFactsBusy] = useState(false);
  /**
   * 卡片上的显式重签：确认框要显示**当前最新事实**（registered / has_credential），
   * 所以确认内容在打开时算一次、签发时再算一次（事实可能在这期间就变了）。
   */
  const [regenConfirm, setRegenConfirm] = useState<string | null>(null);
  const [regenTarget, setRegenTarget] = useState<UserNode | null>(null);
  const [regenIssue, setRegenIssue] = useState<{ node: UserNode; enrollment: NodeEnrollmentIssued } | null>(null);
  const [regenPending, setRegenPending] = useState(false);
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

  /** 现值作用域：Workspace 取模块级 active（切换时同步写入），epoch 随权限变化前进。 */
  const liveScope = useCallback(
    (): OnboardingScope => ({ workspaceId: getActiveWorkspace(), epoch: scopeEpochRef.current }),
    [],
  );

  const beginOperation = useCallback(
    (): OnboardingOperation => ({ ...liveScope(), ticket: enrollmentSeq.current.next() }),
    [liveScope],
  );

  const operationStale = useCallback(
    (started: OnboardingOperation) =>
      operationIsStale(started, { scope: liveScope(), ticketCurrent: enrollmentSeq.current.current }),
    [liveScope],
  );

  /**
   * 注入给共享等待组件的**用户域**适配器：取数只走 `GET /api/nodes`，
   * 签发只走 `POST /api/nodes/:id/enrollment`（绝不调用 admin API），
   * 且都带作用域护栏（晚到响应抛错丢弃，不跨 Workspace 展示命令）。
   *
   * 列表取不到时适配器**不抛**，而是回一个 `read: "list_unavailable"` 的视图：
   * 「暂时取不到」是可展示、可重试的结论，不该当成轮询错误被吞进 toast。
   */
  const adapters = useMemo(
    () =>
      createUserOnboardingAdapters({
        listNodes: () => api.nodes.list(),
        issueEnrollment: (id) => api.nodes.enrollment(id),
        scope: liveScope,
        staleMessage: t("node.scopeChanged"),
      }),
    [liveScope, t],
  );

  /**
   * 节点列表：**失败不是「0 个节点」**。
   *
   * 把一次失败渲染成「还没有节点，去创建吧」会同时骗两件事——机器可能好好地在
   * 线，而用户会照着空态去重复装一台。所以失败要显式呈现 + 可重试。
   */
  const loadNodes = useCallback(async () => {
    const ticket = nodeSeq.current.next();
    const started = liveScope();
    setNodes([]);
    setNodesRead(false);
    setNodesFailed(false);
    if (!canRead) {
      setNodesLoading(false);
      return;
    }
    setNodesLoading(true);
    try {
      const rows = await api.nodes.list();
      if (!nodeSeq.current.current(ticket) || !scopeIsCurrent(started, liveScope())) return;
      setNodes(rows);
      setNodesRead(true);
      const ingressRows = rows.filter(isIngress);
      setSelectedIngressId((current) => {
        if (current && ingressRows.some((node) => Number(node.id) === current)) return current;
        return ingressRows[0] ? Number(ingressRows[0].id) : null;
      });
    } catch {
      // 只有仍属于当前作用域的失败才允许写状态 / 提示。
      if (!nodeSeq.current.current(ticket) || !scopeIsCurrent(started, liveScope())) return;
      setNodesFailed(true);
    } finally {
      if (nodeSeq.current.current(ticket) && scopeIsCurrent(started, liveScope())) setNodesLoading(false);
    }
  }, [canRead, liveScope]);

  /** 节点组单独取数：失败要能**重试**，不能把创建按钮永久锁死。 */
  const loadGroups = useCallback(async () => {
    const ticket = groupSeq.current.next();
    const started = liveScope();
    if (!canManage) {
      setGroups([]);
      setGroupsLoading(false);
      setGroupsFailed(false);
      return;
    }
    setGroupsLoading(true);
    setGroupsFailed(false);
    try {
      const rows = await api.nodeGroups.list({ page: 1, page_size: 100 });
      if (!groupSeq.current.current(ticket) || !scopeIsCurrent(started, liveScope())) return;
      setGroups(rows.data);
    } catch {
      if (!groupSeq.current.current(ticket) || !scopeIsCurrent(started, liveScope())) return;
      setGroups([]);
      setGroupsFailed(true);
    } finally {
      if (groupSeq.current.current(ticket) && scopeIsCurrent(started, liveScope())) setGroupsLoading(false);
    }
  }, [canManage, liveScope]);

  const loadBindings = useCallback(async (id: number | null) => {
    const ticket = bindingSeq.current.next();
    const started = liveScope();
    setBindings([]);
    if (!id || !canRead) return;
    try {
      const rows = await api.nodes.bindings(id);
      if (!bindingSeq.current.current(ticket) || !scopeIsCurrent(started, liveScope())) return;
      setBindings(rows);
    } catch (err) {
      if (!bindingSeq.current.current(ticket) || !scopeIsCurrent(started, liveScope())) return;
      toast.error(err instanceof Error ? err.message : t("node.bindingsLoadFailed"));
    }
  }, [canRead, liveScope, t]);

  /**
   * 用**当前作用域的最新用户列表**补齐一个节点的接入事实。
   *
   * provision 的响应是窄的（没有 `connection` / `registered` / `has_credential`），
   * 所以新建成功后必须立刻取一次列表，把 `unknown` 换成服务端真实投影。晚到响应
   * 用 operationStale 丢弃：切空间后不能把旧空间的事实写成新空间的现值。
   */
  const upgradeFacts = useCallback(async (
    nodeIdValue: number,
    started: OnboardingOperation,
    options?: { toastOnRetry?: boolean },
  ) => {
    setFactsBusy(true);
    try {
      const view = await adapters.loadView(nodeIdValue);
      if (operationStale(started)) return;
      if (view.read === "list_unavailable") {
        // 取不到事实：保留已有快照（或如实降级），不把它当成「节点不存在」。
        setOnboardingView((prev) => prev ?? view);
      } else {
        // 权威列表视图覆盖本地快照（窄响应）。
        setOnboardingView((prev) => mergeOnboardingViews(prev ?? view, view));
      }
    } catch {
      // 适配器只会在作用域变化时抛错：那种情况什么都不该做。
    } finally {
      if (!operationStale(started)) {
        setFactsBusy(false);
        if (options?.toastOnRetry) void loadNodes();
      }
    }
  }, [adapters, loadNodes, operationStale]);

  /** 降级提示上的「重试」：重新拉一次事实，顺便刷新列表与组（都是可重试的）。 */
  const retryFacts = useCallback(() => {
    if (!onboarding) return;
    const started = beginOperation();
    void upgradeFacts(onboarding.node.id, started, { toastOnRetry: true });
  }, [beginOperation, onboarding, upgradeFacts]);

  /**
   * Workspace / 权限变化：epoch 前进一格，并丢弃在途响应与**敏感命令**。
   *
   * epoch 只增不减，所以 A→B→A 也不会让旧响应「重新变有效」。这个 effect 必须
   * 排在下面的取数 effect 之前：先把刻度推进，之后的请求才抓得到新作用域。
   */
  useEffect(() => {
    scopeEpochRef.current += 1;
    setScopeEpoch(scopeEpochRef.current);
    nodeSeq.current.next();
    groupSeq.current.next();
    bindingSeq.current.next();
    enrollmentSeq.current.next();
    lastInstallPhase.current = null;
    setOnboarding(null);
    setOnboardingView(null);
    setCommandOpen(false);
    setCreateOpen(false);
    setCreateConfirmOpen(false);
    setGroupCreateOpen(false);
    setBindOpen(false);
    setSelectedIngressId(null);
    setRegenConfirm(null);
    setRegenTarget(null);
    setRegenIssue(null);
    setRegenPending(false);
    setFactsBusy(false);
    setBusy(false);
  }, [currentId, permissions]);

  useEffect(() => {
    void loadNodes();
    void loadGroups();
    // V4-WP8：`/nodes?focus=<id>` 来自 Dashboard 待办。只认数字，不猜其它形态；
    // 读到后滚动到那张卡片并高亮（找不到就什么也不做，不报错）。
    const requested = new URLSearchParams(window.location.search).get("focus");
    if (requested && /^\d+$/.test(requested)) setFocusId(Number(requested));
    return () => { nodeSeq.current.next(); groupSeq.current.next(); };
  }, [currentId, permissions]);

  useEffect(() => {
    if (focusId === null || nodesLoading) return;
    const target = document.getElementById(`node-${focusId}`);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusId, nodesLoading]);

  useEffect(() => {
    void loadBindings(selectedIngressId);
    return () => { bindingSeq.current.next(); };
  }, [selectedIngressId, currentId, permissions]);

  useEffect(() => {
    if (!createOpen || groupId || groups.length === 0) return;
    const first = groups[0]!;
    setGroupId(String(first.id));
    setNodeRole(first.node_type === "out" ? "egress" : "ingress");
  }, [createOpen, groupId, groups]);

  // 最新一次 loadNodes 的引用（供稳定的 onViewChange 回调使用，避免每帧重建轮询 effect）。
  useEffect(() => {
    reloadNodesRef.current = () => { void loadNodes(); };
  });

  /**
   * 只消费服务端投影：`online` 是「已连接」，**不是**「健康检查通过」。
   * 上线后刷新列表，让节点卡片的徽章跟上；不在这里补任何成功勾选。
   */
  const handleOnboardingView = useCallback((next: UserNodeOnboardingView) => {
    setOnboardingView(next);
    const phase = installPhase(next);
    if (phase === "online" && lastInstallPhase.current !== "online") reloadNodesRef.current();
    lastInstallPhase.current = phase;
  }, []);

  /** 当前输入是否与列表里已有节点同名（大小写不敏感）。 */
  const duplicate = checkNodeIdDuplicate(nodes, nodeId);
  const duplicateNode = duplicate.kind === "conflict"
    ? nodes.find((row) => Number(row.id) === Number(duplicate.nodeId)) ?? null
    : null;

  const groupState = nodeGroupState({
    canManage,
    loading: groupsLoading,
    failed: groupsFailed,
    count: groups.length,
  });
  const listRead = nodesRead && !nodesFailed;
  const submitEnabled = canSubmitNodeCreation({
    canManage,
    groupState,
    nodeId,
    groupId,
    listRead,
    duplicate: duplicate.kind === "conflict",
  });
  const blockedReasonKey = nodeCreationBlockedReasonKey({
    canManage,
    groupState,
    nodeId,
    groupId,
    listRead,
    duplicate: duplicate.kind === "conflict",
  });
  const listState = nodeListState({
    canRead,
    loading: nodesLoading,
    failed: nodesFailed,
    count: nodes.length,
  });
  const prerequisitePersona = nodeGroupPrerequisitePersona({ canManage, canRead });

  /**
   * 新建节点（第一段）：只做本地校验与确认，不碰网络。
   *
   * 同名冲突在**提交前**就拒绝（大小写不敏感，与数据库唯一键同口径），并引导
   * 用户走既有的安装 / 重签入口——后端对已存在 `node_id` 的语义是「复用并重签」，
   * 不是报错，默默创建会作废用户手上还没用的命令。
   */
  function requestCreateNode() {
    if (!canManage) { toast.error(PERMISSION_DENIED); return; }
    if (!submitEnabled) return;
    const conflict = checkNodeIdDuplicate(nodes, nodeId);
    if (conflict.kind === "conflict") {
      toast.error(t("node.createDuplicateBlocked", { nodeId: nodeId.trim() }));
      return;
    }
    setCreateConfirmOpen(true);
  }

  /** 新建节点（第二段）：确认后真正提交。 */
  async function createNode() {
    if (!canManage) { toast.error(PERMISSION_DENIED); return; }
    if (!submitEnabled) return;
    // 提交这一刻再查一次：列表可能在用户读确认文案期间变过（并发新建窗口）。
    const conflict = checkNodeIdDuplicate(nodes, nodeId);
    if (conflict.kind === "conflict") {
      setCreateConfirmOpen(false);
      toast.error(t("node.createDuplicateBlocked", { nodeId: nodeId.trim() }));
      return;
    }
    const requestedNodeId = nodeId.trim();
    const started = beginOperation();
    setBusy(true);
    try {
      const created = await api.nodeGroups.provisionNode(Number(groupId), {
        node_id: requestedNodeId,
        role: nodeRole,
      });
      // 晚到响应 / 已切换作用域：命令属于旧作用域，连 toast 都不该出现。
      if (operationStale(started)) return;
      setCreateOpen(false);
      setCreateConfirmOpen(false);
      // provisionNode 已经签发了 enrollment —— **直接保留**，不再补一次 POST 重签
      // （重签会撤销用户手上刚拿到的命令）。
      const target = nodeOnboardingTargetFromProvision(created);
      setOnboarding(target);
      setOnboardingView(target.initialView);
      setCommandOpen(true);
      setNodeId("");
      setGroupId("");
      toast.success(t("node.createSuccess"));
      void loadNodes();
      void loadGroups();
      // 窄响应补齐：立刻用当前作用域的列表覆盖 `unknown` 事实。
      void upgradeFacts(target.node.id, started);
    } catch (err) {
      if (operationStale(started)) return;
      // D3：建组后加节点的失败分支必须给**真实原因 + 下一步**。
      // 典型是 409 `PORT_RANGE_REQUIRED`（组的端口范围不合法）——只说「创建失败」
      // 会让用户反复点；只说 409 又不可执行。原因用后端原文，下一步取词典。
      const info = nodeGroupApiErrorInfo(err);
      const nextStep = info.nextStepKey ? t(info.nextStepKey) : null;
      toast.error([info.message ?? t("node.createFailed"), nextStep].filter(Boolean).join(" "));
    } finally {
      // 旧请求不能解锁新请求的 busy（用户会在第一个请求还在飞时又点一次）。
      if (!operationStale(started)) setBusy(false);
    }
  }

  /**
   * 节点卡片上的「一键安装 / 重新生成安装命令」。
   *
   * 三种情况刻意分开：
   *   · 本地已保留该节点的命令 → 只重开对话框，**不重签**；
   *   · 需要签发（首次安装 / 已注册节点显式重签）→ 先确认后果，再签发；
   *   · 作用域在签发途中变化 → 丢弃响应，命令不落 UI。
   */
  function openInstaller(node: UserNode) {
    if (!canManage) { toast.error(PERMISSION_DENIED); return; }
    if (onboarding && Number(onboarding.node.id) === Number(node.id)) {
      setCommandOpen(true);
      return;
    }
    if (regenPending) return;
    setRegenTarget(node);
    setRegenIssue(null);
    // 确认文案读**最新视图**（视图缺失时按最严格一档，不把未知当「没有凭据」）。
    setRegenConfirm(buildRegenerateConfirm(t, {
      registered: regenRegisteredFor(node),
      hasCredential: regenHasCredentialFor(node),
      phase: regenPhaseFor(node),
    }));
  }

  /** 该节点的注册事实：优先当前 latest 视图（同一节点时），否则用卡片行上的投影。 */
  function regenRegisteredFor(node: UserNode): boolean | null {
    if (onboarding && Number(onboarding.node.id) === Number(node.id) && onboardingView) {
      return onboardingView.registered;
    }
    return typeof node.registered === "boolean" ? node.registered : null;
  }

  function regenHasCredentialFor(node: UserNode): boolean | null {
    if (onboarding && Number(onboarding.node.id) === Number(node.id) && onboardingView) {
      return onboardingView.has_credential ?? null;
    }
    return typeof node.has_credential === "boolean" ? node.has_credential : null;
  }

  function regenPhaseFor(node: UserNode): InstallPhase {
    if (onboarding && Number(onboarding.node.id) === Number(node.id) && onboardingView) {
      return installPhase(onboardingView);
    }
    return installPhase(node);
  }

  /**
   * 确认框里的「重新生成」：签发这一条命令。
   *
   * 确认内容在这里**重新计算**一次（而不是直接用打开时的字符串）：从打开确认框
   * 到点确认之间，节点可能刚刚完成安装并拿到长期凭据，只有按最新事实重算才
   * 不会漏说「新命令被消费时会替换长期凭据」。
   */
  async function applyRegenerate() {
    if (!regenTarget) return;
    if (!canManage) { toast.error(PERMISSION_DENIED); return; }
    // 双击 / 已有一条在飞：不再签发第二条（否则会作废刚发给用户的那条命令）。
    if (regenPending) return;
    const node = regenTarget;
    const started = beginOperation();
    setRegenPending(true);
    setBusy(true);
    const refreshConfirm = () => {
      setRegenConfirm(buildRegenerateConfirm(t, {
        registered: regenRegisteredFor(node),
        hasCredential: regenHasCredentialFor(node),
        phase: regenPhaseFor(node),
      }));
    };
    try {
      // 签发前再算一次后果：事实可能已经变了（见函数注释）。
      refreshConfirm();
      const issued = await api.nodes.enrollment(node.id);
      if (operationStale(started)) return;
      setRegenIssue({ node, enrollment: issued });
    } catch (err) {
      if (operationStale(started)) return;
      toast.error(err instanceof Error ? err.message : t("node.installerFailed"));
    } finally {
      if (!operationStale(started)) {
        setRegenPending(false);
        setBusy(false);
      }
    }
  }

  /** 确认框里的「继续」：把**已签发**的命令交给页面级等待（不补第二次 POST）。 */
  function confirmRegenerate() {
    if (!regenIssue) return;
    const { node, enrollment } = regenIssue;
    setRegenConfirm(null);
    setRegenTarget(null);
    setRegenIssue(null);
    // 初始视图直接用**列表行**上的服务端投影（不是窄响应）：重签针对的是已有节点，
    // 卡片行的 `registered` / `has_credential` / `role` 都是列表给的权威事实。
    const rowView = userNodeOnboardingView(node, "loaded");
    setOnboardingView(rowView);
    setOnboarding({ node, enrollment, initialView: rowView });
    setCommandOpen(true);
    // 再校验一次当前事实：列表行可能是几分钟前读的，签发后节点可能已经装上并
    // 拿到长期凭据。同时让 `phase` 变到 `awaiting_install`（若本就如此），
    // 共享等待组件才有机会自动开始轮询。
    void upgradeFacts(node.id, beginOperation());
  }

  async function bindEgress() {
    if (!canManage) { toast.error(PERMISSION_DENIED); return; }
    if (!selectedIngressId || !bindEgressId) return;
    const started = beginOperation();
    setBusy(true);
    try {
      await api.nodes.bindEgress(selectedIngressId, Number(bindEgressId));
      if (operationStale(started)) return;
      setBindOpen(false);
      setBindEgressId("");
      toast.success(t("node.bindSuccess"));
      await loadBindings(selectedIngressId);
    } catch (err) {
      if (operationStale(started)) return;
      toast.error(err instanceof Error ? err.message : t("node.bindFailed"));
    } finally {
      if (!operationStale(started)) setBusy(false);
    }
  }

  async function unbindEgress(egressId: number) {
    if (!canManage) { toast.error(PERMISSION_DENIED); return; }
    if (!selectedIngressId) return;
    const started = beginOperation();
    setBusy(true);
    try {
      await api.nodes.unbindEgress(selectedIngressId, egressId);
      if (operationStale(started)) return;
      toast.success(t("node.unbindSuccess"));
      await loadBindings(selectedIngressId);
    } catch (err) {
      if (operationStale(started)) return;
      toast.error(err instanceof Error ? err.message : t("node.unbindFailed"));
    } finally {
      if (!operationStale(started)) setBusy(false);
    }
  }

  if (permissionsLoading) return <p>{t("common.loading")}</p>;
  if (!canRead) return <p role="alert">{PERMISSION_DENIED}</p>;
  const createDisabledReasonKey = nodeCreateDisabledReasonKey({ canManage, groupState });
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--muted-foreground)]" data-testid="node-summary">
          {listState === "failed"
            ? t("node.listFailedSummary")
            : listState === "loading"
              ? t("common.loading")
              : t("node.summary", { nodes: nodes.length, ingress: ingressNodes.length })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" asChild>
            <Link href="/forwards">
              <ArrowLeftRight className="size-4" />
              {t("common.forwards")}
            </Link>
          </Button>
          {createDisabledReasonKey ? (
            // 禁用的按钮旁边必须有原因：否则用户只会反复点一个动不了的按钮。
            <span
              className="text-xs text-[var(--muted-foreground)]"
              data-testid="node-create-disabled-reason"
            >
              {t(createDisabledReasonKey)}
            </span>
          ) : null}
          <Button
            disabled={createDisabledReasonKey !== null}
            onClick={() => setCreateOpen(true)}
            title={createDisabledReasonKey ? t(createDisabledReasonKey) : undefined}
          >
            <Plus className="size-4" />
            {t("node.create")}
          </Button>
        </div>
      </div>

      {/* 节点列表失败：显式错误 + 重试，绝不渲染成「0 个节点」的空态。 */}
      {listState === "failed" ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-[var(--destructive)] p-3"
          data-testid="node-list-error"
          role="alert"
        >
          <span className="text-sm">{t("node.listFailedHint")}</span>
          <Button size="sm" variant="outline" onClick={() => void loadNodes()} data-testid="node-list-retry">
            <RotateCw className="size-3.5" />
            {t("node.listRetry")}
          </Button>
        </div>
      ) : null}

      {/* 接入闭环：命令 + 等待 + 下一步，页面级常驻（关掉命令对话框不打断等待）。 */}
      {onboarding ? (
        <NodeOnboarding
          target={onboarding}
          view={onboardingView}
          onViewChange={handleOnboardingView}
          canCreateForward={canCreateForward}
          workspaceId={currentId}
          scopeEpoch={scopeEpoch}
          open={commandOpen}
          onOpenChange={setCommandOpen}
          loadView={adapters.loadView}
          createEnrollment={adapters.createEnrollment}
          onRetryFacts={retryFacts}
          retryingFacts={factsBusy}
        />
      ) : null}

      {/* 没有可用节点组 / 组加载失败：真实前置条件 + 可重试 + **可自助建组**（R2）。 */}
      {groupState !== "ready" && !createOpen ? (
        <NodeGroupPrerequisite
          state={groupState}
          persona={prerequisitePersona}
          onRetry={() => void loadGroups()}
          onCreateGroup={canManage ? () => setGroupCreateOpen(true) : undefined}
        />
      ) : null}

      {listState === "failed" ? null : (
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
            const onboardingThisNode = onboarding !== null && Number(onboarding.node.id) === Number(node.id);
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
                    <Button
                      size="sm"
                      variant={onboardingThisNode ? "default" : "outline"}
                      onClick={() => openInstaller(node)}
                      disabled={busy || !canManage}
                      title={canManage ? undefined : PERMISSION_DENIED}
                    >
                      <RefreshCw className="size-3.5" />
                      {node.registered ? t("node.reinstall") : t("node.install")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {listState === "empty" || (listState === "loading" && nodes.length === 0) ? (
            canManage ? (
              <Card className="md:col-span-2 xl:col-span-3">
                <CardContent className="py-10 text-center text-sm text-[var(--muted-foreground)]">
                  {t("node.createHint")}
                </CardContent>
              </Card>
            ) : (
              <NodeReadonlyEmptyState className="md:col-span-2 xl:col-span-3" />
            )
          ) : null}
        </div>
      )}

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
                <Button
                  disabled={!canManage}
                  size="sm"
                  variant="outline"
                  onClick={() => setBindOpen(true)}
                  title={canManage ? undefined : PERMISSION_DENIED}
                >
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
          <NodeCreateDialogBody
            nodeId={nodeId}
            onNodeIdChange={setNodeId}
            duplicateNodeId={
              duplicate.kind === "conflict" ? duplicateNode?.node_id ?? nodeId.trim() : null
            }
            groups={groups}
            groupId={groupId}
            onGroupChange={(value) => {
              setGroupId(value);
              const group = groups.find((row) => String(row.id) === value);
              if (group) setNodeRole(group.node_type === "out" ? "egress" : "ingress");
            }}
            nodeRole={nodeRole}
            onRoleChange={setNodeRole}
            groupState={groupState}
            prerequisitePersona={prerequisitePersona}
            onRetryGroups={() => void loadGroups()}
            submitEnabled={submitEnabled}
            blockedReasonKey={blockedReasonKey}
            pending={busy}
            onCancel={() => setCreateOpen(false)}
            onSubmit={requestCreateNode}
          />
        </DialogContent>
      </Dialog>

      {/* R2 自助建组：提交走用户域 `POST /api/node-groups`（node:manage + entitlement
          由后端裁决），成功后刷新组列表并直接打开「创建节点」，把用户接回既有链路。 */}
      <NodeGroupCreateDialog
        open={groupCreateOpen && canManage}
        onOpenChange={setGroupCreateOpen}
        onCreated={() => {
          void loadGroups();
          setCreateOpen(true);
        }}
      />

      <NodeCreationConfirm
        open={createConfirmOpen && canManage}
        nodeId={nodeId.trim()}
        duplicateNodeId={duplicateNode ? duplicateNode.node_id : null}
        pending={busy}
        onOpenChange={setCreateConfirmOpen}
        onConfirm={() => void createNode()}
      />

      <NodeInstallRegenerateConfirm
        open={regenConfirm !== null && regenTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRegenConfirm(null);
            setRegenTarget(null);
            setRegenIssue(null);
          }
        }}
        confirm={regenConfirm ?? undefined}
        hasCredential={
          regenIssue
            ? regenHasCredentialFor(regenIssue.node) === true
            : regenTarget
              ? regenHasCredentialFor(regenTarget) === true
              : false
        }
        phase={regenTarget ? regenPhaseFor(regenTarget) : "unknown"}
        pending={regenPending}
        onConfirm={() => {
          if (regenIssue) confirmRegenerate();
          else void applyRegenerate();
        }}
      />

      {/* V4-WP11C/WP11B：诊断 / 支持包 / 升级命令。只读 + 生成脚本，不改运行态。 */}
      {selectedIngress ? (
        <NodeDiagnostics nodeId={selectedIngress.id} nodeKey={selectedIngress.node_id} />
      ) : null}

      {/* 升级（task-17 交付的自包含卡片）：比 node-diagnostics 里那段内联"生成升级命令"
          多了三件关键事实——**实际上报版本**（不是配置字段）、**服务端前置原文**、
          以及"生成脚本 ≠ 已升级"的执行后可见性。旧内联块已退役，避免两个升级入口
          （退役见 node-diagnostics.tsx 的注释）。 */}
      {selectedIngress ? <NodeUpgradeCard nodeId={selectedIngress.id} /> : null}

      {/* Looking Glass（task-25 交付）：后端/Agent/控制协议早已完整、Web 一直零消费者。
          五态由服务端 `enabled` 与角色决定；**发起是写操作**（真的拨一次 TCP + 写审计），
          因此"未开启 / 无权限 / 未发起 / 发起了但没结果"必须分开说。 */}
      {selectedIngress ? <LookingGlassPanel nodeId={selectedIngress.id} /> : null}

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

/**
 * 「创建节点」对话框正文（纯展示，状态与提交仍归 {@link NodeWorkspace}）。
 *
 * ── 为什么单独导出 ──
 * Radix Portal 在静态渲染下不产出 DOM，对话框正文无法被渲染测试直接断言。抽成
 * 纯展示组件后，测试可以在 `<Dialog open>`（只有 Root，没有 Portal）里渲染它，
 * 直接钉住「入口按钮 / 弹窗标题 / 提交按钮是同一个称呼」这条产品事实；仓库既有
 * 的 `NodeInstallDialogBody` / `NodeCreationConfirmBody` 是同一手法。
 *
 * ── 为什么三处都用 `node.create` ──
 * 同一个动作（创建节点）在页面上出现三次：工具栏入口按钮、弹窗标题、提交按钮。
 * 原先提交按钮用的是通用词 `common.create`（zh「新建」），于是同一个动作有了两种
 * 称呼。这里统一到产品既有用户词汇 `node.create`（zh「创建节点」/ en「Create node」），
 * 不再另起 `common.create`。
 */
export interface NodeCreateDialogBodyProps {
  /** 节点 ID 输入值。 */
  nodeId: string;
  onNodeIdChange: (value: string) => void;
  /** 与当前工作空间已有节点同名的节点名；null = 没有重名（不显示警告）。 */
  duplicateNodeId: string | null;
  groups: NodeGroup[];
  groupId: string;
  onGroupChange: (value: string) => void;
  nodeRole: NodeRole;
  onRoleChange: (role: NodeRole) => void;
  groupState: NodeGroupState;
  prerequisitePersona: "manager" | "readonly" | "denied";
  onRetryGroups: () => void;
  submitEnabled: boolean;
  blockedReasonKey: string | null;
  pending: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}

export function NodeCreateDialogBody({
  nodeId,
  onNodeIdChange,
  duplicateNodeId,
  groups,
  groupId,
  onGroupChange,
  nodeRole,
  onRoleChange,
  groupState,
  prerequisitePersona,
  onRetryGroups,
  submitEnabled,
  blockedReasonKey,
  pending,
  onCancel,
  onSubmit,
}: NodeCreateDialogBodyProps) {
  const { t } = useI18n();
  const duplicate = duplicateNodeId !== null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("node.create")}</DialogTitle>
        <DialogDescription>{t("node.createHint")}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <Field label={t("node.nodeIdLabel")}>
          <Input
            value={nodeId}
            onChange={(e) => onNodeIdChange(e.target.value)}
            placeholder="hk-edge-01"
            aria-invalid={duplicate ? true : undefined}
          />
        </Field>
        {/* 同名冲突就地说明：后端会把同名 `node_id` 当成「复用并重签」，
            而不是报错，所以必须在提交前拦下来并指路。 */}
        {duplicate ? (
          <p className="text-xs text-[var(--destructive)]" data-testid="node-create-duplicate">
            {t("node.createDuplicateWarning", { nodeId: duplicateNodeId })}
          </p>
        ) : null}
        <Field label={t("node.nodeGroupLabel")}>
          <Select value={groupId} onValueChange={onGroupChange}>
            <SelectTrigger><SelectValue placeholder={t("node.chooseNodeGroup")} /></SelectTrigger>
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
          <Select value={nodeRole} onValueChange={(value) => onRoleChange(value as NodeRole)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ingress">{t("node.ingress")}</SelectItem>
              <SelectItem value="egress">{t("node.egress")}</SelectItem>
              <SelectItem value="both">{t("node.both")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <NodeGroupPrerequisite
          state={groupState}
          persona={prerequisitePersona}
          onRetry={onRetryGroups}
        />
        {/* 禁用的按钮旁边必须有原因，否则用户只会反复点。 */}
        {!submitEnabled && blockedReasonKey ? (
          <p className="text-xs text-[var(--muted-foreground)]" data-testid="node-create-blocked-reason">
            {t(blockedReasonKey)}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button
          onClick={onSubmit}
          disabled={pending || !submitEnabled}
          data-testid="node-create-submit"
        >
          {t("node.create")}
        </Button>
      </DialogFooter>
    </>
  );
}
