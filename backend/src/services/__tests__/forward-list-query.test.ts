/**
 * V4-WP9 — 服务端分页 / 排序的查询解析层（`forward-list-query.ts`）。
 *
 * 这是「列表规模化」的正确性底座，因此不依赖 DB / Redis / Hono，全部纯函数直测。
 *
 * 覆盖矩阵（对应 §13.6「server pagination/filter/sort」）：
 *   1. page / page_size 的钳制与非法回落（含 0、负数、小数、字符串、缺省）；
 *   2. sort 白名单：未知键回落默认（不报错）；大小写与空白容错；
 *   3. order 只认 asc/desc；
 *   4. orderBy **永远**带 `id desc` 兜底（分页稳定性）；
 *   5. 过滤参数解析：数字端口/模式/状态的非法值不产生「静默空集」条件；
 *   6. `forwardPageCount` 不出现 0 页。
 *
 * 为什么 `id desc` 兜底要单独测：分页在没有唯一 tiebreak 时，同 `order_by` 的行
 * 在两次查询之间顺序不定，用户翻页会看到重复行或漏行——这是真实缺陷而不是
 * 理论问题（本包 S1 的验收项之一）。
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FORWARD_PAGE_SIZE,
  DEFAULT_FORWARD_SORT,
  DEFAULT_FORWARD_SORT_ORDER,
  FORWARD_SORT_COLUMNS,
  FORWARD_SORT_KEYS,
  MAX_FORWARD_PAGE_SIZE,
  forwardOrderBy,
  forwardPage,
  forwardPageCount,
  parseForwardListQuery,
  parseForwardPage,
  parseForwardPageSize,
  parseForwardSortKey,
  parseForwardSortOrder,
} from "../forward-list-query.ts";

describe("V4-WP9 分页参数解析", () => {
  test("page: 非法输入一律回落 1，合法值原样", () => {
    expect(parseForwardPage(undefined)).toBe(1);
    expect(parseForwardPage("")).toBe(1);
    expect(parseForwardPage("abc")).toBe(1);
    expect(parseForwardPage("0")).toBe(1);
    expect(parseForwardPage("-3")).toBe(1);
    expect(parseForwardPage("1.5")).toBe(1);
    expect(parseForwardPage("2")).toBe(2);
    expect(parseForwardPage("100")).toBe(100);
  });

  test("page_size: 缺省 20、上限 200、0 与负数回落缺省（不返回 0 条页面）", () => {
    expect(parseForwardPageSize(undefined)).toBe(DEFAULT_FORWARD_PAGE_SIZE);
    expect(parseForwardPageSize("")).toBe(DEFAULT_FORWARD_PAGE_SIZE);
    expect(parseForwardPageSize("0")).toBe(DEFAULT_FORWARD_PAGE_SIZE);
    expect(parseForwardPageSize("-10")).toBe(DEFAULT_FORWARD_PAGE_SIZE);
    expect(parseForwardPageSize("abc")).toBe(DEFAULT_FORWARD_PAGE_SIZE);
    expect(parseForwardPageSize("2.5")).toBe(DEFAULT_FORWARD_PAGE_SIZE);
    expect(parseForwardPageSize("50")).toBe(50);
    expect(parseForwardPageSize("200")).toBe(MAX_FORWARD_PAGE_SIZE);
    expect(parseForwardPageSize("1000")).toBe(MAX_FORWARD_PAGE_SIZE);
  });

  test("skip 由 page / page_size 派生（不是客户端传的 offset）", () => {
    expect(parseForwardListQuery({ page: "1", page_size: "20" }).skip).toBe(0);
    expect(parseForwardListQuery({ page: "3", page_size: "20" }).skip).toBe(40);
    expect(parseForwardListQuery({ page: "4", page_size: "200" }).skip).toBe(600);
    // 非法 page 与 page_size 各自独立回落，不互相影响
    const q = parseForwardListQuery({ page: "-1", page_size: "9999" });
    expect(q.page).toBe(1);
    expect(q.skip).toBe(0);
    expect(q.take).toBe(MAX_FORWARD_PAGE_SIZE);
  });
});

describe("V4-WP9 排序白名单", () => {
  test("白名单键与映射表一致（列名映射冻结）", () => {
    expect([...FORWARD_SORT_KEYS].sort()).toEqual(
      [
        "created_at",
        "listen_port",
        "mode",
        "name",
        "order_by",
        "status",
        "traffic",
        "updated_at",
      ].sort(),
    );
    // 响应字段名与数据库列名不同的两项必须映射正确，否则 UI 点表头会按错列排。
    expect(FORWARD_SORT_COLUMNS.status).toBe("apply_status");
    expect(FORWARD_SORT_COLUMNS.mode).toBe("tunnel_mode");
  });

  test("未知 / 注入样式的键回落默认，绝不透传成列名", () => {
    expect(parseForwardSortKey(undefined)).toBe(DEFAULT_FORWARD_SORT);
    expect(parseForwardSortKey("")).toBe(DEFAULT_FORWARD_SORT);
    expect(parseForwardSortKey("id; DROP TABLE tunnel")).toBe(
      DEFAULT_FORWARD_SORT,
    );
    expect(parseForwardSortKey("workspace_id")).toBe(DEFAULT_FORWARD_SORT);
    expect(parseForwardSortKey("traffic")).toBe("traffic");
  });

  test("大小写与空白容错", () => {
    expect(parseForwardSortKey(" NAME ")).toBe("name");
    expect(parseForwardSortKey("Traffic")).toBe("traffic");
    expect(parseForwardSortOrder(" DESC ")).toBe("desc");
    expect(parseForwardSortOrder("Asc")).toBe("asc");
  });

  test("order 只认 asc/desc，其余回落默认方向", () => {
    expect(parseForwardSortOrder(undefined)).toBe(DEFAULT_FORWARD_SORT_ORDER);
    expect(parseForwardSortOrder("ascending")).toBe(DEFAULT_FORWARD_SORT_ORDER);
    expect(parseForwardSortOrder("1")).toBe(DEFAULT_FORWARD_SORT_ORDER);
    expect(DEFAULT_FORWARD_SORT_ORDER).toBe("asc");
  });

  test("orderBy 永远带 id desc 兜底（分页稳定性）", () => {
    expect(forwardOrderBy("order_by", "asc")).toEqual([
      { order_by: "asc" },
      { id: "desc" },
    ]);
    expect(forwardOrderBy("name", "desc")).toEqual([
      { name: "desc" },
      { id: "desc" },
    ]);
    // 默认键的分页也与旧列表口径同形
    expect(forwardOrderBy(DEFAULT_FORWARD_SORT, DEFAULT_FORWARD_SORT_ORDER)).toEqual([
      { order_by: "asc" },
      { id: "desc" },
    ]);
  });

  test("白名单外传入（绕过 parse）时不产出未定义列名", () => {
    // 类型系统挡住这种调用，但运行时防御仍在：导出函数必须自带兜底。
    const rogue = forwardOrderBy("nope" as never, "asc");
    expect(rogue).toEqual([{ order_by: "asc" }, { id: "desc" }]);
  });
});

describe("V4-WP9 过滤参数解析", () => {
  test("模式与状态非法值被忽略（不成为过滤条件，避免静默空集）", () => {
    const q = parseForwardListQuery({
      mode: "tunnel",
      apply_status: "running",
    });
    expect(q.filters.mode).toBeUndefined();
    expect(q.filters.apply_status).toBeUndefined();
  });

  test("模式与状态合法值被保留", () => {
    const q = parseForwardListQuery({ mode: "relay", apply_status: "error" });
    expect(q.filters.mode).toBe("relay");
    expect(q.filters.apply_status).toBe("error");
  });

  test("节点 ID 只接受正整数", () => {
    const q = parseForwardListQuery({
      ingress_node_id: "7",
      egress_node_id: "0",
    });
    expect(q.filters.ingress_node_id).toBe(7);
    expect(q.filters.egress_node_id).toBeUndefined();
    expect(parseForwardListQuery({ egress_node_id: "-2" }).filters.egress_node_id)
      .toBeUndefined();
    expect(parseForwardListQuery({ egress_node_id: "abc" }).filters.egress_node_id)
      .toBeUndefined();
  });

  test("keyword 去空白；纯空白视为未提供", () => {
    expect(parseForwardListQuery({ keyword: "  web  " }).filters.keyword).toBe(
      "web",
    );
    expect(parseForwardListQuery({ keyword: "   " }).filters.keyword).toBeUndefined();
  });

  test("空 query 得到确定的默认形状（不依赖 undefined 传播）", () => {
    const q = parseForwardListQuery();
    expect(q).toEqual({
      page: 1,
      page_size: DEFAULT_FORWARD_PAGE_SIZE,
      skip: 0,
      take: DEFAULT_FORWARD_PAGE_SIZE,
      sort: DEFAULT_FORWARD_SORT,
      order: DEFAULT_FORWARD_SORT_ORDER,
      filters: {
        mode: undefined,
        apply_status: undefined,
        ingress_node_id: undefined,
        egress_node_id: undefined,
        keyword: undefined,
      },
    });
  });
});

describe("V4-WP9 分页信封", () => {
  test("信封字段与既有分页端点同形", () => {
    expect(forwardPage([{ id: 1 }], 42, 2, 20)).toEqual({
      data: [{ id: 1 }],
      total: 42,
      page: 2,
      page_size: 20,
    });
  });

  test("页数向上取整，永不出现 0 页", () => {
    expect(forwardPageCount(0, 20)).toBe(1);
    expect(forwardPageCount(1, 20)).toBe(1);
    expect(forwardPageCount(20, 20)).toBe(1);
    expect(forwardPageCount(21, 20)).toBe(2);
    expect(forwardPageCount(500, 200)).toBe(3);
    // pageSize 非法时不产生 Infinity / NaN
    expect(forwardPageCount(10, 0)).toBe(1);
  });
});
