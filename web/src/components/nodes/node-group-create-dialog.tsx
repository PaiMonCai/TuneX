"use client";

/**
 * R2 First-run —— 最小「自建入口节点组」对话框。
 *
 * ── 为什么需要它 ──
 * 默认免费策略（`free_personal` / `free_team`）**允许**工作空间自建入口组，
 * 用户域 `POST /api/node-groups` 也早就存在；缺的只是一个入口。在此之前，无组的
 * 用户在 `/nodes` 只能读到「本页暂无入口」——那是一次死路。
 *
 * ── 为什么坚持让用户自己填名称与端口范围 ──
 * 组名与端口区间是**用户资源的事实**：自动生成名字会让用户在节点列表里认不出
 * 自己的组；端口区间决定组内节点能用哪些监听端口（缺了它之后 provision 会
 * 409 `PORT_RANGE_REQUIRED`）。所以名称必填、区间必填且校验（格式 / 1..65535 /
 * `start <= end`），方向固定为入口（本切片只开放入口组）。
 *
 * ── 组凭据（token）为什么不出现在这里 ──
 * 后端建组响应带一次性组凭据 `token`。它由 `api.nodeGroups.create` 的投影
 * （`projectCreatedNodeGroup`）当场丢掉，本组件拿到的类型里根本没有这个字段，
 * 因此不存在「渲染出来 / 存进 state / 打进日志」的路径。
 *
 * ── 错误分支必须精确 ──
 * `403 custom_group_not_allowed` = 能力未开通（不是超额、也不是用户填错）：
 * 展示后端原文 + 下一步，并且**不再提供提交按钮**（再点一次必然同样失败）；
 * `403 node_limit` = 真实额度耗尽；`409 / 400` = 后端给的对应原因。
 * 原因一律用后端原文，本组件只补「下一步」那句话。
 */
import { useState } from "react";
import { toast } from "sonner";
import { useI18n } from "@/components/providers";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import { type WorkspaceCapabilities } from "@/lib/api/capabilities";
import { nodeGroupApiErrorInfo, type CreatedNodeGroup } from "@/lib/api/nodeGroups";
import { firstRunQuotaText } from "@/lib/first-run";

/* ================================================================== */
/* 纯校验（行为测试直接调这些函数）                                      */
/* ================================================================== */

export const NODE_GROUP_NAME_MAX = 60;

export type NodeGroupNameError = "required" | "too_long";
export type PortRangeError = "required" | "format" | "bounds" | "order";

export const NODE_GROUP_NAME_ERROR_KEYS: Record<NodeGroupNameError, string> = {
  required: "node.groupCreateNameRequired",
  too_long: "node.groupCreateNameTooLong",
};

export const PORT_RANGE_ERROR_KEYS: Record<PortRangeError, string> = {
  required: "node.groupCreatePortRequired",
  format: "node.groupCreatePortFormat",
  bounds: "node.groupCreatePortBounds",
  order: "node.groupCreatePortOrder",
};

/** 组名校验：trim 后 1..60（与后端 zod 同口径）。 */
export function validateNodeGroupName(raw: string): NodeGroupNameError | null {
  const name = raw.trim();
  if (name === "") return "required";
  if (name.length > NODE_GROUP_NAME_MAX) return "too_long";
  return null;
}

/**
 * 端口区间解析：`start-end`（后端 schema 的正则是 `^\d{1,5}-\d{1,5}$`）。
 * 不合法返回 `null`，不做「猜一个区间」的容错。
 */
export function parsePortRange(raw: string): { start: number; end: number } | null {
  const m = /^(\d{1,5})-(\d{1,5})$/.exec(raw.trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]) };
}

/**
 * 端口区间校验：与后端 `POST /node-groups` 的边界一致
 * （`start >= 1`、`end <= 65535`、`start <= end`）。
 */
export function validatePortRange(raw: string): PortRangeError | null {
  const text = raw.trim();
  if (text === "") return "required";
  const parsed = parsePortRange(text);
  if (!parsed) return "format";
  if (parsed.start < 1 || parsed.end > 65535) return "bounds";
  if (parsed.start > parsed.end) return "order";
  return null;
}

/** 表单是否可以提交（按钮 disabled 的唯一依据）。 */
export function canSubmitNodeGroupForm(input: { name: string; portRange: string; pending: boolean }): boolean {
  if (input.pending) return false;
  return validateNodeGroupName(input.name) === null && validatePortRange(input.portRange) === null;
}

/* ================================================================== */
/* 对话框正文（纯展示；Radix Portal 在静态渲染下不产出 DOM，故单独导出）  */
/* ================================================================== */

export interface NodeGroupCreateFailure {
  /** 后端原文（`ApiError.message`）；没有可用文本时为 `null`。 */
  message: string | null;
  /** 该错误码对应的「下一步」词典键；`null` = 没有专门下一步。 */
  nextStepKey: string | null;
  /** 后端 code（用于可观测与测试断言，不直接渲染）。 */
  code: string | null;
}

export interface NodeGroupCreateDialogBodyProps {
  name: string;
  onNameChange: (value: string) => void;
  portRange: string;
  onPortRangeChange: (value: string) => void;
  /** 已提交过一次后才显示的就地校验错误。 */
  nameErrorKey: string | null;
  portRangeErrorKey: string | null;
  pending: boolean;
  failure: NodeGroupCreateFailure | null;
  /** 后端明确拒绝能力（未授权）：不再提供提交按钮。 */
  denied: boolean;
  /** 当前能力投影（可选）：只用于显示额度用量，`null` = 不显示（不知道就不说）。 */
  capabilities?: WorkspaceCapabilities | null;
  onCancel: () => void;
  onSubmit: () => void;
}

export function NodeGroupCreateDialogBody({
  name,
  onNameChange,
  portRange,
  onPortRangeChange,
  nameErrorKey,
  portRangeErrorKey,
  pending,
  failure,
  denied,
  capabilities = null,
  onCancel,
  onSubmit,
}: NodeGroupCreateDialogBodyProps) {
  const { t } = useI18n();
  const quota = firstRunQuotaText(t, capabilities);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("node.groupCreateTitle")}</DialogTitle>
        <DialogDescription>{t("node.groupCreateHint")}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="node-group-create-name">{t("node.groupCreateNameLabel")}</Label>
          <Input
            id="node-group-create-name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={t("node.groupCreateNamePlaceholder")}
            aria-invalid={nameErrorKey ? true : undefined}
            data-testid="node-group-create-name"
          />
          {nameErrorKey ? (
            <p className="text-xs text-[var(--destructive)]" data-testid="node-group-create-name-error">
              {t(nameErrorKey)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="node-group-create-port-range">{t("node.groupCreatePortLabel")}</Label>
          <Input
            id="node-group-create-port-range"
            value={portRange}
            onChange={(e) => onPortRangeChange(e.target.value)}
            placeholder="20000-20100"
            aria-invalid={portRangeErrorKey ? true : undefined}
            data-testid="node-group-create-port-range"
          />
          <p className="text-xs text-[var(--muted-foreground)]">{t("node.groupCreatePortHint")}</p>
          {portRangeErrorKey ? (
            <p className="text-xs text-[var(--destructive)]" data-testid="node-group-create-port-error">
              {t(portRangeErrorKey)}
            </p>
          ) : null}
        </div>
        {/* 方向固定入口：说清，而不是给一个没有第二种选择的下拉框。 */}
        <p className="text-xs text-[var(--muted-foreground)]" data-testid="node-group-create-direction">
          {t("node.groupCreateDirectionIngress")}
        </p>
        {quota ? (
          <p className="text-xs text-[var(--muted-foreground)]" data-testid="node-group-create-quota">
            {quota}
          </p>
        ) : null}
        {failure ? (
          <div
            className="flex flex-col gap-1 rounded-[var(--radius)] border border-[var(--destructive)] p-3"
            role="alert"
            data-testid="node-group-create-error"
            data-code={failure.code ?? "unknown"}
          >
            <p className="text-sm">{failure.message ?? t("node.groupCreateFailed")}</p>
            {failure.nextStepKey ? (
              <p className="text-xs text-[var(--muted-foreground)]" data-testid="node-group-create-error-next">
                {t(failure.nextStepKey)}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} data-testid="node-group-create-cancel">
          {t("common.cancel")}
        </Button>
        {denied ? null : (
          <Button onClick={onSubmit} disabled={pending} data-testid="node-group-create-submit">
            {pending ? t("node.groupCreating") : t("node.groupCreateSubmit")}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/* ================================================================== */
/* 状态容器                                                            */
/* ================================================================== */

export function NodeGroupCreateDialog({
  open,
  onOpenChange,
  onCreated,
  capabilities,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 建组成功；只回投影后的组（**没有** token）。父级据此刷新组列表。 */
  onCreated: (group: CreatedNodeGroup) => void;
  capabilities?: WorkspaceCapabilities | null;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [portRange, setPortRange] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<NodeGroupCreateFailure | null>(null);

  const nameError = validateNodeGroupName(name);
  const portError = validatePortRange(portRange);
  const denied = failure?.code === "custom_group_not_allowed";

  function reset() {
    setName("");
    setPortRange("");
    setSubmitted(false);
    setPending(false);
    setFailure(null);
  }

  async function submit() {
    setSubmitted(true);
    if (validateNodeGroupName(name) !== null || validatePortRange(portRange) !== null) return;
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const created = await api.nodeGroups.create({
        name: name.trim(),
        node_type: "in",
        port_range: portRange.trim(),
      });
      // 投影后的组只有 id / name / node_type：组凭据（token）不存在于这条路径上。
      toast.success(t("node.groupCreateSuccess"));
      reset();
      onOpenChange(false);
      onCreated(created);
    } catch (error) {
      const info = nodeGroupApiErrorInfo(error);
      setFailure({ message: info.message, nextStepKey: info.nextStepKey, code: info.code });
      // 能力未开通：提交按钮在下一次渲染里消失，不再让用户撞同一堵墙。
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="node-group-create-dialog">
        <NodeGroupCreateDialogBody
          name={name}
          onNameChange={setName}
          portRange={portRange}
          onPortRangeChange={setPortRange}
          nameErrorKey={submitted && nameError ? NODE_GROUP_NAME_ERROR_KEYS[nameError] : null}
          portRangeErrorKey={submitted && portError ? PORT_RANGE_ERROR_KEYS[portError] : null}
          pending={pending}
          failure={failure}
          denied={denied}
          capabilities={capabilities}
          onCancel={() => onOpenChange(false)}
          onSubmit={() => void submit()}
        />
      </DialogContent>
    </Dialog>
  );
}
