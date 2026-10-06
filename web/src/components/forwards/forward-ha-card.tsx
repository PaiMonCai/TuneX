"use client";

/**
 * Forward 详情 · 高可用（多入口 / 首选入口）自包含卡片。
 *
 * 只吃 `forwardId`：挂载点由集成任务决定（本卡片**不**修改 `forward-detail.tsx`）。
 * 数据来自 `GET /api/forwards/:id/ha`（只读投影）与既有的
 * `PUT /api/forwards/:id/preferred-ingress`（设置/清除首选入口）。
 *
 * ── 这份界面最容易犯的四个错（本文件逐条兜住）──
 *
 *  1. **把 `policy=false` 说成"已启用/已保护"**：`FAILOVER_POLICY` **缺省即关**
 *     （生产缺省就是 `{"auto_failover":false,"auto_failback":false}`），所以 `false` 的
 *     唯一正确呈现是「平台未启用自动迁移」。这里不存在任何"已容灾 / 不会中断 / 业务不中断"
 *     的措辞：面板拿不到「不会中断」这种证据，说了就是撒谎。
 *  2. **把「期望」当「事实」**：`preferred_ingress_node_id` 是调度意图，可以是**一台此刻
 *     离线甚至维护中**的机器；`active_ingress_node_id` / `connection` /
 *     `accepts_new_business` 才是事实。三者在版面上分成三块，各自有独立 testid 与说明，
 *     并且首选入口那一块明写「首选 ≠ 在线 ≠ 能接业务 ≠ 会立刻迁移」。
 *  3. **把"取不到"渲染成"没有高可用"**：候选三态 `available` / `none` / `unavailable`
 *     各有独立 testid 与文案；`unavailable` 说的是"这次没读到"，不是"没有候选"。
 *  4. **切 Workspace 后让旧空间的晚到响应落到版面上**：所有取数走令牌守卫
 *     （`claim` / `invalidate` / `isCurrent`），过期响应直接丢弃（含成功与失败）。
 *
 * ── 写入口的边界 ──
 *
 *  `can_be_preferred` 只反映**写入路径自己检查的两条规则**（同入口组 + `role ∈ {ingress,both}`），
 *  所以一台 `connection=offline` 甚至 `lifecycle=maintenance` 的节点照样能被设为首选 ——
 *  界面上这些字段并列显示，绝不合成一句"可以接管"。真正的门槛（连续健康次数 + 冷却）
 *  由平台策略在后续节拍判，本卡片不重复判定、也不预告结果。
 *
 *  文案（zh/en）刻意留在本文件内，与 `forward-latency.tsx` / `forward-topology.tsx` 同样
 *  不碰 `lib/i18n/dictionaries.ts`，避免与并行切片争抢同一个字典文件。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18nOptional } from "@/components/providers";
import { useWorkspace } from "@/components/workspace/workspace-context";
import {
  FORWARD_HA_POLL_MS,
  forwardHaErrorInfo,
  getForwardHa,
  setForwardPreferredIngress,
  type ForwardHaCandidate,
  type ForwardHaErrorInfo,
  type ForwardHaOptionNode,
  type ForwardHaPolicy,
  type ForwardHaProjection,
} from "@/lib/api/forward-ha";
import { PERMISSION_DENIED } from "@/lib/workspace-permissions";
import type { Locale } from "@/lib/i18n";
import type { ID } from "@/lib/types";

/* ================================================================== */
/* 文案（zh / en）                                                      */
/* ================================================================== */

export interface HaCopy {
  title: string;
  subtitle: string;
  loading: string;
  deniedTitle: string;
  unavailableTitle: string;
  unavailableBody: string;
  unavailableNoAutoRetry: string;
  errorCode: string;
  reload: string;
  refreshing: string;
  /** 策略：两个开关都关（生产缺省）。**不得**说成"已启用/已保护"。 */
  policyOff: string;
  policyOffExplain: string;
  /** 策略：至少一个开关打开。 */
  policyOnFailover: string;
  policyOnFailback: string;
  policyOnCaveat: string;
  policyParseError: (detail: string) => string;
  policyReadOnly: string;
  expectationTitle: string;
  expectationSet: (name: string, nodeId: number) => string;
  expectationNone: string;
  expectationCaveat: string;
  factTitle: string;
  factNode: (name: string | null, nodeId: number) => string;
  factMissing: string;
  factFacts: (connection: string, accepts: string, lifecycle: string) => string;
  candidateTitle: string;
  candidateAvailable: (name: string, nodeId: number) => string;
  candidateAvailableCaveat: string;
  candidateNone: string;
  candidateNoneHint: string;
  candidateUnavailable: (reason: string) => string;
  candidateUnavailableCaveat: string;
  optionsUnavailable: string;
  chooseTitle: string;
  chooseHint: string;
  optionFacts: (connection: string, acceptsNewBusiness: string, lifecycle: string) => string;
  optionIsActive: string;
  optionIsPreferred: string;
  optionCannot: (reason: string) => string;
  setPreferred: string;
  setting: string;
  clearPreferred: string;
  clearing: string;
  writeErrorTitle: string;
  /** 后端原因码的可读解释（词表与 `preferred-ingress.ts` 同源）。 */
  writeRejections: Record<string, string>;
  connectionLabel: string;
  connection: Record<string, string>;
  acceptsYes: string;
  acceptsNo: (reason: string | null) => string;
  lifecycleLabel: string;
  lifecycle: Record<string, string>;
  roleLabel: string;
}

const ZH: HaCopy = {
  title: "高可用（首选入口 · 自动迁移）",
  subtitle:
    "只读事实 + 一个调度意图。这里展示的是面板当前已知的策略与归属，「首选入口」只是希望归谁，不代表已经迁移、在线、或者能接业务。",
  loading: "正在读取高可用事实…",
  deniedTitle: "没有查看高可用事实的权限",
  unavailableTitle: "高可用事实取不到",
  unavailableBody:
    "这次请求没有拿到数据，所以它不构成任何结论：既不能说明平台会迁移，也不能说明不会迁移。请刷新页面再试一次，或联系管理员。",
  unavailableNoAutoRetry: "本卡片不会自动重试失败：重试不会让缺失的事实出现。",
  errorCode: "后端返回",
  reload: "重新读取",
  refreshing: "读取中…",
  policyOff: "平台未启用自动迁移：这条转发不会因为入口故障而自动改归属。",
  policyOffExplain:
    "这是本部署当前的策略真值（`FAILOVER_POLICY` 缺省即关），不是这条转发的问题，也不是「暂时」的状态。需要平台自动迁移时，由运维显式打开。",
  policyOnFailover:
    "平台已启用自动迁移（auto_failover）：满足策略条件时，平台会尝试把归属迁到组内另一台合格入口。",
  policyOnFailback:
    "平台已启用自动回切（auto_failback）：满足策略条件时，平台会尝试把归属迁回首选入口。",
  policyOnCaveat:
    "一次迁移会带来短暂中断；是否发生、什么时候发生，取决于每一拍的候选、健康连续次数与冷却判定 —— 本卡片不做预告。",
  policyParseError: (detail) =>
    `平台策略配置无法解析（${detail}）：平台按「未启用」处理（fail-closed）。这是"配置坏了"，不是"运维没开"，下一步是修配置。`,
  policyReadOnly: "策略是只读的：本卡片不提供开关，避免界面与运维配置成为两份真相。",
  expectationTitle: "首选入口（期望）",
  expectationSet: (name, nodeId) => `已设置：${name}（#${nodeId}）`,
  expectationNone: "没有设置首选入口：平台不会把它当作回切目标（当前行为）。",
  expectationCaveat:
    "首选只是期望。它不代表这台机器在线、能接业务或面板指挥得动；设置它也不会立刻改归属（回切由平台策略在后续节拍判）。",
  factTitle: "当前归属入口（事实）",
  factNode: (name, nodeId) => `${name ?? "未知节点"}（#${nodeId}）`,
  factMissing: "这条转发没有归属入口（存量未完成绑定的行）——这不是「未知」，而是「没有」。",
  factFacts: (connection, accepts, lifecycle) =>
    `连接：${connection} · 准入：${accepts} · 生命周期：${lifecycle}`,
  candidateTitle: "自动迁移候选入口",
  candidateAvailable: (name, nodeId) =>
    `有一台此刻合格的候选入口：${name}（#${nodeId}）。`,
  candidateAvailableCaveat:
    "合格 ≠ 已经迁移：候选是按平台自己的判定（同组、非现任、准入、角色、此刻在线）选出的第一台，是否真的接管取决于策略与每一拍的判定。",
  candidateNone:
    "现在没有可接管的候选入口：组内其它节点要么不在线、要么不接受新业务、要么角色不是入口。",
  candidateNoneHint: "这是**这一次判定**的结果，不是「这条转发无法高可用」。",
  candidateUnavailable: (reason) =>
    `候选入口这次没有读到（reason: ${reason}）。`,
  candidateUnavailableCaveat:
    "「没有读到」不等于「没有候选」：它既不能说明有机器能接管，也不能说明没有。刷新一次再判断。",
  optionsUnavailable: "首选入口的备选集合这次没有读到：不能在此挑选，也不代表组内没有别的节点。",
  chooseTitle: "设置 / 清除首选入口",
  chooseHint:
    "可以选组内任何 role 为 ingress / both 的节点（包括此刻离线或维护中的机器：偏好表达的是「它回来后优先归它」）。写入不重启转发、不触发下发。",
  optionFacts: (connection, acceptsNewBusiness, lifecycle) =>
    `连接：${connection} · 新业务：${acceptsNewBusiness} · 生命周期：${lifecycle}`,
  optionIsActive: "当前归属",
  optionIsPreferred: "已是首选",
  optionCannot: (reason) => `不可设为首选（${reason}）`,
  setPreferred: "设为首选",
  setting: "设置中…",
  clearPreferred: "清除首选",
  clearing: "清除中…",
  writeErrorTitle: "首选入口没有写入成功",
  writeRejections: {
    preferred_not_found: "节点或转发不存在（可能已被删除）。",
    preferred_node_group_mismatch: "首选节点必须属于这条转发的入口节点组。",
    preferred_role_mismatch: "该节点的角色不能作为入口（需要 ingress 或 both）。",
    preferred_unavailable: "平台暂时无法写入这个偏好，请稍后重试。",
    permission_denied: "当前工作空间角色没有修改这条转发的权限。",
  },
  connectionLabel: "连接",
  connection: { waiting: "等待首次上报", online: "在线", offline: "离线" },
  acceptsYes: "接受新业务",
  acceptsNo: (reason) => `不接受新业务（${reason ?? "原因码缺失"}）`,
  lifecycleLabel: "生命周期",
  lifecycle: {
    active: "正常启用",
    maintenance: "维护中",
    disabled: "已停用",
    retiring: "退役中",
  },
  roleLabel: "角色",
};

const EN: HaCopy = {
  title: "High availability (preferred ingress · automatic migration)",
  subtitle:
    "Read-only facts plus one scheduling intent. This shows the policy and ownership the panel currently knows; the preferred ingress is only where you would like it to go — it is not a migration, not liveness, and not business admission.",
  loading: "Reading availability facts…",
  deniedTitle: "No permission to read availability facts",
  unavailableTitle: "Availability facts unavailable",
  unavailableBody:
    "This request returned no data, so it carries no conclusion at all: it neither says the platform will migrate nor that it will not. Reload the page or contact an administrator.",
  unavailableNoAutoRetry: "This card does not retry automatically: retrying cannot create missing facts.",
  errorCode: "Backend said",
  reload: "Read again",
  refreshing: "Reading…",
  policyOff: "Automatic migration is not enabled on this platform: this forward will not change ownership automatically when its ingress fails.",
  policyOffExplain:
    "That is the current policy truth of this deployment (FAILOVER_POLICY defaults to off), not a problem of this forward and not a temporary state. An operator must enable it explicitly.",
  policyOnFailover:
    "Automatic migration is enabled (auto_failover): when the policy conditions hold, the platform will try to move ownership to another eligible ingress in the same group.",
  policyOnFailback:
    "Automatic failback is enabled (auto_failback): when the policy conditions hold, the platform will try to move ownership back to the preferred ingress.",
  policyOnCaveat:
    "A migration causes a brief interruption; whether and when it happens depends on each tick's candidates, consecutive-healthy count and cooldown — this card does not predict it.",
  policyParseError: (detail) =>
    `The platform policy cannot be parsed (${detail}): the platform treats it as disabled (fail-closed). That is "the configuration is broken", not "an operator turned it off"; the next step is fixing the config.`,
  policyReadOnly: "The policy is read-only here: this card offers no switch, so the UI and the operator configuration cannot become two versions of the truth.",
  expectationTitle: "Preferred ingress (expectation)",
  expectationSet: (name, nodeId) => `Set to: ${name} (#${nodeId})`,
  expectationNone: "No preferred ingress: the platform does not treat any node as a failback target (current behaviour).",
  expectationCaveat:
    "The preference is only an expectation. It does not mean that machine is online, admissible or controllable, and setting it does not change ownership immediately (failback is decided by the platform policy on later ticks).",
  factTitle: "Current owner ingress (fact)",
  factNode: (name, nodeId) => `${name ?? "unknown node"} (#${nodeId})`,
  factMissing: "This forward has no owner ingress (a legacy row without binding) — that is \"none\", not \"unknown\".",
  factFacts: (connection, accepts, lifecycle) =>
    `Connection: ${connection} · Admission: ${accepts} · Lifecycle: ${lifecycle}`,
  candidateTitle: "Automatic-migration candidate ingress",
  candidateAvailable: (name, nodeId) => `One ingress is eligible right now: ${name} (#${nodeId}).`,
  candidateAvailableCaveat:
    "Eligible is not migrated: the candidate is the first node that passes the platform's own judgement (same group, not the owner, admitted, right role, online now). Whether it takes over depends on the policy and each tick's decision.",
  candidateNone:
    "No ingress can take over right now: the other nodes in the group are offline, do not accept new business, or are not ingress-capable.",
  candidateNoneHint: "This is the result of this one evaluation, not \"this forward cannot be highly available\".",
  candidateUnavailable: (reason) => `The candidate was not readable this time (reason: ${reason}).`,
  candidateUnavailableCaveat:
    "\"Not readable\" is not \"no candidate\": it neither shows that a machine could take over nor that none could. Reload and judge again.",
  optionsUnavailable: "The set of possible preferred ingresses was not readable: you cannot pick one here, and it does not mean the group holds no other node.",
  chooseTitle: "Set / clear the preferred ingress",
  chooseHint:
    "You may pick any node in the group whose role is ingress or both (including machines that are offline or in maintenance right now: the preference means \"prefer it once it is back\"). Writing it does not restart the forward and does not trigger a rollout.",
  optionFacts: (connection, acceptsNewBusiness, lifecycle) =>
    `Connection: ${connection} · New business: ${acceptsNewBusiness} · Lifecycle: ${lifecycle}`,
  optionIsActive: "current owner",
  optionIsPreferred: "already preferred",
  optionCannot: (reason) => `Cannot be preferred (${reason})`,
  setPreferred: "Set as preferred",
  setting: "Setting…",
  clearPreferred: "Clear preference",
  clearing: "Clearing…",
  writeErrorTitle: "The preferred ingress was not written",
  writeRejections: {
    preferred_not_found: "The node or forward does not exist (it may have been deleted).",
    preferred_node_group_mismatch: "The preferred node must belong to this forward's ingress node group.",
    preferred_role_mismatch: "That node's role cannot be an ingress (ingress or both required).",
    preferred_unavailable: "The platform cannot write this preference right now; try again later.",
    permission_denied: "Your workspace role may not modify this forward.",
  },
  connectionLabel: "Connection",
  connection: { waiting: "awaiting first report", online: "online", offline: "offline" },
  acceptsYes: "accepts new business",
  acceptsNo: (reason) => `does not accept new business (${reason ?? "reason code missing"})`,
  lifecycleLabel: "Lifecycle",
  lifecycle: {
    active: "active",
    maintenance: "maintenance",
    disabled: "disabled",
    retiring: "retiring",
  },
  roleLabel: "Role",
};

const COPY: Record<Locale, HaCopy> = { zh: ZH, en: EN };

function useCopy(): HaCopy {
  return COPY[useI18nOptional()?.locale ?? "zh"];
}

/* ================================================================== */
/* 取数：状态机 + 作用域守卫 + 轮询                                      */
/* ================================================================== */

export type ForwardHaState =
  | { status: "loading" }
  | { status: "denied" }
  | { status: "error"; error: ForwardHaErrorInfo }
  | { status: "data"; projection: ForwardHaProjection };

export const HA_LOADING: ForwardHaState = { status: "loading" };
export const HA_DENIED: ForwardHaState = { status: "denied" };

/** 与延迟卡片同一套「只接受最新请求」的守卫（本文件自带一份以保持自包含）。 */
export interface HaScopeGuard {
  claim(): number;
  invalidate(): void;
  isCurrent(token: number): boolean;
}

export function createHaScopeGuard(): HaScopeGuard {
  let latest = 0;
  return {
    claim: () => ++latest,
    invalidate: () => {
      latest += 1;
    },
    isCurrent: (token) => token === latest,
  };
}

export async function loadHaState(input: {
  forwardId: ID;
  token: number;
  guard: HaScopeGuard;
  read?: (forwardId: ID) => Promise<ForwardHaProjection>;
}): Promise<{ applied: boolean; state: ForwardHaState }> {
  const read = input.read ?? getForwardHa;
  try {
    const projection = await read(input.forwardId);
    return {
      applied: input.guard.isCurrent(input.token),
      state: { status: "data", projection },
    };
  } catch (error) {
    return {
      applied: input.guard.isCurrent(input.token),
      state: { status: "error", error: forwardHaErrorInfo(error) },
    };
  }
}

/** 权限还没读出来时不能当作「没有权限」（同 `forward-latency.tsx:latencyGate`）。 */
export function haGate(input: {
  hasReadPermission: boolean;
  permissionsLoading: boolean;
}): "wait" | "denied" | "load" {
  if (input.permissionsLoading) return "wait";
  return input.hasReadPermission ? "load" : "denied";
}

/**
 * 该不该自动刷新：只有 `data` 才轮询（连接/候选会随时间变化），
 * 错误与无权**不**自动重试（重试不会让缺失的事实出现，403 重试还是 403）。
 */
export function haPollIntervalMs(state: ForwardHaState): number | null {
  return state.status === "data" ? FORWARD_HA_POLL_MS : null;
}

/* ================================================================== */
/* 纯投影帮助函数（可单独断言，不需要 DOM）                                */
/* ================================================================== */

/** 首选入口在备选集合里的那一行（可能因为读不到而缺席）。 */
export function optionOf(
  projection: ForwardHaProjection,
  nodeId: number | null,
): ForwardHaOptionNode | null {
  if (nodeId === null) return null;
  if (projection.preference_options.status !== "ok") return null;
  return projection.preference_options.nodes.find((node) => node.node_id === nodeId) ?? null;
}

/** 策略是否至少打开了一个开关（`false` 一律是「未启用」，不做任何乐观解释）。 */
export function policyEnabled(policy: ForwardHaPolicy): boolean {
  return policy.auto_failover === true || policy.auto_failback === true;
}

/** 候选三态的中性描述（不把 `unavailable` 说成 `none`）。 */
export function candidateKind(candidate: ForwardHaCandidate): ForwardHaCandidate["status"] {
  return candidate.status;
}

/** 备选集合里可以设为首选的节点（按 id 升序）。 */
export function preferredCandidates(projection: ForwardHaProjection): ForwardHaOptionNode[] {
  if (projection.preference_options.status !== "ok") return [];
  return [...projection.preference_options.nodes].sort((a, b) => a.node_id - b.node_id);
}

/* ================================================================== */
/* 展示                                                                */
/* ================================================================== */

function connectionText(copy: HaCopy, connection: string): string {
  return copy.connection[connection] ?? connection;
}

function lifecycleText(copy: HaCopy, lifecycle: string): string {
  return copy.lifecycle[lifecycle] ?? lifecycle;
}

function acceptsText(copy: HaCopy, node: Pick<ForwardHaOptionNode, "accepts_new_business" | "admission_rejection">): string {
  return node.accepts_new_business ? copy.acceptsYes : copy.acceptsNo(node.admission_rejection);
}

export interface ForwardHaPanelProps {
  state: ForwardHaState;
  /** 设置首选入口（`null` = 清除）。 */
  onSetPreferred?: (nodeId: number | null) => void;
  onReload?: () => void;
  busy?: boolean;
  /** 正在写入的节点（`null` = 清除中；`undefined` = 没有写入在途）。 */
  pendingNodeId?: number | null | undefined;
  writeError?: ForwardHaErrorInfo | null;
}

export function ForwardHaPanel({
  state,
  onSetPreferred,
  onReload,
  busy,
  pendingNodeId,
  writeError,
}: ForwardHaPanelProps) {
  const copy = useCopy();
  const projection = state.status === "data" ? state.projection : null;
  const policy = projection?.policy ?? null;
  const candidate = projection?.failover_candidate ?? null;
  const preferredNode = projection ? optionOf(projection, projection.preferred_ingress_node_id) : null;
  const activeNode = projection ? optionOf(projection, projection.active_ingress_node_id) : null;
  const options = projection ? projection.preference_options : null;

  return (
    <section data-testid="forward-ha" className="rounded-lg border border-[var(--border)] p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{copy.title}</h3>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">{copy.subtitle}</p>
        </div>
        {onReload ? (
          <button
            type="button"
            data-testid="forward-ha-reload"
            onClick={onReload}
            disabled={busy}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-xs disabled:opacity-50"
          >
            {busy ? copy.refreshing : copy.reload}
          </button>
        ) : null}
      </header>

      {state.status === "loading" ? (
        <p className="mt-3 text-sm" data-testid="forward-ha-loading">
          {copy.loading}
        </p>
      ) : null}

      {state.status === "denied" ? (
        <p role="alert" className="mt-3 text-sm" data-testid="forward-ha-denied">
          {copy.deniedTitle}：{PERMISSION_DENIED}
        </p>
      ) : null}

      {state.status === "error" ? (
        <div role="alert" className="mt-3" data-testid="forward-ha-unavailable">
          <p className="text-sm font-medium">{copy.unavailableTitle}</p>
          <p className="mt-1 text-sm">{copy.unavailableBody}</p>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]" data-testid="forward-ha-error-detail">
            {copy.errorCode}：{state.error.code ?? "—"} · {state.error.message}
          </p>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">{copy.unavailableNoAutoRetry}</p>
        </div>
      ) : null}

      {projection && policy ? (
        <div className="mt-3 space-y-3">
          {/* ① 平台策略（只读真值）：false 只能说「未启用自动迁移」 */}
          <div data-testid="forward-ha-policy">
            {policyEnabled(policy) ? (
              <div data-testid="forward-ha-policy-on" className="text-sm">
                {policy.auto_failover ? <p>{copy.policyOnFailover}</p> : null}
                {policy.auto_failback ? <p>{copy.policyOnFailback}</p> : null}
                <p className="mt-1 text-xs text-[var(--muted-foreground)]" data-testid="forward-ha-policy-caveat">
                  {copy.policyOnCaveat}
                </p>
              </div>
            ) : (
              <div data-testid="forward-ha-policy-off" className="text-sm">
                <p className="font-medium">{copy.policyOff}</p>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">{copy.policyOffExplain}</p>
              </div>
            )}
            {policy.parse_error ? (
              <p
                role="alert"
                data-testid="forward-ha-policy-parse-error"
                className="mt-1 rounded bg-amber-50 p-2 text-xs dark:bg-amber-950"
              >
                {copy.policyParseError(policy.parse_error)}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">{copy.policyReadOnly}</p>
          </div>

          {/* ② 期望：首选入口 */}
          <div data-testid="forward-ha-expectation">
            <h4 className="text-sm font-medium">{copy.expectationTitle}</h4>
            {projection.preferred_ingress_node_id !== null ? (
              <p className="mt-1 text-sm" data-testid="forward-ha-preferred-set">
                {copy.expectationSet(
                  preferredNode?.name ?? `#${projection.preferred_ingress_node_id}`,
                  projection.preferred_ingress_node_id,
                )}
              </p>
            ) : (
              <p className="mt-1 text-sm" data-testid="forward-ha-preferred-none">
                {copy.expectationNone}
              </p>
            )}
            <p className="mt-1 text-xs text-[var(--muted-foreground)]" data-testid="forward-ha-expectation-caveat">
              {copy.expectationCaveat}
            </p>
          </div>

          {/* ③ 事实：当前归属 */}
          <div data-testid="forward-ha-fact">
            <h4 className="text-sm font-medium">{copy.factTitle}</h4>
            {projection.active_ingress_node_id !== null ? (
              <div className="mt-1 text-sm">
                <p data-testid="forward-ha-active">
                  {copy.factNode(
                    activeNode?.name ?? null,
                    projection.active_ingress_node_id,
                  )}
                </p>
                {activeNode ? (
                  <p className="text-xs text-[var(--muted-foreground)]" data-testid="forward-ha-active-facts">
                    {copy.factFacts(
                      connectionText(copy, activeNode.connection),
                      acceptsText(copy, activeNode),
                      lifecycleText(copy, activeNode.lifecycle),
                    )}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-1 text-sm" data-testid="forward-ha-active-none">
                {copy.factMissing}
              </p>
            )}
          </div>

          {/* ④ 候选三态：available / none / unavailable 各有独立呈现 */}
          <div data-testid="forward-ha-candidate">
            <h4 className="text-sm font-medium">{copy.candidateTitle}</h4>
            {candidate?.status === "available" && candidate.node_id !== null ? (
              <div data-testid="forward-ha-candidate-available" className="mt-1 text-sm">
                <p>
                  {copy.candidateAvailable(
                    optionOf(projection, candidate.node_id)?.name ?? `#${candidate.node_id}`,
                    candidate.node_id,
                  )}
                </p>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">{copy.candidateAvailableCaveat}</p>
              </div>
            ) : null}
            {candidate?.status === "none" ? (
              <div data-testid="forward-ha-candidate-none" className="mt-1 text-sm">
                <p>{copy.candidateNone}</p>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">{copy.candidateNoneHint}</p>
              </div>
            ) : null}
            {candidate?.status === "unavailable" ? (
              <div data-testid="forward-ha-candidate-unavailable" className="mt-1 text-sm">
                <p>{copy.candidateUnavailable(candidate.reason ?? "unknown")}</p>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  {copy.candidateUnavailableCaveat}
                </p>
              </div>
            ) : null}
          </div>

          {/* ⑤ 首选入口的备选集合（写入路径规则 + 并列事实） */}
          <div data-testid="forward-ha-options">
            <h4 className="text-sm font-medium">{copy.chooseTitle}</h4>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">{copy.chooseHint}</p>
            {options?.status === "unavailable" ? (
              <p role="alert" data-testid="forward-ha-options-unavailable" className="mt-2 text-sm">
                {copy.optionsUnavailable}
              </p>
            ) : null}
            {options?.status === "ok" ? (
              <ul className="mt-2 space-y-2">
                {preferredCandidates(projection).map((node) => (
                  <li
                    key={node.node_id}
                    data-testid={`forward-ha-option-${node.node_id}`}
                    className="rounded border border-[var(--border)] p-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm">
                        <span className="font-medium">{node.name}</span>
                        <span className="ml-1 text-xs text-[var(--muted-foreground)]">#{node.node_id}</span>
                        {node.is_active_ingress ? (
                          <span className="ml-2 text-xs" data-testid={`forward-ha-option-active-${node.node_id}`}>
                            {copy.optionIsActive}
                          </span>
                        ) : null}
                        {node.is_preferred ? (
                          <span className="ml-2 text-xs" data-testid={`forward-ha-option-preferred-${node.node_id}`}>
                            {copy.optionIsPreferred}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {node.can_be_preferred ? (
                          <button
                            type="button"
                            data-testid={`forward-ha-set-${node.node_id}`}
                            disabled={busy || node.is_preferred || !onSetPreferred}
                            onClick={() => onSetPreferred?.(node.node_id)}
                            className="rounded border border-[var(--border)] px-2 py-0.5 text-xs disabled:opacity-50"
                          >
                            {pendingNodeId === node.node_id ? copy.setting : copy.setPreferred}
                          </button>
                        ) : (
                          <span className="text-xs" data-testid={`forward-ha-option-rejected-${node.node_id}`}>
                            {copy.optionCannot(node.preference_rejection ?? "unknown")}
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                      {copy.roleLabel}: {node.role ?? "—"} ·{" "}
                      <span data-testid={`forward-ha-option-facts-${node.node_id}`}>
                        {copy.optionFacts(
                          connectionText(copy, node.connection),
                          acceptsText(copy, node),
                          lifecycleText(copy, node.lifecycle),
                        )}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-2">
              <button
                type="button"
                data-testid="forward-ha-clear"
                disabled={busy || projection.preferred_ingress_node_id === null || !onSetPreferred}
                onClick={() => onSetPreferred?.(null)}
                className="rounded border border-[var(--border)] px-2 py-0.5 text-xs disabled:opacity-50"
              >
                {pendingNodeId === null ? copy.clearing : copy.clearPreferred}
              </button>
            </div>
          </div>

          {writeError ? (
            <div role="alert" className="rounded bg-red-50 p-2 text-xs dark:bg-red-950" data-testid="forward-ha-write-error">
              <p className="font-medium" data-testid="forward-ha-write-error-title">
                {copy.writeErrorTitle}
              </p>
              {writeError.code && copy.writeRejections[writeError.code] ? (
                <p data-testid="forward-ha-write-error-reason">{copy.writeRejections[writeError.code]}</p>
              ) : null}
              <p className="mt-1 text-[var(--muted-foreground)]">
                {copy.errorCode}：{writeError.code ?? "—"} · {writeError.message}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * 自取数的高可用卡片（**只吃 `forwardId`**；挂载点由集成任务决定）。
 *
 * `read` / `write` 是测试注入缝隙，生产用 `lib/api/forward-ha.ts` 的两个函数；
 * 传它们时请保持引用稳定。`pollMs` 覆盖自动刷新间隔（默认 30s = Agent 上报节拍）。
 */
export function ForwardHaCard({
  forwardId,
  read,
  write,
  pollMs = FORWARD_HA_POLL_MS,
}: {
  forwardId: ID;
  read?: (forwardId: ID) => Promise<ForwardHaProjection>;
  write?: (forwardId: ID, nodeId: number | null) => Promise<unknown>;
  pollMs?: number;
}) {
  const { currentId, can, permissionsLoading } = useWorkspace();
  const canRead = can("forward:read");
  const canWrite = can("forward:update");
  const [state, setState] = useState<ForwardHaState>(HA_LOADING);
  const [busy, setBusy] = useState(false);
  const [pendingNodeId, setPendingNodeId] = useState<number | null | undefined>(undefined);
  const [writeError, setWriteError] = useState<ForwardHaErrorInfo | null>(null);
  const guardRef = useRef<HaScopeGuard | null>(null);
  if (guardRef.current === null) guardRef.current = createHaScopeGuard();
  const guard = guardRef.current;
  // 同一时刻只允许一个在途请求：手动刷新与轮询不许互相叠加。
  const inFlightRef = useRef(false);

  const run = useCallback(
    (options?: { keepState?: boolean }) => {
      const token = guard.claim();
      if (!options?.keepState) setState(HA_LOADING);
      setBusy(true);
      inFlightRef.current = true;
      void loadHaState({ forwardId, token, guard, read })
        .then((result) => {
          // 切了 Workspace/转发的晚到响应一律丢弃（成功与失败都丢）。
          if (result.applied) setState(result.state);
        })
        .finally(() => {
          inFlightRef.current = false;
          setBusy(false);
        });
    },
    [forwardId, guard, read],
  );

  useEffect(() => {
    const gate = haGate({ hasReadPermission: canRead, permissionsLoading });
    if (gate === "wait") return;
    if (gate === "denied") {
      guard.claim();
      setState(HA_DENIED);
      return;
    }
    run();
    return () => guard.invalidate();
  }, [currentId, canRead, permissionsLoading, guard, run]);

  // 只有取到数据才轮询：错误与无权不自动重试（见 haPollIntervalMs）。
  useEffect(() => {
    const interval = haPollIntervalMs(state);
    if (interval === null || pollMs <= 0) return;
    const timer = setInterval(() => {
      if (inFlightRef.current) return; // 上一次还没回来，跳过这一拍
      run({ keepState: true });
    }, Math.max(pollMs, interval));
    return () => clearInterval(timer);
  }, [state, pollMs, run]);

  const setPreferred = useCallback(
    (nodeId: number | null) => {
      if (!canWrite) {
        setWriteError({
          code: "permission_denied",
          message: PERMISSION_DENIED,
          layer: "rbac",
        });
        return;
      }
      const token = guard.claim();
      setPendingNodeId(nodeId);
      setWriteError(null);
      const send = write ?? setForwardPreferredIngress;
      void send(forwardId, nodeId)
        .then(() => {
          if (!guard.isCurrent(token)) return; // 切了空间：写入结果不落到界面
          // 写成功后重新读回**服务端**的真值，而不是本地改一个乐观值：
          // 「期望」写入后到底存成了什么，只有服务端说了算。
          run({ keepState: true });
        })
        .catch((error: unknown) => {
          if (!guard.isCurrent(token)) return;
          setWriteError(forwardHaErrorInfo(error));
        })
        .finally(() => {
          if (guard.isCurrent(token)) setPendingNodeId(undefined);
        });
    },
    [canWrite, forwardId, guard, run, write],
  );

  return (
    <ForwardHaPanel
      state={state}
      busy={busy}
      pendingNodeId={pendingNodeId}
      writeError={writeError}
      onReload={() => run({ keepState: true })}
      onSetPreferred={setPreferred}
    />
  );
}
