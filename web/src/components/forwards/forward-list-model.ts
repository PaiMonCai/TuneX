import { interpolate } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import type { ForwardListQuery } from "@/lib/types";

/**
 * 批量动作的条数上限。
 *
 * 与 `backend/src/services/forward-batch.ts` 的 `FORWARD_BATCH_MAX_IDS` 保持一致：
 * 前端先拦一次是为了让用户在点击时就得到「请分批执行」，而不是发一次注定 400 的
 * 请求。真正的强约束仍在后端（前端校验只是体验优化，不是安全边界），所以这里
 * 刻意不引入运行时共享——它只是一份镜像，且由测试钉住两侧取值。
 */
export const FORWARD_BATCH_MAX_IDS = 50;

export type ForwardModeFilter = "all" | "direct" | "relay";
/**
 * 状态筛选的取值 == 后端 `apply_status` 白名单。
 *
 * 注意与 WP9 之前的行为差异：老 UI 的「待应用」是**前端**把 pending 与 applying
 * 合并显示的（`forward.apply_status !== "pending" && !== "applying"` 这种过滤）。
 * 服务端过滤是单值精确匹配（`parseForwardListStatus`），没有 OR 形态；若仍按老
 * 口径发 `apply_status=pending`，applying 的行会**静默消失**。因此这里把两者拆成
 * 独立选项，用户仍能分别看到，不会出现「筛选后少了一半数据」。
 */
export type ForwardStatusFilter = "all" | "active" | "error" | "suspended" | "pending" | "applying";

/** 服务端排序键（后端 forward-list-query.ts 白名单的超集子集，见 SORT_OPTIONS）。 */
export type ForwardSortKey =
  | "order_by"
  | "name"
  | "status"
  | "mode"
  | "listen_port"
  | "traffic"
  | "created_at"
  | "updated_at";

export type ForwardSortOrder = "asc" | "desc";

/** 每页条数：与后端 `MAX_FORWARD_PAGE_SIZE = 200` 上限一致地取常用档位。 */
export const FORWARD_PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
export const FORWARD_DEFAULT_PAGE_SIZE = FORWARD_PAGE_SIZE_OPTIONS[0];

/**
 * 默认排序：与后端 `DEFAULT_FORWARD_SORT = order_by / asc` 一致。
 *
 * 分页改造的目标是「让大列表好用」，不是「换掉用户已经熟悉的默认视图」，
 * 因此默认键必须与后端默认完全一致——否则首屏顺序会与老版本不符。
 */
export const FORWARD_DEFAULT_SORT: ForwardSortKey = "order_by";
export const FORWARD_DEFAULT_ORDER: ForwardSortOrder = "asc";

/**
 * 「时间/流量」类列默认倒序（新的在前、大的在前）；其余默认正序。
 *
 * 这是**仅用于切换列时**的初值：同一列再点一次只是翻转方向，不会重置成默认键，
 * 否则用户无法表达「按名称倒序」这样的组合。
 */
const DESC_FIRST_SORTS: readonly ForwardSortKey[] = ["created_at", "updated_at", "traffic"];

/**
 * 表头点击 → 下一次排序状态。纯函数，测试直接打它。
 *
 * 不变量：
 *   · 点同一列 → 只翻转方向；
 *   · 点另一列 → 换键 + 该键的默认方向（时间/流量倒序，其余正序）。
 */
export function forwardNextSort(
  current: { sort: ForwardSortKey; order: ForwardSortOrder },
  key: ForwardSortKey,
): { sort: ForwardSortKey; order: ForwardSortOrder } {
  if (current.sort === key) {
    return { sort: key, order: current.order === "asc" ? "desc" : "asc" };
  }
  return { sort: key, order: DESC_FIRST_SORTS.includes(key) ? "desc" : "asc" };
}

/**
 * 总页数：向上取整，**永不返回 0**。
 *
 * 0 页会让 UI 出现「第 1 / 0 页」，并且把「下一页」的禁用条件算错。
 * 与后端 `forwardPageCount` 同口径。
 */
export function forwardPageCount(total: number, pageSize: number): number {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : FORWARD_DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
}

/**
 * 页码夹取：删除最后一页的最后一行后，`page` 可能已经越界。
 *
 * 越界时停在越界页的后果是「空列表 + 一个不可能命中的页码」，用户只能自己点回
 * 上一页；这里把页码夹回最后一页，由调用方触发一次重取。
 */
export function clampForwardPage(page: number, total: number, pageSize: number): number {
  const pages = forwardPageCount(total, pageSize);
  const wanted = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  return Math.min(Math.max(1, wanted), pages);
}

/** 列表控件的全部状态（筛选 + 分页 + 排序）。 */
export interface ForwardListState {
  page: number;
  pageSize: number;
  sort: ForwardSortKey;
  order: ForwardSortOrder;
  mode: ForwardModeFilter;
  status: ForwardStatusFilter;
  ingress: string;
  egress: string;
  keyword: string;
}

/**
 * UI 状态 → 请求参数。
 *
 * 两条硬约束：
 *   1. `page` / `page_size` / `sort` / `order` **始终发送**（哪怕等于默认值）。
 *      后端按「参数是否出现」决定响应形态（`forwardListShape`）：不发送就会拿到
 *      裸数组，而调用方按分页读 → `data` 为 undefined。显式发送也比隐式默认更抗
 *      「后端换默认值」这类静默漂移。
 *   2. `all` / 空关键字**不发送**，而不是发 `""` 或 `"all"`。后端对未知值会回落成
 *      「不过滤」，发过去只是噪声；关键字更必须先 trim（`"  "` 不该触发一次带
 *      `keyword=%20%20` 的查询）。
 */
export function forwardListQuery(state: ForwardListState): ForwardListQuery {
  const query: ForwardListQuery = {
    page: Number.isFinite(state.page) && state.page >= 1 ? Math.floor(state.page) : 1,
    page_size: state.pageSize,
    sort: state.sort,
    order: state.order,
  };
  if (state.mode !== "all") query.mode = state.mode;
  if (state.status !== "all") query.apply_status = state.status;
  if (state.ingress !== "all") query.ingress_node_id = Number(state.ingress);
  if (state.egress !== "all") query.egress_node_id = Number(state.egress);
  const keyword = state.keyword.trim();
  if (keyword) query.keyword = keyword;
  return query;
}

/**
 * 分页控件文案。
 *
 * 本文件不改 `i18n.ts`（该文件由并行切片持有，同文件并发编辑会互相覆盖），
 * 所以采用「先查字典、缺词条再回落」：`translate()` 在词条缺失时会把 key 原样
 * 返回，据此可以判定是否回落 —— 界面永远不会出现 `forward.pagePrev` 这种原始 key，
 * 而词条一旦补进字典，这里自动切换成正式文案，不需要再改本组件。
 */
const FORWARD_LIST_TEXT = {
  zh: {
    "forward.pagePrev": "上一页",
    "forward.pageNext": "下一页",
    "forward.pageSize": "每页",
    "forward.pageInfo": "第 {page} / {pages} 页",
    "forward.allEgress": "全部出口节点",
    "forward.sortAsc": "升序",
    "forward.sortDesc": "降序",
    "forward.copyForward": "复制转发",
    "forward.copySuffix": "（副本）",
    "forward.bindingUsageUsed": "被 {count} 条转发使用",
    "forward.autoPortNotice": "未填写监听端口 = 由系统自动分配；实际端口在保存后确定。",
    "forward.autoPortPlaceholder": "自动分配",
    "forward.listenPortFixed": "指定端口必须落在该入口节点的可用端口区间内，保存后立即生效。",
    "forward.portPlaceholder": "20001",
    // ── V4-WP9 批量操作（可逆动作；批量删除被有意排除，见 reports/v4-wp9-plan.md §3）──
    "forward.selectAll": "全选本页",
    "forward.selectRow": "选择该转发",
    "forward.batchSelected": "已选 {count} 条",
    "forward.batchRetry": "批量重试",
    "forward.batchSuspend": "批量暂停",
    "forward.batchResume": "批量恢复",
    "forward.batchClear": "取消选择",
    "forward.batchResult": "成功 {succeeded} 条，失败 {failed} 条",
    "forward.batchLimit": "一次最多处理 {max} 条，请分批执行",
    "forward.batchPartial": "有 {failed} 条未成功，可单独重试",
    "forward.batchFailed": "批量操作失败",
  },
  en: {
    "forward.pagePrev": "Previous page",
    "forward.pageNext": "Next page",
    "forward.pageSize": "Per page",
    "forward.pageInfo": "Page {page} of {pages}",
    "forward.allEgress": "All egress nodes",
    "forward.sortAsc": "Ascending",
    "forward.sortDesc": "Descending",
    "forward.copyForward": "Duplicate forward",
    "forward.copySuffix": " (copy)",
    "forward.bindingUsageUsed": "Used by {count} forward(s)",
    "forward.autoPortNotice":
      "No listen port = the system assigns one automatically; the real port is fixed only after saving.",
    "forward.autoPortPlaceholder": "Automatic",
    "forward.listenPortFixed":
      "A fixed port must fall inside this ingress node's available port range and applies immediately.",
    "forward.portPlaceholder": "20001",
    // ── V4-WP9 batch actions (reversible only; bulk delete is deliberately
    //    excluded — see reports/v4-wp9-plan.md §3) ──
    "forward.selectAll": "Select this page",
    "forward.selectRow": "Select this forward",
    "forward.batchSelected": "{count} selected",
    "forward.batchRetry": "Retry selected",
    "forward.batchSuspend": "Suspend selected",
    "forward.batchResume": "Resume selected",
    "forward.batchClear": "Clear selection",
    "forward.batchResult": "{succeeded} succeeded, {failed} failed",
    "forward.batchLimit": "At most {max} at a time — please run it in batches",
    "forward.batchPartial": "{failed} could not be applied; retry them individually",
    "forward.batchFailed": "Batch action failed",
  },
} as const;

export type ForwardListTextKey = keyof (typeof FORWARD_LIST_TEXT)["zh"];

/** 词条优先、回落兜底（见 {@link FORWARD_LIST_TEXT}）。 */
export function forwardListText(
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: Locale,
  key: ForwardListTextKey,
  params?: Record<string, string | number>,
): string {
  const translated = t(key, params);
  if (translated !== key) return translated;
  return interpolate(FORWARD_LIST_TEXT[locale][key], params);
}

