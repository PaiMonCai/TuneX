/**
 * Forward「DNS 前门」卡片的**渲染行为**测试（`renderToStaticMarkup` 渲染真实 JSX）。
 *
 * 断言的是用户能看见、且最容易说错的事实：
 *   ① 五态文案分别可辨，**只有 synced 出现「已切换」**；synced_unverified 说「已写入，尚未确认」；
 *   ② 「将于 X 重试」读服务端的 `next_attempt_at`，`auto_resolve=false` 时说「不会自动重试」；
 *   ③ `connect_ip` 为空（期望地址集为空）⇒ 明说不可用，**不出现任何猜测地址**；
 *   ④ 取不到 / 读不出来 / 权限未定 / 确实没权限是四个不同分支，且都不冒充「未绑定」；
 *   ⑤ 首发不开的口子确实不存在：无 CNAME 选项、无 multi_entry 入口、无 TTL；
 *   ⑥ 服务商列表读不到（≠ 空列表）时说"读不到"。
 *
 * 静态渲染下 `useEffect` 不执行，所以"取数后的各分支"用导出的纯展示体
 * `ForwardDnsCardBody` 枚举；"首帧"用真实组件 `ForwardDnsCard` 渲染（必须停在 loading）。
 *
 * 跑法（web 目录）：bun test src/components/forwards/__tests__/forward-dns-card.test.tsx
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import { WorkspaceContext, type WorkspaceContextValue } from "@/components/workspace/workspace-context";
import { getDictionary } from "@/lib/i18n";
import {
  BINDABLE_RECORD_TYPES,
  ForwardDnsCard,
  ForwardDnsCardBody,
  type BindFormState,
  type ProvidersFact,
} from "@/components/forwards/forward-dns-card";
import type { ForwardDnsView } from "@/components/ddns/ddns-view";
import type { DnsBindingState, DnsProviderView } from "@/lib/types/ddns";

const noop = () => undefined;

function binding(over: Partial<DnsBindingState> = {}): DnsBindingState {
  return {
    state: "unbound",
    domain: null,
    record_type: null,
    mode: null,
    provider_id: null,
    expected_values: ["1.2.3.11"],
    confirmed_values: [],
    synced_at: null,
    verified: false,
    last_error: null,
    auto_resolve: false,
    attempt_count: null,
    next_attempt_at: null,
    ...over,
  };
}

/** 已绑定的一行基准数据（state 由各用例指定）。 */
function bound(over: Partial<DnsBindingState> = {}): DnsBindingState {
  return binding({
    state: "pending",
    domain: "node1.example.com",
    record_type: "A",
    mode: "single_active",
    ...over,
  });
}

const READY_PROVIDERS: DnsProviderView[] = [
  { id: 7, name: "生产 CF", type: "cloudflare", workspace_id: 1, platform_level: false, has_credential: true, created_at: null },
];

function render(node: React.ReactNode, locale: "zh" | "en" = "zh") {
  return renderToStaticMarkup(<I18nProvider locale={locale} dict={getDictionary(locale)}>{node}</I18nProvider>);
}

function card(over: Partial<Parameters<typeof ForwardDnsCardBody>[0]> = {}) {
  const view: ForwardDnsView = over.view ?? { kind: "ready", binding: binding() };
  const form: BindFormState = over.form ?? { domain: "", recordType: "A", providerId: null, autoResolve: false };
  const providers: ProvidersFact = over.providers ?? { kind: "ready", rows: [] };
  return render(
    <ForwardDnsCardBody
      view={view}
      canUpdate
      canSelectProvider
      providers={providers}
      pending={null}
      form={form}
      onFormChange={noop}
      onBind={noop}
      onUnbind={noop}
      onRetry={noop}
      {...over}
    />,
  );
}

/** 取出某个 testid 的开标签，便于断言同一元素上的属性。 */
function tagOf(html: string, testid: string): string {
  const at = html.indexOf(`data-testid="${testid}"`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at));
}

function workspaceValue(can: (key: string) => boolean, permissionsLoading = false): WorkspaceContextValue {
  return {
    workspaces: [],
    current: null,
    currentId: 1,
    role: "owner",
    kind: "personal",
    me: { id: 1, email: "u@tunex.local" },
    canManage: true,
    permissions: null,
    permissionsLoading,
    can: can as WorkspaceContextValue["can"],
    canForward: () => true,
    loading: false,
    error: null,
    select: noop,
    createTeam: async () => null,
    refresh: async () => undefined,
  };
}

describe("五态文案：只有 synced 能说「已切换」", () => {
  const cases: { state: DnsBindingState["state"]; title: string }[] = [
    { state: "unbound", title: "未绑定" },
    { state: "pending", title: "已提交，等待写入" },
    { state: "synced", title: "已切换" },
    { state: "synced_unverified", title: "已写入，尚未确认" },
    { state: "error", title: "同步失败" },
  ];

  test("state 属性与标题一一对应", () => {
    for (const entry of cases) {
      const html = card({ view: { kind: "ready", binding: entry.state === "unbound" ? binding() : bound({ state: entry.state }) } });
      expect(tagOf(html, "forward-dns-state")).toContain(`data-state="${entry.state}"`);
      expect(html).toContain(entry.title);
    }
  });

  test("非 synced 的四态文本里绝不出现「已切换」", () => {
    for (const entry of cases) {
      if (entry.state === "synced") continue;
      const html = card({ view: { kind: "ready", binding: entry.state === "unbound" ? binding() : bound({ state: entry.state }) } });
      expect(`${entry.state}: ${html}`).not.toContain("已切换");
    }
  });

  test("pending 明说「200 不等于记录已改」；synced_unverified 明说仍可能返回旧地址", () => {
    expect(card({ view: { kind: "ready", binding: bound({ state: "pending" }) } })).toContain("不等于记录已经改好");
    const unverified = card({ view: { kind: "ready", binding: bound({ state: "synced_unverified" }) } });
    expect(unverified).toContain("已写入，尚未确认");
    expect(unverified).toContain("旧地址");
  });

  test("synced 才展示确认时间与读回确认=是", () => {
    const html = card({
      view: {
        kind: "ready",
        binding: bound({
          state: "synced",
          synced_at: "2026-10-07T01:02:03.000Z",
          verified: true,
          confirmed_values: ["1.2.3.11"],
        }),
      },
    });
    expect(html).toContain("2026");
    expect(html).toContain("服务端读回确认");
    expect(html).toContain("1.2.3.11");
  });
});

describe("退避：将于 X 重试 vs 不会自动重试", () => {
  test("auto_resolve=true 且 next_attempt_at 有值 ⇒ 显示服务端给的那一刻", () => {
    const html = card({
      view: {
        kind: "ready",
        binding: bound({ state: "error", last_error: "provider 调用失败：HTTP 500", auto_resolve: true, next_attempt_at: "2026-10-07T01:00:00.000Z", attempt_count: 3 }),
      },
    });
    const retry = tagOf(html, "forward-dns-retry");
    expect(retry).toContain('data-retry="scheduled"');
    expect(html).toContain("将于");
    expect(html).toContain("provider 调用失败：HTTP 500");
    expect(html).toContain("连续失败次数");
  });

  test("next_attempt_at 有值但 auto_resolve=false ⇒ 说「不会自动重试」且不出现「将于」", () => {
    const html = card({
      view: {
        kind: "ready",
        binding: bound({ auto_resolve: false, next_attempt_at: "2026-10-07T01:00:00.000Z" }),
      },
    });
    expect(tagOf(html, "forward-dns-retry")).toContain('data-retry="not_scheduled_auto_off"');
    expect(html).toContain("不会自动重试");
    expect(html).not.toContain("将于");
  });

  test("auto_resolve=true 但没有待重试计划 ⇒ no-plan（与 auto-off 说法不同）", () => {
    const html = card({ view: { kind: "ready", binding: bound({ auto_resolve: true, next_attempt_at: null }) } });
    expect(tagOf(html, "forward-dns-retry")).toContain('data-retry="not_scheduled_no_plan"');
    expect(html).toContain("没有待重试的计划");
  });

  test("attempt_count=null 时不渲染「连续失败次数」（不许显示 0 次）", () => {
    const html = card({ view: { kind: "ready", binding: bound({ attempt_count: null }) } });
    expect(html).not.toContain("连续失败次数");
  });
});

describe("入口地址：空集不给猜测地址", () => {
  test("expected_values 为空 ⇒ 不可用提示存在，且卡片里没有任何 IP 字面量", () => {
    const html = card({ view: { kind: "ready", binding: binding({ expected_values: [] }) } });
    expect(html).toContain('data-testid="forward-dns-address-unavailable"');
    expect(html).toContain("服务端没有给出期望地址");
    expect(html).toContain("dns_address_unavailable");
    expect(html).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  test("expected_values 非空 ⇒ 原样展示服务端给的值", () => {
    const html = card({ view: { kind: "ready", binding: binding({ expected_values: ["172.33.10.20"] }) } });
    expect(html).toContain("172.33.10.20");
    expect(html).not.toContain('data-testid="forward-dns-address-unavailable"');
  });
});

describe("G4：为什么没写入", () => {
  test("auto_resolve=true 且未选服务商 ⇒ 明说不会写入（不是「稍后会好」）", () => {
    const html = card({ view: { kind: "ready", binding: bound({ auto_resolve: true, provider_id: null }) } });
    expect(html).toContain('data-testid="forward-dns-write-warning"');
    expect(html).toContain("不会写入");
  });

  test("选了服务商 ⇒ 不出现该警告；未选择服务商时显示「未选择服务商」而不是空白", () => {
    const withProvider = card({ view: { kind: "ready", binding: bound({ auto_resolve: true, provider_id: 7 }) }, providers: { kind: "ready", rows: READY_PROVIDERS } });
    expect(withProvider).not.toContain('data-testid="forward-dns-write-warning"');
    expect(withProvider).toContain("生产 CF");

    const without = card({ view: { kind: "ready", binding: bound({ provider_id: null }) }, providers: { kind: "ready", rows: READY_PROVIDERS } });
    expect(without).toContain("未选择服务商");
  });

  test("选中的服务商不在可见列表 ⇒ 明说不在列表里（不显示成「未选择」）", () => {
    const html = card({ view: { kind: "ready", binding: bound({ provider_id: 99 }) }, providers: { kind: "ready", rows: READY_PROVIDERS } });
    expect(html).toContain("不在你可见的列表里");
  });
});

describe("三类「取不到」与「没有权限」互不冒充", () => {
  test("unavailable：独立 testid，文案含「取不到」，且不出现 正常/健康/可达/未绑定", () => {
    const html = card({ view: { kind: "unavailable", message: "工作空间角色无权操作" } });
    expect(html).toContain('data-testid="forward-dns-unavailable"');
    expect(html).toContain("取不到");
    expect(html).toContain("工作空间角色无权操作");
    for (const word of ["正常", "健康", "可达", "未绑定"]) expect(html).not.toContain(word);
    expect(html).not.toContain('data-testid="forward-dns-state"');
  });

  test("权限未读出来 vs 确实没有 forward:read 是两个分支", () => {
    const loading = card({ view: { kind: "permission_loading" } });
    const denied = card({ view: { kind: "permission_denied" } });
    expect(loading).toContain('data-testid="forward-dns-permission-loading"');
    expect(loading).not.toContain('data-testid="forward-dns-permission-denied"');
    expect(denied).toContain('data-testid="forward-dns-permission-denied"');
    expect(loading).not.toContain("forward:read：看不到");
    expect(denied).toContain("forward:read");
    // 两者都不许冒充状态
    for (const html of [loading, denied]) {
      expect(html).not.toContain('data-testid="forward-dns-state"');
      expect(html).not.toContain("未绑定");
    }
  });

  test("首帧（真实组件）：停在 loading，绝不先显示「未绑定」", () => {
    const html = render(
      <WorkspaceContext.Provider value={workspaceValue(() => true)}>
        <ForwardDnsCard forwardId={1} />
      </WorkspaceContext.Provider>,
    );
    expect(html).toContain('data-testid="forward-dns-loading"');
    expect(html).not.toContain('data-testid="forward-dns-state"');
    expect(html).not.toContain("未绑定");
  });

  test("真实组件：没有 forward:read ⇒ 显示权限分支（不是 loading、不是未绑定）", () => {
    const html = render(
      <WorkspaceContext.Provider value={workspaceValue(() => false)}>
        <ForwardDnsCard forwardId={1} />
      </WorkspaceContext.Provider>,
    );
    expect(html).toContain('data-testid="forward-dns-permission-denied"');
    expect(html).not.toContain('data-testid="forward-dns-loading"');
  });
});

describe("写权限与首发边界", () => {
  test("已绑定：给解绑入口、不给绑定表单，并说明改绑要先解绑", () => {
    const html = card({ view: { kind: "ready", binding: bound() } });
    expect(html).toContain('data-testid="forward-dns-unbind"');
    expect(html).not.toContain('data-testid="forward-dns-bind"');
    expect(html).toContain('data-testid="forward-dns-rebind-hint"');
  });

  test("未绑定：给绑定表单，不给解绑", () => {
    const html = card({ view: { kind: "ready", binding: binding() } });
    expect(html).toContain('data-testid="forward-dns-bind"');
    expect(html).not.toContain('data-testid="forward-dns-unbind"');
    expect(html).toContain('data-testid="forward-dns-domain"');
  });

  test("没有 forward:update ⇒ 两个动作都不给，但状态照常可见", () => {
    const html = card({ view: { kind: "ready", binding: bound() }, canUpdate: false });
    expect(html).toContain('data-testid="forward-dns-update-denied"');
    expect(html).not.toContain('data-testid="forward-dns-bind"');
    expect(html).not.toContain('data-testid="forward-dns-unbind"');
    expect(html).toContain('data-testid="forward-dns-state"');
  });

  test("记录类型只给 A / AAAA：整个卡片里不出现 CNAME / multi_entry / TTL", () => {
    const html = card({ view: { kind: "ready", binding: binding() } });
    expect(BINDABLE_RECORD_TYPES).toEqual(["A", "AAAA"]);
    expect(html).not.toContain("CNAME");
    expect(html).not.toContain("multi_entry");
    expect(html).not.toContain("多入口");
    expect(html.toLowerCase()).not.toContain("ttl");
  });

  test("服务商列表三态：读不到 ≠ 空列表 ≠ 无 settings:read", () => {
    const ready = card({ providers: { kind: "ready", rows: READY_PROVIDERS } });
    expect(ready).not.toContain('data-testid="forward-dns-providers-empty"');
    expect(ready).not.toContain('data-testid="forward-dns-providers-load-failed"');

    const empty = card({ providers: { kind: "ready", rows: [] } });
    expect(empty).toContain('data-testid="forward-dns-providers-empty"');
    expect(empty).toContain("不代表平台没有凭据");
    expect(empty).not.toContain('data-testid="forward-dns-providers-load-failed"');

    const failed = card({ providers: { kind: "unavailable", message: "boom" } });
    expect(failed).toContain('data-testid="forward-dns-providers-load-failed"');
    expect(failed).toContain("这不代表没有服务商");
    expect(failed).not.toContain('data-testid="forward-dns-providers-empty"');

    const noPermission = card({ canSelectProvider: false, providers: { kind: "unavailable", message: "" } });
    expect(noPermission).toContain('data-testid="forward-dns-providers-unreadable"');
    expect(noPermission).toContain("settings:read");
    expect(noPermission).not.toContain('data-testid="forward-dns-providers-empty"');
  });

  test("表单里勾了自动同步但没选服务商 ⇒ 提交前就警告", () => {
    const html = card({
      view: { kind: "ready", binding: binding() },
      form: { domain: "a.example.com", recordType: "A", providerId: null, autoResolve: true },
    });
    expect(html).toContain('data-testid="forward-dns-bind-warning"');
    expect(html).toContain("不会写入");
  });
});

describe("凭据纪律：卡片里不出现任何凭据材料", () => {
  test("HTML 不含 token/config/封存串等字样", () => {
    const html = card({
      view: { kind: "ready", binding: bound({ provider_id: 7, auto_resolve: true }) },
      providers: { kind: "ready", rows: READY_PROVIDERS },
    });
    expect(html).not.toContain("token");
    expect(html).not.toContain("sealed");
    expect(html).not.toContain("config");
    expect(html).not.toContain("v1.");
  });

  test("英文渲染可用（同一批分支）", () => {
    const html = render(
      <ForwardDnsCardBody
        view={{ kind: "ready", binding: bound({ state: "synced_unverified" }) }}
        canUpdate
        canSelectProvider
        providers={{ kind: "ready", rows: [] }}
        pending={null}
        form={{ domain: "", recordType: "A", providerId: null, autoResolve: false }}
        onFormChange={noop}
        onBind={noop}
        onUnbind={noop}
        onRetry={noop}
      />,
      "en",
    );
    expect(html).toContain("Written, not confirmed");
    expect(html).not.toContain("Switched");
  });
});
