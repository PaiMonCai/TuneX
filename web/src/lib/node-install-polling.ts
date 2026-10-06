/**
 * I1-A —— 安装等待的轮询核心（无 React / 无 DOM，可注入时钟与定时器）。
 *
 * 把这段长时异步状态机从组件里抽出来的原因只有一个：它必须在受控时钟下被测试。
 *
 * ── 真实不变量 ──
 * 1. **闭环只看服务端**：终止条件复用 `installPhase` / `installClosureReached`
 *    （后端 `deriveConnection` 的投影）。前端不另写「最近上报 + 阈值」，否则同一
 *    页面上「在线」和「不在线」会并存。
 * 2. **同一轮次最多一个在途请求（single-flight）**：下一轮永远在上一轮结算之后
 *    才排期。重复 `start()` 返回 false。
 * 3. **晚到响应丢弃**：`stop()` / `dispose()` 使当前轮次作废；之后 resolve/reject
 *    的响应既不回调、也不清理新轮次的状态、更不续轮。
 * 4. **停止/故障都不谎报成功**：`stop("timeout")` 只结束自动等待；取数失败继续
 *    等下一轮。两者都保留命令与手动重试。
 * 5. **截止时间独立于取数**：`start()` 时挂一个 `maxMs` 的 deadline 定时器。
 *    取数永远挂起（半开连接）时窗口照样到期——旧实现只在 tick 开头判窗口，
 *    而 tick 只在上一轮结算后才排期，于是「挂起 = 永远不会超时」。
 * 6. **stop 后可以真的重开**：新一轮重置 inFlight 标记与计时，并重新挂 deadline。
 *
 * ── 不能保证的事（诚实边界）──
 * 外部 `loadView` 返回的 Promise 没有 `AbortSignal`：`stop()` / `dispose()` 只是
 * **丢弃晚到结果**，不会取消已经发出的 HTTP 请求。因此 `stop()` 后马上 `start()`
 * 时，旧请求可能仍在网络上、与新请求并存；本库保证的是「每一轮内部 <= 1 个在途」
 * 与「旧结果绝不写回」，不是物理层取消。要真正取消需要数据源自己支持 signal。
 */
import { installClosureReached, installPhase } from "./node-lifecycle";
import type { ID } from "./types";

/** 轮询节奏：安装通常要几十秒到几分钟，10s 一次足够且不会打满限流。 */
export const INSTALL_POLL_INTERVAL_MS = 10_000;
/** 最长等待窗口（30 分钟）；到点只停止自动等待，保留命令与手动重试。 */
export const INSTALL_POLL_MAX_MS = 30 * 60 * 1000;

/**
 * 本组件真正消费的最小生命周期视图。
 *
 * 只要两个可选字段：管理端 `NodeLifecycleView`（十键）与用户侧 `GET /api/nodes`
 * 的安全投影（`UserNode`）都满足，组件因此不必 import 任何一侧的完整类型。
 */
export interface NodeInstallView {
  connection?: string | null;
  has_credential?: boolean | null;
}

/** 停止原因：界面据此区分「装好了」「超时了」「用户停了」「组件销毁了」。 */
export type InstallPollStopReason = "closure" | "timeout" | "stopped" | "disposed";

/** 可注入的定时器（测试用假时钟；运行时用全局 `setTimeout`）。 */
export interface InstallPollingTimers {
  setTimer: (fn: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export const installPollingTimers: InstallPollingTimers = {
  setTimer: (fn, delayMs) => globalThis.setTimeout(fn, delayMs),
  clearTimer: (handle) => globalThis.clearTimeout(handle as never),
};

/** 该视图是否已达成安装闭环（online）。复用服务端投影的派生，不另造判据。 */
export function installViewReachedClosure(view: NodeInstallView | null | undefined): boolean {
  return installClosureReached(installPhase(view));
}

export interface NodeInstallPollingOptions<TView extends NodeInstallView> {
  /** 被观察的节点。节点变了必须 dispose 旧实例、另建新实例（晚到响应据此丢弃）。 */
  nodeId: ID;
  /** 数据源。用户域必须注入用户 API，**绝不能**回落到 admin API。 */
  loadView: (nodeId: ID) => Promise<TView>;
  /** 每轮成功取数（含闭环那一轮）。 */
  onView: (view: TView) => void;
  onStop?: (reason: InstallPollStopReason) => void;
  /** 取数失败：**不停轮询**，由调用方展示「暂时取不到」并等下一轮自愈。 */
  onError?: (error: unknown) => void;
  intervalMs?: number;
  maxMs?: number;
  now?: () => number;
  timers?: InstallPollingTimers;
}

/**
 * 安装等待轮询器。
 *
 * 生命周期：`start()` → 每 `intervalMs` 取一次 → `onView` → 闭环则 `stop("closure")`；
 * `stop(reason)` / `dispose()` 作废当前轮次并清掉所有定时器；`dispose()` 之后
 * 实例不可再 `start()`（组件卸载/作用域切换后的响应绝不能复活轮询）。
 */
export class NodeInstallPoller<TView extends NodeInstallView> {
  private active = false;
  private disposed = false;
  /** 已发出的请求所属轮次；null = 当前轮次没有在途请求。 */
  private inFlightGeneration: number | null = null;
  private startedAt = 0;
  private tickTimer: unknown = null;
  private deadlineTimer: unknown = null;
  /** 轮次令牌：每次 start/stop/dispose 自增，旧令牌的晚到响应一律丢弃。 */
  private generation = 0;

  constructor(private readonly options: NodeInstallPollingOptions<TView>) {}

  get isActive(): boolean {
    return this.active;
  }

  /** 当前轮次是否有在途请求（旧轮次的请求不算——它已经作废）。 */
  get isInFlight(): boolean {
    return this.inFlightGeneration !== null && this.inFlightGeneration === this.generation;
  }

  /** 开始一轮等待；已在等待中、或已 `dispose()` 则返回 false。 */
  start(): boolean {
    if (this.active || this.disposed) return false;
    this.active = true;
    this.generation += 1;
    this.inFlightGeneration = null;
    this.startedAt = this.now();
    this.scheduleTick(this.generation);
    this.scheduleDeadline(this.generation, this.maxMs());
    return true;
  }

  /** 显式停止（幂等；不会重复回调）。作废在途响应并清掉定时器。 */
  stop(reason: InstallPollStopReason = "stopped"): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    this.inFlightGeneration = null;
    this.clearTimers();
    this.options.onStop?.(reason);
  }

  /** 组件卸载 / 节点或作用域切换：停止、丢弃在途响应，且此后不可再 start。 */
  dispose(): void {
    this.disposed = true;
    this.stop("disposed");
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private intervalMs(): number {
    return this.options.intervalMs ?? INSTALL_POLL_INTERVAL_MS;
  }

  private maxMs(): number {
    return this.options.maxMs ?? INSTALL_POLL_MAX_MS;
  }

  private timers(): InstallPollingTimers {
    return this.options.timers ?? installPollingTimers;
  }

  private clearTimers(): void {
    const timers = this.timers();
    if (this.tickTimer !== null) {
      timers.clearTimer(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.deadlineTimer !== null) {
      timers.clearTimer(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  private scheduleTick(generation: number): void {
    if (!this.active || generation !== this.generation) return;
    if (this.tickTimer !== null) this.timers().clearTimer(this.tickTimer);
    this.tickTimer = this.timers().setTimer(() => {
      this.tickTimer = null;
      void this.tick(generation);
    }, this.intervalMs());
  }

  /** 独立截止时钟：与取数是否挂起无关，到点即 `stop("timeout")`。 */
  private scheduleDeadline(generation: number, delayMs: number): void {
    this.deadlineTimer = this.timers().setTimer(() => {
      this.deadlineTimer = null;
      if (!this.active || generation !== this.generation) return;
      this.stop("timeout");
    }, delayMs);
  }

  private async tick(generation: number): Promise<void> {
    if (!this.active || generation !== this.generation) return;
    // deadline 定时器已经是权威窗口判定；这里再判一次只是防御定时器被延迟。
    if (this.now() - this.startedAt > this.maxMs()) {
      this.stop("timeout");
      return;
    }
    // 同一轮次最多一个在途请求；正常路径下一轮只在结算后才排期。
    if (this.inFlightGeneration === generation) return;
    this.inFlightGeneration = generation;
    try {
      const view = await this.options.loadView(this.options.nodeId);
      // 只有「自己那一轮」才清理在途标记：旧轮次的响应不得清掉新轮次的请求状态。
      if (this.inFlightGeneration === generation) this.inFlightGeneration = null;
      if (!this.active || generation !== this.generation) return;
      this.options.onView(view);
      if (installViewReachedClosure(view)) {
        this.stop("closure");
        return;
      }
      this.scheduleTick(generation);
    } catch (error) {
      if (this.inFlightGeneration === generation) this.inFlightGeneration = null;
      if (!this.active || generation !== this.generation) return;
      this.options.onError?.(error);
      // 取数失败不停：节点刚上线时后端可能瞬时不可用，静默跳过这一轮
      // 比中断等待更符合用户预期；界面只提示「暂时取不到」。
      this.scheduleTick(generation);
    }
  }
}
