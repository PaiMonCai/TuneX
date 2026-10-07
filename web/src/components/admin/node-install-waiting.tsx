"use client";

/**
 * V4-WP7 §13.4.3 / I1-A —— 安装等待闭环（共享组件，管理端与用户端共用）。
 *
 * 「一键安装」的体验缺口不是「生成命令」，而是**存完命令就再也没有下文**：
 * 用户不知道自己装成功没有。本组件补齐闭环：
 *
 *   waiting ──(生成/重开 enrollment)──▶ 轮询 connection
 *        ├─ online            → 闭环达成（停止轮询 + 成功下一步 CTA）
 *        ├─ offline 且有凭据   → 「已安装但掉线」（连接问题，**不是**安装问题）
 *        ├─ 取数失败          → 明确「暂时取不到」并继续（不冒称成功）
 *        └─ 超时/手动停止       → 横幅与对话框都显示恢复入口，不谎报成功
 *
 * ── 为什么不自己判在线 ──
 * 终止条件只看服务端投影（`installPhase` / `installClosureReached`）。前端另写
 * 一个「最近上报时间 + 阈值」的判定会与面板其它位置给出不同结论。
 *
 * ── 数据源注入 ──
 * `loadView` / `createEnrollment` 显式注入：用户域必须传用户 API，缺省才是
 * 管理端 API。用户流程打 admin-only 接口是本组件最需要防住的越权路径，
 * 因此不做任何静默回落以外的猜测（重载 1 把缺省调用方的视图类型固定为
 * `NodeLifecycleView`，用户域必须走重载 2 并传 `loadView`）。
 *
 * ── 敏感命令（一次性注册令牌）──
 * 只存在于 React 内存状态；不写 localStorage、不进 URL、不进日志。命令的展示与
 * 复制都按「签发时的节点 + 作用域刻度」在渲染期过筛（见 {@link enrollmentBelongsToNode}
 * 与组件内的 `scope.seq`）：切节点/切 Workspace 的那一次提交里，上一个节点的
 * 令牌绝不进 DOM，A→B→A 的旧签发响应也不会回填。
 *
 * ── 对话框正文/确认框正文为何单独导出 ──
 * Radix Portal 在静态渲染下不产出 DOM；拆成纯展示组件后，「有效期/过期/取数
 * 失败/闭环 CTA/重签后果/在线令牌提示」都能被真实渲染测试钉住。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { toast } from "sonner";
import { Copy, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { formatDateTime } from "@/lib/utils";
import { installClosureReached, installPhase, type InstallPhase } from "@/lib/node-lifecycle";
import { nodeLifecycleText } from "@/lib/node-lifecycle-i18n";
import {
  INSTALL_POLL_INTERVAL_MS,
  INSTALL_POLL_MAX_MS,
  NodeInstallPoller,
  type NodeInstallView,
} from "@/lib/node-install-polling";
import type { ID, NodeEnrollmentIssued, NodeLifecycleView } from "@/lib/types";

/** 轮询节奏与最长等待窗口（定义在轮询库里，这里原样转出，旧调用方不受影响）。 */
export { INSTALL_POLL_INTERVAL_MS, INSTALL_POLL_MAX_MS };

/** 过期展示的本地时钟：最多 30s 走一格，足够「留页过期」及时可见且几乎无成本。 */
const TTL_CLOCK_MAX_DELAY_MS = 30_000;

/** 默认数据源 = 管理员 API（只对「没显式传 loadView」的管理端调用方生效）。 */
function defaultAdminLoadView(nodeId: ID) {
  return api.admin.nodeLifecycle(nodeId);
}

/** 默认签发命令 = 管理员 API（同上）。 */
function defaultAdminCreateEnrollment(nodeId: ID) {
  return api.admin.createNodeEnrollment(nodeId);
}

/**
 * 命令是否属于当前节点。
 *
 * `node_id` 缺失时不因此吞掉命令（老后端兼容）；「缺 node_id 的命令属于谁」由
 * 组件在内存里记的**签发请求节点**决定，见 {@link NodeInstallWaiting} 内的
 * `issued.nodeId`。
 */
export function enrollmentBelongsToNode(issued: NodeEnrollmentIssued | null | undefined, nodeId: ID): boolean {
  if (!issued) return false;
  const owner = (issued as { node_id?: ID | null }).node_id;
  if (owner === undefined || owner === null) return true;
  return Number(owner) === Number(nodeId);
}

/** 命令是否已过期（只做展示派生：判定用的是服务端 `expires_at`）。 */
export function installCommandExpired(expiresAt: string | null | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= now;
}

export interface NodeInstallWaitingProps<TView extends NodeInstallView = NodeLifecycleView> {
  /**
   * 目标节点。
   *
   * 用户域建议再加 `key`（例如 `key={`${scopeKey}:${nodeId}`}`）：key 变化即整实例
   * 重挂载，作用域泄漏面更小。组件自身也保证跨节点的命令与晚到响应一律不生效。
   */
  nodeId: ID;
  /** 当前生命周期视图（本组件只读它的 connection / has_credential）。 */
  view: TView | null;
  /** 视图变化回传（父组件据此更新 badges 与依赖预览），保留调用方的具体视图类型。 */
  onViewChange?: (view: TView) => void;
  /**
   * 已生成的安装命令（新建节点流程已经签发过一次）。
   *
   * 传入即**不再重新生成**：重复生成会撤销上一个尚未使用的 enrollment——
   * 用户刚复制过的命令会当场失效。只有用户主动重签时才签发新的。
   */
  initialEnrollment?: NodeEnrollmentIssued | null;
  /** 打开态（父组件控制）。关闭对话框**不**停止等待。 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 打开时是否自动开始等待（新创建节点/详情页用 true）。
   *
   * 自动开始的条件：`phase === "awaiting_install"`，或 `phase === "unknown"` 且
   * 手里确有一条命令。`unknown` 也等是因为**轮询正是把未知变成已知的唯一手段**
   * （production provision 的窄响应没有 connection）；但绝不能因此合成
   * waiting/online，阶段徽章始终显示服务端给的事实。每个作用域只自动开始一次：
   * 用户手动停止后不会自己复活。
   */
  autoStart?: boolean;
  /** 自定义取数（用户域必传；默认管理端 `GET /admin/node/:id/lifecycle`）。 */
  loadView?: (nodeId: ID) => Promise<TView>;
  /** 自定义签发命令（用户域必传；默认管理端 `POST /admin/node/:id/enrollment`）。 */
  createEnrollment?: (nodeId: ID) => Promise<NodeEnrollmentIssued>;
  /** 闭环达成后的下一步（只在服务端投影为 online 时渲染；权限判断由调用方完成）。 */
  successAction?: ReactNode;
  /**
   * 非空时，重新生成命令前先弹可访问确认框，内容由调用方提供
   * （用户域传安全的中/英文提示：旧未用命令立即失效、已注册节点重装会轮换凭据）。
   * 给了它就**所有**生成入口都走同一确认框，包括横幅上的重开按钮。
   */
  regenerateConfirm?: string;
  /** 打开命令入口的按钮文案；不传时沿用共享词条（管理端默认词条不变）。 */
  openLabel?: string;
}

/** 内存里的「谁签发的」记录：作用域刻度 + 请求节点 + 命令本体。 */
interface IssuedCommand {
  seq: number;
  nodeId: ID;
  enrollment: NodeEnrollmentIssued;
}

/**
 * 生成一次性安装命令。
 *
 * 与后端契约一致：`POST .../enrollment` 返回 `{ install_command, expires_at, ... }`，
 * 且**会撤销尚未使用的旧 enrollment**（因此重签不会留下两个可用令牌）。
 */
export function NodeInstallWaiting(props: NodeInstallWaitingProps<NodeLifecycleView>): ReactElement;
/** 自定义数据源（用户域）：必须显式传 `loadView`，视图类型随调用方。 */
export function NodeInstallWaiting<TView extends NodeInstallView>(
  props: NodeInstallWaitingProps<TView> & { loadView: (nodeId: ID) => Promise<TView> },
): ReactElement;
export function NodeInstallWaiting<TView extends NodeInstallView>(
  props: NodeInstallWaitingProps<TView>,
): ReactElement {
  const {
    nodeId,
    view,
    initialEnrollment = null,
    open,
    onOpenChange,
    autoStart = false,
    successAction,
    regenerateConfirm,
    openLabel,
  } = props;
  const { locale } = useI18n();
  const txt = nodeLifecycleText(locale);

  /**
   * 作用域刻度：`nodeId` 一变就 +1（渲染期调整 state，先于提交发生）。
   *
   * 这是「敏感命令不串台」的关键：命令状态带着签发时的 `seq`，渲染时要求
   * `issued.seq === scope.seq` **且** `scope.nodeId` 仍是当前节点。于是换节点的那
   * 一次提交里，上一个节点的令牌不可能进 DOM，A→B→A 的旧签发响应也不会回填。
   */
  const [scope, setScope] = useState({ nodeId, seq: 0 });
  if (Number(scope.nodeId) !== Number(nodeId)) setScope({ nodeId, seq: scope.seq + 1 });

  const [issued, setIssued] = useState<IssuedCommand | null>(() =>
    initialEnrollment && enrollmentBelongsToNode(initialEnrollment, nodeId)
      ? { seq: 0, nodeId, enrollment: initialEnrollment }
      : null,
  );
  const [generating, setGenerating] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  /** 用户主动停止等待：横幅与对话框都要如实说明并可重试。 */
  const [stoppedByUser, setStoppedByUser] = useState(false);
  /** 取数失败（可恢复）：只提示，不停轮询，也绝不冒称成功。 */
  const [pollFailed, setPollFailed] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  /** 过期展示用的本地时钟（不依赖轮询；停止/超时留页也会更新）。 */
  const [clockNow, setClockNow] = useState(() => Date.now());
  /** 手动「重试」的轮次计数：让等待中也能立刻重开一轮，而不是等下一个 10s。 */
  const [pollRound, setPollRound] = useState(0);

  const phase = installPhase(view);
  const closed = installClosureReached(phase);

  /** 渲染期过筛后的命令：只有「本作用域签发、且属于本节点」的才可展示/复制。 */
  const enrollment =
    issued &&
    issued.seq === scope.seq &&
    Number(scope.nodeId) === Number(nodeId) &&
    enrollmentBelongsToNode(issued.enrollment, nodeId)
      ? issued.enrollment
      : null;

  const generatingRef = useRef(false);
  const generateTicketRef = useRef(0);
  const mountedRef = useRef(true);
  const nodeIdRef = useRef(nodeId);
  const scopeSeqRef = useRef(scope.seq);
  /** `initialEnrollment` 这条命令出现在哪个作用域（缺 node_id 的老 shape 靠它绑定发行节点）。 */
  const initialScopeRef = useRef<{ key: string; seq: number } | null>(null);
  /** 自动开始是否已被消费（本作用域内）。用户显式停止/开始后不得再自动复活。 */
  const autoStartConsumedRef = useRef(false);

  /**
   * 最新回调/数据源的引用。
   *
   * 父组件常以内联箭头函数传 `onViewChange` / `loadView`，把它们放进轮询 effect
   * 依赖会让「取数成功 → 父组件 setState → 重渲染 → effect 重建」不断重启轮询，
   * 超时窗口被无限顺延。因此轮询 effect 只依赖 `[waiting, closed, nodeId]`，
   * 数据源与回调在每轮开始时从 ref 取最新值。
   */
  const latestRef = useRef({
    onViewChange: props.onViewChange,
    loadView: props.loadView,
    createEnrollment: props.createEnrollment,
  });
  useEffect(() => {
    latestRef.current = {
      onViewChange: props.onViewChange,
      loadView: props.loadView,
      createEnrollment: props.createEnrollment,
    };
  });
  useEffect(() => {
    nodeIdRef.current = nodeId;
    scopeSeqRef.current = scope.seq;
  }, [nodeId, scope.seq]);

  useEffect(() => {
    // 显式 effect replay（StrictMode 加固）：setup 必须把标记重置回 true，
    // 否则 replay 后 mountedRef 会永久为 false，之后所有响应都被丢弃。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 换节点/换作用域：丢弃上一个作用域的敏感命令与全部等待状态。 */
  const seenScopeSeqRef = useRef(scope.seq);
  useEffect(() => {
    if (seenScopeSeqRef.current === scope.seq) return; // 首次挂载：初始 state 已按作用域筛过
    seenScopeSeqRef.current = scope.seq;
    autoStartConsumedRef.current = false;
    generatingRef.current = false;
    setIssued(null);
    setGenerating(false);
    setWaiting(false);
    setTimedOut(false);
    setStoppedByUser(false);
    setPollFailed(false);
    setRegenerateOpen(false);
  }, [scope.seq]);

  // 传入的命令（新建节点流程）接管状态；不自动重签。
  useEffect(() => {
    if (!initialEnrollment) {
      initialScopeRef.current = null;
      return;
    }
    const owner = (initialEnrollment as { node_id?: ID | null }).node_id;
    /**
     * 命令的身份按**值**算，不按对象引用、也不带 expires_at：父组件每渲染一次就重建一个
     * 等价对象是常见写法，那不是「重新签发」。token 一次性且唯一，用它判断是不是另一条命令。
     */
    const key = String(initialEnrollment.token ?? initialEnrollment.install_command ?? "");
    const seen = initialScopeRef.current;
    if (!seen || seen.key !== key) initialScopeRef.current = { key, seq: scope.seq };
    // 缺 node_id 的老 shape 无法自证属于哪个节点：只在它「发行时的那个作用域」里采纳，
    // 否则同一个命令对象被父组件带到新节点时，A 的令牌会挂到 B 名下。
    if ((owner === undefined || owner === null) && initialScopeRef.current!.seq !== scope.seq) return;
    if (enrollmentBelongsToNode(initialEnrollment, nodeId)) {
      setIssued({ seq: scope.seq, nodeId, enrollment: initialEnrollment });
    }
  }, [initialEnrollment, nodeId, scope.seq]);

  /** 显式开始/重新开始等待（重试按钮、生成成功后）。 */
  const startWaiting = useCallback(() => {
    autoStartConsumedRef.current = true;
    setTimedOut(false);
    setStoppedByUser(false);
    setPollFailed(false);
    setWaiting(true);
  }, []);

  /** 用户主动停止：横幅与对话框都显示可恢复的说明。 */
  const stopWaiting = useCallback(() => {
    autoStartConsumedRef.current = true;
    setStoppedByUser(true);
    setWaiting(false);
  }, []);

  /** 手动重试：清掉失败/停止提示，并把轮询重开一轮（等待中也能立即再取一次）。 */
  const retryNow = useCallback(() => {
    setPollRound((round) => round + 1);
    startWaiting();
  }, [startWaiting]);

  /**
   * 自动开始等待：`awaiting_install`，或 `unknown` + 手里有命令。
   *
   * 刻意**不**依赖「本地存着命令才轮询」之外的条件，也不依赖对话框开合：
   * 等待是页面级状态，关掉对话框继续等（否则又回到「复制完没有下文」）。
   * 每个作用域只消费一次，用户停止后不会因 effect 重跑而复活。
   */
  const hasCommand = enrollment !== null;
  useEffect(() => {
    if (!autoStart || closed) return;
    if (autoStartConsumedRef.current) return;
    if (phase !== "awaiting_install" && !(phase === "unknown" && hasCommand)) return;
    startWaiting();
  }, [autoStart, closed, phase, hasCommand, scope.seq, startWaiting]);

  // 父组件从别处刷新到 online（不是本组件轮询发现的）时，同步收起等待态。
  useEffect(() => {
    if (!closed) return;
    setWaiting(false);
    setTimedOut(false);
    setStoppedByUser(false);
    setPollFailed(false);
  }, [closed]);

  /**
   * 过期展示的本地时钟。
   *
   * 只在「对话框开着 + 阶段是等待安装 + 命令有可解析的 expires_at」时走一步，
   * 走到截止点为止：停止轮询或超时后把对话框留在页面上，过期提示照样会出现。
   * 已 online / 已安装离线时不显示过期（见正文的 phase 判定），因此不需要走时。
   */
  const expiresAtMs = enrollment?.expires_at ? Date.parse(enrollment.expires_at) : Number.NaN;
  useEffect(() => {
    if (!open || phase !== "awaiting_install" || !enrollment || !Number.isFinite(expiresAtMs)) return;
    const nowMs = Date.now();
    if (expiresAtMs <= nowMs) {
      // 已经过期：把展示时钟推过一次截止点即可，之后不必再走时（重签会换新命令）。
      setClockNow((prev) => (prev < expiresAtMs ? nowMs : prev));
      return;
    }
    const delay = Math.min(Math.max(expiresAtMs - nowMs + 1, 1), TTL_CLOCK_MAX_DELAY_MS);
    const timer = setTimeout(() => setClockNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [open, phase, enrollment, expiresAtMs, clockNow]);

  /** 解析本轮要用的数据源：显式注入优先，缺省才是管理员 API。 */
  const resolveLoadView = useCallback((): ((nodeId: ID) => Promise<TView>) => {
    const custom = latestRef.current.loadView;
    if (custom) return custom;
    // 这里的断言只对「没传 loadView」的调用者成立，而重载 1 把这类调用者的
    // TView 固定为 NodeLifecycleView；用户域必须传 loadView，走不到这一行。
    return defaultAdminLoadView as unknown as (nodeId: ID) => Promise<TView>;
  }, []);

  /** 生成新命令并把轮询打开。 */
  const generate = useCallback(async () => {
    if (generatingRef.current) return;
    const requestedNode = nodeId;
    const requestedSeq = scopeSeqRef.current;
    const ticket = generateTicketRef.current + 1;
    generateTicketRef.current = ticket;
    generatingRef.current = true;
    setGenerating(true);
    try {
      const create = latestRef.current.createEnrollment ?? defaultAdminCreateEnrollment;
      const created = await create(requestedNode);
      // 晚到响应：卸载 / 节点已切走 / 作用域已换刻度（含 A→B→A）→ 一律不写回。
      if (
        !mountedRef.current ||
        generateTicketRef.current !== ticket ||
        nodeIdRef.current !== requestedNode ||
        scopeSeqRef.current !== requestedSeq
      ) {
        return;
      }
      if (!enrollmentBelongsToNode(created, requestedNode)) return;
      setIssued({ seq: requestedSeq, nodeId: requestedNode, enrollment: created });
      startWaiting();
    } catch (e) {
      if (
        !mountedRef.current ||
        generateTicketRef.current !== ticket ||
        nodeIdRef.current !== requestedNode ||
        scopeSeqRef.current !== requestedSeq
      ) {
        return;
      }
      toast.error(e instanceof Error ? e.message : txt.installCommandHint);
    } finally {
      // 只有「最新一次请求」才能解锁按钮；旧请求的 finally 不得顶掉新请求的 busy。
      if (generateTicketRef.current === ticket) {
        generatingRef.current = false;
        if (mountedRef.current) setGenerating(false);
      }
    }
  }, [nodeId, startWaiting, txt.installCommandHint]);

  /**
   * 轮询到闭环。
   *
   * 终止条件交给 `NodeInstallPoller`：闭环（online）/ 超时 / 显式停止。
   * **不**在 offline 时停：「已安装但掉线」说明安装已完成，连接可能立刻恢复。
   * 也**不**在关闭对话框时停：命令对话框只是查看命令的入口，等待是页面级状态。
   */
  useEffect(() => {
    if (!waiting || closed) return;
    const poller = new NodeInstallPoller<TView>({
      nodeId,
      loadView: (id) => resolveLoadView()(id),
      onView: (next) => {
        setPollFailed(false);
        latestRef.current.onViewChange?.(next);
      },
      // 取数失败只提示：界面显示「暂时取不到」并继续等下一轮，绝不冒充已连接。
      onError: () => setPollFailed(true),
      onStop: (reason) => {
        // "disposed" 是 effect 重建/卸载时的收拾动作，不是「用户停止等待」：
        // 若在这里 setWaiting(false)，紧接着建立的下一轮会被自己的清理顶掉。
        if (reason === "disposed") return;
        if (!mountedRef.current) return;
        setWaiting(false);
        if (reason === "timeout") {
          setTimedOut(true);
          setPollFailed(false);
        }
        if (reason === "stopped") setStoppedByUser(true);
      },
    });
    poller.start();
    return () => poller.dispose();
  }, [waiting, closed, nodeId, resolveLoadView, pollRound]);

  /** 重新生成：调用方给了安全提示就先进确认框；所有生成入口共用这一条路径。 */
  const requestRegenerate = useCallback(() => {
    if (regenerateConfirm) {
      setRegenerateOpen(true);
      return;
    }
    void generate();
  }, [generate, regenerateConfirm]);

  const copyCommand = useCallback(async () => {
    if (!enrollment) return;
    try {
      await navigator.clipboard.writeText(enrollment.install_command);
      toast.success(txt.installCopied);
    } catch {
      // 剪贴板被拒（非安全上下文）：命令已在对话框里可手动选中，
      // 不把环境限制报成操作失败。
    }
  }, [enrollment, txt.installCopied]);

  /**
   * 横幅上的恢复提示：取数失败 / 超时 / 用户已停止，都必须在对话框关着时可见，
   * 并且能就地重试（取数失败时「重试」会立刻重开一轮，不用等下一个 10s）。
   */
  const bannerAttention = !closed && (pollFailed || stoppedByUser || timedOut);
  const bannerNote = stoppedByUser ? txt.installBannerStoppedHint : timedOut ? txt.installTimeoutHint : txt.installPollError;

  return (
    <>
      {/* 横幅：详情页里持续展示安装阶段，点开即查看/重开命令 */}
      <div className="flex flex-wrap items-center gap-2" data-testid="node-install-waiting">
        <Badge
          variant={closed ? "success" : phase === "installed_offline" ? "outline" : "muted"}
          data-testid="node-install-phase"
        >
          {txt.installPhase[phase]}
        </Badge>
        <span
          className="text-xs text-[var(--muted-foreground)]"
          aria-live="polite"
          data-testid="node-install-phase-hint"
        >
          {txt.installPhaseHint[phase]}
        </span>
        {/* 成功下一步：对话框关着时也要在页面上可见，否则「关掉就没下文」会重演。
            对话框打开时同一份 CTA 渲染在对话框里（避免同屏两个入口）。 */}
        {closed && !open && successAction ? (
          <span className="flex flex-wrap items-center gap-2" data-testid="node-install-success-action">
            {successAction}
          </span>
        ) : null}
        {/* 对话框关着时的失败/停止提示与重试：不能只有打开对话框才能自救 */}
        {bannerAttention ? (
          <>
            <span
              className="text-xs text-[var(--destructive)]"
              role="status"
              aria-live="polite"
              data-testid="node-install-banner-note"
            >
              {bannerNote}
            </span>
            <Button size="sm" variant="ghost" onClick={retryNow} data-testid="node-install-banner-retry">
              {txt.retry}
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => {
            onOpenChange(true);
            // 没有本地命令时的「重开」也是一次生成入口：必须和重签按钮走同一确认。
            if (!enrollment) requestRegenerate();
          }}
          disabled={generating}
          data-testid="node-install-open"
        >
          {generating ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {openLabel ?? txt.installReopen}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{txt.installCommandTitle}</DialogTitle>
            <DialogDescription>{txt.installCommandHint}</DialogDescription>
          </DialogHeader>
          <NodeInstallDialogBody
            enrollment={enrollment}
            generating={generating}
            phase={phase}
            waiting={waiting}
            timedOut={timedOut}
            stoppedByUser={stoppedByUser}
            pollFailed={pollFailed}
            now={clockNow}
            successAction={successAction}
            regenerateNotice={regenerateConfirm ? undefined : txt.installRegenerateInvalidate}
            onRegenerate={requestRegenerate}
            onStop={stopWaiting}
            onRetry={retryNow}
            onCopy={() => void copyCommand()}
            onClose={() => onOpenChange(false)}
          />
        </DialogContent>
      </Dialog>

      <NodeInstallRegenerateConfirm
        open={regenerateOpen}
        onOpenChange={setRegenerateOpen}
        confirm={regenerateConfirm}
        hasCredential={view?.has_credential === true}
        phase={phase}
        pending={generating}
        onConfirm={() => {
          setRegenerateOpen(false);
          void generate();
        }}
      />
    </>
  );
}

export interface NodeInstallDialogBodyProps {
  enrollment: NodeEnrollmentIssued | null;
  generating: boolean;
  phase: InstallPhase;
  waiting: boolean;
  timedOut: boolean;
  /** 用户主动停止了等待；命令仍在这里，可重试。 */
  stoppedByUser?: boolean;
  /** 上一轮取数失败（可恢复）：只提示，不冒充成功。 */
  pollFailed: boolean;
  /** 展示用「现在」（本地轻量时钟）；缺省 `Date.now()`，测试可显式传入。 */
  now?: number;
  /** 闭环后的下一步；权限/准入判断由调用方完成。 */
  successAction?: ReactNode;
  /**
   * 点击重新生成前就地展示的后果说明；调用方已经提供确认框（`regenerateConfirm`）
   * 时留空即可（那时同样的话在确认框里说）。
   */
  regenerateNotice?: string;
  onRegenerate: () => void;
  onStop: () => void;
  onRetry: () => void;
  onCopy: () => void;
  onClose: () => void;
}

/**
 * 安装命令对话框正文（纯展示）。
 *
 * 单独导出是为了能被渲染测试直接断言：Radix Portal 在静态渲染下不产出 DOM，
 * 否则「有效期 / 过期 / 取数失败 / 闭环 CTA」全部无法验证。
 */
export function NodeInstallDialogBody({
  enrollment,
  generating,
  phase,
  waiting,
  timedOut,
  stoppedByUser = false,
  pollFailed,
  now,
  successAction,
  regenerateNotice,
  onRegenerate,
  onStop,
  onRetry,
  onCopy,
  onClose,
}: NodeInstallDialogBodyProps): ReactElement {
  const { locale } = useI18n();
  const txt = nodeLifecycleText(locale);
  const closed = installClosureReached(phase);
  /** 命令过期只对「真的还在等安装」有意义：已连接/已装离线说「过期」等于误报失败。 */
  const showExpired =
    phase === "awaiting_install" && !!enrollment && installCommandExpired(enrollment.expires_at, now ?? Date.now());

  return (
    <>
      {enrollment ? (
        <div className="flex flex-col gap-1.5">
          <div
            className="rounded-md border border-[var(--border)] bg-[var(--muted)] p-3 font-mono text-xs break-all"
            data-testid="node-install-command"
          >
            {enrollment.install_command}
          </div>
          {/* 有效期来自服务端 expires_at；前端只派生「是否已过」 */}
          <span className="text-xs text-[var(--muted-foreground)]" data-testid="node-install-expires">
            {txt.installExpiresLabel} {formatDateTime(enrollment.expires_at)}
          </span>
          {showExpired ? (
            <span className="text-xs text-[var(--destructive)]" data-testid="node-install-expired">
              {txt.installExpiredHint}
            </span>
          ) : null}
          {/* online 之后不得暗示「命令已被消费」：连接状态无法证明是哪条命令被用掉 */}
          {closed ? (
            <span className="text-xs text-[var(--muted-foreground)]" data-testid="node-install-online-command-notice">
              {txt.installOnlineCommandNotice}
            </span>
          ) : null}
          {/* 显式重签入口：旧命令作废的后果必须写在点击之前，不靠用户猜 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {regenerateNotice ? (
              <span className="text-xs text-[var(--muted-foreground)]" data-testid="node-install-regenerate-hint">
                {regenerateNotice}
              </span>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={onRegenerate}
              disabled={generating}
              data-testid="node-install-regenerate"
            >
              <RefreshCw className="size-4" />
              {txt.installRegenerate}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
          {generating ? <Loader2 className="size-4 animate-spin" /> : null}
          <span>{generating ? txt.loading : txt.installWaitingHint}</span>
        </div>
      )}

      {/* 等待闭环状态：这是本组件与旧「复制完就关」流程的唯一区别 */}
      <div
        className="flex flex-col gap-1.5 rounded-[var(--radius)] border border-[var(--border)] p-2.5"
        role="status"
        aria-live="polite"
        data-testid="node-install-progress"
      >
        <div className="flex flex-wrap items-center gap-2">
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
              <Button size="sm" variant="ghost" className="ml-auto" onClick={onStop} data-testid="node-install-stop">
                {txt.installPollStop}
              </Button>
            </>
          ) : (
            <>
              <span className="text-xs text-[var(--muted-foreground)]" data-testid="node-install-idle-hint">
                {stoppedByUser
                  ? txt.installBannerStoppedHint
                  : timedOut
                    ? txt.installTimeoutHint
                    : txt.installPhaseHint[phase]}
              </span>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={onRetry} data-testid="node-install-retry">
                {txt.retry}
              </Button>
            </>
          )}
        </div>
        {/* 取数失败：明确「暂时取不到」，并说明命令不受影响——不谎报已连接 */}
        {!closed && waiting && pollFailed ? (
          <span className="text-xs text-[var(--destructive)]" data-testid="node-install-poll-error">
            {txt.installPollError}
          </span>
        ) : null}
      </div>

      {/* 闭环后的下一步也出现在对话框里（用户正看着对话框时不必先关掉） */}
      {closed && successAction ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="node-install-success-action-dialog">
          {successAction}
        </div>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {txt.installClose}
        </Button>
        <Button onClick={onCopy} disabled={!enrollment} data-testid="node-install-copy">
          <Copy className="size-4" />
          {txt.installCopy}
        </Button>
      </DialogFooter>
    </>
  );
}

export interface NodeInstallRegenerateConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 调用方提供的安全提示（中/英文由调用方决定）。 */
  confirm?: string;
  /** 该节点是否已有凭据：重装会在消费命令时轮换长期凭据、替换原 Agent 身份。 */
  hasCredential?: boolean;
  /** 安装阶段：已安装但离线时明确「重签不会修网络」。 */
  phase: InstallPhase;
  onConfirm: () => void;
  pending?: boolean;
}

/**
 * 重新生成命令前的确认框（可访问：Radix Dialog 的 role/aria 与焦点管理接管）。
 *
 * 三句话必须分开说，否则用户会把它们混成一句「点一下就重装」：
 *   1. 旧命令里**尚未使用**的令牌立即作废（不是所有命令都失效）；
 *   2. 已注册节点：新命令被消费时会轮换长期凭据、替换原 Agent；
 *   3. 已安装但离线：重签**不修网络**，只有确实要重装 Agent 才需要新命令。
 */
export function NodeInstallRegenerateConfirm({
  open,
  onOpenChange,
  confirm,
  hasCredential = false,
  phase,
  onConfirm,
  pending = false,
}: NodeInstallRegenerateConfirmProps): ReactElement {
  const { locale } = useI18n();
  const txt = nodeLifecycleText(locale);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="node-install-regenerate-dialog">
        <DialogHeader>
          <DialogTitle>{txt.installRegenerateTitle}</DialogTitle>
          <DialogDescription>{txt.installRegenerateInvalidate}</DialogDescription>
        </DialogHeader>
        <NodeInstallRegenerateConfirmBody
          confirm={confirm}
          hasCredential={hasCredential}
          phase={phase}
          pending={pending}
          onConfirm={onConfirm}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

export interface NodeInstallRegenerateConfirmBodyProps {
  confirm?: string;
  hasCredential?: boolean;
  phase: InstallPhase;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 确认框正文（纯展示，可被渲染测试直接断言；见文件头的说明）。 */
export function NodeInstallRegenerateConfirmBody({
  confirm,
  hasCredential = false,
  phase,
  pending = false,
  onConfirm,
  onCancel,
}: NodeInstallRegenerateConfirmBodyProps): ReactElement {
  const { locale } = useI18n();
  const txt = nodeLifecycleText(locale);
  return (
    <>
      {confirm ? (
        <p className="text-sm" data-testid="node-install-regenerate-warning">
          {confirm}
        </p>
      ) : null}
      {hasCredential ? (
        <p className="text-xs text-[var(--muted-foreground)]" data-testid="node-install-regenerate-credential">
          {txt.installRegenerateCredential}
        </p>
      ) : null}
      {phase === "installed_offline" ? (
        <p className="text-xs text-[var(--destructive)]" data-testid="node-install-regenerate-offline-hint">
          {txt.installRegenerateOfflineHint}
        </p>
      ) : null}
      <DialogFooter>
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={pending}
          data-testid="node-install-regenerate-cancel"
        >
          {txt.installRegenerateCancel}
        </Button>
        <Button
          variant="destructive"
          onClick={onConfirm}
          disabled={pending}
          data-testid="node-install-regenerate-apply"
        >
          {txt.installRegenerateApply}
        </Button>
      </DialogFooter>
    </>
  );
}
