/**
 * V4-WP7 §13.4.2/§13.4.3 —— Node 生命周期操作面的中英文案。
 *
 * ── 为什么不进 `@/lib/i18n.ts` ──
 * 与 WP6 的 `node-health-i18n.ts` 同一决策：并行分支各自持一份按码点表，
 * 避免两个分支在同一个对象字面量上收口。两条分支落地后可整文件机械并入
 * i18n.ts（键名即下面的键）。
 *
 * ── 为什么按 `condition` 建表 ──
 * §13.5 明文：运行条件拒绝必须用**可区分**的错误码，Web 才能给用户正确的
 * 下一步。因此每个拒绝码都要有各自的「为什么」与「下一步」，
 * 而不是共用一句「操作失败」。未知码原样回落后端 message（不吞、不编造）。
 */
import type { Locale } from "./i18n";
import type { ImpactCountKey, InstallPhase } from "./node-lifecycle";
import type { NodeAdmissionRejection, NodeLifecycleConditionCode, NodeLifecycleValue } from "./types";

/** 提交生命周期变更前需要用户填写的备注上限（与后端 LIFECYCLE_NOTE_MAX 同值）。 */
export const LIFECYCLE_NOTE_MAX = 255;

export interface NodeLifecycleText {
  title: string;
  subtitle: string;
  mockHint: string;
  mockBadge: string;
  refresh: string;
  loading: string;
  loadFailed: string;
  retry: string;

  lifecycle: Record<NodeLifecycleValue, string>;
  lifecycleHint: Record<NodeLifecycleValue, string>;
  connection: Record<"waiting" | "online" | "offline", string>;

  acceptsNewBusiness: string;
  rejectsNewBusiness: string;
  noTransitions: string;
  transitionsTitle: string;
  noteLabel: string;
  notePlaceholder: string;
  noteHint: string;
  noteClearHint: string;
  /** 「当前生效的备注」（节点行 lifecycle_note），与输入框的「改成什么」区分。 */
  noteCurrent: string;
  /** 节点行上还没有备注时的占位。 */
  noteNone: string;
  applying: string;
  irreversibleHint: string;

  sectionImpact: string;
  impactEmpty: string;
  impactIngressForwards: string;
  impactEgressForwards: string;
  impactBindings: string;
  impactLeases: string;
  impactPools: string;
  impactBlockers: string;
  impactLoadFailed: string;
  impactStale: string;
  impactRefresh: string;

  sectionDelete: string;
  deleteHint: string;
  deleteAllowed: string;
  deleteBlocked: string;
  deleteConfirmTitle: string;
  deleteConfirmBody: string;
  deletePending: string;
  deleteSuccess: string;

  sectionRoleCheck: string;
  roleCheckOk: string;
  roleCheckBlocked: string;
  roleCheckPending: string;

  sectionInstall: string;
  installPhase: Record<InstallPhase, string>;
  installPhaseHint: Record<InstallPhase, string>;
  installReopen: string;
  installWaiting: string;
  installWaitingHint: string;
  installCommandTitle: string;
  installCommandHint: string;
  installCopy: string;
  installCopied: string;
  installClose: string;
  installPollStop: string;
  /** 命令有效期前缀（后面接服务端 `expires_at` 的格式化时间）。 */
  installExpiresLabel: string;
  /** 命令已过期（**只对真正等待安装的节点**显示，不能把 online/已装离线标成失败）。 */
  installExpiredHint: string;
  /** 取数失败：可恢复的提示，不得暗示成功或已连接。 */
  installPollError: string;
  /** 等待超时（30 分钟）：命令仍在，可继续等或重签。 */
  installTimeoutHint: string;
  /** 用户手动停止等待：状态不再自动更新，仍可重新开始。 */
  installBannerStoppedHint: string;
  /** 节点已在线时对本地命令的诚实提示：连接状态无法证明这条命令被消费过。 */
  installOnlineCommandNotice: string;
  /** 显式重新生成入口。 */
  installRegenerate: string;
  installRegenerateTitle: string;
  /** 旧命令里尚未使用的令牌立即失效。 */
  installRegenerateInvalidate: string;
  /** 已有凭据的节点：重装会在消费时轮换长期凭据、替换原 Agent。 */
  installRegenerateCredential: string;
  /** 已安装但离线：重签不修网络（避免把「重装」当修网手段）。 */
  installRegenerateOfflineHint: string;
  installRegenerateCancel: string;
  installRegenerateApply: string;

  conditionTitle: string;
  conditionAction: string;
  lifecycleChangeFailed: string;

  listLifecycleColumn: string;
  noLifecycleData: string;
}

const zh: NodeLifecycleText = {
  title: "节点生命周期",
  subtitle: "管理期望态（生命周期）与连接态是两件事：维护中的在线节点不是故障。",
  mockHint: "本区块来自前端 mock（WP5 生命周期端点契约已冻结，字段与之一致）。",
  mockBadge: "MOCK",
  refresh: "刷新生命周期",
  loading: "加载中…",
  loadFailed: "生命周期加载失败",
  retry: "重试",

  lifecycle: { active: "使用中", maintenance: "维护中", disabled: "已停用", retiring: "退役中" },
  lifecycleHint: {
    active: "正常承载端口转发，可作为新的入口/出口候选。",
    maintenance: "服务器升级/检查期间使用：已有运行态尽量保持，新的变更会等待，退出维护后只收敛到最新配置。",
    disabled: "不再接受任何新的转发、绑定或迁移；已有依赖不会被静默删除，需要在下方按清单处理。",
    retiring: "删除前的退役阶段：不接受新业务、依赖清单已锁定。清空依赖后才能物理删除。",
  },
  connection: { waiting: "等待安装", online: "在线", offline: "离线" },

  acceptsNewBusiness: "可接新业务",
  rejectsNewBusiness: "不接新业务",
  noTransitions: "当前状态下没有其它可迁移目标。",
  transitionsTitle: "生命周期操作",
  noteLabel: "原因备注",
  notePlaceholder: "例如：内核升级，预计 30 分钟",
  noteHint: "备注只用于展示与审计，不参与任何判定。",
  noteClearHint: "清空备注：提交时留空即清除，不改生命周期时不会动备注。",
  noteCurrent: "当前原因",
  noteNone: "未填写",
  applying: "提交中…",
  irreversibleHint: "退役是单向操作：进入后不能再回到其它生命周期，唯一的出口是清空依赖后删除节点。",

  sectionImpact: "依赖预览",
  impactEmpty: "该节点当前没有任何依赖（无转发、绑定、端口租约或出口池）。",
  impactIngressForwards: "入口转发",
  impactEgressForwards: "出口转发",
  impactBindings: "入口-出口绑定",
  impactLeases: "占用端口租约",
  impactPools: "出口池",
  impactBlockers: "阻塞原因",
  impactLoadFailed: "依赖统计加载失败（删除裁决仍以服务端返回为准）",
  impactStale: "依赖统计可能已过期，删除前请刷新。",
  impactRefresh: "刷新依赖",

  sectionDelete: "删除节点",
  deleteHint: "删除只清理附属数据（凭据/上报/租约）；端口转发一行都不会被隐式删除。",
  deleteAllowed: "依赖已清空且已进入退役，可以物理删除。",
  deleteBlocked: "还有依赖或尚未进入退役，服务端会拒绝删除。",
  deleteConfirmTitle: "删除节点",
  deleteConfirmBody: "删除后节点行消失，且不可恢复。确认删除",
  deletePending: "删除中…",
  deleteSuccess: "节点已删除",

  sectionRoleCheck: "角色 / 端口区间影响检查",
  roleCheckOk: "按当前输入，角色与端口区间变更不会影响已有转发与租约。",
  roleCheckBlocked: "该变更被拒绝",
  roleCheckPending: "检查中…",

  sectionInstall: "Agent 安装",
  installPhase: {
    awaiting_install: "等待安装",
    online: "已连接",
    installed_offline: "已安装，当前离线",
    unknown: "状态未知",
  },
  installPhaseHint: {
    awaiting_install: "尚未签发节点凭据。执行安装命令后本区块会在节点上线时自动更新。",
    online: "Agent 已连接并上报，安装闭环已达成。",
    installed_offline: "凭据已存在但当前不可达：这是连接问题，不是安装问题，请检查机器与网络（不要重复执行安装命令）。",
    unknown: "缺少足够的生命周期事实，请刷新后重试。",
  },
  installReopen: "重新生成安装命令",
  installWaiting: "等待节点上线…",
  installWaitingHint: "命令中的注册令牌 10 分钟内有效且只能使用一次。",
  installCommandTitle: "节点安装命令",
  installCommandHint: "在目标机器上以 root 执行；命令包含一次性注册令牌，请勿外传。",
  installCopy: "复制命令",
  installCopied: "安装命令已复制",
  installClose: "关闭",
  installPollStop: "停止等待",
  installExpiresLabel: "有效期至",
  installExpiredHint: "该安装命令已过期：命令里的注册令牌已失效，请点「重新生成命令」后再执行。",
  installPollError: "暂时取不到节点状态，正在继续重试…（已生成的安装命令不受影响）",
  installTimeoutHint: "已等待超过 30 分钟。安装命令仍保留在这里：请先在机器上确认命令是否执行、网络是否可达，或重新生成命令。",
  installBannerStoppedHint: "已停止等待：节点状态不会再自动更新。可以重新开始等待，或重新生成安装命令。",
  installOnlineCommandNotice:
    "节点已在线，但这里的注册令牌是一次性的，且连接状态无法证明它就是被这台机器用掉的那条。如果机器不是用这条命令装好的，令牌可能仍未使用——请勿拿到别处重复执行；确实要重装 Agent 时请显式「重新生成命令」。",
  installRegenerate: "重新生成命令",
  installRegenerateTitle: "重新生成安装命令",
  installRegenerateInvalidate: "重新生成后，旧命令里尚未使用的注册令牌会立即失效；已经复制过旧命令的机器需要改用新命令。",
  installRegenerateCredential: "该节点已有凭据：新命令在目标机器上被消费时会轮换长期凭据，原 Agent 身份会被替换。",
  installRegenerateOfflineHint: "重新生成命令不会修复离线：凭据已存在，这是连接问题。只有确实要重装 Agent 时才需要新命令。",
  installRegenerateCancel: "取消",
  installRegenerateApply: "重新生成",

  conditionTitle: "原因",
  conditionAction: "下一步",
  lifecycleChangeFailed: "生命周期变更被拒绝",

  listLifecycleColumn: "生命周期",
  noLifecycleData: "生命周期不可用",
};

const en: NodeLifecycleText = {
  title: "Node lifecycle",
  subtitle: "Desired management state (lifecycle) and connection state are separate: an online node in maintenance is not a failure.",
  mockHint: "This block comes from the frontend mock (the WP5 lifecycle endpoint contract is frozen; fields match it).",
  mockBadge: "MOCK",
  refresh: "Refresh lifecycle",
  loading: "Loading…",
  loadFailed: "Failed to load lifecycle",
  retry: "Retry",

  lifecycle: { active: "Active", maintenance: "Maintenance", disabled: "Disabled", retiring: "Retiring" },
  lifecycleHint: {
    active: "Carries port forwards normally and can be chosen as a new ingress/egress candidate.",
    maintenance: "For host upgrades and checks: existing runtimes are kept, new changes wait, and leaving maintenance converges to the latest config only.",
    disabled: "Accepts no new forwards, bindings or migrations. Existing dependencies are never deleted silently; work through the list below.",
    retiring: "The stage before deletion: no new business, dependency list locked. Dependencies must be cleared before the node can be deleted.",
  },
  connection: { waiting: "Awaiting install", online: "Online", offline: "Offline" },

  acceptsNewBusiness: "Accepts new business",
  rejectsNewBusiness: "Rejects new business",
  noTransitions: "No other lifecycle target is available from the current state.",
  transitionsTitle: "Lifecycle actions",
  noteLabel: "Reason note",
  notePlaceholder: "e.g. kernel upgrade, about 30 minutes",
  noteHint: "The note is display/audit only and never participates in any decision.",
  noteClearHint: "Clearing the note: submitting it empty removes it; not changing the lifecycle leaves the note untouched.",
  noteCurrent: "Current reason",
  noteNone: "not set",
  applying: "Submitting…",
  irreversibleHint: "Retiring is one-way: no other lifecycle can be reached from it. The only exit is deleting the node after clearing its dependencies.",

  sectionImpact: "Dependency preview",
  impactEmpty: "This node has no dependencies (no forwards, bindings, port leases or egress pools).",
  impactIngressForwards: "Ingress forwards",
  impactEgressForwards: "Egress forwards",
  impactBindings: "Ingress-egress bindings",
  impactLeases: "Active port leases",
  impactPools: "Egress pools",
  impactBlockers: "Blocking reasons",
  impactLoadFailed: "Failed to load dependency counts (the server still decides whether deletion is allowed)",
  impactStale: "Dependency counts may be stale; refresh before deleting.",
  impactRefresh: "Refresh dependencies",

  sectionDelete: "Delete node",
  deleteHint: "Deletion only removes attached data (credential/report/leases); port forwards are never deleted implicitly.",
  deleteAllowed: "Dependencies are clear and the node is retiring, so it can be deleted.",
  deleteBlocked: "Dependencies remain or the node is not retiring; the server will refuse the deletion.",
  deleteConfirmTitle: "Delete node",
  deleteConfirmBody: "The node row disappears and cannot be restored. Confirm deletion of",
  deletePending: "Deleting…",
  deleteSuccess: "Node deleted",

  sectionRoleCheck: "Role / port-range impact check",
  roleCheckOk: "With the current input, the role and port-range change affects no existing forward or lease.",
  roleCheckBlocked: "The change is rejected",
  roleCheckPending: "Checking…",

  sectionInstall: "Agent installation",
  installPhase: {
    awaiting_install: "Awaiting install",
    online: "Connected",
    installed_offline: "Installed, currently offline",
    unknown: "Unknown",
  },
  installPhaseHint: {
    awaiting_install: "No node credential yet. After running the install command this block updates when the node comes online.",
    online: "The agent is connected and reporting; the install loop is closed.",
    installed_offline: "A credential exists but the node is unreachable: this is a connectivity problem, not an install problem (do not re-run the install command).",
    unknown: "Not enough lifecycle facts yet; refresh and retry.",
  },
  installReopen: "Regenerate install command",
  installWaiting: "Waiting for the node to come online…",
  installWaitingHint: "The enrollment token is valid for 10 minutes and can be used once.",
  installCommandTitle: "Node install command",
  installCommandHint: "Run as root on the target host; the command carries a one-time enrollment token, do not share it.",
  installCopy: "Copy command",
  installCopied: "Install command copied",
  installClose: "Close",
  installPollStop: "Stop waiting",
  installExpiresLabel: "Valid until",
  installExpiredHint:
    "This install command has expired: its enrollment token no longer works. Choose “Regenerate command” and run the new one.",
  installPollError: "Cannot read the node state right now; still retrying… (the generated command is unaffected)",
  installTimeoutHint:
    "Waited over 30 minutes. The command is still here: check on the host whether it ran and whether the network is reachable, or regenerate the command.",
  installBannerStoppedHint:
    "Waiting stopped: the node state is no longer updated automatically. You can start waiting again, or regenerate the install command.",
  installOnlineCommandNotice:
    "The node is online, but the enrollment token here is one-time and the connection state cannot prove it was the one this host consumed. If the host was not installed with this command, the token may still be unused — do not run it elsewhere; regenerate the command explicitly when you really intend to reinstall the agent.",
  installRegenerate: "Regenerate command",
  installRegenerateTitle: "Regenerate install command",
  installRegenerateInvalidate:
    "Regenerating invalidates the unused enrollment token in the old command immediately; a host that copied the old command must use the new one.",
  installRegenerateCredential:
    "This node already has a credential: when the new command is consumed on the target host it rotates the long-term credential and replaces the original agent identity.",
  installRegenerateOfflineHint:
    "Regenerating will not fix the offline state: a credential already exists, so this is a connectivity problem. Only regenerate when you really intend to reinstall the agent.",
  installRegenerateCancel: "Cancel",
  installRegenerateApply: "Regenerate",

  conditionTitle: "Reason",
  conditionAction: "Next step",
  lifecycleChangeFailed: "Lifecycle change rejected",

  listLifecycleColumn: "Lifecycle",
  noLifecycleData: "Lifecycle unavailable",
};

/** 拒绝码 → 标题（未知码回落后端 message，不吞）。 */
const CONDITION_TITLE: Record<Locale, Record<NodeLifecycleConditionCode | NodeAdmissionRejection, string>> = {
  zh: {
    invalid_transition: "该生命周期迁移不被允许",
    node_in_maintenance: "节点维护中，不接受新业务",
    node_disabled: "节点已停用，不接受新业务",
    node_retiring: "节点退役中，不接受新业务",
    node_not_retiring: "删除前必须先进入退役",
    node_still_used_as_ingress: "仍有转发以该节点为入口",
    node_still_used_as_egress: "仍有转发以该节点为出口",
    dependency_blocked: "仍有依赖未清空",
    port_range_would_orphan_leases: "端口区间收缩会让已占用端口落到区间外",
    node_waiting_install: "该节点尚未完成安装",
  },
  en: {
    invalid_transition: "This lifecycle transition is not allowed",
    node_in_maintenance: "Node is in maintenance and accepts no new business",
    node_disabled: "Node is disabled and accepts no new business",
    node_retiring: "Node is retiring and accepts no new business",
    node_not_retiring: "The node must be retiring before deletion",
    node_still_used_as_ingress: "Forwards still use this node as ingress",
    node_still_used_as_egress: "Forwards still use this node as egress",
    dependency_blocked: "Dependencies are still attached",
    port_range_would_orphan_leases: "Shrinking the port range would orphan active leases",
    node_waiting_install: "This node has not finished installation",
  },
};

/** 拒绝码 → 「下一步做什么」（可操作，不是重复症状）。 */
const CONDITION_ACTION: Record<Locale, Record<NodeLifecycleConditionCode | NodeAdmissionRejection, string>> = {
  zh: {
    invalid_transition: "刷新后按「生命周期操作」里列出的可用目标重试（退役是单向门，无取消）。",
    node_in_maintenance: "退出维护（改为使用中）后再创建；已有转发保持运行。",
    node_disabled: "把它改回使用中后再选择它作为入口/出口。",
    node_retiring: "依赖清空并删除节点，或选择一个非退役节点。",
    node_not_retiring: "先点「退役中」，确认依赖清单为空后再删除。",
    node_still_used_as_ingress: "先在转发列表把这些转发的入口迁移到别的节点，再删除本节点。",
    node_still_used_as_egress: "先在转发列表把这些转发改成 DIRECT 或换出口节点，再删除本节点。",
    dependency_blocked: "按上方依赖预览逐项清空：绑定、端口租约、出口池。",
    port_range_would_orphan_leases: "先释放落在新区间外的端口租约，或放宽端口区间。",
    node_waiting_install: "先执行安装命令让节点上线，再回来创建转发。",
  },
  en: {
    invalid_transition: "Refresh and retry using the targets listed under “Lifecycle actions” (retiring is one-way, there is no cancel).",
    node_in_maintenance: "Leave maintenance (set it back to Active) and then create; existing forwards keep running.",
    node_disabled: "Set it back to Active before choosing it as ingress/egress.",
    node_retiring: "Clear dependencies and delete the node, or pick a node that is not retiring.",
    node_not_retiring: "Switch it to Retiring first, confirm the dependency list is empty, then delete.",
    node_still_used_as_ingress: "Migrate these forwards to another ingress node in the forwards list, then delete this node.",
    node_still_used_as_egress: "Switch these forwards to DIRECT or another egress node, then delete this node.",
    dependency_blocked: "Clear each item in the dependency preview: bindings, port leases, egress pools.",
    port_range_would_orphan_leases: "Release the leases outside the new range first, or widen the port range.",
    node_waiting_install: "Run the install command so the node comes online, then create the forward.",
  },
};

/** 依赖计数键 → 文案。 */
export function impactLabel(locale: Locale, key: ImpactCountKey): string {
  const txt = nodeLifecycleText(locale);
  const map: Record<ImpactCountKey, string> = {
    ingress_forward_count: txt.impactIngressForwards,
    egress_forward_count: txt.impactEgressForwards,
    binding_count: txt.impactBindings,
    active_port_lease_count: txt.impactLeases,
    egress_pool_count: txt.impactPools,
  };
  return map[key];
}

/** 取操作面文案。 */
export function nodeLifecycleText(locale: Locale): NodeLifecycleText {
  return locale === "en" ? en : zh;
}

/**
 * 拒绝码标题：已知码走码表，未知码原样回落后端 message。
 *
 * 回落是必须的：后端新增条件码时，界面宁可显示后端原句，也不能空白——
 * 空白会让管理员以为「操作失败但没原因」。
 */
export function conditionTitle(locale: Locale, code: string | null | undefined, fallback: string): string {
  if (!code) return fallback;
  const table = CONDITION_TITLE[locale === "en" ? "en" : "zh"];
  return (table as Record<string, string>)[code] ?? fallback;
}

/** 拒绝码的下一步动作；未知码返回 null（不编造建议）。 */
export function conditionAction(locale: Locale, code: string | null | undefined): string | null {
  if (!code) return null;
  const table = CONDITION_ACTION[locale === "en" ? "en" : "zh"];
  return (table as Record<string, string>)[code] ?? null;
}

/** 导出供测试做两端键集一致性断言。 */
export const NODE_LIFECYCLE_DICTS = { zh, en } as const;

/** 已知条件码全集（与后端 LifecycleConditionCode + node_waiting_install 对齐）。 */
export const NODE_LIFECYCLE_CONDITION_CODES = Object.keys(CONDITION_TITLE.zh) as NodeLifecycleConditionCode[];

/** 已有中英词条的条件码（测试据此断言「契约里的码都有翻译」）。 */
export const NODE_LIFECYCLE_TRANSLATED_CODES = Object.keys(CONDITION_TITLE.zh);
