"use client"

import { useState } from "react";
import { Copy, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { formatDateTime } from "@/lib/utils";
import type { WorkspaceInvite, WorkspaceInviteInput } from "@/lib/types";

/**
 * 邀请成员对话框（POST /api/workspaces/:id/invites）。
 *
 * 两条后端契约必须在 UI 上体现：
 *   1. 邀请 token 只在创建响应里返回**一次**（后端仅存 sha256）→ 必须当场展示 + 复制；
 *   2. 仅 team + manage 角色可邀请；成员数（active + 未过期未使用的邀请）超过策略上限时
 *      后端返回 403 + { code, limit }，这里把 limit 一并提示。
 */
export function InviteMemberDialog({
  open,
  onOpenChange,
  workspaceId,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: number;
  onInvited: () => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceInviteInput["role"]>("member");
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<WorkspaceInvite | null>(null);

  const trimmed = email.trim();
  const emailValid = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(trimmed);

  async function submit() {
    if (!emailValid || pending) return;
    setPending(true);
    try {
      // 后端对邮箱做 trim + lowercase，这里保持一致，避免大小写造成「重复邀请」误判
      const invite = await api.workspaces.invite(workspaceId, { email: trimmed.toLowerCase(), role });
      setCreated(invite);
      onInvited();
    } catch (err) {
      const limit =
        err && typeof err === "object" && "data" in err
          ? (err as { data?: { limit?: number } }).data?.limit
          : undefined;
      const msg = err instanceof Error ? err.message : t("workspace.inviteFailed");
      toast.error(limit === undefined ? msg : `${msg}（上限 ${limit}）`);
    } finally {
      setPending(false);
    }
  }

  async function copyToken() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      toast.success(t("workspace.inviteTokenCopied"));
    } catch {
      // 剪贴板不可用（非 HTTPS / 权限被拒）时直接展示原文，用户可手动选中
      toast.error(created.token);
    }
  }

  function close(next: boolean) {
    if (!next) {
      setCreated(null);
      setEmail("");
      setRole("member");
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent data-testid="invite-member-dialog">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("workspace.inviteTokenTitle")}</DialogTitle>
              <DialogDescription>{t("workspace.inviteTokenHint")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/40 p-3">
                <div className="mb-1.5 flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                  <span className="truncate">{created.email}</span>
                  <Badge variant="muted">{t(`workspace.role.${created.role}`)}</Badge>
                  <span className="ml-auto shrink-0">
                    {t("workspace.inviteExpires")} {formatDateTime(created.expires_at)}
                  </span>
                </div>
                <code
                  className="block break-all rounded bg-[var(--background)] px-2 py-1.5 font-mono text-xs"
                  data-testid="invite-token"
                >
                  {created.token}
                </code>
              </div>
              <p className="text-xs text-[var(--muted-foreground)]">{t("workspace.inviteTokenWarning")}</p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={copyToken} data-testid="invite-token-copy">
                <Copy className="size-4" />
                {t("common.copy")}
              </Button>
              <Button onClick={() => close(false)} data-testid="invite-done">
                {t("common.done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("workspace.inviteMember")}</DialogTitle>
              <DialogDescription>{t("workspace.inviteDesc")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>{t("common.email")}</Label>
                <Input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="teammate@example.com"
                  inputMode="email"
                  data-testid="invite-email"
                />
                {trimmed && !emailValid && (
                  <p className="text-xs text-[var(--destructive)]">{t("settings.emailInvalid")}</p>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t("common.role")}</Label>
                <Select value={role} onValueChange={(v) => setRole(v as WorkspaceInviteInput["role"])}>
                  <SelectTrigger data-testid="invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["admin", "member", "viewer"] as const).map((r) => (
                      <SelectItem key={r} value={r}>
                        {t(`workspace.role.${r}`)} — {t(`workspace.roleDesc.${r}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => close(false)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={submit} disabled={!emailValid || pending} data-testid="invite-submit">
                <Send className="size-4" />
                {t("workspace.inviteSend")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
