/**
 * I1-B（修正轮）—— 用户端「添加节点」接入的**行为**测试（渲染 + 纯逻辑；无浏览器、无网络）。
 *
 * 盯的是批准方案里写死的几条，**以及 I1-D 独立审查发现的 production 事实缺口**：
 *
 *   A. **production 真实窄响应**：`POST /node-groups/:id/nodes` 只回
 *      `id/node_id/agent_id/role/range/group`；`connection` / `registered` /
 *      `has_credential` / 准入**都不在响应里**。因此新建后的第一帧必须是
 *      「事实未知 + 待列表覆盖」，而不是被 mock 的 `waiting` 投影假装成已知；
 *      连接事实只能来自当前工作空间的 `GET /api/nodes`。
 *   B. **动态重签确认**：确认文案读**最新视图**的 `registered`；未知按更严格的
 *      一档（不得把 unknown 当作「没有凭据」）。
 *   C. **重复 node 标识**：与当前工作空间已有节点同名（大小写不敏感）时拒绝并
 *      指路；列表取不到时不盲目创建；确认区写明后端「同名会重签」的后果。
 *   D. **列表失败 ≠ 0 个节点**：失败给显式错误 + 重试，不渲染空态；组加载初值
 *      不闪「无组」。
 *   E. **作用域护栏**：成功 / 失败 / finally 三条路径都要过 `operationStale`。
 *   F. **无组 / 只读**：不谎称「管理员专属」，只读空态给真实权限原因与联系人。
 *
 * 跑法（web 目录）：bun test src/components/nodes/__tests__/add-node-onboarding.test.tsx
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import {
  buildRegenerateConfirm,
  NodeCreationConfirmBody,
  NodeGroupPrerequisite,
  NodeOnboarding,
  NodeReadonlyEmptyState,
} from "@/components/nodes/node-onboarding";
import { NodeCreateDialogBody, NodeWorkspace, type NodeCreateDialogBodyProps } from "@/components/nodes/node-workspace";
import { Dialog } from "@/components/ui/dialog";
import { WorkspaceContext, type WorkspaceContextValue } from "@/components/workspace/workspace-context";
import { makeT, type Locale } from "@/lib/i18n";
import { en, zh } from "@/lib/i18n/dictionaries";
import { installPhase } from "@/lib/node-lifecycle";
import { installCommandExpired } from "@/components/admin/node-install-waiting";
import {
  canSubmitNodeCreation,
  checkNodeIdDuplicate,
  createUserOnboardingAdapters,
  duplicateNodeIdConflict,
  emptyOnboardingView,
  FORWARD_CTA_BLOCKED_REASONS,
  forwardCtaBlockedKey,
  forwardCtaDecision,
  hasAuthoritativeListFacts,
  mergeOnboardingViews,
  nodeCreateDisabledReasonKey,
  nodeCreationBlockedReasonKey,
  nodeGroupPrerequisitePersona,
  nodeGroupState,
  nodeListState,
  nodeOnboardingTargetFromProvision,
  onboardingNextStep,
  onboardingScopeKey,
  onboardingViewFromProvision,
  onboardingViewFromRows,
  operationIsStale,
  REINSTALL_CONFIRM_KEYS,
  reinstallConfirmKind,
  reinstallConfirmKindForView,
  reinstallConfirmKey,
  shouldKeepWaiting,
  userNodeOnboardingView,
  type NodeOnboardingTarget,
  type UserNodeOnboardingView,
} from "@/lib/node-onboarding";
import type { NodeEnrollmentIssued, NodeGroup, NodeRole, UserNode } from "@/lib/types";

/* ================================================================== */
/* fixtures                                                            */
/* ================================================================== */

function userNode(over: Partial<UserNode> = {}): UserNode {
  return {
    id: 7,
    node_id: "hk-edge-01",
    agent_id: "agent-7",
    weight: 1,
    status: "active",
    connect_ip: null,
    version: "0.13.22",
    backup: false,
    order_by: 0,
    custom_line: null,
    dns_status: false,
    node_group_id: 3,
    created_at: "2026-10-06T00:00:00.000Z",
    updated_at: "2026-10-06T00:00:00.000Z",
    role: "ingress",
    connection: "waiting",
    has_credential: false,
    accepts_new_business: false,
    admission_rejection: "node_waiting_install",
    registered: false,
    ...over,
  };
}

/**
 * **production provisioning 响应的真实形状**。
 *
 * 后端 `node-groups.ts` 的 select 只有这七个字段，且 `UserNode` 上其余字段
 * （weight/version/connection/registered/has_credential/accepts_new_business…）
 * 在 JSON 里**根本不存在**。用它来测，才不会因为 mock 返回了完整投影而
 * 得出「生产已经能用」的假结论。
 */
function provisionResponseNode(over: Partial<UserNode> = {}): UserNode {
  return {
    id: 42,
    node_id: "hk-edge-42",
    agent_id: "agent-42",
    connect_ip: null,
    role: "ingress",
    node_group_id: 3,
    port_range_min: 20000,
    port_range_max: 20100,
    ...over,
  } as UserNode;
}

const enrollment: NodeEnrollmentIssued = {
  token: "one-time-token",
  node_id: 7,
  node_key: "hk-edge-01",
  agent_id: "agent-7",
  expires_at: "2026-10-06T00:15:00.000Z",
  install_command:
    "curl -fsSL https://panel.local/api/internal/node/install.sh | sudo sh -s -- --enroll-token 'one-time-token'",
};

const waitingView: UserNodeOnboardingView = {
  connection: "waiting",
  has_credential: false,
  accepts_new_business: false,
  role: "ingress",
  registered: false,
  found: true,
  read: "loaded",
};
const offlineView: UserNodeOnboardingView = {
  ...waitingView,
  connection: "offline",
  has_credential: true,
};
const onlineView: UserNodeOnboardingView = {
  ...waitingView,
  connection: "online",
  has_credential: true,
  accepts_new_business: true,
  registered: true,
};

function render(node: ReactNode, locale: Locale = "zh") {
  return renderToStaticMarkup(
    <I18nProvider locale={locale} dict={locale === "en" ? en : zh}>{node}</I18nProvider>,
  );
}

/** 从 SSR 出来的 HTML 里取出带某个文案的按钮（用于断言 disabled）。 */
function buttonWith(html: string, label: string): string {
  const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
  return buttons.find((button) => button.includes(label)) ?? "";
}

/**
 * 按钮是否**真的**带 `disabled` 属性。
 *
 * 不能写 `expect(button).toContain("disabled")`：按钮 class 里永远有
 * `disabled:pointer-events-none disabled:opacity-50`，那种断言恒真，等于没测。
 */
function isDisabled(button: string): boolean {
  // 属性必须紧跟着 `=""` / `>` / 空白结束，否则会误命中 class 里的 `disabled:` 前缀。
  return /<button[^>]*\sdisabled(?:="")?(?=[\s>])/.test(button);
}

/** 页面级渲染所需的 Workspace 上下文（只读/可管理的两个投影）。 */
function workspaceValue(over: Partial<WorkspaceContextValue> = {}): WorkspaceContextValue {
  const permissions = new Set(["node:read", "node:manage", "forward:create"]);
  return {
    workspaces: [],
    current: null,
    currentId: 1,
    role: "owner",
    kind: null,
    me: { id: 1, email: "owner@example.test" },
    canManage: true,
    permissions: null,
    permissionsLoading: false,
    can: (key) => permissions.has(key),
    canForward: () => false,
    loading: false,
    error: null,
    select: () => undefined,
    createTeam: async () => null,
    refresh: async () => undefined,
    ...over,
  };
}

function renderPage(over: Partial<WorkspaceContextValue> = {}, locale: Locale = "zh") {
  return render(
    <WorkspaceContext.Provider value={workspaceValue(over)}>
      <NodeWorkspace />
    </WorkspaceContext.Provider>,
    locale,
  );
}

/* ================================================================== */
/* A. production 窄响应 → 事实只能来自用户列表                          */
/* ================================================================== */

describe("production 窄响应：不拿未知当已知，事实只从列表来", () => {
  test("provision 响应的节点行没有 connection/registered/has_credential", () => {
    const row = provisionResponseNode();
    expect(row.connection).toBeUndefined();
    expect(row.registered).toBeUndefined();
    expect(row.has_credential).toBeUndefined();
    expect(row.accepts_new_business).toBeUndefined();
  });

  test("新建第一帧：连接/凭据/注册全部保持未知，不伪造 waiting", () => {
    const target = nodeOnboardingTargetFromProvision({
      node: provisionResponseNode(),
      enrollment,
    });
    expect(target.initialView.connection).toBeNull();
    expect(target.initialView.registered).toBeNull();
    expect(target.initialView.has_credential).toBeNull();
    expect(target.initialView.accepts_new_business).toBeNull();
    expect(target.initialView.found).toBe(true);
    expect(target.initialView.read).toBe("provision");
    // 角色/端口确实是后端写的事实，原样带上。
    expect(target.initialView.role).toBe("ingress");
    // 关键：这一帧不能触发「等待安装」的自动等待（它还不是服务端结论）。
    expect(installPhase(target.initialView)).toBe("unknown");
  });

  test("列表补齐后，事实全部来自列表行（权威）", () => {
    const local = userNodeOnboardingView(provisionResponseNode(), "provision");
    const remote = onboardingViewFromRows([userNode()], 7);
    const merged = mergeOnboardingViews(local, remote);
    expect(merged.connection).toBe("waiting");
    expect(merged.registered).toBe(false);
    expect(merged.has_credential).toBe(false);
    expect(merged.read).toBe("loaded");
    expect(hasAuthoritativeListFacts(merged)).toBe(true);
  });

  test("降级视图不覆盖更好的事实（list_unavailable 只是「不知道」）", () => {
    const loaded = onboardingViewFromRows([userNode({ connection: "online" })], 7);
    const degraded = emptyOnboardingView("list_unavailable");
    expect(mergeOnboardingViews(loaded, degraded)).toBe(loaded);
  });

  test("列表读到但没有该行 = 节点真的不在（found:false），不是「取不到」", () => {
    const view = onboardingViewFromRows([userNode({ id: 8 })], 7);
    expect(view.found).toBe(false);
    expect(view.read).toBe("loaded");
    expect(onboardingNextStep(view, true)).toEqual({ kind: "missing" });
  });

  test("列表取不到时不冒充「节点不存在」：给可重试的降级结论", () => {
    const degraded = emptyOnboardingView("list_unavailable");
    expect(degraded.found).toBe(false);
    expect(onboardingNextStep(degraded, true)).toEqual({
      kind: "blocked",
      reason: "list_unavailable",
    });
    // 与「权威列表里确实没有这一行」用**不同**的文案键。
    expect(forwardCtaBlockedKey("list_unavailable")).toBe("node.ctaBlockedListUnavailable");
    expect(forwardCtaBlockedKey("list_unavailable")).not.toBe(forwardCtaBlockedKey("unknown_connection"));
  });

  test("自动等待判据：拿到 enrollment 即等，unknown 继续等，闭环/已装离线即停", () => {
    expect(shouldKeepWaiting({ hasEnrollment: true, phase: "unknown" })).toBe(true);
    expect(shouldKeepWaiting({ hasEnrollment: true, phase: "awaiting_install" })).toBe(true);
    expect(shouldKeepWaiting({ hasEnrollment: true, phase: "online" })).toBe(false);
    expect(shouldKeepWaiting({ hasEnrollment: true, phase: "installed_offline" })).toBe(false);
    // 没有命令可给时等待没有意义。
    expect(shouldKeepWaiting({ hasEnrollment: false, phase: "unknown" })).toBe(false);
  });

  test("适配器：列表取不到 → 降级视图而不是抛错；作用域变了才抛", async () => {
    let workspaceId = 1;
    const adapters = createUserOnboardingAdapters({
      listNodes: async () => {
        throw new Error("500");
      },
      issueEnrollment: async () => enrollment,
      scope: () => ({ workspaceId, epoch: 1 }),
      staleMessage: "作用域已变化",
    });
    const degraded = await adapters.loadView(7);
    expect(degraded.read).toBe("list_unavailable");
    expect(degraded.connection).toBeNull();

    // 取数途中切 Workspace：那是「不属于这里」，必须抛错丢弃。
    const switching = createUserOnboardingAdapters({
      listNodes: async () => {
        workspaceId = 2;
        throw new Error("500");
      },
      issueEnrollment: async () => enrollment,
      scope: () => ({ workspaceId, epoch: 1 }),
      staleMessage: "作用域已变化",
    });
    await expect(switching.loadView(7)).rejects.toThrow("作用域已变化");
  });
});

/* ================================================================== */
/* B. 动态 registered / has_credential 的重签确认                       */
/* ================================================================== */

describe("重签确认：读最新视图，未知按最严格一档", () => {
  test("registered 明确的两种：new 只作废命令，registered 额外说长期凭据", () => {
    expect(reinstallConfirmKind(userNode({ registered: false }))).toBe("new");
    expect(reinstallConfirmKind(userNode({ registered: true }))).toBe("registered");
    expect(reinstallConfirmKindForView({ registered: false })).toBe("new");
    expect(reinstallConfirmKindForView({ registered: true })).toBe("registered");
    expect(zh.node.reinstallConfirmNew).toContain("作废");
    expect(zh.node.reinstallConfirmNew).not.toContain("长期凭据");
    expect(zh.node.reinstallConfirmRegistered).toContain("作废");
    expect(zh.node.reinstallConfirmRegistered).toContain("长期凭据");
    expect(en.node.reinstallConfirmRegistered.toLowerCase()).toContain("credential");
  });

  test("registered 未知（null/undefined/空视图）→ unknown，并说清可能替换凭据", () => {
    expect(reinstallConfirmKind(null)).toBe("unknown");
    expect(reinstallConfirmKind(undefined)).toBe("unknown");
    expect(reinstallConfirmKindForView(null)).toBe("unknown");
    expect(reinstallConfirmKindForView({ registered: null })).toBe("unknown");
    // 绝不把 unknown 渲染成「没有凭据 / 只作废旧命令」。
    const text = zh.node.reinstallConfirmUnknown;
    expect(text).toContain("长期凭据");
    expect(text).toContain("已经安装过");
    expect(text).not.toBe(zh.node.reinstallConfirmNew);
    expect(en.node.reinstallConfirmUnknown.toLowerCase()).toContain("credential");
  });

  test("构建函数：未知 + 明确有凭据 → 补凭据后果；已装离线 → 补「不修网络」", () => {
    const tzh = makeT(zh);
    const unknownNoCred = buildRegenerateConfirm(tzh, { registered: null, hasCredential: false });
    expect(unknownNoCred).toBe(zh.node.reinstallConfirmUnknown);
    expect(unknownNoCred).not.toContain(zh.node.reinstallConfirmCredential);

    const unknownWithCred = buildRegenerateConfirm(tzh, { registered: null, hasCredential: true });
    expect(unknownWithCred).toContain(zh.node.reinstallConfirmUnknown);
    expect(unknownWithCred).toContain(zh.node.reinstallConfirmCredential);

    const offline = buildRegenerateConfirm(tzh, { registered: true, phase: "installed_offline" });
    expect(offline).toContain(zh.node.reinstallConfirmRegistered);
    expect(offline).toContain(zh.node.reinstallConfirmOffline);

    // 已注册 + 有凭据：registered 那句已经说清凭据会被替换，不重复堆砌。
    const registered = buildRegenerateConfirm(tzh, { registered: true, hasCredential: true });
    expect(registered).toBe(zh.node.reinstallConfirmRegistered);
  });

  test("面板渲染的确认文案跟着**视图**走，而不是创建时的快照", () => {
    const target: NodeOnboardingTarget = {
      node: provisionResponseNode({ id: 7, node_id: "hk-edge-01" }),
      enrollment,
      initialView: onboardingViewFromProvision(provisionResponseNode({ id: 7, node_id: "hk-edge-01" })),
    };
    const html = render(
      <NodeOnboarding
        target={target}
        view={{ ...waitingView, registered: true, has_credential: true }}
        onViewChange={() => undefined}
        canCreateForward
        workspaceId={1}
        scopeEpoch={1}
        open={false}
        onOpenChange={() => undefined}
        loadView={async () => onlineView}
        createEnrollment={async () => enrollment}
      />,
    );
    // 面板本身不渲染确认框正文（Radix Portal），但阶段与下一步必须与视图一致。
    expect(html).toContain('data-testid="node-onboarding"');
    expect(html).not.toContain('data-testid="node-onboarding-facts-pending"');
  });

  test("事实未知时面板明说「正在读取事实」，不谎报阶段", () => {
    const target: NodeOnboardingTarget = {
      node: provisionResponseNode(),
      enrollment,
      initialView: onboardingViewFromProvision(provisionResponseNode()),
    };
    const html = render(
      <NodeOnboarding
        target={target}
        view={target.initialView}
        onViewChange={() => undefined}
        canCreateForward
        workspaceId={1}
        scopeEpoch={1}
        open={false}
        onOpenChange={() => undefined}
        loadView={async () => waitingView}
        createEnrollment={async () => enrollment}
      />,
    );
    expect(html).toContain('data-testid="node-onboarding-facts-pending"');
    expect(html).toContain("正在从当前工作空间读取");
    // 不知道连接状态时不能给「创建第一条转发」。
    expect(html).not.toContain('data-testid="node-create-forward-cta"');
  });

  test("降级（列表取不到）：给可重试提示，不冒充节点不存在", () => {
    const target = nodeOnboardingTargetFromProvision({
      node: provisionResponseNode(),
      enrollment,
    });
    const html = render(
      <NodeOnboarding
        target={target}
        view={emptyOnboardingView("list_unavailable")}
        onViewChange={() => undefined}
        canCreateForward
        workspaceId={1}
        scopeEpoch={1}
        open={false}
        onOpenChange={() => undefined}
        loadView={async () => emptyOnboardingView("list_unavailable")}
        createEnrollment={async () => enrollment}
        onRetryFacts={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="node-onboarding-degraded"');
    expect(html).toContain('data-testid="node-onboarding-retry"');
    expect(html).toContain('data-testid="node-next-step-list_unavailable"');
    expect(html).not.toContain('data-testid="node-onboarding-missing"');
  });
});

/* ================================================================== */
/* C. 重复 node 标识 + 新建确认                                         */
/* ================================================================== */

describe("重复 node 标识：提交前拦截，且说清后端「同名会重签」", () => {
  test("大小写不敏感地查出同名节点", () => {
    const rows = [userNode({ id: 7, node_id: "HK-Edge-01" })];
    expect(duplicateNodeIdConflict(rows, "hk-edge-01")?.id).toBe(7);
    expect(duplicateNodeIdConflict(rows, "HK-EDGE-01")?.id).toBe(7);
    expect(duplicateNodeIdConflict(rows, " hk-edge-01 ")?.id).toBe(7);
    expect(duplicateNodeIdConflict(rows, "hk-edge-02")).toBeNull();
    expect(duplicateNodeIdConflict(rows, "")).toBeNull();
    expect(checkNodeIdDuplicate(rows, "HK-edge-01")).toEqual({ kind: "conflict", nodeId: 7 });
    expect(checkNodeIdDuplicate(rows, "")).toEqual({ kind: "empty" });
    expect(checkNodeIdDuplicate(rows, "fresh")).toEqual({ kind: "ok" });
  });

  test("重名 / 列表未读到都不允许提交，且给出各自的禁用原因", () => {
    const base = {
      canManage: true,
      groupState: "ready" as const,
      nodeId: "hk-edge-01",
      groupId: "3",
      listRead: true,
      duplicate: false,
    };
    expect(canSubmitNodeCreation(base)).toBe(true);
    expect(canSubmitNodeCreation({ ...base, duplicate: true })).toBe(false);
    expect(canSubmitNodeCreation({ ...base, listRead: false })).toBe(false);
    // 旧调用方（不带新字段）保持原行为。
    expect(canSubmitNodeCreation({ canManage: true, groupState: "ready", nodeId: "a", groupId: "3" })).toBe(true);

    expect(nodeCreationBlockedReasonKey(base)).toBeNull();
    expect(nodeCreationBlockedReasonKey({ ...base, duplicate: true })).toBe("node.createBlockedDuplicate");
    expect(nodeCreationBlockedReasonKey({ ...base, listRead: false })).toBe(
      "node.createBlockedListUnavailable",
    );
    expect(nodeCreationBlockedReasonKey({ ...base, groupState: "empty" })).toBe("node.createBlockedGroupsEmpty");
    expect(nodeCreationBlockedReasonKey({ ...base, groupState: "error" })).toBe("node.createBlockedGroupsFailed");
    expect(nodeCreationBlockedReasonKey({ ...base, groupState: "loading" })).toBe(
      "node.createBlockedGroupsLoading",
    );
    expect(nodeCreationBlockedReasonKey({ ...base, canManage: false })).toBe("node.createBlockedPermission");
    expect(nodeCreationBlockedReasonKey({ ...base, nodeId: "  " })).toBe("node.createBlockedNodeId");
    expect(nodeCreationBlockedReasonKey({ ...base, groupId: "" })).toBe("node.createBlockedGroupId");
  });

  test("两种禁用原因在字典里都有非空文案（界面不会画出裸 key）", () => {
    for (const key of [
      "node.createBlockedDuplicate",
      "node.createBlockedListUnavailable",
      "node.createBlockedGroupsEmpty",
      "node.createBlockedGroupsFailed",
      "node.createBlockedGroupsLoading",
      "node.createBlockedPermission",
      "node.createBlockedNodeId",
      "node.createBlockedGroupId",
      "node.createDuplicateWarning",
      "node.createDuplicateBlocked",
    ]) {
      for (const dict of [zh, en]) {
        const text = makeT(dict)(key);
        expect(text).not.toBe(key);
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("新建确认正文：写明后端同名会重签、消费后换长期凭据", () => {
    const html = render(
      <NodeCreationConfirmBody
        nodeId="hk-edge-01"
        duplicateNodeId={null}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        pending={false}
      />,
    );
    expect(html).toContain('data-testid="node-create-confirm-node"');
    expect(html).toContain("hk-edge-01");
    expect(html).toContain('data-testid="node-create-confirm-reprovision"');
    expect(html).toContain("复用该节点并重新签发安装命令");
    expect(html).toContain("长期凭据");
    expect(html).toContain("并发创建");
    expect(html).toContain('data-testid="node-create-confirm-apply"');
    expect(html).not.toContain('data-testid="node-create-confirm-duplicate"');
  });

  test("新建确认正文：列表里已存在同名时额外点名那台节点", () => {
    const html = render(
      <NodeCreationConfirmBody
        nodeId="hk-edge-01"
        duplicateNodeId="HK-EDGE-01"
        onConfirm={() => undefined}
        onCancel={() => undefined}
        pending
      />,
    );
    expect(html).toContain('data-testid="node-create-confirm-duplicate"');
    expect(html).toContain("HK-EDGE-01");
    // pending 时确认按钮禁用（不会连点两次）。
    expect(isDisabled(buttonWith(html, "确认创建"))).toBe(true);
  });
});

/* ================================================================== */
/* D. 列表失败 ≠ 0 个节点                                               */
/* ================================================================== */

describe("节点列表加载状态：失败给显式错误 + 重试，不显示空态", () => {
  test("状态推导：失败优先于空；无权限给 denied", () => {
    expect(nodeListState({ canRead: false, loading: false, failed: false, count: 0 })).toBe("denied");
    expect(nodeListState({ canRead: true, loading: true, failed: false, count: 0 })).toBe("loading");
    expect(nodeListState({ canRead: true, loading: false, failed: true, count: 0 })).toBe("failed");
    expect(nodeListState({ canRead: true, loading: false, failed: true, count: 3 })).toBe("failed");
    expect(nodeListState({ canRead: true, loading: false, failed: false, count: 0 })).toBe("empty");
    expect(nodeListState({ canRead: true, loading: false, failed: false, count: 2 })).toBe("ready");
  });

  test("失败文案 / 重试文案在中英两本字典里都存在", () => {
    // `t()` 收到的是**去前缀**的键（I18nProvider 按命名空间解析），所以这里直接读字典。
    for (const key of ["listFailedSummary", "listFailedHint", "listRetry"] as const) {
      expect(zh.node[key].trim().length).toBeGreaterThan(0);
      expect(en.node[key].trim().length).toBeGreaterThan(0);
    }
    expect(zh.node.listFailedHint).toContain("不代表没有节点");
    expect(en.node.listFailedHint).toContain("does not mean you have no nodes");
  });
});

/* ================================================================== */
/* E. 作用域护栏：成功 / 失败 / finally 都要过闸                        */
/* ================================================================== */

describe("作用域护栏：晚到响应与敏感命令都不许跨作用域", () => {
  test("同一作用域内，被后继操作取代的旧响应算过期", () => {
    const scope = { workspaceId: 1, epoch: 4 };
    expect(operationIsStale({ ...scope, ticket: 2 }, { scope, ticketCurrent: (t) => t === 3 })).toBe(true);
    expect(operationIsStale({ ...scope, ticket: 3 }, { scope, ticketCurrent: (t) => t === 3 })).toBe(false);
  });

  test("切换 Workspace / 权限 epoch 前进后，旧响应一律过期（A→B→A 也不算回来）", () => {
    const started = { workspaceId: 1, epoch: 1, ticket: 1 };
    const ticketCurrent = () => true;
    expect(operationIsStale(started, { scope: { workspaceId: 2, epoch: 2 }, ticketCurrent })).toBe(true);
    // A→B→A：epoch 只增不减，回到 A 也不是同一个作用域。
    expect(operationIsStale(started, { scope: { workspaceId: 1, epoch: 3 }, ticketCurrent })).toBe(true);
    expect(operationIsStale(started, { scope: { workspaceId: 1, epoch: 1 }, ticketCurrent })).toBe(false);
  });

  test("适配器在作用域变化后抛错，不把旧 Workspace 的视图 / 命令交出去", async () => {
    let workspaceId = 1;
    const adapters = createUserOnboardingAdapters({
      listNodes: async () => {
        workspaceId = 2; // 取数途中切了 Workspace
        return [userNode({ connection: "online", has_credential: true, accepts_new_business: true })];
      },
      issueEnrollment: async () => {
        workspaceId = 3; // 签发途中又切了一次
        return enrollment;
      },
      scope: () => ({ workspaceId, epoch: 1 }),
      staleMessage: "作用域已变化",
    });
    await expect(adapters.loadView(7)).rejects.toThrow("作用域已变化");
    await expect(adapters.createEnrollment(7)).rejects.toThrow("作用域已变化");
  });

  test("作用域不变时原样返回：投影只搬运后端事实，签发结果不二次加工", async () => {
    const rows = [userNode({ connection: "online", has_credential: true, accepts_new_business: true })];
    const adapters = createUserOnboardingAdapters({
      listNodes: async () => rows,
      issueEnrollment: async (id) => {
        expect(id).toBe(7);
        return enrollment;
      },
      scope: () => ({ workspaceId: 1, epoch: 1 }),
      staleMessage: "作用域已变化",
    });
    const view = await adapters.loadView(7);
    expect(view.connection).toBe("online");
    expect(view.found).toBe(true);
    expect(view.read).toBe("loaded");
    expect(await adapters.createEnrollment(7)).toBe(enrollment);
  });

  test("列表里找不到该节点：投影成 found:false，不用旧快照冒充现值", () => {
    expect(onboardingViewFromRows([], 7)).toEqual({
      connection: null,
      has_credential: null,
      accepts_new_business: null,
      role: null,
      registered: null,
      found: false,
      read: "loaded",
    });
  });

  test("作用域 key 把 Workspace / 权限 epoch / 节点都编进去", () => {
    expect(onboardingScopeKey(1, 1, 7)).toBe("1:1:7");
    expect(onboardingScopeKey(1, 1, 7)).not.toBe(onboardingScopeKey(2, 1, 7));
    expect(onboardingScopeKey(1, 1, 7)).not.toBe(onboardingScopeKey(1, 2, 7));
    expect(onboardingScopeKey(1, 1, 7)).not.toBe(onboardingScopeKey(1, 1, 8));
    expect(onboardingScopeKey(null, 1, 7)).toBe("none:1:7");
  });

  test("每个异步操作的 catch/finally 都过 operationStale（源码守卫）", () => {
    const src = readFileSync(new URL("../node-workspace.tsx", import.meta.url), "utf8");
    // 关键操作：新建 / 重签签发 / 事实补齐。
    for (const marker of ["async function createNode", "async function applyRegenerate"]) {
      const start = src.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, start + 2600);
      expect(body).toContain("operationStale(started)");
      // catch 与 finally 两处都要有：
      expect(body.split("operationStale(started)").length - 1).toBeGreaterThanOrEqual(3);
    }
    // 事实补齐的 finally 同样受保护（晚到的 finally 不能解锁新请求的 busy）。
    const upgradeStart = src.indexOf("const upgradeFacts = useCallback");
    const upgradeBody = src.slice(upgradeStart, upgradeStart + 1400);
    expect(upgradeBody).toContain("operationStale(started)");
    expect(upgradeBody).toContain("finally");
    // 旧实现用 window.confirm 弹重签确认，已改为可访问的 Radix 确认框。
    expect(src).not.toContain("window.confirm");
    expect(src).not.toContain("confirm(reinstallConfirmMessage");
  });
});

/* ================================================================== */
/* F. 成功 CTA 决策                                                    */
/* ================================================================== */

describe("成功 CTA：四项条件缺一不可，缺了要说清为什么", () => {
  const base = {
    role: "ingress" as NodeRole,
    connection: "online" as const,
    acceptsNewBusiness: true,
    canCreateForward: true,
  };

  test("入口/双角色 + online + 准入通过 + forward:create → CTA", () => {
    expect(forwardCtaDecision(base)).toEqual({ kind: "cta" });
    expect(forwardCtaDecision({ ...base, role: "both" })).toEqual({ kind: "cta" });
  });

  test("出口节点 / 未声明角色：结构性原因，不指向不可创建的入口", () => {
    expect(forwardCtaDecision({ ...base, role: "egress" })).toEqual({ kind: "blocked", reason: "egress" });
    expect(forwardCtaDecision({ ...base, role: null })).toEqual({ kind: "blocked", reason: "undeclared_role" });
    expect(forwardCtaDecision({ ...base, role: undefined })).toEqual({
      kind: "blocked",
      reason: "undeclared_role",
    });
  });

  test("没有 forward:create：即便节点一切正常也不给 CTA", () => {
    expect(forwardCtaDecision({ ...base, canCreateForward: false })).toEqual({
      kind: "blocked",
      reason: "permission",
    });
    expect(forwardCtaDecision({ ...base, role: "egress", canCreateForward: false }).kind).toBe("blocked");
  });

  test("未上线：等待安装与「已安装但掉线」分开说（不把掉线说成安装失败）", () => {
    expect(forwardCtaDecision({ ...base, connection: "waiting" })).toEqual({
      kind: "blocked",
      reason: "awaiting_install",
    });
    expect(forwardCtaDecision({ ...base, connection: "offline" })).toEqual({
      kind: "blocked",
      reason: "not_connected_offline",
    });
    expect(forwardCtaDecision({ ...base, connection: null })).toEqual({
      kind: "blocked",
      reason: "unknown_connection",
    });
  });

  test("准入：false = 拒绝，undefined = 未知（不把没有结论说成被拒绝）", () => {
    expect(forwardCtaDecision({ ...base, acceptsNewBusiness: false })).toEqual({
      kind: "blocked",
      reason: "not_accepting",
    });
    expect(forwardCtaDecision({ ...base, acceptsNewBusiness: null })).toEqual({
      kind: "blocked",
      reason: "unknown_admission",
    });
    expect(forwardCtaDecision({ ...base, acceptsNewBusiness: undefined })).toEqual({
      kind: "blocked",
      reason: "unknown_admission",
    });
  });

  test("每一种原因在中英两本字典里都有非空文案（界面不会画出裸 key）", () => {
    expect(Object.keys(zh.node).sort()).toEqual(Object.keys(en.node).sort());
    for (const reason of FORWARD_CTA_BLOCKED_REASONS) {
      for (const translate of [makeT(zh), makeT(en)]) {
        const key = forwardCtaBlockedKey(reason);
        const text = translate(key);
        expect(text).not.toBe(key);
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("下一步结论：节点已不在列表 / 完全没有事实，都不落回「可创建」", () => {
    expect(onboardingNextStep({ ...onlineView, found: false }, true)).toEqual({ kind: "missing" });
    expect(onboardingNextStep(null, true)).toEqual({ kind: "blocked", reason: "unknown_connection" });
    expect(onboardingNextStep(onlineView, true)).toEqual({ kind: "cta" });
    expect(onboardingNextStep(onlineView, false)).toEqual({ kind: "blocked", reason: "permission" });
  });
});

/* ================================================================== */
/* G. 节点页（页面级）                                                  */
/* ================================================================== */

describe("节点页：无组/只读/失败都先给真话，而不是让用户撞进死路", () => {
  test("可管理但没有任何节点组：页面给出说明 + 不闪「无组」，创建按钮禁用", () => {
    const html = renderPage();
    // 组加载初值按 canManage 给 true：首帧是 loading，不是「无组」。
    expect(html).toContain('data-testid="node-group-loading"');
    expect(html).not.toContain('data-testid="node-group-empty"');
    expect(html).not.toContain('data-testid="node-group-error"');
    expect(isDisabled(buttonWith(html, "创建节点"))).toBe(true);
    // 还在加载组时不给建组入口（此时还不知道是否已有组），也不给假的申请入口。
    expect(html).not.toContain('data-testid="node-group-create-entry"');
    expect(html).not.toContain("/node-groups");
  });

  test("无组空态给出**真的**自助建组入口，且不说「管理员专属」", () => {
    const html = render(
      <NodeGroupPrerequisite state="empty" onRetry={() => undefined} onCreateGroup={() => undefined} />,
    );
    expect(html).toContain('data-testid="node-group-empty"');
    // 文案说清「默认策略允许、可以在本页直接建」，而不是让人去等一个不需要的管理员。
    expect(html).toContain("默认策略允许");
    expect(html).toContain("本页");
    // 真的入口：按钮存在且可点（提交走用户域 API，entitlement 由后端裁决）。
    expect(html).toContain('data-testid="node-group-create-entry"');
    expect(html).toContain("创建节点池");
    // 空不是失败：给的是说明与动作，而不是重试噪音。
    expect(html).not.toContain('data-testid="node-groups-retry"');
    // 不伪造页面跳转：这里是原地打开最小表单的按钮，没有 <a> 链接。
    expect(html).not.toContain("<a ");
  });

  test("没有自助入口回调时只给说明（只读 persona 更是一个字都不给）", () => {
    const html = render(<NodeGroupPrerequisite state="empty" onRetry={() => undefined} />);
    expect(html).toContain('data-testid="node-group-empty"');
    expect(html).not.toContain('data-testid="node-group-create-entry"');
  });

  test("加载失败：以 alert 呈现失败，并给可点击的重试（不是把按钮永久锁死）", () => {
    const html = render(<NodeGroupPrerequisite state="error" onRetry={() => undefined} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("节点池加载失败");
    expect(html).toContain("重新加载节点池");
  });

  test("就绪时什么都不渲染", () => {
    expect(render(<NodeGroupPrerequisite state="ready" onRetry={() => undefined} />)).toBe("");
  });

  test("创建按钮禁用时旁边有原因（只读 → 权限，未就绪 → 组）", () => {
    expect(nodeCreateDisabledReasonKey({ canManage: false, groupState: "ready" })).toBe(
      "node.createBlockedPermission",
    );
    expect(nodeCreateDisabledReasonKey({ canManage: true, groupState: "loading" })).toBe(
      "node.createBlockedGroupsLoading",
    );
    expect(nodeCreateDisabledReasonKey({ canManage: true, groupState: "error" })).toBe(
      "node.createBlockedGroupsFailed",
    );
    expect(nodeCreateDisabledReasonKey({ canManage: true, groupState: "empty" })).toBe(
      "node.createBlockedGroupsEmpty",
    );
    expect(nodeCreateDisabledReasonKey({ canManage: true, groupState: "ready" })).toBeNull();

    // 页面上真的渲染了原因（只读用户看到的不是一句「权限不足」而已）。
    const readonlyHtml = renderPage({ canManage: false, can: (key) => key === "node:read" });
    expect(readonlyHtml).toContain('data-testid="node-create-disabled-reason"');
    // 可管理但组还没就绪：首帧给「正在加载节点组」，不闪「无组」。
    const managerHtml = renderPage();
    expect(managerHtml).toContain('data-testid="node-create-disabled-reason"');
    expect(managerHtml).toContain("正在加载节点池");
  });

  test("persona：只读用户不会被前置条件打扰（也不被当成管理员）", () => {
    expect(nodeGroupPrerequisitePersona({ canManage: true, canRead: true })).toBe("manager");
    expect(nodeGroupPrerequisitePersona({ canManage: false, canRead: true })).toBe("readonly");
    expect(nodeGroupPrerequisitePersona({ canManage: false, canRead: false })).toBe("denied");
    expect(render(<NodeGroupPrerequisite state="empty" persona="readonly" />)).toBe("");
  });

  test("只读用户的空态：说清权限原因与联系人，不叫他去「创建节点」", () => {
    const html = renderPage({ canManage: false, can: (key) => key === "node:read" });
    expect(html).toContain('data-testid="node-readonly-empty-title"');
    expect(html).toContain('data-testid="node-readonly-empty-hint"');
    expect(html).toContain("node:manage");
    expect(html).toContain("工作空间管理员");
    // 不给创建入口，也不显示前置条件。
    expect(isDisabled(buttonWith(html, "创建节点"))).toBe(true);
    expect(html).not.toContain('data-testid="node-group-empty"');
    expect(html).not.toContain('data-testid="node-groups-retry"');
  });

  test("只读空态组件本身：标题 + 权限原因（中英都要有人话）", () => {
    const html = render(<NodeReadonlyEmptyState />);
    expect(html).toContain('data-testid="node-readonly-empty-title"');
    expect(html).toContain('data-testid="node-readonly-empty-hint"');
    expect(zh.node.readonlyEmptyHint).toContain("node:manage");
    expect(en.node.readonlyEmptyHint).toContain("node:manage");
    const enHtml = render(<NodeReadonlyEmptyState />, "en");
    expect(enHtml).toContain(en.node.readonlyEmptyTitle);
  });

  test("没有 node:read：整页只给权限说明，不渲染节点数据", () => {
    const html = renderPage({ can: () => false });
    expect(html).toContain('role="alert"');
    expect(html).toContain("权限不足");
    expect(html).not.toContain('data-testid="node-group-empty"');
  });

  test("还没开始接入时，页面上没有接入面板（不预先渲染空命令）", () => {
    const html = renderPage();
    expect(html).not.toContain('data-testid="node-onboarding"');
    expect(html).not.toContain("install.sh");
  });

  test("节点组未就绪时创建按钮禁用（同一状态推导，不靠渲染时序）", () => {
    expect(nodeGroupState({ canManage: true, loading: true, failed: false, count: 0 })).toBe("loading");
    expect(nodeGroupState({ canManage: true, loading: false, failed: true, count: 0 })).toBe("error");
    expect(nodeGroupState({ canManage: true, loading: false, failed: false, count: 0 })).toBe("empty");
    expect(nodeGroupState({ canManage: true, loading: false, failed: false, count: 2 })).toBe("ready");
    expect(nodeGroupState({ canManage: false, loading: false, failed: false, count: 0 })).toBe("ready");
  });
});

/* ================================================================== */
/* H. 页面级面板渲染                                                    */
/* ================================================================== */

describe("页面级接入面板：命令对话框关掉也仍在等，只给真实下一步", () => {
  const target: NodeOnboardingTarget = {
    node: userNode(),
    enrollment,
    initialView: userNodeOnboardingView(userNode()),
  };

  function renderPanel(view: UserNodeOnboardingView | null, canCreateForward = true) {
    return render(
      <NodeOnboarding
        target={target}
        view={view}
        onViewChange={() => undefined}
        canCreateForward={canCreateForward}
        workspaceId={1}
        scopeEpoch={1}
        open={false}
        onOpenChange={() => undefined}
        loadView={async () => view ?? waitingView}
        createEnrollment={async () => enrollment}
      />,
    );
  }

  test("命令对话框关闭时，面板仍在（等待属于页面级状态）且一次性命令不在 DOM 里", () => {
    const html = renderPanel(waitingView);
    expect(html).toContain('data-testid="node-onboarding"');
    expect(html).toContain("hk-edge-01");
    expect(html).not.toContain("one-time-token");
    expect(html).not.toContain("install.sh");
  });

  test("waiting：说「等安装成功」，不谎报失败也不给创建入口", () => {
    const html = renderPanel(waitingView);
    expect(html).toContain('data-testid="node-next-step-awaiting_install"');
    expect(html).not.toContain('data-testid="node-create-forward-cta"');
    expect(html).not.toContain("href=\"/forwards?ingress_node_id=");
  });

  test("offline（已安装但掉线）：说清是连接问题，不是安装问题", () => {
    const html = renderPanel(offlineView);
    expect(html).toContain('data-testid="node-next-step-not_connected_offline"');
    expect(html).toContain("不是安装问题");
    expect(html).not.toContain('data-testid="node-create-forward-cta"');
  });

  test("online + 入口 + 准入通过 + forward:create：给真实的 CTA 链接", () => {
    const html = renderPanel(onlineView);
    expect(html).toContain('data-testid="node-create-forward-cta"');
    expect(html).toContain("href=\"/forwards?ingress_node_id=7\"");
    expect(html).toContain("创建第一条转发");
    expect(html.split('data-testid="node-create-forward-cta"').length - 1).toBe(1);
  });

  test("online 但出口节点：给准确说明，不指向不可创建的入口", () => {
    const html = renderPanel({ ...onlineView, role: "egress" });
    expect(html).toContain('data-testid="node-next-step-egress"');
    expect(html).toContain("出口节点");
    expect(html).not.toContain('data-testid="node-create-forward-cta"');
  });

  test("online 但准入未通过 / 无准入结论：不给 CTA，两种原因说法不同", () => {
    const rejected = renderPanel({ ...onlineView, accepts_new_business: false });
    expect(rejected).toContain('data-testid="node-next-step-not_accepting"');
    expect(rejected).not.toContain('data-testid="node-create-forward-cta"');

    const unknown = renderPanel({ ...onlineView, accepts_new_business: null });
    expect(unknown).toContain('data-testid="node-next-step-unknown_admission"');
    expect(unknown).not.toContain('data-testid="node-create-forward-cta"');
    expect(unknown).not.toBe(rejected);
  });

  test("没有 forward:create：不给 CTA，并说明是权限问题", () => {
    const html = renderPanel(onlineView, false);
    expect(html).toContain('data-testid="node-next-step-permission"');
    expect(html).toContain("forward:create");
    expect(html).not.toContain('data-testid="node-create-forward-cta"');
  });

  test("节点已不在列表：如实说明，不冒充在线", () => {
    const html = renderPanel({ ...onlineView, found: false });
    expect(html).toContain('data-testid="node-onboarding-missing"');
    expect(html).not.toContain('data-testid="node-create-forward-cta"');
  });

  test("视图缺失（未取到事实）：按「未知」处理，不显示任何成功项", () => {
    const html = renderPanel(null);
    expect(html).toContain('data-testid="node-next-step-unknown_connection"');
    expect(html).not.toContain('data-testid="node-create-forward-cta"');
  });

  test("屏幕阅读器：下一步结论带 aria-live（轮询把它从等待推到在线时能被播报）", () => {
    expect(renderPanel(waitingView)).toContain('aria-live="polite"');
    expect(renderPanel(onlineView)).not.toContain('data-testid="node-next-step-');
  });

  test("英文环境渲染英文下一步（词条真的被用上）", () => {
    const html = render(
      <NodeOnboarding
        target={target}
        view={onlineView}
        onViewChange={() => undefined}
        canCreateForward
        workspaceId={1}
        scopeEpoch={1}
        open={false}
        onOpenChange={() => undefined}
        loadView={async () => onlineView}
        createEnrollment={async () => enrollment}
      />,
      "en",
    );
    expect(html).toContain("Create the first forward");
  });
});

/* ================================================================== */
/* I. 命令有效期只派生展示（不误报）                                     */
/* ================================================================== */

describe("命令过期：只对「还在等安装」有意义", () => {
  test("过期判定只看 expires_at，不猜令牌是否被消费", () => {
    const now = Date.parse("2026-10-06T00:20:00.000Z");
    expect(installCommandExpired("2026-10-06T00:15:00.000Z", now)).toBe(true);
    expect(installCommandExpired("2026-10-06T00:30:00.000Z", now)).toBe(false);
    expect(installCommandExpired(null, now)).toBe(false);
    expect(installCommandExpired("not-a-date", now)).toBe(false);
  });

  test("阶段来自服务端投影：waiting→awaiting_install，拿到凭据的 offline→installed_offline", () => {
    expect(installPhase({ connection: "waiting" })).toBe("awaiting_install");
    expect(installPhase({ connection: "offline", has_credential: true })).toBe("installed_offline");
    expect(installPhase({ connection: "offline", has_credential: false })).toBe("awaiting_install");
    expect(installPhase({ connection: "online" })).toBe("online");
    expect(installPhase({ connection: null })).toBe("unknown");
    expect(installPhase(null)).toBe("unknown");
  });

  test("重签确认键与视图键都存在（不会渲染出裸 key）", () => {
    expect(REINSTALL_CONFIRM_KEYS.unknown).toBe("node.reinstallConfirmUnknown");
    expect(reinstallConfirmKey(null)).toBe("node.reinstallConfirmUnknown");
    for (const key of Object.values(REINSTALL_CONFIRM_KEYS).concat([
      "node.reinstallConfirmCredential",
      "node.reinstallConfirmOffline",
    ])) {
      expect(makeT(zh)(key)).not.toBe(key);
      expect(makeT(en)(key)).not.toBe(key);
    }
  });
});

/* ================================================================== */
/* J. 同一动作只有一个称呼：入口按钮 / 弹窗标题 / 提交按钮                 */
/* ================================================================== */

/**
 * 真实浏览器实测（修复前，中文界面）暴露的第三个称呼：
 * 空态入口按钮「创建节点」、弹窗标题「创建节点」，但弹窗**提交按钮**是通用词
 * 「新建」（源码里提交按钮用 `common.create`，入口与标题用 `node.create`）。
 * 同一动作三种称呼（两处一致、一处不同）会让用户以为在点两件不同的事。
 *
 * 测法：`DialogContent` 在 Radix Portal 里，静态渲染不产出 DOM（已知坑），所以
 * 抽出的纯展示正文 `NodeCreateDialogBody` 外面只包 `Dialog`（Root，无 Portal），
 * 直接断言标题与提交按钮；入口按钮仍从真实页面渲染里取。
 */
describe("创建节点：入口按钮 / 弹窗标题 / 提交按钮同源", () => {
  const group = {
    id: 3,
    token: "tok",
    name: "默认入口组",
    port_range: "20000-30000",
    connect_ip: null,
    node_type: "in",
    load_balance_type: "round_robin",
    allow_listen_protocol: true,
    allow_listen_protocols: null,
    allow_tunnel_types: null,
    bypass_type: "none",
    bypass_list: null,
    admission: true,
    block_protocols: null,
    traffic_rate: 1,
    need_out_node_group: false,
    allow_out_node_groups: null,
    allow_in_node_groups: null,
    order_by: 0,
    user_id: 1,
    created_at: "2026-10-06T00:00:00.000Z",
    updated_at: "2026-10-06T00:00:00.000Z",
  } as NodeGroup;

  /** 去掉标签后的按钮文字（含图标按钮）与弹窗标题文字。 */
  function buttonText(html: string, label: string): string {
    return buttonWith(html, label).replace(/<[^>]*>/g, "").trim();
  }
  function dialogTitleText(html: string): string {
    return (html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) ?? ["", ""])[1]!.replace(/<[^>]*>/g, "").trim();
  }

  function renderCreateBody(locale: Locale = "zh", over: Partial<NodeCreateDialogBodyProps> = {}) {
    return render(
      <Dialog open>
        <NodeCreateDialogBody
          nodeId="hk-edge-01"
          onNodeIdChange={() => undefined}
          duplicateNodeId={null}
          groups={[group]}
          groupId="3"
          onGroupChange={() => undefined}
          nodeRole="ingress"
          onRoleChange={() => undefined}
          groupState="ready"
          prerequisitePersona="manager"
          onRetryGroups={() => undefined}
          submitEnabled
          blockedReasonKey={null}
          pending={false}
          onCancel={() => undefined}
          onSubmit={() => undefined}
          {...over}
        />
      </Dialog>,
      locale,
    );
  }

  test("中文：三处都是「创建节点」，提交按钮不再是通用词「新建」", () => {
    const entry = buttonText(renderPage(), zh.node.create);
    const body = renderCreateBody("zh");
    expect(entry).toBe(zh.node.create);
    expect(dialogTitleText(body)).toBe(zh.node.create);
    expect(buttonText(body, zh.node.create)).toBe(zh.node.create);
    // 同一个动作只有一种称呼：不许退回 `common.create`（「新建」）。
    expect(zh.common.create).toBe("新建");
    expect(entry).not.toBe(zh.common.create);
    expect(buttonText(body, zh.node.create)).not.toBe(zh.common.create);
  });

  test("英文：三处都是 Create node，提交按钮不再是通用词 Create", () => {
    const entry = buttonText(renderPage({}, "en"), en.node.create);
    const body = renderCreateBody("en");
    expect(entry).toBe(en.node.create);
    expect(dialogTitleText(body)).toBe(en.node.create);
    expect(buttonText(body, en.node.create)).toBe(en.node.create);
    expect(zh.node.create).not.toBe(en.node.create);
  });

  test("称呼来自字典且两本都非空、不产生裸 key", () => {
    for (const dict of [zh, en]) {
      const label = makeT(dict)("node.create");
      expect(label).not.toBe("node.create");
      expect(label.trim().length).toBeGreaterThan(0);
      expect(dict.common.close.trim().length).toBeGreaterThan(0);
    }
  });

  test("正文抽成纯展示组件后接线不变：取消、禁用原因、pending 禁用提交", () => {
    const ready = renderCreateBody();
    expect(buttonText(ready, zh.common.cancel)).toBe(zh.common.cancel);
    expect(isDisabled(buttonWith(ready, zh.node.create))).toBe(false);

    // 禁用的按钮旁边必须有原因（与修复前同一条行为）。
    const blocked = renderCreateBody("zh", {
      submitEnabled: false,
      blockedReasonKey: "node.createBlockedNodeId",
    });
    expect(blocked).toContain('data-testid="node-create-blocked-reason"');
    expect(blocked).toContain(zh.node.createBlockedNodeId);
    expect(isDisabled(buttonWith(blocked, zh.node.create))).toBe(true);

    // 提交在途：不许连点两次。
    const pending = renderCreateBody("zh", { pending: true });
    expect(isDisabled(buttonWith(pending, zh.node.create))).toBe(true);
  });

  test("重名警告与 aria-invalid 仍由正文渲染（不再依赖父级 duplicate 枚举）", () => {
    const html = renderCreateBody("zh", { duplicateNodeId: "HK-EDGE-01" });
    expect(html).toContain('data-testid="node-create-duplicate"');
    expect(html).toContain("HK-EDGE-01");
    expect(html).toContain('aria-invalid="true"');
    // 没有重名时不显示警告，也不标 invalid。
    const clean = renderCreateBody();
    expect(clean).not.toContain('data-testid="node-create-duplicate"');
    expect(clean).not.toContain('aria-invalid="true"');
  });
});
