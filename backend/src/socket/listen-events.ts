/**
 * Socket.IO `listen` / `listen_error` 事件处理（多节点端口竞争修复 · 控制面闭环）
 *
 * ── 背景 ──
 * agent 在动态选端口后回发 `listen`（成功）或 `listen_error`（绑定失败，如
 * `EADDRINUSE`）事件：
 *   listen       { node_id, name, port, type }
 *   listen_error { node_id, name, error }
 * 其中 `name` 形如 `tcp-<tunnelId>` / `udp-<tunnelId>`；出口服务名不含数字，
 * 走 `tunnel:out_listen` 缓存通道。
 *
 * 修复前 backend **没有 `listen_error` 的 handler**（见
 * reports/multi-node-verification.md §7 缺陷#3）：agent 起服务失败被静默丢弃，
 * 控制面「不知道」某节点绑定端口失败，无告警、无状态纠正。本模块补上该 handler，
 * 并复刻上游语义（反编译源 `src/socket-io/handlers/listen_error.ts`）：
 *
 *   name 去掉 tcp-/udp- 前缀 → id = Number(name)
 *   id 非数字（出口服务名）→ 直接忽略
 *   error === "ERR_PORT_IN_USE" → 把该隧道置 `inactive` 并写 `port_conflict_at`
 *
 * 这样运行时冲突就与「声明式预检（API 400）」汇合到同一状态字段，形成闭环：
 * 冲突历史可审计、隧道状态反映真实绑定结果。
 *
 * `listen` 处理仍在 `socket/index.ts`（需广播能力与去重语义）；本模块只抽离
 * **可在无 Socket.IO 环境下单测**的纯逻辑与 DB 副作用。
 */

/** `listen` / `listen_error` 的载荷形状。 */
export interface ListenEventPayload {
  node_id?: string;
  name: string;
  error?: string;
  port?: number;
  type?: string;
}

/** `name` 解析结果：数字后缀 → 隧道 id；非数字 → 出口服务名。 */
export interface ParsedListenName {
  /** 隧道 id；`null` 表示 name 不是 `<proto>-<数字>`（视为出口服务名）。 */
  tunnelId: number | null;
  /** 去掉协议前缀后的原始后缀（便于日志）。 */
  suffix: string;
}

/** agent 侧端口绑定失败的错误码（`engine/runtime.go#isAddrInUse`）。 */
export const ERR_PORT_IN_USE = "ERR_PORT_IN_USE";

/**
 * 解析 agent 上报的服务名。
 * 复刻上游：`name.replace("tcp-","").replace("udp-","")` 后 `Number(...)`，
 * `NaN` 即非隧道服务（出口服务名）。
 */
export function parseListenName(name: string): ParsedListenName {
  const suffix = String(name ?? "")
    .replace(/^tcp-/, "")
    .replace(/^udp-/, "");
  const n = Number(suffix);
  return { tunnelId: Number.isFinite(n) && suffix.trim() !== "" ? n : null, suffix };
}

/** 错误码分类：仅 `ERR_PORT_IN_USE` 触发状态纠正（其余仅记录）。 */
export function isPortInUseError(errCode: string | undefined): boolean {
  return errCode === ERR_PORT_IN_USE;
}

/** 依赖注入（默认写真实 DB；测试注入 fake）。 */
export interface ListenErrorDeps {
  /** 标记隧道端口冲突：置 inactive + 写 port_conflict_at。 */
  markPortConflict?: (tunnelId: number, at: Date) => Promise<void>;
  /** 日志（默认 console.warn，便于 grep 告警）。 */
  log?: (message: string, meta: Record<string, unknown>) => void;
}

const defaultMarkPortConflict = async (tunnelId: number, at: Date): Promise<void> => {
  // 延迟 import Prisma，避免本模块在无 DB 环境（如单测）被引入时即连库。
  const { db } = await import("../db.ts");
  // updateMany：即便隧道已被删除也不抛错（原版用 update 会抛）。
  await db.tunnel.updateMany({
    where: { id: tunnelId },
    data: { status: "inactive", port_conflict_at: at },
  });
};

/**
 * 处理 `listen_error` 事件。
 *
 * @returns 是否因端口占用而纠正了隧道状态。
 */
export async function handleListenError(
  data: ListenEventPayload,
  deps: ListenErrorDeps = {},
): Promise<boolean> {
  const log = deps.log ?? ((m, meta) => console.warn(m, meta));
  const mark = deps.markPortConflict ?? defaultMarkPortConflict;

  const { tunnelId, suffix } = parseListenName(data.name);
  // 出口服务名（无隧道 id）：动态端口仅入口侧有定义，无可标记对象。
  if (tunnelId === null) {
    log("[listen_error] non-tunnel service, ignored", {
      node_id: data.node_id,
      name: data.name,
      error: data.error,
    });
    return false;
  }

  if (!isPortInUseError(data.error)) {
    log("[listen_error] non port-in-use error, recorded only", {
      node_id: data.node_id,
      tunnel_id: tunnelId,
      error: data.error,
    });
    return false;
  }

  try {
    await mark(tunnelId, new Date());
  } catch (e) {
    log("[listen_error] failed to mark port conflict", {
      tunnel_id: tunnelId,
      err: (e as Error)?.message,
    });
    return false;
  }
  log("[listen_error] port in use: tunnel marked inactive", {
    node_id: data.node_id,
    tunnel_id: tunnelId,
    name: suffix,
  });
  return true;
}
