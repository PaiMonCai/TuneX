"use client";

/**
 * I1-B —— 用户端节点接入（onboarding）的展示层。
 *
 * 这个文件回答用户装完机器后最关心的三件事，且都挂在**页面级**（不依赖任何
 * 对话框是否打开）：
 *
 *   1. 「我该执行什么命令」——共享等待组件（I1-A）负责命令、轮询与阶段；
 *   2. 「现在到底是什么状态」——等待组件的阶段徽章（只读服务端 `connection`）；
 *   3. 「接下来能做什么」——满足**全部**条件时，把创建第一条转发的 CTA 作为
 *      `successAction` 交给等待组件（闭环处渲染）；不满足时由
 *      {@link NodeOnboardingNextStep} 给出**准确**的说明。
 *
 * ── 为什么不在这里判在线 / 不在这里判准入 ──
 * `connection` 与 `accepts_new_business` 都是后端投影（`deriveConnection` /
 * `nodeAdmission`）。本文件只把它们翻译成界面元素与下一步文案。
 *
 * ── 为什么命令对话框关掉后等待还在 ──
 * 等待状态属于本组件的父级（页面级）生命周期：`open` 只控制命令对话框是否
 * 可见，组件本身只要 onboarding 目标还在就保持挂载；`key` 由
 * Workspace/权限 epoch/节点共同决定，作用域一变立即重建并丢弃旧命令。
 *
 * ── 「自动等待」这条接缝 ──
 * 共享等待组件的自动开始条件是 `phase === "awaiting_install"`（读服务端投影），
 * 而 production provision 的窄响应里没有 `connection`：父组件因此在签发后**立即
 * 用 `GET /api/nodes` 补齐事实**（`NodeWorkspace.upgradeFacts`），把 `unknown`
 * 尽早变成 `waiting`/`online`，共享组件这才有得可等。**绝不**为了触发它而把
 * 未知的 `connection` 填成 `"waiting"`——那是伪造一个服务端投影。真正「未知也
 * 自动等」的防线由共享组件（A2）负责，本层只在事实未知时如实说明。
 */
import Link from "next/link";
import { ArrowLeftRight, Loader2, Plus, RotateCw, Server } from "lucide-react";
import { NodeInstallWaiting } from "@/components/admin/node-install-waiting";
import { useI18n } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { installPhase } from "@/lib/node-lifecycle";
import {
  forwardCtaBlockedKey,
  onboardingNextStep,
  onboardingScopeKey,
  REINSTALL_CONFIRM_KEYS,
  reinstallConfirmKindForView,
  type NodeGroupState,
  type NodeOnboardingTarget,
  type UserNodeOnboardingView,
} from "@/lib/node-onboarding";
import type { ID, NodeEnrollmentIssued, UserNode } from "@/lib/types";

/**
 * 节点组前置条件 / 加载失败的说明与恢复入口。
 *
 * ── 为什么不再写「请联系管理员建组」 ──
 * 后端默认策略（`free_personal` / `free_team`）**允许**工作空间自建入口组，
 * 用户域 `POST /api/node-groups` 也早已存在。R2 之前这里只能读到「本页暂缺入口」，
 * 那是一次死路；现在空态直接给出**自助建组入口**（`onCreateGroup`，由父级挂真实
 * 对话框），建组成功后父级 refetch 组列表，用户接着走既有的「加节点 → 等待上线 →
 * 第一条转发」。
 *
 * ── persona ──
 * 只读用户没有创建权限：这里返回 `null`（页面另有只读空态说明真实权限），
 * 绝不给他一个必然 403 的按钮。加载失败时给重试，而不是把创建按钮永久锁死。
 */
export function NodeGroupPrerequisite({
  state,
  onRetry,
  persona = "manager",
  onCreateGroup,
}: {
  state: NodeGroupState;
  onRetry?: () => void;
  /** `readonly` = 有 node:read 但没有 node:manage：说清真实权限原因与联系人。 */
  persona?: "manager" | "readonly" | "denied";
  /** 自助建组入口（只在该 persona 的「无组」空态给出；父级负责打开最小建组表单）。 */
  onCreateGroup?: () => void;
}) {
  const { t } = useI18n();
  // 只读用户没有创建入口，不该被「节点组」这个前置条件打扰（页面另给只读空态）。
  if (persona !== "manager") return null;
  if (state === "ready") return null;

  if (state === "loading") {
    return (
      <p
        className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]"
        data-testid="node-group-loading"
      >
        <Loader2 className="size-3.5 animate-spin" />
        {t("node.groupsLoading")}
      </p>
    );
  }

  const failed = state === "error";
  const title = failed ? t("node.groupsFailedTitle") : t("node.groupsEmptyTitle");
  const hint = failed ? t("node.groupsFailedHint") : t("node.groupsEmptyHint");

  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3"
      data-testid={failed ? "node-group-error" : "node-group-empty"}
      role={failed ? "alert" : undefined}
    >
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-[var(--muted-foreground)]">{hint}</p>
      {failed && onRetry ? (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={onRetry}
          data-testid="node-groups-retry"
        >
          <RotateCw className="size-3.5" />
          {t("node.groupsRetry")}
        </Button>
      ) : null}
      {/* 无组：真的能建（用户域 API + 有效 entitlement 由后端裁决），不是「联系管理员」的死路。 */}
      {!failed && onCreateGroup ? (
        <Button size="sm" className="self-start" onClick={onCreateGroup} data-testid="node-group-create-entry">
          <Plus className="size-3.5" />
          {t("node.createGroupCta")}
        </Button>
      ) : null}
    </div>
  );
}

/** 创建第一条转发（ForwardWorkspace 已消费 `?ingress_node_id`）。 */
export function NodeForwardCta({ nodeId }: { nodeId: ID }) {
  const { t } = useI18n();
  return (
    <Button asChild size="sm" data-testid="node-create-forward-cta">
      <Link href={`/forwards?ingress_node_id=${nodeId}`}>
        <ArrowLeftRight className="size-4" />
        {t("node.createFirstForward")}
      </Link>
    </Button>
  );
}

/**
 * 「下一步」：说明为什么还不能创建转发。
 *
 * 成功 CTA 不在这里渲染——共享等待组件把它放在闭环徽章旁（页面级常驻，对话框
 * 打开时同一份 CTA 出现在对话框里），同屏只有一个入口。
 *
 * 也不编造 health / version / 「已通过」勾选——本切片没有这些事实来源。
 *
 * `aria-live="polite"`：轮询把状态从「等待安装」推到「在线」时，这段文字会**在
 * 原地变化**；没有 live region 的话屏幕阅读器用户听不到任何东西（视觉用户至少
 * 能看到徽章变色）。
 */
export function NodeOnboardingNextStep({
  view,
  canCreateForward,
}: {
  view: UserNodeOnboardingView | null;
  canCreateForward: boolean;
}) {
  const { t } = useI18n();
  const next = onboardingNextStep(view, canCreateForward);

  if (next.kind === "cta") return null;
  if (next.kind === "missing") {
    return (
      <p
        className="text-xs text-[var(--muted-foreground)]"
        data-testid="node-onboarding-missing"
        aria-live="polite"
      >
        {t("node.onboardingNodeMissing")}
      </p>
    );
  }
  return (
    <p
      className="text-xs text-[var(--muted-foreground)]"
      data-testid={`node-next-step-${next.reason}`}
      aria-live="polite"
    >
      {t(forwardCtaBlockedKey(next.reason))}
    </p>
  );
}

/** 「事实暂时取不到」的可重试提示（不谎报成功，也不冒充节点不存在）。 */
export function NodeOnboardingFactUnavailable({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  retrying: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2" data-testid="node-onboarding-degraded">
      <p className="text-xs text-[var(--destructive)]" role="status" aria-live="polite">
        {t("node.listUnavailableHint")}
      </p>
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        onClick={onRetry}
        disabled={retrying}
        data-testid="node-onboarding-retry"
      >
        {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
        {t("node.listRetry")}
      </Button>
    </div>
  );
}

/* ================================================================== */
/* 新建确认（明确后端「同 node_id 会重签」的后果）                        */
/* ================================================================== */

/**
 * 新建节点前的确认正文（纯展示，可被 SSR 测试直接断言）。
 *
 * ── 为什么新建也要确认 ──
 * `POST /node-groups/:id/nodes` 对**已存在的** `node_id` 不是报错，而是
 * 「复用该节点 + 重签 enrollment」（后端 `node.reprovisioned`）：旧命令立即作废，
 * 新命令被消费时会轮换长期凭据、替换原 Agent。前端已经先用当前工作空间列表
 * 拦了一道同名（大小写不敏感），但列表可能过期、并发窗口依然存在，所以在这里
 * 把后端语义**写清楚**再让用户点确认——不偷偷重装、不自动改名。
 */
export function NodeCreationConfirmBody({
  nodeId,
  duplicateNodeId,
  onConfirm,
  onCancel,
  pending,
}: {
  nodeId: string;
  /** 列表里已经存在的同名节点名（大小写不敏感）；null = 当前没查到。 */
  duplicateNodeId: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      <p className="text-sm" data-testid="node-create-confirm-node">
        {t("node.createConfirmNode", { nodeId })}
      </p>
      <p className="text-xs text-[var(--muted-foreground)]" data-testid="node-create-confirm-reprovision">
        {t("node.createConfirmReprovision")}
      </p>
      {duplicateNodeId ? (
        <p className="text-xs text-[var(--destructive)]" data-testid="node-create-confirm-duplicate">
          {t("node.createConfirmDuplicate", { nodeId: duplicateNodeId })}
        </p>
      ) : null}
      <DialogFooter>
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={pending}
          data-testid="node-create-confirm-cancel"
        >
          {t("common.cancel")}
        </Button>
        <Button onClick={onConfirm} disabled={pending} data-testid="node-create-confirm-apply">
          {t("node.createConfirmApply")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** 新建确认对话框（Radix Dialog：焦点管理与 role 由组件库接管）。 */
export function NodeCreationConfirm({
  open,
  nodeId,
  duplicateNodeId,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  nodeId: string;
  duplicateNodeId: string | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="node-create-confirm-dialog">
        <DialogHeader>
          <DialogTitle>{t("node.createConfirmTitle")}</DialogTitle>
        </DialogHeader>
        <NodeCreationConfirmBody
          nodeId={nodeId}
          duplicateNodeId={duplicateNodeId}
          pending={pending}
          onConfirm={onConfirm}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/* ================================================================== */
/* 显式重签的确认文案（读**最新视图**，未知按最严格一档）                  */
/* ================================================================== */

/**
 * 组装重签确认文案。
 *
 * ── 为什么不能沿用创建时的节点快照 ──
 * `POST /nodes/:id/enrollment` 的后果取决于节点**此刻**的 `registered` /
 * `has_credential`：节点在用户停留期间可能已经完成安装、拿到了长期凭据。
 * 用创建时的 `registered:false` 去渲染「只会作废旧命令」就会漏掉
 * 「消费新命令会替换长期凭据、旧 Agent 掉线」这个不可逆后果。
 *
 * ── 未知为什么不装作「没有凭据」 ──
 * `registered` 拿不到时（列表取不到 / 后端没投影）用更严格的一档：把两段后果
 * 都写上（作废旧命令 + **可能**替换长期凭据），并额外说明「重签不修网络连接」。
 * 反过来（未知 → 当作 new）会让用户以为没有凭据被替换，这是**会掉线**的错误。
 */
export function buildRegenerateConfirm(
  t: (key: string) => string,
  input: {
    registered: boolean | null | undefined;
    hasCredential?: boolean | null;
    phase?: "awaiting_install" | "online" | "installed_offline" | "unknown";
  },
): string {
  const kind = reinstallConfirmKindForView({ registered: input.registered ?? null });
  const parts = [t(REINSTALL_CONFIRM_KEYS[kind])];
  // 未知 + 明确有凭据 → 补一句凭据后果（两段分开写，不与严格档的首句重复）。
  if (kind === "unknown" && input.hasCredential === true) {
    parts.push(t("node.reinstallConfirmCredential"));
  }
  // 已安装但离线：重签**不修网络**，只有确实要重装 Agent 才需要新命令。
  if (input.phase === "installed_offline") {
    parts.push(t("node.reinstallConfirmOffline"));
  }
  return parts.join(" ");
}

/* ================================================================== */
/* 页面级面板                                                          */
/* ================================================================== */

export interface NodeOnboardingProps {
  /** 目标节点 + 已保留的安装命令（新建时来自 provisionNode，重签时来自显式签发）。 */
  target: NodeOnboardingTarget;
  view: UserNodeOnboardingView | null;
  onViewChange: (view: UserNodeOnboardingView) => void;
  /** `forward:create`：决定成功 CTA 是否可操作。 */
  canCreateForward: boolean;
  /** 当前 Workspace（进 key，切换即重建等待状态）。 */
  workspaceId: number | null;
  /** 权限 epoch（进 key）。 */
  scopeEpoch: number;
  /** 命令对话框是否打开；关闭**不**停止本轮等待。 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 用户域取数适配器（I1-A 契约），由父级注入 `api.nodes.*`。 */
  loadView: (nodeId: ID) => Promise<UserNodeOnboardingView>;
  createEnrollment: (nodeId: ID) => Promise<NodeEnrollmentIssued>;
  /** 事实暂时取不到时的重试（父级重新拉一次当前作用域的节点列表）。 */
  onRetryFacts?: () => void;
  /** 父级正在重取事实（按钮转圈，避免连点）。 */
  retryingFacts?: boolean;
}

export function NodeOnboarding({
  target,
  view,
  onViewChange,
  canCreateForward,
  workspaceId,
  scopeEpoch,
  open,
  onOpenChange,
  loadView,
  createEnrollment,
  onRetryFacts,
  retryingFacts = false,
}: NodeOnboardingProps) {
  const { t } = useI18n();
  const next = onboardingNextStep(view, canCreateForward);

  const phase = installPhase(view);
  /** 事实还没到位的窗口（production 窄响应 / 列表暂时取不到）：不谎报阶段。 */
  const factsUnknown = view === null || view.read !== "loaded" || phase === "unknown";

  return (
    <Card data-testid="node-onboarding">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="size-4" />
          {t("node.onboardingTitle")}
          <span className="font-mono text-sm">{target.node.node_id}</span>
        </CardTitle>
        <CardDescription>{t("node.onboardingHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {factsUnknown ? (
          <p
            className="text-xs text-[var(--muted-foreground)]"
            data-testid="node-onboarding-facts-pending"
            aria-live="polite"
          >
            {t("node.onboardingFactsPending")}
          </p>
        ) : null}
        <NodeInstallWaiting
          key={onboardingScopeKey(workspaceId, scopeEpoch, target.node.id)}
          nodeId={target.node.id}
          view={view}
          onViewChange={onViewChange}
          initialEnrollment={target.enrollment}
          open={open}
          onOpenChange={onOpenChange}
          // 事实补齐后（`awaiting_install`）才由共享组件起轮：见文件头「自动等待」。
          autoStart
          loadView={loadView}
          createEnrollment={createEnrollment}
          // 成功 CTA 只在四项条件同时成立时给出（见 `onboardingNextStep`）。
          successAction={next.kind === "cta" ? <NodeForwardCta nodeId={target.node.id} /> : undefined}
          // 显式重签的确认按**最新视图**渲染（未知按严格一档），不用创建时快照。
          regenerateConfirm={buildRegenerateConfirm(t, {
            registered: view ? view.registered : null,
            hasCredential: view?.has_credential ?? null,
            phase,
          })}
        />
        {view && view.read === "list_unavailable" && view.connection === null && onRetryFacts ? (
          <NodeOnboardingFactUnavailable onRetry={onRetryFacts} retrying={retryingFacts} />
        ) : null}
        <NodeOnboardingNextStep view={view} canCreateForward={canCreateForward} />
      </CardContent>
    </Card>
  );
}

/** 只读用户（有 node:read、无 node:manage）的空态：真实权限原因 + 联系人。 */
export function NodeReadonlyEmptyState({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <Card className={className}>
      <CardContent className="flex flex-col gap-1 py-10 text-center text-sm text-[var(--muted-foreground)]">
        <p className="font-medium text-[var(--foreground)]" data-testid="node-readonly-empty-title">
          {t("node.readonlyEmptyTitle")}
        </p>
        <p data-testid="node-readonly-empty-hint">{t("node.readonlyEmptyHint")}</p>
      </CardContent>
    </Card>
  );
}
