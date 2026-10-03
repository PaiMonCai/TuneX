"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Route,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { api, getActiveWorkspace } from "@/lib/api";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { PERMISSION_DENIED } from "@/lib/workspace-permissions";
import {
  forwardAccessAddress,
  forwardCopyDraft,
  listenPortHintKey,
  listenPortPlaceholderKey,
} from "@/components/forwards/forward-copy";
import {
  bindingUsageView,
  hasBindingUsage,
} from "@/components/forwards/forward-binding-usage";
import { ForwardEditDialog } from "@/components/forwards/forward-edit-dialog";
import { useI18n } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input, Label } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { interpolate } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import {
  applyErrorAction,
  forwardErrorActions,
  forwardErrorInfo,
  forwardProductBadgeVariant,
  forwardProductStatus,
} from "@/lib/forward-status";
import { formatBytes, formatDateTime } from "@/lib/utils";
import type {
  ForwardBatchAction,
  ForwardListQuery,
  ForwardSummary,
  NodeBinding,
  PortForward,
  UserNode,
} from "@/lib/types";

/**
 * 批量动作的条数上限。
 *
 * 与 `backend/src/services/forward-batch.ts` 的 `FORWARD_BATCH_MAX_IDS` 保持一致：
 * 前端先拦一次是为了让用户在点击时就得到「请分批执行」，而不是发一次注定 400 的
 * 请求。真正的强约束仍在后端（前端校验只是体验优化，不是安全边界），所以这里
 * 刻意不引入运行时共享——它只是一份镜像，且由测试钉住两侧取值。
 */
export const FORWARD_BATCH_MAX_IDS = 50;

type ForwardModeFilter = "all" | "direct" | "relay";
/**
 * 状态筛选的取值 == 后端 `apply_status` 白名单。
 *
 * 注意与 WP9 之前的行为差异：老 UI 的「待应用」是**前端**把 pending 与 applying
 * 合并显示的（`forward.apply_status !== "pending" && !== "applying"` 这种过滤）。
 * 服务端过滤是单值精确匹配（`parseForwardListStatus`），没有 OR 形态；若仍按老
 * 口径发 `apply_status=pending`，applying 的行会**静默消失**。因此这里把两者拆成
 * 独立选项，用户仍能分别看到，不会出现「筛选后少了一半数据」。
 */
type ForwardStatusFilter = "all" | "active" | "error" | "suspended" | "pending" | "applying";

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

function isIngress(node: UserNode) {
  return node.role === "ingress" || node.role === "both";
}

function isEgress(node: UserNode) {
  return node.role === "egress" || node.role === "both";
}

/**
 * 编辑器未选中行时的占位（避免 null 传播进受控表单）。
 * 仅用于渲染，open=false 时不会真正读到。
 */
const EMPTY_FORWARD: PortForward = {
  id: 0,
  name: "",
  mode: "direct",
  ingress_node_id: 0,
  egress_node_id: null,
  listen_port: null,
  target_host: null,
  target_port: null,
  created_at: "",
} as PortForward;

/** 可点表头（后端 sort 白名单里本表真实展示的列）。 */
function SortableHead({
  label,
  sortKey,
  sort,
  order,
  onSort,
}: {
  label: string;
  sortKey: ForwardSortKey;
  sort: ForwardSortKey;
  order: ForwardSortOrder;
  onSort: (key: ForwardSortKey) => void;
}) {
  const active = sort === sortKey;
  return (
    <TableHead aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-left hover:underline"
        onClick={() => onSort(sortKey)}
        data-testid={`forward-sort-${sortKey}`}
      >
        {label}
        {active ? (
          order === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

export function ForwardWorkspace() {
  const { t, locale } = useI18n();
  const { currentId, permissions, permissionsLoading, can, canForward } = useWorkspace();
  const canRead = can("forward:read");
  const canReadNodes = can("node:read");
  const canCreate = can("forward:create") && canReadNodes;
  const canManageNodes = can("node:manage");
  const [nodes, setNodes] = useState<UserNode[]>([]);
  const [bindings, setBindings] = useState<Record<number, NodeBinding[]>>({});
  const [summary, setSummary] = useState<ForwardSummary | null>(null);
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(FORWARD_DEFAULT_PAGE_SIZE);
  const [sort, setSort] = useState<ForwardSortKey>(FORWARD_DEFAULT_SORT);
  const [order, setOrder] = useState<ForwardSortOrder>(FORWARD_DEFAULT_ORDER);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 输入框实时值；`keyword` 是防抖后真正参与查询的值。 */
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [modeFilter, setModeFilter] = useState<ForwardModeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<ForwardStatusFilter>("all");
  const [ingressFilter, setIngressFilter] = useState("all");
  const [egressFilter, setEgressFilter] = useState("all");
  /** 写操作后强制重取当前页（页码/筛选都没变，靠它触发）。 */
  const [reloadToken, setReloadToken] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createdForward, setCreatedForward] = useState<PortForward | null>(null);
  const [createMode, setCreateMode] = useState<"direct" | "relay">("direct");
  const [name, setName] = useState("");
  const [ingressId, setIngressId] = useState("");
  const [egressId, setEgressId] = useState("");
  const [listenPort, setListenPort] = useState("");
  const [targetHost, setTargetHost] = useState("");
  const [targetPort, setTargetPort] = useState("");
  const [bindEgressId, setBindEgressId] = useState("");
  const [bindingBusy, setBindingBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<number | null>(null);
  /**
   * V4-WP9 §13.6：批量操作的选中集。
   *
   * 用 `Set<number>` 而不是「数组 + 当前页」：用户可能在翻页后继续勾选，
   * 选中集必须跨页存在（分页之后这正是批量操作最需要的能力）。
   * 清空时机有明确规则（见 `clearSelection` 与各筛选 setter）——不能默认「变了就清」，
   * 否则用户勾了 10 条再改个排序就全丢。
   */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  // V4-WP4：列表行也能全字段编辑（§13.3.1），不需要先进详情。
  const [editTarget, setEditTarget] = useState<PortForward | null>(null);
  /**
   * 列表请求序号：筛选/页码变动很快（连点表头、翻页），后发的请求不一定后到。
   * 只接受最新序号的响应，否则旧响应会把新条件下的结果覆盖回去——最典型的表现是
   * 「点了下一页，看到的还是上一页的内容」。
   */
  const listSeq = useRef(0);

  const L = (key: ForwardListTextKey, params?: Record<string, string | number>) =>
    forwardListText(t, locale, key, params);

  const ingressNodes = useMemo(() => nodes.filter(isIngress), [nodes]);
  const egressNodes = useMemo(() => nodes.filter(isEgress), [nodes]);
  // 编辑器的出口下拉用字符串 key（Record<string, NodeBinding[]>）。
  const bindingMapForDialog = useMemo(() => {
    const out: Record<string, NodeBinding[]> = {};
    for (const [key, value] of Object.entries(bindings)) out[String(key)] = value;
    return out;
  }, [bindings]);
  const selectedBindings = ingressId ? bindings[Number(ingressId)] ?? [] : [];
  const availableEgressNodes = useMemo(() => {
    if (!ingressId) return [];
    const ingress = Number(ingressId);
    const bound = new Set(
      (bindings[ingress] ?? []).map((binding) => Number(binding.egress_node_id)),
    );
    return nodes.filter(
      (node) =>
        isEgress(node) &&
        Number(node.id) !== ingress &&
        !bound.has(Number(node.id)),
    );
  }, [nodes, bindings, ingressId]);

  const pageCount = forwardPageCount(total, pageSize);
  const hasFilters =
    keyword.trim() !== "" ||
    modeFilter !== "all" ||
    statusFilter !== "all" ||
    ingressFilter !== "all" ||
    egressFilter !== "all";

  const listState: ForwardListState = useMemo(
    () => ({
      page,
      pageSize,
      sort,
      order,
      mode: modeFilter,
      status: statusFilter,
      ingress: ingressFilter,
      egress: egressFilter,
      keyword,
    }),
    [page, pageSize, sort, order, modeFilter, statusFilter, ingressFilter, egressFilter, keyword],
  );
  const listQuery = useMemo(() => forwardListQuery(listState), [listState]);

  /**
   * 汇总卡片与节点/绑定是不随筛选变化的「参考数据」，与列表分开取：
   * 翻页只该触发一次列表请求，不该顺带把全部节点的绑定再拉一遍。
   */
  /**
   * V4-WP8 §13.5 —— 写操作失败 → 「下一步做什么」。
   *
   * 抽成一处是因为列表页有 create / retry / suspend / resume / batch 多条写路径，
   * 每处各写一遍「取 condition → 查表」必然漂移；而 409 `condition`
   * （`node_in_maintenance` / `node_waiting_install` …）**必须**被消费，
   * 否则用户看到的是「保存失败」而不是「入口节点正在维护，请改选节点」。
   *
   * 输出顺序有意固定：先可执行的动作，再后端原文（原文是排障材料，可能要念给
   * 管理员）。没有任何已知动作时只给原文 —— 不编造通用建议。
   */
  function writeFailureText(err: unknown, fallback: string): string {
    const info = forwardErrorInfo(err);
    const actions = forwardErrorActions(locale, info);
    const parts = [...actions, info.message || fallback].filter((s) => s !== "");
    return parts.join(" ");
  }

  const referenceSeq = useRef(0);
  async function loadReference() {
    const seq = ++referenceSeq.current;
    const scope = currentId;
    const current = () => seq === referenceSeq.current && getActiveWorkspace() === scope;
    setNodes([]); setBindings({}); setSummary(null);
    // Independent permissions and partial loads: denied nodes must not erase Forward summary.
    const summaryTask = canRead ? api.forwards.summary().then((value) => {
      if (current()) setSummary(value);
    }).catch(() => {}) : Promise.resolve();
    const nodesTask = canReadNodes ? api.nodes.list().then(async (nodeRows) => {
      if (!current()) return;
      setNodes(nodeRows);
      const rows = await Promise.all(nodeRows.filter(isIngress).map(async (node) => ({
        id: Number(node.id), bindings: await api.nodes.bindings(node.id).catch(() => []),
      })));
      if (!current()) return;
      const map: Record<number, NodeBinding[]> = {};
      for (const row of rows) map[row.id] = row.bindings;
      setBindings(map);
    }).catch((err) => { if (current()) toast.error(err instanceof Error ? err.message : t("forward.loadFailed")); }) : Promise.resolve();
    await Promise.all([summaryTask, nodesTask]);
  }

  /** 写操作后刷新汇总：列表与卡片是两套口径（卡片是 workspace 全量）。 */
  async function reloadSummary() {
    if (!canRead) return;
    const scope = currentId;
    try {
      const value = await api.forwards.summary();
      if (getActiveWorkspace() === scope) setSummary(value);
    } catch {
      // 汇总失败不影响列表可用性；下一次写操作/刷新会再试。
    }
  }

  /** 强制重取当前页（写操作后用；筛选/页码未变时 effect 不会触发）。 */
  function reloadList() {
    setReloadToken((token) => token + 1);
    void reloadSummary();
  }

  useEffect(() => {
    void loadReference();
    const requestedIngress = new URLSearchParams(window.location.search).get("ingress_node_id");
    if (requestedIngress && /^\d+$/.test(requestedIngress)) {
      setIngressFilter(requestedIngress);
    }
    return () => { referenceSeq.current++; };
  }, [currentId, permissions]);

  useEffect(() => {
    setSelectedIds(new Set()); setEditTarget(null); setCreateOpen(false); setCreatedForward(null);
  }, [currentId, permissions]);

  /**
   * 关键字防抖：服务端过滤意味着「每敲一个字 = 一次查询」。
   *
   * 300ms 是「快速输入时不发请求」与「停手后马上看到结果」之间的折中；
   * 关键字变化同样回第 1 页（否则会停留在第 3 页看一个只有 1 页的结果集）。
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = keywordInput.trim();
      if (next === keyword) return;
      setKeyword(next);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [keywordInput, keyword]);

  useEffect(() => {
    const seq = ++listSeq.current;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setForwards([]);
    setTotal(0);
    if (!canRead || currentId === null) { setLoading(false); return; }
    api.forwards
      .page(listQuery)
      .then((result) => {
        if (cancelled || seq !== listSeq.current) return;
        // 越界页码（删掉最后一页的最后一行）夹回最后一页，由 effect 再取一次。
        const clamped = clampForwardPage(result.page, result.total, result.page_size);
        if (clamped !== result.page) {
          setPage(clamped);
          return;
        }
        setForwards(result.data);
        setTotal(result.total);
        setPage(result.page);
      })
      .catch((err: unknown) => {
        if (cancelled || seq !== listSeq.current) return;
        setForwards([]);
        setTotal(0);
        setError(err instanceof Error ? err.message : t("forward.loadFailed"));
      })
      .finally(() => {
        if (cancelled || seq !== listSeq.current) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listQuery, reloadToken, t, currentId, permissions, canRead]);

  /**
   * 筛选变化一律回第 1 页。
   *
   * 这是与「服务端分页」绑定的一条不变量：筛选前的第 3 页在筛选后可能根本不存在，
   * 不回第 1 页的结果是空列表 + 一个越界页码，用户会误以为「没有数据」。
   */
  function changeFilter<T>(setter: (value: T) => void, value: T) {
    setter(value);
    setPage(1);
  }

  function toggleSort(key: ForwardSortKey) {
    const next = forwardNextSort({ sort, order }, key);
    setSort(next.sort);
    setOrder(next.order);
    setPage(1);
  }

  function openCreate(mode: "direct" | "relay") {
    if (!canCreate) { toast.error(PERMISSION_DENIED); return; }
    const filteredIngress =
      ingressFilter !== "all"
        ? ingressNodes.find((node) => String(node.id) === ingressFilter)
        : undefined;
    const firstIngress = filteredIngress ?? ingressNodes[0];
    setCreateMode(mode);
    setName("");
    setIngressId(firstIngress ? String(firstIngress.id) : "");
    setEgressId("");
    setListenPort("");
    setTargetHost("");
    setTargetPort("");
    setBindEgressId("");
    setCreateOpen(true);
  }

  /**
   * V4-WP9 §13.6 复制 Forward（列表行入口）。
   *
   * 复制 = 用同一份 create 契约再建一条：草稿由 `forward-copy.ts`（与编辑器共用的
   * 纯逻辑）构造 —— 监听端口一律留空（自动分配，避免与源转发抢同一个入口端口）、
   * 运行态/流量/revision 结构上进不来。这里只负责把草稿装进创建表单让用户确认，
   * 真正的 POST 仍走 `createForward()`，因此「复制」没有第二条写路径。
   */
  function copyForward(forward: PortForward) {
    if (!canCreate) { toast.error(PERMISSION_DENIED); return; }
    const draft = forwardCopyDraft(forward, L("forward.copySuffix"));
    setCreateMode(draft.mode);
    setName(draft.name);
    setIngressId(draft.ingressId);
    setEgressId(draft.egressId);
    setListenPort(draft.listenPort);
    setTargetHost(draft.targetHost);
    setTargetPort(draft.targetPort);
    setBindEgressId("");
    setCreateOpen(true);
  }

  async function bindSelectedEgress() {
    if (!canManageNodes) { toast.error(PERMISSION_DENIED); return; }
    const ingress = Number(ingressId);
    const egress = Number(bindEgressId);
    if (!Number.isInteger(ingress) || !Number.isInteger(egress)) return;

    setBindingBusy(true);
    try {
      const binding = await api.nodes.bindEgress(ingress, egress);
      setBindings((current) => {
        const existing = current[ingress] ?? [];
        const next = existing.some(
          (row) => Number(row.egress_node_id) === Number(binding.egress_node_id),
        )
          ? existing
          : [...existing, binding];
        return { ...current, [ingress]: next };
      });
      setEgressId(String(binding.egress_node_id));
      setBindEgressId("");
      toast.success(t("node.bindSuccess"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("forward.bindFailed"));
    } finally {
      setBindingBusy(false);
    }
  }

  async function createForward() {
    if (!canCreate) { toast.error(PERMISSION_DENIED); return; }
    const ingress = Number(ingressId);
    const targetPortNum = Number(targetPort);
    const listenPortNum = listenPort ? Number(listenPort) : null;
    if (!name.trim() || !Number.isInteger(ingress) || !targetHost.trim() || !targetPort) {
      toast.error(t("forward.createFailed"));
      return;
    }
    if (
      !Number.isInteger(targetPortNum) ||
      targetPortNum < 1 ||
      targetPortNum > 65535 ||
      (listenPortNum !== null && (!Number.isInteger(listenPortNum) || listenPortNum < 1 || listenPortNum > 65535))
    ) {
      toast.error(t("forward.createFailed"));
      return;
    }
    if (createMode === "relay" && !egressId) {
      toast.error(t("forward.chooseEgress"));
      return;
    }

    setBusy(true);
    try {
      const created = await api.forwards.create({
        mode: createMode,
        ingress_node_id: ingress,
        name: name.trim(),
        listen_port: listenPortNum,
        target_host: targetHost.trim(),
        target_port: targetPortNum,
        egress_node_id: createMode === "relay" ? Number(egressId) : null,
      });
      setCreatedForward(created);
      setCreateOpen(false);
      // 新行按默认排序（order_by asc）不一定落在当前页，回到第 1 页更容易被看到。
      setPage(1);
      reloadList();
    } catch (err) {
      toast.error(writeFailureText(err, t("forward.createFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function runAction(forward: PortForward, action: "retry" | "suspend" | "resume") {
    if (!canForward(forward, "update")) { toast.error(PERMISSION_DENIED); return; }
    setActionBusy(Number(forward.id));
    try {
      await api.forwards.action(forward.id, action);
      reloadList();
    } catch (err) {
      toast.error(writeFailureText(err, t("forward.loadFailed")));
    } finally {
      setActionBusy(null);
    }
  }

  /* ------------------------------------------------------------------ */
  /* V4-WP9 §13.6：批量操作                                              */
  /* ------------------------------------------------------------------ */

  /** 选中集的唯一修改点（不可变更新，避免 Set 被就地改写导致漏渲染）。 */
  function toggleSelected(id: number, checked: boolean) {
    const row = forwards.find((f) => Number(f.id) === id);
    if (checked && (!row || !canForward(row, "update"))) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setBatchError(null);
  }

  const pageIds = useMemo(() => forwards.filter((row) => canForward(row, "update")).map((row) => Number(row.id)), [forwards, permissions]);
  const selectedOnPage = pageIds.filter((id) => selectedIds.has(id));
  const allPageSelected = pageIds.length > 0 && selectedOnPage.length === pageIds.length;

  /**
   * 本页「全选/全不选」。
   *
   * 语义是**并集**（不会清掉其它页已选的项）：跨页勾选是分页列表的既定能力，
   * 一个「全选本页」把别的页清掉会让用户以为选中集被重置了。
   */
  function toggleSelectAllOnPage(checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of pageIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  /**
   * 批量执行。
   *
   * 上限在前端先拦一次（`FORWARD_BATCH_MAX_IDS`）：让用户在点击时就得到
   * 「请分批执行」，而不是发一次注定 400 的请求。真正的强约束仍在后端
   * （前端校验只是体验优化，不是安全边界）。
   */
  async function runBatch(action: ForwardBatchAction) {
    const ids = [...selectedIds];
    // Revalidate all selected resources before batching (including cross-page selections).
    if (!can("forward:update")) { setBatchError(PERMISSION_DENIED); return; }
    if (permissions?.forward_mutations === "own") {
      const rows = await Promise.all(ids.map((id) => api.forwards.detail(id).catch(() => null)));
      if (getActiveWorkspace() !== currentId || rows.some((row) => !row || !canForward(row, "update"))) {
        setBatchError(PERMISSION_DENIED); return;
      }
    }
    if (ids.length === 0) return;
    if (ids.length > FORWARD_BATCH_MAX_IDS) {
      setBatchError(L("forward.batchLimit", { max: FORWARD_BATCH_MAX_IDS }));
      return;
    }
    setBatchBusy(true);
    setBatchError(null);
    try {
      const result = await api.forwards.batch({ action, ids });
      // 逐条结果 + 200：失败条数必须显式告诉用户，不能只看 promise 是否 reject。
      if (result.failed > 0) {
        toast.warning(
          `${L("forward.batchResult", {
            succeeded: result.succeeded,
            failed: result.failed,
          })} · ${L("forward.batchPartial", { failed: result.failed })}`,
        );
        // 只保留失败的项继续选中，方便用户直接改动作或逐条处理。
        const failedIds = new Set(
          result.results.filter((row) => !row.ok).map((row) => Number(row.id)),
        );
        setSelectedIds(failedIds);
      } else {
        toast.success(
          L("forward.batchResult", { succeeded: result.succeeded, failed: 0 }),
        );
        clearSelection();
      }
      reloadList();
    } catch (err) {
      // 批量失败同样是写失败：按 condition/apply_error_code 给下一步，
      // 并在页内保留一条常驻提示（toast 会消失，而用户要照着做）。
      const message = writeFailureText(err, L("forward.batchFailed"));
      setBatchError(message);
      toast.error(message);
    } finally {
      setBatchBusy(false);
    }
  }

  async function removeForward(forward: PortForward) {
    if (!canForward(forward, "delete")) { toast.error(PERMISSION_DENIED); return; }
    if (!confirm(t("forward.deleteConfirm").replace("{name}", forward.name))) return;
    setActionBusy(Number(forward.id));
    try {
      await api.forwards.remove(forward.id);
      toast.success(t("forward.deleteSuccess"));
      reloadList();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("forward.loadFailed"));
    } finally {
      setActionBusy(null);
    }
  }

  if (permissionsLoading) return <p>{t("common.loading")}</p>;
  if (!canRead) return <p role="alert">{PERMISSION_DENIED}</p>;
  return (
    <div className="flex flex-col gap-5">
      {!can("forward:update") && <p className="text-sm text-[var(--muted-foreground)]">只读：当前有效权限不允许修改转发。</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={modeFilter === "all" ? "default" : "outline"}
            onClick={() => changeFilter(setModeFilter, "all")}
          >
            {t("forward.all")}
          </Button>
          <Button
            size="sm"
            variant={modeFilter === "direct" ? "default" : "outline"}
            onClick={() => changeFilter(setModeFilter, "direct")}
          >
            {t("forward.direct")}
          </Button>
          <Button
            size="sm"
            variant={modeFilter === "relay" ? "default" : "outline"}
            onClick={() => changeFilter(setModeFilter, "relay")}
          >
            {t("forward.relay")}
          </Button>
          <Input
            className="h-9 w-64"
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
            placeholder={t("forward.searchPlaceholder")}
            data-testid="forward-keyword"
          />
          <Select value={statusFilter} onValueChange={(value) => changeFilter(setStatusFilter, value as ForwardStatusFilter)}>
            <SelectTrigger className="h-9 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("forward.statusAll")}</SelectItem>
              <SelectItem value="active">{t("forward.statusActive")}</SelectItem>
              <SelectItem value="pending">{t("forward.statusPending")}</SelectItem>
              <SelectItem value="applying">{t("tunnel.v3ApplyApplying")}</SelectItem>
              <SelectItem value="suspended">{t("forward.statusSuspended")}</SelectItem>
              <SelectItem value="error">{t("forward.statusError")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={ingressFilter} onValueChange={(value) => changeFilter(setIngressFilter, value)}>
            <SelectTrigger className="h-9 w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("forward.allIngress")}</SelectItem>
              {ingressNodes.map((node) => (
                <SelectItem key={String(node.id)} value={String(node.id)}>
                  {node.node_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={egressFilter} onValueChange={(value) => changeFilter(setEgressFilter, value)}>
            <SelectTrigger className="h-9 w-48" data-testid="forward-egress-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{L("forward.allEgress")}</SelectItem>
              {egressNodes.map((node) => (
                <SelectItem key={String(node.id)} value={String(node.id)}>
                  {node.node_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!canCreate} variant="outline" onClick={() => openCreate("direct")}>
            <Plus className="size-4" />
            {t("forward.createDirect")}
          </Button>
          <Button disabled={!canCreate} onClick={() => openCreate("relay")}>
            <Route className="size-4" />
            {t("forward.createRelay")}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-[var(--muted-foreground)]">{t("forward.monitorTotal")}</div>
            <div className="mt-1 text-2xl font-semibold">{summary?.total ?? (loading ? "—" : 0)}</div>
            <div className="mt-1 text-xs text-[var(--muted-foreground)]">
              {t("forward.direct")} {summary?.direct ?? 0} · {t("forward.relay")} {summary?.relay ?? 0}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-[var(--muted-foreground)]">{t("forward.monitorActive")}</div>
            <div className="mt-1 text-2xl font-semibold">{summary?.active ?? (loading ? "—" : 0)}</div>
            <div className="mt-1 text-xs text-[var(--muted-foreground)]">
              {t("forward.statusPending")} {summary?.pending ?? 0} · {t("forward.statusSuspended")} {summary?.suspended ?? 0}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-[var(--muted-foreground)]">{t("forward.monitorAttention")}</div>
            <div className="mt-1 text-2xl font-semibold">{summary?.error ?? (loading ? "—" : 0)}</div>
            <div className="mt-1 text-xs text-[var(--muted-foreground)]">{t("forward.monitorAttentionHint")}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-[var(--muted-foreground)]">{t("forward.monitorTraffic")}</div>
            <div className="mt-1 text-2xl font-semibold">{formatBytes(summary?.traffic ?? 0)}</div>
            <div className="mt-1 text-xs text-[var(--muted-foreground)]">{t("forward.monitorTrafficHint")}</div>
          </CardContent>
        </Card>
      </div>

      {error ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--destructive)] p-3 text-sm"
          role="alert"
          data-testid="forward-list-error"
        >
          <span className="text-[var(--destructive)]">{error}</span>
          <Button size="sm" variant="outline" onClick={reloadList} disabled={loading}>
            {t("common.refresh")}
          </Button>
        </div>
      ) : null}

      {/*
        V4-WP9 §13.6 批量操作栏：仅在选中 ≥1 条时出现，避免占用常态空间。
        只提供可逆动作（重试 / 暂停 / 恢复）——批量删除被有意排除，
        理由见 reports/v4-wp9-plan.md §3（不可逆 + 部分成功无法解释）。
      */}
      {selectedIds.size > 0 ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)]/40 p-3"
          data-testid="forward-batch-bar"
        >
          <span className="text-sm font-medium" data-testid="forward-batch-count">
            {L("forward.batchSelected", { count: selectedIds.size })}
          </span>
          <Button
            size="sm"
            variant="outline"
            data-testid="forward-batch-retry"
            disabled={batchBusy}
            onClick={() => void runBatch("retry")}
          >
            {batchBusy ? <Loader2 className="size-4 animate-spin" /> : null}
            {L("forward.batchRetry")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="forward-batch-suspend"
            disabled={batchBusy}
            onClick={() => void runBatch("suspend")}
          >
            {L("forward.batchSuspend")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="forward-batch-resume"
            disabled={batchBusy}
            onClick={() => void runBatch("resume")}
          >
            {L("forward.batchResume")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="forward-batch-clear"
            disabled={batchBusy}
            onClick={clearSelection}
          >
            {L("forward.batchClear")}
          </Button>
          {batchError ? (
            <span className="text-xs text-[var(--destructive)]" role="alert" data-testid="forward-batch-error">
              {batchError}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* 出错时不能落到「还没建转发」的空态：那会把一次加载失败讲成「你没有数据」 */}
      {!loading && !error && total === 0 && !hasFilters ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ArrowLeftRight className="size-5" />
                {t("forward.createDirect")}
              </CardTitle>
              <CardDescription>{t("forward.directDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button disabled={!canCreate} onClick={() => openCreate("direct")}>{t("forward.createDirect")}</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Route className="size-5" />
                {t("forward.createRelay")}
              </CardTitle>
              <CardDescription>{t("forward.relayDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button disabled={!canCreate} onClick={() => openCreate("relay")}>{t("forward.createRelay")}</Button>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] p-3"
            data-testid="forward-list-controls"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-[var(--muted-foreground)]">{t("fields.orderBy")}</span>
              <Select
                value={sort}
                onValueChange={(value) => {
                  setSort(value as ForwardSortKey);
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-9 w-36" data-testid="forward-sort-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="order_by">{t("fields.orderBy")}</SelectItem>
                  <SelectItem value="name">{t("common.name")}</SelectItem>
                  <SelectItem value="mode">{t("forward.mode")}</SelectItem>
                  <SelectItem value="listen_port">{t("forward.listenPort")}</SelectItem>
                  <SelectItem value="status">{t("common.status")}</SelectItem>
                  <SelectItem value="created_at">{t("common.createdAt")}</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                data-testid="forward-sort-order"
                aria-label={order === "asc" ? L("forward.sortAsc") : L("forward.sortDesc")}
                onClick={() => {
                  setOrder(order === "asc" ? "desc" : "asc");
                  setPage(1);
                }}
              >
                {order === "asc" ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-[var(--muted-foreground)]" data-testid="forward-total">
                {t("common.total")} {total} {t("common.items")}
              </span>
              <span className="text-xs text-[var(--muted-foreground)]">{L("forward.pageSize")}</span>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  setPageSize(Number(value));
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-9 w-24" data-testid="forward-page-size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORWARD_PAGE_SIZE_OPTIONS.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="icon"
                variant="outline"
                data-testid="forward-page-prev"
                aria-label={L("forward.pagePrev")}
                disabled={loading || page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="text-xs text-[var(--muted-foreground)]" data-testid="forward-page-info">
                {L("forward.pageInfo", { page, pages: pageCount })}
              </span>
              <Button
                size="icon"
                variant="outline"
                data-testid="forward-page-next"
                aria-label={L("forward.pageNext")}
                disabled={loading || page >= pageCount}
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      className="size-4 cursor-pointer"
                      data-testid="forward-select-all"
                      aria-label={L("forward.selectAll")}
                      disabled={!can("forward:update") || pageIds.length === 0}
                      checked={allPageSelected}
                      onChange={(event) => toggleSelectAllOnPage(event.target.checked)}
                    />
                  </TableHead>
                  <SortableHead
                    label={t("common.name")}
                    sortKey="name"
                    sort={sort}
                    order={order}
                    onSort={toggleSort}
                  />
                  <SortableHead
                    label={t("forward.mode")}
                    sortKey="mode"
                    sort={sort}
                    order={order}
                    onSort={toggleSort}
                  />
                  <TableHead>{t("forward.ingressNode")}</TableHead>
                  <TableHead>{t("forward.egressNode")}</TableHead>
                  <SortableHead
                    label={t("forward.listenPort")}
                    sortKey="listen_port"
                    sort={sort}
                    order={order}
                    onSort={toggleSort}
                  />
                  <TableHead>{t("forward.accessAddress")}</TableHead>
                  <TableHead>{t("forward.target")}</TableHead>
                  <SortableHead
                    label={t("common.status")}
                    sortKey="status"
                    sort={sort}
                    order={order}
                    onSort={toggleSort}
                  />
                  <SortableHead
                    label={t("common.createdAt")}
                    sortKey="created_at"
                    sort={sort}
                    order={order}
                    onSort={toggleSort}
                  />
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={11} className="h-24 text-center text-[var(--muted-foreground)]">
                      {t("common.loading")}
                    </TableCell>
                  </TableRow>
                ) : forwards.length === 0 ? (
                  <TableEmpty colSpan={11} text={t("common.noData")} />
                ) : (
                  forwards.map((forward) => (
                    <TableRow key={String(forward.id)}>
                      <TableCell>
                        <input
                          type="checkbox"
                          className="size-4 cursor-pointer"
                          data-testid={`forward-select-${forward.id}`}
                          aria-label={L("forward.selectRow")}
                          disabled={!canForward(forward, "update")}
                          checked={selectedIds.has(Number(forward.id))}
                          onChange={(event) =>
                            toggleSelected(Number(forward.id), event.target.checked)
                          }
                        />
                      </TableCell>
                      <TableCell className="font-medium">
                        <Link href={"/forwards/" + forward.id} className="hover:underline">
                          {forward.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant={forward.mode === "relay" ? "outline" : "secondary"}>
                          {forward.mode === "relay" ? t("forward.relay") : t("forward.direct")}
                        </Badge>
                      </TableCell>
                      <TableCell>{forward.ingress_node?.node_id ?? forward.ingress_node_id}</TableCell>
                      <TableCell>{forward.egress_node?.node_id ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {forward.listen_port == null ? t("forward.addressPending") : `:${forward.listen_port}`}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {forwardAccessAddress(forward) ?? t("forward.addressPending")}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {forward.target_host ?? "—"}{forward.target_port ? ":" + forward.target_port : ""}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {(() => {
                            // V4-WP8 §13.7：产品状态取代 raw apply_status 枚举
                            //（唯一实现见 lib/forward-status.ts）。
                            const product = forwardProductStatus(forward);
                            return (
                              <Badge
                                variant={forwardProductBadgeVariant(product.state)}
                                data-testid={`forward-status-${forward.id}`}
                              >
                                {t(`forward.product.${product.state}`)}
                              </Badge>
                            );
                          })()}
                          {forward.apply_error ? (
                            /* V4-WP8 §13.5：先给「下一步」，原文仍保留（排障用）。 */
                            <span className="max-w-52 text-xs text-[var(--destructive)]">
                              {applyErrorAction(locale, forward.apply_error_code) ? (
                                <span className="block">
                                  {applyErrorAction(locale, forward.apply_error_code)}
                                </span>
                              ) : null}
                              <span className="block truncate font-mono opacity-70">
                                {forward.apply_error}
                              </span>
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-[var(--muted-foreground)]">
                        {formatDateTime(forward.created_at)}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" disabled={actionBusy === Number(forward.id)}>
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canForward(forward, "update") && forward.apply_status === "error" ? (
                              <DropdownMenuItem onClick={() => void runAction(forward, "retry")}>
                                {t("forward.retry")}
                              </DropdownMenuItem>
                            ) : null}
                            {canForward(forward, "update") && forward.apply_status === "active" ? (
                              <DropdownMenuItem onClick={() => void runAction(forward, "suspend")}>
                                {t("forward.suspend")}
                              </DropdownMenuItem>
                            ) : null}
                            {canForward(forward, "update") && forward.apply_status === "suspended" ? (
                              <DropdownMenuItem onClick={() => void runAction(forward, "resume")}>
                                {t("forward.resume")}
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem disabled={!canForward(forward, "update")} onClick={() => setEditTarget(forward)}>
                              <Pencil className="size-4" />
                              {t("forward.editForward")}
                            </DropdownMenuItem>
                            {/* V4-WP9 §13.6：复制 = 同一份 create 契约再建一条（端口自动分配）。 */}
                            <DropdownMenuItem
                              disabled={!canCreate}
                               data-testid={`forward-copy-${forward.id}`}
                              onClick={() => copyForward(forward)}
                            >
                              <Copy className="size-4" />
                              {L("forward.copyForward")}
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={!canForward(forward, "delete")} className="text-[var(--destructive)]" onClick={() => void removeForward(forward)}>
                              <Trash2 className="size-4" />
                              {t("common.delete")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <Dialog open={createOpen && canCreate} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {createMode === "relay" ? t("forward.createRelay") : t("forward.createDirect")}
            </DialogTitle>
            <DialogDescription>
              {createMode === "relay" ? t("forward.relayDesc") : t("forward.directDesc")}
            </DialogDescription>
          </DialogHeader>

          {ingressNodes.length === 0 ? (
            <div className="rounded-md border border-[var(--border)] p-4 text-sm text-[var(--muted-foreground)]">
              {t("forward.noIngress")}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <Field label={t("common.name")}>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="web-hk" />
              </Field>
              <Field label={t("forward.ingressNode")}>
                <Select
                  value={ingressId}
                  onValueChange={(value) => {
                    setIngressId(value);
                    setEgressId("");
                    setBindEgressId("");
                  }}
                >
                  <SelectTrigger><SelectValue placeholder={t("forward.chooseIngress")} /></SelectTrigger>
                  <SelectContent>
                    {ingressNodes.map((node) => (
                      <SelectItem key={String(node.id)} value={String(node.id)}>
                        {node.node_id} · {node.connect_ip ?? t("node.waiting")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              {createMode === "relay" ? (
                <Field label={t("forward.egressNode")}>
                  <div className="flex flex-col gap-3">
                    {selectedBindings.length > 0 ? (
                      <Select value={egressId} onValueChange={setEgressId}>
                        <SelectTrigger><SelectValue placeholder={t("forward.chooseEgress")} /></SelectTrigger>
                        <SelectContent>
                          {selectedBindings.map((binding) => (
                            <SelectItem key={String(binding.egress_node_id)} value={String(binding.egress_node_id)}>
                              {binding.egress_node.node_id} · {binding.egress_node.connect_ip ?? t("node.waiting")}
                              {/*
                               * V4-WP9 §13.6「Binding usage」：使用量是后端响应投影
                               * （`used_by_forward_count`），前端不重算；选出出口时就能
                               * 看到它已经被多少条中继占用，而不是解绑时被 409 告知。
                               */}
                              {hasBindingUsage(binding)
                                ? ` · ${L("forward.bindingUsageUsed", {
                                    count: bindingUsageView(binding).used_by_forward_count,
                                  })}`
                                : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <div className="rounded-md border border-dashed border-[var(--border)] p-3 text-sm text-[var(--muted-foreground)]">
                        <div>{t("forward.noBoundEgress")}</div>
                        <div className="mt-1 text-xs">{t("forward.bindFirstHint")}</div>
                      </div>
                    )}

                    {canManageNodes && availableEgressNodes.length > 0 ? (
                      <div className="rounded-md border border-[var(--border)] p-3">
                        <div className="mb-2 text-xs font-medium text-[var(--muted-foreground)]">
                          {selectedBindings.length > 0
                            ? t("forward.bindAnotherEgress")
                            : t("forward.bindInline")}
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Select value={bindEgressId} onValueChange={setBindEgressId}>
                            <SelectTrigger className="min-w-0 flex-1">
                              <SelectValue placeholder={t("forward.chooseUnboundEgress")} />
                            </SelectTrigger>
                            <SelectContent>
                              {availableEgressNodes.map((node) => (
                                <SelectItem key={String(node.id)} value={String(node.id)}>
                                  {node.node_id} · {node.connect_ip ?? t("node.waiting")}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void bindSelectedEgress()}
                            disabled={bindingBusy || !bindEgressId}
                          >
                            {t("forward.bindAndUse")}
                          </Button>
                        </div>
                      </div>
                    ) : selectedBindings.length === 0 ? (
                      <div className="text-xs text-[var(--muted-foreground)]">
                        {t("forward.noAvailableEgress")}{" "}
                        <Link href="/nodes" className="underline underline-offset-2">
                          {t("common.nodes")}
                        </Link>
                      </div>
                    ) : null}
                  </div>
                </Field>
              ) : null}

              {/*
               * 空值 = 自动分配。提示与占位符都走 `forward-copy.ts` 的纯逻辑，
               * 保证「空」永远被渲染成文字而不是一个看起来像真值的端口号。
               */}
              <Field label={t("forward.listenPort")} hint={L(listenPortHintKey(listenPort))}>
                <Input
                  inputMode="numeric"
                  value={listenPort}
                  onChange={(event) => setListenPort(event.target.value)}
                  placeholder={L(listenPortPlaceholderKey(listenPort))}
                  data-testid="forward-listen-port"
                />
              </Field>
              <Field label={t("forward.targetHost")}>
                <Input value={targetHost} onChange={(event) => setTargetHost(event.target.value)} placeholder="example.com" />
              </Field>
              <Field label={t("forward.targetPort")}>
                <Input
                  inputMode="numeric"
                  value={targetPort}
                  onChange={(event) => setTargetPort(event.target.value)}
                  placeholder="443"
                />
              </Field>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t("common.cancel")}</Button>
            <Button
              onClick={() => void createForward()}
              disabled={
                busy ||
                ingressNodes.length === 0 ||
                (createMode === "relay" && (!egressId || selectedBindings.length === 0))
              }
            >
              {createMode === "relay" ? t("forward.createRelay") : t("forward.createDirect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createdForward !== null} onOpenChange={(open) => !open && setCreatedForward(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("forward.createReceiptTitle")}</DialogTitle>
            <DialogDescription>
              {forwardAccessAddress(createdForward ?? EMPTY_FORWARD)
                ? t("forward.createReceiptAddress")
                : t("forward.createReceiptPending")}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-[var(--border)] px-4 py-3 font-mono text-sm">
            {forwardAccessAddress(createdForward ?? EMPTY_FORWARD) ?? t("forward.addressPending")}
          </div>
          <DialogFooter>
            <Button onClick={() => setCreatedForward(null)}>{t("common.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* V4-WP4：列表行进入全字段编辑；保存后按 updated 回填行，保持列表可用 */}
      <ForwardEditDialog
        open={editTarget !== null && canForward(editTarget, "update")}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        forward={editTarget ?? EMPTY_FORWARD}
        nodes={nodes}
        bindings={bindingMapForDialog}
        onSaved={(updated) => {
          setForwards((rows) =>
            rows.map((row) => (Number(row.id) === Number(updated.id) ? updated : row)),
          );
          setEditTarget(null);
          void reloadSummary();
        }}
        onReload={() => void reloadList()}
      />
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-[var(--muted-foreground)]">{hint}</p> : null}
    </div>
  );
}
