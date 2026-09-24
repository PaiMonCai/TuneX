"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Building, Check, ChevronsUpDown, CircleUser, Plus, Settings } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input, Label } from "@/components/ui/input";
import { useI18n } from "@/components/providers";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { cn } from "@/lib/utils";

/**
 * 工作空间切换器（挂在顶栏）。
 *
 * 交互：下拉列出当前用户可访问的全部 workspace；选中即更新 `x-workspace-id`
 * （内存请求头 + cookie）并 `router.refresh()`，让 dashboard / tunnels 等页面
 * 按新作用域重新取数。个人空间由后端注册时自动创建，这里不可删除。
 *
 * 「管理工作空间」跳转到 /settings/workspace（成员 + 邀请），个人空间同样可查看成员（仅自己）。
 */
export function WorkspaceSwitcher() {
  const { t } = useI18n();
  const router = useRouter();
  const { workspaces, current, loading, select } = useWorkspace();
  const [createOpen, setCreateOpen] = useState(false);

  function onSelect(id: number) {
    if (current?.id === id) return;
    select(id);
    // 请求头/cookie 已在 provider 的 effect 里同步；刷新让服务端组件与 Suspense 边界重新取数
    router.refresh();
  }

  // 列表为空（未登录 / 尚未拉回）时不渲染占位，避免登录页出现空壳
  if (!loading && workspaces.length === 0) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="max-w-[13rem] gap-1.5"
            data-testid="workspace-switcher"
            aria-label={t("workspace.switch")}
          >
            {current?.kind === "team" ? (
              <Building className="size-3.5 shrink-0 opacity-70" />
            ) : (
              <CircleUser className="size-3.5 shrink-0 opacity-70" />
            )}
            <span className="truncate" data-testid="workspace-current-name">
              {current?.name ?? t("common.loading")}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>{t("workspace.switch")}</DropdownMenuLabel>
          {workspaces.map((w) => (
            <DropdownMenuItem
              key={w.id}
              onSelect={() => onSelect(w.id)}
              className="gap-2"
              data-testid={`workspace-option-${w.id}`}
            >
              {w.kind === "team" ? (
                <Building className="size-4 shrink-0 opacity-70" />
              ) : (
                <CircleUser className="size-4 shrink-0 opacity-70" />
              )}
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              {w.role !== "owner" && <Badge variant="muted">{t(`workspace.role.${w.role}`)}</Badge>}
              {current?.id === w.id && <Check className="size-4 shrink-0 text-[var(--primary)]" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreateOpen(true)} data-testid="workspace-create-open">
            <Plus className="size-4" />
            {t("workspace.create")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => router.push("/settings/workspace")} data-testid="workspace-manage-link">
            <Settings className="size-4" />
            {t("workspace.manage")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

/**
 * 创建团队空间对话框。个人空间由后端注册时自动创建，这里只能建 team。
 * 校验与后端 zod 对齐：trim 后 1–120 字符。
 */
export function CreateWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const { createTeam } = useWorkspace();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);

  const trimmed = name.trim();
  const invalid = !trimmed || trimmed.length > 120;

  async function submit() {
    if (invalid || pending) return;
    setPending(true);
    try {
      const created = await createTeam(trimmed);
      if (created) {
        setName("");
        onOpenChange(false);
        router.refresh();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="workspace-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("workspace.create")}</DialogTitle>
          <DialogDescription>{t("workspace.createDesc")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label>{t("common.name")}</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder={t("workspace.namePlaceholder")}
            maxLength={120}
            data-testid="workspace-create-name"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            className={cn(invalid && "pointer-events-none")}
            onClick={submit}
            disabled={invalid || pending}
            data-testid="workspace-create-submit"
          >
            <Plus className="size-4" />
            {t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
