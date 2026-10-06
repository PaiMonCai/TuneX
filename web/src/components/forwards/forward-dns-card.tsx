/**
 * Forward 详情 · 「DNS 前门（DDNS）」卡片 —— **自包含组件**。
 *
 * 外部只需传 `forwardId`：权限、取数、栅栏、表单状态都在内部。
 * （挂载点由集成任务负责，本文件不 import `forward-detail.tsx` 的任何东西。）
 *
 * ── 这一片最容易说错的四件事，以及这里的处理 ──
 *   ① **只有 `state === "synced"` 才写"已切换"**：五态文案来自由服务端 `state` 索引的码表，
 *      其余四态的词条里不含"已切换/已生效"（测试逐态断言）。
 *   ② **"会重试"读两个字段**：`auto_resolve === true && next_attempt_at !== null`；
 *      只看 `next_attempt_at` 会把"自动同步关着"读成"稍后会重试"。时间用服务端给的 ISO，前端不算窗口。
 *   ③ **`connect_ip` 为空 ⇒ 不给地址**：期望地址集只来自服务端；空集时明说
 *      "服务端没有给出期望地址 / 当前状态会被 `dns_address_unavailable` 拒绝"，绝不猜。
 *   ④ **取不到 ≠ 没有**：读取失败、载荷里有未知 `state`、权限还没读出来、服务商列表读不到，
 *      四个分支互不冒充，也都不当成"未绑定"。切 Workspace 时在途响应由 `createDdnsReader` 丢弃。
 *
 * ── 首发刻意不开的口子 ──
 *   · 记录类型只给 A / AAAA（CNAME 会被执行器写成一个 IP 值），**由用户显式选择**：
 *     面板不从入口地址反推族别（那是服务端的判定，前端重算必然与之漂移），选错由服务端
 *     以 `dns_record_type_mismatch` 拒绝并给出人话；
 *   · 形态固定 `single_active`（`multi_entry` 今天只写 owner 单地址，不能当 HA 卖）；
 *   · 不发送 `ttl_seconds`（后端收下即丢弃，暴露它等于承诺一个不生效的开关）。
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Link2, RefreshCw, Unlink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, InfoRow, ToggleRow } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/providers";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { ddnsApi } from "@/lib/api/ddns";
import {
  apiMessageOf,
  ddnsErrorCodeOf,
  dnsBindingStateFromPayload,
  type DnsBindingReadResult,
  type DnsBindingState,
  type DnsProviderView,
} from "@/lib/types/ddns";
import {
  ddnsErrorText,
  ddnsText,
  dnsAddressAvailable,
  dnsAddressText,
  dnsModeText,
  dnsProviderDisplayText,
  dnsProviderTypeText,
  dnsRecordTypeText,
  dnsRetryFact,
  dnsRetryText,
  dnsStateCopy,
  dnsSyncedAtText,
  dnsWriteWarningText,
} from "@/lib/ddns-i18n";
import { formatDateTime } from "@/lib/utils";
import { createDdnsReader, type DdnsReadState } from "@/components/ddns/ddns-reader";
import { canSubmitBinding, forwardDnsView, type ForwardDnsView } from "@/components/ddns/ddns-view";

/** 可选记录类型：**不含 CNAME**（后端允许，但执行器会把它写成一个 IP 值）。 */
export const BINDABLE_RECORD_TYPES = ["A", "AAAA"] as const;
export type BindableRecordType = (typeof BINDABLE_RECORD_TYPES)[number];

export interface BindFormState {
  domain: string;
  recordType: BindableRecordType;
  providerId: number | null;
  autoResolve: boolean;
}

const EMPTY_BIND_FORM: BindFormState = { domain: "", recordType: "A", providerId: null, autoResolve: false };

/** 服务商列表在**卡片里**的三态（读不到 ≠ 空列表）。 */
export type ProvidersFact =
  | { kind: "loading" }
  | { kind: "ready"; rows: DnsProviderView[] }
  | { kind: "unavailable"; message: string };

function stateBadgeVariant(state: DnsBindingState["state"]): "muted" | "secondary" | "success" | "outline" | "destructive" {
  if (state === "synced") return "success";
  if (state === "synced_unverified") return "outline";
  if (state === "error") return "destructive";
  if (state === "pending") return "secondary";
  return "muted";
}

/** 纯展示体：测试直接枚举各个视图分支（静态渲染下 `useEffect` 不跑，所以必须可单独渲染）。 */
export function ForwardDnsCardBody({
  view,
  canUpdate,
  canSelectProvider,
  providers,
  pending,
  form,
  onFormChange,
  onBind,
  onUnbind,
  onRetry,
}: {
  view: ForwardDnsView;
  canUpdate: boolean;
  canSelectProvider: boolean;
  providers: ProvidersFact;
  pending: "bind" | "unbind" | null;
  form: BindFormState;
  onFormChange: (patch: Partial<BindFormState>) => void;
  onBind: () => void;
  onUnbind: () => void;
  onRetry: () => void;
}) {
  const { locale } = useI18n();
  const text = ddnsText(locale);

  const shell = (body: React.ReactNode) => (
    <Card data-testid="forward-dns-card">
      <CardHeader>
        <CardTitle>{text.cardTitle}</CardTitle>
        <CardDescription>{text.cardSubtitle}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{body}</CardContent>
    </Card>
  );

  if (view.kind === "permission_loading") {
    return shell(
      <p className="field-hint" data-testid="forward-dns-permission-loading">
        {text.permissionUnknown}
      </p>,
    );
  }
  if (view.kind === "permission_denied") {
    return shell(
      <p className="field-hint" data-testid="forward-dns-permission-denied">
        {text.forwardReadDenied}
      </p>,
    );
  }
  if (view.kind === "loading") {
    return shell(
      <p className="field-hint flex items-center gap-2" data-testid="forward-dns-loading">
        <Loader2 className="size-4 animate-spin" />
        {text.cardLoading}
      </p>,
    );
  }
  if (view.kind === "unavailable") {
    return shell(
      <div
        className="flex flex-col gap-2 rounded-md border border-[var(--warning,#eab308)]/60 bg-[var(--warning,#eab308)]/10 px-4 py-3"
        data-testid="forward-dns-unavailable"
        role="status"
      >
        <p className="text-sm font-medium">{text.cardUnavailable}</p>
        <p className="text-xs text-[var(--muted-foreground)]">{text.cardUnavailableHint}</p>
        {view.message && <p className="break-words font-mono text-xs text-[var(--muted-foreground)]">{view.message}</p>}
        <div>
          <Button variant="outline" size="sm" onClick={onRetry} data-testid="forward-dns-retry-load">
            <RefreshCw className="size-4" />
            {text.retry}
          </Button>
        </div>
      </div>,
    );
  }

  const binding = view.binding;
  const copy = dnsStateCopy(locale, binding.state);
  const writeWarning = dnsWriteWarningText(locale, binding);
  const retryFact = dnsRetryFact(binding);
  const bound = binding.state !== "unbound";
  const providerRows = providers.kind === "ready" ? providers.rows : null;

  return (
    <Card data-testid="forward-dns-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {text.cardTitle}
          <Badge
            variant={stateBadgeVariant(binding.state)}
            data-testid="forward-dns-state"
            data-state={binding.state}
          >
            {copy.title}
          </Badge>
        </CardTitle>
        <CardDescription>{text.cardSubtitle}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm" data-testid="forward-dns-state-detail">
          {copy.detail}
        </p>

        {/* 未绑定时也要把"将要写入的地址"说清楚：它是服务端推导值，不是承诺，也不是"已绑定"的证据。 */}
        {!bound && dnsAddressAvailable(binding) && (
          <InfoRow label={text.expectedOnBind}>
            <span className="font-mono text-xs">{binding.expected_values.join("、")}</span>
          </InfoRow>
        )}

        {/* connect_ip 为空（或没有入口节点）：服务端期望地址集为空。明说不可用，绝不猜地址。 */}
        {!dnsAddressAvailable(binding) && (
          <p
            className="rounded-md border border-[var(--destructive)]/40 bg-[var(--destructive)]/5 px-3 py-2 text-xs"
            data-testid="forward-dns-address-unavailable"
          >
            {text.expectedEmptyUnavailable}
          </p>
        )}

        {bound && (
          <div className="flex flex-col">
            <InfoRow label={text.domain}>{binding.domain ?? text.never}</InfoRow>
            <InfoRow label={text.recordType}>{dnsRecordTypeText(locale, binding.record_type)}</InfoRow>
            <InfoRow label={text.mode}>{dnsModeText(locale, binding.mode)}</InfoRow>
            <InfoRow label={text.provider}>{dnsProviderDisplayText(locale, binding, providerRows)}</InfoRow>
            <InfoRow label={text.expected}>{dnsAddressText(locale, binding.expected_values, "expected")}</InfoRow>
            <InfoRow label={text.confirmed}>{dnsAddressText(locale, binding.confirmed_values, "confirmed")}</InfoRow>
            <InfoRow label={text.syncedAt}>{dnsSyncedAtText(locale, binding, formatDateTime)}</InfoRow>
            <InfoRow label={text.readBack}>{binding.verified ? text.yes : text.no}</InfoRow>
            {binding.attempt_count !== null && <InfoRow label={text.attempts}>{binding.attempt_count}</InfoRow>}
            {binding.last_error !== null && (
              <InfoRow label={text.lastError}>
                <span className="font-mono text-xs" data-testid="forward-dns-last-error">
                  {binding.last_error}
                </span>
              </InfoRow>
            )}
          </div>
        )}

        {/* 退避："将于 X 重试" vs "不会自动重试" —— 判据读服务端两个字段，前端不算窗口。 */}
        {bound && (
          <p className="field-hint" data-testid="forward-dns-retry" data-retry={retryFact.kind}>
            {dnsRetryText(locale, binding, formatDateTime)}
          </p>
        )}

        {bound && (
          <div className="flex flex-col gap-1 rounded-md border border-[var(--border)] px-3 py-2">
            <span className="text-sm font-medium" data-testid="forward-dns-auto-resolve" data-auto={binding.auto_resolve}>
              {text.autoResolve}：{binding.auto_resolve ? text.autoResolveOn : text.autoResolveOff}
            </span>
            <span className="field-hint">{text.autoResolveHint}</span>
            {/* 关闭时**必须**说清后果：缺省就是关闭，而"绑定了就会跟着走"是最容易产生的误解。
                R5-A 复核专门点出过这条：只写"开启后会怎样"，用户会以为关着也没关系。 */}
            {!binding.auto_resolve && (
              <span className="field-hint" data-testid="forward-dns-auto-resolve-off-note">
                {text.autoResolveOffHint}
              </span>
            )}
          </div>
        )}

        {writeWarning && (
          <p
            className="rounded-md border border-[var(--warning,#eab308)]/60 bg-[var(--warning,#eab308)]/10 px-3 py-2 text-xs"
            data-testid="forward-dns-write-warning"
          >
            {writeWarning}
          </p>
        )}

        {!canUpdate && (
          <p className="field-hint" data-testid="forward-dns-update-denied">
            {text.updateOnlyHint}
          </p>
        )}
        {canUpdate && !canSubmitBinding(binding) && (
          <p className="field-hint" data-testid="forward-dns-rebind-hint">
            {text.rebindHint}
          </p>
        )}

        {canUpdate && canSubmitBinding(binding) && (
          <div className="flex flex-col gap-3 rounded-md border border-[var(--border)] px-3 py-3">
            <span className="text-sm font-medium">{text.bindTitle}</span>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={text.bindDomain} htmlFor="forward-dns-domain">
                <Input
                  id="forward-dns-domain"
                  value={form.domain}
                  onChange={(e) => onFormChange({ domain: e.target.value })}
                  placeholder={text.bindDomainPlaceholder}
                  data-testid="forward-dns-domain"
                />
              </Field>
              <Field label={text.recordType} htmlFor="forward-dns-record-type">
                <select
                  id="forward-dns-record-type"
                  value={form.recordType}
                  onChange={(e) => onFormChange({ recordType: e.target.value as BindableRecordType })}
                  className="flex h-9 w-full rounded-md border border-[var(--input)] bg-[var(--card)] px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                  data-testid="forward-dns-record-type"
                >
                  {BINDABLE_RECORD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {text.recordTypeLabel[type]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={text.bindProvider}>
              <select
                value={form.providerId === null ? "" : String(form.providerId)}
                onChange={(e) => onFormChange({ providerId: e.target.value === "" ? null : Number(e.target.value) })}
                disabled={!canSelectProvider}
                className="flex h-9 w-full rounded-md border border-[var(--input)] bg-[var(--card)] px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="forward-dns-provider"
              >
                <option value="">{text.providerNoneOption}</option>
                {(providerRows ?? []).map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}（{dnsProviderTypeText(locale, provider.type)}）
                    {provider.has_credential ? "" : ` — ${text.providerCredentialBad}`}
                  </option>
                ))}
              </select>
            </Field>
            {!canSelectProvider && (
              <p className="field-hint" data-testid="forward-dns-providers-unreadable">
                {text.providersUnreadable}
              </p>
            )}
            {canSelectProvider && providers.kind === "unavailable" && (
              <p className="field-hint" data-testid="forward-dns-providers-load-failed">
                {text.providersLoadFailed}
              </p>
            )}
            {canSelectProvider && providers.kind === "ready" && providers.rows.length === 0 && (
              <p className="field-hint" data-testid="forward-dns-providers-empty">
                {text.providersEmptyForBind}
              </p>
            )}
            <ToggleRow
              label={text.bindAutoResolve}
              description={text.autoResolveHint}
              checked={form.autoResolve}
              onCheckedChange={(checked) => onFormChange({ autoResolve: checked })}
            />
            {/* 提交前就把 G4(a) 说清：开了自动同步但没选服务商 ⇒ 执行器不会写入 */}
            {form.autoResolve && form.providerId === null && (
              <p
                className="rounded-md border border-[var(--warning,#eab308)]/60 bg-[var(--warning,#eab308)]/10 px-3 py-2 text-xs"
                data-testid="forward-dns-bind-warning"
              >
                {text.warningNoProvider}
              </p>
            )}
            <div className="flex justify-end">
              <Button onClick={onBind} disabled={pending !== null} data-testid="forward-dns-bind">
                {pending === "bind" ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
                {pending === "bind" ? text.binding : text.bindSubmit}
              </Button>
            </div>
          </div>
        )}

        {canUpdate && !canSubmitBinding(binding) && (
          <div className="flex justify-end">
            <Button variant="outline" onClick={onUnbind} disabled={pending !== null} data-testid="forward-dns-unbind">
              {pending === "unbind" ? <Loader2 className="size-4 animate-spin" /> : <Unlink className="size-4" />}
              {pending === "unbind" ? text.unbinding : text.unbind}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ForwardDnsCard({ forwardId }: { forwardId: number }) {
  const { locale } = useI18n();
  const { currentId, permissionsLoading, can } = useWorkspace();
  const text = ddnsText(locale);
  const canRead = can("forward:read");
  const canUpdate = can("forward:update");
  // 选服务商要读设置域（`GET /api/ddns/providers` 是 settings:read），与 forward:update 是两把权限。
  const canSelectProvider = can("settings:read");

  const [read, setRead] = useState<DdnsReadState<DnsBindingReadResult>>({ status: "loading" });
  const [providers, setProviders] = useState<ProvidersFact>({ kind: "loading" });
  const [pending, setPending] = useState<"bind" | "unbind" | null>(null);
  const [form, setForm] = useState<BindFormState>(EMPTY_BIND_FORM);
  const [reloadToken, setReloadToken] = useState(0);

  const bindReader = useRef<ReturnType<typeof createDdnsReader<DnsBindingReadResult>> | null>(null);
  if (bindReader.current === null) {
    bindReader.current = createDdnsReader<DnsBindingReadResult>((workspaceId) =>
      ddnsApi.forwardDns({ workspaceId }, forwardId).then(dnsBindingStateFromPayload),
    );
  }
  const providerReader = useRef<ReturnType<typeof createDdnsReader<DnsProviderView[]>> | null>(null);
  if (providerReader.current === null) {
    providerReader.current = createDdnsReader<DnsProviderView[]>((workspaceId) => ddnsApi.listProviders({ workspaceId }));
  }

  useEffect(() => {
    const bindingReader = bindReader.current;
    const listReader = providerReader.current;
    if (!bindingReader || !listReader) return;
    // 切 Workspace：作废两组在途请求；晚到的旧作用域响应会被 reader 直接丢掉（不写状态）。
    bindingReader.reset();
    listReader.reset();
    setRead(bindingReader.peek());
    setProviders({ kind: "loading" });
    if (permissionsLoading || currentId === null || !canRead) return;
    void bindingReader.load(currentId).then((outcome) => {
      if (outcome.applied) setRead(outcome.state);
    });
    if (!canSelectProvider) {
      setProviders({ kind: "unavailable", message: "" });
      return;
    }
    void listReader.load(currentId).then((outcome) => {
      if (!outcome.applied) return;
      const loaded = outcome.state;
      if (loaded.status === "ready") setProviders({ kind: "ready", rows: loaded.value });
      else if (loaded.status === "unavailable") setProviders({ kind: "unavailable", message: loaded.message });
      else setProviders({ kind: "loading" });
    });
  }, [currentId, permissionsLoading, canRead, canSelectProvider, forwardId, reloadToken]);

  async function bind() {
    if (!canUpdate || pending !== null || currentId === null) return;
    const domain = form.domain.trim();
    if (domain === "") {
      toast.error(ddnsErrorText(locale, "invalid_input", text.bindFailed));
      return;
    }
    setPending("bind");
    try {
      const payload = await ddnsApi.bindForwardDns({ workspaceId: currentId }, forwardId, {
        domain,
        record_type: form.recordType,
        mode: "single_active",
        provider_id: form.providerId,
        auto_resolve: form.autoResolve,
      });
      const parsed = dnsBindingStateFromPayload(payload);
      // 200/201 只代表服务端受理，**不等于**已同步：五态与文案都说 pending。
      if (parsed.ok) setRead({ status: "ready", workspaceId: currentId, value: parsed });
      else setReloadToken((n) => n + 1);
      toast.success(text.bound);
      setForm(EMPTY_BIND_FORM);
    } catch (error) {
      toast.error(ddnsErrorText(locale, ddnsErrorCodeOf(error), apiMessageOf(error) ?? text.bindFailed));
    } finally {
      setPending(null);
    }
  }

  async function unbind() {
    if (!canUpdate || pending !== null || currentId === null) return;
    setPending("unbind");
    try {
      const payload = await ddnsApi.unbindForwardDns({ workspaceId: currentId }, forwardId);
      const parsed = dnsBindingStateFromPayload(payload);
      if (parsed.ok) setRead({ status: "ready", workspaceId: currentId, value: parsed });
      else setReloadToken((n) => n + 1);
      toast.success(text.unbound);
    } catch (error) {
      toast.error(ddnsErrorText(locale, ddnsErrorCodeOf(error), apiMessageOf(error) ?? text.unbindFailed));
    } finally {
      setPending(null);
    }
  }

  const view = forwardDnsView({ permissionsLoading, canRead, read });

  return (
    <ForwardDnsCardBody
      view={view}
      canUpdate={canUpdate}
      canSelectProvider={canSelectProvider}
      providers={providers}
      pending={pending}
      form={form}
      onFormChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
      onBind={() => void bind()}
      onUnbind={() => void unbind()}
      onRetry={() => setReloadToken((n) => n + 1)}
    />
  );
}
