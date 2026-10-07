"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, GitBranch, Info, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  addTransit,
  applyOutcomeText,
  EMPTY_TEMPLATE,
  hopChain,
  hopsLabel,
  impactChangeText,
  MAX_TRANSIT,
  moveTransit,
  normalizeCapabilities,
  normalizeConstraints,
  normalizeNumberList,
  removeTransit,
  routeProfileErrorInfo,
  type RouteProfileErrorInfo,
  selectorLabel,
  templateContentChanged,
  templateSummary,
  visibilityText,
} from "@/components/admin/route-profiles/route-profile-status";
import {
  ReadOnlyNotice,
  RouteProfileErrorNotice,
  RouteProfileTable,
  StatTile,
  TransitChain,
  VersionBadge,
  VisibilityPill,
  type Locale,
} from "@/components/admin/route-profiles/route-profile-ui";
import type {
  RouteProfileApplyResult,
  RouteProfileImpact,
  RouteProfileTemplate,
  RouteProfileView,
  RouteSelector,
} from "@/lib/types";
import { getDictionary } from "@/lib/i18n";

const t = (locale: Locale, zh: string, en: string) => (locale === "en" ? en : zh);

/**
 * 图标按钮 / 结构化输入的可访问名称。
 *
 * 它们以前是写死的英文字面量（"move up" / "node_id" / "strategy" …）：图标按钮没有
 * 可见文字，这个 `aria-label` 就是它的全部语义，写死等于语言切换后读错。
 * 这里改走词典（本组件已显式接收 `locale`，故按该语言取词，不依赖 Provider，
 * 静态渲染也不会抛错）；偏技术标识的字段（节点 ID / 策略）保留语义但给人话。
 */
const a11y = (locale: Locale) => getDictionary(locale).admin.routeProfiles;

type Action = { pending: string | null; error: RouteProfileErrorInfo | null; notice: string | null };

/** 写操作的统一交互：就地、单飞、失败把后端 code/层/next_action 原样上屏。 */
function useProfileAction() {
  const [state, setState] = useState<Action>({ pending: null, error: null, notice: null });
  const clear = useCallback(() => setState({ pending: null, error: null, notice: null }), []);
  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>, describe?: (result: never) => string): Promise<boolean> => {
      setState({ pending: label, error: null, notice: null });
      try {
        const result = (await fn()) as never;
        setState({ pending: null, error: null, notice: describe ? describe(result) : null });
        return true;
      } catch (e) {
        setState({ pending: null, error: routeProfileErrorInfo(e), notice: null });
        return false;
      }
    },
    [],
  );
  return { ...state, run, clear };
}

/* ================================================================== */
/* 模板编辑器（有序 transit 是重点）                                    */
/* ================================================================== */

function SelectorEditor({
  label,
  value,
  onChange,
  allowNull,
  locale,
  testId,
}: {
  label: string;
  value: RouteSelector | null;
  onChange: (next: RouteSelector | null) => void;
  allowNull?: boolean;
  locale: Locale;
  testId: string;
}) {
  const kind = value?.kind ?? "null";
  const labels = a11y(locale);
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <Label>{label}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          data-testid={`${testId}-kind`}
          className="h-9 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-sm"
          value={kind}
          onChange={(e) => {
            const next = e.target.value;
            if (next === "null") return onChange(null);
            if (next === "fixed_node") return onChange({ kind: "fixed_node", node_id: value?.kind === "fixed_node" ? value.node_id : 1 });
            return onChange({
              kind: "node_group",
              node_group_id: value?.kind === "node_group" ? value.node_group_id : 1,
              strategy: value?.kind === "node_group" ? value.strategy : "failover",
            });
          }}
        >
          <option value="fixed_node">{t(locale, "固定节点", "fixed node")}</option>
          <option value="node_group">{t(locale, "节点组", "node group")}</option>
          {allowNull && <option value="null">{t(locale, "直连（同入口）", "direct (same as ingress)")}</option>}
        </select>
        {value?.kind === "fixed_node" && (
          <Input
            aria-label={labels.fixedNode}
            data-testid={`${testId}-node`}
            className="w-24"
            value={String(value.node_id)}
            onChange={(e) => onChange({ kind: "fixed_node", node_id: Number(e.target.value) || 0 })}
          />
        )}
        {value?.kind === "node_group" && (
          <>
            <Input
              aria-label={labels.nodeGroup}
              data-testid={`${testId}-group`}
              className="w-24"
              value={String(value.node_group_id)}
              onChange={(e) => onChange({ kind: "node_group", node_group_id: Number(e.target.value) || 0, strategy: value.strategy })}
            />
            <Input
              aria-label={labels.strategy}
              data-testid={`${testId}-strategy`}
              className="w-32"
              value={value.strategy}
              onChange={(e) => onChange({ kind: "node_group", node_group_id: value.node_group_id, strategy: e.target.value })}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 模板编辑器。
 *
 * **模板内容变更 = 发新版本**：本组件只负责产出 `template`，
 * 「PATCH metadata」与「发布新版本」由调用方按 `templateContentChanged()` 决定 ——
 * 界面上是两个不同的按钮，用户永远知道自己在做哪一件事。
 */
export function RouteProfileTemplateEditor({
  initial,
  onChange,
  locale,
  testId = "route-profile-editor",
}: {
  initial: RouteProfileTemplate;
  onChange: (template: RouteProfileTemplate, changed: boolean) => void;
  locale: Locale;
  testId?: string;
}) {
  const [template, setTemplate] = useState<RouteProfileTemplate>(initial);
  const [constraintsText, setConstraintsText] = useState({
    exclude_node_ids: (initial.constraints?.exclude_node_ids ?? []).join(", "),
    allowed_lifecycles: (initial.constraints?.allowed_lifecycles ?? []).join(", "),
    require_health: (initial.constraints?.require_health ?? []).join(", "),
    require_node_binding: initial.constraints?.require_node_binding !== false,
  });
  const [capabilitiesText, setCapabilitiesText] = useState((initial.required_capabilities ?? []).join(", "));
  const [policyText, setPolicyText] = useState({ ingress: "{}", egress: "{}" });
  const [policyError, setPolicyError] = useState<string | null>(null);
  const labels = a11y(locale);

  const emit = useCallback(
    (next: RouteProfileTemplate) => {
      setTemplate(next);
      onChange(next, templateContentChanged(initial, next));
    },
    [initial, onChange],
  );

  const applyPolicies = (next: RouteProfileTemplate, ingress: string, egress: string) => {
    try {
      const parsedIngress = ingress.trim() === "" ? null : (JSON.parse(ingress) as Record<string, unknown>);
      const parsedEgress = egress.trim() === "" ? null : (JSON.parse(egress) as Record<string, unknown>);
      if ((parsedIngress && typeof parsedIngress !== "object") || (parsedEgress && typeof parsedEgress !== "object")) {
        setPolicyError(t(locale, "策略必须是 JSON 对象", "policy must be a JSON object"));
        return;
      }
      setPolicyError(null);
      emit({ ...next, ingress_policy: parsedIngress, egress_policy: parsedEgress });
    } catch {
      setPolicyError(t(locale, "策略不是合法 JSON", "policy is not valid JSON"));
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      <SelectorEditor
        label={t(locale, "入口 selector", "ingress selector")}
        value={template.ingress}
        onChange={(next) => next && emit({ ...template, ingress: next })}
        locale={locale}
        testId={`${testId}-ingress`}
      />

      {/* 有序 transit：顺序就是执行顺序 */}
      <div className="flex flex-col gap-2" data-testid={`${testId}-transit`}>
        <div className="flex items-center justify-between">
          <Label>{t(locale, "中转（有序）", "transit (ordered)")}</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={`${testId}-transit-add`}
            disabled={template.transit.length >= MAX_TRANSIT}
            title={t(
              locale,
              `第一阶段最多 ${MAX_TRANSIT} 个中间跳（整条路由最多 3 跳）`,
              `Phase 1 allows at most ${MAX_TRANSIT} middle hop`,
            )}
            onClick={() => emit(addTransit(template, template.transit[0]?.node_id ?? 1))}
          >
            <Plus className="size-3.5" />
            {t(locale, "添加中转", "Add transit")}
          </Button>
        </div>
        {template.transit.length === 0 ? (
          <p className="text-xs text-[var(--muted-foreground)]" data-testid={`${testId}-transit-empty`}>
            {t(locale, "无中转（入口直连出口）", "No transit (ingress connects to egress)")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {template.transit.map((hop, index) => (
              <li
                key={`${hop.node_id}-${index}`}
                data-testid={`${testId}-transit-row`}
                data-order={index}
                className="flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--card)] p-2"
              >
                <Badge variant="outline" data-testid={`${testId}-transit-order`} data-order={index}>
                  {index + 1}
                </Badge>
                <Input
                  aria-label={labels.transitNode}
                  className="w-24"
                  value={String(hop.node_id)}
                  onChange={(e) => {
                    const next = [...template.transit];
                    next[index] = { kind: "fixed_node", node_id: Number(e.target.value) || 0 };
                    emit({ ...template, transit: next });
                  }}
                />
                <span className="font-mono text-xs text-[var(--muted-foreground)]">{selectorLabel(hop)}</span>
                <div className="ml-auto flex items-center gap-1">
                  <Button type="button" variant="ghost" size="icon" aria-label={labels.moveUp} disabled={index === 0} onClick={() => emit(moveTransit(template, index, -1))}>
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={labels.moveDown}
                    disabled={index === template.transit.length - 1}
                    onClick={() => emit(moveTransit(template, index, 1))}
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={labels.removeTransit} onClick={() => emit(removeTransit(template, index))}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <SelectorEditor
        label={t(locale, "出口 selector", "egress selector")}
        value={template.egress}
        onChange={(next) => emit({ ...template, egress: next })}
        allowNull
        locale={locale}
        testId={`${testId}-egress`}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>ingress_policy (JSON)</Label>
          <Input
            data-testid={`${testId}-ingress-policy`}
            value={policyText.ingress}
            onChange={(e) => {
              setPolicyText({ ...policyText, ingress: e.target.value });
              applyPolicies(template, e.target.value, policyText.egress);
            }}
          />
        </div>
        <div>
          <Label>egress_policy (JSON)</Label>
          <Input
            data-testid={`${testId}-egress-policy`}
            value={policyText.egress}
            onChange={(e) => {
              setPolicyText({ ...policyText, egress: e.target.value });
              applyPolicies(template, policyText.ingress, e.target.value);
            }}
          />
        </div>
      </div>
      {policyError && (
        <p className="text-xs text-[var(--destructive)]" data-testid={`${testId}-policy-error`}>
          {policyError}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{t(locale, "排除节点（逗号分隔）", "exclude node ids (csv)")}</Label>
          <Input
            value={constraintsText.exclude_node_ids}
            onChange={(e) => {
              setConstraintsText({ ...constraintsText, exclude_node_ids: e.target.value });
              emit({ ...template, constraints: normalizeConstraints({ ...constraintsText, exclude_node_ids: e.target.value }) });
            }}
          />
        </div>
        <div>
          <Label>{t(locale, "允许的 lifecycle（逗号分隔，缺省=仅 active）", "allowed lifecycles (csv; default = active only)")}</Label>
          <Input
            value={constraintsText.allowed_lifecycles}
            onChange={(e) => {
              setConstraintsText({ ...constraintsText, allowed_lifecycles: e.target.value });
              emit({ ...template, constraints: normalizeConstraints({ ...constraintsText, allowed_lifecycles: e.target.value }) });
            }}
          />
        </div>
        <div>
          <Label>{t(locale, "要求的健康态（逗号分隔）", "require health states (csv)")}</Label>
          <Input
            value={constraintsText.require_health}
            onChange={(e) => {
              setConstraintsText({ ...constraintsText, require_health: e.target.value });
              emit({ ...template, constraints: normalizeConstraints({ ...constraintsText, require_health: e.target.value }) });
            }}
          />
        </div>
        <label className="flex items-center gap-2 self-end text-sm">
          <input
            type="checkbox"
            data-testid={`${testId}-require-binding`}
            checked={constraintsText.require_node_binding}
            onChange={(e) => {
              setConstraintsText({ ...constraintsText, require_node_binding: e.target.checked });
              emit({ ...template, constraints: normalizeConstraints({ ...constraintsText, require_node_binding: e.target.checked }) });
            }}
          />
          {t(locale, "要求相邻跳已有节点绑定", "require node binding between hops")}
        </label>
        <div className="sm:col-span-2">
          <Label>{t(locale, "必需能力（逗号分隔）", "required capabilities (csv)")}</Label>
          <Input
            data-testid={`${testId}-capabilities`}
            value={capabilitiesText}
            onChange={(e) => {
              setCapabilitiesText(e.target.value);
              emit({ ...template, required_capabilities: normalizeCapabilities(e.target.value) });
            }}
          />
        </div>
      </div>

      <div className="rounded border border-[var(--border)] bg-[var(--muted)]/40 p-2 text-xs">
        <div className="mb-1 font-medium">{t(locale, "当前有序跳链", "Current ordered hops")}</div>
        <TransitChain template={template} locale={locale} testId={`${testId}-preview-chain`} />
      </div>
    </div>
  );
}

/** 新模板的默认值（避免每个入口各写一份）。 */
export function blankTemplate(ingressNodeId: number, egressNodeId: number): RouteProfileTemplate {
  return { ...EMPTY_TEMPLATE, ingress: { kind: "fixed_node", node_id: ingressNodeId }, egress: { kind: "fixed_node", node_id: egressNodeId } };
}

/* ================================================================== */
/* Impact Analysis + apply                                             */
/* ================================================================== */

export function RouteProfileImpactPanel({
  profile,
  locale,
  onApplied,
}: {
  profile: { id: number; version: number; template: RouteProfileTemplate };
  locale: Locale;
  onApplied?: () => void;
}) {
  const [impact, setImpact] = useState<RouteProfileImpact | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [result, setResult] = useState<RouteProfileApplyResult | null>(null);
  const { pending, error, notice, run } = useProfileAction();

  const load = useCallback(async () => {
    await run("impact", () => api.routeProfiles.impact(profile.id, profile.version), (res) => {
      const data = res as unknown as RouteProfileImpact;
      setImpact(data);
      setSelected(data.affected.filter((entry) => entry.resolves).map((entry) => entry.forward_id));
      return t(
        locale,
        `影响面 ${data.total} 条（其中 ${data.changing} 条会改变放置）`,
        `${data.total} affected (${data.changing} would change the resolved path)`,
      );
    });
  }, [locale, profile.id, profile.version, run]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (dryRun: boolean) => {
    if (selected.length === 0) return;
    const expected_revisions = (impact?.affected ?? [])
      .filter((entry) => selected.includes(entry.forward_id))
      .map((entry) => ({ forward_id: entry.forward_id, revision: entry.current_revision }));
    await run(
      dryRun ? "apply-dry" : "apply",
      () => api.routeProfiles.apply(profile.id, { version: profile.version, forward_ids: selected, expected_revisions, dry_run: dryRun }),
      (res) => {
        const data = res as unknown as RouteProfileApplyResult;
        setResult(data);
        return dryRun
          ? t(locale, `已预览 ${data.outcomes.length} 条（未下发任何变更）`, `Previewed ${data.outcomes.length} (nothing dispatched)`)
          : t(
              locale,
              `已下发 ${data.applied_count} 条，失败 ${data.failed_count} 条`,
              `Applied ${data.applied_count}, failed ${data.failed_count}`,
            );
      },
    );
  };

  return (
    <div className="flex flex-col gap-3" data-testid="route-profile-impact">
      <ReadOnlyNotice locale={locale} />
      {error && <RouteProfileErrorNotice error={error} locale={locale} />}
      {notice && (
        <p className="text-sm text-[var(--muted-foreground)]" data-testid="route-profile-impact-notice">
          {notice}
        </p>
      )}

      <RouteProfileTable
        rowCount={impact?.affected.length ?? 0}
        empty={
          t(
            locale,
            "还没有 Forward 使用这条路由策略 —— 第一次应用策略之前这是正确答案（策略只是规则，不会自动生成转发）",
            "No Forward references this profile yet — that is the correct answer before the first apply",
          )
        }
        columns={[
          { key: "select", label: "" },
          { key: "forward", label: "Forward" },
          { key: "current", label: t(locale, "当前路径", "current hops") },
          { key: "resolved", label: t(locale, "目标版本解析", "resolved (target)") },
          { key: "change", label: t(locale, "会发生什么", "what happens") },
        ]}
      >
        {(impact?.affected ?? []).map((entry) => (
          <TableRow key={entry.forward_id} data-testid="route-profile-impact-row" data-forward-id={entry.forward_id}>
            <TableCell>
              <input
                type="checkbox"
                data-testid="route-profile-impact-select"
                disabled={!entry.resolves}
                checked={selected.includes(entry.forward_id)}
                onChange={(e) =>
                  setSelected(e.target.checked ? [...selected, entry.forward_id] : selected.filter((id) => id !== entry.forward_id))
                }
              />
            </TableCell>
            <TableCell className="text-xs">
              <div className="font-medium">{entry.name}</div>
              <div className="text-[11px] text-[var(--muted-foreground)]">
                #{entry.forward_id} · {entry.tunnel_mode} · {t(locale, "当前 revision", "revision")} {entry.current_revision}
                {entry.source_version !== null ? ` · ${t(locale, "来源线路 v", "route v")}${entry.source_version}` : ""}
              </div>
            </TableCell>
            <TableCell className="text-xs font-mono">{hopsLabel(entry.current_hops)}</TableCell>
            <TableCell className="text-xs font-mono">
              {entry.resolves ? hopsLabel(entry.resolved_hops) : <span className="text-[var(--destructive)]">{entry.error?.code}</span>}
            </TableCell>
            <TableCell className="text-xs" data-testid="route-profile-impact-change" data-resolves={entry.resolves ? "true" : "false"} data-noop={entry.change?.noop ? "true" : "false"}>
              {impactChangeText(locale, entry)}
              {entry.error && (
                <div className="mt-0.5 text-[11px] text-[var(--destructive)]">
                  {entry.error.code}: {entry.error.message}
                </div>
              )}
            </TableCell>
          </TableRow>
        ))}
      </RouteProfileTable>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" data-testid="route-profile-impact-reload" disabled={pending !== null} onClick={() => void load()}>
          <RefreshCw className="size-3.5" />
          {t(locale, "重新分析（只读）", "Re-analyze (read-only)")}
        </Button>
        <Button variant="outline" size="sm" data-testid="route-profile-apply-dry" disabled={pending !== null || selected.length === 0} onClick={() => void apply(true)}>
          {t(locale, "预览 apply（dry run）", "Preview apply (dry run)")}
        </Button>
        <Button variant="default" size="sm" data-testid="route-profile-apply" disabled={pending !== null || selected.length === 0} onClick={() => void apply(false)}>
          <GitBranch className="size-3.5" />
          {t(locale, `对选中的 ${selected.length} 条执行 apply`, `Apply to ${selected.length} selected`)}
        </Button>
        <span className="text-xs text-[var(--muted-foreground)]">
          {t(locale, "apply 会为每条 Forward 生成新 revision（走既有 rollout，不改 lease）", "apply creates a new revision per Forward via the existing rollout")}
        </span>
      </div>

      {result && (
        <div className="rounded border border-[var(--border)] p-2 text-xs" data-testid="route-profile-apply-result" data-dry-run={result.dry_run ? "true" : "false"}>
          <div className="mb-1 font-medium">
            {result.dry_run ? t(locale, "预览结果（未下发）", "Preview result (not dispatched)") : t(locale, "apply 结果", "Apply result")}
          </div>
          <ul className="flex flex-col gap-1">
            {result.outcomes.map((outcome) => (
              <li key={outcome.forward_id} data-testid="route-profile-apply-outcome" data-status={outcome.status} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">#{outcome.forward_id}</span>
                <Badge variant={outcome.status === "failed" ? "destructive" : outcome.status === "previewed" ? "outline" : "success"}>
                  {applyOutcomeText(locale, outcome)}
                </Badge>
                {outcome.error && (
                  <span className="text-[var(--destructive)]">
                    {outcome.error.code}: {outcome.error.message}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {!result.dry_run && onApplied && (
            <p className="mt-1 text-[var(--muted-foreground)]">
              {t(locale, "已记录策略来源；如需刷新列表请点上面的刷新。", "Policy source recorded; refresh the list above if needed.")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/* 列表 + 详情动作                                                     */
/* ================================================================== */

export function RouteProfilesManager({ initial, locale }: { initial: RouteProfileView[]; locale: Locale }) {
  const [rows, setRows] = useState<RouteProfileView[]>(initial);
  const [detail, setDetail] = useState<{ id: number; used_by_forwards: number } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [metaTarget, setMetaTarget] = useState<RouteProfileView | null>(null);
  const [publishTarget, setPublishTarget] = useState<RouteProfileView | null>(null);
  const [impactTarget, setImpactTarget] = useState<RouteProfileView | null>(null);
  const [createForm, setCreateForm] = useState({ name: "", description: "", visibility: "INTERNAL", enabled: true });
  const [createTemplate, setCreateTemplate] = useState<RouteProfileTemplate>(() => blankTemplate(1, 5));
  const [metaForm, setMetaForm] = useState({ name: "", description: "", visibility: "INTERNAL", enabled: true });
  const [publishTemplate, setPublishTemplate] = useState<RouteProfileTemplate | null>(null);
  const [publishSummary, setPublishSummary] = useState("");
  const [templateChanged, setTemplateChanged] = useState(false);
  const { pending, error, notice, run, clear } = useProfileAction();

  const refresh = async () => {
    await run("refresh", () => api.routeProfiles.list({ page: 1, page_size: 50 }), (res) => {
      const page = res as unknown as { data: RouteProfileView[]; total: number };
      setRows(page.data);
      return t(locale, `已刷新（共 ${page.total} 条）`, `Refreshed (${page.total})`);
    });
  };

  const submitCreate = async () => {
    const created = await run(
      "create",
      () =>
        api.routeProfiles.create({
          name: createForm.name.trim(),
          description: createForm.description.trim() || null,
          visibility: createForm.visibility as "INTERNAL",
          enabled: createForm.enabled,
          template: createTemplate,
        }),
      () => t(locale, "路由策略已创建（v1）", "Routing policy created (v1)"),
    );
    if (created) {
      setCreateOpen(false);
      setCreateForm({ name: "", description: "", visibility: "INTERNAL", enabled: true });
      setCreateTemplate(blankTemplate(1, 5));
      await refresh();
    }
  };

  const submitMeta = async () => {
    if (!metaTarget) return;
    const saved = await run(
      "patch",
      () =>
        api.routeProfiles.patch(metaTarget.id, {
          name: metaForm.name.trim(),
          description: metaForm.description.trim() || null,
          visibility: metaForm.visibility as "INTERNAL",
          enabled: metaForm.enabled,
          // 乐观闸门：确认改的是我们看到的那个版本
          expected_version: metaTarget.version,
        }),
      () => t(locale, "已保存（metadata 变更不会 bump 版本）", "Saved (metadata edit does not bump the version)"),
    );
    if (saved) {
      setMetaTarget(null);
      await refresh();
    }
  };

  const submitPublish = async () => {
    if (!publishTarget || !publishTemplate) return;
    const published = await run(
      "publish",
      () =>
        api.routeProfiles.publishVersion(publishTarget.id, {
          template: publishTemplate,
          expected_version: publishTarget.version,
          change_summary: publishSummary.trim() || undefined,
        }),
      (res) => {
        const data = res as unknown as { version: number };
        return t(locale, `已发布新版本 v${data.version}（运行中的 Forward 未受影响）`, `Published v${data.version} (running forwards untouched)`);
      },
    );
    if (published) {
      setPublishTarget(null);
      setPublishTemplate(null);
      setPublishSummary("");
      setTemplateChanged(false);
      await refresh();
    }
  };

  const openMeta = (row: RouteProfileView) => {
    clear();
    setMetaForm({
      name: row.name,
      description: row.description ?? "",
      visibility: String(row.visibility),
      enabled: row.enabled,
    });
    setMetaTarget(row);
  };

  const openPublish = (row: RouteProfileView) => {
    clear();
    setPublishTemplate(row.template);
    setTemplateChanged(false);
    setPublishSummary("");
    setPublishTarget(row);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="route-profiles-manager">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile testId="rp-stat-total" label={t(locale, "路由策略", "Routing policies")} value={String(rows.length)} />
        <StatTile
          testId="rp-stat-public"
          label={t(locale, "公开可选", "PUBLIC")}
          value={String(rows.filter((r) => r.visibility === "PUBLIC" && r.enabled).length)}
        />
        <StatTile
          testId="rp-stat-disabled"
          label={t(locale, "已停用", "Disabled")}
          value={String(rows.filter((r) => !r.enabled).length)}
          hint={t(locale, "停用后不再允许 apply、也不再对用户可见", "Disabled blocks apply and hides it from users")}
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>{t(locale, "路由策略", "Routing policies")}</CardTitle>
            <CardDescription>
              {t(
                locale,
                "改路径规则 = 发布新版本；改名称/描述/可见性/启用 = 原地改。影响分析只读，只有应用策略才会改变转发路径。",
                "Editing template content publishes a new version; name/description/visibility/enabled are in-place.",
              )}
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={pending !== null}>
              <RefreshCw className="size-3.5" />
              {t(locale, "刷新", "Refresh")}
            </Button>
            <Button variant="default" size="sm" data-testid="route-profile-create-open" disabled={pending !== null} onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" />
              {t(locale, "新建路由策略", "New routing policy")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <RouteProfileTable
            rowCount={rows.length}
            empty={t(locale, "还没有路由策略。", "No routing policies yet.")}
            columns={[
              { key: "name", label: t(locale, "名称", "Name") },
              { key: "visibility", label: t(locale, "可见性", "Visibility") },
              { key: "state", label: t(locale, "状态", "State") },
              { key: "version", label: t(locale, "版本", "Version") },
              { key: "chain", label: t(locale, "入口 → 中转 → 出口", "ingress → transit → egress") },
              { key: "actions", label: t(locale, "操作", "Actions") },
            ]}
          >
            {rows.map((row) => (
              <TableRow key={row.id} data-testid="route-profile-row" data-profile-id={row.id}>
                <TableCell className="text-xs">
                  <div className="font-medium">{row.name}</div>
                  <div className="text-[11px] text-[var(--muted-foreground)]">{row.description ?? "—"}</div>
                  {detail?.id === row.id && (
                    <div className="text-[11px] text-[var(--muted-foreground)]" data-testid="route-profile-used-by">
                      {t(locale, `被 ${detail.used_by_forwards} 条 Forward 引用`, `${detail.used_by_forwards} Forward(s) reference it`)}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <VisibilityPill visibility={String(row.visibility)} locale={locale} />
                </TableCell>
                <TableCell>
                  <Badge variant={row.enabled ? "success" : "muted"} data-testid="route-profile-enabled" data-enabled={row.enabled ? "true" : "false"}>
                    {row.enabled ? t(locale, "启用", "enabled") : t(locale, "停用", "disabled")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <VersionBadge version={row.version} locale={locale} />
                </TableCell>
                <TableCell className="text-xs">
                  <TransitChain template={row.template} locale={locale} />
                  <div className="mt-0.5 text-[11px] text-[var(--muted-foreground)]" data-testid="route-profile-summary">
                    {templateSummary(locale, row.template)}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Button variant="ghost" size="sm" data-testid="route-profile-meta" onClick={() => openMeta(row)}>
                      {t(locale, "改基本信息", "Edit metadata")}
                    </Button>
                    <Button variant="ghost" size="sm" data-testid="route-profile-publish" onClick={() => openPublish(row)}>
                      {t(locale, "发布新版本", "New version")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="route-profile-impact-open"
                      onClick={() => {
                        clear();
                        setImpactTarget(row);
                        void api.routeProfiles
                          .detail(row.id)
                          .then((d) => setDetail({ id: row.id, used_by_forwards: d.used_by_forwards }))
                          .catch(() => setDetail(null));
                      }}
                    >
                      <Info className="size-3.5" />
                      {t(locale, "影响分析", "Impact")}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </RouteProfileTable>
        </CardContent>
      </Card>

      {error && !createOpen && !metaTarget && !publishTarget && !impactTarget && (
        <RouteProfileErrorNotice error={error} locale={locale} onRetry={refresh} />
      )}
      {notice && (
        <p className="text-sm text-[var(--muted-foreground)]" data-testid="route-profiles-notice">
          {notice}
        </p>
      )}
      {pending && (
        <p className="text-xs text-[var(--muted-foreground)]" data-testid="route-profiles-pending">
          {t(locale, "处理中…", "working…")}
        </p>
      )}

      {/* 新建 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t(locale, "新建路由策略", "New routing policy")}</DialogTitle>
            <DialogDescription>
              {t(locale, "创建即产生 v1；后续路径规则变更通过发布新版本完成。", "Creation produces v1; later path-rule changes publish new versions.")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t(locale, "名称", "Name")}</Label>
              <Input data-testid="route-profile-create-name" value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} />
            </div>
            <div>
              <Label>{t(locale, "可见性", "Visibility")}</Label>
              <select
                data-testid="route-profile-create-visibility"
                className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-sm"
                value={createForm.visibility}
                onChange={(e) => setCreateForm({ ...createForm, visibility: e.target.value })}
              >
                <option value="INTERNAL">INTERNAL</option>
                <option value="ASSIGNED">ASSIGNED</option>
                <option value="PUBLIC">PUBLIC</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <Label>{t(locale, "描述", "Description")}</Label>
              <Input value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} />
            </div>
          </div>
          <RouteProfileTemplateEditor initial={createTemplate} onChange={(next) => setCreateTemplate(next)} locale={locale} testId="route-profile-create-editor" />
          {error && <RouteProfileErrorNotice error={error} locale={locale} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t(locale, "取消", "Cancel")}
            </Button>
            <Button data-testid="route-profile-create-submit" disabled={pending !== null} onClick={() => void submitCreate()}>
              {t(locale, "创建（v1）", "Create (v1)")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 原地改 metadata */}
      <Dialog open={metaTarget !== null} onOpenChange={(open) => !open && setMetaTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(locale, "编辑基本信息（不产生新版本）", "Edit metadata (no new version)")}</DialogTitle>
            <DialogDescription>
              {t(
                locale,
                "名称 / 描述 / 可见性 / 启用状态属于「原地改」：版本号不变，也不会重写任何正在运行的 Forward。",
                "Name/description/visibility/enabled are in-place edits: the version does not change and no running Forward is rewritten.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div>
              <Label>{t(locale, "名称", "Name")}</Label>
              <Input data-testid="route-profile-meta-name" value={metaForm.name} onChange={(e) => setMetaForm({ ...metaForm, name: e.target.value })} />
            </div>
            <div>
              <Label>{t(locale, "描述", "Description")}</Label>
              <Input value={metaForm.description} onChange={(e) => setMetaForm({ ...metaForm, description: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>{t(locale, "可见性", "Visibility")}</Label>
                <select
                  data-testid="route-profile-meta-visibility"
                  className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-sm"
                  value={metaForm.visibility}
                  onChange={(e) => setMetaForm({ ...metaForm, visibility: e.target.value })}
                >
                  <option value="INTERNAL">INTERNAL</option>
                  <option value="ASSIGNED">ASSIGNED</option>
                  <option value="PUBLIC">PUBLIC</option>
                </select>
                <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{visibilityText(locale, metaForm.visibility).hint}</p>
              </div>
              <label className="flex items-center gap-2 self-end text-sm">
                <input
                  type="checkbox"
                  data-testid="route-profile-meta-enabled"
                  checked={metaForm.enabled}
                  onChange={(e) => setMetaForm({ ...metaForm, enabled: e.target.checked })}
                />
                {t(locale, "启用（停用后不再允许 apply、也不对用户可见）", "Enabled (disabled blocks apply and hides from users)")}
              </label>
            </div>
            <p className="text-[11px] text-[var(--muted-foreground)]">
              {t(locale, "路径规则请用「发布新版本」修改。", "Use “New version” to change path rules.")}
            </p>
          </div>
          {error && <RouteProfileErrorNotice error={error} locale={locale} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMetaTarget(null)}>
              {t(locale, "取消", "Cancel")}
            </Button>
            <Button data-testid="route-profile-meta-submit" disabled={pending !== null} onClick={() => void submitMeta()}>
              {t(locale, "保存（版本不变）", "Save (version unchanged)")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 发布新版本 */}
      <Dialog open={publishTarget !== null} onOpenChange={(open) => !open && setPublishTarget(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitBranch className="size-4" />
              {t(locale, `发布新版本（当前 v${publishTarget?.version ?? "—"}）`, `Publish a new version (current v${publishTarget?.version ?? "—"})`)}
            </DialogTitle>
            <DialogDescription>
              {t(
                locale,
                "路径规则变更走这里：发布后生成 vN+1，运行中的 Forward 不会自动变化 —— 要让新策略生效必须再显式应用。",
                "Content changes go through here: vN+1 is created and running Forwards are untouched until an explicit apply.",
              )}
            </DialogDescription>
          </DialogHeader>
          {publishTemplate && (
            <RouteProfileTemplateEditor
              initial={publishTemplate}
              locale={locale}
              testId="route-profile-publish-editor"
              onChange={(next, changed) => {
                setPublishTemplate(next);
                setTemplateChanged(changed);
              }}
            />
          )}
          <div
            className="rounded border border-[var(--border)] p-2 text-xs"
            data-testid="route-profile-publish-intent"
            data-new-version={templateChanged ? "true" : "false"}
          >
            {templateChanged
              ? t(locale, "内容已变更 → 提交后将生成新版本（v+1）", "Content changed → submitting creates a new version (v+1)")
              : t(locale, "内容未变更 → 提交不会产生有意义的新版本", "Content unchanged → nothing meaningful to publish")}
          </div>
          <div>
            <Label>{t(locale, "变更说明（写进版本历史）", "Change summary")}</Label>
            <Input data-testid="route-profile-publish-summary" value={publishSummary} onChange={(e) => setPublishSummary(e.target.value)} />
          </div>
          {error && <RouteProfileErrorNotice error={error} locale={locale} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishTarget(null)}>
              {t(locale, "取消", "Cancel")}
            </Button>
            <Button
              data-testid="route-profile-publish-submit"
              disabled={pending !== null || !templateChanged}
              onClick={() => void submitPublish()}
            >
              {t(locale, "发布新版本", "Publish new version")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Impact + apply */}
      <Dialog open={impactTarget !== null} onOpenChange={(open) => !open && setImpactTarget(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {t(locale, "影响分析", "Impact analysis")}
              {impactTarget && <VersionBadge version={impactTarget.version} locale={locale} />}
            </DialogTitle>
            <DialogDescription>
              {t(
                locale,
                "范围口径：当前使用这条策略的 Forward（第一次应用之前为空是正确答案）。",
                "Scope: forwards whose source pointer references this profile.",
              )}
            </DialogDescription>
          </DialogHeader>
          {impactTarget && (
            <RouteProfileImpactPanel profile={{ id: impactTarget.id, version: impactTarget.version, template: impactTarget.template }} locale={locale} />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setImpactTarget(null)}>
              <X className="size-3.5" />
              {t(locale, "关闭", "Close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
