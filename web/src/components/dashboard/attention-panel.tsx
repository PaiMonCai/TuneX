"use client";

/**
 * V4-WP8 §13.7 Wave 4 —— Dashboard「需要处理」面板（客户端组件，带轮询）。
 *
 * ── 为什么是客户端组件 ──
 * 它必须**轮询**：节点上线、转发收敛都会在没有用户操作的情况下改变待办
 * 清单，而 Dashboard 常常被一直开着当作「今天有没有事」的看板。轮询常量复用
 * WP7 的 `INSTALL_POLL_INTERVAL_MS`（10s）与 `INSTALL_POLL_MAX_MS`（30min），
 * 不新造第二套节奏 —— 两套节奏意味着两处都要调，迟早不一致。
 *
 * ── 三重状态，缺一不可 ──
 *   · **有内容**    → 分组列出节点/转发，每条给「下一步」与跳转/重试；
 *   · **空且正常**  → 一句「没有需要处理的」；
 *   · **取不到**（`degraded` 或请求失败）→ 明说「暂时取不到，这不代表没问题」。
 * 第三态是最容易被漏掉的：把空数组当「一切正常」，于是一次 DB 抖动会被用户
 * 读成「我的节点都健康」。
 *
 * ── 判定一律来自后端 ──
 * 本组件不判在线、不算 revision、不判准入：`severity` / `reason_code` /
 * `retryable` 全部由 `GET /api/dashboard/attention` 给出，前端只做归类、取词
 * 与跳转（`lib/attention.ts`）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import {
  attentionAction,
  attentionHref,
  attentionRetryable,
  groupAttention,
  normalizeAttentionPayload,
} from "@/lib/attention";
import { forwardErrorActions, forwardErrorInfo } from "@/lib/forward-status";
import {
  attentionGroupLabel,
  attentionSeverityLabel,
  attentionSeverityVariant,
  attentionText,
} from "@/lib/attention-i18n";
import { INSTALL_POLL_INTERVAL_MS, INSTALL_POLL_MAX_MS } from "@/components/admin/node-install-waiting";
import type { AttentionItem, AttentionPayload } from "@/lib/types";

/**
 * 加载状态机。
 *
 * `degraded` 与 `empty` 必须分开：前者是「取不到」，后者是「确实没有」。
 * 合并成一个布尔就会把查询失败显示成一切正常（本 WP 明令禁止的谎）。
 */
type AttentionState =
  | { kind: "loading" }
  | { kind: "ready"; payload: AttentionPayload; fetching: boolean }
  | { kind: "degraded" };

export function AttentionPanel() {
  const { t, locale } = useI18n();
  const txt = attentionText(locale);
  const [state, setState] = useState<AttentionState>({ kind: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const startedAt = useRef(Date.now());

  const load = useCallback(async () => {
    try {
      const payload = normalizeAttentionPayload(await api.dashboard.attention());
      if (!payload) {
        setState({ kind: "degraded" });
        return;
      }
      setState({ kind: "ready", payload, fetching: false });
    } catch {
      // 请求失败与后端 degraded 等价：都表示「取不到」，不是「没有问题」。
      setState((prev) => (prev.kind === "ready" ? { ...prev, fetching: false } : { kind: "degraded" }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 轮询：到期（30min）自动停，避免用户把标签页挂一天后还在打接口。
  useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() - startedAt.current > INSTALL_POLL_MAX_MS) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load();
    }, INSTALL_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  /** 快捷操作：只做「重试」——那是唯一一个不需要先改配置的动作。 */
  async function retry(item: AttentionItem) {
    const key = `${item.kind}:${item.id}`;
    setBusyId(key);
    try {
      await api.forwards.action(item.id, "retry");
      toast.success(t("forward.retry"));
      await load();
    } catch (error) {
      // V4-WP8 §13.5：重试**本身**也可能失败（例如入口节点此刻正在维护 →
      // 409 且 `data.condition` 有码）。只回显原文会退化成「重试失败」，
      // 所以这里同样按码给下一步。
      const info = forwardErrorInfo(error);
      const actions = forwardErrorActions(locale, info);
      toast.error([...actions, info.message || t("forward.loadFailed")].filter(Boolean).join(" "));
      await load();
    } finally {
      setBusyId(null);
    }
  }

  if (state.kind === "loading") {
    return (
      <Card data-testid="attention-panel">
        <CardHeader>
          <CardTitle>{txt.title}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
          <Loader2 className="size-4 animate-spin" />
          {t("common.loading")}
        </CardContent>
      </Card>
    );
  }

  if (state.kind === "degraded") {
    return (
      <Card data-testid="attention-panel" data-attention-state="degraded">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-[var(--muted-foreground)]" />
            {txt.title}
          </CardTitle>
          <CardDescription>{txt.degraded}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw className="size-4" />
            {t("common.refresh")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { payload, fetching } = state;
  const groups = groupAttention(payload.items);

  if (groups.length === 0) {
    return (
      <Card data-testid="attention-panel" data-attention-state="clear">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-4 text-[var(--success)]" />
            {txt.title}
          </CardTitle>
          <CardDescription>{txt.allClear}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card data-testid="attention-panel" data-attention-state="items">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{txt.title}</CardTitle>
          <CardDescription>{txt.subtitle}</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{txt.totalItems.replace("{count}", String(payload.total))}</Badge>
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={fetching} aria-label={t("common.refresh")}>
            {fetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group.kind} className="flex flex-col gap-2">
            <div className="text-xs font-medium text-[var(--muted-foreground)]">
              {attentionGroupLabel(locale, group.kind)}
            </div>
            <ul className="flex flex-col divide-y divide-[var(--border)]">
              {group.items.map((item) => {
                const key = `${item.kind}:${item.id}`;
                // `retryable === null` = 后端没给结论 → 不显示按钮（不猜）。
                const canRetry = item.kind === "forward" && attentionRetryable(item) === true;
                const action = attentionAction(locale, item);
                return (
                  <li key={key} className="flex flex-wrap items-start justify-between gap-2 py-2" data-testid={`attention-item-${key}`}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={attentionSeverityVariant(item.severity)}>
                          {attentionSeverityLabel(locale, item.severity)}
                        </Badge>
                        <span className="truncate text-sm font-medium">{item.name}</span>
                      </div>
                      {action ? (
                        <p className="mt-1 text-xs text-[var(--muted-foreground)]" data-testid={`attention-action-${key}`}>
                          {action}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      {canRetry ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void retry(item)}
                          disabled={busyId === key}
                          data-testid={`attention-retry-${key}`}
                        >
                          {busyId === key ? <Loader2 className="size-4 animate-spin" /> : null}
                          {txt.retry}
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" asChild>
                        <Link href={attentionHref(item)}>
                          {item.kind === "node" ? txt.openNode : txt.openForward}
                        </Link>
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
