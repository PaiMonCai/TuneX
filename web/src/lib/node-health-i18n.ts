/**
 * V4-WP6 §13.4.4 —— 节点健康面板的中英文案。
 *
 * ── 为什么这里不是 `@/lib/i18n.ts` ──
 * WP6 与 WP9 是两个并行分支，WP9 正在改 `@/lib/i18n.ts`（forward 词条）。
 * 把 WP6 的新词条塞进同一个文件会让两个分支在同一处收口：`git merge` 的
 * 冲突面从「两个不相干的词条」变成「同一个对象字面量」。因此 WP6 的健康词条
 * 自持一份**按码点表**，零共享、零冲突；等两条分支都落地后可以把本文件
 * 整体并入 i18n.ts（键名沿用下面的键，机械搬迁即可）。
 *
 * ── 为什么按 reason code 建表 ──
 * 后端的 `reasons[].message` 是中文结论（含 92.3% 这类具体数值），**不可本地化**。
 * 英文界面靠码点表翻译；未知码必须原样回落后端 message（见 `reasonTitle`），
 * 否则后端新增理由会在英文界面里变成空白。
 */
import type { Locale } from "./i18n";
import type { HealthReasonCode, HealthSeverity, NodeHealthValue, NodeLifecycleValue } from "./types";

/** 面板文案：两个 locale 必须键集一致（类型保证，漏翻译会编译不过）。 */
export interface NodeHealthText {
  title: string;
  subtitle: string;
  mockHint: string;
  mockBadge: string;
  refresh: string;
  loading: string;
  loadFailed: string;
  retry: string;
  noReport: string;
  noReportHint: string;
  noIssues: string;
  issuesCount: string;
  reasonDetail: string;
  nextStep: string;

  health: Record<NodeHealthValue, string>;
  connection: Record<"waiting" | "online" | "offline", string>;
  lifecycle: Record<NodeLifecycleValue, string>;
  severity: Record<HealthSeverity, string>;

  flagReportsFresh: string;
  flagReportsStale: string;
  flagRevisionInSync: string;
  flagRevisionBehind: string;
  flagErrorsOngoing: string;
  flagErrorsNone: string;
  flagResourcesOk: string;
  flagResourcesTight: string;
  flagPortsBound: string;
  flagPortsMissing: string;

  sectionVersion: string;
  sectionIdentity: string;
  sectionRevision: string;
  sectionRuntime: string;
  sectionResources: string;
  sectionErrors: string;
  sectionReasons: string;

  version: string;
  expectedVersion: string;
  upgradeAdvice: string;
  versionUnknownHint: string;
  reportedRole: string;
  hostname: string;
  osArch: string;
  agentStartedAt: string;
  agentUptime: string;
  reportedAt: string;
  reportAge: string;
  appliedRevision: string;
  knownRevision: string;
  revisionPending: string;
  revisionPendingHint: string;
  forwardsCount: string;
  desiredRuntimes: string;
  runningRuntimes: string;
  usedPorts: string;
  errorCount: string;
  lastErrorAt: string;
  lastErrorMessage: string;
  diskPath: string;
  runtimeDirect: string;
  runtimeRelayIngress: string;
  runtimeRelayEgress: string;
  runtimeTotal: string;
  resourceCpu: string;
  resourceLoad: string;
  resourceMemory: string;
  resourceDisk: string;
  resourceRss: string;
  resourceHostUptime: string;

  listHealthColumn: string;
  noHealthData: string;
  fleetSummaryLabel: string;
  listSummaryHealthy: string;
  listSummaryWarning: string;
  listSummaryError: string;
  listSummaryUnknown: string;
  listSummaryHint: string;
}

const zh: NodeHealthText = {
  title: "节点健康",
  subtitle: "由面板依据 Agent 上报的事实合成（Health / Connection / 生命周期三者正交）。",
  mockHint: "本区块来自前端 mock（后端 health 端点契约已冻结，字段与之一致）。",
  mockBadge: "MOCK",
  refresh: "刷新健康状态",
  loading: "加载中…",
  loadFailed: "健康状态加载失败",
  retry: "重试",
  noReport: "等待首次状态上报",
  noReportHint: "该节点还没有可判定的事实（未装 Agent 或刚上线），Health 为 unknown 属正常。",
  noIssues: "没有任何判定理由：事实齐全且一致。",
  issuesCount: "判定理由",
  reasonDetail: "详情",
  nextStep: "下一步",

  health: { healthy: "健康", warning: "警告", error: "故障", unknown: "未知" },
  connection: { waiting: "等待安装", online: "在线", offline: "离线" },
  lifecycle: { active: "使用中", maintenance: "维护中", disabled: "已停用", retiring: "退役中" },
  severity: { info: "提示", warning: "警告", error: "故障" },

  flagReportsFresh: "上报新鲜",
  flagReportsStale: "上报过期",
  flagRevisionInSync: "配置已同步",
  flagRevisionBehind: "配置落后",
  flagErrorsOngoing: "仍在报错",
  flagErrorsNone: "无进行中错误",
  flagResourcesOk: "资源正常",
  flagResourcesTight: "资源接近阈值",
  flagPortsBound: "监听端口已占用",
  flagPortsMissing: "监听端口未占用",

  sectionVersion: "Agent 版本",
  sectionIdentity: "节点身份与进程",
  sectionRevision: "配置版本（revision）",
  sectionRuntime: "runtime 与端口",
  sectionResources: "系统资源",
  sectionErrors: "错误账本",
  sectionReasons: "怎么处理",

  version: "上报版本",
  expectedVersion: "期望版本",
  upgradeAdvice: "建议升级到期望版本",
  versionUnknownHint: "面板未配置期望版本，无法判断是否落后",
  reportedRole: "Agent 自报角色",
  hostname: "主机名",
  osArch: "系统 / 架构",
  agentStartedAt: "Agent 启动",
  agentUptime: "Agent 运行时长",
  reportedAt: "上报时间",
  reportAge: "上报年龄",
  appliedRevision: "已应用 revision",
  knownRevision: "已见过 revision",
  revisionPending: "有待应用的 revision",
  revisionPendingHint: "面板在推新配置，节点还没应用上。",
  forwardsCount: "该节点上的转发数",
  desiredRuntimes: "期望 runtime 数",
  runningRuntimes: "运行中的 runtime",
  usedPorts: "已占用端口",
  errorCount: "累计错误",
  lastErrorAt: "最近错误时间",
  lastErrorMessage: "最近错误内容",
  diskPath: "路径",
  runtimeDirect: "DIRECT",
  runtimeRelayIngress: "RELAY ingress",
  runtimeRelayEgress: "RELAY egress",
  runtimeTotal: "合计",
  resourceCpu: "CPU 核心",
  resourceLoad: "负载 1/5/15",
  resourceMemory: "内存",
  resourceDisk: "数据盘",
  resourceRss: "进程 RSS",
  resourceHostUptime: "主机运行时长",

  listHealthColumn: "健康",
  noHealthData: "-",
  fleetSummaryLabel: "全量巡检：",
  listSummaryHealthy: "健康",
  listSummaryWarning: "警告",
  listSummaryError: "故障",
  listSummaryUnknown: "未知",
  listSummaryHint: "四态计数（过滤前全量）。",
};

const en: NodeHealthText = {
  title: "Node health",
  subtitle: "Synthesised by the panel from the facts the agent reports (health, connection and lifecycle are orthogonal).",
  mockHint: "This block comes from the front-end mock; the backend health contract is frozen and mirrored here.",
  mockBadge: "MOCK",
  refresh: "Refresh health",
  loading: "Loading…",
  loadFailed: "Could not load node health",
  retry: "Retry",
  noReport: "Waiting for the first state report",
  noReportHint: "This node has no judgeable facts yet (agent not installed, or just registered). Health=unknown is expected.",
  noIssues: "No reasons: the facts are complete and consistent.",
  issuesCount: "Reasons",
  reasonDetail: "Detail",
  nextStep: "Next step",

  health: { healthy: "Healthy", warning: "Warning", error: "Error", unknown: "Unknown" },
  connection: { waiting: "Waiting for install", online: "Online", offline: "Offline" },
  lifecycle: { active: "Active", maintenance: "Maintenance", disabled: "Disabled", retiring: "Retiring" },
  severity: { info: "Info", warning: "Warning", error: "Error" },

  flagReportsFresh: "Report fresh",
  flagReportsStale: "Report stale",
  flagRevisionInSync: "Revision in sync",
  flagRevisionBehind: "Revision behind",
  flagErrorsOngoing: "Errors ongoing",
  flagErrorsNone: "No ongoing error",
  flagResourcesOk: "Resources ok",
  flagResourcesTight: "Resources near threshold",
  flagPortsBound: "Listen ports bound",
  flagPortsMissing: "Listen port not bound",

  sectionVersion: "Agent version",
  sectionIdentity: "Identity & process",
  sectionRevision: "Config revisions",
  sectionRuntime: "Runtimes & ports",
  sectionResources: "System resources",
  sectionErrors: "Error ledger",
  sectionReasons: "What to do",

  version: "Reported version",
  expectedVersion: "Expected version",
  upgradeAdvice: "Upgrade to the expected version",
  versionUnknownHint: "No expected version is configured, so drift cannot be judged",
  reportedRole: "Agent-reported role",
  hostname: "Hostname",
  osArch: "OS / arch",
  agentStartedAt: "Agent started",
  agentUptime: "Agent uptime",
  reportedAt: "Reported at",
  reportAge: "Report age",
  appliedRevision: "Applied revision",
  knownRevision: "Known revision",
  revisionPending: "Revision pending",
  revisionPendingHint: "The panel is pushing a newer config and the node has not applied it yet.",
  forwardsCount: "Forwards on this node",
  desiredRuntimes: "Desired runtimes",
  runningRuntimes: "Running runtimes",
  usedPorts: "Ports in use",
  errorCount: "Total errors",
  lastErrorAt: "Last error at",
  lastErrorMessage: "Last error",
  diskPath: "Path",
  runtimeDirect: "DIRECT",
  runtimeRelayIngress: "RELAY ingress",
  runtimeRelayEgress: "RELAY egress",
  runtimeTotal: "Total",
  resourceCpu: "CPU cores",
  resourceLoad: "Load 1/5/15",
  resourceMemory: "Memory",
  resourceDisk: "Data disk",
  resourceRss: "Process RSS",
  resourceHostUptime: "Host uptime",

  listHealthColumn: "Health",
  noHealthData: "-",
  fleetSummaryLabel: "Fleet inspection:",
  listSummaryHealthy: "Healthy",
  listSummaryWarning: "Warning",
  listSummaryError: "Error",
  listSummaryUnknown: "Unknown",
  listSummaryHint: "Four-state counts over all nodes (before filtering).",
};

/** 理由码 → 标题（中英）。键集 = HealthReasonCode，新增码会强制两端同时补。 */
const REASON_TITLE: Record<Locale, Record<HealthReasonCode, string>> = {
  zh: {
    no_credential: "尚未安装 Agent",
    never_reported: "从未上报",
    report_stale: "上报已过期",
    connection_offline: "当前离线",
    agent_errors_ongoing: "Agent 仍在报错",
    agent_errors_historical: "历史错误",
    runtime_missing: "转发没有运行",
    runtime_revision_behind: "配置尚未生效",
    port_not_bound: "监听端口未占用",
    forward_apply_error: "转发应用失败",
    agent_version_behind: "Agent 版本落后",
    agent_version_unknown: "版本无法判定",
    resource_memory_high: "内存接近阈值",
    resource_disk_high: "数据盘接近阈值",
    resource_load_high: "负载接近阈值",
    role_mismatch: "角色不一致",
  },
  en: {
    no_credential: "Agent not installed",
    never_reported: "Never reported",
    report_stale: "Report is stale",
    connection_offline: "Currently offline",
    agent_errors_ongoing: "Agent is still failing",
    agent_errors_historical: "Historical error",
    runtime_missing: "Forward is not running",
    runtime_revision_behind: "Config not applied yet",
    port_not_bound: "Listen port is not bound",
    forward_apply_error: "Forward failed to apply",
    agent_version_behind: "Agent version behind",
    agent_version_unknown: "Version cannot be judged",
    resource_memory_high: "Memory near threshold",
    resource_disk_high: "Data disk near threshold",
    resource_load_high: "Load near threshold",
    role_mismatch: "Role mismatch",
  },
};

/** 理由码 → 「下一步做什么」（这才是可操作诊断，而不是重复一遍症状）。 */
const REASON_ACTION: Record<Locale, Record<HealthReasonCode, string>> = {
  zh: {
    no_credential: "在凭据区块签发节点凭据，并按安装命令部署 Agent。",
    never_reported: "确认 Agent 进程已启动且能连到面板；首次上报后本区块会自动更新。",
    report_stale: "检查 Agent 是否卡死或被防火墙拦截；超过心跳周期的上报说明节点已失去联系。",
    connection_offline: "确认节点网络/电源；掉线只是连接状态，恢复连接后 Health 会重新判定。",
    agent_errors_ongoing: "查看下方错误账本与节点上的 Agent 日志，先处理最近一条错误。",
    agent_errors_historical: "无需立即处理；如反复出现，按最近错误内容排查。",
    runtime_missing: "检查该转发是否被暂停/未下发，必要时重试下发或重启 Agent。",
    runtime_revision_behind: "等待下发完成；长时间不生效时对该转发重试。",
    port_not_bound: "该转发声明的监听端口没有被占用：检查端口是否被别的进程抢占或 Agent 换端口失败。",
    forward_apply_error: "打开该转发查看 apply 错误并重试（必要时修正配置）。",
    agent_version_behind: "升级该节点的 Agent 到期望版本。",
    agent_version_unknown: "Agent 版本格式无法比较；确认构建时写入了版本号。",
    resource_memory_high: "检查内存占用来源或扩容；资源紧张只影响健康提示，不等价于故障。",
    resource_disk_high: "清理数据盘或扩容；磁盘写满会导致 runtime 无法启动。",
    resource_load_high: "检查 CPU 占用进程；长期高负载会拖慢下发与转发。",
    role_mismatch: "对齐面板节点角色与 Agent 配置（Agent 自报仅供参考，以面板声明为准）。",
  },
  en: {
    no_credential: "Issue a node credential in the credential block and deploy the agent with the install command.",
    never_reported: "Check that the agent process is running and can reach the panel; this block updates on the first report.",
    report_stale: "Check whether the agent is hung or blocked by a firewall; a report older than a heartbeat means the node lost contact.",
    connection_offline: "Check node network/power. Being offline is a connection state; health is re-judged once it reconnects.",
    agent_errors_ongoing: "Read the error ledger below and the agent log on the node; fix the latest error first.",
    agent_errors_historical: "No immediate action; if it keeps happening, investigate using the last error message.",
    runtime_missing: "Check whether this forward is suspended or never delivered; retry the rollout or restart the agent.",
    runtime_revision_behind: "Wait for the rollout to finish; retry this forward if it stays behind.",
    port_not_bound:
      "The listen port this forward declares is not bound: check whether another process took it or the agent failed to switch ports.",
    forward_apply_error: "Open the forward to see the apply error and retry (fix the config when needed).",
    agent_version_behind: "Upgrade this node's agent to the expected version.",
    agent_version_unknown: "The reported version cannot be compared; make sure the build writes a version string.",
    resource_memory_high: "Find what consumes the memory or add capacity; tight resources are a warning, not a failure.",
    resource_disk_high: "Free space on the data disk or add capacity; a full disk stops runtimes from starting.",
    resource_load_high: "Find the CPU consumers; sustained high load slows rollouts and forwarding.",
    role_mismatch: "Align the panel node role with the agent config (the agent-reported role is advisory; the panel wins).",
  },
};

/** 取面板文案。 */
export function nodeHealthText(locale: Locale): NodeHealthText {
  return locale === "en" ? en : zh;
}

/**
 * 理由标题：已知码走码表，未知码原样回落后端 message。
 *
 * 回落是**必须**的：后端新增理由码时，英文界面宁可显示中文原句，也不能空白
 * ——空白会让运维以为「没有理由」。
 */
export function reasonTitle(locale: Locale, code: string, fallback: string): string {
  const table = REASON_TITLE[locale === "en" ? "en" : "zh"];
  return (table as Record<string, string>)[code] ?? fallback;
}

/** 理由的下一步动作；未知码返回 null（不编造建议）。 */
export function reasonAction(locale: Locale, code: string): string | null {
  const table = REASON_ACTION[locale === "en" ? "en" : "zh"];
  return (table as Record<string, string>)[code] ?? null;
}

/** 导出供测试做两端键集一致性断言。 */
export const NODE_HEALTH_DICTS = { zh, en } as const;
export const NODE_HEALTH_REASON_CODES = Object.keys(REASON_TITLE.zh) as HealthReasonCode[];
