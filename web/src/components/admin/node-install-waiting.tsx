"use client";

/**
 * V4-WP7 §13.4.3 —— 安装等待闭环。
 *
 * 「一键安装」的体验缺口不是「生成命令」，而是**存完命令就再也没有下文**：
 * 用户不知道自己装成功没有。本组件补齐闭环：
 *
 *   waiting ──(生成/重开 enrollment)──▶ 轮询 lifecycle.connection
 *        ├─ online            → 闭环达成（停止轮询）
 *        ├─ offline 且有凭据   → 「已安装但掉线」（连接问题，**不是**安装问题）
 *        └─ 超时              → 提示可继续等待，不谎报成功
 *
 * ── 为什么不自己判在线 ──
 * 终止条件只看后端 `NodeLifecycleView.connection`（`deriveConnection` 的
 * 90s 窗口口径）。前端另写一个「最近上报时间 + 阈值」的判定就会与面板其它
 * 位置（列表、健康卡）给出不同结论——同一页面上「在线」和「不在线」并存是
 * 最伤信任的 bug。
 *
 * ── 为什么轮询而不是 WebSocket ──
 * 这一次性交互只持续几分钟，且面板已有全局 `/admin/node/health` 轮询先例；
 * 为它开一条 socket 通道会在 WP8/WP9 的规模工作之前引入新的连接生命周期。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Copy, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { installClosureReached, installPhase } from "@/lib/node-lifecycle";
import { nodeLifecycleText } from "@/lib/node-lifecycle-i18n";
import type { ID, NodeEnrollmentIssued, NodeLifecycleView } from "@/lib/types";

/** 轮询节奏：安装通常要几十秒到几分钟，10s 一次足够且不会打满限流。 */
export const INSTALL_POLL_INTERVAL_MS = 10_000;
/** 最长等待窗口（30 分钟）；超时后停轮询但保留命令与手动重试。 */
export const INSTALL_POLL_MAX_MS = 30 * 60 * 1000;

export interface NodeInstallWaitingProps {
  nodeId: ID;
  /** 当前生命周期视图（父组件持有；本组件只读它的 connection）。 */
  view: NodeLifecycleView | null;
  /** 视图变化回传（父组件据此更新 badges 与依赖预览）。 */
  onViewChange?: (view: NodeLifecycleView) => void;
  /**
   * 已生成的安装命令（列表页「创建节点」流程已经签发过一次）。
   *
   * 传入即**不再重新生成**：重复生成会撤销上一个尚未使用的 enrollment——
   * 用户刚复制过的命令会当场失效。只有用户主动点「重新生成」时才签发新的。
   */
  initialEnrollment?: NodeEnrollmentIssued | null;
  /** 打开态（父组件控制）。 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开时是否自动开始轮询（新创建节点的流程用 true）。 */
  autoStart?: boolean;
}

/**
 * 生成一次性安装命令。
 *
 * 与 WP7 已合并的后端契约一致：`POST /api/admin/node/:id/enrollment`
 * 返回 `{ install_command, expires_at, ... }`，且**会撤销尚未使用的旧
 * enrollment**（因此重开命令是安全的，不会留下两个可用令牌）。
 */
export function NodeInstallWaiting({
  nodeId,
  view,
  onViewChange,
  initialEnrollment = null,
  open,
  onOpenChange,
  autoStart = false,
}: NodeInstallWaitingProps) {
  const { locale } = useI18n();
  const txt = nodeLifecycleText(locale);
  const [enrollment, setEnrollment] = useState<NodeEnrollmentIssued | null>(initialEnrollment);
  const [generating, setGenerating] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const startedAt = useRef<number>(0);

  const phase = installPhase(view);
  const closed = installClosureReached(phase);

  // 传入的命令（新建节点流程）接管状态；不自动重签。
  useEffect(() => {
    if (initialEnrollment) setEnrollment(initialEnrollment);
  }, [initialEnrollment]);

  /**
   * 自动开始等待：只要节点确实还在等待安装就轮询。
   *
   * 刻意**不**依赖 `enrollment`：轮询读的是节点的 connection，与「本地有没有
   * 存着命令」无关。把两者绑在一起会让「在别的终端里已经装好了」这种情况永远
   * 等不到更新——那正是本期要消灭的体验缺口。
   */
  useEffect(() => {
    if (!autoStart || closed) return;
    if (phase !== "awaiting_install") return;
    startedAt.current = Date.now();
    setWaiting(true);
  }, [autoStart, closed, phase]);

  /** 生成新命令并把轮询打开。 */
  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const issued = await api.admin.createNodeEnrollment(nodeId);
      setEnrollment(issued);
      setTimedOut(false);
      startedAt.current = Date.now();
      setWaiting(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : txt.installCommandHint);
    } finally {
      setGenerating(false);
    }
  }, [nodeId, txt.installCommandHint]);

  /**
   * 轮询到闭环。
   *
   * 终止条件三条：已在线 / 已超时 / 用户显式停止。**不**在 offline 时停：
   * 「已安装但掉线」说明安装已完成，但连接可能立刻恢复，继续等才有意义；
   * 界面文案已经区分这两种情况。
   *
   * 也**不**在关闭对话框时停：命令对话框只是查看命令的入口，等待本身是页面级
   * 的状态（横幅上一直显示阶段）。关掉对话框就停止等待，等于又回到「复制完就
   * 没有下文」——正是本期要修的缺口。
   */
  useEffect(() => {
    if (!waiting || closed) return;
    const timer = setInterval(() => {
      if (Date.now() - startedAt.current > INSTALL_POLL_MAX_MS) {
        setWaiting(false);
        setTimedOut(true);
        return;
      }
      void api.admin
        .nodeLifecycle(nodeId)
        .then((next) => {
          onViewChange?.(next);
          if (installClosureReached(installPhase(next))) setWaiting(false);
        })
        // 取数失败不停轮询：节点刚上线时后端可能瞬时不可用，
        // 静默跳过这一轮比中断等待更符合用户预期。
        .catch(() => undefined);
    }, INSTALL_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [waiting, closed, nodeId, onViewChange]);

  async function copyCommand() {
    if (!enrollment) return;
    try {
      await navigator.clipboard.writeText(enrollment.install_command);
      toast.success(txt.installCopied);
    } catch {
      // 剪贴板被拒（非安全上下文）：命令已在对话框里可手动选中，
      // 不把环境限制报成操作失败。
    }
  }

  return (
    <>
      {/* 横幅：详情页里持续展示安装阶段，点开即生成/重开命令 */}
      <div className="flex flex-wrap items-center gap-2" data-testid="node-install-waiting">
        <Badge
          variant={closed ? "success" : phase === "installed_offline" ? "outline" : "muted"}
          data-testid="node-install-phase"
        >
          {txt.installPhase[phase]}
        </Badge>
        <span className="text-xs text-[var(--muted-foreground)]" data-testid="node-install-phase-hint">
          {txt.installPhaseHint[phase]}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => {
            onOpenChange(true);
            if (!enrollment) void generate();
          }}
          disabled={generating}
          data-testid="node-install-open"
        >
          {generating ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {txt.installReopen}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{txt.installCommandTitle}</DialogTitle>
            <DialogDescription>{txt.installCommandHint}</DialogDescription>
          </DialogHeader>
          {enrollment ? (
            <div
              className="rounded-md border border-[var(--border)] bg-[var(--muted)] p-3 font-mono text-xs break-all"
              data-testid="node-install-command"
            >
              {enrollment.install_command}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
              {generating ? <Loader2 className="size-4 animate-spin" /> : null}
              <span>{generating ? txt.loading : txt.installWaitingHint}</span>
            </div>
          )}

          {/* 等待闭环状态：这是本组件与旧「复制完就关」流程的唯一区别 */}
          <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] p-2.5">
            {closed ? (
              <span className="text-xs text-[var(--muted-foreground)]" data-testid="node-install-closed">
                {txt.installPhaseHint.online}
              </span>
            ) : waiting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                <span className="text-xs" data-testid="node-install-waiting-state">
                  {txt.installWaiting}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => setWaiting(false)}
                  data-testid="node-install-stop"
                >
                  {txt.installPollStop}
                </Button>
              </>
            ) : (
              <>
                <span className="text-xs text-[var(--muted-foreground)]">
                  {timedOut ? txt.installWaitingHint : txt.installPhaseHint[phase]}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => {
                    setTimedOut(false);
                    startedAt.current = Date.now();
                    setWaiting(true);
                  }}
                  data-testid="node-install-retry"
                >
                  {txt.retry}
                </Button>
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {txt.installClose}
            </Button>
            <Button onClick={copyCommand} disabled={!enrollment} data-testid="node-install-copy">
              <Copy className="size-4" />
              {txt.installCopy}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
