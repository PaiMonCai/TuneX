/**
 * V4-WP8 §13.4.1 —— 用户侧 Node **三层状态**的展示翻译（纯函数，只翻译不判定）。
 *
 * ── 三层是哪三层，为什么不能压成一层 ──
 *   · **Connection（事实）**：这台机器现在联不联得上。看心跳与凭据。
 *   · **Lifecycle（期望）**：我们**打算**让它接不接新业务（使用中 / 维护中 /
 *     停用 / 退役中）。这是运维的意图，不是机器的状态。
 *   · **Admission（结论）**：此刻点「创建转发」会不会被拒。它是前两层的
 *     合成，**不是**第三个独立事实。
 *
 * 压成一层就会出现 WP8 要修的两种谎：
 *   1. 「维护中的在线节点」显示成「离线故障」——它在线上，是我们让它别接活；
 *   2. 「掉线但可接新业务」显示成「不可用」——它确实掉线（要提醒），但准入
 *      并未被拒（已有转发照跑，新建也仍可能成功）。
 *
 * ── 判定权在后端 ──
 * 本模块**不**读 `last_seen_at`、不比 90s 窗口、不判生命周期合法性。它只把
 * 后端投影好的 `connection` / `accepts_new_business` / `admission_rejection`
 * 翻译成徽章与文案。缺字段时**回落**（`online` 布尔 / 不显示准入结论），
 * 而不是自己算一个 —— 前端算出来的结论一旦与后端准入分叉，用户就会看到
 * 「界面说可以创建，点了却 409」。
 */
import { connectionBadgeVariant, lifecycleBadgeVariant } from "./node-health";
import { conditionAction, nodeLifecycleText } from "./node-lifecycle-i18n";
import type { Locale } from "./i18n";
import type { NodeAdmissionRejection, NodeConnectionValue, UserNode } from "./types";

/** 单个徽章的渲染描述。 */
export interface StatusBadge {
  label: string;
  variant: "success" | "secondary" | "outline" | "muted" | "destructive";
  /** 供测试与 tooltip 使用的稳定语义键（不是文案）。 */
  key: string;
}

/** 三层状态的可渲染描述。 */
export interface UserNodeStatusView {
  /** Connection 层徽章（**总是**存在：这是用户最关心的那一层）。 */
  connection: StatusBadge;
  /** Lifecycle 层徽章；`active`（使用中）时返回 null —— 不显示噪音。 */
  lifecycle: StatusBadge | null;
  /**
   * Admission 层的用户可读结论。
   *
   * `accepts_new_business === true` → 「可接新业务」；
   * `false` → 「不接新业务」+ 下一步动作（拒绝码走 WP7 的文案表）。
   * 后端没给该字段（旧后端）→ null：**不猜**，界面上少一行也比说错强。
   */
  admission: { label: string; reason: string | null; rejection: NodeAdmissionRejection | null } | null;
}

/**
 * Connection 层取值：后端 `connection` → 旧字段 `online` 布尔 → 兜底。
 *
 * **没有**第三档「自己按 status + last_seen 算」——那正是本 WP 删掉的那份
 * 重复判据（`routes/nodes.ts` 与 `services/node-lifecycle.ts` 各判一遍）。
 * 两个事实都缺时回落 `waiting`：说「等待安装」会让用户去看安装步骤（那里会
 * 给出真实状态），而说「在线」会让用户以为一切都好了。
 */
export function nodeConnectionValue(node: UserNode | null | undefined): NodeConnectionValue {
  if (node?.connection) return node.connection;
  if (typeof node?.online === "boolean") return node.online ? "online" : "offline";
  return "waiting";
}

/**
 * 三层状态 → 徽章 / 文案。
 */
export function userNodeStatus(locale: Locale, node: UserNode | null | undefined): UserNodeStatusView {
  const txt = nodeLifecycleText(locale);

  // ── Connection 层 ──
  const connectionKey = nodeConnectionValue(node);
  const connectionBadge: StatusBadge = {
    key: `connection:${connectionKey}`,
    label: txt.connection[connectionKey],
    variant: connectionBadgeVariant(connectionKey),
  };

  // ── Lifecycle 层（使用中不显示徽章）──
  const lifecycle = node?.lifecycle ?? null;
  const lifecycleBadge: StatusBadge | null =
    lifecycle && lifecycle !== "active"
      ? {
          key: `lifecycle:${lifecycle}`,
          label: txt.lifecycle[lifecycle],
          variant: lifecycleBadgeVariant(lifecycle),
        }
      : null;

  // ── Admission 层（后端结论；缺字段则不给结论）──
  const accepts = node?.accepts_new_business;
  let admission: UserNodeStatusView["admission"] = null;
  if (typeof accepts === "boolean") {
    const rejection = node?.admission_rejection ?? null;
    admission = {
      label: accepts ? txt.acceptsNewBusiness : txt.rejectsNewBusiness,
      // 原因文案直接复用 WP7 的「下一步」表：用户要知道的不是码，是做什么。
      reason: accepts ? null : conditionAction(locale, rejection),
      rejection: accepts ? null : rejection,
    };
  }

  return { connection: connectionBadge, lifecycle: lifecycleBadge, admission };
}
