/**
 * V5.5 Federation —— 消息回执（replay 防护 + 幂等，契约 §2.3 第 4 步）。
 *
 * 跨面板调用会重试（丢包、超时、进程重启），因此**同一个 message_id 必须只有一次副作用**。
 * 实现方式是「先占位、后写响应快照」：
 *   1. 收到请求 → 用唯一键 `inbound:<peer>:<message_id>` 插入回执行；
 *   2. 插入成功 = 首次见到 → 执行 handler，然后把状态码与响应体写回该行；
 *   3. 插入冲突（P2002）= 重复投递 → 有快照就原样返回，没有就说明**同一条消息正在处理中**，
 *      返回 duplicate_message（retryable）让对端稍后重试 —— 这比"再执行一次"安全得多。
 *
 * 这不替代 revision 闸门：回执只保证"同一条消息只做一次"，业务上的新旧判定仍归
 * `(intent_id, revision)` / `grant_epoch` / `lease_epoch`。
 */
import { db } from "../../db.ts";

const MESSAGE_ID_MAX = 96;
const PEER_ID_MAX = 64;

export type ClaimResult =
  | { kind: "new"; messageKey: string }
  | { kind: "duplicate_done"; status: number; body: unknown }
  | { kind: "duplicate_in_flight" };

export function receiptMessageKey(peerPanelId: string, messageId: string): string {
  return `inbound:${peerPanelId.slice(0, PEER_ID_MAX)}:${messageId.slice(0, MESSAGE_ID_MAX)}`;
}

function isUniqueConflict(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 尝试占用一条入站消息。重复时最多等待 `waitForSnapshotMs`
 * （默认 600ms，5 次 120ms）以便首次处理来得及写回快照 ——
 * 对端重试通常发生在同一秒内，这个等待能把绝大多数并发重复变成"返回首次结果"。
 */
export async function claimInboundMessage(
  input: { peer_panel_id: string; message_id: string; path: string },
  opts: { waitForSnapshotMs?: number } = {},
): Promise<ClaimResult> {
  const message_key = receiptMessageKey(input.peer_panel_id, input.message_id);
  try {
    await db.federationMessageReceipt.create({
      data: {
        message_key,
        peer_panel_id: input.peer_panel_id.slice(0, PEER_ID_MAX),
        direction: "inbound",
        path: input.path.slice(0, 191),
        status: 0,
        response_body: undefined,
      },
    });
    return { kind: "new", messageKey: message_key };
  } catch (e) {
    if (!isUniqueConflict(e)) throw e;
  }

  const budget = opts.waitForSnapshotMs ?? 600;
  const step = 120;
  for (let waited = 0; waited <= budget; waited += step) {
    const row = await db.federationMessageReceipt.findUnique({ where: { message_key } });
    if (row && row.status > 0) {
      return { kind: "duplicate_done", status: row.status, body: row.response_body ?? null };
    }
    if (waited < budget) await sleep(step);
  }
  return { kind: "duplicate_in_flight" };
}

/** 首次处理完成后写回快照（status > 0 表示"已完成"，重复判定据此区分在途）。 */
export async function completeInboundMessage(input: {
  message_key: string;
  status: number;
  body: unknown;
}): Promise<void> {
  try {
    await db.federationMessageReceipt.update({
      where: { message_key: input.message_key },
      data: { status: input.status, response_body: (input.body ?? null) as never },
    });
  } catch (e) {
    // 写不回快照的后果是"对端重试只会拿到 409 而不是快照"，不能因此让业务失败。
    console.warn("[federation] failed to persist message receipt:", e instanceof Error ? e.message : e);
  }
}

/**
 * 释放一条回执（**瞬态失败**时必须调用）。
 *
 * 为什么需要它：客户端重试会**复用同一个 message_id**（那是幂等的前提）。如果一次
 * 瞬时 5xx 也被写进快照，那么对端的每一次重试都会拿到同一个缓存的 5xx —— 一次抖动
 * 就被永久化了，而且现象是"重试永远失败"，与"对方一直坏着"无法区分。
 *
 * 所以：幂等只对**决策**成立，不对**服务端瞬态故障**成立。
 */
export async function releaseInboundMessage(message_key: string): Promise<void> {
  try {
    await db.federationMessageReceipt.deleteMany({ where: { message_key, status: { in: [0, 429] } } });
    await db.federationMessageReceipt.deleteMany({ where: { message_key, status: { gte: 500 } } });
  } catch (e) {
    console.warn("[federation] failed to release message receipt:", e instanceof Error ? e.message : e);
  }
}

/** 清理过期回执（由 worker 周期任务调用；回执只用于去重窗口，不是长期账本）。 */
export async function pruneInboundReceipts(olderThanMs = 24 * 60 * 60 * 1000, now = new Date()): Promise<number> {
  const res = await db.federationMessageReceipt.deleteMany({
    where: { created_at: { lt: new Date(now.getTime() - olderThanMs) } },
  });
  return res.count;
}
