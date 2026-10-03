/**
 * V4-WP8 §13.4 / §13.7 Wave 4 —— Forward **产品状态**的**唯一**实现（纯函数）。
 *
 * ── 这个模块为什么存在（D7）──
 * 改造前 `apply_status` 的原始枚举值被直接画进 Badge：列表页
 * `forward-workspace.tsx`、详情页 `forward-detail.tsx` 各画一遍，Dashboard 的
 * 前 5 条表再画一遍。同一个转发在三个页面上有三种说法是必然的——只要有一处
 * 忘了跟进 `applied < desired` 这条规则，用户就会看到「列表说同步、详情说
 * 落后」。这里把投影收成一处，三处共用。
 *
 * ── 产品状态 vs 运行态事实 ──
 * 用户要回答的问题是「你要改的，现在跑的是不是这一版」（§13.4），不是
 * 「config_revision 等于几」。所以：
 *   · `synced`    —— 运行的就是已保存的那一版
 *   · `pending`   —— 已保存但还没完全下发（滚动中 / 下层正在推进）
 *   · `error`     —— 下发失败，**上一版仍在跑**（不是「没在跑」）
 *   · `suspended` —— 用户主动暂停，恢复时才应用已保存的版本
 *
 * `raw revision / desired internals` 默认不出现在任何普通页面（D6）：本模块
 * 只在 `pending` 时**以「运行 X / 已保存 Y」的形式**给出必要进度，其余情况不
 * 暴露数字（详情页的完整技术细节折叠在 `<details>` 里，默认收起）。
 *
 * ── 边界 ──
 * 判定权在后端：`apply_status` / `config_revision` / `applied_revision` 的取值
 * 与关系由控制面写入，前端**不**推导状态机（例如不把 `applied > desired`
 * 解释成「回滚」——那需要后端语义，不是前端能猜的）。本模块只做归类与文案键。
 */
import type { PortForward } from "./types";
import { conditionAction } from "./node-lifecycle-i18n";
import type { Locale } from "./i18n";

/** 产品状态四态（与 WP4 的 running-vs-desired 语义一致）。 */
export type ForwardProductState = "synced" | "pending" | "error" | "suspended";

export interface ForwardProductStatus {
  state: ForwardProductState;
  /**
   * 进度用的两个数字，**仅在 `pending` 时有意义**。
   *
   * 调用方不得把它们渲染到别处：`synced` 时它们是等价数字（说了等于没说），
   * `error` / `suspended` 时用户关心的是「上一版还在跑」，不是版本号。
   */
  applied: number | null;
  desired: number | null;
}

/**
 * `(apply_status, config_revision, applied_revision)` → 产品状态。
 *
 * 优先级有意固定为 **异常 > 暂停 > 落后 > 推进中 > 同步**：
 *   · `error` / `suspended` 是**用户可见的运行态异常**，无论 revision 关系如何
 *     都必须先说它（否则「上一版在跑」会被 `applied < desired` 说成「正在同步」，
 *     用户会一直等一个不会发生的收敛）；
 *   · `applied < desired` 才是「还没下发完」；
 *   · `pending` / `applying` 是下层正在推进（此时 revision 可能已相等）。
 *
 * 缺字段（legacy DIRECT 隧道没有编排）→ `synced`：没有 revision 概念的历史
 * 隧道，其运行态就是用户保存的那一版，报「同步」比报「未知」更诚实。
 * 注意 `apply_status` 为 null 时**不**当成 `pending`——那是「从来没过编排」。
 */
export function forwardProductStatus(
  forward: Pick<
    PortForward,
    "apply_status" | "config_revision" | "applied_revision" | "latest_revision"
  > | null | undefined,
): ForwardProductStatus {
  const desired = forward?.config_revision ?? forward?.latest_revision ?? null;
  const applied = forward?.applied_revision ?? null;
  const status = forward?.apply_status ?? null;

  if (status === "error") return { state: "error", applied, desired };
  if (status === "suspended") return { state: "suspended", applied, desired };
  if (desired !== null && applied !== null && applied < desired) {
    return { state: "pending", applied, desired };
  }
  if (status === "pending" || status === "applying") {
    return { state: "pending", applied, desired };
  }
  return { state: "synced", applied, desired };
}

/** 产品状态 → Badge 变体（列表 / 详情 / Dashboard 共用，避免三处配色漂移）。 */
export function forwardProductBadgeVariant(state: ForwardProductState): "success" | "secondary" | "outline" | "destructive" {
  switch (state) {
    case "synced":
      return "success";
    case "suspended":
      return "secondary";
    case "pending":
      return "outline";
    case "error":
      return "destructive";
  }
}

/* ================================================================== */
/* 应用失败 → 下一步动作（D4）                                          */
/* ================================================================== */

/**
 * 编排错误码 → 「下一步做什么」。
 *
 * **键集必须等于**后端 `services/scheduler.ts` 的 `SCHEDULER_ERROR_CODES`：
 * 后端加一个码而前端漏词条时，界面会退化成「操作失败」，而 §13.5 要求错误必须
 * 给出下一步。契约测试（`components/forwards/__tests__/wp8-forward-status.test.ts`）
 * 直接读后端源码做集合断言，所以漏一个词条 CI 就红——这是**有意**的强耦合：
 * 词条是产品契约的一部分，不是可选文案。
 *
 * 词条只描述**用户能做的那一步**，不重复症状（症状由 `forward.applyError` 承载）。
 */
export const APPLY_ERROR_ACTION: Record<string, { zh: string; en: string; retryable: boolean }> = {
  /* ── ① auth / quota：用户自己改配置或套餐 ── */
  policy_denied: {
    zh: "当前策略不允许该配置（可能已过期）。刷新页面后重试，仍失败请联系管理员。",
    en: "The current policy does not allow this configuration (it may have expired). Reload and retry; contact an administrator if it persists.",
    retryable: false,
  },
  tunnel_limit: {
    zh: "已达套餐的转发数量上限。升级套餐或删除不再使用的转发后重试。",
    en: "You have reached the forward limit of your plan. Upgrade the plan or delete unused forwards, then retry.",
    retryable: false,
  },
  traffic_exhausted: {
    zh: "本周期流量额度已耗尽。充值或升级套餐后重试；已有转发不会自动恢复。",
    en: "This period's traffic quota is exhausted. Top up or upgrade, then retry; existing forwards will not resume on their own.",
    retryable: false,
  },
  node_group_not_allowed: {
    zh: "所选节点组未被授权。改选已授权的节点作为入口/出口后重试。",
    en: "The selected node group is not authorised. Pick an authorised ingress/egress node and retry.",
    retryable: false,
  },
  scope_revoked: {
    zh: "这条转发使用的节点组授权已被撤销。改选仍获授权的节点并保存；已运行的转发不会被自动迁移或删除。",
    en: "The node group authorising this forward was revoked. Save with a still-authorised node; running forwards are never migrated or deleted automatically.",
    retryable: false,
  },
  mode_topology_mismatch: {
    zh: "模式与拓扑矛盾：中继必须选出口节点，直连不得选。改好模式或出口节点后再保存。",
    en: "Mode and topology conflict: relay requires an egress node, direct must not have one. Fix the mode or egress node and save again.",
    retryable: false,
  },
  unsupported_protocol: {
    zh: "当前运行时尚未开放这类协议。请改用已支持的协议；历史配置请联系管理员处理。",
    en: "This protocol is not enabled by the current runtime. Use a supported protocol; ask an administrator to handle legacy configurations.",
    retryable: false,
  },
  invalid_target: {
    zh: "目标地址格式不合法。检查主机名与端口后重新保存。",
    en: "The target address is invalid. Check the host and port, then save again.",
    retryable: false,
  },

  /* ── ② bind / acquire：节点与端口 ── */
  node_unavailable: {
    zh: "候选节点当前不可用（角色不匹配或已离线）。确认节点在线后重试，或改选别的节点。",
    en: "No candidate node was available (role mismatch or offline). Bring a node online, or pick another node, then retry.",
    retryable: true,
  },
  node_credential_missing: {
    zh: "节点缺少有效凭据，无法下发配置。请联系管理员为该节点补签凭据后再重试。",
    en: "The node has no valid credential, so configuration cannot be delivered. Ask an administrator to issue one, then retry.",
    retryable: false,
  },
  port_allocation_failed: {
    zh: "入口/出口节点上都分不到端口（区间未配置或已耗尽）。稍后重试，或让管理员扩大节点端口区间。",
    en: "No port could be allocated on the ingress/egress node (no range configured or exhausted). Retry later, or ask an administrator to widen the port range.",
    retryable: true,
  },
  port_invalid: {
    zh: "指定的端口不可用（越界或被拒绝）。改成自动分配端口，或换一个端口后保存。",
    en: "The requested port is not usable (out of range or rejected). Use automatic allocation or pick another port, then save.",
    retryable: false,
  },

  /* ── ③ apply / ACK：下发被拒或超时 ── */
  egress_apply_rejected: {
    zh: "出口节点拒绝了这份配置。先重试一次；仍失败请检查出口节点状态与版本。",
    en: "The egress node rejected the configuration. Retry once; if it fails again, check that node's state and version.",
    retryable: true,
  },
  egress_ack_failed: {
    zh: "出口节点未在规定时间内确认（ACK 超时）。稍后重试；持续失败请检查出口节点网络。",
    en: "The egress node did not acknowledge in time. Retry shortly; if it keeps failing, check that node's network.",
    retryable: true,
  },
  ingress_apply_rejected: {
    zh: "入口节点拒绝了这份配置。先重试一次；仍失败请检查入口节点状态与版本。",
    en: "The ingress node rejected the configuration. Retry once; if it fails again, check that node's state and version.",
    retryable: true,
  },
  ingress_ack_failed: {
    zh: "入口节点未在规定时间内确认（ACK 超时）。稍后重试；持续失败请检查入口节点网络。",
    en: "The ingress node did not acknowledge in time. Retry shortly; if it keeps failing, check that node's network.",
    retryable: true,
  },

  /* ── ④ 补偿自身失败 ── */
  compensation_failed: {
    zh: "回滚这次变更时出错，资源可能残留。请联系管理员核对节点上的残留配置后再重试。",
    en: "Rolling back this change failed, so resources may be left behind. Ask an administrator to check the node before retrying.",
    retryable: true,
  },

  /* ── ⑤ 其它 ── */
  invariant_violated: {
    zh: "控制面状态被外部改动，无法继续。请联系管理员核对这条转发的状态。",
    en: "The control-plane state was altered externally. Ask an administrator to check this forward's state.",
    retryable: false,
  },
  internal_error: {
    zh: "内部错误。重试一次；持续失败请联系管理员并提供该转发名称。",
    en: "Internal error. Retry once; if it persists, contact an administrator with this forward's name.",
    retryable: false,
  },
};

/**
 * 错误码 → 下一步动作文案；未知码返回 `null`（**不编造**建议）。
 *
 * 返回 null 时调用方必须回落后端原文（`apply_error`），而不是显示一句空洞的
 * 「请联系管理员」——运维看到原文才可能自己定位；编造的通用建议会掩盖事实。
 */
export function applyErrorAction(locale: string, code: string | null | undefined): string | null {
  if (!code) return null;
  const entry = APPLY_ERROR_ACTION[code];
  if (!entry) return null;
  return locale === "en" ? entry.en : entry.zh;
}

/**
 * 该错误码是否值得用户自己重试。
 *
 * 前端镜像后端 `isRetryable` 的**结论**（`RETRYABLE` 集合，见
 * `backend/src/services/scheduler.ts`），用于在**没有** `retryable` 字段的路径
 * （详情页读的是 `PortForward.apply_error_code`，聚合接口才有 `retryable`）
 * 上决定是否显示「重试」。
 *
 * 未知码返回 `false`：宁可少给一个按钮，也不给一个注定无效的按钮 ——
 * 「重试一万次也不会让节点凭空多出一把凭据」。
 * 契约测试同时断言本表与后端 `SCHEDULER_ERROR_CODES` / `RETRYABLE` 一致。
 */
export function applyErrorIsRetryable(code: string | null | undefined): boolean {
  if (!code) return false;
  return APPLY_ERROR_ACTION[code]?.retryable === true;
}

/** 已知编排错误码全集（契约测试用来与后端做集合断言）。 */
export const APPLY_ERROR_CODES: string[] = Object.keys(APPLY_ERROR_ACTION);

/** 可自愈（值得用户重试）的错误码子集。 */
export const RETRYABLE_APPLY_ERROR_CODES: string[] = APPLY_ERROR_CODES.filter(
  (code) => APPLY_ERROR_ACTION[code].retryable,
);

/* ================================================================== */
/* 写操作失败 → 下一步（消费 409 condition，D4）                        */
/* ================================================================== */

/** 从接口错误里抽出的 Forward 写失败信息。 */
export interface ForwardErrorInfo {
  status: number | null;
  /** 服务层码：`conflict` / `invalid_input` / `not_found` / `policy_denied` … */
  code: string | null;
  /**
   * 运行条件拒绝码（`node_in_maintenance` / `node_waiting_install` / …）。
   *
   * 后端把它放在 `data.condition`（`routes/forwards.ts` 的 `send()` →
   * `forward-service.ts` 的 `nodeAdmissionError`）。改造前前端**完全没读**
   * 这个字段，于是一个「入口节点正在维护」的 409 在界面上只剩「保存失败」。
   */
  condition: string | null;
  /** 编排错误码（`apply_error_code`；创建/更新路径上的失败原因）。 */
  applyErrorCode: string | null;
  /** 人读原因（`message` → `error` → 状态码兜底，见 lib/api.ts 的 finalize）。 */
  message: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 解析 Forward 写操作（create / patch / action）抛出的 `ApiError`。
 *
 * 后端 `forwards` 族的错误体是 `{ error, code, apply_error_code, data }`：
 *   · `code`：服务层分类（`conflict` / `invalid_input` / …）；
 *   · `data.condition`：**节点准入/生命周期拒绝码**（§13.5 要求的可区分码）；
 *   · `apply_error_code`：编排阶段失败码（下发后才会有）。
 * 三者平级，所以这里一次全取，调用方按优先级给下一步。
 *
 * 同时容忍 `data.data` 一层嵌套（mock 的通用 `fail()` 用那种形状，而 mock 是
 * 前端演示与契约测试的运行环境）。**契约仍以后端顶层为准**。
 */
export function forwardErrorInfo(error: unknown): ForwardErrorInfo {
  const status =
    isRecord(error) && typeof error.status === "number" && Number.isFinite(error.status)
      ? error.status
      : null;
  const message =
    isRecord(error) && typeof error.message === "string"
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const payload = isRecord(error) && isRecord(error.data) ? error.data : null;
  const nested = payload && isRecord(payload.data) ? payload.data : null;
  const read = (key: string): unknown => payload?.[key] ?? nested?.[key];
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return {
    status,
    code: str(read("code")),
    condition: str(read("condition")),
    applyErrorCode: str(read("apply_error_code")),
    message,
  };
}

/**
 * 写失败 → 「下一步做什么」（可能返回多条，按优先级）。
 *
 * 顺序有意如此：**准入拒绝**（`condition`）优先于编排错误（`apply_error_code`）
 * —— 准入被拒说明请求根本没进编排，此时给一个编排层面的建议是误导。
 *
 * 返回空数组 = 没有已知动作；调用方回落后端原文（`message`），不编造建议。
 */
export function forwardErrorActions(locale: string, info: ForwardErrorInfo): string[] {
  const out: string[] = [];
  if (info.condition) {
    const text = conditionAction(locale as Locale, info.condition);
    if (text) out.push(text);
  }
  if (info.applyErrorCode) {
    const text = applyErrorAction(locale, info.applyErrorCode);
    if (text) out.push(text);
  }
  return out;
}

/** 是否值得给「重试」（仅编排层的可自愈错误）。 */
export function forwardErrorIsRetryable(info: ForwardErrorInfo): boolean {
  return applyErrorIsRetryable(info.applyErrorCode);
}
