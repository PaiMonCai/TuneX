"use client";

import { useState } from "react";
import { Pause, Play, Plus, RefreshCw, ShieldOff } from "lucide-react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  FederationErrorNotice,
  FederationSection,
  FederationTable,
  type Locale,
  StatusPill,
} from "@/components/admin/federation/federation-ui";
import { useFederationAction } from "@/components/admin/federation/use-federation-action";
import { capacitySummary, grantStatusText, scopeSummary } from "@/components/admin/federation/federation-status";
import type { FederationGrant, FederationPeer } from "@/lib/types";

const HOP_ROLES = ["ingress", "egress", "transit"] as const;

interface GrantForm {
  peer_panel_id: string;
  workspace_id: string;
  node_group_ids: string;
  hop_roles: string[];
  max_legs: string;
  max_bandwidth_mbps: string;
  max_connections: string;
  expires_in_seconds: string;
  quota_reserved: boolean;
}

const EMPTY_FORM: GrantForm = {
  peer_panel_id: "",
  workspace_id: "",
  node_group_ids: "",
  hop_roles: ["egress"],
  max_legs: "2",
  max_bandwidth_mbps: "",
  max_connections: "",
  expires_in_seconds: "86400",
  quota_reserved: false,
};

const csvInts = (raw: string): number[] =>
  raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);

const optionalInt = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN;
};

/**
 * 授予（`/admin/federation/grants`）：列表 + 新建 + revoke / suspend / resume。
 *
 * 表单只构造契约里存在的键（`scope` 的三个键 + `capacity` 的三个键）：
 * 后端对未知键 fail-closed（`grant_scope_violation` / `message_malformed`），
 * 所以界面**不提供**「粘贴任意 JSON」的入口 —— 那只会把 fail-closed 变成用户的困惑。
 * 失败时原样显示后端错误码与下一步。
 */
export function FederationGrantsManager({
  initial,
  peers,
  locale,
}: {
  initial: FederationGrant[];
  peers: FederationPeer[];
  locale: Locale;
}) {
  const [grants, setGrants] = useState<FederationGrant[]>(initial);
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<FederationGrant | null>(null);
  const [form, setForm] = useState<GrantForm>({ ...EMPTY_FORM, peer_panel_id: peers.find((p) => p.status === "active")?.peer_panel_id ?? "" });
  const { pending, error, notice, run } = useFederationAction();

  const refresh = async () => {
    await run("refresh", () => api.admin.federation.grants(), {
      onSuccess: (next) => setGrants(next as FederationGrant[]),
    });
  };

  const submit = async () => {
    const maxLegs = optionalInt(form.max_legs);
    const mbps = optionalInt(form.max_bandwidth_mbps);
    const conns = optionalInt(form.max_connections);
    const expires = Number(form.expires_in_seconds);
    const okDone = await run(
      "create",
      () =>
        api.admin.federation.createGrant({
          peer_panel_id: form.peer_panel_id,
          workspace_id: form.workspace_id.trim() === "" ? null : Number(form.workspace_id),
          scope: {
            node_group_ids: csvInts(form.node_group_ids),
            hop_roles: form.hop_roles,
            allow_target_policy: null,
          },
          capacity: {
            max_legs: Number.isNaN(maxLegs as number) ? null : maxLegs,
            max_bandwidth_mbps: Number.isNaN(mbps as number) ? null : mbps,
            max_connections: Number.isNaN(conns as number) ? null : conns,
          },
          expires_in_seconds: Number.isFinite(expires) ? expires : 86400,
          quota_reserved: form.quota_reserved,
        }),
      {
        describe: (result) =>
          `${locale === "en" ? "Grant created" : "授予已创建"} · ${(result as { grant_ref: string }).grant_ref}`,
        onSuccess: () => setCreateOpen(false),
      },
    );
    if (okDone) await refresh();
  };

  const act = async (grant: FederationGrant, action: "revoke" | "suspend" | "resume") => {
    const okDone = await run(`${action}:${grant.grant_ref}`, () =>
      action === "revoke"
        ? api.admin.federation.revokeGrant(grant.grant_ref)
        : action === "suspend"
          ? api.admin.federation.suspendGrant(grant.grant_ref)
          : api.admin.federation.resumeGrant(grant.grant_ref),
      {
        describe: (result) => {
          const body = result as { grant_epoch: number; leases_revoked?: number; ports_released?: number; ports_pending?: number };
          if (action === "revoke") {
            return `${locale === "en" ? "Revoked" : "已撤销"} · epoch=${body.grant_epoch} · ${
              body.leases_revoked ?? 0
            } ${locale === "en" ? "leases" : "条租约"} · ${body.ports_released ?? 0} ${
              locale === "en" ? "ports released" : "个端口已归还"
            }${body.ports_pending ? (locale === "en" ? ` · ${body.ports_pending} pending teardown` : ` · ${body.ports_pending} 个待停服归还`) : ""}`;
          }
          return `${action === "suspend" ? (locale === "en" ? "Suspended" : "已挂起") : locale === "en" ? "Resumed" : "已恢复"} · epoch=${body.grant_epoch}`;
        },
        onSuccess: () => {
          setRevokeTarget(null);
        },
      },
    );
    if (okDone) await refresh();
  };

  return (
    <div className="flex flex-col gap-4" data-testid="federation-grants">
      <FederationSection
        testId="federation-grants-section"
        title={locale === "en" ? "Resource grants" : "资源授予"}
        description={
          locale === "en"
            ? "Scope and capacity are sent as whole objects; unknown keys are rejected fail-closed by the backend."
            : "范围与容量按整对象提交；后端对未知键 fail-closed 拒绝。"
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh} disabled={pending !== null}>
              <RefreshCw className="size-3.5" />
              {locale === "en" ? "Refresh" : "刷新"}
            </Button>
            <Button variant="default" size="sm" data-testid="federation-grant-open" onClick={() => setCreateOpen(true)} disabled={pending !== null}>
              <Plus className="size-3.5" />
              {locale === "en" ? "New grant" : "新建授予"}
            </Button>
          </>
        }
      >
        <FederationTable
          rowCount={grants.length}
          empty={locale === "en" ? "No grants yet." : "还没有授予。"}
          columns={[
            { key: "ref", label: locale === "en" ? "Grant" : "授予" },
            { key: "status", label: locale === "en" ? "Status" : "状态" },
            { key: "scope", label: locale === "en" ? "Scope" : "范围" },
            { key: "capacity", label: locale === "en" ? "Capacity" : "容量" },
            { key: "expires", label: locale === "en" ? "Expires" : "到期" },
            { key: "actions", label: locale === "en" ? "Actions" : "操作" },
          ]}
        >
          {grants.map((grant) => {
            const status = grantStatusText(locale, grant.status);
            const canSuspend = grant.status === "active";
            const canResume = grant.status === "suspended";
            const canRevoke = grant.status !== "revoked";
            return (
              <TableRow key={grant.grant_ref} data-testid="federation-grant-row" data-grant-ref={grant.grant_ref}>
                <TableCell>
                  <div className="font-mono text-xs">{grant.grant_ref}</div>
                  <div className="text-[11px] text-[var(--muted-foreground)]">
                    peer #{grant.peer_id} · epoch {grant.grant_epoch}
                    {grant.workspace_id !== null ? ` · ws ${grant.workspace_id}` : ""}
                    {grant.quota_reserved ? ` · ${locale === "en" ? "quota reserved" : "已预留配额"}` : ""}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusPill label={status.label} tone={status.tone} testId="federation-grant-status" />
                </TableCell>
                <TableCell className="text-xs">{scopeSummary(locale, grant.scope)}</TableCell>
                <TableCell className="text-xs">{capacitySummary(locale, grant.capacity)}</TableCell>
                <TableCell className="text-xs text-[var(--muted-foreground)]">{formatDateTime(grant.expires_at)}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="federation-grant-suspend"
                      disabled={pending !== null || !canSuspend}
                      onClick={() => void act(grant, "suspend")}
                    >
                      <Pause className="size-3.5" />
                      {locale === "en" ? "suspend" : "挂起"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="federation-grant-resume"
                      disabled={pending !== null || !canResume}
                      onClick={() => void act(grant, "resume")}
                    >
                      <Play className="size-3.5" />
                      {locale === "en" ? "resume" : "恢复"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="federation-grant-revoke"
                      disabled={pending !== null || !canRevoke}
                      onClick={() => setRevokeTarget(grant)}
                    >
                      <ShieldOff className="size-3.5" />
                      {locale === "en" ? "revoke" : "撤销"}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </FederationTable>
      </FederationSection>

      {error && <FederationErrorNotice error={error} locale={locale} onRetry={refresh} />}
      {notice && (
        <p className="text-sm text-[var(--muted-foreground)]" data-testid="federation-grants-notice">
          {notice}
        </p>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{locale === "en" ? "New grant" : "新建授予"}</DialogTitle>
            <DialogDescription>
              {locale === "en"
                ? "Empty node group list means “nothing allowed” (deny), not “unlimited”."
                : "节点组留空表示「什么都不允许」（deny），不是「不限」。"}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="fed-grant-peer">{locale === "en" ? "Peer" : "对端"}</Label>
              <Input
                id="fed-grant-peer"
                data-testid="federation-grant-peer"
                value={form.peer_panel_id}
                onChange={(e) => setForm({ ...form, peer_panel_id: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="fed-grant-ws">{locale === "en" ? "Workspace id (optional)" : "工作空间 id（可选）"}</Label>
              <Input
                id="fed-grant-ws"
                value={form.workspace_id}
                onChange={(e) => setForm({ ...form, workspace_id: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="fed-grant-ng">{locale === "en" ? "Node group ids (csv)" : "节点组 id（逗号分隔）"}</Label>
              <Input
                id="fed-grant-ng"
                data-testid="federation-grant-node-groups"
                value={form.node_group_ids}
                onChange={(e) => setForm({ ...form, node_group_ids: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Label>{locale === "en" ? "Allowed hop roles" : "允许的 hop 角色"}</Label>
              <div className="flex flex-wrap gap-3 pt-1">
                {HOP_ROLES.map((role) => (
                  <label key={role} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      data-testid={`federation-grant-hop-${role}`}
                      checked={form.hop_roles.includes(role)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          hop_roles: e.target.checked
                            ? [...form.hop_roles, role]
                            : form.hop_roles.filter((r) => r !== role),
                        })
                      }
                    />
                    {role}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label htmlFor="fed-grant-legs">max_legs</Label>
              <Input id="fed-grant-legs" value={form.max_legs} onChange={(e) => setForm({ ...form, max_legs: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="fed-grant-mbps">max_bandwidth_mbps</Label>
              <Input id="fed-grant-mbps" value={form.max_bandwidth_mbps} onChange={(e) => setForm({ ...form, max_bandwidth_mbps: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="fed-grant-conns">max_connections</Label>
              <Input id="fed-grant-conns" value={form.max_connections} onChange={(e) => setForm({ ...form, max_connections: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="fed-grant-expires">{locale === "en" ? "expires_in_seconds (60–2592000)" : "expires_in_seconds（60–2592000）"}</Label>
              <Input
                id="fed-grant-expires"
                data-testid="federation-grant-expires"
                value={form.expires_in_seconds}
                onChange={(e) => setForm({ ...form, expires_in_seconds: e.target.value })}
              />
            </div>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                data-testid="federation-grant-quota-reserved"
                checked={form.quota_reserved}
                onChange={(e) => setForm({ ...form, quota_reserved: e.target.checked })}
              />
              {locale === "en" ? "Reserve quota on the host" : "在对端预留配额"}
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {locale === "en" ? "Cancel" : "取消"}
            </Button>
            <Button data-testid="federation-grant-submit" onClick={() => void submit()} disabled={pending !== null}>
              {locale === "en" ? "Create" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{locale === "en" ? "Revoke grant?" : "确认撤销授予？"}</DialogTitle>
            <DialogDescription>
              {locale === "en"
                ? "Live remote leases under this grant are cascaded to revoked and stopped. Ports are returned only after teardown succeeds."
                : "该授予下的活跃远端租约会级联撤销并停服；端口只有在停服成功后才归还（否则留给对账重试）。"}
            </DialogDescription>
          </DialogHeader>
          {revokeTarget && <div className="font-mono text-xs">{revokeTarget.grant_ref}</div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)}>
              {locale === "en" ? "Cancel" : "取消"}
            </Button>
            <Button
              variant="destructive"
              data-testid="federation-grant-revoke-confirm"
              disabled={pending !== null}
              onClick={() => revokeTarget && void act(revokeTarget, "revoke")}
            >
              {locale === "en" ? "Revoke" : "确认撤销"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
