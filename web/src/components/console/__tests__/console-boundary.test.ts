/**
 * Console Boundary — 导航边界 / route group 布局单测（纯逻辑 + 文件系统断言）。
 *
 * 覆盖交付要求（DEVELOPMENT.md §9.4.1）：
 *   1. **route group 不改变对外 URL**：从 `web/src/app` 真实文件系统解析出路由表
 *      （route group 目录不进 URL，`[param]` 段按动态段匹配），再断言每个对外 URL
 *      都能落到预期 group 里的 page —— 目录拆了、URL 没变、页面归属正确；
 *   2. **user nav 不含任何 admin-only 入口**（`/admin*`）与任何内部概念
 *      （federation / trust / grant / lease / audit / license …），href 与中英文案两个维度都查；
 *   3. **admin nav 含 Federation 分组**（Peers / Trust / Grants / Remote Leases / Usage），
 *      页面未落位时只作为禁用项声明，绝不进入可导航列表（因此不会 404）；
 *   4. billing / commerce gate 保持既有产品语义；
 *   5. 两个控制台外壳是**不同模块**（UserShell / AdminShell），导航与信息密度分别配置，
 *      且既有页面仍只从 `@/components/app-shell` 引入外壳（导入路径零破坏）。
 *
 * 跑法（web 目录）：bun test src/components/console/__tests__/
 * 无浏览器、无 docker、无网络依赖。
 */
import { test, expect, describe } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  adminConsoleNav,
  adminNav,
  userConsoleNav,
  userNav,
  visibleNavGroups,
  visibleNavItems,
  expectedConsolePageFile,
  consoleSurfaceForPath,
  isAdminOnlyHref,
  mentionsInternalConcept,
  normalizePath,
  localizedLabel,
  CONSOLE_ROUTE_GROUPS,
  AUTH_PATHS,
  type ConsoleId,
  type NavItem,
} from "@/lib/nav";

/** `src/app` 绝对路径（__tests__ → console → components → src） */
const APP_DIR = resolve(import.meta.dir, "..", "..", "..", "app");
/** `src/components/console` */
const CONSOLE_DIR = resolve(import.meta.dir, "..");
/** `src/components` */
const COMPONENTS_DIR = resolve(import.meta.dir, "..", "..");

const IS_GROUP = /^\(.+\)$/;

interface RouteEntry {
  /** 对外 URL（动态段保留 `[param]` 写法） */
  url: string;
  /** page.tsx 绝对路径 */
  file: string;
  /** 所属 route group 目录名，`.` = 未分组 */
  group: string;
}

/** 从文件系统解析真实路由表（Next App Router 规则：`(group)` 不进 URL、`[x]` 是动态段） */
function collectRoutes(dir: string = APP_DIR, segments: string[] = [], group = "."): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue; // 私有目录不可路由
    const isGroupDir = IS_GROUP.test(entry.name);
    out.push(
      ...collectRoutes(
        resolve(dir, entry.name),
        isGroupDir ? segments : [...segments, entry.name],
        isGroupDir ? entry.name : group,
      ),
    );
  }
  if (existsSync(resolve(dir, "page.tsx"))) {
    out.push({
      url: segments.length ? `/${segments.join("/")}` : "/",
      file: resolve(dir, "page.tsx"),
      group,
    });
  }
  return out;
}

/** 把一个具体 URL 匹配到路由表（`[param]` 匹配任意单段） */
function matchRoute(url: string, routes: RouteEntry[]): RouteEntry | undefined {
  const parts = normalizePath(url).split("/").filter(Boolean);
  return routes.find((route) => {
    const rp = route.url === "/" ? [] : route.url.split("/").filter(Boolean);
    if (rp.length !== parts.length) return false;
    return rp.every((seg, i) => (seg.startsWith("[") && seg.endsWith("]") ? parts[i].length > 0 : seg === parts[i]));
  });
}

const ROUTES = collectRoutes();

/** 对外 URL 不得因 route group 重组而变化（含兼容跳转）。 */
const LEGACY_URLS = [
  "/dashboard",
  "/forwards",
  "/forwards/42",
  "/nodes",
  "/plans",
  "/topup",
  "/tickets",
  "/settings",
  "/settings/workspace",
  "/tunnels",
  "/tunnels/42",
  "/admin",
  "/admin/nodes",
  "/admin/nodes/7",
  "/admin/node-groups",
  "/admin/users",
  "/admin/roles",
  "/admin/tunnels",
  "/admin/plans",
  "/admin/orders",
  "/admin/settings",
  "/admin/audit-logs",
  "/admin/license",
  "/login",
  "/register",
  "/reset-password",
  "/forgot-password",
  "/verify-email",
];

/** 用户侧绝不允许出现的内部概念（href 与文案两个维度都查） */
const FORBIDDEN_CONCEPT_WORDS = [
  "federation",
  "trust",
  "grant",
  "lease",
  "epoch",
  "revision",
  "agent",
  "audit",
  "license",
];

const FORBIDDEN_CONCEPT_WORDS_ZH = ["联邦", "信任", "授权", "租约", "审计", "许可", "回执"];

function navLabel(locale: "zh" | "en", item: NavItem): string {
  return localizedLabel(locale, item.labelKey, item.labelZh ?? item.labelKey, item.labelEn ?? item.labelKey);
}

function declaredItems(groups: typeof userConsoleNav): NavItem[] {
  return groups.flatMap((g) => g.items);
}

/** 断言某 URL 在文件系统中可达，且落在期望的 route group 内 */
function expectRouted(url: string, expectGroup?: string) {
  const hit = matchRoute(url, ROUTES);
  expect({ url, routed: Boolean(hit) }).toEqual({ url, routed: true });
  if (expectGroup) {
    expect({ url, group: hit!.group }).toEqual({ url, group: expectGroup });
  }
  return hit!;
}

describe("route group 边界不改变 URL", () => {
  test("旧 URL 全部仍可达（按真实路由表解析，含动态段）", () => {
    for (const url of LEGACY_URLS) expectRouted(url);
  });

  test("每个旧 URL 落在正确的 route group 里（route group 不产生 URL 段）", () => {
    for (const url of LEGACY_URLS) {
      expectRouted(url, CONSOLE_ROUTE_GROUPS[consoleSurfaceForPath(url)]);
    }
  });

  test("每个 URL 的归属 surface 正确（user / admin / auth）", () => {
    expect(consoleSurfaceForPath("/dashboard")).toBe("user");
    expect(consoleSurfaceForPath("/forwards/42")).toBe("user");
    expect(consoleSurfaceForPath("/nodes")).toBe("user");
    expect(consoleSurfaceForPath("/settings/workspace")).toBe("user");
    expect(consoleSurfaceForPath("/admin")).toBe("admin");
    expect(consoleSurfaceForPath("/admin/nodes/7")).toBe("admin");
    for (const p of AUTH_PATHS) expect(consoleSurfaceForPath(p)).toBe("auth");
    expect(consoleSurfaceForPath("/")).toBe("public");
  });

  test("期望文件路径带 route group 目录，但 URL 本身不含括号", () => {
    expect(expectedConsolePageFile("/dashboard")).toBe("(user)/dashboard/page.tsx");
    expect(expectedConsolePageFile("/settings/workspace")).toBe("(user)/settings/workspace/page.tsx");
    expect(expectedConsolePageFile("/admin/nodes")).toBe("(admin)/admin/nodes/page.tsx");
    expect(expectedConsolePageFile("/login")).toBe("(auth)/login/page.tsx");
    expect(expectedConsolePageFile("/")).toBe("page.tsx");

    // route group 目录名只存在于文件系统，不出现在任何导航 href / 规范化路径里
    for (const url of LEGACY_URLS) {
      expect(url.includes("(")).toBe(false);
      expect(normalizePath(url).includes("(")).toBe(false);
      expect(expectedConsolePageFile(url).startsWith(CONSOLE_ROUTE_GROUPS[consoleSurfaceForPath(url)])).toBe(true);
    }
    expect(CONSOLE_ROUTE_GROUPS).toEqual({ user: "(user)", admin: "(admin)", auth: "(auth)", public: "." });
  });

  test("三个 route group 目录存在，且旧的一级目录已搬空（防止半搬状态）", () => {
    expect(existsSync(resolve(APP_DIR, "(user)"))).toBe(true);
    expect(existsSync(resolve(APP_DIR, "(admin)"))).toBe(true);
    expect(existsSync(resolve(APP_DIR, "(auth)"))).toBe(true);
    for (const stale of [
      "dashboard",
      "forwards",
      "nodes",
      "plans",
      "topup",
      "tickets",
      "settings",
      "tunnels",
      "admin",
      "login",
      "register",
    ]) {
      expect(existsSync(resolve(APP_DIR, stale))).toBe(false);
    }
    // 根目录仍保留落地页与根 layout
    expect(existsSync(resolve(APP_DIR, "page.tsx"))).toBe(true);
    expect(existsSync(resolve(APP_DIR, "layout.tsx"))).toBe(true);
    // 路由表里除了落地页，不应再有其它未分组页面（边界之外不存在第二套页面）
    const ungrouped = ROUTES.filter((r) => r.group === "." && r.url !== "/");
    expect(ungrouped.map((r) => r.url)).toEqual([]);
  });

  test("动态详情页仍在原 URL 上（/forwards/[id]、/admin/nodes/[id]）", () => {
    expectRouted("/forwards/42", "(user)");
    expectRouted("/admin/nodes/7", "(admin)");
    expect(matchRoute("/forwards/42", ROUTES)!.file).toBe(resolve(APP_DIR, "(user)/forwards/[id]/page.tsx"));
    expect(matchRoute("/admin/nodes/7", ROUTES)!.file).toBe(resolve(APP_DIR, "(admin)/admin/nodes/[id]/page.tsx"));
  });

  test("pathname 规范化：query / hash / 尾斜杠不影响归属", () => {
    expect(normalizePath("/admin/nodes/?page=1#x")).toBe("/admin/nodes");
    expect(consoleSurfaceForPath("/admin/nodes/?page=1#x")).toBe("admin");
    expect(consoleSurfaceForPath("/dashboard/")).toBe("user");
    expect(expectedConsolePageFile("/dashboard/?a=1")).toBe("(user)/dashboard/page.tsx");
    expectRouted("/dashboard/");
  });
});

describe("User Console 导航边界", () => {
  const userItemsAll = declaredItems(userConsoleNav);
  const userItemsNavigable = visibleNavItems("user", { paymentsEnabled: true });

  test("user nav 不含任何 admin-only 入口，也不触及内部概念路径", () => {
    for (const item of userItemsAll) {
      expect(isAdminOnlyHref(item.href)).toBe(false);
      expect(mentionsInternalConcept(item.href)).toBe(false);
      expect(item.href.toLowerCase().includes("admin")).toBe(false);
      expect(item.href.startsWith("/admin")).toBe(false);
    }
  });

  test("user nav 文案不泄露 Federation / trust / grant / lease / audit 等内部概念", () => {
    for (const item of userItemsAll) {
      for (const locale of ["zh", "en"] as const) {
        const label = navLabel(locale, item).toLowerCase();
        for (const word of FORBIDDEN_CONCEPT_WORDS) expect({ label, word, hit: label.includes(word) }).toEqual({ label, word, hit: false });
        for (const word of FORBIDDEN_CONCEPT_WORDS_ZH) expect({ label, word, hit: label.includes(word) }).toEqual({ label, word, hit: false });
      }
    }
  });

  test("user nav 可导航项全部落在 (user) group 且真实可达", () => {
    for (const item of userItemsNavigable) {
      expectRouted(item.href, "(user)");
    }
  });

  test("user nav 覆盖 §9.4.1 的六个分区", () => {
    const ids = visibleNavGroups("user", { paymentsEnabled: true }).map((g) => g.id);
    expect(ids).toEqual(["overview", "forwards", "routes", "billing", "support", "settings"]);
  });

  test("网络分组的两条入口都是真页面（/nodes 节点 + /routes 可用路由策略）", () => {
    const routesGroup = userConsoleNav.find((g) => g.id === "routes")!;
    for (const href of ["/nodes", "/routes"]) {
      const item = routesGroup.items.find((i) => i.href === href)!;
      expect({ href, status: item.status ?? "available" }).toEqual({ href, status: "available" });
      // 用户侧文案不许出现编排侧的词（模板 / Route Profile / selector / transit）
      const labels = [item.labelKey ?? "", item.labelZh ?? "", item.labelEn ?? ""].join(" ").toLowerCase();
      for (const word of ["template", "selector", "transit", "模板"]) {
        expect({ href, word, hit: labels.includes(word) }).toEqual({ href, word, hit: false });
      }
    }
  });

  test("planned 项绝不进入可导航列表（因此不会生成 404 链接）", () => {
    // 用户侧当前没有 planned 项；/routes 是实际可用页面。
    // 用 admin 侧仍未落位的项验证同一条不变量，避免这条规则失去守卫。
    const adminPlanned = declaredItems(adminConsoleNav)
      .filter((i) => i.status === "planned")
      .map((i) => i.href);
    expect(adminPlanned.length).toBeGreaterThan(0);
    for (const href of adminPlanned) {
      expect(visibleNavItems("admin", { paymentsEnabled: true }).some((i) => i.href === href)).toBe(false);
    }
    // 用户侧：所有 declared 项都必须是可导航的真实入口
    for (const item of declaredItems(userConsoleNav)) {
      expect({ href: item.href, status: item.status ?? "available" }).toEqual({ href: item.href, status: "available" });
      expect(userItemsNavigable.some((i) => i.href === item.href)).toBe(true);
    }
  });

  test("billing gate 保持既有语义", () => {
    const on = visibleNavItems("user", { paymentsEnabled: true }).map((i) => i.href);
    const off = visibleNavItems("user", { paymentsEnabled: false }).map((i) => i.href);
    expect(on).toContain("/plans");
    expect(on).toContain("/topup");
    expect(off).not.toContain("/plans");
    expect(off).not.toContain("/topup");
    expect(visibleNavGroups("user", { paymentsEnabled: false }).map((g) => g.id)).not.toContain("billing");
    // 计费关闭不影响非计费入口
    expect(off).toContain("/dashboard");
    expect(off).toContain("/settings/workspace");
  });

  test("兼容导出 userNav 与组合后的可导航项一致", () => {
    const expectedHrefs = visibleNavItems("user", {
      paymentsEnabled: process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === "true",
    }).map((i) => i.href);
    expect(userNav.map((i) => i.href)).toEqual(expectedHrefs);
  });
});

describe("Admin Console 导航边界", () => {
  const adminItemsNavigable = visibleNavItems("admin", { paymentsEnabled: true });

  test("admin nav 含 Federation 分组，六条入口齐全且是真链接", () => {
    const federation = visibleNavGroups("admin", { paymentsEnabled: true }).find((g) => g.id === "federation");
    expect(federation).toBeDefined();
    expect(federation!.items.map((i) => i.href)).toEqual([
      "/admin/federation",
      "/admin/federation/peers",
      "/admin/federation/trust",
      "/admin/federation/grants",
      "/admin/federation/remote-leases",
      "/admin/federation/usage",
    ]);
    // 页面落位后不许再留 planned：入口必须真的可点（否则就是 dead 入口）
    for (const item of federation!.items) {
      expect({ href: item.href, status: item.status ?? "available" }).toEqual({ href: item.href, status: "available" });
    }
    // 双语标题里必须明确写「联邦 / Federation」，不能是占位名
    expect(federation!.labelZh.toLowerCase()).toContain("联邦");
    expect(federation!.labelEn.toLowerCase()).toContain("federation");
  });

  test("Federation 只出现在 Admin Console，用户侧一个字都没有", () => {
    const adminHrefs = declaredItems(adminConsoleNav).map((i) => i.href);
    expect(adminHrefs.some((h) => h.includes("/federation/"))).toBe(true);
    const userHrefs = declaredItems(userConsoleNav).map((i) => i.href);
    expect(userHrefs.some((h) => mentionsInternalConcept(h))).toBe(false);
    expect(userHrefs.some((h) => h.includes("federation"))).toBe(false);
  });

  test("admin nav 覆盖 §9.4.1 的八个分区", () => {
    const ids = visibleNavGroups("admin", { paymentsEnabled: true }).map((g) => g.id);
    expect(ids).toEqual([
      "overview",
      "infrastructure",
      "network",
      "access",
      "commerce",
      "operations",
      "federation",
      "system",
    ]);
  });

  test("admin nav 可导航项全部是 /admin* 且落在 (admin) group 真实可达", () => {
    expect(adminItemsNavigable.length).toBeGreaterThan(0);
    for (const item of adminItemsNavigable) {
      expect(isAdminOnlyHref(item.href)).toBe(true);
      expectRouted(item.href, "(admin)");
    }
  });

  test("网络概念收口为转发 + 路由策略，不再并列暴露目标对象", () => {
    const network = visibleNavGroups("admin", { paymentsEnabled: true }).find((g) => g.id === "network")!;
    expect(network.items.map((i) => i.href)).toEqual(["/admin/tunnels", "/admin/route-profiles"]);
    const zh = network.items.map((i) => navLabel("zh", i));
    const en = network.items.map((i) => navLabel("en", i));
    expect(zh).toEqual(["转发", "路由策略"]);
    expect(en).toEqual(["Forwards", "Routing policies"]);
    expect(network.items.some((i) => i.href === "/admin/targets")).toBe(false);
  });

  test("Federation 与路由策略已落位；其余未落位项仍是 planned 禁用项（不进可导航列表）", () => {
    const planned = declaredItems(adminConsoleNav).filter((i) => i.status === "planned");
    const plannedHrefs = planned.map((i) => i.href);
    // Federation 页面已落地，不允许再挂 planned。
    expect(plannedHrefs.some((h) => h.startsWith("/admin/federation"))).toBe(false);
    // /admin/targets 已从一级导航移除：Target 是 Forward 的目标地址，不再作为并列产品对象。
    expect(declaredItems(adminConsoleNav).map((i) => i.href)).not.toContain("/admin/targets");
    // 已落位的 /admin/route-profiles 不得留在 planned。
    expect(plannedHrefs).not.toContain("/admin/route-profiles");
    expect(plannedHrefs).toContain("/admin/capacity");
    for (const href of plannedHrefs) {
      expect(adminItemsNavigable.some((i) => i.href === href)).toBe(false);
    }
  });

  test("commerce gate 与既有 adminNav 语义一致", () => {
    const on = visibleNavItems("admin", { paymentsEnabled: true }).map((i) => i.href);
    const off = visibleNavItems("admin", { paymentsEnabled: false }).map((i) => i.href);
    expect(on).toContain("/admin/plans");
    expect(on).toContain("/admin/orders");
    expect(off).not.toContain("/admin/plans");
    expect(off).not.toContain("/admin/orders");
    expect(adminNav.map((i) => i.href)).toEqual(
      visibleNavItems("admin", {
        paymentsEnabled: process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === "true",
      }).map((i) => i.href),
    );
  });

  test("既有 admin 入口一个都没丢", () => {
    const hrefs = visibleNavItems("admin", { paymentsEnabled: false }).map((i) => i.href);
    for (const legacy of [
      "/admin",
      "/admin/nodes",
      "/admin/node-groups",
      "/admin/tunnels",
      "/admin/users",
      "/admin/roles",
      "/admin/tickets",
      "/admin/settings",
      "/admin/audit-logs",
      "/admin/license",
    ]) {
      expect(hrefs).toContain(legacy);
    }
  });
});

describe("User/Admin 两个控制台外壳保持分离", () => {
  const readConsole = (name: string) => readFileSync(resolve(CONSOLE_DIR, name), "utf8");
  const readComponent = (name: string) => readFileSync(resolve(COMPONENTS_DIR, name), "utf8");

  test("UserShell / AdminShell 是独立模块，各取各的导航", () => {
    const user = readConsole("user-shell.tsx");
    const admin = readConsole("admin-shell.tsx");
    expect(user).toContain('visibleNavGroups("user")');
    expect(user).not.toContain('visibleNavGroups("admin")');
    expect(admin).toContain('visibleNavGroups("admin")');
    expect(admin).not.toContain('visibleNavGroups("user")');
    // 信息密度分别设计：admin 内容区更宽
    expect(user).toContain("max-w-[1400px]");
    expect(admin).toContain("max-w-[1800px]");
    // 管理端外壳标记 admin-access（仅展示，不拦截）
    expect(admin).toContain("data-admin-access");
  });

  test("AppShell 仍是兼容入口：按 adminMode 分发，且保留 requireSession/currentLocale 导出", () => {
    const shell = readComponent("app-shell.tsx");
    expect(shell).toContain("AdminShell");
    expect(shell).toContain("UserShell");
    expect(shell).toContain('from "@/components/console/admin-shell"');
    expect(shell).toContain('from "@/components/console/user-shell"');
    expect(shell).toContain('from "@/components/console/session"');
    expect(shell).toContain("export async function AppShell");
    expect(shell).toContain("requireSession");
    expect(shell).toContain("currentLocale");
  });

  test("既有页面仍只从 @/components/app-shell 引入外壳（导入路径零破坏）", () => {
    const targets = [
      "(user)/dashboard/page.tsx",
      "(user)/forwards/page.tsx",
      "(user)/nodes/page.tsx",
      "(user)/plans/page.tsx",
      "(user)/topup/page.tsx",
      "(user)/tickets/page.tsx",
      "(user)/settings/page.tsx",
      "(user)/settings/workspace/page.tsx",
      "(user)/forwards/[id]/page.tsx",
      "(admin)/admin/page.tsx",
      "(admin)/admin/[segment]/page.tsx",
      "(admin)/admin/nodes/[id]/page.tsx",
    ];
    for (const rel of targets) {
      const src = readFileSync(resolve(APP_DIR, rel), "utf8");
      expect({ rel, imports: src.includes('from "@/components/app-shell"') }).toEqual({ rel, imports: true });
      expect({ rel, deepImport: src.includes('from "@/components/console/') }).toEqual({ rel, deepImport: false });
    }
  });

  test("(user)/(admin)/(auth) layout 承担边界，且不重复渲染 chrome", () => {
    const userLayout = readFileSync(resolve(APP_DIR, "(user)/layout.tsx"), "utf8");
    const adminLayout = readFileSync(resolve(APP_DIR, "(admin)/layout.tsx"), "utf8");
    const authLayout = readFileSync(resolve(APP_DIR, "(auth)/layout.tsx"), "utf8");
    expect(userLayout).toContain('enforceConsoleBoundary("user")');
    expect(adminLayout).toContain('enforceConsoleBoundary("admin")');
    expect(authLayout).toContain('enforceConsoleBoundary("auth")');
    // layout 不渲染 shell，避免与页面级 AppShell 形成双 chrome
    for (const src of [userLayout, adminLayout, authLayout]) {
      expect(src.includes("<AppShell")).toBe(false);
      expect(src.includes("<Sidebar")).toBe(false);
      expect(src.includes("<Topbar")).toBe(false);
    }
  });

  test("Sidebar/Topbar 支持控制台变体（同一实现，两套参数，不复制 design system）", () => {
    const sidebar = readComponent("sidebar.tsx");
    const topbar = readComponent("topbar.tsx");
    expect(sidebar).toContain("groups: NavGroup[]");
    expect(sidebar).toContain("console?: ConsoleId");
    expect(sidebar).toContain("navGroupLabel");
    expect(sidebar).toContain('data-nav-status="planned"');
    expect(topbar).toContain("console?: ConsoleId");
    expect(topbar).toContain('data-testid="console-badge"');
  });

  test("控制台类型只有 user / admin（没有第三个半吊子控制台）", () => {
    const ids: ConsoleId[] = ["user", "admin"];
    expect(ids.length).toBe(2);
    expect(Object.keys(CONSOLE_ROUTE_GROUPS)).toEqual(["user", "admin", "auth", "public"]);
  });
});
