/** Domain types extracted from the legacy flat types.ts facade. */
import type { Node } from "./base";
/* ================================================================== */
/* V4-WP11C：Forward / Node 诊断、Support Bundle、WP11B 升级命令          */
/* ================================================================== */

/** Forward 诊断的一段结论来源。`node_facts` = 只核对事实，未做连通性验证。 */
export type DiagnoseSegmentMethod = "tcp_probe" | "node_facts";

/** 单目标探测结果（Agent 侧闭集状态；UI 只做展示，不重新判定）。 */
export interface DiagnoseProbeResult {
  host: string;
  port: number;
  status: "reachable" | "refused" | "timeout" | "dns_error" | "invalid_target" | "error" | "unsupported" | string;
  elapsed_ms: number;
  resolved_ip?: string;
  detail?: string;
}

/** facts 段的两端运行态事实（没有一次拨号）。 */
export interface DiagnoseSegmentFacts {
  hop: { host: string; port: number } | null;
  expected_revision: number | null;
  ingress: {
    node_id: number;
    reported: boolean;
    runtime_present: boolean;
    runtime_revision: number | null;
    listener_port: number | null;
  };
  egress: {
    node_id: number;
    reported: boolean;
    runtime_present: boolean;
    runtime_revision: number | null;
    listener_port: number | null;
  };
}

export interface DiagnoseSegment {
  segment: "ingress_to_target" | "ingress_to_egress" | "egress_to_target";
  method: DiagnoseSegmentMethod;
  /** false = 这一段没做过连通性验证：UI 必须显式标注，不能渲染成"正常"。 */
  verified: boolean;
  node_id: number;
  node_key: string;
  capability?: { advertised: boolean; actions: string[] | null };
  targets: { host: string; port: number }[];
  results: DiagnoseProbeResult[];
  facts?: DiagnoseSegmentFacts;
  outcome: "ok" | "unreachable" | "unsupported" | "failed" | "unknown";
  error_code?: string;
  message?: string;
}

export interface DiagnoseReport {
  forward_id: number;
  /** Desired protocol, if projected; never means the runtime has converged. */
  protocol?: string;
  mode: "direct" | "relay";
  generated_at: string;
  segments: DiagnoseSegment[];
  next_step: string | null;
}

/** Node 自述事实（Agent 侧白名单；字段与 backend NodeSelfFacts 一一对应）。 */
export interface NodeSelfFacts {
  version: string;
  role: string;
  agent_id: string;
  node_id: string;
  runtime: {
    tunnel_count: number;
    truncated: boolean;
    ports_total: number;
    listen_ports: number[];
    tunnels: { id: string; mode: string; ingress_port: number; egress_port?: number; revision: number; crosses_node: boolean }[];
  };
  state_dir: {
    path: string;
    configured: boolean;
    dir_exists: boolean;
    cache_present: boolean;
    cache_mod_time?: string;
    cache_valid: boolean;
  };
  process: {
    uptime_seconds: number;
    started_at: string;
    go_version: string;
    os: string;
    arch: string;
    cpu_count: number;
    gomaxprocs: number;
    goroutines: number;
    heap_bytes: number;
  };
  shutting_down: boolean;
}

export interface NodeDiagnosticsReport {
  node_id: number;
  node_key: string;
  generated_at: string;
  /** online = 上报新鲜；offline = 已过期（未下发命令）；unknown = 从未上报。 */
  reachability: "online" | "offline" | "unknown";
  agent_facts: NodeSelfFacts | null;
  agent_facts_error: { error_code: string; message: string } | null;
  panel: {
    id: number;
    node_id: string;
    agent_id: string | null;
    role: string | null;
    lifecycle: string | null;
    status: string | null;
    last_seen_at: string | null;
    reported: {
      version: string | null;
      role: string | null;
      control_protocol_version: number | null;
      capabilities: string[] | null;
      reported_revision: number | null;
      known_revision: number | null;
      reported_at: string | null;
      age_seconds: number | null;
      last_error: string | null;
      error_count: number | null;
    } | null;
    forwards: { total: number; active: number; pending: number; failed: number; unconverged: number };
  };
  next_step: string | null;
}

/** `POST /api/nodes/:id/upgrade-command`：面板渲染的升级脚本与它的不变量。 */
export interface NodeUpgradeCommand {
  node: { id: number; node_id: string; agent_id: string | null; lifecycle: string | null };
  target_image: string;
  allow_active: boolean;
  script: string;
  preserves: { node_identity: boolean; credential: boolean; lkg_state: boolean; forwards: boolean };
  rollback_hint: string;
  downtime: string;
}

