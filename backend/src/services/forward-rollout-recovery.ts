/**
 * V4-WP3 — Rollout 恢复面（`DEVELOPMENT.md` §3.5 Reconciler 恢复接缝 / §13.3.2）。
 *
 * ── 本模块是什么 ──
 * `forward-rollout-exec.ts` 交付了「登记 + 执行 + 补偿」三个入口，全部要求
 * **调用方显式给出 rolloutId**。那在请求同步路径上够用（`patchForward` 手里
 * 正好有刚建的 id），但 §13.3.2 要求的「Backend/Worker 重启后只靠 DB 就能
 * 继续/补偿 rollout」缺一个反向入口：**库里已经有未完成的 rollout，谁知道
 * 有哪些、怎么把它们跑完**。
 *
 * 本文件就是那一个入口：`resumeRollouts()` 扫库 → 逐个 `executeRollout()`。
 * 它**不新增任何执行语义**——每一步的动作、幂等键、失败分流全部复用 exec
 * 模块；这里只回答「扫哪些行、按什么顺序、一条失败了要不要继续」。
 *
 * ── 为什么不在 `reconciler.ts` 里做 ──
 * 报告 §3.5 明文「WP3 不修改 reconciler.ts / runtime-reconcile-sink.ts 的
 * 语义」。reconciler 的白名单动作是「同 revision 重发 / 补缺失 runtime」，
 * 它既没有阶段概念也没有补偿概念；把 rollout 续跑塞进去等于给它开第二套
 * 完全不同的语义。接法是 worker 的 `cron_reconcile_v3` case 在调
 * `executeReconcile` **之前**先调本模块（详见 `worker.ts` 的注释）。
 *
 * ── 三条硬约束（写死在实现里）──
 *  1. **只扫未完成行**：`phase in ACTIVE_ROLLOUT_PHASES`。`done/failed/
 *     degraded` 是终态，再扫进来只会每轮空转。
 *  2. **顺序 = id 升序**：同一 tunnel 同期至多一条未完成 rollout（register 的
 *     抢占闸门保证），因此升序即「先发生的先收敛」，与补偿回退的时序直觉一致。
 *  3. **一条失败不影响其余**：worker 是共享进程里的一轮 cron，一次 Agent
 *     不可达不该让同一批其它 Forward 的 rollout 全部停摆。失败只记进结果里
 *     的 `errors`，由下一轮自然重试。
 */

import {
  executeRollout,
  type RolloutDb,
  type RolloutDeps,
} from "./forward-rollout-exec.ts";
import { ACTIVE_ROLLOUT_PHASES } from "./forward-rollout.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { getOrchestrator } from "./relay-wiring.ts";

/** {@link resumeRollouts} 的一轮结果（观测用：暴涨的 pending = 环境有问题）。 */
export interface ResumeRolloutsResult {
  /** 本轮扫进来的未完成 rollout 行数。 */
  scanned: number;
  /** 推进到 `done` 的条数。 */
  resumed: number;
  /** 本轮仍失败/降级的条数（`failed` / `degraded`）。 */
  failed: number;
  /** 因并发被别处抢先而跳过的条数（`concurrent_transition`）。 */
  skipped: number;
  /** 单条错误摘要（rolloutId + error_code），上报用，不含敏感字段。 */
  errors: Array<{ rolloutId: number; error_code?: string; error?: string }>;
  /** 单轮硬上限（防止一次不可恢复故障导致 worker 长时间占锁）。 */
  truncated: boolean;
}

/**
 * 单轮最多处理多少条 rollout。
 *
 * worker 的 `cron_reconcile_v3` 是 30s 的共享 cron，一条 rollout 最坏情况要
 * 跑完五个阶段（每阶段至少一次 Agent 往返，ACK TTL 15s）。设上限只是为了
 * 「异常堆积时这轮 cron 会有界」——正常量级（个位数未完成 rollout）永远触碰
 * 不到它。超限时置 `truncated`，剩余行下一轮继续。
 */
const RESUME_BATCH_LIMIT = 25;

/**
 * 扫库并续跑全部未完成 rollout。
 *
 * @param deps 与 {@link executeRollout} 同一套注入（db + orchestrator）。
 *              必填：显式传 `db` 才不会在测试里静默连上进程单例。
 */
export async function resumeRollouts(deps: ResumeRolloutsDeps): Promise<ResumeRolloutsResult> {
  const out: ResumeRolloutsResult = {
    scanned: 0,
    resumed: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    truncated: false,
  };

  // 控制面未接线（relay-wiring 失败 / 测试只喂 db）⇒ 一行都不扫。
  // 理由：executeRollout 的每个 step 都要走 orchestrator，没有它只能全部记
  // agent_unreachable，把非环境问题伪装成 rollout 失败，且会烧掉 attempt。
  if (deps.orchestrator === null) {
    return out;
  }
  const engineDeps: RolloutDeps = {
    db: deps.db,
    orchestrator: deps.orchestrator,
    ...(deps.now ? { now: deps.now } : {}),
  };

  const rows = (await deps.db.forwardRollout.findMany({
    where: { phase: { in: [...ACTIVE_ROLLOUT_PHASES] } },
    orderBy: { id: "asc" },
    take: RESUME_BATCH_LIMIT + 1,
    select: { id: true },
  })) as Array<{ id: number }>;

  out.scanned = rows.length;

  // 多扫一条 ⇒ 超出上限，仅记标记（避免把第 LIMIT+1 条也跑掉）。
  if (rows.length > RESUME_BATCH_LIMIT) {
    out.truncated = true;
    rows.length = RESUME_BATCH_LIMIT;
  }

  for (const row of rows) {
    try {
      const r = await executeRollout(row.id, engineDeps);
      if (r.ok) {
        out.resumed += 1;
      } else if (r.error_code === "concurrent_transition") {
        // 别处（请求同步路径）已抢先推进 ⇒ 不算失败，也不算成功。
        out.skipped += 1;
      } else {
        out.failed += 1;
        out.errors.push({ rolloutId: row.id, error_code: r.error_code, error: r.error });
      }
    } catch (e) {
      // executeRollout 自己承诺不抛；这里兜住是怕未来改动破了那条承诺时
      // 把整轮 cron 打挂（worker 的 failed handler 只会记一行日志）。
      out.failed += 1;
      out.errors.push({
        rolloutId: row.id,
        error_code: "resume_threw",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return out;
}

/** {@link resumeRollouts} 的最小依赖形状：db 必需，orchestrator 允许 null（见下）。 */
export type ResumeRolloutsDeps = Omit<RolloutDeps, "orchestrator"> & {
  db: RolloutDb;
  /** relay-wiring 未就绪时 worker 侧拿到 null ⇒ 本轮整体跳过，不假装推进。 */
  orchestrator: Orchestrator | null;
};

/**
 * 生产依赖。懒加载 `../db.ts` 与 orchestrator，使**只 import 本模块**的
 * 单测不会连库（与 `defaultReconcileDeps` 同口径：worker 在 import 期就加载
 * 全部 cron 实现，任何顶层 `db` 引用都会让单测强制连 MySQL）。
 */
export function defaultRolloutResumeDeps(): ResumeRolloutsDeps {
  return {
    db: {
      forwardRollout: {
        findMany: async (args) => {
          const { db } = await import("../db.ts");
          const rows = await db.forwardRollout.findMany(args as never);
          return rows as unknown as Awaited<ReturnType<RolloutDb["forwardRollout"]["findMany"]>>;
        },
        findUnique: async (args) => {
          const { db } = await import("../db.ts");
          const row = await db.forwardRollout.findUnique(args as never);
          return row as unknown as Awaited<ReturnType<RolloutDb["forwardRollout"]["findUnique"]>>;
        },
      },
    } as RolloutDb,
    // orchestrator 在**构造时**取一次（worker 单例，与 relay-wiring 同一实例）。
    orchestrator: getOrchestrator(),
  };
}
