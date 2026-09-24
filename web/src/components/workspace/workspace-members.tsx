"use client";

import { useEffect, useState } from "react";
import { LogOut, LogIn, RefreshCw, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { InviteMemberDialog } from "@/components/workspace/invite-member-dialog";
import { formatDateTime } from "@/lib/utils";
import type { WorkspaceMember } from "@/lib/types";

/**
 * 工作空间管理页（成员列表 + 邀请 + 移除）。
 *
 * 权限（与后端一致）：
 *   - GET    /:id/members：任一 active 成员可读（个人空间就是自己）；
 *   - POST   /:id/invites：kind==="team" 且 role∈{owner,admin}；
 *   - DELETE /:id/members/:userId：manage 角色，或 actor===target（退出）。
 *     owner 行不可移除（后端 403）。
 */

/**
 * 「加入工作空间」：粘贴收到的邀请口令（POST /api/workspaces/invites/accept）。
 *
 * 后端契约：token 与**当前登录用户邮箱**匹配、单次使用、7 天有效；加入后
 * 刷新 workspace 列表，新空间出现在顶栏切换器里（当前空间不变，由用户自行切换）。
 */
function JoinWorkspace() {
  const { t } = useI18n();
  const { refresh } = useWorkspace();
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);

  const trimmed = token.trim();
  // 后端 zod 要求 30–128 字符，这里只做「非空即可提交」，精确校验交给后端
  const canSubmit = trimmed.length > 0 && !pending;

  async function join() {
    if (!canSubmit) return;
    setPending(true);
    try {
      await api.workspaces.acceptInvite(trimmed);
      toast.success(t("workspace.acceptInviteSuccess"));
      setToken("");
      // 成员列表页仍停留在原空间，但切换器里要能看到新加入的空间
      await refresh();
    } catch {
      // 后端统一返回「邀请不存在或已失效」不区分原因（防枚举），这里直接展示
      toast.error(t("workspace.acceptInviteFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LogIn className="size-4 shrink-0 opacity-70" />
          {t("workspace.acceptInvite")}
        </CardTitle>
        <CardDescription>{t("workspace.acceptInviteDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        <Label htmlFor="join-invite-token">{t("workspace.acceptInvitePlaceholder")}</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="join-invite-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void join();
            }}
            placeholder={t("workspace.acceptInvitePlaceholder")}
            className="font-mono text-xs"
            data-testid="join-invite-token"
          />
          <Button
            variant="outline"
            onClick={join}
            disabled={!canSubmit}
            className="shrink-0"
            data-testid="join-invite-submit"
          >
            <LogIn className="size-4" />
            {t("workspace.acceptInviteSubmit")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function WorkspaceMembers() {
  const { t } = useI18n();
  const { current, currentId, canManage, me, refresh } = useWorkspace();
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<WorkspaceMember | null>(null);

  const isPersonal = current?.kind === "personal";

  async function load() {
    if (currentId === null) return;
    setLoading(true);
    try {
      setMembers(await api.workspaces.members(currentId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("workspace.loadMembersFailed"));
      setMembers([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // currentId 变化即切换了空间，成员列表要整体重取
  }, [currentId]);

  const canInvite = canManage && !isPersonal;

  async function onRemove() {
    if (!removeTarget || currentId === null) return;
    const self = removeTarget.user_id === me?.id;
    try {
      await api.workspaces.removeMember(currentId, removeTarget.user_id);
      toast.success(self ? t("workspace.leftSuccess") : t("workspace.removedSuccess"));
      setRemoveTarget(null);
      await load();
      if (self) await refresh(); // 退出后 workspace 列表里已无该空间
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("workspace.removeMemberFailed"));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/*
        成员卡片固定展示「当前空间」的成员。
        「加入工作空间」只影响当前用户可访问的空间列表（顶栏切换器），不切换当前空间，
        因此放在同一页内，先邀请后加入的 workflow 不用跳出本页。
      */}
      <JoinWorkspace />

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate">{current?.name ?? t("common.loading")}</span>
              <Badge variant={isPersonal ? "outline" : "default"} data-testid="workspace-kind">
                {isPersonal ? t("workspace.kind.personal") : t("workspace.kind.team")}
              </Badge>
            </CardTitle>
            <CardDescription>
              {isPersonal ? t("workspace.personalHint") : t("workspace.teamHint")}
            </CardDescription>
            {/* 空间详情：类型 / 创建时间 / 成员数 + 当前用户角色（与切换器徽标一致） */}
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--muted-foreground)]">
              <span>
                {t("workspace.detailId")} {currentId ?? "-"}
              </span>
              <span>
                {t("common.createdAt")} {formatDateTime(current?.created_at)}
              </span>
              <span data-testid="workspace-member-count">
                {t("workspace.memberCount")} {members?.length ?? 0}
              </span>
              {current && (
                <Badge variant="muted" data-testid="workspace-role">
                  {t(`workspace.role.${current.role}`)}
                </Badge>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => void load()} aria-label={t("common.refresh")}>
              <RefreshCw className="size-4" />
            </Button>
            {canInvite && (
              <Button size="sm" onClick={() => setInviteOpen(true)} data-testid="invite-open">
                <UserPlus className="size-4" />
                {t("workspace.inviteMember")}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.email")}</TableHead>
                  <TableHead>{t("common.role")}</TableHead>
                  <TableHead>{t("common.createdAt")}</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center text-[var(--muted-foreground)]">
                      {t("common.loading")}
                    </TableCell>
                  </TableRow>
                ) : !members || members.length === 0 ? (
                  <TableEmpty colSpan={4} text={t("workspace.noMembers")} />
                ) : (
                  members.map((m) => {
                    const self = m.user_id === me?.id;
                    const isOwner = m.role === "owner";
                    // owner 行后端拒删；manage 角色可移除他人，普通成员只能退出自己
                    const canRemove = !isOwner && (canManage || self);
                    return (
                      <TableRow key={m.user_id} data-testid={`member-row-${m.user_id}`}>
                        <TableCell className="font-medium">
                          <span className="break-all">{m.email}</span>
                          {self && (
                            <span className="ml-2 text-xs text-[var(--muted-foreground)]">
                              {t("workspace.you")}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              m.role === "owner" ? "default" : m.role === "admin" ? "success" : "muted"
                            }
                          >
                            {t(`workspace.role.${m.role}`)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-[var(--muted-foreground)]">
                          {formatDateTime(m.created_at)}
                        </TableCell>
                        <TableCell>
                          {canRemove && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setRemoveTarget(m)}
                              aria-label={t("common.delete")}
                              data-testid={`member-remove-${m.user_id}`}
                            >
                              {self ? <LogOut className="size-4" /> : <Trash2 className="size-4" />}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
          {!isPersonal && !canManage && (
            <p className="mt-3 text-xs text-[var(--muted-foreground)]">{t("workspace.readOnlyHint")}</p>
          )}
        </CardContent>
      </Card>

      {currentId !== null && (
        <InviteMemberDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          workspaceId={currentId}
          onInvited={() => void load()}
        />
      )}

      <Dialog open={!!removeTarget} onOpenChange={(v) => !v && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {removeTarget?.user_id === me?.id ? t("workspace.leave") : t("common.delete")}
            </DialogTitle>
            <DialogDescription>
              {removeTarget?.user_id === me?.id
                ? t("workspace.leaveConfirm")
                : `${t("workspace.removeConfirm")}${removeTarget?.email ?? ""}？`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={onRemove} data-testid="member-remove-confirm">
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
