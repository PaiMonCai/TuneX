/**
 * V4-WP9 §13.6「server pagination / filter / sort」——**纯函数**解析层。
 *
 * 为什么单独一个模块而不是写在路由里：
 *   · 路由的 zod schema 只校验请求体，query string 的钳制/回落规则无法复用；
 *   · 分页与排序是「产品契约」，前端 mock（web/src/mocks/handler.ts）必须镜像
 *     同一套口径，否则 mock 下的分页行为与真实后端静默不一致；
 *   · 纯函数可离线单测（无 DB / 无 Redis），符合本仓库「CI 绿 ≠ 运行时对，
 *     但纯逻辑必须本地可验」的分工。
 *
 * 口径（与 §13.6 的 DoD 对齐）：
 *   · `page` ≥ 1，非数字回落 1；
 *   · `page_size` 钳到 [1, 200]，缺省 20 —— 与 `routes/node-groups.ts`、
 *     `routes/tunnels.ts` 的既有分页口径一致（同一产品里不能有两套上限）；
 *   · `sort` 走**白名单**，未知值回落默认键（不报错：UI 传错值不该看到空列表，
 *     与 mock 的「未知过滤值被忽略」同一取向）；
 *   · `order` 只接受 asc/desc，未知回落 `DEFAULT_FORWARD_SORT_ORDER`；
 *   · 排序**永远**追加 `id desc` 兜底：同名/同 order_by 的行必须稳定，
 *     否则翻页时同一行可能在两页出现或被跳过（keyset 之外最常见的分页 bug）。
 */
import type { ForwardApplyStatus, ForwardMode } from "./forward-service.ts";

/** 稳定兜底排序键：分页正确性依赖它，不是"顺手加的"。 */
export const FORWARD_SORT_TIEBREAK = "id" as const;

export type ForwardSortOrder = "asc" | "desc";

/**
 * 可排序字段白名单 → 数据库列。
 *
 * 值是 Prisma 列名（不是响应字段名）：`status` 在响应里叫 `apply_status`，
 * `mode` 叫 `tunnel_mode`。映射写在这里，路由与测试都只认这一份。
 */
export const FORWARD_SORT_COLUMNS = {
  order_by: "order_by",
  name: "name",
  status: "apply_status",
  mode: "tunnel_mode",
  listen_port: "listen_port",
  traffic: "traffic",
  created_at: "created_at",
  updated_at: "updated_at",
} as const;

export type ForwardSortKey = keyof typeof FORWARD_SORT_COLUMNS;

export const FORWARD_SORT_KEYS = Object.keys(
  FORWARD_SORT_COLUMNS,
) as ForwardSortKey[];

/**
 * 默认排序保持 WP4 之前的列表口径（`order_by asc, id desc`）。
 *
 * 为什么默认不是 created_at desc：改造分页是「让大列表好用」，不是「改变用户
 * 已经熟悉的默认视图」。用户想按时间看，显式点表头即可。
 */
export const DEFAULT_FORWARD_SORT: ForwardSortKey = "order_by";
export const DEFAULT_FORWARD_SORT_ORDER: ForwardSortOrder = "asc";

export const DEFAULT_FORWARD_PAGE_SIZE = 20;
export const MAX_FORWARD_PAGE_SIZE = 200;

/**
 * 「取全部」语义下的硬上限。
 *
 * 产品端点不带分页参数时返回裸数组（冻结的旧契约），兼容端点
 * `/api/nodes/:ingressId/forwards` 永远返回裸数组。两者都必须有上限：
 * 无界 `findMany` 在规模上来后是一次 OOM/超时事故，而不是「反正现在没事」。
 * 500 是「一次全量刷新仍可用」与「单次查询不会拖垮进程」之间的折中值。
 */
export const FORWARD_LIST_MAX_UNPAGED = 500;

export interface ForwardListFilters {
  mode?: ForwardMode;
  apply_status?: ForwardApplyStatus;
  ingress_node_id?: number;
  egress_node_id?: number;
  keyword?: string;
}

export interface ParsedForwardListQuery {
  page: number;
  page_size: number;
  skip: number;
  take: number;
  sort: ForwardSortKey;
  order: ForwardSortOrder;
  filters: ForwardListFilters;
}

/**
 * 响应形态决策：**带任一分页/排序参数** → 分页信封；否则 → 裸数组。
 *
 * 为什么是「参数出现」而不是「参数有值」：客户端显式写 `sort=order_by`
 * （与默认值同值）表明它就是要分页视图；按值判断会让 UI 点默认列表头
 * 拿到与其它表头不同类型（数组 vs 信封）的响应——那是最难查的一类前端 bug。
 */
export function forwardListShape(
  raw: Record<string, string | undefined> = {},
): "page" | "all" {
  return raw.page !== undefined ||
    raw.page_size !== undefined ||
    raw.sort !== undefined ||
    raw.order !== undefined
    ? "page"
    : "all";
}

/** 未知/空 → 默认键；大小写不敏感；绝不抛错。 */
export function parseForwardSortKey(raw: unknown): ForwardSortKey {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (FORWARD_SORT_KEYS as string[]).includes(value)
    ? (value as ForwardSortKey)
    : DEFAULT_FORWARD_SORT;
}

/** 未知/空 → 默认方向。 */
export function parseForwardSortOrder(raw: unknown): ForwardSortOrder {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return value === "asc" || value === "desc"
    ? value
    : DEFAULT_FORWARD_SORT_ORDER;
}

/** 非数字/越界 → 1；`null` / `""` 不特殊处理，就是非数字。 */
export function parseForwardPage(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return 1;
  return n;
}

/**
 * `page_size` 钳到 [1, 200]。注意 `page_size=0` 视为**非法**而不是"取 0 条"：
 * 0 条页面是 UI bug 的伪装，直接回落缺省更可诊断。
 */
export function parseForwardPageSize(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_FORWARD_PAGE_SIZE;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return DEFAULT_FORWARD_PAGE_SIZE;
  }
  return Math.min(MAX_FORWARD_PAGE_SIZE, n);
}

function parsePositiveInt(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const APPLY_STATUSES: ForwardApplyStatus[] = [
  "pending",
  "applying",
  "active",
  "error",
  "suspended",
];

function parseMode(raw: unknown): ForwardMode | undefined {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return value === "direct" || value === "relay"
    ? (value as ForwardMode)
    : undefined;
}

function parseApplyStatus(raw: unknown): ForwardApplyStatus | undefined {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (APPLY_STATUSES as string[]).includes(value)
    ? (value as ForwardApplyStatus)
    : undefined;
}

/**
 * query string → 分页 + 排序 + 过滤。
 *
 * 入参刻意收 `Record<string, string | undefined>`（Hono 的 `c.req.query()` 形态），
 * 这样路由层不做任何解析；测试直接传普通对象。
 */
export function parseForwardListQuery(
  raw: Record<string, string | undefined> = {},
): ParsedForwardListQuery {
  const page = parseForwardPage(raw.page);
  const page_size = parseForwardPageSize(raw.page_size);
  const keyword = raw.keyword?.trim();
  return {
    page,
    page_size,
    skip: (page - 1) * page_size,
    take: page_size,
    sort: parseForwardSortKey(raw.sort),
    order: parseForwardSortOrder(raw.order),
    filters: {
      mode: parseMode(raw.mode),
      apply_status: parseApplyStatus(raw.apply_status),
      ingress_node_id: parsePositiveInt(raw.ingress_node_id),
      egress_node_id: parsePositiveInt(raw.egress_node_id),
      keyword: keyword ? keyword : undefined,
    },
  };
}

/**
 * 排序白名单 → Prisma `orderBy`（含 `id desc` 兜底）。
 *
 * 返回普通对象数组而不是 `Prisma.TunnelOrderByWithRelationInput[]`：本模块要能
 * 在没有生成的 Prisma client 的环境里被单测直接 import。
 */
export function forwardOrderBy(
  sort: ForwardSortKey,
  order: ForwardSortOrder,
): Array<Record<string, "asc" | "desc">> {
  const column = FORWARD_SORT_COLUMNS[sort] ?? FORWARD_SORT_COLUMNS.order_by;
  return [{ [column]: order }, { [FORWARD_SORT_TIEBREAK]: "desc" }];
}

/** 分页信封：与 `routes/tunnels.ts` / `routes/node-groups.ts` 同形。 */
export interface ForwardPage<T> {
  data: T[];
  total: number;
  page: number;
  page_size: number;
}

export function forwardPage<T>(
  rows: T[],
  total: number,
  page: number,
  pageSize: number,
): ForwardPage<T> {
  return { data: rows, total, page, page_size: pageSize };
}

/**
 * 前端分页控件的页数。向上取整；总数 0 时至少 1 页，避免 UI 出现「第 1 / 0 页」。
 */
export function forwardPageCount(total: number, pageSize: number): number {
  if (pageSize < 1) return 1;
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}
