/**
 * WP12 / WP7 —— 节点运行态读数的**三态**契约与中英文案。
 *
 * ── 为什么需要三态，而不是 `NodeStateReport | null` ──
 * `GET /api/admin/node/:id/state` 的契约里只有**一种**「没有」：
 *   · 节点存在时**一律 200** —— 从未上报是 `reported_at: null` 的空态视图
 *     （`backend/src/services/node-admin-state.ts` 的 `NodeStateView`，
 *     见 `routes/node-admin.ts` 那段注释「从未上报 → 空态字段（不是 404）」）；
 *   · 只有节点不存在才是 404。
 * 于是「取不到」（网络/5xx/4xx/响应形状不认识）与「该节点还没有上报过」是
 * **两类不同的事实**，绝不能折成同一个 `null` 后由界面猜：猜错的代价是
 * 管理员把「接口坏了」读成「节点还没上报」，或者反过来把「真的没上报」
 * 当成故障去排查。
 *
 * ── 为什么不写进 `@/lib/i18n/dictionaries.ts` ──
 * 与 `target-health.ts` / `node-lifecycle-i18n.ts` 同一决策：词条按**状态**建表
 * （`Record<status, …>`），漏一个状态是编译错误；放进字典会退化成「缺词条 →
 * 界面画 key」。本切片不写字典（避免与其它分支在同一对象字面量上收口）。
 */
import type { Locale } from "./i18n";
import type { NodeStateReport } from "./types";

/**
 * 状态端点的**线上形状**（真实后端 `NodeStateView`）。
 *
 * 与 `NodeStateReport`（落库行投影）的唯一差别：从未上报时 `reported_at` 是
 * `null` —— 既不是缺字段、也不是 404、更不是 `null` 载荷。因此这里放宽为可空，
 * 让「无上报」在**形状上**可判定，而不是靠调用方猜。
 */
export type NodeStatePayload = Omit<NodeStateReport, "reported_at" | "updated_at"> & {
  reported_at: string | null;
  /** 后端不返回该字段（落库行才有）；缺失时由 `reported_at` 兜底。 */
  updated_at?: string | null;
};

/** 「取不到」的两种来源：请求本身失败，还是响应形状不认识。 */
export type NodeRuntimeUnavailableReason = "request_failed" | "unrecognized_payload";

/**
 * 运行态读数的三种结果。三者互斥，且**不可互相回落**：
 *   · `reported`         —— 200 且有上报（`reported_at` 是实际时刻）；
 *   · `never_reported`   —— 200 且从未上报（契约事实：新节点还没事实，不是错误）；
 *   · `unavailable`      —— 取不到（失败原因 + 可重试）。
 */
export type NodeRuntimeState =
  | { status: "reported"; report: NodeStateReport }
  | { status: "never_reported" }
  | { status: "unavailable"; reason: NodeRuntimeUnavailableReason; message: string };

/**
 * 把状态端点的载荷映射成三态。
 *
 * 两条判据写死在这里（不散落到组件里，否则又会有人把失败折成 `null`）：
 *   1. `null` / `undefined` 载荷 = **响应形状不认识**（真实后端对存在的节点
 *      永远返回对象）→ `unavailable`，绝不当成「没有上报」；
 *   2. 对象载荷里 `reported_at` 为空 = 「从未上报」→ `never_reported`。
 */
export function nodeRuntimeStateFromPayload(
  payload: NodeStatePayload | null | undefined,
): NodeRuntimeState {
  if (payload === null || payload === undefined || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      status: "unavailable",
      reason: "unrecognized_payload",
      message: "state payload is not an object",
    };
  }
  const reportedAt = payload.reported_at;
  if (reportedAt === null || reportedAt === undefined || reportedAt === "") {
    return { status: "never_reported" };
  }
  return {
    status: "reported",
    report: { ...payload, reported_at: reportedAt, updated_at: payload.updated_at ?? reportedAt },
  };
}

export interface NodeRuntimeText {
  /** 取不到运行态（请求失败/4xx/5xx）：不得说「没有上报」，也不得说「正常」。 */
  unavailableTitle: string;
  unavailableHint: string;
  /** 响应形状不认识（载荷为 null 等）：同样是「取不到」，但要说明是形状问题。 */
  unrecognizedTitle: string;
  unrecognizedHint: string;
  /** 可重试入口的文案。 */
  retry: string;
}

const zh: NodeRuntimeText = {
  unavailableTitle: "暂时取不到运行态",
  unavailableHint:
    "读取该节点的运行态快照失败（网络、权限或服务端错误），因此这里不给出任何运行态结论。它与「该节点从未上报」是两回事：请重试读取后再判断。",
  unrecognizedTitle: "运行态响应无法识别",
  unrecognizedHint:
    "服务端返回的运行态响应形状与契约不一致，因此无法判断该节点是否上报过。这与「从未上报」不是一回事，请重试读取。",
  retry: "重试读取运行态",
};

const en: NodeRuntimeText = {
  unavailableTitle: "Runtime state is temporarily unavailable",
  unavailableHint:
    "Reading this node's runtime snapshot failed (network, permission, or server error), so no runtime conclusion is shown here. This is not the same as \"this node has never reported\" — retry the read before drawing any conclusion.",
  unrecognizedTitle: "Unrecognized runtime state response",
  unrecognizedHint:
    "The runtime state response does not match the contract, so whether this node has ever reported cannot be determined. That is not the same as \"never reported\" — retry the read.",
  retry: "Retry reading runtime state",
};

export function nodeRuntimeText(locale: Locale): NodeRuntimeText {
  return locale === "en" ? en : zh;
}
