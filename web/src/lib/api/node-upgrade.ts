/**
 * 用户域「Agent 升级」读投影与命令渲染的客户端模块。
 *
 * ── 为什么单独一个模块（而不是塞进 `lib/api/nodes.ts`）──
 * `lib/api/nodes.ts` 是同一切片里别人的写点；升级流程需要的两个端点在这里独立成面，
 * 也让"读投影"与"渲染脚本"两件事的契约各自成型。
 *
 * ── 这两件事的语义差别是本质的 ──
 *   · `readUpgradeState()` —— **只读**：面板持有的节点事实上报（`node_state_report.version`）、
 *     上报新鲜度、部署方声明的目标镜像/版本基线，以及**服务端算出来的升级前置结论**。
 *   · `renderUpgradeCommand()` —— 也**没有副作用**（后端注释明写"脚本不改任何运行态"），
 *     它只渲染一段**由操作者在节点主机上执行**的脚本。**生成脚本 ≠ 已升级**，也 ≠ 会升级。
 *
 * 所以这里刻意不提供任何"开始升级/完成升级"的写端点：控制面不会远程替换 Agent，
 * 面板也拿不到脚本在节点上执行的结果（身份校验结论只打印在节点主机上）。
 *
 * 字段全部读服务端，前端**不重算**：
 *   · 离线窗口用 `offline_after_seconds`（服务端常量），不自己编 90s/75s；
 *   · 前置提示用 `precondition.code/message`（服务端 `checkUpgradePrecondition` 的原文），
 *     不自己写一套"先切维护"的规则；
 *   · 版本落后用 `target.version_drift`（服务端复用 WP6 的同一个比较函数）三态，
 *     基线未配置时是 `unknown`，**不猜**落后、也不猜"已是最新"。
 */
import { get, post, ApiError } from "./core";
import type { ID, NodeUpgradeCommand } from "../types";

/** 轮询节拍：Agent 每 30s 上报一次；15s 只读一拍不会读到两份不同的档案。 */
export const UPGRADE_POLL_MS = 15_000;

/** 面板最近一次状态上报里的事实（`node_state_report`，**不是** `node.version`）。 */
export interface NodeUpgradeReported {
  version: string | null;
  role: string | null;
  reported_at: string | null;
  /** 服务端算好的年龄（秒），前端不做时钟算术。 */
  age_seconds: number | null;
  last_error: string | null;
}

/** `fresh` = 面板仍在收到上报（连接事实，**不是**升级结论）。 */
export type UpgradeReportFreshness = "fresh" | "stale" | "unknown";

/** `unknown` = 基线未声明或版本号无法比较（服务端语义）。 */
export type UpgradeVersionDrift = "behind" | "not_behind" | "unknown";

export interface NodeUpgradeState {
  node: {
    id: number;
    node_key: string;
    agent_id: string | null;
    role: string | null;
    lifecycle: string | null;
  };
  /** `null` = 该节点从未上报过（**不得**用 `configured_version` 顶替）。 */
  reported: NodeUpgradeReported | null;
  report_freshness: UpgradeReportFreshness;
  /** ⚠️ 管理员配置字段（`Node.version`），不反映实际运行版本。 */
  configured_version: string;
  target: {
    /** 部署方发给节点的镜像（`TUNEX_AGENT_IMAGE`）；升级脚本的默认目标。 */
    image: string;
    image_source: string;
    /** 部署方声明的版本基线；`null` = 未声明 = 面板不判定落后。 */
    expected_version: string | null;
    version_drift: UpgradeVersionDrift;
  };
  /** 服务端 `checkUpgradePrecondition` 的原文结论（默认路径：不带 allow_active）。 */
  precondition: { ok: boolean; code: string | null; message: string | null };
  /** 面板判定"上报已过期"的阈值（秒），由服务端下发。 */
  offline_after_seconds: number;
  generated_at: string;
}

/** `GET /api/nodes/:id/upgrade-state`（`node:read`，只读）。 */
export function readUpgradeState(nodeId: ID, cookie?: string): Promise<NodeUpgradeState> {
  return get<NodeUpgradeState>(`/nodes/${nodeId}/upgrade-state`, undefined, cookie);
}

/** `POST /api/nodes/:id/upgrade-command`（`node:manage`；仍无副作用）。 */
export function renderUpgradeCommand(
  nodeId: ID,
  input: { agent_image: string; allow_active?: boolean; container_name?: string },
  cookie?: string,
): Promise<NodeUpgradeCommand> {
  return post<NodeUpgradeCommand>(`/nodes/${nodeId}/upgrade-command`, input, cookie);
}

/**
 * 失败之后**具体该改什么**——这是卡片"下一步"的唯一依据。
 *
 * 刻意不是"可重试/不可重试"两态：拿 409 反复点按钮是最常见的错误引导。
 *   · `retry`              取数失败（5xx / 网络 / 限流）⇒ 同一请求重试有意义；
 *   · `fix_image`          400 `invalid_image` ⇒ 改镜像引用；
 *   · `enable_allow_active` 409 `node_not_in_maintenance` ⇒ 带 `allow_active=true` 再生成
 *                          （或先去把节点切到 maintenance，这是更稳的那条路）；
 *   · `install_first`      409 `node_has_no_agent_id` ⇒ 该节点还没完成安装；
 *   · `retired`            409 `node_retired` ⇒ 单向状态，不再接受升级；
 *   · `permission`         403 ⇒ 需要 `node:manage`，重试不会变；
 *   · `not_found`          404 ⇒ 节点不存在或不在当前空间；重试不会变。
 */
export type UpgradeRecovery =
  | "retry"
  | "fix_image"
  | "enable_allow_active"
  | "install_first"
  | "retired"
  | "permission"
  | "not_found"
  | "unknown";

export interface UpgradeErrorInfo {
  status: number | null;
  code: string | null;
  message: string;
  layer: string | null;
  recovery: UpgradeRecovery;
}

/** 读投影 / 渲染脚本两条路径的失败分类（服务端 `code` + HTTP 状态）。 */
export function upgradeErrorInfo(error: unknown): UpgradeErrorInfo {
  const status = error instanceof ApiError ? error.status : null;
  const data = (error as { data?: unknown } | null | undefined)?.data;
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const code = typeof record?.code === "string" ? record.code : null;
  const layer = typeof record?.error_layer === "string" ? record.error_layer : null;
  const message =
    error instanceof Error && error.message.trim() !== ""
      ? error.message
      : "升级接口没有返回可用的错误信息";
  return { status, code, message, layer, recovery: classifyUpgradeRecovery(status, code) };
}

export function classifyUpgradeRecovery(status: number | null, code: string | null): UpgradeRecovery {
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 400) return code === "invalid_image" ? "fix_image" : "unknown";
  if (status === 409) {
    if (code === "node_not_in_maintenance") return "enable_allow_active";
    if (code === "node_has_no_agent_id") return "install_first";
    if (code === "node_retired") return "retired";
    return "unknown";
  }
  // 5xx / 网络层 / 限流：同一请求重试是**有意义**的（这是与上面几类最大的区别）。
  if (status === null || status === 429 || status >= 500) return "retry";
  return "unknown";
}

/**
 * 前置结论是否**允许**在默认路径（不带 `allow_active`）下生成命令。
 *
 * 注意这里不是"前端自己判定前置"：`precondition` 本身是服务端算的，本函数只回答
 * "卡片该不该把那个 `allow_active` 勾选框摆出来"——只有服务端说"是因为节点不在
 * maintenance"时才有意义；`node_has_no_agent_id` / `node_retired` 加这个开关也救不回来。
 */
export function canOfferAllowActive(precondition: NodeUpgradeState["precondition"]): boolean {
  return !precondition.ok && precondition.code === "node_not_in_maintenance";
}

/** 默认路径下是否可以直接生成命令（服务端前置通过）。 */
export function canRenderDefault(precondition: NodeUpgradeState["precondition"]): boolean {
  return precondition.ok || precondition.code === "node_not_in_maintenance";
}

/* ------------------------------------------------------------------ */
/* 脚本生成之后：面板**能**看到什么（诚实边界）                            */
/* ------------------------------------------------------------------ */

/**
 * 操作者生成命令的**本机**记录。
 *
 * 这是卡片自己的状态，不是服务端事实——生成脚本没有任何副作用，服务端因此无从知道
 * "有人正在升级"。把它显式标出来，避免用户把"命令已生成"读成"面板知道我在升级"。
 */
export interface UpgradeRequestRecord {
  /** 生成本机记录的时刻（ISO）。 */
  at: string;
  /** 本次要升级到的镜像。 */
  image: string;
  /** 生成时的上报版本，作为事后对照的基线（可能为 null = 当时从未上报）。 */
  baseline_version: string | null;
}

export type UpgradeAftermathKind =
  | "not_requested"
  /** 生成后**没有**新上报（可能还没执行、也可能节点已经不上报了：面板分不清）。 */
  | "no_new_report"
  /** 生成后**有**新上报：这是"升级后节点又回来了"的**唯一**面板可见证据。 */
  | "new_report";

export interface UpgradeAftermath {
  kind: UpgradeAftermathKind;
  /** 生成后是否又有上报（服务端 `reported_at` 晚于本机记录时刻）。 */
  newReport: boolean;
  /** 上报新鲜度（服务端判定）。 */
  freshness: UpgradeReportFreshness;
  versionBefore: string | null;
  versionAfter: string | null;
  /** 版本字符串真的变了（变了 ≠ 变成了目标版本，更 ≠ 成功）。 */
  versionChanged: boolean;
}

/**
 * 生成命令之后的可见性。
 *
 * **只**根据两件服务端事实（上报时刻、上报版本）+ 一条本机记录来回答：
 * "面板又收到上报了吗""上报的版本和生成时一样吗"。它**不能**回答"升级成功了吗"——
 * 面板看不到脚本的输出、看不到容器、也看不到镜像。"没有新上报"必须同时保留两种解释
 * （还没执行 / 节点掉线），所以这里返回的是 `no_new_report`，不是"失败"。
 */
export function upgradeAftermath(
  state: NodeUpgradeState | null,
  requested: UpgradeRequestRecord | null,
): UpgradeAftermath {
  const freshness = state?.report_freshness ?? "unknown";
  if (!requested) {
    return {
      kind: "not_requested",
      newReport: false,
      freshness,
      versionBefore: null,
      versionAfter: state?.reported?.version ?? null,
      versionChanged: false,
    };
  }
  const after = state?.reported?.reported_at ?? null;
  const afterMs = after ? Date.parse(after) : Number.NaN;
  const atMs = Date.parse(requested.at);
  const newReport = Number.isFinite(afterMs) && Number.isFinite(atMs) ? afterMs > atMs : false;
  const versionAfter = state?.reported?.version ?? null;
  return {
    kind: newReport ? "new_report" : "no_new_report",
    newReport,
    freshness,
    versionBefore: requested.baseline_version,
    versionAfter,
    versionChanged: newReport && requested.baseline_version !== versionAfter,
  };
}
