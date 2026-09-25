"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Loader2, RefreshCw, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { formatDateTime } from "@/lib/utils";
import type { ID, Node, NodeCredentialIssued } from "@/lib/types";

/** 凭据展示态：unknown = 后端未给出派生字段（旧契约），按「未签到」处理但不明说有 */
export type CredentialView = "none" | "valid" | "revoked";

function viewOf(node: Node): CredentialView {
  if (node.credential_revoked) return "revoked";
  if (node.has_credential) return "valid";
  return "none";
}

/**
 * 复制到剪贴板：优先 navigator.clipboard，失败时回落到 execCommand。
 * 凭据明文只此一次可见，复制失败必须给用户明确的兜底路径（手动选择文本）。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 走回落分支 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export interface NodeCredentialPanelProps {
  /** 节点主键（数字 id）。credential 端点的 :id 同时接受数字主键与字符串 node_id */
  nodeId: ID;
  /** 节点标识（展示用） */
  nodeKey: string;
  /** 当前凭据状态快照；操作成功后由父组件刷新后的新节点替换 */
  node: Node;
  /** 节点变更后回调（旋转/撤销成功后父组件重新拉取详情，派生字段才会更新） */
  onNodeChanged?: (node: Node) => void;
}

/**
 * 节点凭据面板（WP12 / WP7）：
 *   状态灯 + 轮换/撤销按钮 + 一次性明文弹窗。
 *
 * 三条不变量写死在交互里：
 *   1. **未知状态 → 后拉详情**：派生字段（has_credential/revoked）缺失时不猜，
 *      显示「状态未知」并提供刷新（init 详情接口补齐）。
 *   2. **明文绝不入 state 之外的存储**：仅 React state，弹窗关闭即从内存消失；
 *      不写 localStorage、不进 URL、不进 toast 正文（toast 只说「已签发」）。
 *   3. **签发 vs 轮换分流**：未签发 → 只有「签发」；已签发 → 只有「轮换 + 撤销」。
 *      （后端 issue 对已持有有效凭据的节点返回 409，UI 提前分流避免误点导致
 *      线上 Agent 静默失联的困惑。）
 */
export function NodeCredentialPanel({ nodeId, nodeKey, node, onNodeChanged }: NodeCredentialPanelProps) {
  const { t } = useI18n();
  const view = viewOf(node);
  const [pending, setPending] = useState<"issue" | "rotate" | "revoke" | null>(null);
  const [confirming, setConfirming] = useState<"issue" | "rotate" | "revoke" | null>(null);
  const [issued, setIssued] = useState<NodeCredentialIssued | null>(null);
  const [copied, setCopied] = useState(false);

  async function run(action: "issue" | "rotate" | "revoke") {
    setPending(action);
    try {
      if (action === "revoke") {
        const res = await api.admin.revokeNodeCredential(nodeId);
        toast.success(t("admin.credentialRevokedOk", { name: res.node_key || nodeKey }));
        onNodeChanged?.({ ...node, credential_revoked: true, has_credential: true });
        return;
      }
      const res = action === "issue" ? await api.admin.issueNodeCredential(nodeId) : await api.admin.rotateNodeCredential(nodeId);
      setIssued(res);
      setCopied(false);
      toast.success(action === "issue" ? t("admin.credentialIssued") : t("admin.credentialRotated"));
      onNodeChanged?.({
        ...node,
        has_credential: true,
        credential_revoked: false,
        credential_rotated_at: res.rotated_at ?? res.issued_at ?? new Date().toISOString(),
        // 重新签发/轮换 = 新一轮：清掉上次的 rejected 时间戳（与后端语义对齐）
        credential_last_rejected_at: null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("admin.credentialFailed");
      // 429 = 凭据写限流（60s/5 次 user 维度）。给出可操作文案而不是裸错误串。
      const status = (e as { status?: number })?.status;
      toast.error(status === 429 ? t("admin.credentialRateLimited") : msg);
    } finally {
      setPending(null);
      setConfirming(null);
    }
  }

  async function copy() {
    if (!issued) return;
    const ok = await copyText(issued.credential);
    if (ok) {
      setCopied(true);
      toast.success(t("admin.credentialCopied"));
    } else {
      toast.error(t("admin.credentialCopyFailed"));
    }
  }

  const badge =
    view === "valid" ? (
      <Badge variant="success" data-testid="credential-badge">
        <ShieldCheck className="mr-1 size-3" />
        {t("admin.credentialValid")}
      </Badge>
    ) : view === "revoked" ? (
      <Badge variant="destructive" data-testid="credential-badge">
        <ShieldOff className="mr-1 size-3" />
        {t("admin.credentialRevoked")}
      </Badge>
    ) : (
      <Badge variant="muted" data-testid="credential-badge">
        <ShieldAlert className="mr-1 size-3" />
        {t("admin.credentialNone")}
      </Badge>
    );

  return (
    <Card data-testid="node-credential-panel">
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            {t("admin.credential")}
          </CardTitle>
          <CardDescription>{t("admin.credentialHint")}</CardDescription>
        </div>
        {badge}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-[var(--muted-foreground)]">{t("admin.credentialRotatedAt")}</dt>
            <dd className="text-sm">{formatDateTime(node.credential_rotated_at)}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted-foreground)]">{t("admin.credentialLastRejected")}</dt>
            <dd className="text-sm">
              {node.credential_last_rejected_at
                ? formatDateTime(node.credential_last_rejected_at)
                : t("admin.credentialNever")}
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          {view === "none" ? (
            <Button
              size="sm"
              onClick={() => setConfirming("issue")}
              disabled={pending !== null}
              data-testid="credential-issue-btn"
            >
              {pending === "issue" ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              {t("admin.credentialIssue")}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => setConfirming("rotate")}
                disabled={pending !== null}
                data-testid="credential-rotate-btn"
              >
                {pending === "rotate" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                {t("admin.credentialRotate")}
              </Button>
              {view === "valid" ? (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setConfirming("revoke")}
                  disabled={pending !== null}
                  data-testid="credential-revoke-btn"
                >
                  {pending === "revoke" ? <Loader2 className="size-4 animate-spin" /> : <ShieldOff className="size-4" />}
                  {t("admin.credentialRevoke")}
                </Button>
              ) : null}
            </>
          )}
        </div>

        {/* 确认弹窗：三个动作各自的后果都写清楚（轮换 = 旧 Agent 掉线等） */}
        <Dialog open={confirming !== null} onOpenChange={(v) => !v && setConfirming(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {confirming === "issue"
                  ? t("admin.credentialIssue")
                  : confirming === "rotate"
                    ? t("admin.credentialRotate")
                    : t("admin.credentialRevoke")}
              </DialogTitle>
              <DialogDescription>
                {confirming === "issue"
                  ? t("admin.credentialIssueConfirm", { name: nodeKey })
                  : confirming === "rotate"
                    ? t("admin.credentialRotateConfirm", { name: nodeKey })
                    : t("admin.credentialRevokeConfirm", { name: nodeKey })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(null)} disabled={pending !== null}>
                {t("common.cancel")}
              </Button>
              <Button
                variant={confirming === "revoke" ? "destructive" : "default"}
                onClick={() => confirming && run(confirming)}
                disabled={pending !== null}
                data-testid="credential-confirm-btn"
              >
                {pending && <Loader2 className="size-4 animate-spin" />}
                {t("common.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 一次性明文：关窗即失。刻意不做持久化，也刻意不进 toast 正文 */}
        <Dialog open={issued !== null} onOpenChange={(v) => !v && setIssued(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {issued?.rotated_at ? t("admin.credentialRotated") : t("admin.credentialIssued")}
              </DialogTitle>
              <DialogDescription>{t("admin.credentialDismissHint")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <span className="text-xs text-[var(--muted-foreground)]">{t("admin.credentialCopy")}</span>
              <div className="flex items-center gap-2">
                <code
                  className="min-w-0 flex-1 break-all rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] p-2 font-mono text-xs"
                  data-testid="credential-plaintext"
                >
                  {issued?.credential}
                </code>
                <Button size="icon" variant="outline" onClick={copy} aria-label={t("admin.credentialCopy")} data-testid="credential-copy-btn">
                  {copied ? <Check className="size-4 text-[var(--success)]" /> : <Copy className="size-4" />}
                </Button>
              </div>
              <div className="mt-2 flex flex-col gap-1">
                <span className="text-xs text-[var(--muted-foreground)]">{t("admin.credentialAgentCmd")}</span>
                <code className="break-all rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] p-2 font-mono text-xs">
                  tunex-agent --node-credential=&lt;{t("admin.credentialCopy")}&gt;
                </code>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => setIssued(null)} data-testid="credential-dismiss-btn">
                {t("common.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
