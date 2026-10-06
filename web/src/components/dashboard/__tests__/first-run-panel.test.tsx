/**
 * R2 First-run —— Dashboard「下一步」面板的**行为**测试（渲染 + 纯异步，无浏览器）。
 *
 * 面板分两层，两层都被真实断言：
 *
 *   A. `FirstRunCard`（纯展示）：每一种结论渲染出什么——CTA、href、文案、以及
 *      「只读账户不给必失败按钮」「取不到不说一切正常」这两条纪律；
 *   B. `loadFirstRunFacts`（状态容器的加载器）：**切 Workspace / 权限变化 / 被后继
 *      请求取代的晚到响应必须被丢弃**（包括晚到的失败 —— 旧作用域的错误提示同样是越界）。
 *
 * 为什么不直接渲染 `FirstRunPanel`：它依赖 `useEffect` 取数，静态渲染只能拿到
 * loading 帧（本仓既有的 I1 测试出于同一原因把面板拆成纯展示 + 纯逻辑两层，
 * 并在 I1-C 里用真实浏览器补组件级证据）。
 *
 * 跑法（web 目录）：bun test src/components/dashboard/__tests__/first-run-panel.test.tsx
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import {
  FirstRunCard,
  loadFirstRunFacts,
  type FirstRunLoaderDeps,
  type FirstRunPanelState,
} from "@/components/dashboard/first-run-panel";
import { ApiError } from "@/lib/api/core";
import type { WorkspaceCapabilities } from "@/lib/api/capabilities";
import { createPermissionRequestFence } from "@/lib/workspace-permissions";
import { deriveFirstRunStep, type FirstRunDecision, type FirstRunFacts } from "@/lib/first-run";
import { en, zh } from "@/lib/i18n/dictionaries";
import type { Locale } from "@/lib/i18n";

/* ================================================================== */
/* helpers                                                             */
/* ================================================================== */

function renderCard(
  state: FirstRunPanelState,
  over: Partial<{ canCreateForward: boolean; locale: Locale; refreshing: boolean }> = {},
): string {
  const locale = over.locale ?? "zh";
  return renderToStaticMarkup(
    <I18nProvider locale={locale} dict={locale === "en" ? en : zh}>
      <FirstRunCard
        state={state}
        canCreateForward={over.canCreateForward ?? true}
        refreshing={over.refreshing ?? false}
        onRetry={() => undefined}
        onCreateGroup={() => undefined}
      />
    </I18nProvider>,
  );
}

const caps = (over: Partial<WorkspaceCapabilities> = {}): WorkspaceCapabilities => ({
  allow_custom_in_group: true,
  allow_custom_out_group: false,
  max_nodes: 1,
  nodes_used: 0,
  max_tunnels: 2,
  tunnels_used: 0,
  policy_missing: false,
  deny_message: null,
  ...over,
});

const facts = (over: Partial<FirstRunFacts> = {}): FirstRunFacts => ({
  canManageNodes: true,
  groups: 0,
  nodes: 0,
  forwards: 0,
  capabilities: caps(),
  ...over,
});

const ready = (decision: FirstRunDecision, over: Partial<FirstRunFacts> = {}): FirstRunPanelState => ({
  kind: "ready",
  decision,
  facts: facts(over),
});

/* ================================================================== */
/* A. 每种结论的 CTA / 文案 / href                                       */
/* ================================================================== */

describe("A. 结论 → 可执行的下一步", () => {
  test("create_group：原地打开最小建组表单（按钮存在、不是跳转链接）", () => {
    const html = renderCard(ready({ step: "create_group" }));
    expect(html).toContain('data-first-run-state="ready:create_group"');
    expect(html).toContain(zh.firstRun.createGroupTitle);
    expect(html).toContain(zh.firstRun.createGroupHint);
    expect(html).toContain('data-testid="first-run-create-group"');
    expect(html).toContain(zh.firstRun.createGroupAction);
    // 不跳走：建组必须原地可完成（跳 /nodes 还要用户自己再找一次入口）。
    expect(html).not.toContain('data-testid="first-run-link-create_group"');
  });

  test("add_node：给出真的 /nodes 链接（带权限时是可执行动作）", () => {
    const html = renderCard(ready({ step: "add_node" }));
    expect(html).toContain('data-first-run-state="ready:add_node"');
    expect(html).toContain('href="/nodes"');
    expect(html).toContain('data-testid="first-run-link-add_node"');
    expect(html).toContain(zh.firstRun.addNodeAction);
    expect(html).toContain(zh.firstRun.addNodeHint);
  });

  test("create_forward：给出真的 /forwards 链接", () => {
    const html = renderCard(ready({ step: "create_forward" }));
    expect(html).toContain('data-first-run-state="ready:create_forward"');
    expect(html).toContain('href="/forwards"');
    expect(html).toContain(zh.firstRun.createForwardAction);
  });

  test("只读账户（无 node:manage）：改说权限真话，链接降级为「查看节点」", () => {
    const html = renderCard(ready({ step: "add_node" }, { canManageNodes: false }));
    expect(html).toContain(zh.firstRun.addNodeHintPermission);
    expect(html).toContain(zh.firstRun.viewNodes);
    expect(html).not.toContain(zh.firstRun.addNodeHint);
    expect(html).toContain('href="/nodes"');
  });

  test("无 forward:create：改说权限真话，链接降级为「查看转发」", () => {
    const html = renderCard(ready({ step: "create_forward" }), { canCreateForward: false });
    expect(html).toContain(zh.firstRun.createForwardHintPermission);
    expect(html).toContain(zh.firstRun.viewForwards);
    expect(html).not.toContain(zh.firstRun.createForwardHint);
  });

  test("need_operator：两种原因各说各的真话，且**不给任何动作入口**（只有刷新）", () => {
    const permission = renderCard(ready({ step: "need_operator", reason: "permission" }));
    expect(permission).toContain(zh.firstRun.needOperatorHintPermission);
    expect(permission).not.toContain(zh.firstRun.needOperatorHintPolicy);
    expect(permission).not.toContain('data-testid="first-run-create-group"');
    expect(permission).not.toContain('data-testid="first-run-link-add_node"');
    expect(permission).not.toContain("<a ");

    const policy = renderCard(ready({ step: "need_operator", reason: "policy_not_granted" }));
    expect(policy).toContain(zh.firstRun.needOperatorHintPolicy);
    expect(policy).not.toContain(zh.firstRun.needOperatorHintPermission);
    expect(policy).not.toContain('data-testid="first-run-create-group"');
    expect(policy).not.toContain("<a ");
  });

  test("done：不再渲染任何东西（首启引导结束，不打扰）", () => {
    expect(renderCard(ready({ step: "done" }, { groups: 1, nodes: 2, forwards: 1 }))).toBe("");
  });

  test("额度行来自 capabilities 安全投影；取不到就不显示（不写「不限」）", () => {
    const withQuota = renderCard(ready({ step: "add_node" }, { groups: 1, capabilities: caps({ nodes_used: 1, max_nodes: 1, tunnels_used: 0, max_tunnels: 2 }) }));
    expect(withQuota).toContain('data-testid="first-run-quota"');
    expect(withQuota).toContain("1 / 1");
    expect(withQuota).toContain("0 / 2");

    const unknownQuota = renderCard(ready({ step: "add_node" }, { groups: 1, capabilities: null }));
    expect(unknownQuota).not.toContain('data-testid="first-run-quota"');
    expect(unknownQuota).not.toContain(zh.common.unlimited);
  });

  test("语言切换：同样的事实，中英两套文案（不是硬编码一边）", () => {
    const zhHtml = renderCard(ready({ step: "create_forward" }), { locale: "zh" });
    const enHtml = renderCard(ready({ step: "create_forward" }), { locale: "en" });
    expect(zhHtml).toContain(zh.firstRun.createForwardTitle);
    expect(enHtml).toContain(en.firstRun.createForwardTitle);
    expect(enHtml).not.toContain(zh.firstRun.createForwardTitle);
    expect(zh.firstRun.createForwardTitle).not.toBe(en.firstRun.createForwardTitle);
  });
});

/* ================================================================== */
/* B. 三态（loading / degraded / unknown）                              */
/* ================================================================== */

describe("B. 「取不到」永远不是「一切正常」", () => {
  test("loading：说明正在确认，不给任何结论", () => {
    const html = renderCard({ kind: "loading" });
    expect(html).toContain('data-first-run-state="loading"');
    expect(html).toContain(zh.firstRun.loading);
    expect(html).not.toContain(zh.firstRun.createGroupAction);
    expect(html).not.toContain(zh.firstRun.doneHint);
  });

  test("degraded（取数失败）：明说无法确认 + 给手动重试，不显示完成", () => {
    const html = renderCard({ kind: "degraded", reason: "fetch" });
    expect(html).toContain('data-first-run-state="degraded"');
    expect(html).toContain('data-degraded-reason="fetch"');
    expect(html).toContain(zh.firstRun.degradedTitle);
    expect(html).toContain(zh.firstRun.degradedHint);
    expect(html).toContain('data-testid="first-run-retry"');
    expect(html).not.toContain(zh.firstRun.unknownTitle);
  });

  test("degraded（403 权限）：说的是权限真话（重试无用，要找管理员），与取数失败分开", () => {
    const html = renderCard({ kind: "degraded", reason: "permission" });
    expect(html).toContain('data-degraded-reason="permission"');
    expect(html).toContain(zh.firstRun.degradedPermissionHint);
    expect(html).not.toContain(zh.firstRun.degradedHint);
  });

  test("unknown（事实缺失）：明说缺少事实、不代表已完成 + 可重试", () => {
    const html = renderCard({ kind: "ready", decision: { step: "unknown", missing: ["groups"] }, facts: facts({ groups: null }) });
    expect(html).toContain('data-first-run-state="unknown"');
    expect(html).toContain(zh.firstRun.unknownHint);
    expect(html).toContain('data-testid="first-run-retry"');
    expect(html).not.toContain(zh.firstRun.createGroupAction);
  });
});

/* ================================================================== */
/* C. 加载器：作用域与晚到响应                                           */
/* ================================================================== */

interface Harness {
  deps: FirstRunLoaderDeps;
  scope: { workspaceId: number | null; epoch: number };
  setScope: (next: { workspaceId: number | null; epoch: number }) => void;
}

function harness(over: Partial<FirstRunLoaderDeps> = {}): Harness {
  const scope = { workspaceId: 1, epoch: 1 };
  const fence = createPermissionRequestFence();
  const deps: FirstRunLoaderDeps = {
    fetchCounts: async () => ({ groups: 0, nodes: 0, forwards: 0 }),
    fetchCapabilities: async () => caps(),
    scope: () => ({ ...scope }),
    fence,
    ...over,
  };
  return {
    deps,
    scope,
    setScope: (next) => {
      scope.workspaceId = next.workspaceId;
      scope.epoch = next.epoch;
    },
  };
}

/** 手动控制完成时刻的 promise。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("C. loadFirstRunFacts：作用域护栏", () => {
  test("成功：事实齐全时返回 counts + capabilities + 权限", async () => {
    const h = harness({
      fetchCounts: async () => ({ groups: 1, nodes: 0, forwards: 0 }),
    });
    const result = await loadFirstRunFacts({ canManageNodes: true }, h.deps);
    expect(result.kind).toBe("facts");
    if (result.kind === "facts") {
      expect(result.facts).toEqual({
        canManageNodes: true,
        groups: 1,
        nodes: 0,
        forwards: 0,
        capabilities: caps(),
      });
      // 端到端：拿到的事实可以直接派生下一步。
      expect(deriveFirstRunStep(result.facts)).toEqual({ step: "add_node" });
    }
  });

  test("切 Workspace：在途成功响应被丢弃（stale，不返回旧空间的事实）", async () => {
    const pending = deferred<{ groups: number; nodes: number; forwards: number }>();
    const h = harness({ fetchCounts: () => pending.promise });
    const started = loadFirstRunFacts({ canManageNodes: true }, h.deps);
    // 响应还没回来，用户切到了另一个工作空间。
    h.setScope({ workspaceId: 2, epoch: 2 });
    pending.resolve({ groups: 3, nodes: 3, forwards: 3 });
    expect(await started).toEqual({ kind: "stale" });
  });

  test("同样的 workspace、权限 epoch 前进（A→B→A）：旧响应同样丢弃", async () => {
    const pending = deferred<WorkspaceCapabilities>();
    const h = harness({ fetchCapabilities: () => pending.promise, fetchCounts: async () => ({ groups: 1, nodes: 1, forwards: 1 }) });
    const started = loadFirstRunFacts({ canManageNodes: true }, h.deps);
    h.setScope({ workspaceId: 1, epoch: 2 }); // 回到同一个空间，但权限刻度已变
    pending.resolve(caps());
    expect(await started).toEqual({ kind: "stale" });
  });

  test("被后继请求取代（同一 fence）：先发的那次结果丢弃，不让旧结果顶掉新结果", async () => {
    const first = deferred<{ groups: number; nodes: number; forwards: number }>();
    const second = deferred<{ groups: number; nodes: number; forwards: number }>();
    let call = 0;
    const h = harness({
      fetchCounts: () => {
        call += 1;
        return call === 1 ? first.promise : second.promise;
      },
    });
    const firstRun = loadFirstRunFacts({ canManageNodes: true }, h.deps);
    const secondRun = loadFirstRunFacts({ canManageNodes: true }, h.deps);
    second.resolve({ groups: 5, nodes: 5, forwards: 1 });
    const secondResult = await secondRun;
    expect(secondResult.kind).toBe("facts");
    if (secondResult.kind === "facts") expect(secondResult.facts.groups).toBe(5);
    // 第一次的响应晚到：必须 stale，而不是把 groups 覆盖回 0。
    first.resolve({ groups: 0, nodes: 0, forwards: 0 });
    expect(await firstRun).toEqual({ kind: "stale" });
  });

  test("晚到的失败也要丢弃：旧作用域的错误不该弹在新作用域上", async () => {
    const pending = deferred<{ groups: number; nodes: number; forwards: number }>();
    const h = harness({ fetchCounts: () => pending.promise });
    const started = loadFirstRunFacts({ canManageNodes: true }, h.deps);
    h.setScope({ workspaceId: 9, epoch: 4 });
    pending.reject(new ApiError(500, "旧空间炸了", {}));
    expect(await started).toEqual({ kind: "stale" });
  });

  test("失败：403 与其它错误分开（界面据此说「权限」还是「暂时取不到」）", async () => {
    const forbidden = harness({
      fetchCapabilities: async () => {
        throw new ApiError(403, "工作空间角色无权操作", { code: "permission_denied" });
      },
    });
    expect(await loadFirstRunFacts({ canManageNodes: true }, forbidden.deps)).toEqual({
      kind: "failed",
      status: 403,
      message: "工作空间角色无权操作",
    });

    const offline = harness({
      fetchCounts: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(await loadFirstRunFacts({ canManageNodes: true }, offline.deps)).toEqual({
      kind: "failed",
      status: null,
      message: "Failed to fetch",
    });
  });

  test("权限事实未知（canManageNodes = null）：照样把事实取回来，由派生层判 unknown", async () => {
    const h = harness({ fetchCounts: async () => ({ groups: 0, nodes: 0, forwards: 0 }) });
    const result = await loadFirstRunFacts({ canManageNodes: null }, h.deps);
    expect(result.kind).toBe("facts");
    if (result.kind === "facts") {
      expect(result.facts.canManageNodes).toBeNull();
      expect(deriveFirstRunStep(result.facts)).toEqual({ step: "unknown", missing: ["node_permission"] });
    }
  });
});
