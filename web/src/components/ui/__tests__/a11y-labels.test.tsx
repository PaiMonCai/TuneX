/**
 * R2/W1 Part B —— **图标按钮与图表容器的可访问名称跟随语言**（行为测试，无浏览器）。
 *
 * 背景（D1 只读审查结论）：全仓 `sr-only` 只剩 `ui/dialog.tsx` 一处（已修），
 * 但还散着 12 处写死的字面量 `aria-label`：
 *
 *   · `sidebar.tsx` 移动端菜单按钮 "menu" / 遮罩层 "close"；
 *   · `traffic-chart.tsx` "traffic trend"、`admin-charts.tsx` 两个图表；
 *   · `route-profiles-manager.tsx` 的 7 处（含技术标识 node_id / strategy）；
 *   · `node-diagnostics.tsx` 写死中文「目标镜像」（英文界面会读出中文）。
 *
 * 图标按钮没有可见文字，`aria-label` 就是它的**全部**语义：写死一种语言等于另一种
 * 语言的用户读到错的（或空的）名称。这里逐条断言「随语言切换」这条行为。
 *
 * `sidebar.tsx` 依赖 `next/navigation` 的 app router 上下文（静态渲染会抛
 * "invariant expected app router to be mounted"），所以本文件显式 stub 掉这个模块
 * ——测的是页面里真实的 Sidebar 组件与真实词典，而不是把它复制一遍。
 *
 * 跑法（web 目录）：bun test src/components/ui/__tests__/a11y-labels.test.tsx
 */
import { describe, expect, test, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({
    push: () => undefined,
    replace: () => undefined,
    refresh: () => undefined,
    prefetch: () => undefined,
    back: () => undefined,
    forward: () => undefined,
  }),
}));

import type { ReactNode } from "react";
import { I18nProvider } from "@/components/providers";
import { Sidebar, SidebarBackdrop } from "@/components/sidebar";
import { TrafficChart } from "@/components/traffic-chart";
import { RevenueAreaChart, TunnelTypePieChart } from "@/components/admin/admin-charts";
import { RouteProfileTemplateEditor } from "@/components/admin/route-profiles/route-profiles-manager";
import { NodeUpgradeCard, nodeUpgradeCopy } from "@/components/nodes/node-upgrade-card";
import { NodeDiagnostics } from "@/components/nodes/node-diagnostics";
import { visibleNavGroups } from "@/lib/nav";
import { en, zh, type Dict } from "@/lib/i18n/dictionaries";
import type { Locale } from "@/lib/i18n";
import type { RouteProfileTemplate, User } from "@/lib/types";

/* ================================================================== */
/* fixtures / helpers                                                  */
/* ================================================================== */

const user: User = {
  id: 1,
  email: "demo@example.com",
  super_admin: false,
  balance: 0,
  commission_balance: 0,
  tg_id: null,
  uid: "TX-1",
  note: null,
  parent_id: null,
  referral_commission_rate: null,
  auto_renew: false,
  api_key: null,
  subscription_key: null,
  status: "active",
  created_at: "2026-10-06T00:00:00.000Z",
  updated_at: "2026-10-06T00:00:00.000Z",
  email_verified_at: null,
};

const dictFor = (locale: Locale): Dict => (locale === "en" ? en : zh);

function withLocale(node: ReactNode, locale: Locale): string {
  return renderToStaticMarkup(
    <I18nProvider locale={locale} dict={dictFor(locale)}>{node}</I18nProvider>,
  );
}

/** 抽出所有 aria-label 值（顺序无关的集合断言，避免依赖属性顺序）。 */
function ariaLabels(html: string): string[] {
  return [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]!);
}

function template(over: Partial<RouteProfileTemplate> = {}): RouteProfileTemplate {
  return {
    ingress: { kind: "fixed_node", node_id: 1 },
    transit: [{ kind: "fixed_node", node_id: 4 }],
    egress: { kind: "fixed_node", node_id: 5 },
    ingress_policy: null,
    egress_policy: null,
    constraints: null,
    required_capabilities: null,
    ...over,
  };
}

/* ================================================================== */
/* A. 侧栏（移动端菜单按钮 + 遮罩层）                                    */
/* ================================================================== */

describe("A. sidebar：菜单与遮罩的可访问名称跟随语言", () => {
  test("中文：菜单 / 关闭菜单；英文：Menu / Close menu（都不是写死的旧字面量）", () => {
    const groups = visibleNavGroups("user");
    const zhHtml = withLocale(<Sidebar groups={groups} locale="zh" user={user} />, "zh");
    const enHtml = withLocale(<Sidebar groups={groups} locale="en" user={user} />, "en");
    // 抽屉遮罩只在抽屉打开时渲染，静态渲染拿不到，故单独渲染这个按钮。
    const zhBackdrop = withLocale(<SidebarBackdrop onClose={() => undefined} />, "zh");
    const enBackdrop = withLocale(<SidebarBackdrop onClose={() => undefined} />, "en");

    expect(ariaLabels(zhHtml)).toContain(zh.common.menu);
    expect(ariaLabels(enHtml)).toContain(en.common.menu);
    expect(ariaLabels(zhBackdrop)).toContain(zh.common.closeMenu);
    expect(ariaLabels(enBackdrop)).toContain(en.common.closeMenu);

    // 旧实现的两个字面量不再出现。
    expect(ariaLabels(zhHtml)).not.toContain("menu");
    expect(ariaLabels(zhBackdrop)).not.toContain("close");
    // 两种语言确实不同（不是两边写同一句）。
    expect(zh.common.menu).not.toBe(en.common.menu);
    expect(zh.common.closeMenu).not.toBe(en.common.closeMenu);
  });
});

/* ================================================================== */
/* B. 图表容器                                                          */
/* ================================================================== */

describe("B. 图表容器：aria-label 是画布对屏幕阅读器唯一的语义，必须跟随语言", () => {
  test("流量趋势图（无 Provider 时回落默认语言，而不是英文硬编码）", () => {
    const points = [{ date: "2026-10-06", traffic: 1, traffic_cost: 0.1 }];
    expect(ariaLabels(withLocale(<TrafficChart data={points} />, "zh"))).toContain(
      zh.dashboard.trafficChartLabel,
    );
    expect(ariaLabels(withLocale(<TrafficChart data={points} />, "en"))).toContain(
      en.dashboard.trafficChartLabel,
    );
    // 没有 Provider（隔离渲染 / 错误回退）也不能给出空名称或旧英文。
    const bare = renderToStaticMarkup(<TrafficChart data={points} />);
    expect(ariaLabels(bare)).toContain(zh.dashboard.trafficChartLabel);
    expect(ariaLabels(bare)).not.toContain("traffic trend");
  });

  test("管理端两个图表：收入趋势 / 转发类型分布跟随语言", () => {
    const revenue = withLocale(<RevenueAreaChart data={[{ date: "2026-10-06", amount: 1 }]} />, "en");
    const pie = withLocale(<TunnelTypePieChart data={[{ type: "tcp", count: 2 }]} />, "en");
    expect(ariaLabels(revenue)).toContain(en.admin.revenueChartLabel);
    expect(ariaLabels(pie)).toContain(en.admin.tunnelTypeChartLabel);
    expect(ariaLabels(revenue)).not.toContain("revenue trend");
    expect(ariaLabels(pie)).not.toContain("tunnel type distribution");

    const zhPie = withLocale(<TunnelTypePieChart data={[{ type: "tcp", count: 2 }]} />, "zh");
    expect(ariaLabels(zhPie)).toContain(zh.admin.tunnelTypeChartLabel);
  });
});

/* ================================================================== */
/* C. Route Profile 编辑器（含技术标识字段）                             */
/* ================================================================== */

describe("C. route-profiles-manager：7 处字面量全部改走词典", () => {
  // 三种 selector 各出现一次：ingress(固定节点) / transit(中转节点) / egress(节点组+策略)。
  const groupTemplate = template({
    ingress: { kind: "fixed_node", node_id: 1 },
    transit: [{ kind: "fixed_node", node_id: 4 }],
    egress: { kind: "node_group", node_group_id: 2, strategy: "round" },
  });

  test("中文界面读中文（上移/下移/删除中转/固定节点 ID/节点组 ID/负载策略）", () => {
    const labels = ariaLabels(
      renderToStaticMarkup(<RouteProfileTemplateEditor initial={groupTemplate} locale="zh" onChange={() => {}} />),
    );
    for (const value of [
      zh.admin.routeProfiles.moveUp,
      zh.admin.routeProfiles.moveDown,
      zh.admin.routeProfiles.removeTransit,
      zh.admin.routeProfiles.transitNode,
      zh.admin.routeProfiles.fixedNode,
      zh.admin.routeProfiles.nodeGroup,
      zh.admin.routeProfiles.strategy,
    ]) {
      expect(labels).toContain(value);
    }
    // 旧的英文字面量一个都不在了。
    for (const legacy of ["move up", "move down", "remove transit", "transit node id", "node_id", "node_group_id", "strategy"]) {
      expect(labels).not.toContain(legacy);
    }
  });

  test("英文界面读英文，且没有可访问名称为空的控件", () => {
    const labels = ariaLabels(
      renderToStaticMarkup(<RouteProfileTemplateEditor initial={groupTemplate} locale="en" onChange={() => {}} />),
    );
    expect(labels).toContain(en.admin.routeProfiles.moveUp);
    expect(labels).toContain(en.admin.routeProfiles.strategy);
    expect(labels).not.toContain(zh.admin.routeProfiles.moveUp);
    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
  });
});

/* ================================================================== */
/* D. 升级入口：镜像输入框的可访问名称（原在 node-diagnostics 内联块）      */
/* ================================================================== */

// 内联升级块已退役（它把管理配置字段 node.version 当版本依据、没有服务端前置、
// 生成脚本后也没有执行后可见性）。升级入口统一由 `NodeUpgradeCard` 承担，
// 它的文案是**文件内** zh/en 两份，因此这条断言必须跟着走，否则"英文界面别出现
// 写死中文"这条回归就没人守了。
describe("D. NodeUpgradeCard：镜像/目标的可访问名称跟随语言（不得写死中文）", () => {
  const CJK = /[\u4e00-\u9fff]/;

  test("英文：非空、且不含任何 CJK（旧实现是写死的中文「目标镜像」）", () => {
    const label = nodeUpgradeCopy("en").imageLabel;
    expect(label.trim().length).toBeGreaterThan(0);
    expect(label).not.toBe(nodeUpgradeCopy("zh").imageLabel);
    expect(CJK.test(label)).toBe(false);
    expect(label).not.toContain("目标镜像");
  });

  test("中文：读中文；没有 locale 时回落到非空默认", () => {
    expect(nodeUpgradeCopy("zh").imageLabel).toBe("目标镜像");
    const fallback = nodeUpgradeCopy(undefined).imageLabel;
    expect(fallback.trim().length).toBeGreaterThan(0);
    expect(CJK.test(fallback)).toBe(true);
  });
});

/* ================================================================== */
/* E. 词典本身：新增键两本都有、非空、不是裸 key                          */
/* ================================================================== */

describe("E. 新增的无障碍 / 首启词条键集一致且非空", () => {
  test("所有新增键在 zh/en 都存在、非空，且渲染出来不是键名本身", () => {
    const keys: [string, string, string][] = [
      ["common.menu", zh.common.menu, en.common.menu],
      ["common.closeMenu", zh.common.closeMenu, en.common.closeMenu],
      ["dashboard.trafficChartLabel", zh.dashboard.trafficChartLabel, en.dashboard.trafficChartLabel],
      ["admin.revenueChartLabel", zh.admin.revenueChartLabel, en.admin.revenueChartLabel],
      ["admin.tunnelTypeChartLabel", zh.admin.tunnelTypeChartLabel, en.admin.tunnelTypeChartLabel],
      ["node.upgradeImageLabel", zh.node.upgradeImageLabel, en.node.upgradeImageLabel],
      ["node.createGroupCta", zh.node.createGroupCta, en.node.createGroupCta],
      ["node.groupCreateTitle", zh.node.groupCreateTitle, en.node.groupCreateTitle],
      ["admin.routeProfiles.moveUp", zh.admin.routeProfiles.moveUp, en.admin.routeProfiles.moveUp],
      ["admin.routeProfiles.moveDown", zh.admin.routeProfiles.moveDown, en.admin.routeProfiles.moveDown],
      ["admin.routeProfiles.removeTransit", zh.admin.routeProfiles.removeTransit, en.admin.routeProfiles.removeTransit],
      ["admin.routeProfiles.transitNode", zh.admin.routeProfiles.transitNode, en.admin.routeProfiles.transitNode],
      ["admin.routeProfiles.fixedNode", zh.admin.routeProfiles.fixedNode, en.admin.routeProfiles.fixedNode],
      ["admin.routeProfiles.nodeGroup", zh.admin.routeProfiles.nodeGroup, en.admin.routeProfiles.nodeGroup],
      ["admin.routeProfiles.strategy", zh.admin.routeProfiles.strategy, en.admin.routeProfiles.strategy],
    ];
    for (const [key, zhText, enText] of keys) {
      for (const text of [zhText, enText]) {
        expect(text.trim().length).toBeGreaterThan(0);
        expect(text).not.toBe(key);
      }
    }
    // 两本字典的键集一致（互相不缺键）。
    expect(Object.keys(zh.admin.routeProfiles).sort()).toEqual(Object.keys(en.admin.routeProfiles).sort());
  });
});
