"use client";

/**
 * V4-WP7 §13.4.2/§13.4.3 —— 节点生命周期面板（**展示层**）。
 *
 * ── 这一层不做任何判定 ──
 * 可用按钮来自 `view.allowed_transitions`（服务端 `canTransition` 的输出），
 * 准入结论来自 `view.accepts_new_business` / `admission_rejection`，依赖统计
 * 来自 `/impact`。前端不比较阈值、不复刻迁移表、不推断「能不能删」——
 * §13.4.2 的唯一代码落点在服务端。`deletePreview()` 只用于**提前禁用按钮**，
 * 真正裁决永远看 DELETE 的响应（设计决策 D3）。
 *
 * ── 三层状态并列，不合并 ──
 * Connection / Lifecycle 在这里，Health 由 WP6 的健康卡单独呈现。刻意不合成
 * 一个「综合状态」：三层的下一步动作完全不同（去安装 / 去退出维护 / 去查日志）。
 */
import { AlertTriangle, Ban, Loader2, RefreshCw, ShieldCheck, Trash2, Wrench } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/form";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { API_MOCK } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { formatDateTime } from "@/lib/utils";
import {
  connectionBadgeVariant,
  lifecycleBadgeVariant,
} from "@/lib/node-health";
import {
  deletePreview,
  impactEntries,
  impactIsEmpty,
  isTerminalLifecycle,
  lifecycleActionTargets,
  type ImpactEntry,
} from "@/lib/node-lifecycle";
import {
  LIFECYCLE_NOTE_MAX,
  conditionAction,
  conditionTitle,
  impactLabel,
  nodeLifecycleText,
} from "@/lib/node-lifecycle-i18n";
import type { Locale } from "@/lib/i18n";
import type {
  ID,
  NodeImpact,
  NodeLifecycleConditionCode,
  NodeLifecycleValue,
  NodeLifecycleView,
  NodeRoleCheckResult,
} from "@/lib/types";

/** 生命周期 → 图标（active 正常、maintenance 扳手、disabled 禁止、retiring 垃圾桶）。 */
function LifecycleIcon({ lifecycle, className }: { lifecycle: NodeLifecycleValue; className?: string }) {
  if (lifecycle === "maintenance") return <Wrench className={className} />;
  if (lifecycle === "disabled") return <Ban className={className} />;
  if (lifecycle === "retiring") return <Trash2 className={className} />;
  return <ShieldCheck className={className} />;
}

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3"
      data-testid={testId}
    >
      <span className="text-xs font-medium">{title}</span>
      {children}
    </div>
  );
}

/** 一条依赖计数：名称 + 数值（0 也显示，条目不隐藏——用户要看全五类）。 */
function ImpactRow({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-[var(--muted-foreground)]">{label}</span>
      <span
        className={`font-mono text-xs ${count > 0 ? "text-[var(--foreground)]" : "text-[var(--muted-foreground)]"}`}
        data-testid="node-impact-count"
      >
        {count}
      </span>
    </div>
  );
}

/** 拒绝原因一条：原因码标题 + 后端原句 + 下一步动作（§13.5 可区分错误码）。 */
export function LifecycleConditionNotice({
  condition,
  message,
  locale,
  testId = "node-lifecycle-condition",
}: {
  condition: NodeLifecycleConditionCode | null;
  message: string;
  locale: Locale;
  testId?: string;
}) {
  const txt = nodeLifecycleText(locale);
  const action = conditionAction(locale, condition);
  return (
    <div
      className="flex flex-col gap-1 rounded-[var(--radius)] border border-[var(--destructive)] p-2.5"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="size-3.5 text-[var(--destructive)]" />
        <span className="text-xs font-medium">{conditionTitle(locale, condition, txt.lifecycleChangeFailed)}</span>
        {condition && (
          <code className="font-mono text-[10px] text-[var(--muted-foreground)]" data-testid="node-lifecycle-condition-code">
            {condition}
          </code>
        )}
      </div>
      {message && <p className="text-xs text-[var(--muted-foreground)]">{message}</p>}
      {action && (
        <p className="text-xs" data-testid="node-lifecycle-condition-action">
          <span className="text-[var(--muted-foreground)]">{txt.conditionAction}：</span>
          {action}
        </p>
      )}
    </div>
  );
}

export interface NodeLifecyclePanelProps {
  view: NodeLifecycleView | null;
  loading: boolean;
  /** 视图取数失败（保留上一份视图时也显示）。 */
  error: string | null;
  /** 最近一次写操作的拒绝信息（null = 无）。 */
  refusal: { condition: NodeLifecycleConditionCode | null; message: string } | null;
  /** 依赖影响统计；null = 尚未加载（不渲染 0，避免把「未知」说成「空」）。 */
  impact: NodeImpact | null;
  impactError: string | null;
  /** 角色/端口区间检查结果（null = 未做检查）。 */
  roleCheck: NodeRoleCheckResult | null;
  roleCheckPending: boolean;
  /** 当前输入是否与节点已保存值不同（不同才做检查）。 */
  note: string;
  /** 节点行上已保存的备注（`lifecycle_note`）——视图不带这个字段。 */
  currentNote?: string | null;
  onNoteChange: (v: string) => void;
  onApply: (lifecycle: NodeLifecycleValue, note: string | null) => void;
  onDelete: () => void;
  onRefresh: () => void;
  applying: NodeLifecycleValue | null;
  deleting: boolean;
  confirmOpen: boolean;
  onConfirmOpenChange: (open: boolean) => void;
  nodeId: ID;
  children?: React.ReactNode;
}

export function NodeLifecyclePanel({
  view,
  loading,
  error,
  refusal,
  impact,
  impactError,
  roleCheck,
  roleCheckPending,
  note,
  currentNote = null,
  onNoteChange,
  onApply,
  onDelete,
  onRefresh,
  applying,
  deleting,
  confirmOpen,
  onConfirmOpenChange,
  nodeId,
  children,
}: NodeLifecyclePanelProps) {
  const { locale } = useI18n();
  const txt = nodeLifecycleText(locale);

  const lifecycle = view?.lifecycle ?? null;
  const targets = lifecycleActionTargets(view);
  const entries = impact ? impactEntries(impact) : [];
  const empty = impact ? impactIsEmpty(impact) : false;
  const gate = view ? deletePreview(view.lifecycle, impact) : null;
  const deleteReady = Boolean(gate && gate.ok);

  return (
    <Card data-testid="node-lifecycle">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {lifecycle && <LifecycleIcon lifecycle={lifecycle} className="size-4" />}
          {txt.title}
          {view && (
            <>
              <Badge variant={lifecycleBadgeVariant(view.lifecycle)} data-testid="node-lifecycle-badge">
                {txt.lifecycle[view.lifecycle]}
              </Badge>
              <Badge variant={connectionBadgeVariant(view.connection)} data-testid="node-lifecycle-connection">
                {txt.connection[view.connection]}
              </Badge>
              {/* 准入是**状态**而不是错误：用中性徽章表达，不进红色告警 */}
              <Badge
                variant={view.accepts_new_business ? "success" : "outline"}
                data-testid="node-lifecycle-accepts"
              >
                {view.accepts_new_business ? txt.acceptsNewBusiness : txt.rejectsNewBusiness}
              </Badge>
            </>
          )}
          {API_MOCK && (
            <Badge variant="outline" title={txt.mockHint} data-testid="node-lifecycle-mock-badge">
              {txt.mockBadge}
            </Badge>
          )}
          <span className="ml-auto">
            <Button size="sm" variant="ghost" onClick={onRefresh} disabled={loading} data-testid="node-lifecycle-refresh">
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {txt.refresh}
            </Button>
          </span>
        </CardTitle>
        <CardDescription>{lifecycle ? txt.lifecycleHint[lifecycle] : txt.subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!view ? (
          <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]" data-testid="node-lifecycle-pending">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <AlertTriangle className="size-4" />}
            <span>{error ?? (loading ? txt.loading : txt.loadFailed)}</span>
          </div>
        ) : (
          <>
            {/* 写操作被拒：按 condition 给「原因 + 下一步」，不合并成一句「操作失败」 */}
            {refusal && (
              <LifecycleConditionNotice
                condition={refusal.condition}
                message={refusal.message}
                locale={locale}
              />
            )}
            {error && (
              <p className="text-xs text-[var(--muted-foreground)]" data-testid="node-lifecycle-stale">
                {error}
              </p>
            )}

            {/* 迁移按钮：唯一来源是 allowed_transitions */}
            <Section title={txt.transitionsTitle} testId="node-lifecycle-transitions">
              {targets.length === 0 ? (
                <p className="text-xs text-[var(--muted-foreground)]" data-testid="node-lifecycle-no-transitions">
                  {txt.noTransitions}
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {targets.map((target) => (
                    <Button
                      key={target}
                      size="sm"
                      variant={target === "retiring" ? "outline" : "default"}
                      disabled={applying !== null}
                      onClick={() => onApply(target, note.trim() === "" ? null : note.trim())}
                      data-testid={`node-lifecycle-set-${target}`}
                    >
                      {applying === target ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <LifecycleIcon lifecycle={target} className="size-4" />
                      )}
                      {txt.lifecycle[target]}
                    </Button>
                  ))}
                </div>
              )}
              {isTerminalLifecycle(lifecycle) && (
                <p className="text-xs text-[var(--muted-foreground)]" data-testid="node-lifecycle-one-way">
                  {txt.irreversibleHint}
                </p>
              )}
              {/* 已保存的备注在**节点行**上（lifecycle_note），视图不带它。
                  与下方输入框区分展示：上面是「当前生效的原因」，下面是「这次要改成什么」。 */}
              <p className="text-xs" data-testid="node-lifecycle-current-note">
                <span className="text-[var(--muted-foreground)]">{txt.noteCurrent}：</span>
                {currentNote ? (
                  <span>{currentNote}</span>
                ) : (
                  <span className="text-[var(--muted-foreground)]">{txt.noteNone}</span>
                )}
              </p>
              <Field label={txt.noteLabel} hint={txt.noteHint}>
                <Input
                  value={note}
                  maxLength={LIFECYCLE_NOTE_MAX}
                  onChange={(e) => onNoteChange(e.target.value)}
                  placeholder={txt.notePlaceholder}
                  data-testid="node-lifecycle-note"
                />
              </Field>
              <p className="text-xs text-[var(--muted-foreground)]">{txt.noteClearHint}</p>
            </Section>

            {/* 依赖预览：五类计数 + 阻塞原因 */}
            <Section title={txt.sectionImpact} testId="node-lifecycle-impact">
              {impactError && (
                <p className="text-xs text-[var(--destructive)]" data-testid="node-impact-error">
                  {impactError}
                </p>
              )}
              {!impact ? (
                <p className="text-xs text-[var(--muted-foreground)]" data-testid="node-impact-pending">
                  {impactError ? "-" : loading ? txt.loading : txt.impactLoadFailed}
                </p>
              ) : (
                <div className="flex flex-col gap-1" data-testid="node-impact-entries">
                  {empty ? (
                    <p className="text-xs text-[var(--muted-foreground)]" data-testid="node-impact-empty">
                      {txt.impactEmpty}
                    </p>
                  ) : (
                    entries.map((e: ImpactEntry) => (
                      <ImpactRow key={e.key} label={impactLabel(locale, e.key)} count={e.count} />
                    ))
                  )}
                  {impact.blockers.length > 0 && (
                    <div className="pt-1" data-testid="node-impact-blockers">
                      <span className="text-xs text-[var(--muted-foreground)]">{txt.impactBlockers}</span>
                      <ul className="list-inside list-disc">
                        {impact.blockers.map((b) => (
                          <li key={b} className="text-xs">
                            {b}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
              {/* 角色/端口区间收缩检查（后端 checkRoleChange 的结论，前端不重算） */}
              {roleCheckPending ? (
                <p className="text-xs text-[var(--muted-foreground)]" data-testid="node-role-check-pending">
                  {txt.roleCheckPending}
                </p>
              ) : roleCheck && !roleCheck.ok ? (
                <LifecycleConditionNotice
                  condition={roleCheck.condition}
                  message={roleCheck.message}
                  locale={locale}
                  testId="node-role-check"
                />
              ) : roleCheck?.ok ? (
                <p className="text-xs text-[var(--muted-foreground)]" data-testid="node-role-check-ok">
                  {txt.roleCheckOk}
                </p>
              ) : null}
            </Section>

            {/* 删除：预览闸门只用于禁用按钮，最终以服务端响应为准 */}
            <Section title={txt.sectionDelete} testId="node-lifecycle-delete">
              <p className="text-xs text-[var(--muted-foreground)]">{txt.deleteHint}</p>
              <p
                className={`text-xs ${deleteReady ? "text-[var(--muted-foreground)]" : "text-[var(--destructive)]"}`}
                data-testid="node-delete-gate"
              >
                {gate && !gate.ok && gate.condition === "node_not_retiring"
                  ? txt.lifecycle.retiring + " · " + conditionTitle(locale, gate.condition, txt.deleteBlocked)
                  : deleteReady
                    ? txt.deleteAllowed
                    : txt.deleteBlocked}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="text-[var(--destructive)]"
                  disabled={deleting || applying !== null}
                  onClick={() => onConfirmOpenChange(true)}
                  data-testid="node-delete-open"
                >
                  {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  {txt.sectionDelete}
                </Button>
              </div>
            </Section>

            {/* 安装等待闭环（由父组件传入，避免本组件自己再拉一次 enrollment） */}
            {children}
          </>
        )}
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={onConfirmOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{txt.deleteConfirmTitle}</DialogTitle>
            <DialogDescription>
              {txt.deleteConfirmBody} <span className="font-mono">#{nodeId}</span>
            </DialogDescription>
          </DialogHeader>
          {impact && !deleteReady && (
            <LifecycleConditionNotice
              condition={gate && !gate.ok ? gate.condition : "dependency_blocked"}
              message=""
              locale={locale}
              testId="node-delete-confirm-warning"
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => onConfirmOpenChange(false)} disabled={deleting}>
              {txt.installClose}
            </Button>
            <Button
              variant="outline"
              className="text-[var(--destructive)]"
              onClick={onDelete}
              disabled={deleting}
              data-testid="node-delete-confirm"
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {deleting ? txt.deletePending : txt.sectionDelete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
