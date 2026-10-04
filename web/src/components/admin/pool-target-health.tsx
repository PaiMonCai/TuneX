"use client";

/**
 * V5.2 §7（WP5/WP6）—— 出口池的**目标健康**面板：`期望目标 × 观测结论`。
 *
 * ── 为什么是单独一块，而不是塞进上面那张编辑表 ──
 * 后端刻意把两者分成两个端点（`.../targets` = 期望，`.../health` = 观测 + 合成），
 * 理由写在 `routes/node-admin.ts`：混在一个响应里，下次改动就说不清哪个字段属于哪类
 * 事实。界面沿用同一条边界：上表是「你要什么」（可编辑），这里是「我们看到了什么」
 * （只读）。因此这一块**没有任何写入口** —— 观测没有删除权，界面上就不该出现
 * 走观测数据的删除按钮。
 *
 * ── 三条契约要求在渲染上的落点 ──
 *   1. 每个目标的徽标由 `TargetHealthBadge` 渲染（五态穷尽、`unknown` = 没有证据）；
 *   2. 多观测者**逐条摊开**：两个节点结论不同时，两条都显示，并且明说「已取最坏、
 *      未做平均」（取最坏的判断是后端做的，这里只如实呈现）；
 *   3. 行集来自**期望清单**（按期望顺序），所以 `unhealthy` 的目标不会消失，也不会
 *      被画成「已移除/已停用」——它的期望状态列仍然是它自己的状态，和观测无关。
 *
 * ── age 在客户端现算 ──
 * 视图里的 `facts.age_ms` 是后端在 `observed_at` 那一刻算出来的。页面挂久了之后，
 * 证据其实已经过期，而那个数字不会自己变。所以每次渲染都用
 * `evidenceAgeMs()` 以 `observed_at` 为锚、本地时钟为参照把年龄推到此刻，并在
 * 越过 stale 线时显式标注（§7 结论 7/8：age 不落库，过期等同于没有证据）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, Users } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { TargetHealthBadge } from "@/components/admin/target-health-badge";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  buildTargetHealthRows,
  evidenceAgeMs,
  formatObservationAge,
  hasObserverDisagreement,
  observerDisplayLabel,
  observerNodesText,
  shouldShowObserverBreakdown,
  targetHealthFreshness,
  targetHealthReasonText,
  targetHealthStateHint,
  targetHealthStateLabel,
  TARGET_HEALTH_SEVERITY_ORDER,
  targetHealthVerdict,
  type TargetHealthReason,
  type TargetHealthState,
  type TargetHealthTargetView,
  type TargetPoolHealth,
  type TargetHealthRow,
} from "@/lib/target-health";
import { formatDateTime } from "@/lib/utils";
import type { EgressPool, ID } from "@/lib/types";

/**
 * age 重算的渲染节拍（毫秒）。
 *
 * 15s 是**展示节奏**：它不参与任何判定（stale 线在后端 `target-health-thresholds.ts`），
 * 只决定「页面上的年龄多久刷新一次」。选择它是因为最坏情况下（stale=90s）也能在
 * 一秒级精度上把「刚刚过期」呈现出来，而重绘成本对这个尺寸的表格可以忽略。
 */
const TARGET_HEALTH_AGE_TICK_MS = 15_000;

/** 取数状态：显式三态，避免「空数组」同时表示「没有目标」和「还没取到」。 */
export type PoolTargetHealthStatus = "loading" | "ready" | "error";

export interface PoolTargetHealthViewProps {
  pool: Pick<EgressPool, "id" | "name" | "targets">;
  health: TargetPoolHealth | null;
  status: PoolTargetHealthStatus;
  error?: string | null;
  onRefresh?: () => void;
  /** 注入「此刻」（毫秒）：age 的换算锚点。缺省用本地时钟，测试可固定。 */
  now?: number;
}

/** 结论计数（按目标计，不按观测者计）：无证据单独一档，绝不与「健康」合并。 */
export function healthStateCounts(
  rows: readonly TargetHealthRow<{ host: string; port: number }>[],
): Record<TargetHealthState, number> {
  const counts: Record<TargetHealthState, number> = {
    unknown: 0,
    healthy: 0,
    degraded: 0,
    unhealthy: 0,
    recovering: 0,
  };
  for (const row of rows) {
    const state = row.kind === "reported" ? row.view.state : "unknown";
    counts[state] += 1;
  }
  return counts;
}

/** 可达性 → 人话（`null` = 没有这个事实，不是「不可达」）。 */
function reachableText(
  reachable: boolean | null,
  t: (key: string) => string,
): string {
  if (reachable === null) return t("admin.targetHealth.reachableUnknown");
  return reachable ? t("admin.targetHealth.reachable") : t("admin.targetHealth.unreachable");
}

/** 一个观测者的明细行（节点标识 + 它自己的结论 + 它自己的事实）。 */
function ObserverLine({
  observer,
  now,
}: {
  observer: TargetHealthTargetView["observers"][number];
  now: number;
}) {
  const { t, locale } = useI18n();
  const age = evidenceAgeMs(observer.age_ms, observer.last_observed_at, now);
  const freshness = targetHealthFreshness(age);
  const facts: string[] = [
    reachableText(observer.reachable, t),
    `${t("admin.targetHealth.consecutiveFailure")} ${observer.consecutive_failure ?? "—"}`,
    `${t("admin.targetHealth.successRate")} ${
      observer.success_rate === null ? "—" : `${Math.round(observer.success_rate * 100)}%`
    }`,
    `${t("admin.targetHealth.latency")} ${
      observer.latency_ms === null ? "—" : `${Math.round(observer.latency_ms)}ms`
    }`,
    formatObservationAge(age, locale),
  ];
  return (
    <li
      className="flex flex-wrap items-center gap-2 py-0.5"
      data-testid={`target-health-observer-${observerDisplayLabel(observer)}`}
    >
      <span className="font-mono text-[11px]">{observerDisplayLabel(observer)}</span>
      <TargetHealthBadge state={observer.state} />
      <span className="text-[11px] text-[var(--muted-foreground)]">{facts.join(" · ")}</span>
      {observer.stale ? (
        <span className="text-[11px] text-[var(--muted-foreground)]" data-testid="observer-stale">
          {t("admin.targetHealth.stale")}
        </span>
      ) : null}
      {observer.usable ? null : (
        <span className="text-[11px] text-[var(--muted-foreground)]">
          {t("admin.targetHealth.ageUnknown")}
        </span>
      )}
      {/*
        观测者自己的理由：这一行存在的意义就是「让两条不同的看法都能被读到」，
        所以不折叠、不 summary 化。
      */}
      {observer.reasons.length > 0 ? (
        <span className="text-[11px] text-[var(--muted-foreground)]">
          {observer.reasons.map((reason) => targetHealthReasonText(reason, locale)).join("；")}
        </span>
      ) : null}
    </li>
  );
}

/** 一个目标行的观测单元（徽标 + 年龄 + 计数 + 观测者明细 + 理由）。 */
function TargetHealthCell({
  view,
  now,
}: {
  view: TargetHealthTargetView;
  now: number;
}) {
  const { t, locale } = useI18n();
  const age = evidenceAgeMs(view.facts.age_ms, view.facts.last_observed_at, now);
  const freshness = targetHealthFreshness(age);
  const verdict = targetHealthVerdict(view.state);
  const disagreement = hasObserverDisagreement(view);
  const showObservers = shouldShowObserverBreakdown(view);
  const reasons = view.reasons.map((reason: TargetHealthReason) =>
    targetHealthReasonText(reason, locale),
  );
  return (
    <div className="flex flex-col gap-1" data-testid={`target-health-${view.target}`}>
      <div className="flex flex-wrap items-center gap-2">
        <TargetHealthBadge state={view.state} />
        <span className="text-xs text-[var(--muted-foreground)]">
          {t("admin.targetHealth.age")}: {formatObservationAge(age, locale)}
        </span>
        {/*
          过期标注：这是**客户端现算**的结论（后端在 observed_at 那一刻说「新鲜」，
          页面挂到 90 秒之后就未必）。契约里 stale 等同于没有证据，所以这里必须
          说出来，而不是继续把那一行当「有证据」渲染。
        */}
        {freshness === "stale" ? (
          <span
            className="text-xs text-[var(--warning,var(--muted-foreground))]"
            data-testid="target-health-stale"
          >
            {t("admin.targetHealth.stale")}
          </span>
        ) : freshness === "fresh" ? (
          <span className="text-xs text-[var(--muted-foreground)]">
            {t("admin.targetHealth.fresh")}
          </span>
        ) : (
          <span className="text-xs text-[var(--muted-foreground)]">
            {t("admin.targetHealth.ageUnknown")}
          </span>
        )}
        {view.flapping ? (
          <Badge variant="outline" data-testid="target-health-flapping">
            {t("admin.targetHealth.flapping")}
          </Badge>
        ) : null}
      </div>

      {/*
        「没有事实」与「事实是 0」必须分得开（§7：缺字段不得被当成健康）。所以
        无证据的目标**不渲染**一串 `—`，而是明说没有可用事实。
      */}
      {view.facts.evidence ? (
      <div className="flex flex-wrap gap-x-3 text-xs text-[var(--muted-foreground)]">
        {/* 结论所依据的那个观测者的事实（后端只给 facts，不跨观测者拼凑） */}
        <span>{reachableText(view.facts.reachable, t)}</span>
        <span>
          {t("admin.targetHealth.consecutiveFailure")}: {view.facts.consecutive_failure ?? "—"}
        </span>
        <span>
          {t("admin.targetHealth.consecutiveSuccess")}: {view.facts.consecutive_success ?? "—"}
        </span>
        <span>
          {t("admin.targetHealth.successRate")}:{" "}
          {view.facts.success_rate === null
            ? "—"
            : `${Math.round(view.facts.success_rate * 100)}%`}
        </span>
        <span>
          {t("admin.targetHealth.latency")}:{" "}
          {view.facts.latency_ms === null ? "—" : `${Math.round(view.facts.latency_ms)}ms`}
        </span>
        {/*
          绝对时间与「多久之前」一起给：相对年龄会随页面挂机增长，绝对时刻不会。
          两列并排时，运维能直接看出「这份证据是什么时候到的」，也就能识别时钟异常。
        */}
        {view.facts.last_observed_at ? (
          <span data-testid="target-health-last-observed">
            {t("admin.targetHealth.lastObserved")}:{" "}
            <span className="font-mono">{formatDateTime(view.facts.last_observed_at)}</span>
          </span>
        ) : null}
      </div>
      ) : (
        <span className="text-xs text-[var(--muted-foreground)]" data-testid="target-health-no-facts">
          {t("admin.targetHealth.noFacts")}
        </span>
      )}

      {showObservers ? (
        <div className="flex flex-col gap-0.5" data-testid="target-health-observers">
          <span className="flex items-center gap-1 text-xs font-medium">
            <Users className="size-3" />
            {t("admin.targetHealth.observers")}（{view.observers.length}）
          </span>
          <ul className="flex flex-col">
            {view.observers.map((observer, index) => (
              <ObserverLine
                key={`${observerDisplayLabel(observer)}-${index}`}
                observer={observer}
                now={now}
              />
            ))}
          </ul>
        </div>
      ) : view.observers.length === 0 ? (
        <span className="text-xs text-[var(--muted-foreground)]">
          {t("admin.targetHealth.observersNone")}
        </span>
      ) : null}

      {disagreement ? (
        <span
          className="flex items-start gap-1 text-xs text-[var(--warning,var(--muted-foreground))]"
          data-testid="target-health-disagreement"
        >
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          {t("admin.targetHealth.disagreement")}
        </span>
      ) : null}

      {reasons.length > 0 ? (
        <span className="text-xs text-[var(--muted-foreground)]" data-testid="target-health-reasons">
          {t("admin.targetHealth.reasons")}: {reasons.join("；")}
        </span>
      ) : null}

      {verdict === "no-evidence" ? (
        // unknown 的补充说明：把契约定义原样摆出来（「既不是健康，也不是故障」）——
        // 这是 §7 里最容易被误读的一格，不能只留一个灰色徽标。
        <span className="text-xs text-[var(--muted-foreground)]" data-testid="target-health-no-evidence">
          {targetHealthStateHint("unknown", locale)}
        </span>
      ) : null}
    </div>
  );
}

export function PoolTargetHealthView({
  pool,
  health,
  status,
  error,
  onRefresh,
  now = Date.now(),
}: PoolTargetHealthViewProps) {
  const { t, locale } = useI18n();
  const rows = useMemo(
    () => buildTargetHealthRows(pool.targets ?? [], health),
    [pool.targets, health],
  );
  const counts = useMemo(() => healthStateCounts(rows), [rows]);
  const observerText = observerNodesText(health?.observers ?? [], locale);
  const snapshotAge = health?.observed_at
    ? evidenceAgeMs(0, health.observed_at, now)
    : null;

  return (
    <Card data-testid="pool-target-health">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            {t("admin.targetHealth.title")}
            <span className="text-xs font-normal text-[var(--muted-foreground)]">{pool.name}</span>
            {/*
              汇总只按**目标**计数，且「无证据」单独一档：不与健康合并、不取平均。
              顺序用契约全序**从最坏到最好**（`TARGET_HEALTH_SEVERITY_ORDER` 反向），
              坏消息先出现 —— 这个顺序不是界面自创的，就是 §7 冻结块里那条全序。
            */}
            {[...TARGET_HEALTH_SEVERITY_ORDER].reverse().map((state) =>
              counts[state] > 0 ? (
                <span
                  key={state}
                  className="flex items-center gap-1 text-xs font-normal"
                  data-testid={`target-health-count-${state}`}
                >
                  <TargetHealthBadge state={state} />
                  {counts[state]}
                </span>
              ) : null,
            )}
          </CardTitle>
          <CardDescription>{t("admin.targetHealth.hint")}</CardDescription>
        </div>
        {onRefresh ? (
          <Button size="sm" variant="outline" onClick={onRefresh} data-testid="target-health-refresh">
            <RefreshCw className="size-3.5" />
            {t("admin.targetHealth.refresh")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {status === "loading" ? (
          <p className="text-sm text-[var(--muted-foreground)]" data-testid="target-health-loading">
            {t("admin.targetHealth.loading")}
          </p>
        ) : null}
        {status === "error" ? (
          <p className="text-sm text-[var(--destructive)]" role="alert" data-testid="target-health-error">
            {t("admin.targetHealth.failed")}
            {error ? `：${error}` : ""}
          </p>
        ) : null}

        {health ? (
          <p className="text-xs text-[var(--muted-foreground)]">
            {t("admin.targetHealth.snapshotAt")}:{" "}
            <span className="font-mono">{health.observed_at}</span>{" "}
            {snapshotAge !== null
              ? `（${t("admin.targetHealth.snapshotAge", {
                  age: formatObservationAge(snapshotAge, locale),
                })}）`
              : ""}
            {observerText ? ` · ${observerText}` : ` · ${t("admin.targetHealth.noObservingNodes")}`}
          </p>
        ) : null}

        {rows.length === 0 ? (
          <p className="text-sm text-[var(--muted-foreground)]">{t("admin.targetHealth.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("admin.targetHost")}</TableHead>
                  <TableHead>{t("common.remark")}</TableHead>
                  <TableHead>{t("admin.targetWeight")}</TableHead>
                  {/* 期望状态单列，且与「健康状态」分开命名：两者是两类事实 */}
                  <TableHead>{t("admin.targetHealth.desiredStatus")}</TableHead>
                  <TableHead>{t("admin.targetHealth.stateLabel")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* 行集 = 期望清单（顺序也照期望）；unhealthy 不会被过滤掉。 */}
                {rows.map((row) => {
                  // 期望侧字段：missing 行仍然是期望目标（它的 weight/remark/期望状态
                  // 都读得到），unexpected 行没有期望侧。
                  const desired = row.kind === "unexpected" ? null : row.desired;
                  const label =
                    desired === null ? row.key : `${desired.host}:${desired.port}`;
                  return (
                  <TableRow
                    key={`${row.kind}-${row.key}`}
                    data-testid={`target-health-row-${row.kind}-${row.key}`}
                  >
                    <TableCell className="align-top font-mono text-xs">
                      {label}
                      {row.kind === "unexpected" ? (
                        <span className="mt-1 block text-[11px] text-[var(--muted-foreground)]">
                          {t("admin.targetHealth.unexpectedRow")}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top text-xs text-[var(--muted-foreground)]">
                      {desired ? (desired.remark ?? "-") : "-"}
                    </TableCell>
                    <TableCell className="align-top text-xs">
                      {desired ? desired.weight : "-"}
                    </TableCell>
                    <TableCell className="align-top">
                      {desired ? (
                        <Badge
                          variant={desired.status === "active" ? "success" : "muted"}
                          title={t("admin.targetHealth.desiredStatusTitle")}
                        >
                          {/*
                            期望状态（active/inactive）是用户配置的事实，与观测无关：
                            观测**不会**把它改成 inactive，界面也不许借观测状态暗示它被停用。
                          */}
                          {String(desired.status ?? "—")}
                        </Badge>
                      ) : (
                        <span className="text-xs text-[var(--muted-foreground)]">—</span>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      {row.kind === "reported" ? (
                        <TargetHealthCell view={row.view} now={now} />
                      ) : row.kind === "missing" ? (
                        // 期望里有、健康视图里没有：按「没有证据」处理并**留在表里**，
                        // 不隐藏、也不假定健康（§7：观测不能删除一个期望目标）。
                        <div className="flex flex-col gap-1" data-testid="target-health-missing">
                          <TargetHealthBadge state="unknown" />
                          <span className="text-xs text-[var(--muted-foreground)]">
                            {t("admin.targetHealth.missingRow")}
                          </span>
                        </div>
                      ) : (
                        <TargetHealthCell view={row.view} now={now} />
                      )}
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 目标键签名：期望清单变化（增/删/改地址）时用于触发重新取观测。 */
function targetSignature(pool: Pick<EgressPool, "targets">): string {
  return (pool.targets ?? [])
    .map((target) => `${target.host}:${target.port}`)
    .join(",");
}

/**
 * 自取数的容器：一个池一块。
 *
 * 取数时机：挂载、期望清单变化（加/删目标之后旧观测已经对不上了）、手动刷新。
 * 失败**不清空**上一次的结果里已有的行集（行集来自期望清单，不依赖响应），只在
 * 状态区给出可重试的错误提示 —— 「读不到观测」与「没有目标」必须在界面上分开。
 */
export function PoolTargetHealth({ pool }: { pool: Pick<EgressPool, "id" | "name" | "targets"> }) {
  const { t } = useI18n();
  const [health, setHealth] = useState<TargetPoolHealth | null>(null);
  const [status, setStatus] = useState<PoolTargetHealthStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const seq = useRef(0);
  const signature = targetSignature(pool);

  /**
   * 让「此刻」自己走：age 是客户端现算的，`now` 不前进的话，一份证据永远显示成
   * 加载那一刻的年龄，「超过 stale 线」这件事就永远不会出现 —— 而那正是 §7 要求
   * 可见的事实。节奏是**渲染节拍**，不是任何健康阈值（阈值只有后端那一处）。
   */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TARGET_HEALTH_AGE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    const current = ++seq.current;
    setStatus("loading");
    setError(null);
    try {
      const data = await api.admin.poolTargetHealth(pool.id as ID);
      if (current !== seq.current) return;
      setHealth(data);
      setNow(Date.now());
      setStatus("ready");
    } catch (err) {
      if (current !== seq.current) return;
      setStatus("error");
      setError(err instanceof Error ? err.message : null);
      toast.error(t("admin.targetHealth.failed"));
    }
  }, [pool.id, t]);

  useEffect(() => {
    void load();
    // `signature` 刻意放进依赖：期望清单变了（加/删/改目标）就必须重新取观测 ——
    // 旧观测已经对不上新的期望清单，继续显示它会得到「缺行/多行」这种噪声。
  }, [load, signature]);

  return (
    <PoolTargetHealthView
      pool={pool}
      health={health}
      status={status}
      error={error}
      now={now}
      onRefresh={() => void load()}
    />
  );
}
