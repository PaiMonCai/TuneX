/**
 * I1-A —— 安装等待轮询的**受控异步**测试（不读源码字符串、不起浏览器）。
 *
 * 用可注入的假时钟（`now` + `timers`）替代真实定时器，把「等待」这类长时异步
 * 行为变成确定性断言。覆盖的都是用户真会遇到、且静态检查抓不到的行为：
 *
 *   ① 闭环（online）→ 停止，且不再打接口；
 *   ② 已安装但离线 / 状态未知 → **不**停止（连接问题不是安装失败）；
 *   ③ 超时 → 停止但不谎报成功，之后可重试（新窗口）；
 *   ④ 取数失败 / 取数永久挂起 → 窗口照样到期或可恢复，不冒充成功；
 *   ⑤ single-flight：重复 start 无效、同一轮次并发请求 <= 1；
 *   ⑥ stop / dispose → 丢弃晚到响应；stop→start 后新轮不被旧在途请求停摆；
 *   ⑦ dispose 之后不可复活。
 *
 * 跑法（web 目录）：bun test src/lib/__tests__/node-install-polling.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  INSTALL_POLL_INTERVAL_MS,
  INSTALL_POLL_MAX_MS,
  NodeInstallPoller,
  installViewReachedClosure,
  type InstallPollStopReason,
  type NodeInstallView,
} from "@/lib/node-install-polling";

/* ------------------------------------------------------------------ */
/* 受控时钟与工具                                                        */
/* ------------------------------------------------------------------ */

/** 等微任务结算（异步 loadView 的 then/catch 链）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 假时钟：`advance(ms)` 逐个触发到期任务，并在每次触发后结算微任务。 */
class FakeTimers {
  now = 0;
  private seq = 0;
  private tasks = new Map<number, { at: number; fn: () => void }>();

  readonly api = {
    setTimer: (fn: () => void, delayMs: number): unknown => {
      this.seq += 1;
      this.tasks.set(this.seq, { at: this.now + delayMs, fn });
      return this.seq;
    },
    clearTimer: (handle: unknown): void => {
      this.tasks.delete(handle as number);
    },
  };

  get pendingTasks(): number {
    return this.tasks.size;
  }

  /** 待触发任务的到期时间（相对现在）。用来区分「下一轮 tick」与「deadline」。 */
  pendingDelays(): number[] {
    return [...this.tasks.values()].map((task) => task.at - this.now).sort((a, b) => a - b);
  }

  hasPendingDelay(delayMs: number): boolean {
    return this.pendingDelays().includes(delayMs);
  }

  /** 时间推进到 now+ms：途中到期的定时器按时间顺序触发。 */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
      await flush();
    }
    this.now = target;
  }
}

interface Harness {
  timers: FakeTimers;
  views: NodeInstallView[];
  stops: InstallPollStopReason[];
  errors: unknown[];
  calls: number;
  poller: NodeInstallPoller<NodeInstallView>;
}

/**
 * 建一个「按脚本应答」的轮询器。
 *
 * @param script 每轮返回的视图；抛出的 Error 表示该轮取数失败；用完则用最后一个。
 */
function harness(script: Array<NodeInstallView | Error>, options: { intervalMs?: number; maxMs?: number } = {}): Harness {
  const timers = new FakeTimers();
  const views: NodeInstallView[] = [];
  const stops: InstallPollStopReason[] = [];
  const errors: unknown[] = [];
  const state: Harness = { timers, views, stops, errors, calls: 0, poller: undefined as unknown as NodeInstallPoller<NodeInstallView> };
  state.poller = new NodeInstallPoller<NodeInstallView>({
    nodeId: 7,
    loadView: async () => {
      const step = script[Math.min(state.calls, script.length - 1)];
      state.calls += 1;
      if (step instanceof Error) throw step;
      return step;
    },
    onView: (view) => views.push(view),
    onStop: (reason) => stops.push(reason),
    onError: (error) => errors.push(error),
    intervalMs: options.intervalMs,
    maxMs: options.maxMs,
    now: () => timers.now,
    timers: timers.api,
  });
  return state;
}

/* ------------------------------------------------------------------ */
/* ① 节奏常量 & 闭环                                                    */
/* ------------------------------------------------------------------ */

describe("安装等待轮询：节奏与闭环", () => {
  test("保留原管理端节奏：10s 一轮、最长 30 分钟", () => {
    expect(INSTALL_POLL_INTERVAL_MS).toBe(10_000);
    expect(INSTALL_POLL_MAX_MS).toBe(30 * 60 * 1000);
  });

  test("闭环判定只看服务端 connection（复用 installPhase 投影）", () => {
    expect(installViewReachedClosure({ connection: "online" })).toBe(true);
    expect(installViewReachedClosure({ connection: "offline", has_credential: true })).toBe(false);
    expect(installViewReachedClosure({ connection: "waiting", has_credential: false })).toBe(false);
    expect(installViewReachedClosure(null)).toBe(false);
  });

  test("start 后先等一个间隔才取数；online 当轮即 stop(closure) 且不再打接口", async () => {
    const h = harness([{ connection: "waiting" }, { connection: "online" }]);
    expect(h.poller.start()).toBe(true);
    await flush();
    expect(h.calls).toBe(0); // 不立刻取数（与原 setInterval 行为一致）

    await h.timers.advance(INSTALL_POLL_INTERVAL_MS);
    expect(h.calls).toBe(1);
    expect(h.views).toEqual([{ connection: "waiting" }]);
    expect(h.stops).toEqual([]); // 等待安装中 → 继续轮询

    await h.timers.advance(INSTALL_POLL_INTERVAL_MS);
    expect(h.calls).toBe(2);
    expect(h.stops).toEqual(["closure"]);
    expect(h.poller.isActive).toBe(false);
    expect(h.timers.pendingTasks).toBe(0); // 闭环后 deadline 与 tick 都清掉

    // 闭环后即使时间再走，也不再产生任何请求/回调。
    await h.timers.advance(INSTALL_POLL_MAX_MS);
    expect(h.calls).toBe(2);
    expect(h.stops).toEqual(["closure"]);
  });

  test("已安装但离线 / 状态未知都不停止等待（连接问题不是安装失败）", async () => {
    const offline = harness([{ connection: "offline", has_credential: true }]);
    offline.poller.start();
    await offline.timers.advance(INSTALL_POLL_INTERVAL_MS * 3);
    expect(offline.calls).toBe(3);
    expect(offline.stops).toEqual([]);
    expect(offline.poller.isActive).toBe(true);

    const unknown = harness([{ connection: null }]);
    unknown.poller.start();
    await unknown.timers.advance(INSTALL_POLL_INTERVAL_MS * 2);
    expect(unknown.calls).toBe(2);
    expect(unknown.stops).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* ② 超时与重试                                                         */
/* ------------------------------------------------------------------ */

describe("安装等待轮询：超时后可重试", () => {
  test("超过最长窗口 → stop(timeout)，不谎报成功；再次 start() 重新计时", async () => {
    // 10s 一轮、25s 窗口：第 1、2 轮取数，第 3 轮到点时已超窗。
    const h = harness([{ connection: "waiting" }], { intervalMs: 10, maxMs: 25 });
    h.poller.start();

    await h.timers.advance(10);
    expect(h.calls).toBe(1);
    await h.timers.advance(10);
    expect(h.calls).toBe(2);
    await h.timers.advance(10); // t=30 > 25 → 超时，不发请求
    expect(h.calls).toBe(2);
    expect(h.stops).toEqual(["timeout"]);
    expect(h.poller.isActive).toBe(false);
    expect(h.views).toEqual([{ connection: "waiting" }, { connection: "waiting" }]);
    expect(h.timers.pendingTasks).toBe(0);

    // 超时 ≠ 失败：重试会开一轮新窗口（对应界面上的「重试」按钮）。
    expect(h.poller.start()).toBe(true);
    await h.timers.advance(10);
    expect(h.calls).toBe(3);
    expect(h.stops).toEqual(["timeout"]);
  });

  test("取数永久挂起（半开连接）时窗口照样到期：deadline 独立于 tick", async () => {
    const hang = deferred<NodeInstallView>();
    const timers = new FakeTimers();
    const views: NodeInstallView[] = [];
    const stops: InstallPollStopReason[] = [];
    let calls = 0;
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: () => {
        calls += 1;
        return hang.promise;
      },
      onView: (view) => views.push(view),
      onStop: (reason) => stops.push(reason),
      intervalMs: 10_000,
      maxMs: 25_000,
      now: () => timers.now,
      timers: timers.api,
    });

    poller.start();
    await timers.advance(10_000); // 第 1 轮请求发出后一直不结算
    expect(calls).toBe(1);
    expect(poller.isActive).toBe(true);

    // 旧实现只在 tick 开头判窗口，而 tick 只在结算后才会排期 → 挂起 = 永远不会超时。
    await timers.advance(20_000); // t=30s > 25s
    expect(stops).toEqual(["timeout"]);
    expect(poller.isActive).toBe(false);
    expect(timers.pendingTasks).toBe(0);

    // 挂起请求晚到：既不写回，也不复活轮询。
    hang.resolve({ connection: "online" });
    await flush();
    expect(views).toEqual([]);
    expect(stops).toEqual(["timeout"]);
    expect(calls).toBe(1);

    // 超时后仍可显式重试：新窗口同时挂上「下一轮 tick」与「新的 deadline」。
    expect(poller.start()).toBe(true);
    expect(timers.hasPendingDelay(10_000)).toBe(true);
    expect(timers.hasPendingDelay(25_000)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* ③ 取数失败可恢复                                                     */
/* ------------------------------------------------------------------ */

describe("安装等待轮询：取数失败可恢复", () => {
  test("某轮报错只回调 onError，不停轮询；下一轮成功后照常闭环", async () => {
    const boom = new Error("socket hang up");
    const h = harness([boom, { connection: "waiting" }, { connection: "online" }]);
    h.poller.start();

    await h.timers.advance(INSTALL_POLL_INTERVAL_MS);
    expect(h.errors).toEqual([boom]);
    expect(h.views).toEqual([]);
    expect(h.poller.isActive).toBe(true); // 失败不停：后端瞬时不可用不该中断等待

    await h.timers.advance(INSTALL_POLL_INTERVAL_MS);
    expect(h.calls).toBe(2);
    expect(h.views).toEqual([{ connection: "waiting" }]);

    await h.timers.advance(INSTALL_POLL_INTERVAL_MS);
    expect(h.stops).toEqual(["closure"]);
  });
});

/* ------------------------------------------------------------------ */
/* ④ single-flight / 不重叠                                             */
/* ------------------------------------------------------------------ */

describe("安装等待轮询：single-flight", () => {
  test("重复 start 无效；请求在途时不会有第二次并发请求", async () => {
    const first = deferred<NodeInstallView>();
    const timers = new FakeTimers();
    let calls = 0;
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: () => {
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve({ connection: "waiting" });
      },
      onView: () => undefined,
      now: () => timers.now,
      timers: timers.api,
    });

    expect(poller.start()).toBe(true);
    expect(poller.start()).toBe(false); // 已在等待中

    await timers.advance(INSTALL_POLL_INTERVAL_MS * 3); // 请求总共挂了 30s
    expect(calls).toBe(1); // 慢请求不会与下一轮重叠
    expect(poller.isInFlight).toBe(true);
    expect(timers.hasPendingDelay(INSTALL_POLL_INTERVAL_MS)).toBe(false); // 结算前不排下一轮

    first.resolve({ connection: "waiting" });
    await flush();
    expect(poller.isInFlight).toBe(false);
    expect(timers.hasPendingDelay(INSTALL_POLL_INTERVAL_MS)).toBe(true); // 结算后才排下一轮

    await timers.advance(INSTALL_POLL_INTERVAL_MS);
    expect(calls).toBe(2);
  });

  test("同一轮次内并发取数请求不超过 1（无论一次请求挂多久）", async () => {
    const timers = new FakeTimers();
    let calls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const settle: Array<(view: NodeInstallView) => void> = [];
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: () =>
        new Promise<NodeInstallView>((resolve) => {
          calls += 1;
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          settle.push((view) => {
            concurrent -= 1;
            resolve(view);
          });
        }),
      onView: () => undefined,
      now: () => timers.now,
      timers: timers.api,
    });

    poller.start();
    await timers.advance(INSTALL_POLL_INTERVAL_MS * 5);
    expect(calls).toBe(1);
    expect(maxConcurrent).toBe(1);

    settle.shift()!({ connection: "waiting" });
    await flush();
    await timers.advance(INSTALL_POLL_INTERVAL_MS * 2);
    expect(calls).toBe(2);
    expect(maxConcurrent).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* ⑤ stop / dispose 丢弃晚到响应                                        */
/* ------------------------------------------------------------------ */

describe("安装等待轮询：停止后丢弃晚到响应", () => {
  test("dispose() 后在途响应不再写回（切节点/卸载不串台）", async () => {
    const first = deferred<NodeInstallView>();
    const timers = new FakeTimers();
    const views: NodeInstallView[] = [];
    const stops: InstallPollStopReason[] = [];
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: () => first.promise,
      onView: (view) => views.push(view),
      onStop: (reason) => stops.push(reason),
      now: () => timers.now,
      timers: timers.api,
    });

    poller.start();
    await timers.advance(INSTALL_POLL_INTERVAL_MS);
    expect(poller.isInFlight).toBe(true);

    poller.dispose();
    expect(stops).toEqual(["disposed"]);

    // 晚到的 online：既不能当成闭环成功，也不能触发后续轮询。
    first.resolve({ connection: "online" });
    await flush();
    expect(views).toEqual([]);
    expect(stops).toEqual(["disposed"]);
    expect(timers.pendingTasks).toBe(0);
    expect(poller.isActive).toBe(false);
  });

  test("dispose 之后不可复活：start() 返回 false，且不再排期", async () => {
    const timers = new FakeTimers();
    let calls = 0;
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: async () => {
        calls += 1;
        return { connection: "waiting" };
      },
      onView: () => undefined,
      now: () => timers.now,
      timers: timers.api,
    });

    poller.start();
    poller.dispose();
    expect(poller.start()).toBe(false);
    await timers.advance(INSTALL_POLL_INTERVAL_MS * 3);
    expect(calls).toBe(0);
    expect(timers.pendingTasks).toBe(0);
  });

  test("显式 stop('stopped') 幂等：不重复回调，晚到失败也不复活轮询", async () => {
    const first = deferred<NodeInstallView>();
    const timers = new FakeTimers();
    const errors: unknown[] = [];
    const stops: InstallPollStopReason[] = [];
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: () => first.promise,
      onView: () => undefined,
      onStop: (reason) => stops.push(reason),
      onError: (error) => errors.push(error),
      now: () => timers.now,
      timers: timers.api,
    });

    poller.start();
    await timers.advance(INSTALL_POLL_INTERVAL_MS);
    poller.stop("stopped");
    poller.stop("stopped");
    poller.dispose();
    expect(stops).toEqual(["stopped"]);

    first.reject(new Error("late failure"));
    await flush();
    expect(errors).toEqual([]);
    expect(stops).toEqual(["stopped"]);
    expect(timers.pendingTasks).toBe(0);
  });

  test("stop → start 后旧在途请求不得让新轮停摆，也不得清掉新轮的 inFlight", async () => {
    const first = deferred<NodeInstallView>();
    const second = deferred<NodeInstallView>();
    const timers = new FakeTimers();
    const views: NodeInstallView[] = [];
    const stops: InstallPollStopReason[] = [];
    let calls = 0;
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: () => {
        calls += 1;
        if (calls === 1) return first.promise;
        if (calls === 2) return second.promise;
        return Promise.resolve({ connection: "waiting" });
      },
      onView: (view) => views.push(view),
      onStop: (reason) => stops.push(reason),
      now: () => timers.now,
      timers: timers.api,
    });

    poller.start();
    await timers.advance(INSTALL_POLL_INTERVAL_MS); // 第 1 轮请求发出后挂起
    expect(calls).toBe(1);
    expect(poller.isInFlight).toBe(true);

    poller.stop("stopped");
    expect(stops).toEqual(["stopped"]);
    expect(poller.start()).toBe(true); // 重试：新窗口、新 deadline
    expect(poller.isInFlight).toBe(false); // 新轮还没有在途请求

    // 旧实现里新轮会被上一轮的 inFlight 挡掉且不排期（active 但永远不再取数）。
    await timers.advance(INSTALL_POLL_INTERVAL_MS);
    expect(calls).toBe(2);
    expect(poller.isInFlight).toBe(true);
    expect(poller.isActive).toBe(true);

    // 旧轮的晚到响应：不得清掉新轮的 inFlight，也不得回调/续轮/停止。
    first.resolve({ connection: "online" });
    await flush();
    expect(views).toEqual([]);
    expect(stops).toEqual(["stopped"]);
    expect(poller.isActive).toBe(true);
    expect(poller.isInFlight).toBe(true); // 新轮的在途标记必须还在
    expect(calls).toBe(2);

    // 新轮照常结算并续轮。
    second.resolve({ connection: "waiting" });
    await flush();
    expect(views).toEqual([{ connection: "waiting" }]);
    await timers.advance(INSTALL_POLL_INTERVAL_MS);
    expect(calls).toBe(3);
  });

  test("stop → start 后旧轮的晚到失败也不影响新轮", async () => {
    const first = deferred<NodeInstallView>();
    const timers = new FakeTimers();
    const errors: unknown[] = [];
    const stops: InstallPollStopReason[] = [];
    let calls = 0;
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: () => {
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve({ connection: "waiting" });
      },
      onView: () => undefined,
      onStop: (reason) => stops.push(reason),
      onError: (error) => errors.push(error),
      now: () => timers.now,
      timers: timers.api,
    });

    poller.start();
    await timers.advance(INSTALL_POLL_INTERVAL_MS);
    poller.stop("stopped");
    poller.start();
    await timers.advance(INSTALL_POLL_INTERVAL_MS);
    expect(calls).toBe(2);

    first.reject(new Error("late failure"));
    await flush();
    expect(errors).toEqual([]); // 旧轮次的错误不弹给用户
    expect(stops).toEqual(["stopped"]);
    expect(poller.isActive).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* ⑧ 消费者回调（onView）抛错 ≠ 取数失败                                 */
/* ------------------------------------------------------------------ */

/**
 * 这两个异常必须分开（受控复现的旧行为）：`onView` 在 `connection === "online"`
 * 那一帧抛错时，旧实现把它当成"本轮取数失败" —— 于是
 *   ① 闭环判定被跳过：界面永远不进成功态；
 *   ② 一直轮询到 30 分钟 deadline，并把**前端 bug** 报成「暂时取不到」。
 * 现在：回调异常只走 `onViewError`，闭环判定与轮询语义都不受影响。
 */
describe("消费者回调抛错：不改变闭环判定与轮询语义", () => {
  test("online 那一帧 onView 抛错 → 仍然 stop('closure')，且这次 online 没有被丢掉", async () => {
    const timers = new FakeTimers();
    const views: NodeInstallView[] = [];
    const stops: InstallPollStopReason[] = [];
    const errors: unknown[] = [];
    const viewErrors: unknown[] = [];
    let calls = 0;
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: async () => {
        calls += 1;
        return { connection: "online" };
      },
      onView: (view) => {
        views.push(view);
        throw new Error("consumer boom");
      },
      onViewError: (error) => viewErrors.push(error),
      onStop: (reason) => stops.push(reason),
      onError: (error) => errors.push(error),
      now: () => timers.now,
      timers: timers.api,
    });

    poller.start();
    await timers.advance(INSTALL_POLL_INTERVAL_MS);
    await flush();

    expect(stops).toEqual(["closure"]);
    expect(poller.isActive).toBe(false);
    // 那一帧 online 被消费者看到了（异常发生在它之后），没有被吞掉。
    expect(views).toEqual([{ connection: "online" }]);
    expect(viewErrors).toHaveLength(1);
    // 关键断言：这不是"取数失败"，所以错误没有被报成「暂时取不到」。
    expect(errors).toEqual([]);
    // 也没有继续轮询到 30 分钟：定时器全清、不再取数。
    expect(timers.pendingTasks).toBe(0);
    await timers.advance(INSTALL_POLL_MAX_MS);
    expect(calls).toBe(1);
  });

  test("非闭环帧 onView 抛错 → 照常续轮（异常不改变轮询语义），但仍不冒充取数失败", async () => {
    const timers = new FakeTimers();
    const stops: InstallPollStopReason[] = [];
    const errors: unknown[] = [];
    const viewErrors: unknown[] = [];
    let calls = 0;
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: async () => {
        calls += 1;
        return calls === 1 ? { connection: "waiting" } : { connection: "online" };
      },
      onView: () => {
        throw new Error("consumer boom");
      },
      onViewError: (error) => viewErrors.push(error),
      onStop: (reason) => stops.push(reason),
      onError: (error) => errors.push(error),
      now: () => timers.now,
      timers: timers.api,
    });

    poller.start();
    await timers.advance(INSTALL_POLL_INTERVAL_MS); // 第 1 轮：waiting + 回调抛错
    expect(calls).toBe(1);
    expect(errors).toEqual([]); // 回调异常不是取数失败
    expect(stops).toEqual([]);
    expect(poller.isActive).toBe(true);

    // 回调抛错不影响排期：下一轮照常发生，并在 online 时闭环。
    await timers.advance(INSTALL_POLL_INTERVAL_MS);
    await flush();
    expect(calls).toBe(2);
    expect(stops).toEqual(["closure"]);
    expect(viewErrors).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  test("取数失败仍然走 onError（与回调异常分开），onView 不被调用", async () => {
    const timers = new FakeTimers();
    const stops: InstallPollStopReason[] = [];
    const errors: unknown[] = [];
    const viewErrors: unknown[] = [];
    const views: NodeInstallView[] = [];
    let calls = 0;
    const sourceError = new Error("loadView down");
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: async () => {
        calls += 1;
        if (calls === 1) throw sourceError;
        return { connection: "online" };
      },
      onView: (view) => views.push(view),
      onViewError: (error) => viewErrors.push(error),
      onStop: (reason) => stops.push(reason),
      onError: (error) => errors.push(error),
      now: () => timers.now,
      timers: timers.api,
    });

    poller.start();
    await timers.advance(INSTALL_POLL_INTERVAL_MS);
    expect(errors).toEqual([sourceError]);
    expect(viewErrors).toEqual([]);

    await timers.advance(INSTALL_POLL_INTERVAL_MS);
    await flush();
    expect(stops).toEqual(["closure"]);
    expect(views).toEqual([{ connection: "online" }]);
    expect(viewErrors).toEqual([]);
  });

  test("没有注入 onViewError 时，回调异常被丢弃但闭环判定照旧（不静默改语义）", async () => {
    const timers = new FakeTimers();
    const stops: InstallPollStopReason[] = [];
    const errors: unknown[] = [];
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: async () => ({ connection: "online" }),
      onView: () => {
        throw new Error("consumer boom");
      },
      onStop: (reason) => stops.push(reason),
      onError: (error) => errors.push(error),
      now: () => timers.now,
      timers: timers.api,
    });

    poller.start();
    await timers.advance(INSTALL_POLL_INTERVAL_MS);
    await flush();
    expect(stops).toEqual(["closure"]);
    expect(errors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* ⑧ dispose 的事件语义（E2 的 F8：从未 start() 的 dispose 不回调 onStop）  */
/* ------------------------------------------------------------------ */

describe("安装等待轮询：dispose 的事件语义", () => {
  /**
   * 这条**钉住有意行为**（不是「忘了修」）：`onStop` 表示「一次等待被终止」，
   * 从未开始过的等待没有状态变化可报告。发一个 "disposed" 会让消费方以为刚结束
   * 了一次等待 —— 现网唯一的消费者（`admin/node-install-waiting.tsx`）就明确
   * 忽略 "disposed"，正是因为它只代表「收拾现场」。
   */
  test("从未 start() 的 dispose()：不回调 onStop、不排期、之后不可 start", async () => {
    const timers = new FakeTimers();
    const stops: InstallPollStopReason[] = [];
    const views: NodeInstallView[] = [];
    let calls = 0;
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: async () => {
        calls += 1;
        return { connection: "online" };
      },
      onView: (view) => views.push(view),
      onStop: (reason) => stops.push(reason),
      now: () => timers.now,
      timers: timers.api,
    });

    poller.dispose();
    expect(stops).toEqual([]);
    expect(poller.isActive).toBe(false);
    expect(timers.pendingTasks).toBe(0);
    expect(poller.start()).toBe(false);

    await timers.advance(INSTALL_POLL_INTERVAL_MS * 3);
    expect(calls).toBe(0);
    expect(views).toEqual([]);
    expect(stops).toEqual([]);
  });

  test("dispose() 幂等：重复调用只产生一个事件，定时器清零", async () => {
    const first = deferred<NodeInstallView>();
    const timers = new FakeTimers();
    const stops: InstallPollStopReason[] = [];
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: () => first.promise,
      onView: () => undefined,
      onStop: (reason) => stops.push(reason),
      now: () => timers.now,
      timers: timers.api,
    });

    poller.start();
    await timers.advance(INSTALL_POLL_INTERVAL_MS);
    poller.dispose();
    poller.dispose();
    poller.dispose();
    expect(stops).toEqual(["disposed"]);
    expect(timers.pendingTasks).toBe(0);

    first.resolve({ connection: "online" });
    await flush();
    expect(stops).toEqual(["disposed"]);
  });

  /**
   * 与上一条互补：等待**已经**因为闭环而结束时，dispose 是纯收拾动作 ——
   * 不能让同一个「结束」事实被报成两个不同原因（closure + disposed）。
   */
  test("闭环之后 dispose()：不产生第二个 onStop（结束事实只报一次）", async () => {
    const timers = new FakeTimers();
    const stops: InstallPollStopReason[] = [];
    const poller = new NodeInstallPoller<NodeInstallView>({
      nodeId: 1,
      loadView: async () => ({ connection: "online" }),
      onView: () => undefined,
      onStop: (reason) => stops.push(reason),
      now: () => timers.now,
      timers: timers.api,
    });

    poller.start();
    await timers.advance(INSTALL_POLL_INTERVAL_MS);
    await flush();
    expect(stops).toEqual(["closure"]);

    poller.dispose();
    expect(stops).toEqual(["closure"]);
    expect(timers.pendingTasks).toBe(0);
  });
});
