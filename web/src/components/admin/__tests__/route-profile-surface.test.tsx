/**
 * V5-WP13.5B Route Profile Web 表面 —— 渲染与语义不变量（无浏览器、无网络）。
 *
 * 盯的是契约要求，不是界面口味：
 *
 *   A. **「发新版本」与「原地改」是两件事**：模板内容变更才 bump 版本，
 *      metadata 改动不 bump；界面上是两个不同的动作与两段不同的说明；
 *   B. **Impact Analysis 是只读**：渲染出「不会触发任何下发」的显式声明，
 *      apply 必须显式勾选 Forward（没有「应用到全部」）；
 *   C. **ordered transit 顺序可见**：跳链带序号，顺序变化即内容变化；
 *   D. **错误分层**：profile_disabled / no_eligible_node / forbidden /
 *      profile_not_visible / unsupported_topology 各自不同的 code + 层 + next_action；
 *   E. **Admin 侧不出现 runtime 表达**：没有 applied revision / lease / epoch；
 *   F. **User 侧内部概念零出现**：/routes 页面与用户导航都不含
 *      internal / version / selector / transit / revision / lease / profile 等词，
 *      且导航入口已是真链接。
 *
 * 跑法（web 目录）：bun test src/components/admin/__tests__/
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ReadOnlyNotice,
  RouteProfileErrorNotice,
  RouteProfileTable,
  TransitChain,
  VersionBadge,
  VisibilityPill,
} from "@/components/admin/route-profiles/route-profile-ui";
import { RouteProfileTemplateEditor } from "@/components/admin/route-profiles/route-profiles-manager";
import {
  addTransit,
  applyOutcomeText,
  EMPTY_TEMPLATE,
  errorLayerText,
  hopChain,
  hopsLabel,
  impactChangeText,
  MAX_TRANSIT,
  moveTransit,
  normalizeCapabilities,
  normalizeConstraints,
  removeTransit,
  ROUTE_PROFILE_ERROR_MEANING,
  routeProfileErrorInfo,
  selectorLabel,
  stableTemplateJson,
  templateContentChanged,
  templateSummary,
  UNKNOWN_ERROR_NEXT_ACTION,
} from "@/components/admin/route-profiles/route-profile-status";
import { ApiError } from "@/lib/api";
import { zh } from "@/lib/i18n/dictionaries";
import { ROUTE_PROFILE_ERROR_CODES, type RouteProfileTemplate } from "@/lib/types";
import { expectedConsolePageFile, visibleNavGroups, visibleNavItems } from "@/lib/nav";

const APP_DIR = resolve(import.meta.dir, "..", "..", "..", "app");
const ADMIN_MODULE_DIR = resolve(import.meta.dir, "..", "route-profiles");

const template = (over: Partial<RouteProfileTemplate> = {}): RouteProfileTemplate => ({
  ingress: { kind: "fixed_node", node_id: 1 },
  transit: [{ kind: "fixed_node", node_id: 4 }],
  egress: { kind: "fixed_node", node_id: 5 },
  ingress_policy: null,
  egress_policy: null,
  constraints: null,
  required_capabilities: null,
  ...over,
});

describe("A. 发新版本 vs 原地改", () => {
  test("模板内容变更 = 需要发新版本（顺序/端点/策略/约束/能力任一项变化都算）", () => {
    const base = template();
    expect(templateContentChanged(base, template())).toBe(false);
    expect(templateContentChanged(base, template({ transit: [{ kind: "fixed_node", node_id: 5 }] }))).toBe(true);
    expect(templateContentChanged(base, template({ ingress: { kind: "fixed_node", node_id: 2 } }))).toBe(true);
    expect(templateContentChanged(base, template({ egress: null }))).toBe(true);
    expect(templateContentChanged(base, template({ required_capabilities: ["relay"] }))).toBe(true);
    expect(templateContentChanged(base, template({ constraints: { require_health: ["healthy"] } }))).toBe(true);
    expect(templateContentChanged(base, template({ ingress_policy: { protocol: "tcp" } }))).toBe(true);
    expect(templateContentChanged(null, base)).toBe(true);
  });

  test("序列化稳定：键顺序不同的等价模板不会被判成「变了」", () => {
    const a: RouteProfileTemplate = { ingress: { kind: "fixed_node", node_id: 1 }, transit: [], egress: null };
    const b: RouteProfileTemplate = {
      // @ts-expect-error 故意用不同键顺序构造（等价内容）
      egress: null,
      transit: [],
      ingress: { kind: "fixed_node", node_id: 1 },
    };
    expect(stableTemplateJson(a)).toBe(stableTemplateJson(b));
    expect(templateContentChanged(a, b)).toBe(false);
  });

  test("管理器源码把两条路分开：PATCH 与 publish 是两个动作、两段说明", () => {
    const src = readFileSync(resolve(ADMIN_MODULE_DIR, "route-profiles-manager.tsx"), "utf8");
    expect(src).toContain("api.routeProfiles.patch");
    expect(src).toContain("api.routeProfiles.publishVersion");
    expect(src).toContain("不产生新版本");
    expect(src).toContain("发布新版本");
    // 乐观闸门：两条路都带 expected_version
    expect((src.match(/expected_version/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // 发布意图在界面上可见（内容变了才允许提交）
    expect(src).toContain("route-profile-publish-intent");
    expect(src).toContain("data-new-version");
  });

  test("版本徽章带 data-version（版本是第一等概念）", () => {
    const html = renderToStaticMarkup(<VersionBadge version={4} locale="zh" />);
    expect(html).toContain('data-version="4"');
    expect(html).toContain("v4");
  });
});

describe("B. Impact Analysis 只读 + apply 显式", () => {
  test("只读声明渲染出来（且明确写「不会触发任何下发」）", () => {
    const html = renderToStaticMarkup(<ReadOnlyNotice locale="zh" />);
    expect(html).toContain('data-read-only="true"');
    expect(html).toContain("只读预览：不会触发任何下发");
    expect(html).toContain("不会改任何 Forward");
  });

  test("impact 面板源码：先分析后 apply、必须勾选、dry run 与真 apply 分开", () => {
    const src = readFileSync(resolve(ADMIN_MODULE_DIR, "route-profiles-manager.tsx"), "utf8");
    expect(src).toContain("api.routeProfiles.impact");
    expect(src).toContain("api.routeProfiles.apply");
    expect(src).toContain("route-profile-apply-dry");
    expect(src).toContain("forward_ids: selected");
    // 没有「应用到全部」的隐式形式
    expect(src.includes("forward_ids: []")).toBe(false);
  });

  test("apply 结果把「认领来源」与「真的重下发」分开说（runtime_changed=false 不算失败）", () => {
    expect(applyOutcomeText("zh", { status: "applied", runtime_changed: false, revision: 8 })).toContain("路径未变");
    expect(applyOutcomeText("zh", { status: "applied", runtime_changed: true, revision: 8 })).toContain("已下发");
    expect(applyOutcomeText("zh", { status: "previewed" })).toContain("预览");
    expect(applyOutcomeText("zh", { status: "failed" })).toBe("失败");
  });

  test("impact 条目的「会发生什么」区分 noop / 各类变更 / 无法解析", () => {
    expect(impactChangeText("zh", { resolves: true, change: { ingress_change: false, egress_change: false, middle_change: false, noop: true } })).toContain("不需要改动");
    expect(impactChangeText("zh", { resolves: true, change: { ingress_change: true, egress_change: false, middle_change: false, noop: false } })).toContain("入口变");
    expect(impactChangeText("zh", { resolves: false, change: null })).toContain("无法解析");
  });

  test("跳链与 before/after 文本（impact 对比用）", () => {
    expect(hopsLabel([{ role: "ingress", node_id: 2 }, { role: "middle", node_id: 4 }, { role: "egress", node_id: 5 }])).toBe(
      "ingress#2 → mid#4 → egress#5",
    );
    expect(hopsLabel([])).toBe("—");
    expect(hopsLabel(null)).toBe("—");
  });
});

describe("C. ordered transit 顺序可见且可操作", () => {
  test("跳链带序号与角色，DIRECT 写「同入口（直连）」而不是留空", () => {
    const hops = hopChain("zh", template());
    expect(hops.map((h) => h.index)).toEqual([0, 1, 2]);
    expect(hops.map((h) => h.role)).toEqual(["ingress", "middle", "egress"]);
    const direct = hopChain("zh", template({ transit: [], egress: null }));
    expect(direct.map((h) => h.index)).toEqual([0, 1]);
    expect(direct[1].selector).toContain("直连");
    expect(templateSummary("zh", template())).toBe("node#1 → node#4 → node#5");
  });

  test("中间跳的顺序在 DOM 上按 index 渲染", () => {
    const html = renderToStaticMarkup(<TransitChain template={template()} locale="zh" />);
    expect(html).toContain('data-hop-count="3"');
    expect(html).toContain('data-hop-index="0"');
    expect(html).toContain('data-hop-role="middle"');
    expect(html).toContain('data-hop-index="2"');
  });

  test("增删/移动都是纯函数：顺序变更 = 内容变更（因此要发新版本）", () => {
    const empty = { ...EMPTY_TEMPLATE, ingress: { kind: "fixed_node" as const, node_id: 1 } };
    const one = addTransit(empty, 4);
    expect(one.transit.map((t) => t.node_id)).toEqual([4]);
    // 第一阶段上限：再加不进去（UI 也禁用按钮）
    expect(addTransit(one, 5).transit.map((t) => t.node_id)).toEqual([4]);
    expect(MAX_TRANSIT).toBe(1);

    const two = { ...empty, transit: [{ kind: "fixed_node" as const, node_id: 4 }, { kind: "fixed_node" as const, node_id: 5 }] };
    expect(moveTransit(two, 0, 1).transit.map((t) => t.node_id)).toEqual([5, 4]);
    expect(moveTransit(two, 0, -1).transit.map((t) => t.node_id)).toEqual([4, 5]); // 越界原样返回
    expect(removeTransit(two, 0).transit.map((t) => t.node_id)).toEqual([5]);
    // 顺序变化确实是内容变化
    expect(templateContentChanged({ ...empty, transit: [two.transit[0]] }, { ...empty, transit: [two.transit[1]] })).toBe(true);
  });

  test("编辑器渲染出有序行与序号徽章（含上移/下移按钮）", () => {
    const html = renderToStaticMarkup(
      <RouteProfileTemplateEditor initial={template()} locale="zh" onChange={() => {}} />,
    );
    expect(html).toContain('data-testid="route-profile-editor-transit"');
    expect(html).toContain('data-testid="route-profile-editor-transit-row"');
    expect(html).toContain('data-order="0"');
    // 图标按钮的可访问名称来自词典（中文界面读中文），不再是写死的英文 "move up"。
    expect(html).toContain(`aria-label="${zh.admin.routeProfiles.moveUp}"`);
    expect(html).toContain(`aria-label="${zh.admin.routeProfiles.moveDown}"`);
    expect(html).not.toContain('aria-label="move up"');
    expect(html).not.toContain('aria-label="move down"');
    expect(html).toContain('data-testid="route-profile-editor-preview-chain"');
  });

  test("编辑器给出结构化输入（selector / 约束 / 能力），不做「粘贴任意 JSON 模板」", () => {
    const html = renderToStaticMarkup(
      <RouteProfileTemplateEditor initial={template()} locale="zh" onChange={() => {}} />,
    );
    expect(html).toContain('data-testid="route-profile-editor-ingress-kind"');
    expect(html).toContain('data-testid="route-profile-editor-egress-kind"');
    expect(html).toContain('data-testid="route-profile-editor-capabilities"');
    expect(html).toContain('data-testid="route-profile-editor-require-binding"');
    // 动态中间池：第一阶段不开放，编辑器里没有「中间池 / pool」入口
    expect(html.toLowerCase().includes("middle pool")).toBe(false);
    expect(html.includes("动态中间池")).toBe(false);
  });

  test("归一化：能力与约束去空去重、空值回落 null（不发明默认约束）", () => {
    expect(normalizeCapabilities("relay, relay ,, tls")).toEqual(["relay", "tls"]);
    expect(normalizeCapabilities("")).toBeNull();
    expect(normalizeCapabilities(null)).toBeNull();
    expect(normalizeConstraints({ exclude_node_ids: "3, 3, x", require_node_binding: true })).toEqual({ exclude_node_ids: [3] });
    expect(normalizeConstraints({ require_node_binding: false })).toEqual({ require_node_binding: false });
    expect(normalizeConstraints({})).toBeNull();
  });
});

describe("D. 错误分层（每个码不同 code / 层 / next_action）", () => {
  const body = (code: string, extra: Record<string, unknown> = {}) => ({
    error: `${code} 的人读原因`,
    code,
    error_layer: code === "forbidden" ? "rbac" : code === "no_eligible_node" ? "runtime_admission" : "capability",
    retryable: code === "no_eligible_node" || code === "version_conflict",
    next_action: `${code} 的下一步`,
    ...extra,
  });

  test("五种典型失败各自渲染出不同的码与下一步", () => {
    const codes = ["profile_disabled", "no_eligible_node", "forbidden", "profile_not_visible", "unsupported_topology"];
    const rendered = codes.map((code) => {
      const info = routeProfileErrorInfo(new ApiError(409, "x", body(code)));
      return { code, html: renderToStaticMarkup(<RouteProfileErrorNotice error={info} locale="zh" />) };
    });
    for (const item of rendered) {
      expect(item.html).toContain(`data-error-code="${item.code}"`);
      expect(item.html).toContain(`${item.code} 的下一步`);
      expect(item.html).toContain(`${item.code} 的人读原因`);
    }
    expect(new Set(rendered.map((r) => r.html)).size).toBe(codes.length);
  });

  test("失败层与 retryable 在 DOM 上可见", () => {
    const rbac = renderToStaticMarkup(
      <RouteProfileErrorNotice error={routeProfileErrorInfo(new ApiError(403, "x", body("forbidden")))} locale="zh" />,
    );
    expect(rbac).toContain("权限层");
    expect(rbac).toContain('data-retryable="false"');
    const admission = renderToStaticMarkup(
      <RouteProfileErrorNotice error={routeProfileErrorInfo(new ApiError(409, "x", body("no_eligible_node")))} locale="zh" />,
    );
    expect(admission).toContain("运行准入");
    expect(admission).toContain('data-retryable="true"');
  });

  test("人读原因取自后端的 `error` 字段（不是 message）", () => {
    const info = routeProfileErrorInfo(new ApiError(409, "Request failed with status 409", body("profile_disabled")));
    expect(info.message).toBe("profile_disabled 的人读原因");
    expect(info.next_action).toBe("profile_disabled 的下一步");
    expect(info.known).toBe(true);
  });

  test("闭集外/无码的错误不冒充已知语义", () => {
    const unknown = routeProfileErrorInfo(new ApiError(500, "boom", { code: "brand_new" }));
    expect(unknown.known).toBe(false);
    const html = renderToStaticMarkup(<RouteProfileErrorNotice error={unknown} locale="zh" />);
    expect(html).toContain("未知错误码");
    expect(html).toContain(UNKNOWN_ERROR_NEXT_ACTION.zh);

    const network = routeProfileErrorInfo(new Error("socket hang up"));
    expect(network.code).toBeNull();
    expect(network.known).toBe(false);
    expect(renderToStaticMarkup(<RouteProfileErrorNotice error={network} locale="zh" />)).toContain("socket hang up");
  });

  test("每个闭集码都有能力描述（穷尽表；后端加码这里编译失败）", () => {
    expect(Object.keys(ROUTE_PROFILE_ERROR_MEANING).sort()).toEqual([...ROUTE_PROFILE_ERROR_CODES].sort());
    for (const code of ROUTE_PROFILE_ERROR_CODES) {
      expect(ROUTE_PROFILE_ERROR_MEANING[code].zh.length).toBeGreaterThan(0);
    }
    expect(errorLayerText("zh", "rbac")).toBe("权限层");
    expect(errorLayerText("zh", "brand_new_layer")).toBe("brand_new_layer");
    expect(errorLayerText("zh", null)).toBeNull();
  });
});

describe("E. Admin 侧不出现「runtime 状态机」表达", () => {
  test("route-profiles 模块源码不含 applied revision / lease / epoch（Route Profile 没有 runtime）", () => {
    for (const file of ["route-profile-status.ts", "route-profile-ui.tsx", "route-profiles-manager.tsx"]) {
      const src = readFileSync(resolve(ADMIN_MODULE_DIR, file), "utf8");
      // 只看代码：注释里可以解释「为什么这里没有 lease」
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
      for (const banned of [".applied_revision", ".lease_epoch", "lease_ref", "placement", "node_port_lease"]) {
        expect({ file, banned, hits: code.split(banned).length - 1 }).toEqual({ file, banned, hits: 0 });
      }
    }
  });

  test("列表列里有版本与跳链，但没有「运行状态 / applied」列", () => {
    const html = renderToStaticMarkup(
      <RouteProfileTable
        rowCount={0}
        empty="空"
        columns={[
          { key: "version", label: "版本" },
          { key: "chain", label: "入口 → 中转 → 出口" },
        ]}
      >
        {null}
      </RouteProfileTable>,
    );
    expect(html).toContain("版本");
    expect(html).not.toContain("运行状态");
    expect(html).not.toContain("applied");
  });
});

describe("F. User Console：/routes 内部概念零出现", () => {
  const INTERNAL_WORDS = [
    "internal",
    "selector",
    "transit",
    "revision",
    "lease",
    "epoch",
    "profile_id",
    "template",
    "template_digest",
    "route_profile",
  ];

  test("用户导航：/routes 已是真链接，且文案不含内部概念", () => {
    const routes = visibleNavGroups("user", { paymentsEnabled: true }).find((g) => g.id === "routes")!;
    expect(routes).toBeDefined();
    const routesItem = routes.items.find((i) => i.href === "/routes")!;
    expect(routesItem.status ?? "available").toBe("available");
    for (const item of routes.items) {
      const labels = [item.labelKey ?? "", item.labelZh ?? "", item.labelEn ?? ""].join(" ").toLowerCase();
      for (const word of INTERNAL_WORDS) {
        expect({ href: item.href, word, hit: labels.includes(word) }).toEqual({ href: item.href, word, hit: false });
      }
    }
  });

  test("用户页源码：只消费用户字段，不渲染 version / template / id", () => {
    // 只看代码：注释里允许（也应该）解释「为什么用户侧不出现 transit」
    const src = readFileSync(resolve(APP_DIR, "(user)/routes/page.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // 只读页面：没有写操作、没有 apply、没有发布
    expect(src).not.toContain("api.routeProfiles.apply");
    expect(src).not.toContain("api.routeProfiles.publishVersion");
    expect(src).not.toContain("route.profile_id");
    // 不把管理面字段画到界面上
    expect(src).not.toContain("route.version");
    expect(src).not.toContain("route.template");
    expect(src).not.toContain("templateSummary");
    for (const word of ["transit", "selector", "epoch", "revision", "lease", "INTERNAL", "ASSIGNED", "PUBLIC"]) {
      expect({ word, hits: src.split(word).length - 1 }).toEqual({ word, hits: 0 });
    }
    // 明确写出「下一步」，而不是造一个创建按钮
    expect(src).toContain("route-next-step");
    expect(src).toContain("目前还不支持");
    // 显式收窄：只把 name/description/selectable 放进渲染树（整对象会把 template/version 一起下发）
    expect(src).toContain("page.data.map((route) => ({");
    expect(src).toContain("route.selectable");
  });

  test("用户页整页文案不含内部概念（把可渲染的中文文案抽出来检查）", () => {
    const src = readFileSync(resolve(APP_DIR, "(user)/routes/page.tsx"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const strings = [...code.matchAll(/"([^"\\\n]{2,})"/g)].map((m) => m[1]).join("\n");
    for (const word of ["模板", "中转", "选择器", "版本", "租约", "修订"]) {
      expect({ word, hits: strings.split(word).length - 1 }).toEqual({ word, hits: 0 });
    }
  });

  test("admin / user 两条路由都落在正确的 route group 并且文件存在", () => {
    expect(expectedConsolePageFile("/admin/route-profiles")).toBe("(admin)/admin/route-profiles/page.tsx");
    expect(expectedConsolePageFile("/routes")).toBe("(user)/routes/page.tsx");
    for (const rel of ["(admin)/admin/route-profiles/page.tsx", "(user)/routes/page.tsx"]) {
      expect({ rel, bytes: readFileSync(resolve(APP_DIR, rel), "utf8").length > 0 }).toEqual({ rel, bytes: true });
    }
    // 用户端导航里不出现 /admin/*；admin 端里有 route-profiles
    for (const item of visibleNavItems("user", { paymentsEnabled: true })) {
      expect(item.href.startsWith("/admin")).toBe(false);
    }
    const network = visibleNavGroups("admin", { paymentsEnabled: true }).find((g) => g.id === "network")!;
    expect(network.items.map((i) => i.href)).toContain("/admin/route-profiles");
  });

  test("可见性徽章区分三类（管理面可辨，不混为一谈）", () => {
    const labels = ["INTERNAL", "ASSIGNED", "PUBLIC"].map((v) => {
      const html = renderToStaticMarkup(<VisibilityPill visibility={v} locale="zh" />);
      return html;
    });
    expect(new Set(labels).size).toBe(3);
    expect(labels[0]).toContain('data-visibility="INTERNAL"');
    expect(labels[2]).toContain("公开");
  });

  test("selector 描述对固定节点与节点组给出不同写法", () => {
    expect(selectorLabel({ kind: "fixed_node", node_id: 4 })).toBe("node#4");
    expect(selectorLabel({ kind: "node_group", node_group_id: 3, strategy: "least_conn" })).toBe("group#3 (least_conn)");
    expect(selectorLabel(null)).toBe("—");
  });
});
