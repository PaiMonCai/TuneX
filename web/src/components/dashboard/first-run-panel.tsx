"use client";

/**
 * R2 First-run —— Dashboard 上的「下一步」面板（客户端组件）。
 *
 * ── 它做什么 ──
 * 用**已经存在的四个只读事实**（组数 / 节点数 / 转发数 / 当前有效能力投影）派生唯一的
 * 下一步（`lib/first-run.ts`），并把那一步变成真的能点的东西：
 *   · `create_group`   → 原地打开最小建组表单（用户域 `POST /api/node-groups`）；
 *   · `add_node`       → 去 `/nodes`（I1 的「加节点 → 等待上线」链路）；
 *   · `create_forward` → 去 `/forwards`；
 *   · `need_operator`  → 只说真话：谁、为什么、下一步找谁（不给必失败按钮）；
 *   · `done`           → 不渲染（首启引导已经走完，不再打扰）；
 *   · `unknown`        → 明说「无法确认」，绝不当成一切正常。
 *
 * ── 三重状态纪律（沿用 AttentionPanel）──
 *   loading（还不知道）/ ready（有结论）/ degraded（取不到）。第三态最容易漏：
 *   把一次失败的请求渲染成「没有待办」就是一次谎，而首启用户会照着这个谎去以为
 *   自己已经接入完成。`degraded` 时给**手动重试**，不自动轮询（首启事实只在用户
 *   自己的操作下变化，10s 一次的自动轮询只会白打接口）。
 *
 * ── 作用域护栏 ──
 * 每次加载抓 `(workspace, epoch, ticket)` 三个坐标，响应回来先比对现值：切 Workspace
 * 或权限变化后，晚到的成功/失败都**丢弃**（不 setState、不 toast）。fence 复用既有
 * `createPermissionRequestFence()`，作用域比较复用 `lib/node-onboarding` 的
 * `scopeIsCurrent`——两处都是同一套既有机制，不新造第二套。
 *
 * ── 不缓存、不落库 ──
 * 没有 localStorage、没有 setup 完成标记：进度每次都由事实现算。用户删掉转发、
 * 切了工作空间之后，这里会立刻回到真实的那一步。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Loader2, RefreshCw } from "lucide-react";
import { useI18n } from "@/components/providers";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, ApiError, getActiveWorkspace } from "@/lib/api";
import { capabilitiesApi, type WorkspaceCapabilities } from "@/lib/api/capabilities";
import { createPermissionRequestFence } from "@/lib/workspace-permissions";
import { NodeGroupCreateDialog } from "@/components/nodes/node-group-create-dialog";
import {
  deriveFirstRunStep,
  firstRunHref,
  firstRunQuotaText,
  firstRunTextKeys,
  type FirstRunDecision,
  type FirstRunFacts,
} from "@/lib/first-run";
import { scopeIsCurrent, type OnboardingScope } from "@/lib/node-onboarding";

/* ================================================================== */
/* 加载（可注入依赖，行为测试直接调）                                    */
/* ================================================================== */

export interface FirstRunLoaderDeps {
  /** 一次拿齐三个计数（同一波请求，避免三个独立失败点各自降级）。 */
  fetchCounts: () => Promise<{ groups: number; nodes: number; forwards: number }>;
  fetchCapabilities: () => Promise<WorkspaceCapabilities>;
  /** 现值作用域（Workspace + 权限 epoch）。 */
  scope: () => OnboardingScope;
  /** 单调 fence：被后继请求取代的晚到响应同样要丢弃。 */
  fence: { next: () => number; current: (ticket: number) => boolean };
}

export type FirstRunLoadResult =
  | { kind: "facts"; facts: FirstRunFacts }
  /** 作用域已变或已被后继请求取代：调用方必须**丢弃**这份结果。 */
  | { kind: "stale" }
  | { kind: "failed"; status: number | null; message: string | null };

/**
 * 读取派生首启下一步所需的全部事实。
 *
 * 失败时**不抛**：返回 `failed`（带 HTTP 状态），由界面渲染成可重试的 degraded 卡片。
 * 403 单独保留状态码，因为「没有权限读这些资源」与「后端暂时坏了」对用户是两件事：
 * 前者重试多少次都一样，该去找管理员。
 */
export async function loadFirstRunFacts(
  input: { canManageNodes: boolean | null },
  deps: FirstRunLoaderDeps,
): Promise<FirstRunLoadResult> {
  const ticket = deps.fence.next();
  const started = deps.scope();
  try {
    const [counts, capabilities] = await Promise.all([deps.fetchCounts(), deps.fetchCapabilities()]);
    if (!deps.fence.current(ticket) || !scopeIsCurrent(started, deps.scope())) return { kind: "stale" };
    return {
      kind: "facts",
      facts: {
        canManageNodes: input.canManageNodes,
        groups: counts.groups,
        nodes: counts.nodes,
        forwards: counts.forwards,
        capabilities,
      },
    };
  } catch (error) {
    if (!deps.fence.current(ticket) || !scopeIsCurrent(started, deps.scope())) return { kind: "stale" };
    return {
      kind: "failed",
      status: error instanceof ApiError ? error.status : null,
      message: error instanceof Error ? error.message : null,
    };
  }
}

/* ================================================================== */
/* 三态                                                                */
/* ================================================================== */

export type FirstRunPanelState =
  | { kind: "loading" }
  | { kind: "ready"; decision: FirstRunDecision; facts: FirstRunFacts }
  /** `permission` = 当前账户读不到判断所需资源（重试无用，要找管理员）；`fetch` = 暂时取不到。 */
  | { kind: "degraded"; reason: "fetch" | "permission" };

/* ================================================================== */
/* 纯展示（静态渲染可断言，含每种动作的 CTA / 文案 / href）               */
/* ================================================================== */

export interface FirstRunCardProps {
  state: FirstRunPanelState;
  /** `forward:create`：决定 `create_forward` 是给按钮还是给说明。 */
  canCreateForward: boolean;
  onRetry: () => void;
  /** 原地打开建组表单（`create_group` 的主按钮）。 */
  onCreateGroup: () => void;
  refreshing?: boolean;
}

export function FirstRunCard({
  state,
  canCreateForward,
  onRetry,
  onCreateGroup,
  refreshing = false,
}: FirstRunCardProps) {
  const { t } = useI18n();

  if (state.kind === "loading") {
    return (
      <Card data-testid="first-run-panel" data-first-run-state="loading">
        <CardHeader>
          <CardTitle>{t("firstRun.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
          <Loader2 className="size-4 animate-spin" />
          {t("firstRun.loading")}
        </CardContent>
      </Card>
    );
  }

  if (state.kind === "degraded") {
    return (
      <Card data-testid="first-run-panel" data-first-run-state="degraded" data-degraded-reason={state.reason}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-[var(--muted-foreground)]" />
            {t("firstRun.degradedTitle")}
          </CardTitle>
          <CardDescription>
            {state.reason === "permission" ? t("firstRun.degradedPermissionHint") : t("firstRun.degradedHint")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" variant="outline" onClick={onRetry} disabled={refreshing} data-testid="first-run-retry">
            {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {t("common.refresh")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { decision, facts } = state;
  // 首启引导已经走完：不再打扰（Dashboard 上还有计数、流量与待办面板）。
  if (decision.step === "done") return null;

  if (decision.step === "unknown") {
    return (
      <Card data-testid="first-run-panel" data-first-run-state="unknown">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-[var(--muted-foreground)]" />
            {t("firstRun.unknownTitle")}
          </CardTitle>
          <CardDescription>{t("firstRun.unknownHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" variant="outline" onClick={onRetry} disabled={refreshing} data-testid="first-run-retry">
            {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {t("common.refresh")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const keys = firstRunTextKeys(decision);
  const href = firstRunHref(decision);
  const quota = firstRunQuotaText(t, facts.capabilities);
  // 只读账户：动作不能替用户完成，就只给「去哪里看」，并说明缺的是哪一项权限。
  const managerOnly = decision.step === "add_node" && facts.canManageNodes !== true;
  const forwardOnly = decision.step === "create_forward" && !canCreateForward;
  const hint = managerOnly
    ? t("firstRun.addNodeHintPermission")
    : forwardOnly
      ? t("firstRun.createForwardHintPermission")
      : t(keys.hint);

  return (
    <Card data-testid="first-run-panel" data-first-run-state={`ready:${decision.step}`}>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{t(keys.title)}</CardTitle>
          <CardDescription>{hint}</CardDescription>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={onRetry}
          disabled={refreshing}
          aria-label={t("common.refresh")}
          data-testid="first-run-refresh"
        >
          {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {decision.step === "create_group" ? (
            <Button size="sm" onClick={onCreateGroup} data-testid="first-run-create-group">
              {t(keys.action ?? "firstRun.createGroupAction")}
            </Button>
          ) : null}
          {href ? (
            <Button size="sm" variant={managerOnly || forwardOnly ? "outline" : "default"} asChild>
              <Link href={href} data-testid={`first-run-link-${decision.step}`}>
                {managerOnly
                  ? t("firstRun.viewNodes")
                  : forwardOnly
                    ? t("firstRun.viewForwards")
                    : t(keys.action ?? "common.done")}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          ) : null}
        </div>
        {quota ? (
          <p className="text-xs text-[var(--muted-foreground)]" data-testid="first-run-quota">
            {quota}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ================================================================== */
/* 状态容器                                                            */
/* ================================================================== */

export function FirstRunPanel() {
  const { currentId, permissions, permissionsLoading, can } = useWorkspace();
  const [state, setState] = useState<FirstRunPanelState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const fence = useRef(createPermissionRequestFence());
  const epochRef = useRef(0);

  const liveScope = useCallback((): OnboardingScope => ({ workspaceId: getActiveWorkspace(), epoch: epochRef.current }), []);

  const load = useCallback(async () => {
    // 权限投影没到位：不知道能不能管理节点，也不能推断「无权限」——保持 loading。
    if (permissionsLoading) return;
    const canManageNodes = permissions ? can("node:manage") : null;
    setRefreshing(true);
    const result = await loadFirstRunFacts(
      { canManageNodes },
      {
        fetchCounts: async () => {
          const [groups, nodes, forwards] = await Promise.all([
            api.nodeGroups.list({ page: 1, page_size: 1 }),
            api.nodes.list(),
            api.forwards.list(),
          ]);
          return { groups: groups.total, nodes: nodes.length, forwards: forwards.length };
        },
        fetchCapabilities: () => capabilitiesApi.current(),
        scope: liveScope,
        fence: fence.current,
      },
    );
    setRefreshing(false);
    if (result.kind === "stale") return; // 切空间 / 权限变化 / 被后继请求取代：整份结果丢弃。
    if (result.kind === "failed") {
      setState({ kind: "degraded", reason: result.status === 403 ? "permission" : "fetch" });
      return;
    }
    setState({ kind: "ready", decision: deriveFirstRunStep(result.facts), facts: result.facts });
  }, [can, liveScope, permissions, permissionsLoading]);

  // 作用域变化：epoch 前进一格并丢弃在途响应（A→B→A 也不会让旧响应重新有效）。
  useEffect(() => {
    epochRef.current += 1;
    fence.current.next();
    setState({ kind: "loading" });
    setDialogOpen(false);
    void load();
    return () => {
      fence.current.next();
    };
  }, [currentId, permissions, load]);

  const decisionCapabilities = useMemo(
    () => (state.kind === "ready" ? state.facts.capabilities : null),
    [state],
  );

  return (
    <>
      <FirstRunCard
        state={state}
        canCreateForward={can("forward:create")}
        refreshing={refreshing}
        onRetry={() => void load()}
        onCreateGroup={() => setDialogOpen(true)}
      />
      <NodeGroupCreateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        capabilities={decisionCapabilities}
        onCreated={() => {
          // 建组成功后立刻重算：下一步会变成 add_node，用户可以直接点过去加节点。
          void load();
        }}
      />
    </>
  );
}
