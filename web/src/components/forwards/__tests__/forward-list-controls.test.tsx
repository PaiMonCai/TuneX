/**
 * V4-WP9 §13.6：Forward 列表**控件接线**（真实渲染 + 加载/错误状态不变量）。
 *
 * 与 `forward-scale.test.ts` 的分工：
 *   · forward-scale.test.ts —— 服务端契约（分页信封 / 排序白名单 / 过滤 / 分页窗口）；
 *   · 本文件 —— 列表组件本身：控件是否真的渲染出来、文案是不是人话（不出现
 *     `forward.pagePrev` 这种原始 key）、以及加载/错误态不会退化成误导性空态。
 *
 * 用静态渲染而不是源码字符串扫描来验文案：只有真正渲染才会暴露「词条缺失导致
 * 界面画 key」这类问题；状态机的不变量（竞争保护、回第 1 页）则按仓库既有做法
 * 读源码断言——静态渲染不会跑 useEffect，光靠渲染覆盖不到取数路径。
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import {
  FORWARD_BATCH_MAX_IDS,
  ForwardWorkspace,
  forwardListText,
  type ForwardListTextKey,
} from "@/components/forwards/forward-workspace";
import {
  listenPortHintKey,
  listenPortPlaceholderKey,
} from "@/components/forwards/forward-copy";
import { getDictionary, makeT } from "@/lib/i18n";
import { WorkspaceContext, type WorkspaceContextValue } from "@/components/workspace/workspace-context";
import { mockBasePermissions } from "@/mocks/workspace-permissions";
import { hasWorkspacePermission, canMutateForward } from "@/lib/workspace-permissions";
const permissions = { workspace_id: 1, actor_id: 1, role: "owner" as const, custom_role_id: null,
  permissions: mockBasePermissions("owner"), forward_mutations: "workspace" as const };
const workspace: WorkspaceContextValue = {
  workspaces: [], current: null, currentId: 1, role: "owner", kind: "personal", me: { id: 1, email: "fixture" },
  permissions, permissionsLoading: false, canManage: true, loading: false, error: null,
  can: (key) => hasWorkspacePermission(permissions, key), canForward: (row, action) => canMutateForward(permissions, row, action),
  select: () => {}, createTeam: async () => null, refresh: async () => {},
};

const COMPONENT = readFileSync(new URL("../forward-workspace.tsx", import.meta.url), "utf8");
const TABLE = readFileSync(new URL("../forward-table.tsx", import.meta.url), "utf8");
const CREATE_DIALOG = readFileSync(new URL("../forward-create-dialog.tsx", import.meta.url), "utf8");

const render = (locale: "zh" | "en") =>
  renderToStaticMarkup(
    <I18nProvider locale={locale} dict={getDictionary(locale)}>
      <WorkspaceContext.Provider value={workspace}><ForwardWorkspace /></WorkspaceContext.Provider>
    </I18nProvider>,
  );

/** 用户可见的文本（去掉标签/属性，避免把 data-testid 里的单词当成文案）。 */
const visibleText = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

describe("分页控件渲染", () => {
  const html = render("zh");

  test("页码 / 每页 / 排序 / 总数控件都渲染出来", () => {
    for (const id of [
      "forward-list-controls",
      "forward-page-prev",
      "forward-page-next",
      "forward-page-info",
      "forward-page-size",
      "forward-sort-select",
      "forward-sort-order",
      "forward-total",
      "forward-egress-filter",
      "forward-keyword",
    ]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
  });

  test("可排序表头只暴露后端白名单里、且本表真实展示的列", () => {
    for (const key of ["name", "mode", "listen_port", "status", "created_at"]) {
      expect(html).toContain(`data-testid="forward-sort-${key}"`);
    }
    // 本表没有 traffic 列、也没有 id 列 → 不该给出排序入口
    expect(html).not.toContain('data-testid="forward-sort-traffic"');
    expect(html).not.toContain('data-testid="forward-sort-id"');
  });

  test("翻页按钮在首页 / 加载中被禁用（点不动比点了没反应更好）", () => {
    // 首屏 loading=true、page=1 → 上一页/下一页都禁用
    expect(html).toMatch(/data-testid="forward-page-prev"[^>]*disabled/);
    expect(html).toMatch(/data-testid="forward-page-next"[^>]*disabled/);
  });

  test("页码文案带真实页码/页数并完成插值", () => {
    expect(html).toMatch(/第\s*1\s*\/\s*1\s*页/);
    expect(visibleText(html)).not.toContain("{page}");
    expect(visibleText(html)).not.toContain("{pages}");
  });

  test("总数文案带计数（共 N 条）", () => {
    expect(html).toMatch(/data-testid="forward-total"[^>]*>共\s*0\s*条/);
  });
});

describe("文案：不把原始 key 画到界面上", () => {
  test("两种语言都不出现未翻译的分页词条 key", () => {
    for (const locale of ["zh", "en"] as const) {
      const html = render(locale);
      for (const key of [
        "forward.pagePrev",
        "forward.pageNext",
        "forward.pageSize",
        "forward.pageInfo",
        "forward.allEgress",
        "forward.sortAsc",
        "forward.sortDesc",
      ]) {
        expect(html).not.toContain(key);
      }
    }
  });

  test("回落逻辑：缺词条给可读文案；词条已在字典里则原样透传（补词条后无需改组件）", () => {
    const zh = makeT(getDictionary("zh"));
    // i18n.ts 里还没有 forward.pagePrev（该文件由并行切片持有，本切片不新增词条）
    expect(zh("forward.pagePrev")).toBe("forward.pagePrev");
    // → 回落成可读文案
    expect(forwardListText(zh, "zh", "forward.pagePrev")).toBe("上一页");
    expect(forwardListText(zh, "en", "forward.pageNext")).toBe("Next page");
    expect(forwardListText(zh, "en", "forward.allEgress")).toBe("All egress nodes");
    // 字典里已有的词条必须原样透传（复制/自动分配等词条由并行切片提供）
    expect(forwardListText(zh, "zh", "forward.copyForward")).toBe(zh("forward.copyForward"));
    expect(forwardListText(zh, "zh", "forward.copySuffix")).toBe(zh("forward.copySuffix"));
  });

  test("占位符插值在「字典命中」与「回落」两条路径上都成立", () => {
    const zh = makeT(getDictionary("zh"));
    expect(forwardListText(zh, "zh", "forward.pageInfo", { page: 3, pages: 7 })).toBe("第 3 / 7 页");
    expect(forwardListText(zh, "en", "forward.pageInfo", { page: 3, pages: 7 })).toBe("Page 3 of 7");
    // 字典命中的路径（bindingUsageUsed 由并行切片提供）
    expect(forwardListText(zh, "zh", "forward.bindingUsageUsed", { count: 2 })).toContain("2");
    expect(forwardListText(zh, "zh", "forward.bindingUsageUsed", { count: 2 })).not.toContain("{count}");
  });

  /**
   * 全量兜底：组件里每个 `L("…")` 字面量都必须在两种语言下解析成可读文案。
   *
   * 上面的用例只列了分页词条，漏一个键（例如新增词条只加了 `i18n.ts`、忘了
   * `FORWARD_LIST_TEXT`，或反之）就会把 `forward.xxx` 原样画到界面上 —— 这正是
   * 本切片曾经出过的缺陷。类型检查能挡住一部分，但 `bun test` 不跑 tsc，所以这里
   * 用一个不依赖人工维护清单的断言把它钉住。
   */
  test('组件里每个 L("…") 字面量都有可读文案（新增词条不会画成原始 key）', () => {
    const literalKeys = [...COMPONENT.matchAll(/\bL\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(literalKeys.length).toBeGreaterThan(0);
    const keys = new Set<ForwardListTextKey>([
      ...(literalKeys as ForwardListTextKey[]),
      // 动态 key（auto-port 提示 / 占位符）两种取值都要覆盖。
      listenPortHintKey(""),
      listenPortHintKey("20001"),
      listenPortPlaceholderKey(""),
      listenPortPlaceholderKey("20001"),
    ]);
    for (const key of keys) {
      for (const locale of ["zh", "en"] as const) {
        const text = forwardListText(makeT(getDictionary(locale)), locale, key);
        expect(text, `${locale}:${key}`).not.toBe(key);
        expect(text.length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("加载 / 错误状态不变量", () => {
  test("首屏即 loading，且加载态渲染占位行（不是空列表）", () => {
    expect(COMPONENT).toContain("const [loading, setLoading] = useState(true)");
    expect(COMPONENT).toContain('t("common.loading")');
  });

  test("失败必须给出可见错误 + 可重试入口，而不是只 toast 就走了", () => {
    expect(COMPONENT).toContain("const [error, setError] = useState<string | null>(null)");
    expect(COMPONENT).toContain('data-testid="forward-list-error"');
    expect(COMPONENT).toContain('role="alert"');
    expect(COMPONENT).toMatch(/onClick=\{reloadList\}/);
  });

  test("错误态不得退化成「还没有转发」空态（否则把加载失败讲成没有数据）", () => {
    expect(COMPONENT).toContain("{!loading && !error && total === 0 && !hasFilters ? (");
  });

  test("旧响应不覆盖新响应（连点翻页 / 连改筛选时）", () => {
    expect(COMPONENT).toContain("const listSeq = useRef(0)");
    expect(COMPONENT).toContain("const seq = ++listSeq.current");
    expect(COMPONENT).toMatch(/if \(cancelled \|\| seq !== listSeq\.current\) return;/);
  });

  test("筛选变化一律回第 1 页", () => {
    expect(COMPONENT).toContain("function changeFilter<T>(setter: (value: T) => void, value: T)");
    expect(COMPONENT).toMatch(/function changeFilter<T>[\s\S]{0,200}setPage\(1\);/);
  });

  test("越界页夹回最后一页（删掉最后一页最后一行不会停在空页）", () => {
    expect(COMPONENT).toContain("clampForwardPage(result.page, result.total, result.page_size)");
    expect(COMPONENT).toMatch(/if \(clamped !== result\.page\) \{/);
  });

  test("关键字防抖后再查询，且不把每次击键都发成请求", () => {
    expect(COMPONENT).toContain("setTimeout(");
    expect(COMPONENT).toContain("setKeyword(next)");
  });

  test("走分页端点（page）而不是裸数组端点（list）", () => {
    // 跨行排版也要能匹配：`api.forwards` 换行后接 `.page(listQuery)`
    expect(COMPONENT).toMatch(/api\.forwards\s*\.page\(listQuery\)/);
    // 列表只能经分页端点取数；`api.forwards.list(` 一次都不该出现
    // （裸数组端点没有 total/page，按分页读会得到 undefined）
    expect(COMPONENT).not.toContain("api.forwards.list(");
  });
});

describe("复制 Forward / Binding usage 在列表侧的接线", () => {
  test("行菜单有复制入口，且草稿复用共享纯逻辑（不在组件里另写一套）", () => {
    expect(COMPONENT).toContain("forwardCopyDraft(");
    expect(TABLE).toMatch(/data-testid=\{`forward-copy-\$\{forward\.id\}`\}/);
  });

  test("复制最终落到真实 create 契约（没有第二条写路径）", () => {
    expect(COMPONENT).toContain("api.forwards.create(");
    // 复制只能经用户确认后提交，不得自动 POST
    expect(COMPONENT).toMatch(/function copyForward\(forward: PortForward\)[\s\S]{0,700}setCreateOpen\(true\);/);
  });

  test("出口下拉展示绑定使用量，且读的是后端投影而不是前端重算", () => {
    expect(CREATE_DIALOG).toContain("bindingUsageView(");
    expect(CREATE_DIALOG).toContain("hasBindingUsage(");
    expect(CREATE_DIALOG).not.toMatch(/used_by_forward_count\s*>:?/);
  });
});

describe("批量操作上限与后端一致（读真实源码断言）", () => {
  /**
   * `FORWARD_BATCH_MAX_IDS` 在前端是**镜像常量**（组件里再声明一次，见该常量注释）。
   * 镜像的固有风险是两边漂移：前端放行 60 条、后端 50 条 → 用户点了注定 400 的按钮。
   * 这里直接读后端源码比对取值，漂移时测试立刻红。
   */
  test("前端镜像值 == backend/src/services/forward-batch.ts", () => {
    const backend = readFileSync(
      new URL("../../../../../backend/src/services/forward-batch.ts", import.meta.url),
      "utf8",
    );
    const m = backend.match(/export const FORWARD_BATCH_MAX_IDS\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(FORWARD_BATCH_MAX_IDS).toBe(Number(m![1]));
  });

  test("批量动作白名单与后端一致（不含 delete：不可逆动作不给批量入口）", () => {
    const backend = readFileSync(
      new URL("../../../../../backend/src/services/forward-batch.ts", import.meta.url),
      "utf8",
    );
    const m = backend.match(/export const FORWARD_BATCH_ACTIONS\s*=\s*\[([^\]]+)\]/);
    expect(m).not.toBeNull();
    const actions = m![1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    expect(actions).toEqual(["retry", "suspend", "resume"]);
    expect(actions).not.toContain("delete");
    // 组件只把这三个动作发给后端
    for (const action of actions) expect(COMPONENT).toContain(`"${action}"`);
  });
});
