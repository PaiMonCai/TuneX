/** Domain types extracted from the legacy flat types.ts facade. */
import type { ID, Node } from "./base";
/* ================================================================== */
/* V4-WP6 Node Health —— 后端合成视图（§13.4.4）                        */
/* ================================================================== */

/**
 * Health 四态（后端 `services/node-health.ts` 的 NODE_HEALTHS）。
 *
 * 这里**只声明**取值，绝不复制判定规则：判定是后端的唯一真相（§13.4.4
 * 「Backend 根据这些事实计算 Health」），前端只负责把结论翻译成界面。
 */
export type NodeHealthValue = "healthy" | "warning" | "error" | "unknown";

/** Connection（§13.4.1）：与 Health 正交的事实维度，offline ≠ error。 */
export type NodeConnectionValue = "waiting" | "online" | "offline";

/** 节点生命周期（WP5 schema enum NodeLifecycle）。 */
export type NodeLifecycleValue = "active" | "maintenance" | "disabled" | "retiring";

export type HealthSeverity = "info" | "warning" | "error";

/**
 * 判定理由码（后端 HealthReasonCode 的镜像）。
 *
 * UI 用这个码做两件事：把英文界面本地化（后端文案是中文且不可本地化）、
 * 以及给出「下一步动作」。未知码必须原样回落后端 `message`，不得吞掉。
 */
export type HealthReasonCode =
  | "no_credential"
  | "never_reported"
  | "report_stale"
  | "connection_offline"
  | "agent_errors_ongoing"
  | "agent_errors_historical"
  | "runtime_missing"
  | "runtime_revision_behind"
  | "port_not_bound"
  | "forward_apply_error"
  | "agent_version_behind"
  | "agent_version_unknown"
  | "resource_memory_high"
  | "resource_disk_high"
  | "resource_load_high"
  | "role_mismatch";

/** 一条判定理由（severity 降序由后端排好；前端不再重排）。 */
export interface NodeHealthReason {
  code: HealthReasonCode;
  severity: HealthSeverity;
  /** 后端给出的中文结论（含具体比值/版本号）；英文界面走码表翻译。 */
  message: string;
  /** 涉及的对象：隧道名 / revision 比较 / 磁盘路径；没有则 null。 */
  detail?: string | null;
}

/** reasons 的布尔投影（与 reasons 同源，不是第二套判定）。 */
export interface NodeHealthFlags {
  reports_fresh: boolean;
  revision_in_sync: boolean;
  agent_errors_ongoing: boolean;
  resources_ok: boolean;
  /** §13.4.4「端口是否真实占用」：该监听的端口都在上报清单里。 */
  ports_bound: boolean;
}

/** Agent 自报的 runtime 分类计数；字段缺失 = 旧 Agent 没报（未知 ≠ 0）。 */
export interface NodeRuntimeCounts {
  direct?: number | null;
  relay_ingress?: number | null;
  relay_egress?: number | null;
  total?: number | null;
}

/** 轻量资源采样；缺失分组不写键（面板按「未知」处理，不补 0）。 */
export interface NodeHostMetrics {
  cpu_count?: number | null;
  load1?: number | null;
  load5?: number | null;
  load15?: number | null;
  memory_total_bytes?: number | null;
  memory_used_bytes?: number | null;
  disk_path?: string | null;
  disk_total_bytes?: number | null;
  disk_free_bytes?: number | null;
  host_uptime_seconds?: number | null;
  process_rss_bytes?: number | null;
}

/** 上报快照的 UI 投影（后端 NodeTelemetryView）。 */
export interface NodeTelemetry {
  reported_at: string | null;
  /** 面板时钟算出的上报年龄（秒）；null = 从未上报。 */
  age_seconds: number | null;
  version: string | null;
  reported_role: string | null;
  applied_revision: number | null;
  known_revision: number | null;
  /** 见过但没应用上（面板在推、节点应用不了）。 */
  revision_pending: boolean;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  agent_started_at: string | null;
  /** 面板时钟算出的 Agent 进程 uptime（秒）。 */
  uptime_seconds: number | null;
  runtime: {
    counts: NodeRuntimeCounts | null;
    running: string[];
  };
  used_ports: number[];
  host: NodeHostMetrics | null;
  errors: {
    count: number | null;
    last_at: string | null;
    last_message: string | null;
  };
  /** 面板建议升级的目标版本；null = 未配置期望版本（不判落后）。 */
  expected_version: string | null;
}

/** GET /api/admin/node/:id/health 的响应体（`{ data: NodeHealthView }`）。 */
export interface NodeHealthView {
  node_id: ID;
  node_key: string;
  role: string | null;
  lifecycle: string;
  health: NodeHealthValue;
  connection: NodeConnectionValue;
  reasons: NodeHealthReason[];
  flags: NodeHealthFlags;
  /** null = 尚无上报（新节点是正常状态，不是错误）。 */
  telemetry: NodeTelemetry | null;
  desired_runtime_count: number | null;
  forward_count: number;
}

/** 四态计数（GET /api/admin/node/health 的 `summary`，过滤前全量口径）。 */
export interface NodeHealthSummary {
  healthy: number;
  warning: number;
  error: number;
  unknown: number;
}

/**
 * GET /api/admin/node/health 的响应体。
 *
 * 注意后端是**单层**信封（`{ data, total, summary }`），与 paginated 列表的
 * 双层 `{ data: { data, total } }` 不同：多出来的 summary 会被通用 unwrap
 * 丢掉，所以 api 层用 `raw` 取原始信封（见 api.ts 的 nodeHealthList）。
 */
export interface NodeHealthList {
  data: NodeHealthView[];
  total: number;
  summary: NodeHealthSummary;
}

