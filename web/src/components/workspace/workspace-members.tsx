"use client";

import { useEffect, useState } from "react";
import { LogOut, RefreshCw, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { InviteMemberDialog } from "@/components/workspace/invite-member-dialog";
import { formatDateTime } from "@/lib/utils";
import type { WorkspaceMember, WorkspaceRole } from "@/lib/types";

/**
 * 工作空间管理页（成员列表 + 邀请 + 移除）。
 *
 * 权限（与后端一致）：
 *   - GET    /:id/members：任一 active 成员可读（个人空间就是自己）；
 *   - POST   /:id/invites：kind==="team" 且 role∈{owner,admin}；
 *   - DELETE /:id/members/:userId：manage 角色，或 actor===target（退出）。
 *     owner 行不可移除（后端 403）。
 */
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
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <span className="truncate">{current?.name ?? t("common.loading")}</span>
              <Badge variant={isPersonal ? "outline" : "default"} data-testid="workspace-kind">
                {isPersonal ? t("workspace.kind.personal") : t("workspace.kind.team")}
              </Badge>
            </CardTitle>
            <CardDescription>
              {isPersonal ? t("workspace.personalHint") : t("workspace.teamHint")}
            </CardDescription>
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
