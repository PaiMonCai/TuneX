"use client";

/**
 * 节点 · Looking Glass（主动诊断）—— **自包含面板**，只吃 `nodeId`。
 *
 * ── 它做什么 ──
 *
 * 把已经完备的后端能力（`GET /api/looking-glass/status` + `POST /api/looking-glass/nodes/:id/tests`）
 * 接成用户可用的一个面板：读开关与上限 → 填目标 → **明确告知这是一次写操作** → 发起 → 按状态
 * 逐条呈现结果与口径声明。
 *
 * ── 四件必须如实呈现、且都有行为测试的事 ──
 *
 *  1. **缺省关闭**：`enabled:false` = "平台未开启这项诊断"（说出开关名与找谁开），**不是**"测试失败"；
 *     而 `platform_admin_override:true` 表示"你作为平台管理员仍可例外发起"——例外要写明是例外。
 *  2. **取不到状态 ≠ 没开启**：状态读取失败/载荷读不出来走**独立分支**（含"取不到"与重试），
 *     绝不落进"未开启"，也绝不渲染成"暂无数据"。
 *  3. **能力边界来自服务端**：只支持 `tcp_connect`；目标条数/超时上下限全部读 `caps`
 *     （界面**不硬编码** 4 / 3000 / 5000）；服务端 `caveats` 的**结论**用本面板的 zh/en 文案表达，
 *     数量与本地结论条数不一致时，把服务端原始声明也列出来（漂移要看得见，而不是被藏起来）。
 *  4. **发起是写操作**：按钮上方固定写明"该节点会向目标发起真实 TCP 连接并写审计"；
 *     "还没发起"与"发起了但没拿到结果"是两个状态（`lookingGlassFailureKind`），
 *     后者**不能**说成"没有发出"——ACK 超时下拨没拨过，面板无法确认。
 *
 * 文案走组件内 zh/en 表（`locale` 由 props / i18n 上下文给出），**不写** `lib/i18n/dictionaries.ts`。
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, PlayCircle, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, InfoRow } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/providers";
import { useWorkspace } from "@/components/workspace/workspace-context";
import {
  LOOKING_GLASS_CODES,
  lookingGlassApi,
  lookingGlassErrorMessageOf,
  lookingGlassErrorCodeOf,
  lookingGlassFailureKind,
  lookingGlassIsPermissionFailure,
  type LookingGlassFailureKind,
  type LookingGlassReport,
  type LookingGlassResultRow,
  type LookingGlassStatus,
  type LookingGlassTarget,
} from "@/lib/api/looking-glass";
import { createPermissionRequestFence } from "@/lib/workspace-permissions";
import { formatDateTime } from "@/lib/utils";
import type { Locale } from "@/lib/i18n";

/* ================================================================== */
/* 文案（zh/en；服务端 caveats 的**结论**，不是文案）                    */
/* ================================================================== */

export interface LookingGlassCopy {
  title: string;
  subtitle: string;
  writeWarning: string;
  statusLoading: string;
  statusUnavailable: string;
  statusUnavailableNext: string;
  retry: string;
  disabledTitle: string;
  disabledDetail: (switchEnv: string) => string;
  disabledNext: string;
  adminOverrideBadge: string;
  adminOverrideDetail: string;
  permissionTitle: string;
  permissionDetail: string;
  permissionNext: string;
  capsLine: (maxTargets: number, defaultTimeout: number, maxTimeout: number) => string;
  methodLine: (method: string) => string;
  scopeLine: string;
  caveatsTitle: string;
  caveats: readonly string[];
  rawCaveatsTitle: string;
  targetHost: string;
  targetPort: string;
  addTarget: string;
  removeTarget: string;
  maxTargetsHint: (max: number) => string;
  timeoutLabel: string;
  timeoutHint: (defaultMs: number, maxMs: number) => string;
  run: string;
  running: string;
  notRunYet: string;
  reportTitle: string;
  generatedAt: string;
  adminOverrideRun: string;
  enabledRun: string;
  pinnedTitle: string;
  pinnedNote: string;
  resultsTitle: string;
  elapsed: (ms: number) => string;
  detailLabel: string;
  resultStatus: Record<string, string>;
  unknownResultStatus: (raw: string) => string;
  refusedTitle: string;
  refusedNotIssued: string;
  refusedIssuedNoResult: string;
  refusedUnknown: string;
  refusedNext: string;
  refusalGuess: string;
}

const ZH: LookingGlassCopy = {
  title: "Looking Glass（从该节点主动探测）",
  subtitle: "让这台节点对公网目标发起一次有界 TCP 连接测试，并把结果逐条报回来。",
  writeWarning:
    "发起测试是一次写操作：这台节点会真的向目标地址发起 TCP 连接，并写一条审计记录（结果不落库）。",
  statusLoading: "正在读取该诊断的开关与上限…",
  statusUnavailable: "取不到 Looking Glass 的状态",
  statusUnavailableNext:
    "这不等于「平台未开启」，也不等于「节点有问题」——请重试；若一直取不到，请检查节点接口与权限。",
  retry: "重试",
  disabledTitle: "平台未开启这项诊断",
  disabledDetail: (switchEnv) =>
    `本部署没有把 ${switchEnv} 设为真值（缺省关闭：拼写错误、空值都算关闭）。这不是测试失败，也没有向任何目标发过包。`,
  disabledNext: "需要这项能力请联系平台管理员开启；开启后这里会直接出现测试表单。",
  adminOverrideBadge: "管理员例外",
  adminOverrideDetail:
    "平台没有开启这项诊断，但你是平台管理员：可以例外发起。这是例外，不是常态——普通成员在这里看不到测试入口。",
  permissionTitle: "没有权限使用这项诊断",
  permissionDetail: "服务端拒绝了这次请求：当前工作空间角色不足以读取节点或发起主动测试。",
  permissionNext: "需要 node:read（以及该能力本身已开启）；请联系工作空间管理员。",
  capsLine: (maxTargets, defaultTimeout, maxTimeout) =>
    `服务端上限：单次最多 ${maxTargets} 个目标；单次超时 ${defaultTimeout}ms（缺省）…${maxTimeout}ms（硬上限）。`,
  methodLine: (method) => `本版本只支持方法 ${method}（未知方法被拒绝，不降级）。`,
  scopeLine: "只允许公网单播目标：私网 / 回环 / 链路本地 / 多播 / 保留段一律在发包前拒绝。",
  caveatsTitle: "口径声明（决定这些结果能证明什么）",
  caveats: [
    "连上只证明这一跳的 L3/L4 通，不证明对端业务可用。",
    "域名由面板解析、节点只拨固定地址：因此它回答不了「节点侧 DNS 能否解析这个域名」。",
    "不含 UDP/ICMP：本版本不产生 datagram 的事实。",
    "结果不含任何数据面载荷与凭据，只有地址、端口、状态与耗时；每一次发起与拒绝都会写审计。",
  ],
  rawCaveatsTitle: "服务端原始声明（未翻译；条数与本地结论不一致时列出）",
  targetHost: "目标地址或域名",
  targetPort: "端口",
  addTarget: "再加一个目标",
  removeTarget: "移除",
  maxTargetsHint: (max) => `一次最多 ${max} 个目标（服务端硬上限，超限会被拒绝而不是截断）。`,
  timeoutLabel: "单次超时（毫秒）",
  timeoutHint: (defaultMs, maxMs) => `留空用服务端缺省 ${defaultMs}ms；上限 ${maxMs}ms。`,
  run: "发起测试（写操作）",
  running: "已发起，等待节点回报…",
  notRunYet: "本轮还没有发起过测试。",
  reportTitle: "本次结果",
  generatedAt: "报告生成时间",
  adminOverrideRun: "本次因管理员例外而执行（平台开关仍是关闭）。",
  enabledRun: "本次按平台开关正常执行。",
  pinnedTitle: "面板解析并钉死的地址",
  pinnedNote: "节点只拨这些字面地址、不做名称解析；域名到地址的映射由面板完成。",
  resultsTitle: "逐条结果",
  elapsed: (ms) => `${ms} ms`,
  detailLabel: "服务端补充",
  resultStatus: {
    reachable: "TCP 握手完成（只说明这一跳的 L3/L4 通了）",
    refused: "对端（或前面某层）主动拒绝",
    timeout: "死线内没有应答（可能是静默丢包或防火墙）",
    dns_error: "名字没有解析成功",
    invalid_target: "这个目标本身不可用（地址/端口写法问题）",
    error: "这次探测以其它错误结束（见服务端补充）",
    unsupported: "这个请求超出了该节点当前能做的事",
  },
  unknownResultStatus: (raw) => `服务端返回了未知状态「${raw}」：本界面不猜它的含义。`,
  refusedTitle: "本次发起被拒绝",
  refusedNotIssued: "这次没有发出任何测试（拒绝发生在发包之前）。",
  refusedIssuedNoResult: "这次已经下发到节点，但没有拿到可用结果：是否真的拨过目标，面板无法确认。",
  refusedUnknown: "服务端的拒绝码不在已知集合里：请按下方的原句判断（本界面不猜它有没有发包）。",
  refusedNext: "拒绝原因与下一步见下方原句；同一节点同一时刻只允许一个测试在途。",
  refusalGuess: "已知原因",
};

const EN: LookingGlassCopy = {
  title: "Looking Glass (probe from this node)",
  subtitle: "Have this node run one bounded TCP connect test against public targets and report each result.",
  writeWarning:
    "Running a test is a write: this node will open real TCP connections to the targets and write an audit record (results are not stored).",
  statusLoading: "Reading the switch and limits for this diagnostic…",
  statusUnavailable: "Could not read the Looking Glass status",
  statusUnavailableNext:
    "That is not the same as “the platform did not enable it”, nor “the node is broken” — retry; if it stays unavailable, check the nodes API and your permissions.",
  retry: "Retry",
  disabledTitle: "The platform did not enable this diagnostic",
  disabledDetail: (switchEnv) =>
    `This deployment does not set ${switchEnv} to a truthy value (off by default: typos and empty values count as off). This is not a failed test, and no packet was sent anywhere.`,
  disabledNext: "Ask a platform admin to enable it; once enabled the test form appears right here.",
  adminOverrideBadge: "admin exception",
  adminOverrideDetail:
    "The platform did not enable this diagnostic, but you are a platform admin: you may run it as an exception. It is an exception, not the norm — regular members see no test entry here.",
  permissionTitle: "You do not have permission to use this diagnostic",
  permissionDetail: "The server refused this request: the current workspace role is not enough to read nodes or to run active tests.",
  permissionNext: "node:read is required (and the capability must be enabled); ask a workspace admin.",
  capsLine: (maxTargets, defaultTimeout, maxTimeout) =>
    `Server limits: at most ${maxTargets} target(s) per run; per-attempt timeout ${defaultTimeout}ms (default)…${maxTimeout}ms (hard cap).`,
  methodLine: (method) => `This version supports ${method} only (unknown methods are refused, not downgraded).`,
  scopeLine: "Public unicast targets only: private / loopback / link-local / multicast / reserved ranges are refused before any packet.",
  caveatsTitle: "What these results can and cannot prove",
  caveats: [
    "A completed handshake proves this hop's L3/L4 only — not that the peer's service works.",
    "The panel resolves names and the node dials fixed addresses: so this cannot answer “can the node resolve that name”.",
    "No UDP/ICMP: this version produces no datagram facts.",
    "Results carry no data-plane payload and no credentials — only address, port, status and elapsed time; every run and refusal is audited.",
  ],
  rawCaveatsTitle: "Server's raw statement (untranslated; shown when its count differs from the local conclusions)",
  targetHost: "Target host or name",
  targetPort: "Port",
  addTarget: "Add another target",
  removeTarget: "Remove",
  maxTargetsHint: (max) => `At most ${max} target(s) per run (server hard cap; over-limit is refused, never truncated).`,
  timeoutLabel: "Per-attempt timeout (ms)",
  timeoutHint: (defaultMs, maxMs) => `Leave empty for the server default ${defaultMs}ms; cap ${maxMs}ms.`,
  run: "Run test (write)",
  running: "Issued, waiting for the node…",
  notRunYet: "No test has been run in this session yet.",
  reportTitle: "This run",
  generatedAt: "Report generated at",
  adminOverrideRun: "This run happened through the admin exception (the platform switch is still off).",
  enabledRun: "This run followed the platform switch normally.",
  pinnedTitle: "Addresses resolved and pinned by the panel",
  pinnedNote: "The node dials these literal addresses and does no name resolution; the name→address mapping happens here on the panel.",
  resultsTitle: "Per-target results",
  elapsed: (ms) => `${ms} ms`,
  detailLabel: "Server detail",
  resultStatus: {
    reachable: "TCP handshake completed (this hop's L3/L4 only)",
    refused: "Actively refused by the peer (or something in front of it)",
    timeout: "No answer before the deadline (silent drop or firewall)",
    dns_error: "The name did not resolve",
    invalid_target: "The target itself was unusable (address/port form)",
    error: "The probe ended with another error (see the server detail)",
    unsupported: "The request asked for something this node cannot do",
  },
  unknownResultStatus: (raw) => `The server returned an unknown status “${raw}”: this panel does not guess what it means.`,
  refusedTitle: "This run was refused",
  refusedNotIssued: "No test was sent this time (the refusal happened before any packet).",
  refusedIssuedNoResult: "This was issued to the node but no usable result came back: whether the target was actually dialed cannot be confirmed here.",
  refusedUnknown: "The refusal code is not in the known set: read the original message below (this panel does not guess whether a packet went out).",
  refusedNext: "The reason and the next step are in the message below; one node allows a single in-flight test at a time.",
  refusalGuess: "Known reason",
};

const COPY: Record<Locale, LookingGlassCopy> = { zh: ZH, en: EN };

export function lookingGlassCopy(locale: Locale): LookingGlassCopy {
  return COPY[locale];
}

/** 已知拒绝码 → 一句"为什么"（下一步统一在 refusedNext / 原句）。未知码返回 `null`，不编。 */
export function refusalReasonText(locale: Locale, code: string | null): string | null {
  const table: Record<string, [string, string]> = {
    [LOOKING_GLASS_CODES.disabled]: [
      "平台未开启这项诊断（缺省关闭），且你不是平台管理员",
      "the platform did not enable this diagnostic (off by default) and you are not a platform admin",
    ],
    [LOOKING_GLASS_CODES.busy]: [
      "该节点已有一个测试在途（单飞：同一节点同一时刻只允许一个）",
      "this node already has a test in flight (single-flight per node)",
    ],
    [LOOKING_GLASS_CODES.notFound]: [
      "节点不存在，或不属于当前工作空间",
      "the node does not exist, or is not in the current workspace",
    ],
    [LOOKING_GLASS_CODES.targetNotPublic]: [
      "目标不是公网单播地址（私网/回环/链路本地/多播/保留段在发包前就被拒绝）",
      "the target is not public unicast (private/loopback/link-local/multicast/reserved are refused before any packet)",
    ],
    [LOOKING_GLASS_CODES.tooManyTargets]: [
      "目标数量不合法：至少 1 个、最多服务端上限（超限拒绝，不截断）",
      "invalid target count: at least 1 and at most the server cap (over-limit is refused, never truncated)",
    ],
    [LOOKING_GLASS_CODES.tooManyAddresses]: [
      "域名解析出的地址数超过钉死上限",
      "the name resolved to more addresses than the pinning cap allows",
    ],
    [LOOKING_GLASS_CODES.duplicateTarget]: ["同一个目标重复出现", "the same target was listed twice"],
    [LOOKING_GLASS_CODES.invalidPort]: ["端口不是 1-65535 的整数", "the port is not an integer in 1-65535"],
    [LOOKING_GLASS_CODES.invalidHostname]: ["目标不是合法的 {host, port}", "the target is not a valid {host, port}"],
    [LOOKING_GLASS_CODES.addressNotCanonical]: [
      "地址写法不规范（十进制/八进制/十六进制/短写一律拒绝，不 reinterpret）",
      "the address is not canonical (decimal/octal/hex/short forms are refused, never reinterpreted)",
    ],
    [LOOKING_GLASS_CODES.specialUseName]: [
      "目标是特殊用途域名（如 .local/.internal），不是公网可解析的名字",
      "the name is a special-use domain (e.g. .local/.internal), not a public name",
    ],
    [LOOKING_GLASS_CODES.targetUnresolved]: ["域名没有解析到任何地址", "the name resolved to nothing"],
    [LOOKING_GLASS_CODES.resolverInvalid]: ["解析器返回了非字符串地址", "the resolver returned a non-string address"],
    [LOOKING_GLASS_CODES.methodNotSupported]: ["本版本只支持 tcp_connect", "this version supports tcp_connect only"],
    [LOOKING_GLASS_CODES.timeoutOutOfRange]: [
      "超时超出服务端允许范围（1…硬上限，整数毫秒）",
      "the timeout is outside the server range (1…hard cap, whole milliseconds)",
    ],
    [LOOKING_GLASS_CODES.auditUnavailable]: [
      "审计写入失败：服务端拒绝发起一次没有留痕的主动测试",
      "the audit write failed: the server refuses to run an active test that leaves no record",
    ],
    [LOOKING_GLASS_CODES.upgradeRequired]: [
      "该节点的 Agent 还没广告这个动作（需要升级 Agent）",
      "this node's agent has not advertised this action yet (an agent upgrade is required)",
    ],
    [LOOKING_GLASS_CODES.incompatibleAgent]: [
      "该 Agent 与控制协议的版本不兼容",
      "that agent is incompatible with the control protocol version",
    ],
    [LOOKING_GLASS_CODES.runtimeFeatureNotSupported]: [
      "该 Agent 明确不支持这个运行时特性",
      "that agent explicitly does not support this runtime feature",
    ],
    [LOOKING_GLASS_CODES.malformedCapabilityManifest]: [
      "该节点上报的能力清单不合法",
      "the node's reported capability manifest is malformed",
    ],
    [LOOKING_GLASS_CODES.ackTimeout]: [
      "节点没有在预算内回报（请求已下发，但没有结果）",
      "the node did not answer within the budget (the request was issued, but no result came back)",
    ],
    [LOOKING_GLASS_CODES.agentFailed]: ["Agent 执行失败", "the agent failed to execute it"],
    [LOOKING_GLASS_CODES.incompleteResult]: [
      "节点返回的结果条数与请求不符（拒绝把不完整的结果当成事实）",
      "the node returned a different number of rows than requested (an incomplete answer is not treated as fact)",
    ],
    [LOOKING_GLASS_CODES.invalidResult]: ["节点返回的结果不合规", "the node returned a non-conforming result"],
    [LOOKING_GLASS_CODES.permissionDenied]: [
      "当前工作空间角色没有这项权限",
      "the current workspace role lacks this permission",
    ],
  };
  if (code === null) return null;
  const entry = table[code.toLowerCase()];
  if (!entry) return null;
  return locale === "en" ? entry[1] : entry[0];
}

/* ================================================================== */
/* 视图选择（纯函数：五态互不冒充）                                      */
/* ================================================================== */

export type LookingGlassPhase =
  | "loading"
  | "unavailable"
  | "permission_denied"
  | "disabled"
  | "admin_override"
  | "ready";

export type LookingGlassRunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "refused"; failure: LookingGlassFailureKind; code: string | null; message: string }
  | { kind: "report"; report: LookingGlassReport };

/**
 * 五态判定。**取不到状态**与**未开启**是两个分支（这是本面板最重要的一条纪律）：
 * 前者是我们不知道，后者是一个可行动的产品结论（说出开关名 + 找谁开）。
 */
export function lookingGlassPhase(status: LookingGlassStatus | null, readable: boolean): LookingGlassPhase {
  if (!readable) return "unavailable";
  if (status === null) return "loading";
  if (status.enabled) return "ready";
  return status.platform_admin_override ? "admin_override" : "disabled";
}

/** 结果行：闭集之外的状态走"未知"分支，绝不显示成某一种成功。 */
export function resultStatusText(locale: Locale, row: LookingGlassResultRow): string {
  const copy = lookingGlassCopy(locale);
  const known = Object.prototype.hasOwnProperty.call(copy.resultStatus, row.status);
  return known ? copy.resultStatus[row.status]! : copy.unknownResultStatus(row.status);
}

/* ================================================================== */
/* 展示体（纯展示：测试直接枚举各状态）                                   */
/* ================================================================== */

export interface LookingGlassPanelProps {
  phase: LookingGlassPhase;
  status: LookingGlassStatus | null;
  failureMessage?: string | null;
  locale: Locale;
  /** 目标草稿行（字符串，避免受控数字输入的中间态）。 */
  targets: LookingGlassTarget[];
  timeoutMs: string;
  run: LookingGlassRunState;
  onTargetChange: (index: number, patch: Partial<LookingGlassTarget>) => void;
  onAddTarget: () => void;
  onRemoveTarget: (index: number) => void;
  onTimeoutChange: (value: string) => void;
  onRun: () => void;
  onRetryStatus: () => void;
}

export function LookingGlassPanelBody(props: LookingGlassPanelProps) {
  const copy = lookingGlassCopy(props.locale);
  const { phase, status, run, locale } = props;

  if (phase === "loading") {
    return (
      <Card data-testid="looking-glass-panel">
        <CardHeader>
          <CardTitle>{copy.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="field-hint flex items-center gap-2" data-testid="looking-glass-loading">
            <Loader2 className="size-4 animate-spin" />
            {copy.statusLoading}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (phase === "unavailable") {
    return (
      <Card data-testid="looking-glass-panel">
        <CardHeader>
          <CardTitle>{copy.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="flex flex-col gap-2 rounded-md border border-[var(--warning,#eab308)]/60 bg-[var(--warning,#eab308)]/10 px-4 py-3"
            data-testid="looking-glass-status-unavailable"
            role="status"
          >
            <p className="text-sm font-medium">{copy.statusUnavailable}</p>
            <p className="text-xs text-[var(--muted-foreground)]">{copy.statusUnavailableNext}</p>
            {props.failureMessage ? (
              <p className="break-words font-mono text-xs text-[var(--muted-foreground)]">{props.failureMessage}</p>
            ) : null}
            <div>
              <Button variant="outline" size="sm" onClick={props.onRetryStatus} data-testid="looking-glass-retry-status">
                <RefreshCw className="size-4" />
                {copy.retry}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (phase === "permission_denied") {
    return (
      <Card data-testid="looking-glass-panel">
        <CardHeader>
          <CardTitle>{copy.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-xs" data-testid="looking-glass-permission-denied">
            <p className="text-sm font-medium">{copy.permissionTitle}</p>
            <p className="mt-0.5 text-[var(--muted-foreground)]">{copy.permissionDetail}</p>
            {props.failureMessage ? (
              <p className="mt-0.5 break-words font-mono text-[var(--muted-foreground)]">{props.failureMessage}</p>
            ) : null}
            <p className="mt-0.5 text-[var(--muted-foreground)]">{copy.permissionNext}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (phase === "disabled") {
    return (
      <Card data-testid="looking-glass-panel">
        <CardHeader>
          <CardTitle>{copy.title}</CardTitle>
          <CardDescription>{copy.subtitle}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-xs" data-testid="looking-glass-disabled">
            <p className="text-sm font-medium">{copy.disabledTitle}</p>
            <p className="mt-0.5 text-[var(--muted-foreground)]">
              {copy.disabledDetail(status?.switch_env ?? "LOOKING_GLASS_ENABLED")}
            </p>
            <p className="mt-0.5 text-[var(--muted-foreground)]">{copy.disabledNext}</p>
            {status ? (
              <p className="mt-1 text-[var(--muted-foreground)]" data-testid="looking-glass-caps">
                {copy.capsLine(status.caps.max_targets, status.caps.default_timeout_ms, status.caps.max_timeout_ms)}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    );
  }

  // ready / admin_override：都能发起（后者是例外，会显式标注）。
  const maxTargets = status?.caps.max_targets ?? 1;
  const defaultTimeout = status?.caps.default_timeout_ms ?? 3000;
  const maxTimeout = status?.caps.max_timeout_ms ?? 5000;

  return (
    <Card data-testid="looking-glass-panel">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {copy.title}
          {phase === "admin_override" ? (
            <Badge variant="outline" data-testid="looking-glass-admin-override">
              {copy.adminOverrideBadge}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>{copy.subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {phase === "admin_override" ? (
          <p
            className="rounded-md border border-[var(--warning,#eab308)]/60 bg-[var(--warning,#eab308)]/10 px-3 py-2 text-xs"
            data-testid="looking-glass-admin-override-detail"
          >
            {copy.adminOverrideDetail}
          </p>
        ) : null}

        {/* 能力边界：全部读服务端 caps。 */}
        <div className="text-xs text-[var(--muted-foreground)]">
          <p data-testid="looking-glass-caps">{copy.capsLine(maxTargets, defaultTimeout, maxTimeout)}</p>
          <p data-testid="looking-glass-method">{copy.methodLine(status?.method ?? "tcp_connect")}</p>
          <p data-testid="looking-glass-scope">{copy.scopeLine}</p>
        </div>

        <div className="rounded-md border border-[var(--border)] p-3" data-testid="looking-glass-form">
          <p className="text-xs" data-testid="looking-glass-write-warning">
            <ShieldAlert className="mr-1 inline size-3.5 align-[-2px]" />
            {copy.writeWarning}
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {props.targets.map((target, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2" data-testid={`looking-glass-target-${index}`}>
                <Field label={index === 0 ? copy.targetHost : undefined} className="min-w-[16rem] flex-1">
                  <Input
                    value={target.host}
                    onChange={(event) => props.onTargetChange(index, { host: event.target.value })}
                    placeholder="example.com"
                    data-testid={`looking-glass-target-host-${index}`}
                  />
                </Field>
                <Field label={index === 0 ? copy.targetPort : undefined} className="w-28">
                  <Input
                    value={target.port === 0 ? "" : String(target.port)}
                    inputMode="numeric"
                    onChange={(event) =>
                      props.onTargetChange(index, { port: Number(event.target.value.replace(/[^\d]/g, "")) || 0 })
                    }
                    placeholder="443"
                    data-testid={`looking-glass-target-port-${index}`}
                  />
                </Field>
                {props.targets.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => props.onRemoveTarget(index)}
                    data-testid={`looking-glass-remove-${index}`}
                  >
                    {copy.removeTarget}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
          <p className="mt-1 field-hint" data-testid="looking-glass-max-targets">
            {copy.maxTargetsHint(maxTargets)}
          </p>
          {props.targets.length < maxTargets ? (
            <Button variant="outline" size="sm" className="mt-1" onClick={props.onAddTarget} data-testid="looking-glass-add-target">
              {copy.addTarget}
            </Button>
          ) : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label={copy.timeoutLabel} hint={copy.timeoutHint(defaultTimeout, maxTimeout)}>
              <Input
                value={props.timeoutMs}
                inputMode="numeric"
                onChange={(event) => props.onTimeoutChange(event.target.value.replace(/[^\d]/g, ""))}
                placeholder={String(defaultTimeout)}
                data-testid="looking-glass-timeout"
              />
            </Field>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              onClick={props.onRun}
              disabled={run.kind === "running"}
              data-testid="looking-glass-run"
              data-running={run.kind === "running"}
            >
              {run.kind === "running" ? <Loader2 className="size-4 animate-spin" /> : <PlayCircle className="size-4" />}
              {run.kind === "running" ? copy.running : copy.run}
            </Button>
            {run.kind === "idle" ? (
              <span className="field-hint" data-testid="looking-glass-idle">
                {copy.notRunYet}
              </span>
            ) : null}
          </div>
        </div>

        {run.kind === "refused" ? (
          <div
            className="rounded-md border border-[var(--destructive)]/40 bg-[var(--destructive)]/5 px-3 py-2 text-xs"
            data-testid="looking-glass-refused"
            data-failure={run.failure}
          >
            <p className="text-sm font-medium">{copy.refusedTitle}</p>
            <p className="mt-0.5" data-testid="looking-glass-refused-issue">
              {run.failure === "not_issued"
                ? copy.refusedNotIssued
                : run.failure === "issued_without_result"
                  ? copy.refusedIssuedNoResult
                  : copy.refusedUnknown}
            </p>
            {refusalReasonText(locale, run.code) ? (
              <p className="mt-0.5" data-testid="looking-glass-refused-reason">
                {copy.refusalGuess}：{refusalReasonText(locale, run.code)}
              </p>
            ) : null}
            {run.code ? (
              <p className="mt-0.5 font-mono text-[var(--muted-foreground)]" data-testid="looking-glass-refused-code">
                {run.code}
              </p>
            ) : null}
            <p className="mt-0.5 break-words font-mono text-[var(--muted-foreground)]" data-testid="looking-glass-refused-message">
              {run.message}
            </p>
            {run.code !== null ? (
              <p className="mt-0.5 text-[var(--muted-foreground)]">{copy.refusedNext}</p>
            ) : null}
          </div>
        ) : null}

        {run.kind === "report" ? (
          <div className="flex flex-col gap-2" data-testid="looking-glass-report">
            <p className="text-sm font-medium">{copy.reportTitle}</p>
            <div className="flex flex-col">
              <InfoRow label={copy.generatedAt}>{formatDateTime(run.report.generated_at)}</InfoRow>
              <InfoRow label="method">{run.report.method}</InfoRow>
            </div>
            <p className="text-xs" data-testid="looking-glass-entry">
              {run.report.entry.admin_override ? copy.adminOverrideRun : copy.enabledRun}
            </p>
            <div className="text-xs" data-testid="looking-glass-pinned">
              <div className="text-[var(--muted-foreground)]">{copy.pinnedTitle}</div>
              <ul className="list-disc pl-4">
                {run.report.pinned_by_host.map((row) => (
                  <li key={row.host}>
                    {row.host} → {row.addresses.join("、")}
                  </li>
                ))}
              </ul>
              <p className="mt-0.5 text-[var(--muted-foreground)]">{copy.pinnedNote}</p>
            </div>
            <div className="text-xs" data-testid="looking-glass-results">
              <div className="text-[var(--muted-foreground)]">{copy.resultsTitle}</div>
              <ul className="flex flex-col gap-1">
                {run.report.results.map((row) => (
                  <li key={`${row.address}:${row.port}`} data-testid="looking-glass-result-row" className="rounded-md border border-[var(--border)] px-2 py-1">
                    <span className="font-mono">
                      {row.address}:{row.port}
                    </span>
                    <span className="mx-1">·</span>
                    <span>{resultStatusText(locale, row)}</span>
                    <span className="mx-1">·</span>
                    <span className="text-[var(--muted-foreground)]">{copy.elapsed(row.elapsed_ms)}</span>
                    {row.detail ? (
                      <span className="mt-0.5 block break-words font-mono text-[var(--muted-foreground)]">
                        {copy.detailLabel}: {row.detail}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        {/* 口径声明：本地 zh/en 结论；服务端声明条数不一致时把原始声明也列出来（漂移要看得见）。 */}
        <div className="text-xs" data-testid="looking-glass-caveats">
          <div className="text-[var(--muted-foreground)]">{copy.caveatsTitle}</div>
          <ul className="list-disc pl-4">
            {copy.caveats.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {status && status.caveats.length !== copy.caveats.length ? (
            <div className="mt-1" data-testid="looking-glass-raw-caveats">
              <div className="text-[var(--muted-foreground)]">{copy.rawCaveatsTitle}</div>
              <ul className="list-disc pl-4">
                {status.caveats.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/* ================================================================== */
/* 实时组件（自包含：只吃 nodeId）                                       */
/* ================================================================== */

const EMPTY_TARGETS: LookingGlassTarget[] = [{ host: "", port: 0 }];

export function LookingGlassPanel({ nodeId }: { nodeId: number | string }) {
  const { locale } = useI18n();
  const { currentId, permissionsLoading, can } = useWorkspace();
  const canRead = can("node:read");

  const [status, setStatus] = useState<LookingGlassStatus | null>(null);
  const [statusReadable, setStatusReadable] = useState(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [phaseOverride, setPhaseOverride] = useState<LookingGlassPhase>("loading");
  const [targets, setTargets] = useState<LookingGlassTarget[]>(EMPTY_TARGETS);
  const [timeoutMs, setTimeoutMs] = useState("");
  const [run, setRun] = useState<LookingGlassRunState>({ kind: "idle" });
  const [reloadToken, setReloadToken] = useState(0);
  const fence = useRef(createPermissionRequestFence());

  useEffect(() => {
    // 切 Workspace：作废在途读取（晚到的旧作用域结果不写状态）。
    const ticket = fence.current.next();
    setStatus(null);
    setStatusReadable(true);
    setStatusMessage(null);
    setTargets(EMPTY_TARGETS);
    setRun({ kind: "idle" });
    void (async () => {
      try {
        const result = await lookingGlassApi.readStatus();
        if (!fence.current.current(ticket)) return;
        if (!result.ok) {
          setStatusReadable(false);
          setStatusMessage(result.message);
          return;
        }
        setStatus(result.value);
      } catch (error) {
        if (!fence.current.current(ticket)) return;
        setStatusReadable(false);
        setStatusMessage(lookingGlassErrorMessageOf(error) ?? String(error));
        if (lookingGlassIsPermissionFailure(error)) setPhaseOverride("permission_denied");
      }
    })();
  }, [currentId, permissionsLoading, canRead, nodeId, reloadToken]);

  /**
   * 五态判定：**取不到**（不可读）与**没开启**（可读的 `enabled:false`）互不冒充；
   * 权限不足（本地权限投影说没有 `node:read`，或服务端 403 且不是 `disabled`）是第三种。
   */
  const phase: LookingGlassPhase =
    phaseOverride === "permission_denied" || (!canRead && !permissionsLoading)
      ? "permission_denied"
      : lookingGlassPhase(status, statusReadable);

  async function runTest() {
    if (run.kind === "running" || currentId === null) return;
    const usable = targets.filter((target) => target.host.trim() !== "" && target.port > 0);
    if (usable.length === 0) {
      // 本地校验：**没有**发出请求，也没有服务端拒绝码（因此不给"服务端原因"那一行）。
      setRun({
        kind: "refused",
        failure: "not_issued",
        code: null,
        message:
          locale === "en"
            ? "No usable target (host and port are required): this panel sent nothing."
            : "没有可用的目标（地址与端口必填）：本面板没有发出任何请求。",
      });
      return;
    }
    setRun({ kind: "running" });
    try {
      const result = await lookingGlassApi.runAndRead({
        workspaceId: currentId,
        nodeId,
        payload: {
          targets: usable,
          ...(timeoutMs.trim() === "" ? {} : { timeout_ms: Number(timeoutMs) }),
        },
      });
      if (!result.ok) {
        // 报告读不出来（形状不认识）≠ 有结果：如实说"这次没拿到可用结果"。
        setRun({
          kind: "refused",
          failure: "issued_without_result",
          code: null,
          message: result.message,
        });
        return;
      }
      setRun({ kind: "report", report: result.value });
    } catch (error) {
      const code = lookingGlassErrorCodeOf(error);
      setRun({
        kind: "refused",
        failure: lookingGlassFailureKind(code),
        code,
        message: lookingGlassErrorMessageOf(error) ?? "请求失败",
      });
    }
  }

  return (
    <LookingGlassPanelBody
      phase={phase}
      status={status}
      failureMessage={statusMessage}
      locale={locale}
      targets={targets}
      timeoutMs={timeoutMs}
      run={run}
      onTargetChange={(index, patch) =>
        setTargets((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
      }
      onAddTarget={() => setTargets((prev) => (prev.length >= (status?.caps.max_targets ?? 1) ? prev : [...prev, { host: "", port: 0 }]))}
      onRemoveTarget={(index) => setTargets((prev) => prev.filter((_, i) => i !== index))}
      onTimeoutChange={setTimeoutMs}
      onRun={() => void runTest()}
      onRetryStatus={() => setReloadToken((token) => token + 1)}
    />
  );
}
