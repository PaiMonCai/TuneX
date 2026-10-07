"use client";

// 行为参照：ForwardX（AGPL-3.0-only）——多入口/转发组（成员顺序即优先级、当前入口失效后切到
// 下一个可用成员、"恢复后切回"开关、以及"在线 ≠ 可用"的成员状态口径）；代码为本项目改写，
// 未复制其实现。参照溯源：docs/agent/forwardx-code-reuse.md。
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
 *  `can_be_preferred` 只反映**写入路径自己的规则**（同入口组 + `role ∈ {ingress,both}` + 未显式停用），
 *  所以一台 `connection=offline` 甚至 `lifecycle=maintenance` 的节点照样能被设为首选 ——
 *  界面上这些字段并列显示，绝不合成一句"可以接管"。真正的门槛（连续健康次数 + 冷却）
 *  由平台策略在后续节拍判，本卡片不重复判定、也不预告结果。
 *
 *  文案（zh/en）刻意留在本文件内，与 `forward-latency.tsx` / `forward-topology.tsx` 同样
 *  不碰 `lib/i18n/dictionaries.ts`，避免与并行切片争抢同一个字典文件。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18nOptional } from "@/components/providers";
import { useWorkspace } from "@/components/workspace/workspace-context";
import {
  FORWARD_HA_POLL_MS,
  forwardHaErrorInfo,
  getForwardHa,
  setForwardIngressMembers,
  setForwardPreferredIngress,
  type ForwardHaCandidate,
  type ForwardHaErrorInfo,
  type ForwardHaOptionNode,
  type ForwardHaPolicy,
  type ForwardHaProjection,
  type IngressMemberInput,
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
  membersTitle: string;
  membersHint: string;
  membersUnavailable: string;
  membersEmpty: string;
  membersNoTakeover: string;
  orderSource: (source: ForwardHaProjection["member_priority"]["source"], orderReadable: boolean) => string;
  orderEditorTitle: string;
  orderHint: string;
  moveUp: string;
  moveDown: string;
  orderSave: string;
  orderSaving: string;
  orderClear: string;
  orderReset: string;
  disableMember: string;
  enableMember: string;
  memberDisabled: string;
  orderUnreadable: string;
  orderSaved: string;
  optionIsFailbackTarget: string;
  canTakeOver: (rank: number | null) => string;
  cannotTakeOver: (reason: string) => string;
  failbackTitle: string;
  failbackOn: string;
  failbackOff: string;
  failbackNoTarget: string;
  failbackProgress: (healthy: number, required: number, met: boolean) => string;
  failbackCaveat: string;
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
    `平台策略配置无法解析（${detail}）：平台按「未启用」处理（fail-closed）。这是「配置坏了」，不是「运维没开」，下一步是修配置。`,
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
  membersTitle: "入口成员与优先级",
  membersHint:
    "成员集合就是这条转发的入口节点组。次序是平台当前的接管次序（不是可以随意拖动的自定义顺序）。每台成员下面分开写三件事：连接（事实）、新业务准入（结论）、以及此刻能不能接管（failover 判定）。",
  membersUnavailable:
    "这次没有读到成员列表：不能据此判断有哪些入口，也不代表这个入口组里没有成员。",
  membersEmpty:
    "这个入口节点组里没有任何成员 —— 这不是「没有可用候选」，而是组里确实一台都没有。",
  membersNoTakeover:
    "有成员，但此刻没有一台能接管：每台下面写了它自己的原因（离线 / 维护中 / 角色不符 / 凭据被吊销）。",
  orderSource: (source, orderReadable) =>
    !orderReadable
      ? "顺序这次取不到：下面按平台默认规则（合格候选按节点 id 升序）显示 —— 这不等于你保存的次序被清空。"
      : source === "forward_member_table"
        ? "顺序来源：你保存的入口次序（列表顺序 = 优先级）。"
        : "顺序来源：平台默认规则（合格候选按节点 id 升序）；你还没有保存过自定义次序。",
  orderEditorTitle: "调整入口次序",
  orderHint:
    "列表顺序 = 优先级：平台按这个次序挑下一台接管的入口，不合格（离线 / 维护中 / 停用）的会被跳过。保存是**全量替换**，不重启转发、不触发下发。",
  moveUp: "上移",
  moveDown: "下移",
  orderSave: "保存次序",
  orderSaving: "保存中…",
  orderClear: "清除自定义次序",
  orderReset: "还原",
  disableMember: "停用",
  enableMember: "启用",
  memberDisabled: "已停用",
  orderUnreadable: "次序取不到：编辑器按当前展示的顺序初始化，保存会覆盖服务端已存的次序。",
  orderSaved: "已保存的次序（第 1 位是回切目标）",
  optionIsFailbackTarget: "回切目标",
  canTakeOver: (rank) =>
    rank === null ? "此刻可接管" : `此刻可接管（平台次序第 ${rank} 位）`,
  cannotTakeOver: (reason) => `此刻不可接管（${reason}）`,
  failbackTitle: "恢复后切回（恢复观察）",
  failbackOn:
    "平台已启用自动回切（auto_failback）：首选入口恢复、并满足恢复观察后，平台会尝试把它切回来。",
  failbackOff:
    "平台未启用自动回切（auto_failback=false）：即使首选入口恢复，平台也不会自动切回 —— 首选只是被记录下来的期望。",
  failbackNoTarget: "还没有首选入口 ⇒ 回切没有目标。",
  failbackProgress: (healthy, required, met) =>
    `首选入口连续健康 ${healthy}/${required} 次（${met ? "已满足" : "未满足"}平台阈值）。`,
  failbackCaveat:
    "恢复观察与迁移冷却由平台策略判定：本卡片只回显计数与阈值，不预告迁移什么时候发生。",
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
    preferred_disabled: "该成员已被停用，请先启用它再设为首选入口。",
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
  membersTitle: "Ingress members and priority",
  membersHint:
    "The member set is this forward's ingress node group. The order is the platform's current takeover order (not a freely draggable custom order). Each member lists three separate things: connection (fact), new-business admission (conclusion), and whether it can take over right now (the failover judgement).",
  membersUnavailable:
    "The member list was not readable this time: you cannot tell which ingresses exist from this, and it does not mean the group has no member.",
  membersEmpty:
    "This ingress node group holds no member at all — that is not \"no eligible candidate\"; it is an empty group.",
  membersNoTakeover:
    "There are members, but none can take over right now: each one lists its own reason (offline / maintenance / wrong role / revoked credential).",
  orderSource: (source, orderReadable) =>
    !orderReadable
      ? "The order could not be read this time: what follows uses the platform default (eligible candidates by ascending node id) — this does not mean your saved order was cleared."
      : source === "forward_member_table"
        ? "Order source: your saved ingress order (list order = priority)."
        : "Order source: platform default (eligible candidates by ascending node id); you have not saved a custom order yet.",
  orderEditorTitle: "Adjust ingress order",
  orderHint:
    "List order = priority: the platform picks the next ingress to take over in this order, skipping ineligible ones (offline / maintenance / disabled). Saving is a full replacement; it does not restart the forward or trigger a rollout.",
  moveUp: "Move up",
  moveDown: "Move down",
  orderSave: "Save order",
  orderSaving: "Saving…",
  orderClear: "Clear custom order",
  orderReset: "Reset",
  disableMember: "Disable",
  enableMember: "Enable",
  memberDisabled: "disabled",
  orderUnreadable: "The order was unreadable: the editor starts from what is displayed, and saving will overwrite the stored order.",
  orderSaved: "Saved order (position 1 is the failback target)",
  optionIsFailbackTarget: "failback target",
  canTakeOver: (rank) => (rank === null ? "can take over now" : `can take over now (takeover position ${rank})`),
  cannotTakeOver: (reason) => `cannot take over now (${reason})`,
  failbackTitle: "Switch back after recovery (recovery observation)",
  failbackOn:
    "Automatic failback is enabled (auto_failback): once the preferred ingress recovers and passes the recovery observation, the platform will try to switch back to it.",
  failbackOff:
    "Automatic failback is not enabled (auto_failback=false): even if the preferred ingress recovers, the platform will not switch back automatically — the preference is only a recorded expectation.",
  failbackNoTarget: "No preferred ingress yet ⇒ failback has no target.",
  failbackProgress: (healthy, required, met) =>
    `Preferred ingress has been consecutively healthy ${healthy}/${required} times (${met ? "meets" : "below"} the platform threshold).`,
  failbackCaveat:
    "Recovery observation and migration cooldown are decided by the platform policy: this card only mirrors the counter and threshold, and does not predict when a migration happens.",
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
    preferred_disabled: "This member is disabled. Enable it before setting it as the preferred ingress.",
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
  if (projection.ingress_members.status !== "ok") return null;
  return projection.ingress_members.nodes.find((node) => node.node_id === nodeId) ?? null;
}

/** 策略是否至少打开了一个开关（`false` 一律是「未启用」，不做任何乐观解释）。 */
export function policyEnabled(policy: ForwardHaPolicy): boolean {
  return policy.auto_failover === true || policy.auto_failback === true;
}

/** 候选三态的中性描述（不把 `unavailable` 说成 `none`）。 */
export function candidateKind(candidate: ForwardHaCandidate): ForwardHaCandidate["status"] {
  return candidate.status;
}

/**
 * 入口成员（**有序**：与后端 `ingress_members` 顺序一致 = 平台当前的接管次序）。
 *
 * 刻意**不重新排序**：顺序是服务端事实（`failover_rank` 就是它），前端照抄才不会出现
 * "界面上的第 1 名"与"平台会切到的那台"不是一个东西。
 */
export function preferredCandidates(projection: ForwardHaProjection): ForwardHaOptionNode[] {
  if (projection.ingress_members.status !== "ok") return [];
  return [...projection.ingress_members.nodes];
}

/** 组内是否至少有一台**此刻能接管**的成员（与"没有成员"是两件事）。 */
export function hasTakeover(nodes: readonly ForwardHaOptionNode[]): boolean {
  return nodes.some((node) => node.can_take_over);
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

/**
 * 次序编辑器（task-43）。
 *
 * 行为参照：ForwardX（AGPL-3.0-only）——多入口/转发组的成员排序（拖动/上移下移，顺序即优先级，
 * 含每成员启用开关）；**代码为本项目改写，未复制其实现**。
 *
 * 三条纪律：
 *   1. 草稿只在本地：**没有保存之前不改服务端**（保存是"全量替换"，一次 PUT）；
 *   2. 保存的是**完整次序**（数组顺序 = 优先级），停用状态也一起提交；
 *   3. 只是 UI 的排序意图，**不预告**平台会不会迁移 —— 迁移仍由策略在每一拍判。
 */
export function IngressOrderEditor({
  nodes,
  busy,
  saving,
  onSave,
  onClear,
}: {
  nodes: readonly ForwardHaOptionNode[];
  busy?: boolean;
  saving?: boolean;
  onSave?: (members: readonly IngressMemberInput[]) => void;
  onClear?: () => void;
}) {
  const copy = useCopy();
  const serverOrder = useMemo(() => nodes.map((node) => node.node_id), [nodes]);
  const serverDisabled = useMemo(
    () => nodes.filter((node) => node.is_disabled).map((node) => node.node_id),
    [nodes],
  );
  const [order, setOrder] = useState<number[]>(serverOrder);
  const [disabled, setDisabled] = useState<number[]>(serverDisabled);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.node_id, node])), [nodes]);
  const dirty =
    order.join(",") !== serverOrder.join(",") || disabled.join(",") !== serverDisabled.join(",");

  const move = (index: number, delta: number) => {
    const next = [...order];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    setOrder(next);
  };
  const toggle = (nodeId: number) => {
    setDisabled((prev) =>
      prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId],
    );
  };

  return (
    <div data-testid="forward-ha-order-editor" className="mt-3 rounded border border-dashed border-[var(--border)] p-2">
      <h5 className="text-xs font-medium">{copy.orderEditorTitle}</h5>
      <p className="mt-1 text-xs text-[var(--muted-foreground)]">{copy.orderHint}</p>
      <ol className="mt-2 space-y-1">
        {order.map((nodeId, index) => {
          const node = byId.get(nodeId);
          const isOff = disabled.includes(nodeId);
          return (
            <li key={nodeId} className="flex flex-wrap items-center gap-2 text-xs" data-testid={`forward-ha-order-row-${nodeId}`}>
              <span
                className="inline-block min-w-5 rounded border border-[var(--border)] px-1 text-center"
                data-testid={`forward-ha-order-rank-${nodeId}`}
              >
                {index + 1}
              </span>
              <span>{node?.name ?? `#${nodeId}`}</span>
              <button
                type="button"
                data-testid={`forward-ha-order-up-${nodeId}`}
                onClick={() => move(index, -1)}
                disabled={index === 0 || busy}
                className="rounded border border-[var(--border)] px-1 disabled:opacity-40"
              >
                {copy.moveUp}
              </button>
              <button
                type="button"
                data-testid={`forward-ha-order-down-${nodeId}`}
                onClick={() => move(index, 1)}
                disabled={index === order.length - 1 || busy}
                className="rounded border border-[var(--border)] px-1 disabled:opacity-40"
              >
                {copy.moveDown}
              </button>
              <button
                type="button"
                data-testid={`forward-ha-order-toggle-${nodeId}`}
                aria-pressed={isOff}
                onClick={() => toggle(nodeId)}
                disabled={busy}
                className="rounded border border-[var(--border)] px-1 disabled:opacity-40"
              >
                {isOff ? copy.enableMember : copy.disableMember}
              </button>
            </li>
          );
        })}
      </ol>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="forward-ha-order-save"
          disabled={busy || saving || !dirty || !onSave}
          onClick={() =>
            onSave?.(
              order.map((nodeId) =>
                disabled.includes(nodeId)
                  ? { node_id: nodeId, is_enabled: false }
                  : { node_id: nodeId },
              ),
            )
          }
          className="rounded border border-[var(--border)] px-2 py-0.5 text-xs disabled:opacity-50"
        >
          {saving ? copy.orderSaving : copy.orderSave}
        </button>
        <button
          type="button"
          data-testid="forward-ha-order-reset"
          disabled={busy || saving || !dirty}
          onClick={() => {
            setOrder(serverOrder);
            setDisabled(serverDisabled);
          }}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-xs disabled:opacity-50"
        >
          {copy.orderReset}
        </button>
        <button
          type="button"
          data-testid="forward-ha-order-clear"
          disabled={busy || saving || !onClear}
          onClick={() => onClear?.()}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-xs disabled:opacity-50"
        >
          {copy.orderClear}
        </button>
      </div>
    </div>
  );
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
  /** task-43：保存入口次序（**全量替换**，数组顺序 = 优先级）。 */
  onSaveOrder?: (members: readonly IngressMemberInput[]) => void;
  /** task-43：清除自定义次序（回到平台默认次序）。 */
  onClearOrder?: () => void;
  savingOrder?: boolean;
}

export function ForwardHaPanel({
  state,
  onSetPreferred,
  onReload,
  busy,
  pendingNodeId,
  writeError,
  onSaveOrder,
  onClearOrder,
  savingOrder,
}: ForwardHaPanelProps) {
  const copy = useCopy();
  const projection = state.status === "data" ? state.projection : null;
  const policy = projection?.policy ?? null;
  const candidate = projection?.failover_candidate ?? null;
  const preferredNode = projection ? optionOf(projection, projection.preferred_ingress_node_id) : null;
  const activeNode = projection ? optionOf(projection, projection.active_ingress_node_id) : null;
  const members = projection ? projection.ingress_members : null;

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

          {/* ⑤ 入口成员与优先级（有序；行为参照 ForwardX 的"成员即优先级"） */}
          <div data-testid="forward-ha-members">
            <h4 className="text-sm font-medium">{copy.membersTitle}</h4>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">{copy.membersHint}</p>
            {members?.status === "unavailable" ? (
              <p role="alert" data-testid="forward-ha-members-unavailable" className="mt-2 text-sm">
                {copy.membersUnavailable}
              </p>
            ) : null}
            {members?.status === "ok" && members.nodes.length === 0 ? (
              <p data-testid="forward-ha-members-empty" className="mt-2 text-sm">
                {copy.membersEmpty}
              </p>
            ) : null}
            {members?.status === "ok" && members.nodes.length > 0 ? (
              <>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]" data-testid="forward-ha-members-order-source">
                  {copy.orderSource(projection.member_priority.source, projection.member_priority.order_readable)}
                </p>
                {projection.member_priority.order_readable === false ? (
                  <p role="alert" data-testid="forward-ha-order-unreadable" className="mt-1 text-xs">
                    {copy.orderUnreadable}
                  </p>
                ) : null}
                {!hasTakeover(members.nodes) ? (
                  <p data-testid="forward-ha-members-no-takeover" className="mt-1 text-sm">
                    {copy.membersNoTakeover}
                  </p>
                ) : null}
                <ol className="mt-2 space-y-2">
                  {members.nodes.map((node) => (
                    <li
                      key={node.node_id}
                      data-testid={`forward-ha-option-${node.node_id}`}
                      className="rounded border border-[var(--border)] p-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm">
                          <span
                            className="mr-2 inline-block min-w-5 rounded border border-[var(--border)] px-1 text-center text-xs"
                            data-testid={`forward-ha-rank-${node.node_id}`}
                          >
                            {node.failover_rank ?? "—"}
                          </span>
                          <span className="font-medium">{node.name}</span>
                          <span className="ml-1 text-xs text-[var(--muted-foreground)]">#{node.node_id}</span>
                          {node.is_active_ingress ? (
                            <span className="ml-2 text-xs" data-testid={`forward-ha-option-active-${node.node_id}`}>
                              {copy.optionIsActive}
                            </span>
                          ) : null}
                          {node.is_failback_target ? (
                            <span className="ml-2 text-xs" data-testid={`forward-ha-option-failback-${node.node_id}`}>
                              {copy.optionIsFailbackTarget}
                            </span>
                          ) : null}
                          {node.is_preferred ? (
                            <span className="ml-2 text-xs" data-testid={`forward-ha-option-preferred-${node.node_id}`}>
                              {copy.optionIsPreferred}
                            </span>
                          ) : null}
                          {node.is_disabled ? (
                            <span className="ml-2 text-xs" data-testid={`forward-ha-option-disabled-${node.node_id}`}>
                              {copy.memberDisabled}
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
                      {/* 「能不能接管」是**另一个**问题（failover 判定），单独一行说，不与上一条混。 */}
                      <p className="mt-1 text-xs" data-testid={`forward-ha-option-takeover-${node.node_id}`}>
                        {node.can_take_over
                          ? copy.canTakeOver(node.failover_rank)
                          : copy.cannotTakeOver(node.takeover_rejection ?? "unknown")}
                      </p>
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
            {members?.status === "ok" && members.nodes.length > 0 && onSaveOrder ? (
              <IngressOrderEditor
                key={members.nodes.map((node) => `${node.node_id}:${node.is_disabled ? 0 : 1}`).join(",")}
                nodes={members.nodes}
                busy={Boolean(busy)}
                saving={Boolean(savingOrder)}
                onSave={onSaveOrder}
                onClear={onClearOrder}
              />
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

          {/* ⑥ 恢复后切回（平台真值 + 回切进度；期望已有，但能不能切回由平台开关决定） */}
          <div data-testid="forward-ha-failback">
            <h4 className="text-sm font-medium">{copy.failbackTitle}</h4>
            <p className="mt-1 text-sm" data-testid="forward-ha-failback-switch">
              {projection.failback.auto_failback ? copy.failbackOn : copy.failbackOff}
            </p>
            {projection.failback.preferred_ingress_node_id === null ? (
              <p className="mt-1 text-xs text-[var(--muted-foreground)]" data-testid="forward-ha-failback-no-target">
                {copy.failbackNoTarget}
              </p>
            ) : (
              <p className="mt-1 text-xs text-[var(--muted-foreground)]" data-testid="forward-ha-failback-progress">
                {copy.failbackProgress(
                  projection.failback.progress.healthy_checks,
                  projection.failback.progress.required_checks,
                  projection.failback.progress.met,
                )}
              </p>
            )}
            <p className="mt-1 text-xs text-[var(--muted-foreground)]" data-testid="forward-ha-failback-caveat">
              {copy.failbackCaveat}
            </p>
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
  writeMembers,
  pollMs = FORWARD_HA_POLL_MS,
}: {
  forwardId: ID;
  read?: (forwardId: ID) => Promise<ForwardHaProjection>;
  write?: (forwardId: ID, nodeId: number | null) => Promise<unknown>;
  /** task-43：保存入口次序（**全量替换**）。测试注入缝隙；生产用 API 模块的同名函数。 */
  writeMembers?: (forwardId: ID, members: readonly IngressMemberInput[]) => Promise<unknown>;
  pollMs?: number;
}) {
  const { currentId, can, permissionsLoading } = useWorkspace();
  const canRead = can("forward:read");
  const canWrite = can("forward:update");
  const [state, setState] = useState<ForwardHaState>(HA_LOADING);
  const [busy, setBusy] = useState(false);
  const [pendingNodeId, setPendingNodeId] = useState<number | null | undefined>(undefined);
  const [writeError, setWriteError] = useState<ForwardHaErrorInfo | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
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

  /** task-43：保存完整次序（全量替换）。成功/失败都**回读服务端真值**，不做乐观赋值。 */
  const saveOrder = useCallback(
    (members: readonly IngressMemberInput[]) => {
      if (!canWrite) {
        setWriteError({ code: "permission_denied", message: PERMISSION_DENIED, layer: "rbac" });
        return;
      }
      const token = guard.claim();
      setSavingOrder(true);
      setWriteError(null);
      const send = writeMembers ?? setForwardIngressMembers;
      void send(forwardId, members)
        .then(() => {
          if (!guard.isCurrent(token)) return;
          run({ keepState: true });
        })
        .catch((error: unknown) => {
          if (!guard.isCurrent(token)) return;
          setWriteError(forwardHaErrorInfo(error));
        })
        .finally(() => {
          if (guard.isCurrent(token)) setSavingOrder(false);
        });
    },
    [canWrite, forwardId, guard, run, writeMembers],
  );

  return (
    <ForwardHaPanel
      state={state}
      busy={busy}
      pendingNodeId={pendingNodeId}
      writeError={writeError}
      savingOrder={savingOrder}
      onReload={() => run({ keepState: true })}
      onSetPreferred={setPreferred}
      onSaveOrder={saveOrder}
      onClearOrder={() => saveOrder([])}
    />
  );
}
