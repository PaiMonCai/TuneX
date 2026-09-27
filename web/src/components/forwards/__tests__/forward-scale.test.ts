/**
 * V4-WP9 §13.6「Forward 列表：服务端 pagination / filter / sort」契约测试。
 *
 * 这个文件就是 `web/src/mocks/handler.ts` 里 `MOCK_FORWARD_SORT_FIELDS` 注释所引用的
 * 「契约测试（forward-scale.test.ts）」——mock 与 `backend/src/services/forward-list-query.ts`
 * 是同一套口径的两份实现，本文件把**可见行为**钉死，防止两边静默分叉。
 *
 * 覆盖三块：
 *   1. mock/后端可见契约：响应形态决策、分页窗口、排序白名单与方向、五类过滤、组合；
 *   2. 列表组件的纯逻辑：页码计算/夹取、表头点击 → 排序态、UI 状态 → 查询参数；
 *   3. 接线不变量：越界页必须夹回（后端会原样回显越界页码，不夹取就是「空列表 + 不存在的页码」）。
 *
 * 全部通过 mock handler 与纯函数验证（无 DOM / 无网络）。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  FORWARD_DEFAULT_ORDER,
  FORWARD_DEFAULT_PAGE_SIZE,
  FORWARD_PAGE_SIZE_OPTIONS,
  FORWARD_DEFAULT_SORT,
  clampForwardPage,
  forwardListQuery,
  forwardNextSort,
  forwardPageCount,
  type ForwardListState,
  type ForwardSortKey,
} from "@/components/forwards/forward-workspace";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";
import type { Paginated, PortForward } from "@/lib/types";

const COOKIE = "tunex_session=u1"; // 种子里 tunnels 1..4 的 owner（普通用户）

/** 驱动 mock handler：path 上的 query string 自行解析成 query 对象（handler 不解 URL） */
const call = <T>(method: string, path: string, body?: unknown) => {
  const [bare, qs] = path.split("?");
  const query: Record<string, string> = {};
  if (qs) for (const [k, v] of new URLSearchParams(qs).entries()) query[k] = v;
  return handleMock(method, bare, { cookie: COOKIE, body, query }) as Promise<{
    status: number;
    body: T;
  }>;
};

/** 种子：user 1 名下有 4 条 port_forward（id 1..4；id 5 是 remote_port_forward，不算转发）。 */
const SEED_TOTAL = 4;
const SEED_ORDER_BY_ASC = [1, 2, 3, 4];

const rowIds = (page: Paginated<PortForward>) => page.data.map((row) => Number(row.id));

const listState = (over: Partial<ForwardListState> = {}): ForwardListState => ({
  page: 1,
  pageSize: FORWARD_DEFAULT_PAGE_SIZE,
  sort: FORWARD_DEFAULT_SORT,
  order: FORWARD_DEFAULT_ORDER,
  mode: "all",
  status: "all",
  ingress: "all",
  egress: "all",
  keyword: "",
  ...over,
});

beforeEach(() => resetStore());

describe("响应形态：带分页/排序参数 → 信封；否则 → 裸数组", () => {
  test("不带任何分页参数仍是裸数组（冻结的旧契约，不能被分页改造破坏）", async () => {
    const { status, body } = await call<PortForward[]>("GET", "/forwards");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(SEED_TOTAL);
  });

  test("page / page_size / sort / order **任一**参数出现即切到信封（按「出现」判定，不按「有值」）", async () => {
    for (const qs of [
      "page=1",
      "page_size=20",
      "sort=order_by",
      "order=asc",
      // 与后端默认值同值也算：客户端显式写出来就说明它要分页视图
      "sort=order_by&order=asc",
    ]) {
      const { body } = await call<PortForward[] | Paginated<PortForward>>("GET", `/forwards?${qs}`);
      expect(Array.isArray(body)).toBe(false);
      const page = body as Paginated<PortForward>;
      expect(page.total).toBe(SEED_TOTAL);
      expect(page.page).toBe(1);
      expect(typeof page.page_size).toBe("number");
    }
  });
});

describe("默认排序与分页窗口", () => {
  test("默认排序 = order_by asc（与 WP4 之前一致，首屏顺序不变）", async () => {
    const { body } = await call<Paginated<PortForward>>(
      "GET",
      "/forwards?page=1&page_size=20&sort=order_by&order=asc",
    );
    expect(rowIds(body)).toEqual(SEED_ORDER_BY_ASC);
    // 组件默认值必须与后端默认值一致，否则首屏顺序与老版本不符
    expect(FORWARD_DEFAULT_SORT).toBe("order_by");
    expect(FORWARD_DEFAULT_ORDER).toBe("asc");
  });

  test("相邻页不重叠、合起来等于全集（每行恰好出现一次）", async () => {
    const p1 = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=2&sort=order_by&order=asc");
    const p2 = await call<Paginated<PortForward>>("GET", "/forwards?page=2&page_size=2&sort=order_by&order=asc");
    expect(rowIds(p1.body)).toEqual([1, 2]);
    expect(rowIds(p2.body)).toEqual([3, 4]);
    expect(new Set([...rowIds(p1.body), ...rowIds(p2.body)]).size).toBe(SEED_TOTAL);
    // total 是**过滤后**的全量，不随页码变
    expect(p1.body.total).toBe(SEED_TOTAL);
    expect(p2.body.total).toBe(SEED_TOTAL);
  });

  test("越界页返回空 data 且原样回显该页码（所以前端必须夹取，见最后一节）", async () => {
    const { body } = await call<Paginated<PortForward>>(
      "GET",
      "/forwards?page=9&page_size=2&sort=order_by&order=asc",
    );
    expect(body.data).toEqual([]);
    expect(body.page).toBe(9);
    expect(body.total).toBe(SEED_TOTAL);
  });

  test("page / page_size 钳制：0 与非法值回落 1 / 20，超上限钳到 200", async () => {
    const zero = await call<Paginated<PortForward>>("GET", "/forwards?page=0&page_size=0");
    expect(zero.body.page).toBe(1);
    expect(zero.body.page_size).toBe(FORWARD_DEFAULT_PAGE_SIZE);
    const huge = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=999");
    expect(huge.body.page_size).toBe(200);
  });
});

describe("排序：白名单 + 方向", () => {
  test("方向真的生效（同一列 asc / desc 互为逆序）", async () => {
    const asc = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&sort=created_at&order=asc");
    const desc = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&sort=created_at&order=desc");
    expect(rowIds(desc.body)).toEqual([...rowIds(asc.body)].reverse());
    expect(rowIds(desc.body)).toEqual([4, 3, 2, 1]);
  });

  test("白名单外的 sort 键回落默认键（不报错、也不返回空集）", async () => {
    const bogus = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&sort=drop_table&order=asc");
    expect(bogus.status).toBe(200);
    expect(rowIds(bogus.body)).toEqual(SEED_ORDER_BY_ASC);
  });

  test("未知 order 回落 asc（只认 asc/desc）", async () => {
    const bogus = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&sort=created_at&order=sideways");
    const asc = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&sort=created_at&order=asc");
    expect(rowIds(bogus.body)).toEqual(rowIds(asc.body));
  });

  test("所有白名单键都可用（与后端 FORWARD_SORT_COLUMNS 同一词表）", async () => {
    const keys: ForwardSortKey[] = [
      "order_by",
      "name",
      "status",
      "mode",
      "listen_port",
      "traffic",
      "created_at",
      "updated_at",
    ];
    for (const key of keys) {
      const { status, body } = await call<Paginated<PortForward>>(
        "GET",
        `/forwards?page=1&page_size=20&sort=${key}&order=asc`,
      );
      expect(status).toBe(200);
      expect(body.data.length).toBe(SEED_TOTAL);
    }
  });
});

describe("过滤：mode / apply_status / ingress / egress / keyword", () => {
  test("mode 只回该模式，未知值被忽略（不返回空集）", async () => {
    const relay = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&mode=relay");
    expect(rowIds(relay.body)).toEqual([2, 3]);
    expect(relay.body.total).toBe(2);

    const unknown = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&mode=quantum");
    expect(unknown.body.total).toBe(SEED_TOTAL);

    // 「全部」由前端拆成不带参数，绝不发 "all" 给后端
    expect(forwardListQuery(listState({ mode: "all" }))).not.toHaveProperty("mode");
  });

  test("apply_status 精确匹配单值；pending 与 applying **不是**同一个过滤值", async () => {
    const applying = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&apply_status=applying");
    expect(rowIds(applying.body)).toEqual([3]);

    const pending = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&apply_status=pending");
    expect(rowIds(pending.body)).toEqual([]);

    const active = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&apply_status=active");
    expect(rowIds(active.body)).toEqual([1, 2]);
  });

  test("ingress_node_id / egress_node_id 只回该节点的行", async () => {
    const ingress = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&ingress_node_id=1");
    expect(rowIds(ingress.body)).toEqual(SEED_ORDER_BY_ASC);

    const egress = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&egress_node_id=6");
    expect(rowIds(egress.body)).toEqual([3]);
    for (const row of egress.body.data) expect(Number(row.egress_node_id)).toBe(6);

    // 非法/非正数节点 id 被忽略，而不是「命中 0 行」
    const bogus = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&ingress_node_id=abc");
    expect(bogus.body.total).toBe(SEED_TOTAL);
  });

  test("keyword 跨字段模糊匹配；无命中时 total=0（不是无限下一页）", async () => {
    const ssh = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&keyword=ssh");
    expect(rowIds(ssh.body)).toEqual([2]);

    const none = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=20&keyword=zzzz");
    expect(none.body.data).toEqual([]);
    expect(none.body.total).toBe(0);
  });

  test("过滤与分页**组合**：total 反映过滤后的集合，窗口在过滤后的集合上切", async () => {
    const relay = await call<Paginated<PortForward>>("GET", "/forwards?page=1&page_size=1&mode=relay&sort=order_by&order=asc");
    const relay2 = await call<Paginated<PortForward>>("GET", "/forwards?page=2&page_size=1&mode=relay&sort=order_by&order=asc");
    expect(relay.body.total).toBe(2);
    expect(relay2.body.total).toBe(2);
    expect(rowIds(relay.body)).toEqual([2]);
    expect(rowIds(relay2.body)).toEqual([3]);
    // 过滤后的第 3 页越界（只有 2 条）
    const relay3 = await call<Paginated<PortForward>>("GET", "/forwards?page=3&page_size=1&mode=relay");
    expect(relay3.body.data).toEqual([]);
  });

  test("筛选变化必须回第 1 页（组件侧用 changeFilter 保证，这里钉住参数构造）", () => {
    // 第 3 页 + 筛选条件同发是合法请求，但视图会停在越界页；因此组件在改筛选时
    // 重置页码。这里验证「页码由 state 决定」这一前提不被破坏。
    const state = listState({ page: 3, status: "error" });
    expect(forwardListQuery(state)).toMatchObject({ page: 3, apply_status: "error" });
  });
});

describe("UI 状态 → 查询参数", () => {
  test("page / page_size / sort / order 始终发送（即使等于默认值）", () => {
    const query = forwardListQuery(listState());
    expect(query).toEqual({
      page: 1,
      page_size: FORWARD_DEFAULT_PAGE_SIZE,
      sort: "order_by",
      order: "asc",
    });
    // 显式发送才能稳定拿到信封；漏发会退回裸数组 → data 为 undefined
    expect(Object.keys(query)).toContain("page");
    expect(Object.keys(query)).toContain("sort");
  });

  test("all / 空关键字不发送（不发 \"\"，也不发 \"all\"）", () => {
    const query = forwardListQuery(
      listState({ mode: "all", status: "all", ingress: "all", egress: "all", keyword: "" }),
    );
    expect(query).not.toHaveProperty("mode");
    expect(query).not.toHaveProperty("apply_status");
    expect(query).not.toHaveProperty("ingress_node_id");
    expect(query).not.toHaveProperty("egress_node_id");
    expect(query).not.toHaveProperty("keyword");
  });

  test("关键字先 trim：纯空白不触发查询，前后空白不进入参数", () => {
    expect(forwardListQuery(listState({ keyword: "   " }))).not.toHaveProperty("keyword");
    expect(forwardListQuery(listState({ keyword: "  ssh  " })).keyword).toBe("ssh");
  });

  test("节点下拉的字符串值折算成数字 id", () => {
    const query = forwardListQuery(listState({ ingress: "3", egress: "6" }));
    expect(query.ingress_node_id).toBe(3);
    expect(query.egress_node_id).toBe(6);
  });

  test("非法页码在构造参数前就被夹到 1", () => {
    expect(forwardListQuery(listState({ page: 0 })).page).toBe(1);
    expect(forwardListQuery(listState({ page: -5 })).page).toBe(1);
    expect(forwardListQuery(listState({ page: 2 })).page).toBe(2);
  });

  test("每页档位都在后端 [1,200] 上限内", () => {
    for (const size of FORWARD_PAGE_SIZE_OPTIONS) {
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(200);
    }
    expect(FORWARD_PAGE_SIZE_OPTIONS).toContain(FORWARD_DEFAULT_PAGE_SIZE);
  });
});

describe("序号 / 页码纯逻辑", () => {
  test("页数向上取整且不低于 1（永不出现「第 1 / 0 页」）", () => {
    expect(forwardPageCount(0, 20)).toBe(1);
    expect(forwardPageCount(1, 20)).toBe(1);
    expect(forwardPageCount(20, 20)).toBe(1);
    expect(forwardPageCount(21, 20)).toBe(2);
    expect(forwardPageCount(200, 20)).toBe(10);
    expect(forwardPageCount(4, 2)).toBe(2);
  });

  test("非法的 total / pageSize 不产生 NaN 或 0 页", () => {
    expect(forwardPageCount(Number.NaN, 20)).toBe(1);
    expect(forwardPageCount(-5, 20)).toBe(1);
    expect(forwardPageCount(50, 0)).toBe(3); // pageSize 非法 → 回落默认 20
    expect(forwardPageCount(50, Number.NaN)).toBe(3);
  });

  test("页码夹取：删掉最后一页最后一行后停在最后一页，而不是越界页", () => {
    // 只剩 4 条、每页 2 条 → 2 页
    expect(clampForwardPage(3, 4, 2)).toBe(2);
    expect(clampForwardPage(2, 4, 2)).toBe(2);
    expect(clampForwardPage(1, 4, 2)).toBe(1);
    // 结果集空了 → 夹到第 1 页（唯一的合法页）
    expect(clampForwardPage(5, 0, 2)).toBe(1);
    expect(clampForwardPage(0, 4, 2)).toBe(1);
    expect(clampForwardPage(Number.NaN, 4, 2)).toBe(1);
  });

  test("表头点击：同一列翻转方向，另一列换键 + 该键默认方向", () => {
    // 同列 → 只翻转，不重置成默认键（否则无法表达「按名称倒序」）
    expect(forwardNextSort({ sort: "name", order: "asc" }, "name")).toEqual({ sort: "name", order: "desc" });
    expect(forwardNextSort({ sort: "name", order: "desc" }, "name")).toEqual({ sort: "name", order: "asc" });

    // 换列 → 时间/流量类默认倒序（新的/大的在前）
    expect(forwardNextSort({ sort: "order_by", order: "asc" }, "created_at")).toEqual({ sort: "created_at", order: "desc" });
    expect(forwardNextSort({ sort: "order_by", order: "asc" }, "traffic")).toEqual({ sort: "traffic", order: "desc" });
    // 其余列默认正序
    expect(forwardNextSort({ sort: "created_at", order: "desc" }, "name")).toEqual({ sort: "name", order: "asc" });
    expect(forwardNextSort({ sort: "name", order: "desc" }, "listen_port")).toEqual({ sort: "listen_port", order: "asc" });
  });

  test("越界页的接线不变量：后端回显越界页码 → 夹取后必然与回显页不同 → 触发一次重取", async () => {
    const { body } = await call<Paginated<PortForward>>("GET", "/forwards?page=3&page_size=2&sort=order_by&order=asc");
    const clamped = clampForwardPage(body.page, body.total, body.page_size);
    expect(body.page).toBe(3);
    expect(clamped).toBe(2);
    // 这正是组件里 `if (clamped !== result.page) { setPage(clamped); return; }` 的判定
    expect(clamped).not.toBe(body.page);
  });
});
