/**
 * 设置页 · Workspace 级「DNS 服务商」CRUD（EXPOSE 既有后端，不新增端点）。
 *
 * ── 凭据只写不读，而且**不进 React 状态** ──
 * token 输入框是**非受控**的（`defaultValue=""` + ref）。为什么比"受控 + 提交后 setState("")"
 * 更严：受控字段会把明文放进 React 树，任何一次 SSR/序列化/错误边界重渲染都可能把它写进
 * HTML 或日志；非受控则意味着明文只存在于真实的 DOM 节点里，提交后由 `clearCredential()`
 * 立刻抹掉，**结构上**不可能被回填或出现在服务端渲染输出里。
 * 它同样不进 URL（走 POST body）、不进 toast、不进 localStorage。
 *
 * ── 权限三态不得合并 ──
 * `permissionsLoading`（还不确定）与 `!can("settings:read")`（确实没有）是两个分支：
 * 前者按只读处理并说明原因，后者才说"没有权限"。写操作要 `settings:manage`。
 *
 * ── "列表为空"≠"平台没配" ──
 * 平台级凭据只对平台管理员可见，所以空列表只能说"你可见的列表为空"，不能推平台状态。
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDeleteDialog } from "@/components/admin/admin-ui";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/form";
import { Input, Label } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/components/providers";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { apiMessageOf, ddnsErrorCodeOf, DNS_PROVIDER_TYPES, type DnsProviderType, type DnsProviderView } from "@/lib/types/ddns";
import { ddnsApi } from "@/lib/api/ddns";
import { ddnsErrorText, ddnsText, dnsProviderTypeText } from "@/lib/ddns-i18n";
import { createDdnsReader, type DdnsReadState } from "./ddns-reader";
import { dnsProvidersView, type DnsProvidersView } from "./ddns-view";
import { clearCredential, readCredential } from "./credential-field";

export interface ProviderFormState {
  name: string;
  type: DnsProviderType;
  endpoint: string;
}

const EMPTY_FORM: ProviderFormState = { name: "", type: "cloudflare", endpoint: "" };

/** 服务商列表展示体（纯展示，供静态渲染测试直接枚举五个视图分支）。 */
export function DnsProvidersBody({
  view,
  canManage,
  form,
  creating,
  deletingId,
  credentialRef,
  onFormChange,
  onCreate,
  onRequestDelete,
  onRetry,
}: {
  view: DnsProvidersView;
  canManage: boolean;
  form: ProviderFormState;
  creating: boolean;
  deletingId: number | null;
  credentialRef: React.RefObject<HTMLInputElement | null>;
  onFormChange: (patch: Partial<ProviderFormState>) => void;
  onCreate: () => void;
  onRequestDelete: (provider: DnsProviderView) => void;
  onRetry: () => void;
}) {
  const { t, locale } = useI18n();
  const text = ddnsText(locale);

  return (
    <div className="flex flex-col gap-5" data-testid="ddns-providers-manager">
      <Card>
        <CardHeader>
          <CardTitle>{text.title}</CardTitle>
          <CardDescription>{text.subtitle}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {view.kind === "permission_loading" && (
            <p className="field-hint" data-testid="ddns-providers-permission-loading">
              {text.permissionUnknown}
            </p>
          )}
          {view.kind === "permission_denied" && (
            <p className="field-hint" data-testid="ddns-providers-permission-denied">
              {text.readOnlyHint}
            </p>
          )}
          {view.kind === "loading" && (
            <p className="field-hint flex items-center gap-2" data-testid="ddns-providers-loading">
              <Loader2 className="size-4 animate-spin" />
              {text.loading}
            </p>
          )}
          {view.kind === "unavailable" && (
            <div
              className="flex flex-col gap-2 rounded-md border border-[var(--warning,#eab308)]/60 bg-[var(--warning,#eab308)]/10 px-4 py-3"
              data-testid="ddns-providers-unavailable"
              role="status"
            >
              <p className="text-sm font-medium">{text.unavailable}</p>
              <p className="text-xs text-[var(--muted-foreground)]">{text.unavailableHint}</p>
              {/* 后端原句照实显示：可能是 403/404/网络错误，界面不替它编一个更具体的理由 */}
              {view.message && <p className="break-words font-mono text-xs text-[var(--muted-foreground)]">{view.message}</p>}
              <div>
                <Button variant="outline" size="sm" onClick={onRetry} data-testid="ddns-providers-retry">
                  <RefreshCw className="size-4" />
                  {text.retry}
                </Button>
              </div>
            </div>
          )}
          {view.kind === "ready" && (
            <div className="flex flex-col gap-3">
              {view.providers.length === 0 ? (
                <div
                  className="flex flex-col gap-1 rounded-md border border-dashed border-[var(--input)] px-4 py-6"
                  data-testid="ddns-providers-empty"
                >
                  <span className="text-sm">{text.empty}</span>
                  <span className="field-hint">{text.emptyHint}</span>
                </div>
              ) : (
                <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{text.name}</TableHead>
                    <TableHead>{text.type}</TableHead>
                    <TableHead>{text.createdAt}</TableHead>
                    <TableHead className="text-right">{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.providers.map((provider) => (
                    <TableRow key={provider.id} data-testid={`ddns-provider-row-${provider.id}`}>
                      <TableCell className="font-medium">
                        <span className="flex flex-wrap items-center gap-2">
                          {provider.name}
                          {provider.platform_level ? (
                            <Badge variant="outline" data-testid={`ddns-provider-platform-${provider.id}`}>
                              {text.platformBadge}
                            </Badge>
                          ) : (
                            <Badge variant="muted">{text.workspaceBadge}</Badge>
                          )}
                        </span>
                        {provider.platform_level && <span className="field-hint block">{text.platformHint}</span>}
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-col gap-1">
                          <span>{dnsProviderTypeText(locale, provider.type)}</span>
                          <span
                            className="field-hint"
                            data-testid={`ddns-provider-credential-${provider.id}`}
                          >
                            {provider.has_credential ? text.hasCredential : text.noCredential}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-[var(--muted-foreground)]">
                        {provider.created_at ?? text.never}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canManage || deletingId === provider.id}
                          onClick={() => onRequestDelete(provider)}
                          data-testid={`ddns-provider-delete-${provider.id}`}
                          aria-label={`${text.delete} ${provider.name}`}
                        >
                          {deletingId === provider.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                          {text.delete}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{text.create}</CardTitle>
          <CardDescription>{text.tokenHint}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={text.name} htmlFor="ddns-provider-name">
              <Input
                id="ddns-provider-name"
                value={form.name}
                onChange={(e) => onFormChange({ name: e.target.value })}
                placeholder={text.namePlaceholder}
                data-testid="ddns-provider-name"
              />
            </Field>
            <Field label={text.type} htmlFor="ddns-provider-type">
              <select
                id="ddns-provider-type"
                value={form.type}
                onChange={(e) => onFormChange({ type: e.target.value as DnsProviderType })}
                className="flex h-9 w-full rounded-md border border-[var(--input)] bg-[var(--card)] px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                data-testid="ddns-provider-type"
              >
                {DNS_PROVIDER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {dnsProviderTypeText(locale, type)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={text.endpoint} hint={text.endpointHint}>
              <Input
                value={form.endpoint}
                onChange={(e) => onFormChange({ endpoint: e.target.value })}
                placeholder={text.optional}
                data-testid="ddns-provider-endpoint"
              />
            </Field>
          </div>
          <Label htmlFor="ddns-provider-token">{text.token}</Label>
          {/* 非受控 + 无 defaultValue：明文只活在真实 DOM 节点里，提交后立刻清空 */}
          <Input
            id="ddns-provider-token"
            ref={credentialRef}
            type="password"
            autoComplete="off"
            placeholder={text.tokenPlaceholder}
            data-testid="ddns-provider-token"
            disabled={!canManage}
          />
          <p className="field-hint">{text.tokenHint}</p>
          <div className="flex justify-end">
            <Button onClick={onCreate} disabled={!canManage || creating} data-testid="ddns-provider-create">
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              {creating ? text.creating : text.create}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function DnsProvidersManager() {
  const { locale } = useI18n();
  const { currentId, permissionsLoading, can } = useWorkspace();
  const text = ddnsText(locale);
  const canRead = can("settings:read");
  const canManage = can("settings:manage");

  const [read, setRead] = useState<DdnsReadState<DnsProviderView[]>>({ status: "loading" });
  const [form, setForm] = useState<ProviderFormState>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DnsProviderView | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const credentialRef = useRef<HTMLInputElement | null>(null);
  const readerRef = useRef<ReturnType<typeof createDdnsReader<DnsProviderView[]>> | null>(null);
  if (readerRef.current === null) {
    readerRef.current = createDdnsReader<DnsProviderView[]>((workspaceId) => ddnsApi.listProviders({ workspaceId }));
  }

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) return;
    // 切 Workspace / 刷新：先作废在途请求，晚到的旧响应会被 reader 直接丢掉。
    reader.reset();
    setRead(reader.peek());
    if (permissionsLoading || currentId === null || !canRead) return;
    void reader.load(currentId).then((outcome) => {
      if (outcome.applied) setRead(outcome.state);
    });
  }, [currentId, permissionsLoading, canRead, reloadToken]);

  async function createProvider() {
    if (!canManage || creating || currentId === null) return;
    const scope = { workspaceId: currentId };
    const token = readCredential(credentialRef.current);
    const name = form.name.trim();
    const endpoint = form.endpoint.trim();
    if (name === "" || token === "") {
      toast.error(ddnsErrorText(locale, "invalid_input", text.createFailed));
      return;
    }
    setCreating(true);
    try {
      await ddnsApi.createProvider(scope, {
        name,
        type: form.type,
        credential: { token, ...(endpoint === "" ? {} : { endpoint }) },
      });
      toast.success(text.created);
      setForm((prev) => ({ ...prev, name: "", endpoint: "" }));
      setReloadToken((n) => n + 1);
    } catch (error) {
      toast.error(ddnsErrorText(locale, ddnsErrorCodeOf(error), apiMessageOf(error) ?? text.createFailed));
    } finally {
      // 成功与失败都清空：凭据不留在页面上（也不回填、不进任何日志）。
      clearCredential(credentialRef.current);
      setCreating(false);
    }
  }

  async function deleteProvider(provider: DnsProviderView) {
    if (!canManage || currentId === null) return;
    setDeletingId(provider.id);
    try {
      await ddnsApi.deleteProvider({ workspaceId: currentId }, provider.id);
      toast.success(text.deleted);
      setReloadToken((n) => n + 1);
    } catch (error) {
      toast.error(ddnsErrorText(locale, ddnsErrorCodeOf(error), apiMessageOf(error) ?? text.deleteFailed));
    } finally {
      setDeletingId(null);
      setDeleteTarget(null);
    }
  }

  const view = dnsProvidersView({ permissionsLoading, canRead, read });

  return (
    <>
      <DnsProvidersBody
        view={view}
        canManage={canManage}
        form={form}
        creating={creating}
        deletingId={deletingId}
        credentialRef={credentialRef}
        onFormChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
        onCreate={() => void createProvider()}
        onRequestDelete={(provider) => setDeleteTarget(provider)}
        onRetry={() => setReloadToken((n) => n + 1)}
      />
      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={text.deleteConfirmTitle}
        description={text.deleteConfirmBody}
        onConfirm={() => deleteTarget && void deleteProvider(deleteTarget)}
        pending={deletingId !== null}
      />
    </>
  );
}
