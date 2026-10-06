"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, getActiveWorkspace } from "@/lib/api";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { PERMISSION_DENIED } from "@/lib/workspace-permissions";
import {
  forwardAccessAddress,
  forwardCopyDraft,
} from "@/components/forwards/forward-copy";
import {
  forwardProtocolFields,
  tlsPathFieldErrors,
} from "@/lib/forward-protocol";
import { ForwardEditDialog } from "@/components/forwards/forward-edit-dialog";
import { ForwardListControls } from "@/components/forwards/forward-list-controls";
import { ForwardTable } from "@/components/forwards/forward-table";
import { ForwardCreateDialog } from "@/components/forwards/forward-create-dialog";
import { ForwardBatchBar } from "@/components/forwards/forward-batch-bar";
import { ForwardSummaryCards } from "@/components/forwards/forward-summary-cards";
import { ForwardToolbar } from "@/components/forwards/forward-toolbar";
import { ForwardEmptyState } from "@/components/forwards/forward-empty-state";
import { copiedForwardCreateDraft, emptyForwardCreateDraft } from "@/components/forwards/forward-create-model";
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
  forwardErrorActions,
  forwardErrorInfo,
} from "@/lib/forward-status";
import type {
  ForwardBatchAction,
  ForwardSummary,
  NodeBinding,
  PortForward,
  UserNode,
} from "@/lib/types";

export {
  FORWARD_BATCH_MAX_IDS,
  FORWARD_DEFAULT_ORDER,
  FORWARD_DEFAULT_PAGE_SIZE,
  FORWARD_DEFAULT_SORT,
  FORWARD_PAGE_SIZE_OPTIONS,
  clampForwardPage,
  forwardListQuery,
  forwardListText,
  forwardNextSort,
  forwardPageCount,
} from "@/components/forwards/forward-list-model";
import {
  FORWARD_BATCH_MAX_IDS,
  FORWARD_DEFAULT_ORDER,
  FORWARD_DEFAULT_PAGE_SIZE,
  FORWARD_DEFAULT_SORT,
  FORWARD_PAGE_SIZE_OPTIONS,
  clampForwardPage,
  forwardListQuery,
  forwardListText,
  forwardNextSort,
  forwardPageCount,
  type ForwardListState,
  type ForwardListTextKey,
  type ForwardModeFilter,
  type ForwardStatusFilter,
  type ForwardSortKey,
  type ForwardSortOrder,
} from "@/components/forwards/forward-list-model";

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
  const [createDraft, setCreateDraft] = useState(() => emptyForwardCreateDraft("direct"));
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
  const selectedBindings = createDraft.ingressId ? bindings[Number(createDraft.ingressId)] ?? [] : [];
  const availableEgressNodes = useMemo(() => {
    if (!createDraft.ingressId) return [];
    const ingress = Number(createDraft.ingressId);
    const bound = new Set(
      (bindings[ingress] ?? []).map((binding) => Number(binding.egress_node_id)),
    );
    return nodes.filter(
      (node) =>
        isEgress(node) &&
        Number(node.id) !== ingress &&
        !bound.has(Number(node.id)),
    );
  }, [nodes, bindings, createDraft.ingressId]);

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
  /** 绑定事实是否"取不到"（读取失败 / 还没读到 / 没有读权限）。 */
  //
  // 这三种情况在界面上**都不是**"没有可用出口"：把空 map 当权威会让创建对话框
  // 给出错误结论（"这台入口没有已绑定的出口"），而这正是本专项反复修的
  // "把取不到说成没有"。所以它们只用来把结论降级成"事实取不到"，不改变任何动作可用性。
  const [bindingsUnavailable, setBindingsUnavailable] = useState(false);
  const [referenceLoaded, setReferenceLoaded] = useState(false);
  async function loadReference() {
    const seq = ++referenceSeq.current;
    const scope = currentId;
    const current = () => seq === referenceSeq.current && getActiveWorkspace() === scope;
    setNodes([]); setBindings({}); setSummary(null);
    setReferenceLoaded(false);
    setBindingsUnavailable(false);
    // Independent permissions and partial loads: denied nodes must not erase Forward summary.
    const summaryTask = canRead ? api.forwards.summary().then((value) => {
      if (current()) setSummary(value);
    }).catch((err) => {
      if (current()) toast.error(err instanceof Error ? err.message : t("forward.summaryLoadFailed"));
    }) : Promise.resolve();
    const nodesTask = canReadNodes ? api.nodes.list().then(async (nodeRows) => {
      if (!current()) return;
      setNodes(nodeRows);
      const rows = await Promise.all(nodeRows.filter(isIngress).map(async (node) => ({
        id: Number(node.id), bindings: await api.nodes.bindings(node.id).catch(() => null),
      })));
      if (!current()) return;
      const map: Record<number, NodeBinding[]> = {};
      let bindingsFailed = false;
      for (const row of rows) {
        if (row.bindings === null) {
          bindingsFailed = true;
          continue;
        }
        map[row.id] = row.bindings;
      }
      if (bindingsFailed) toast.error(t("forward.bindingsLoadFailed"));
      setBindings(map);
      setBindingsUnavailable(bindingsFailed);
    }).catch((err) => { if (current()) toast.error(err instanceof Error ? err.message : t("forward.loadFailed")); }) : Promise.resolve();
    await Promise.all([summaryTask, nodesTask]);
    if (current()) setReferenceLoaded(true);
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
    const filteredIngress = ingressFilter !== "all"
      ? ingressNodes.find((node) => String(node.id) === ingressFilter)
      : undefined;
    setCreateDraft(emptyForwardCreateDraft(mode, filteredIngress ?? ingressNodes[0]));
    setCreateOpen(true);
  }

  /**
   * V4-WP9 §13.6 复制 Forward（列表行入口）。
   *
   * 复制 = 用同一份 create 契约再建一条：草稿由 `forward-copy.ts`（与编辑器共用的
   * 纯逻辑）构造 —— 监听端口一律留空（自动分配，避免与源转发抢同一个入口端口）、
   * 运行态/流量/revision 结构上进不来。这里只负责把草稿装进创建表单让用户确认，
   * 真正的 POST 仍走 `createForward()`，因此「复制」没有第二条写路径。
   *
   * V5-WP5-A1：协议与 tls 的证书/私钥路径都随草稿带过（复制一条 tls 转发必须还是
   * tls；路径现在由 `forwardView` 投影，所以不必再让运维重敲一遍），源行缺路径时
   * 草稿留空并由表单预检拦下（见 `forwardCopyDraft`）。
   */
  function copyForward(forward: PortForward) {
    if (!canCreate) { toast.error(PERMISSION_DENIED); return; }
    setCreateDraft(copiedForwardCreateDraft(forward, L("forward.copySuffix")));
    setCreateOpen(true);
  }

  async function bindSelectedEgress() {
    if (!canManageNodes) { toast.error(PERMISSION_DENIED); return; }
    const ingress = Number(createDraft.ingressId);
    const egress = Number(createDraft.bindEgressId);
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
      setCreateDraft((draft) => ({ ...draft, egressId: String(binding.egress_node_id), bindEgressId: "" }));
      toast.success(t("node.bindSuccess"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("forward.bindFailed"));
    } finally {
      setBindingBusy(false);
    }
  }

  /**
   * V5-WP5-A1：tls 路径的形态预检（与 create payload builder 成对，见
   * `lib/forward-protocol.ts`）。
   *
   * 「tls 但没有证书」在契约里不是一种状态：这里拦住它，而不是把半条配置发给
   * 后端换一个 400。非 tls 协议携带路径同样在此被拒（正常情况下到不了 —— 切换
   * 协议会清空路径输入）。
   */
  const protocolErrors = useMemo(
    () => tlsPathFieldErrors(createDraft.protocol, createDraft.tlsCertPath, createDraft.tlsKeyPath),
    [createDraft.protocol, createDraft.tlsCertPath, createDraft.tlsKeyPath],
  );
  const protocolReady = Object.keys(protocolErrors).length === 0;
  async function createForward() {
    if (!canCreate) { toast.error(PERMISSION_DENIED); return; }
    const ingress = Number(createDraft.ingressId);
    const targetPortNum = Number(createDraft.targetPort);
    const listenPortNum = createDraft.listenPort ? Number(createDraft.listenPort) : null;
    if (!createDraft.name.trim() || !Number.isInteger(ingress) || !createDraft.targetHost.trim() || !createDraft.targetPort) {
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
    if (createDraft.mode === "relay" && !createDraft.egressId) {
      toast.error(t("forward.chooseEgress"));
      return;
    }
    // 提交按钮已按同一份预检禁用；这里再拦一次，防止键盘/程序路径绕过。
    const firstProtocolError =
      protocolErrors.tls_cert_path ?? protocolErrors.tls_key_path;
    if (firstProtocolError) {
      toast.error(t(firstProtocolError));
      return;
    }

    setBusy(true);
    try {
      const created = await api.forwards.create({
        mode: createDraft.mode,
        ingress_node_id: ingress,
        name: createDraft.name.trim(),
        listen_port: listenPortNum,
        target_host: createDraft.targetHost.trim(),
        target_port: targetPortNum,
        egress_node_id: createDraft.mode === "relay" ? Number(createDraft.egressId) : null,
        // 协议与（仅 tls 的）路径由同一个纯函数生成：非 tls 的请求里两个路径键
        // 结构上不存在，不存在「发出去再让 Agent 决定忽略」的字段。
        ...forwardProtocolFields(createDraft.protocol, createDraft.tlsCertPath, createDraft.tlsKeyPath),
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
      <ForwardToolbar
        mode={modeFilter} status={statusFilter} ingress={ingressFilter} egress={egressFilter}
        keyword={keywordInput} ingressNodes={ingressNodes} egressNodes={egressNodes} canCreate={canCreate}
        t={t} text={L}
        onMode={(value) => changeFilter(setModeFilter, value)}
        onStatus={(value) => changeFilter(setStatusFilter, value)}
        onIngress={(value) => changeFilter(setIngressFilter, value)}
        onEgress={(value) => changeFilter(setEgressFilter, value)}
        onKeyword={setKeywordInput}
        onCreate={openCreate}
      />

      <ForwardSummaryCards summary={summary} loading={loading} t={t} />

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

      <ForwardBatchBar
        count={selectedIds.size}
        busy={batchBusy}
        error={batchError}
        text={L}
        onRun={(action) => void runBatch(action)}
        onClear={clearSelection}
      />

      {/* 出错时不能落到「还没建转发」的空态：那会把一次加载失败讲成「你没有数据」 */}
      {!loading && !error && total === 0 && !hasFilters ? (
        <ForwardEmptyState canCreate={canCreate} t={t} onCreate={openCreate} />
      ) : (
        <div className="flex flex-col gap-3">
          <ForwardListControls
            loading={loading}
            total={total}
            page={page}
            pageCount={pageCount}
            pageSize={pageSize}
            sort={sort}
            order={order}
            t={t}
            text={L}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            onSortChange={(nextSort) => {
              setSort(nextSort);
              setPage(1);
            }}
            onOrderChange={(nextOrder) => {
              setOrder(nextOrder);
              setPage(1);
            }}
          />

          <ForwardTable
            forwards={forwards}
            loading={loading}
            sort={sort}
            order={order}
            selectedIds={selectedIds}
            allPageSelected={allPageSelected}
            canUpdateAny={can("forward:update")}
            canCreate={canCreate}
            actionBusy={actionBusy}
            locale={locale}
            t={t}
            text={L}
            canUpdate={(forward) => canForward(forward, "update")}
            canDelete={(forward) => canForward(forward, "delete")}
            onSort={toggleSort}
            onSelectAll={toggleSelectAllOnPage}
            onSelect={toggleSelected}
            onAction={(forward, action) => void runAction(forward, action)}
            onEdit={setEditTarget}
            onCopy={copyForward}
            onDelete={(forward) => void removeForward(forward)}
          />
        </div>
      )}

      <ForwardCreateDialog
        open={createOpen && canCreate}
        draft={createDraft}
        ingressNodes={ingressNodes}
        selectedBindings={selectedBindings}
        availableEgressNodes={availableEgressNodes}
        // 事实取不到（读失败 / 还没读到 / 没读权限）时，预览必须说"取不到"，
        // 而不是"没有可用出口"；动作块保留（读取失败不代表绑定动作无效）。
        bindingsUnavailable={bindingsUnavailable || !referenceLoaded || !canReadNodes}
        workspaceId={currentId}
        canManageNodes={canManageNodes}
        bindingBusy={bindingBusy}
        busy={busy}
        locale={locale}
        t={t}
        text={L}
        onOpenChange={setCreateOpen}
        onDraftChange={setCreateDraft}
        onBindEgress={() => void bindSelectedEgress()}
        onCreate={() => void createForward()}
      />

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

