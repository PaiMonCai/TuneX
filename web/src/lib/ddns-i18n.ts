/**
 * DDNS（DNS 前门）域的中英文案 + **只读判定**的纯函数。
 *
 * ── 为什么不进 `@/lib/i18n/dictionaries.ts` ──
 * 与 `node-health-i18n.ts` / `node-lifecycle-i18n.ts` 同一决策：并行分支各自持一份
 * 按码点表，避免两个分支在同一个大对象字面量上收口（本切片并行的是 task-2/task-4）。
 *
 * ── 这里的纯函数只做两件事 ──
 *   1. 把**服务端已有的事实**搬成文案（五态、退避、期望/确认值、错误码）；
 *   2. 明确表达"取不到"（`unavailable` / 空地址集）与"真的没有"的区别。
 * 一律**禁止**：自己算重试窗口/阈值、自己推"是否已切换"、自己拼地址。
 */
import { interpolate } from "./i18n";
import type { Locale } from "./i18n";
import {
  DDNS_ERROR_CODES,
  type DdnsErrorCode,
  type DnsBindingState,
  type DnsProviderType,
  type DnsState,
  type DnsProviderView,
} from "./types/ddns";

/** 五态的统一标签形状（"这一态是什么" + "为什么 / 下一步"）。 */
export interface DnsStateCopy {
  title: string;
  detail: string;
}

export interface DdnsText {
  /* ---------- 设置页：DNS 服务商 ---------- */
  title: string;
  subtitle: string;
  loading: string;
  /** 取不到（网络/权限/网关），**不是**"没有服务商"。 */
  unavailable: string;
  unavailableHint: string;
  retry: string;
  /** 真的读到了、但列表为空。 */
  empty: string;
  emptyHint: string;
  name: string;
  namePlaceholder: string;
  type: string;
  token: string;
  tokenPlaceholder: string;
  tokenHint: string;
  endpoint: string;
  endpointHint: string;
  optional: string;
  create: string;
  creating: string;
  created: string;
  createFailed: string;
  delete: string;
  deleteConfirmTitle: string;
  deleteConfirmBody: string;
  deleted: string;
  deleteFailed: string;
  platformBadge: string;
  platformHint: string;
  workspaceBadge: string;
  hasCredential: string;
  noCredential: string;
  createdAt: string;
  readOnlyHint: string;
  permissionUnknown: string;
  /** 密码/凭据类输入的成功提示：**只出现一次，不回填**。 */
  credentialDiscarded: string;

  /* ---------- Forward 详情：DNS 前门卡片 ---------- */
  cardTitle: string;
  cardSubtitle: string;
  cardLoading: string;
  cardUnavailable: string;
  cardUnavailableHint: string;
  state: Record<DnsState, DnsStateCopy>;
  domain: string;
  recordType: string;
  mode: string;
  provider: string;
  providerNone: string;
  expected: string;
  confirmed: string;
  expectedEmptyUnavailable: string;
  confirmedEmpty: string;
  syncedAt: string;
  never: string;
  lastError: string;
  attempts: string;
  autoResolve: string;
  autoResolveOn: string;
  autoResolveOff: string;
  autoResolveHint: string;
  autoResolveUnavailableHint: string;
  retryScheduled: string;
  retryNoPlan: string;
  retryAutoOff: string;
  bindTitle: string;
  bindDomain: string;
  bindDomainPlaceholder: string;
  bindProvider: string;
  bindAutoResolve: string;
  bindSubmit: string;
  binding: string;
  bound: string;
  bindFailed: string;
  unbind: string;
  unbinding: string;
  unbindConfirmTitle: string;
  unbindConfirmBody: string;
  unbound: string;
  unbindFailed: string;
  updateOnlyHint: string;
  /** 连 `forward:read` 都没有（与"取不到"、"未绑定"都不同）。 */
  forwardReadDenied: string;
  /** 服务商列表**读取失败**（≠ 列表为空）。 */
  providersLoadFailed: string;
  /** 未绑定时展示"将要写入的地址"（服务端推导，不是承诺）。 */
  expectedOnBind: string;
  /** 已绑定时不提供"直接改绑定"表单：改域名/服务商/自动同步必须先解绑（后端无 PATCH）。 */
  rebindHint: string;
  /** 只有 synced 才可以说的话（单独成词条，便于测试断言"其余四态绝不出现"）。 */
  claimSwitched: string;
  claimWrittenUnverified: string;
  claimPending: string;
  claimError: string;
  claimUnbound: string;
  modeSingleActive: string;
  modeMultiEntry: string;
  readBack: string;
  yes: string;
  no: string;
  /** G4(a)：`auto_resolve=true && provider_id=null` ⇒ 执行器不会写入（不是"稍后会好"）。 */
  warningNoProvider: string;
  /** 选中的 provider 不在可见列表里（跨作用域/已删除）；不允许把它显示成"未选择"。 */
  providerMissingFromList: string;
  /** provider 行的 `has_credential=false`：绑定会被服务端拒绝。 */
  providerCredentialBad: string;
  /** 读不到服务商列表（缺 settings:read）时的诚实说明。 */
  providersUnreadable: string;
  /** 可见列表为空时的诚实说明（不等于平台没配）。 */
  providersEmptyForBind: string;
  providerNoneOption: string;
  recordTypeLabel: Record<"A" | "AAAA" | "CNAME", string>;
  providerTypeLabel: Record<DnsProviderType, string>;
  /** 错误码 → 人话；未知码原样回落后端 message。 */
  errors: Record<string, string>;
}

const zh: DdnsText = {
  title: "DNS 服务商",
  subtitle: "为转发准备「DNS 前门」所需的凭据。凭据只写不读：保存后不会再显示，也不能取回。",
  loading: "正在读取 DNS 服务商…",
  unavailable: "取不到 DNS 服务商列表",
  unavailableHint: "这不代表本工作空间没有服务商，也不代表平台没有配置——请重试或检查权限。",
  retry: "重试",
  empty: "本工作空间还没有 DNS 服务商",
  emptyHint: "这只说明你可见的列表为空：不代表平台级配置不存在（平台级凭据只对平台管理员可见）。",
  name: "名称",
  namePlaceholder: "例如：生产 Cloudflare",
  type: "类型",
  token: "API 凭据（Token）",
  tokenPlaceholder: "粘贴服务商 API Token",
  tokenHint: "只写不读：提交后立即从页面清除，不回填、不显示、不进 URL/日志。留空的凭据无法用于绑定。",
  endpoint: "接口地址（可选）",
  endpointHint: "仅在自建/代理场景覆盖服务商默认端点，留空即用默认值。",
  optional: "可选",
  create: "添加服务商",
  creating: "正在添加…",
  created: "服务商已添加（凭据已提交，页面不再显示）",
  createFailed: "添加失败",
  delete: "删除",
  deleteConfirmTitle: "删除这个 DNS 服务商？",
  deleteConfirmBody:
    "删除只删除凭据本身：引用它的转发会在下次同步时报「provider 凭据不可用」；已经写入 DNS 的记录不会被自动回滚。",
  deleted: "已删除",
  deleteFailed: "删除失败",
  platformBadge: "平台级",
  platformHint: "平台级服务商对所有工作空间可见（仅平台管理员可管理）。",
  workspaceBadge: "本工作空间",
  hasCredential: "凭据已保存",
  noCredential: "凭据异常（未封存）",
  createdAt: "创建于",
  readOnlyHint: "当前角色只有查看权限（settings:read）：看不到凭据，也不能新增或删除。",
  permissionUnknown: "权限尚未确定：先按只读处理，等权限读取完成后再操作。",
  credentialDiscarded: "出于安全，输入框已清空；凭据不会再显示。",

  cardTitle: "DNS 前门（DDNS）",
  cardSubtitle: "把这条转发的入口地址写进你的域名解析，并在入口变化时跟随。",
  cardLoading: "正在读取 DNS 前门状态…",
  cardUnavailable: "取不到 DNS 前门状态",
  cardUnavailableHint: "这不代表没有绑定，更不能当成一切无事——请重试。",
  state: {
    unbound: { title: "未绑定", detail: "这条转发还没有 DNS 前门；面板不会替你改动任何解析记录。" },
    pending: {
      title: "已提交，等待写入",
      detail: "绑定请求已被服务端受理，但这不等于记录已经改好：执行器尚未确认写入。",
    },
    synced: { title: "已切换", detail: "服务端已读回确认：解析记录就是这里的期望地址。" },
    synced_unverified: {
      title: "已写入，尚未确认",
      detail: "写请求已发出，但面板还没读回确认值；此刻解析仍可能返回旧地址。",
    },
    error: { title: "同步失败", detail: "服务端报告了错误，见下方原因；自动同步会按服务端计划重试。" },
  },
  domain: "域名",
  recordType: "记录类型",
  mode: "形态",
  provider: "服务商",
  providerNone: "未选择服务商",
  expected: "期望地址（服务端推导）",
  confirmed: "已确认地址（服务端读回）",
  expectedEmptyUnavailable:
    "服务端没有给出期望地址：前门地址只能来自入口节点的 connect_ip。当前状态下服务端会以 dns_address_unavailable 拒绝绑定——面板不猜地址。",
  confirmedEmpty: "服务端还没有读回任何地址",
  syncedAt: "确认时间",
  never: "无",
  lastError: "服务端错误",
  attempts: "连续失败次数",
  autoResolve: "自动同步（跟随入口地址）",
  autoResolveOn: "已开启",
  autoResolveOff: "已关闭",
  autoResolveHint:
    "开启后，执行器会在入口地址变化时改写这条记录。注意：DNS 路径不可用时，自动迁移会被闸住（epoch 不动），不会带着不可用的地址下线。",
  autoResolveUnavailableHint: "自动同步开关需要 DNS 前门写权限（forward:update）。",
  retryScheduled: "服务端计划：将于 {time} 自动重试（已连续失败 {count} 次）",
  retryNoPlan: "服务端没有待重试的计划：不会自动重试",
  retryAutoOff: "自动同步已关闭：不会自动写入，也不会自动重试",
  bindTitle: "绑定 DNS 前门",
  bindDomain: "域名",
  bindDomainPlaceholder: "例如：node1.example.com",
  bindProvider: "服务商",
  bindAutoResolve: "开启自动同步",
  bindSubmit: "绑定",
  binding: "正在绑定…",
  bound: "已提交绑定（等待服务端写入）",
  bindFailed: "绑定失败",
  unbind: "解除绑定",
  unbinding: "正在解除…",
  unbindConfirmTitle: "解除这条转发的 DNS 前门？",
  unbindConfirmBody:
    "面板会清空这条转发的绑定记录，并不会替你回滚已经写入 DNS 的解析：请自行确认解析是否还指向可用地址。",
  unbound: "已解除绑定",
  unbindFailed: "解除绑定失败",
  updateOnlyHint: "当前角色没有 forward:update：可以查看 DNS 前门状态，但不能绑定或解绑。",
  forwardReadDenied: "当前角色没有 forward:read：看不到这条转发的 DNS 前门状态。",
  providersLoadFailed: "读取不到 DNS 服务商列表——这不代表没有服务商。可以提交不带服务商的绑定，但它不会被写入。",
  expectedOnBind: "将要写入的地址（服务端推导）",
  rebindHint: "要改域名、服务商或自动同步开关，请先解绑再重新绑定（面板不提供就地改写绑定）。",
  claimSwitched: "已切换",
  claimWrittenUnverified: "已写入，尚未确认",
  claimPending: "已提交，等待写入",
  claimError: "同步失败",
  claimUnbound: "未绑定",
  modeSingleActive: "单入口",
  modeMultiEntry: "多入口",
  readBack: "服务端读回确认",
  yes: "是",
  no: "否",
  warningNoProvider:
    "自动同步已开启，但没有选择服务商：执行器会报「provider 凭据不可用」，不会写入这条记录——请先选择一个服务商。",
  providerMissingFromList: "选中的服务商（id {id}）不在你可见的列表里",
  providerCredentialBad: "凭据不可用：绑定会被服务端拒绝",
  providersUnreadable: "读取不到服务商列表（需要 settings:read）：这里只能提交不带服务商的绑定。",
  providersEmptyForBind: "你可见的服务商列表为空（不代表平台没有凭据）：不带服务商的绑定不会被写入。",
  providerNoneOption: "（不选择服务商）",
  recordTypeLabel: { A: "A（IPv4）", AAAA: "AAAA（IPv6）", CNAME: "CNAME" },
  providerTypeLabel: { cloudflare: "Cloudflare", huawei: "华为云 DNS" },
  errors: {
    [DDNS_ERROR_CODES.ddns_not_found]: "这条转发不存在（或不属于当前工作空间）。",
    [DDNS_ERROR_CODES.dns_address_unavailable]:
      "入口节点没有可用的 connect_ip：前门地址只能来自它，面板不猜地址。请先给入口节点配置地址。",
    [DDNS_ERROR_CODES.dns_domain_invalid]: "域名不合法：需要是公网可解析的完整域名（含至少一个点）。",
    [DDNS_ERROR_CODES.dns_record_type_mismatch]:
      "记录类型与入口地址族不匹配：IPv4 用 A，IPv6 用 AAAA。",
    [DDNS_ERROR_CODES.dns_mode_record_type_conflict]: "多入口形态不支持 CNAME。",
    [DDNS_ERROR_CODES.dns_ttl_out_of_range]: "TTL 超出后端允许范围。",
    [DDNS_ERROR_CODES.dns_provider_not_found]: "选中的服务商不存在，或不属于当前工作空间。",
    [DDNS_ERROR_CODES.dns_provider_forbidden]: "该服务商是平台级的，只有平台管理员能使用。",
    [DDNS_ERROR_CODES.dns_provider_credential_invalid]: "该服务商的凭据不是可用的封存形态，拒绝用于绑定。",
    [DDNS_ERROR_CODES.shared_group_dns_denied]: "该入口组是平台共享组，租户凭据不得配置它的 DNS。",
    [DDNS_ERROR_CODES.dns_not_bound]: "这条转发本来就没有绑定 DNS 前门。",
    [DDNS_ERROR_CODES.dns_unavailable]: "DNS 前门当前不可用。",
    invalid_input: "提交的参数不合法，请检查域名、记录类型与服务商。",
    not_found: "目标不存在（或不属于当前工作空间）。",
    permission_denied: "当前工作空间角色没有这个操作的权限。",
  },
};

const en: DdnsText = {
  title: "DNS providers",
  subtitle:
    "Credentials for the DNS front door. Write-only: once saved they are never shown or returned.",
  loading: "Loading DNS providers…",
  unavailable: "Could not load the DNS provider list",
  unavailableHint:
    "This does not mean the workspace has none, nor that the platform has none — retry or check permissions.",
  retry: "Retry",
  empty: "No DNS provider in this workspace yet",
  emptyHint:
    "This only means the list you can see is empty; platform-level credentials are visible to platform admins only.",
  name: "Name",
  namePlaceholder: "e.g. Production Cloudflare",
  type: "Type",
  token: "API credential (token)",
  tokenPlaceholder: "Paste the provider API token",
  tokenHint:
    "Write-only: cleared from the page right after submit — never echoed, never placed in the URL or logs.",
  endpoint: "Endpoint (optional)",
  endpointHint: "Only to override the provider default for self-hosted/proxied setups.",
  optional: "optional",
  create: "Add provider",
  creating: "Adding…",
  created: "Provider added (credential submitted, no longer shown)",
  createFailed: "Could not add the provider",
  delete: "Delete",
  deleteConfirmTitle: "Delete this DNS provider?",
  deleteConfirmBody:
    "Deleting removes the credential only: forwards that reference it will report “provider credential unavailable”; records already written are not rolled back by the panel.",
  deleted: "Deleted",
  deleteFailed: "Could not delete the provider",
  platformBadge: "Platform-level",
  platformHint: "Visible to every workspace (platform admins manage it).",
  workspaceBadge: "This workspace",
  hasCredential: "Credential stored",
  noCredential: "Credential unusable (not sealed)",
  createdAt: "Created",
  readOnlyHint: "This role has settings:read only — credentials are hidden and create/delete is disabled.",
  permissionUnknown: "Permissions are not known yet: treated as read-only until loaded.",
  credentialDiscarded: "The input was cleared for safety; the credential will not be shown again.",

  cardTitle: "DNS front door (DDNS)",
  cardSubtitle: "Write this forward's ingress address into your DNS zone and follow it when it changes.",
  cardLoading: "Loading DNS front door status…",
  cardUnavailable: "Could not load the DNS front door status",
  cardUnavailableHint: "This does not mean it is unbound, and it must not be read as all-clear — retry.",
  state: {
    unbound: { title: "Not bound", detail: "No DNS front door for this forward; the panel will not touch your records." },
    pending: {
      title: "Submitted, waiting to be written",
      detail: "The bind request was accepted, but that is not the same as the record being updated.",
    },
    synced: { title: "Switched", detail: "The server read the record back and it matches the expected address." },
    synced_unverified: {
      title: "Written, not confirmed",
      detail: "The write was sent, but the panel has not read the value back yet; resolvers may still return the old address.",
    },
    error: { title: "Sync failed", detail: "The server reported an error — see the reason below; retries follow the server plan." },
  },
  domain: "Domain",
  recordType: "Record type",
  mode: "Mode",
  provider: "Provider",
  providerNone: "No provider selected",
  expected: "Expected addresses (derived by the server)",
  confirmed: "Confirmed addresses (read back by the server)",
  expectedEmptyUnavailable:
    "The server returned no expected address: the front-door address can only come from the ingress node's connect_ip. In this state the server rejects binding with dns_address_unavailable — the panel does not guess addresses.",
  confirmedEmpty: "The server has not read back any address yet",
  syncedAt: "Confirmed at",
  never: "none",
  lastError: "Server error",
  attempts: "Consecutive failures",
  autoResolve: "Auto-sync (follow the ingress address)",
  autoResolveOn: "on",
  autoResolveOff: "off",
  autoResolveHint:
    "When on, the executor rewrites this record as the ingress address changes. Note: while the DNS path is unavailable, automatic migration is gated (epoch does not move).",
  autoResolveUnavailableHint: "Toggling auto-sync requires forward:update.",
  retryScheduled: "The server plans to retry at {time} (after {count} consecutive failure(s))",
  retryNoPlan: "The server has no pending retry: it will not retry automatically",
  retryAutoOff: "Auto-sync is off: nothing is written and nothing is retried automatically",
  bindTitle: "Bind a DNS front door",
  bindDomain: "Domain",
  bindDomainPlaceholder: "e.g. node1.example.com",
  bindProvider: "Provider",
  bindAutoResolve: "Enable auto-sync",
  bindSubmit: "Bind",
  binding: "Binding…",
  bound: "Bind request submitted (waiting for the server to write)",
  bindFailed: "Could not bind",
  unbind: "Unbind",
  unbinding: "Unbinding…",
  unbindConfirmTitle: "Unbind the DNS front door of this forward?",
  unbindConfirmBody:
    "The panel clears the binding for this forward and does not roll back records already written — check that DNS still points somewhere usable.",
  unbound: "Unbound",
  unbindFailed: "Could not unbind",
  updateOnlyHint: "This role lacks forward:update: you can read the DNS front door but not bind or unbind.",
  forwardReadDenied: "This role lacks forward:read: the DNS front door status is not visible.",
  providersLoadFailed: "Could not load the DNS provider list — that does not mean there is none. A binding without a provider can be submitted, but it writes nothing.",
  expectedOnBind: "Address that will be written (derived by the server)",
  rebindHint: "To change the domain, provider or auto-sync, unbind first and bind again (no in-place edit).",
  claimSwitched: "Switched",
  claimWrittenUnverified: "Written, not confirmed",
  claimPending: "Submitted, waiting to be written",
  claimError: "Sync failed",
  claimUnbound: "Not bound",
  modeSingleActive: "single active ingress",
  modeMultiEntry: "multi entry",
  readBack: "Server read-back confirmed",
  yes: "yes",
  no: "no",
  warningNoProvider:
    "Auto-sync is on but no provider is selected: the executor reports “provider credential unavailable” and writes nothing — pick a provider first.",
  providerMissingFromList: "The selected provider (id {id}) is not in the list you can see",
  providerCredentialBad: "credential unusable: the server will reject binding",
  providersUnreadable: "The provider list is unreadable (needs settings:read): only a binding without a provider can be submitted here.",
  providersEmptyForBind: "The provider list you can see is empty (that does not mean the platform has none): a binding without a provider writes nothing.",
  providerNoneOption: "(no provider)",
  recordTypeLabel: { A: "A (IPv4)", AAAA: "AAAA (IPv6)", CNAME: "CNAME" },
  providerTypeLabel: { cloudflare: "Cloudflare", huawei: "Huawei Cloud DNS" },
  errors: {
    [DDNS_ERROR_CODES.ddns_not_found]: "This forward does not exist (or is not in this workspace).",
    [DDNS_ERROR_CODES.dns_address_unavailable]:
      "The ingress node has no usable connect_ip — the front-door address can only come from it, and the panel does not guess addresses.",
    [DDNS_ERROR_CODES.dns_domain_invalid]: "Invalid domain: it must be a fully qualified public name.",
    [DDNS_ERROR_CODES.dns_record_type_mismatch]: "Record type does not match the address family: use A for IPv4, AAAA for IPv6.",
    [DDNS_ERROR_CODES.dns_mode_record_type_conflict]: "Multi-entry mode does not support CNAME.",
    [DDNS_ERROR_CODES.dns_ttl_out_of_range]: "TTL is outside the range the backend accepts.",
    [DDNS_ERROR_CODES.dns_provider_not_found]: "The selected provider does not exist or is not in this workspace.",
    [DDNS_ERROR_CODES.dns_provider_forbidden]: "That provider is platform-level: only platform admins can use it.",
    [DDNS_ERROR_CODES.dns_provider_credential_invalid]: "That provider's credential is not in a usable sealed form.",
    [DDNS_ERROR_CODES.shared_group_dns_denied]: "That ingress group is platform-shared; tenant credentials may not configure its DNS.",
    [DDNS_ERROR_CODES.dns_not_bound]: "This forward was not bound to a DNS front door.",
    [DDNS_ERROR_CODES.dns_unavailable]: "The DNS front door is currently unavailable.",
    invalid_input: "The submitted values are invalid — check domain, record type and provider.",
    not_found: "Not found (or not in this workspace).",
    permission_denied: "This workspace role does not permit that action.",
  },
};

/** 供测试断言两端键集一致。 */
export const DDNS_DICTS = { zh, en } as const;

export function ddnsText(locale: Locale): DdnsText {
  return locale === "en" ? en : zh;
}

/** 已知错误码全集（含路由层也用的 `invalid_input` / `not_found` / `permission_denied`）。 */
export const DDNS_KNOWN_ERRORS = Object.keys(zh.errors);

/**
 * 错误码 → 人话。未知码/无码时**原样回落后端 message**（`fallback`），
 * 绝不编造一个更具体的理由，也绝不显示成"成功"。
 */
export function ddnsErrorText(locale: Locale, code: string | null | undefined, fallback: string): string {
  const table = ddnsText(locale).errors;
  if (code && Object.prototype.hasOwnProperty.call(table, code)) return table[code];
  return fallback;
}

/** 五态的标签。**只有 `synced` 的 title 里可以出现"已切换"**（见测试）。 */
export function dnsStateCopy(locale: Locale, state: DnsState): DnsStateCopy {
  return ddnsText(locale).state[state];
}

/** `verified`/`synced_at` 只对"已写入"的两态有意义；其余态一律不解释它们。 */
export function dnsSyncedAtText(locale: Locale, state: DnsBindingState, formatTime: (iso: string) => string): string {
  if (state.synced_at === null) return ddnsText(locale).never;
  return formatTime(state.synced_at);
}

/**
 * 「会重试」的**唯一**判据（`docs/agent/ddns-recon.md` §2）：
 * `auto_resolve === true && next_attempt_at !== null`。只看 `next_attempt_at` 会读错。
 *
 * 三支都**只读服务端字段**，没有一支是前端推出来的时间/阈值：
 *   · `unbound` ⇒ 忽略其余字段（契约明文），没有任何重试计划；
 *   · `auto_resolve !== true` ⇒ 执行器第一个分支就 noop（零外呼）⇒ 不会写入/不会重试；
 *   · 其余 ⇒ `next_attempt_at` 是否为 null 就是服务端的计划。
 */
export type DnsRetryFact =
  | { kind: "scheduled"; at: string; attempt: number | null }
  | { kind: "not_scheduled_no_plan" }
  | { kind: "not_scheduled_auto_off" };

export function dnsRetryFact(state: DnsBindingState): DnsRetryFact {
  if (state.state === "unbound") return { kind: "not_scheduled_no_plan" };
  if (state.auto_resolve !== true) return { kind: "not_scheduled_auto_off" };
  if (state.next_attempt_at === null) return { kind: "not_scheduled_no_plan" };
  return { kind: "scheduled", at: state.next_attempt_at, attempt: state.attempt_count };
}

export function willAutoRetry(state: DnsBindingState): boolean {
  return dnsRetryFact(state).kind === "scheduled";
}

export function dnsRetryText(
  locale: Locale,
  state: DnsBindingState,
  formatTime: (iso: string) => string,
): string {
  const text = ddnsText(locale);
  const fact = dnsRetryFact(state);
  if (fact.kind === "scheduled") {
    return interpolate(text.retryScheduled, {
      time: formatTime(fact.at),
      count: fact.attempt ?? 0,
    });
  }
  return fact.kind === "not_scheduled_auto_off" ? text.retryAutoOff : text.retryNoPlan;
}

/** 期望地址集是否由服务端给出。空集 ⇒ 不可用（**不是**"没有变化"）。 */
export function dnsAddressAvailable(state: DnsBindingState): boolean {
  return state.expected_values.length > 0;
}

/** 人话呈现地址集：空集时明说"服务端没有给出"，绝不显示猜测地址或 `-`。 */
export function dnsAddressText(locale: Locale, values: readonly string[], kind: "expected" | "confirmed"): string {
  if (values.length > 0) return values.join("、");
  const text = ddnsText(locale);
  return kind === "expected" ? text.expectedEmptyUnavailable : text.confirmedEmpty;
}

const RECORD_TYPE_KEYS = new Set(["A", "AAAA", "CNAME"]);

export function dnsRecordTypeText(locale: Locale, value: string | null): string {
  const text = ddnsText(locale);
  if (value === null) return text.never;
  return RECORD_TYPE_KEYS.has(value) ? text.recordTypeLabel[value as "A" | "AAAA" | "CNAME"] : value;
}

export function dnsModeText(locale: Locale, value: string | null): string {
  const text = ddnsText(locale);
  if (value === null) return text.never;
  if (value === "single_active") return text.modeSingleActive;
  if (value === "multi_entry") return text.modeMultiEntry;
  return value;
}

export function dnsProviderTypeText(locale: Locale, value: string): string {
  const table = ddnsText(locale).providerTypeLabel as Record<string, string>;
  return Object.prototype.hasOwnProperty.call(table, value) ? table[value] : value;
}

/**
 * 服务商一栏的**诚实**说法（G4(b)：`provider_id` 指到看不见的行时不许显示成"未选择"）。
 *
 *   ① 未绑定 / `provider_id === null` ⇒ "未选择服务商"；
 *   ② 选中的 id 不在可见列表里（跨作用域、已被删除、平台级）⇒ 明说"不在你可见的列表里"；
 *   ③ 在列表里 ⇒ 名称 + 类型；`has_credential=false` 时补一句"绑定会被拒绝"。
 */
export function dnsProviderDisplayText(
  locale: Locale,
  binding: DnsBindingState,
  providers: readonly DnsProviderView[] | null,
): string {
  const text = ddnsText(locale);
  if (binding.provider_id === null) return text.providerNone;
  const provider = providers?.find((row) => row.id === binding.provider_id) ?? null;
  if (!provider) return interpolate(text.providerMissingFromList, { id: binding.provider_id });
  const base = `${provider.name}（${dnsProviderTypeText(locale, provider.type)}）`;
  return provider.has_credential ? base : `${base} — ${text.providerCredentialBad}`;
}

/**
 * "为什么没写入"的可见警告（只由服务端字段判定，前端不加任何自己的阈值）：
 * `state !== "unbound" && auto_resolve === true && provider_id === null`
 * ⇒ 执行器读到 `dns_auto_resolve === true` 但没有可用凭据 ⇒ 报错、**不会写入**。
 */
export function dnsWriteWarningText(locale: Locale, binding: DnsBindingState): string | null {
  if (binding.state === "unbound") return null;
  if (binding.auto_resolve === true && binding.provider_id === null) return ddnsText(locale).warningNoProvider;
  return null;
}
