"use client";

/**
 * Node 详情 · Agent 升级（退出条件 #7「Agent upgrade 有完整用户流程」）。
 *
 * 这块卡片只回答四件事，而且**每一件都只回答到面板真的知道的边界**：
 *
 *   1. **现在跑的是什么版本**——`node_state_report.version`（面板收到的上报）。
 *      ⚠️ 不是 `node.version`：那是**管理员配置字段**（真机取证：scratch 拓扑上 9 台节点
 *      全是 `unknown`，而上报版本是 `0.13.22`）。R1-A 已确认把它当"当前运行版本"就是
 *      把配置当事实，所以这里两个字段分开展示，且配置字段带显式说明。
 *   2. **目标是什么**——部署方发的镜像（`TUNEX_AGENT_IMAGE`）+（可选的）版本基线。
 *      基线未声明时如实说"面板不判定落后"，不猜落后、也不猜"已是最新"。
 *   3. **升级脚本**——由面板渲染、由操作者在节点主机上执行。生成**没有任何副作用**，
 *      所以"命令已生成"必须显式写成"生成脚本 ≠ 已升级"。
 *   4. **执行之后的可见性**——面板唯一能看到的痕迹是"又收到了上报"。这里因此只呈现
 *      "有没有新上报 / 上报版本变了没有"，**没有**"升级成功/失败"这种结论；节点停止上报
 *      时，排空重建与掉线在面板上不可区分，必须两种解释都留着。
 *
 * ── 三条不能违反的纪律（本文件逐条兜住）──
 *
 *   · **`online` ≠ 升级成功 ≠ 健康**：新鲜度只说"面板还在收到上报"（连接事实）。
 *   · **身份校验结论如实**：脚本的身份校验只在**节点主机**上执行并打印结论，面板收不到它
 *     （`node-upgrade.ts` 的探针只 `printf` 到 stdout）。因此卡片**永远不显示"身份校验通过"**，
 *     并明确写出"以节点主机的脚本输出为准"。未校验不得写成通过。
 *   · **前置提示与后端同源**：`precondition.code/message` 直接来自服务端
 *     `checkUpgradePrecondition`，前端不另写一套"先切维护"的规则；离线上报阈值
 *     （`offline_after_seconds`）同样由服务端下发，前端不自己编窗口。
 *
 * ── 降级 ──
 * 取不到读投影 ⇒ 独立降级态（`unavailable`）+ 可重试，**不**显示"一切正常"；
 * 切 Workspace 时失效在途请求（scope guard），晚到的响应被丢弃（epoch/ticket 保护）。
 *
 * 文案在文件内（zh/en），沿用 `forward-latency.tsx` / `forward-topology.tsx` 的做法，
 * 刻意不碰 `lib/i18n/dictionaries.ts`（那是并行切片的写点）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18nOptional } from "@/components/providers";
import { useWorkspace } from "@/components/workspace/workspace-context";
import {
  UPGRADE_POLL_MS,
  canOfferAllowActive,
  canRenderDefault,
  readUpgradeState,
  renderUpgradeCommand,
  upgradeAftermath,
  upgradeErrorInfo,
  type NodeUpgradeState,
  type UpgradeErrorInfo,
  type UpgradeRecovery,
  type UpgradeReportFreshness,
  type UpgradeRequestRecord,
  type UpgradeVersionDrift,
} from "@/lib/api/node-upgrade";
import type { Locale } from "@/lib/i18n";
import type { ID, NodeUpgradeCommand } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

/* ================================================================== */
/* 文案（zh / en）                                                     */
/* ================================================================== */

export interface UpgradeCopy {
  title: string;
  subtitle: string;
  loading: string;
  deniedTitle: string;
  deniedBody: string;
  deniedAction: string;
  unavailableTitle: string;
  unavailableBody: string;
  unavailableRetry: string;
  refresh: string;
  refreshing: string;
  errorCode: string;
  runningVersion: string;
  neverReported: string;
  reportedAt: string;
  ageSeconds: (seconds: number) => string;
  freshness: Record<UpgradeReportFreshness, string>;
  freshnessMeaning: Record<UpgradeReportFreshness, string>;
  configuredVersion: string;
  configuredVersionCaveat: string;
  targetTitle: string;
  targetImage: string;
  imageSourceEnv: string;
  imageSourceDefault: string;
  expectedVersion: string;
  expectedVersionNone: string;
  drift: Record<UpgradeVersionDrift, string>;
  driftMeaning: Record<UpgradeVersionDrift, string>;
  lastError: string;
  preconditionTitle: string;
  preconditionOk: string;
  preconditionBlocked: (message: string) => string;
  allowActiveLabel: string;
  imageLabel: string;
  imagePlaceholder: string;
  generate: string;
  generating: string;
  noManagePermission: string;
  generateNote: string;
  scriptTitle: string;
  scriptNotUpgraded: string;
  scriptRunOnHost: string;
  scriptPreserves: string;
  scriptDowntime: string;
  scriptRollback: string;
  scriptIdentityBoundary: string;
  copy: string;
  copied: string;
  copyFailed: string;
  aftermathTitle: string;
  aftermathNotRequested: string;
  aftermathNoNewReport: string;
  aftermathNewReport: string;
  aftermathVersionChanged: (before: string, after: string) => string;
  aftermathVersionSame: (version: string) => string;
  aftermathStale: string;
  aftermathUnknown: string;
  aftermathLimit: string;
  recoveryTitle: string;
  recovery: Record<UpgradeRecovery, string>;
  requestLocalNote: string;
}

const ZH: UpgradeCopy = {
  title: "Agent 升级",
  subtitle:
    "控制面不会远程替换节点上的 Agent：这里生成一段脚本，由你在节点主机上执行。面板只能在事后从节点上报里看到痕迹，所以本卡片只呈现面板真的能看到的事实，不给结论。",
  loading: "正在读取节点事实…",
  deniedTitle: "没有查看该节点的权限",
  deniedBody: "当前工作空间角色没有 node:read，因此面板不会展示该节点的任何事实。",
  deniedAction: "请联系空间管理员调整角色。",
  unavailableTitle: "节点事实取不到",
  unavailableBody:
    "这次请求没有拿到数据，所以它不构成任何结论：既不能说该节点不需要升级，也不能说它没问题。可以重试；重试仍失败时请检查面板与后端。",
  unavailableRetry: "重新读取",
  refresh: "刷新",
  refreshing: "读取中…",
  errorCode: "后端返回",
  runningVersion: "当前运行版本（面板收到的上报）",
  neverReported: "从未上报",
  reportedAt: "上次上报",
  ageSeconds: (seconds) => `${seconds} 秒前`,
  freshness: { fresh: "面板仍在收到上报", stale: "上报已超过面板阈值", unknown: "没有可判定的上报" },
  freshnessMeaning: {
    fresh: "这是连接事实：节点在按节拍上报。它不说明版本对不对，也不说明升级有没有发生。",
    stale:
      "面板在这段时间没有收到该节点的上报。正在执行升级（排空/重建）与节点掉线在面板上无法区分，两种解释都要留着。",
    unknown: "这个节点还没有任何状态上报记录，因此没有「当前运行版本」可言。",
  },
  configuredVersion: "面板配置字段（管理员设置，不是实际上报版本）",
  configuredVersionCaveat:
    "它由管理员在面板侧填写，与实际运行中的 Agent 版本无关；判断「现在跑的是什么」只看上面的上报版本。",
  targetTitle: "升级目标",
  targetImage: "目标镜像（部署方配置）",
  imageSourceEnv: "来自 TUNEX_AGENT_IMAGE",
  imageSourceDefault: "面板内置默认值（部署方未配置 TUNEX_AGENT_IMAGE）",
  expectedVersion: "部署方声明的版本基线",
  expectedVersionNone: "未声明 —— 面板因此不判定版本落后",
  drift: { behind: "上报版本落后于该基线", not_behind: "上报版本不落后于该基线", unknown: "无法判定" },
  driftMeaning: {
    behind: "比较由服务端完成（与版本落后判定同一个函数）。落后 ≠ 故障，只是建议升级。",
    not_behind: "「不落后」= 相同或更新；它不代表该节点可以接新业务，也不代表升级执行过。",
    unknown: "基线未声明，或版本号无法比较（例如 unknown / 空值）：面板不猜。",
  },
  lastError: "Agent 自述的最近错误",
  preconditionTitle: "升级前置（服务端判定）",
  preconditionOk: "服务端前置通过：默认路径可以直接生成脚本。",
  preconditionBlocked: (message) => `服务端判定当前不能直接升级：${message}`,
  allowActiveLabel: "确认带业务升级（allow_active=true，跳过 maintenance 前置）",
  imageLabel: "目标镜像",
  imagePlaceholder: "ghcr.io/paimoncai/tunex-agent:replace-with-git-sha",
  generate: "生成升级命令",
  generating: "生成中…",
  noManagePermission: "当前角色没有 node:manage，只能查看，不能生成升级命令。",
  generateNote:
    "生成脚本不会改动节点上的任何东西：它只渲染一段文本。真正执行发生在你复制到节点主机之后。",
  scriptTitle: "升级脚本",
  scriptNotUpgraded: "命令已生成（本机记录）—— 生成脚本不代表已升级，也不代表节点会去执行它。",
  scriptRunOnHost: "请在节点主机上以 root 执行；脚本会先拉取镜像，再优雅排空并重建容器。",
  scriptPreserves: "服务端声明的不变量：节点身份 / 长期凭据 / 本地缓存 / Forward 关系保持不变。",
  scriptDowntime: "停机窗口",
  scriptRollback: "失败回退",
  scriptIdentityBoundary:
    "身份校验在节点主机上执行，结论只打印在那里 —— 面板收不到它，所以本卡片不给任何通过性结论，只以节点主机的输出为准。脚本只有在拿到 200 + Panel JSON 时才认为那次校验成立，其余情况一律打印「未校验」。",
  copy: "复制命令",
  copied: "已复制到剪贴板",
  copyFailed: "复制失败：请手动选中脚本内容",
  aftermathTitle: "执行之后：面板能看到的",
  aftermathNotRequested:
    "生成命令后，这里会显示面板随后收到的上报。面板看不到脚本的执行结果，所以「有没有新上报」是它唯一的痕迹。",
  aftermathNoNewReport:
    "生成命令之后，面板还没有收到该节点的新上报。它有两种解释，面板无法区分：脚本还没执行（或正在排空/重建），或者节点已经不再上报。",
  aftermathNewReport: "生成命令之后，面板又收到了该节点的新上报。",
  aftermathVersionChanged: (before, after) => `上报版本变了：${before} → ${after}（面板观测，不是判定）。`,
  aftermathVersionSame: (version) =>
    `上报版本仍是 ${version}：与生成命令时相同。可能还没执行完，也可能是「同一个版本重新起来了」。`,
  aftermathStale: "注意：这条上报已超过面板阈值（新鲜度=stale），它可能是升级前的最后一次。",
  aftermathUnknown: "注意：该节点的上报时刻不可用，无法判断新旧。",
  aftermathLimit:
    "面板不判断升级有没有达成：它看不到脚本输出、容器与镜像。若脚本在主机上回退了，面板也只会显示旧版本继续上报。",
  recoveryTitle: "下一步",
  recovery: {
    retry: "这是取数/服务端侧的失败：稍后重试同一请求是有意义的。",
    fix_image: "镜像引用不合法：改成 registry/name[:tag] 形式（不能含空格或 shell 字符）后重新生成。",
    enable_allow_active:
      "服务端要求节点先进入 maintenance。两条路：把节点切到 maintenance 再生成，或在你确认可以带业务升级时勾选上面的 allow_active 再生成。",
    install_first: "该节点还没有 agent_id：请先完成 Agent 安装，升级在此之前无从谈起。",
    retired: "该节点已退役（单向状态）：服务端不再接受它的升级请求。",
    permission: "需要 node:manage 权限：重试不会改变结论，请让空间管理员授予后再试。",
    not_found: "节点不存在，或不属于当前工作空间：请回到节点列表重新选择。",
    unknown: "服务端返回了未预期的失败：请查看上面的原始信息，必要时联系管理员。",
  },
  requestLocalNote:
    "「命令已生成」是这张卡片的本机记录，不是服务端事实：面板并不知道有人在升级（生成命令没有副作用）。",
};

const EN: UpgradeCopy = {
  title: "Agent upgrade",
  subtitle:
    "The control plane never replaces the Agent on a node: this card renders a script that you run on the node host. The panel can only see traces in later node reports, so this card renders only what the panel can actually see and reaches no verdict.",
  loading: "Reading node facts…",
  deniedTitle: "No permission to view this node",
  deniedBody: "Your current workspace role lacks node:read, so no node facts are shown.",
  deniedAction: "Ask a workspace admin to adjust your role.",
  unavailableTitle: "Node facts unavailable",
  unavailableBody:
    "This request returned no data, so it proves nothing: it does not mean the node is up to date, nor that anything is wrong. You can retry; if it keeps failing, check the panel and backend.",
  unavailableRetry: "Retry",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  errorCode: "Backend returned",
  runningVersion: "Current running version (as reported to the panel)",
  neverReported: "Never reported",
  reportedAt: "Last report",
  ageSeconds: (seconds) => `${seconds}s ago`,
  freshness: { fresh: "Panel is still receiving reports", stale: "Reports older than the panel threshold", unknown: "No report to judge" },
  freshnessMeaning: {
    fresh: "This is a connection fact: the node reports on schedule. It says nothing about versions or whether an upgrade happened.",
    stale:
      "The panel has not received a report from this node recently. A drain/rebuild in progress and a node that went down look identical here, so keep both readings.",
    unknown: "This node has never reported, so there is no running version to show.",
  },
  configuredVersion: "Panel configuration field (admin-set, NOT the reported version)",
  configuredVersionCaveat:
    "It is a value an admin typed in the panel and has nothing to do with the Agent version actually running; read the reported version above.",
  targetTitle: "Upgrade target",
  targetImage: "Target image (deployment-configured)",
  imageSourceEnv: "from TUNEX_AGENT_IMAGE",
  imageSourceDefault: "panel built-in default (TUNEX_AGENT_IMAGE unset)",
  expectedVersion: "Version baseline declared by the deployment",
  expectedVersionNone: "not declared — the panel therefore never judges version drift",
  drift: { behind: "Reported version is behind that baseline", not_behind: "Reported version is not behind that baseline", unknown: "cannot be determined" },
  driftMeaning: {
    behind: "The comparison is done server-side (same function as health synthesis). Behind is not a fault; it is an upgrade suggestion.",
    not_behind: "\"Not behind\" means equal or newer; it says nothing about health or about a completed upgrade.",
    unknown: "No baseline declared, or the versions cannot be compared (unknown/empty): the panel does not guess.",
  },
  lastError: "Last error reported by the Agent",
  preconditionTitle: "Upgrade precondition (server-decided)",
  preconditionOk: "Server precondition passes: the default path can render a script right away.",
  preconditionBlocked: (message) => `The server says this node cannot be upgraded on the default path: ${message}`,
  allowActiveLabel: "Upgrade while serving traffic (allow_active=true, skip the maintenance precondition)",
  imageLabel: "Target image",
  imagePlaceholder: "ghcr.io/paimoncai/tunex-agent:replace-with-git-sha",
  generate: "Generate upgrade command",
  generating: "Generating…",
  noManagePermission: "Your role lacks node:manage: you can look, but not generate an upgrade command.",
  generateNote:
    "Generating a script changes nothing on the node: it only renders text. Execution happens after you copy it to the node host.",
  scriptTitle: "Upgrade script",
  scriptNotUpgraded: "Command generated (recorded locally) — generating a script does not mean an upgrade happened, nor that the node will run it.",
  scriptRunOnHost: "Run it as root on the node host; it pulls the image first, then drains gracefully and recreates the container.",
  scriptPreserves: "Invariants declared by the server: node identity / long-lived credential / local cache / Forward relations are preserved.",
  scriptDowntime: "Downtime window",
  scriptRollback: "Failure rollback",
  scriptIdentityBoundary:
    "Identity verification runs on the node host and prints its verdict there — the panel never receives it, so this card shows no pass/fail verdict. The script itself only accepts a 200 with Panel JSON as a pass; anything else prints unverified. Trust the node host output.",
  copy: "Copy command",
  copied: "Copied to clipboard",
  copyFailed: "Copy failed: select the script manually",
  aftermathTitle: "After execution: what the panel can see",
  aftermathNotRequested:
    "Once a command is generated, this area shows the reports the panel receives afterwards. The panel cannot see the script's result, so \"did a new report arrive\" is the only trace there is.",
  aftermathNoNewReport:
    "No new report from this node since the command was generated. Two readings, and the panel cannot tell them apart: the script has not run yet (or is draining/rebuilding), or the node stopped reporting.",
  aftermathNewReport: "The panel received a new report from this node after the command was generated.",
  aftermathVersionChanged: (before, after) => `Reported version changed: ${before} → ${after} (panel observation, not a verdict).`,
  aftermathVersionSame: (version) =>
    `Reported version is still ${version}, same as when the command was generated. It may simply not be finished, or the same version came back up.`,
  aftermathStale: "Note: this report is older than the panel threshold (freshness=stale); it may predate the upgrade.",
  aftermathUnknown: "Note: this node's report timestamp is unavailable, so old and new cannot be told apart.",
  aftermathLimit:
    "The panel reaches no verdict about the upgrade: it cannot see the script output, the container or the image. If the script rolled back on the host, the panel will keep showing the old version reporting in.",
  recoveryTitle: "Next step",
  recovery: {
    retry: "This is a fetch/server-side failure: retrying the same request later is meaningful.",
    fix_image: "Invalid image reference: use registry/name[:tag] (no spaces or shell characters) and generate again.",
    enable_allow_active:
      "The server requires the node to be in maintenance first. Two options: put the node into maintenance and generate again, or tick allow_active above if you accept upgrading while serving traffic.",
    install_first: "This node has no agent_id yet: finish the Agent installation first; upgrading is not applicable before that.",
    retired: "This node is retired (a one-way state): the server no longer accepts upgrade requests for it.",
    permission: "This needs node:manage: retrying will not change the answer; ask a workspace admin to grant it.",
    not_found: "The node does not exist, or is not in the current workspace: pick it again from the node list.",
    unknown: "The server returned an unexpected failure: read the raw message above and contact an admin if needed.",
  },
  requestLocalNote:
    "\"Command generated\" is a local note on this card, not a server fact: the panel does not know anyone is upgrading (generating a command has no side effects).",
};

const COPY: Record<Locale, UpgradeCopy> = { zh: ZH, en: EN };

function copyFor(locale: Locale | undefined): UpgradeCopy {
  return locale === "en" ? EN : ZH;
}

/* ================================================================== */
/* 读投影的加载（含"只接受最新请求"的守卫）                               */
/* ================================================================== */

export interface NodeUpgradeViewState {
  status: "loading" | "denied" | "error" | "ready";
  data: NodeUpgradeState | null;
  error: UpgradeErrorInfo | null;
}

export function resetUpgradeViewState(): NodeUpgradeViewState {
  return { status: "loading", data: null, error: null };
}

export function deniedUpgradeViewState(): NodeUpgradeViewState {
  return { status: "denied", data: null, error: null };
}

/** 只接受最新请求：切 Workspace / 手动刷新时让在途响应失效（晚到的必须被丢弃）。 */
export interface UpgradeScopeGuard {
  claim(): number;
  invalidate(): void;
  isCurrent(token: number): boolean;
}

export function createUpgradeScopeGuard(): UpgradeScopeGuard {
  let latest = 0;
  return {
    claim: () => ++latest,
    invalidate: () => {
      latest += 1;
    },
    isCurrent: (token) => token === latest,
  };
}

export async function loadUpgradeView(input: {
  nodeId: ID;
  token: number;
  guard: UpgradeScopeGuard;
  read?: (nodeId: ID) => Promise<NodeUpgradeState>;
}): Promise<{ applied: boolean; state: NodeUpgradeViewState }> {
  const read = input.read ?? ((id: ID) => readUpgradeState(id));
  try {
    const data = await read(input.nodeId);
    return { applied: input.guard.isCurrent(input.token), state: { status: "ready", data, error: null } };
  } catch (error) {
    return {
      applied: input.guard.isCurrent(input.token),
      state: { status: "error", data: null, error: upgradeErrorInfo(error) },
    };
  }
}

/** 权限还没读出来时不能当作"没有权限"（同 `forward-latency.tsx:latencyGate`）。 */
export function upgradeGate(input: {
  hasReadPermission: boolean;
  permissionsLoading: boolean;
}): "wait" | "denied" | "load" {
  if (input.permissionsLoading) return "wait";
  return input.hasReadPermission ? "load" : "denied";
}

/**
 * 该不该自动刷新（以及多久一次）。
 *
 *   · 还没生成过命令 ⇒ 不轮询（没有人正在升级；这份事实只在用户自己动作后才需要跟踪）；
 *   · 已生成命令 ⇒ 按 {@link UPGRADE_POLL_MS} 跟踪"有没有新上报"；
 *   · 读取失败 / 无权限 ⇒ 不轮询（失败不许自动重试；403 重试还是 403）。
 */
export function upgradePollIntervalMs(
  state: NodeUpgradeViewState,
  requested: UpgradeRequestRecord | null,
): number | null {
  if (!requested) return null;
  return state.status === "ready" ? UPGRADE_POLL_MS : null;
}

/* ================================================================== */
/* 纯展示                                                              */
/* ================================================================== */

export interface NodeUpgradeViewProps {
  state: NodeUpgradeViewState;
  copy: UpgradeCopy;
  /** 本机记录：操作者为哪个镜像生成过命令。**不是**服务端事实。 */
  requested: UpgradeRequestRecord | null;
  script: NodeUpgradeCommand | null;
  scriptError: UpgradeErrorInfo | null;
  canManage: boolean;
  image: string;
  allowActive: boolean;
  busy: boolean;
  generating: boolean;
  copied: boolean;
  copyFailed: boolean;
  onImageChange: (value: string) => void;
  onAllowActiveChange: (value: boolean) => void;
  onGenerate: () => void;
  onCopy: () => void;
  onReload: () => void;
}

export function NodeUpgradeDataView(props: NodeUpgradeViewProps) {
  const { state, copy } = props;

  if (state.status === "denied") {
    return (
      <section data-testid="upgrade-denied" className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h3 className="text-sm font-medium">{copy.deniedTitle}</h3>
        <p className="mt-2 text-xs text-neutral-500">{copy.deniedBody}</p>
        <p className="mt-1 text-xs text-neutral-500">{copy.deniedAction}</p>
      </section>
    );
  }

  if (state.status === "loading") {
    return (
      <section data-testid="upgrade-loading" className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h3 className="text-sm font-medium">{copy.title}</h3>
        <p className="mt-2 text-xs text-neutral-500">{copy.loading}</p>
      </section>
    );
  }

  if (state.status === "error" || state.data === null) {
    return (
      <section data-testid="upgrade-unavailable" className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h3 className="text-sm font-medium">{copy.title}</h3>
        <p data-testid="upgrade-unavailable-body" className="mt-2 text-sm">
          {copy.unavailableBody}
        </p>
        <p data-testid="upgrade-unavailable-title" className="mt-1 text-xs font-medium">
          {copy.unavailableTitle}
        </p>
        {state.error ? (
          <p className="mt-2 text-xs text-neutral-500">
            {copy.errorCode} {state.error.status ?? "-"} / {state.error.code ?? "-"}：{state.error.message}
          </p>
        ) : null}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={props.onReload}
            disabled={props.busy}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
          >
            {props.busy ? copy.refreshing : copy.unavailableRetry}
          </button>
        </div>
      </section>
    );
  }

  const data = state.data;
  const aftermath = upgradeAftermath(data, props.requested);
  const allowActiveOffered = canOfferAllowActive(data.precondition);
  const defaultPathOk = canRenderDefault(data.precondition);

  return (
    <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">{copy.title}</h3>
          <p className="mt-1 max-w-3xl text-xs text-neutral-500">{copy.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={props.onReload}
          disabled={props.busy}
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
        >
          {props.busy ? copy.refreshing : copy.refresh}
        </button>
      </header>

      {/* ① 当前运行版本（上报事实）与配置字段（显式区分） */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
          <h4 className="text-xs font-medium text-neutral-500">{copy.runningVersion}</h4>
          <p data-testid="upgrade-running-version" className="mt-2 font-mono text-sm">
            {data.reported?.version ?? copy.neverReported}
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            {copy.reportedAt}：
            {data.reported?.reported_at
              ? `${formatDateTime(data.reported.reported_at)}${
                  data.reported.age_seconds === null ? "" : `（${copy.ageSeconds(data.reported.age_seconds)}）`
                }`
              : "-"}
          </p>
          <p data-testid="upgrade-freshness" data-state={data.report_freshness} className="mt-2 text-xs font-medium">
            {copy.freshness[data.report_freshness]}
          </p>
          <p className="mt-1 text-xs text-neutral-500">{copy.freshnessMeaning[data.report_freshness]}</p>
          {data.reported?.last_error ? (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-500">
              {copy.lastError}：{data.reported.last_error}
            </p>
          ) : null}
        </div>

        <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
          <h4 className="text-xs font-medium text-neutral-500">{copy.configuredVersion}</h4>
          <p data-testid="upgrade-configured-version" className="mt-2 font-mono text-sm">
            {data.configured_version}
          </p>
          <p className="mt-1 text-xs text-neutral-500">{copy.configuredVersionCaveat}</p>

          <h4 className="mt-3 text-xs font-medium text-neutral-500">{copy.targetTitle}</h4>
          <p className="mt-2 text-xs">
            {copy.targetImage}：<span data-testid="upgrade-target-image" className="font-mono">{data.target.image}</span>
            <span className="ml-1 text-neutral-500">
              （{data.target.image_source === "env:TUNEX_AGENT_IMAGE" ? copy.imageSourceEnv : copy.imageSourceDefault}）
            </span>
          </p>
          <p className="mt-1 text-xs">
            {copy.expectedVersion}：
            <span data-testid="upgrade-expected-version" className="font-mono">
              {data.target.expected_version ?? copy.expectedVersionNone}
            </span>
          </p>
          <p data-testid="upgrade-drift" data-state={data.target.version_drift} className="mt-1 text-xs font-medium">
            {copy.drift[data.target.version_drift]}
          </p>
          <p className="mt-1 text-xs text-neutral-500">{copy.driftMeaning[data.target.version_drift]}</p>
        </div>
      </div>

      {/* ② 前置（服务端原文）+ 生成脚本 */}
      <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
        <h4 className="text-sm font-medium">{copy.preconditionTitle}</h4>
        <p
          data-testid="upgrade-precondition"
          data-state={data.precondition.ok ? "ok" : data.precondition.code ?? "blocked"}
          className="mt-2 text-xs"
        >
          {data.precondition.ok
            ? copy.preconditionOk
            : copy.preconditionBlocked(data.precondition.message ?? "")}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="text-xs text-neutral-600 dark:text-neutral-400">
            {copy.imageLabel}
            <input
              aria-label={copy.imageLabel}
              placeholder={copy.imagePlaceholder}
              value={props.image}
              onChange={(event) => props.onImageChange(event.target.value)}
              className="ml-2 w-72 rounded border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700"
            />
          </label>
          {allowActiveOffered ? (
            <label className="flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-400">
              <input
                type="checkbox"
                checked={props.allowActive}
                onChange={(event) => props.onAllowActiveChange(event.target.checked)}
              />
              {copy.allowActiveLabel}
            </label>
          ) : null}
          <button
            type="button"
            onClick={props.onGenerate}
            disabled={props.generating || !props.canManage || !defaultPathOk || props.image.trim() === ""}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
          >
            {props.generating ? copy.generating : copy.generate}
          </button>
        </div>
        {!props.canManage ? <p className="mt-2 text-xs text-neutral-500">{copy.noManagePermission}</p> : null}
        <p className="mt-2 text-xs text-neutral-500">{copy.generateNote}</p>

        {props.scriptError ? (
          <div data-testid="upgrade-script-error" className="mt-3 rounded bg-neutral-50 p-3 dark:bg-neutral-900">
            <p className="text-sm">
              {copy.recoveryTitle}：{copy.recovery[props.scriptError.recovery]}
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              {copy.errorCode} {props.scriptError.status ?? "-"} / {props.scriptError.code ?? "-"}：
              {props.scriptError.message}
            </p>
          </div>
        ) : null}

        {props.script ? (
          <div className="mt-3 space-y-2">
            <p data-testid="upgrade-script-note" className="text-xs font-medium">
              {copy.scriptNotUpgraded}
            </p>
            <p className="text-xs text-neutral-500">{copy.scriptRunOnHost}</p>
            <p className="text-xs text-neutral-500">
              {copy.scriptPreserves} · {copy.scriptDowntime}：{props.script.downtime}
            </p>
            <p className="text-xs text-neutral-500">
              {copy.scriptRollback}：{props.script.rollback_hint}
            </p>
            <p data-testid="upgrade-identity-boundary" className="text-xs text-amber-700 dark:text-amber-500">
              {copy.scriptIdentityBoundary}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={props.onCopy}
                className="rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
              >
                {props.copied ? copy.copied : copy.copy}
              </button>
              {props.copyFailed ? <span className="text-xs text-red-600">{copy.copyFailed}</span> : null}
            </div>
            <pre
              data-testid="upgrade-script"
              className="max-h-64 overflow-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100"
            >
              {props.script.script}
            </pre>
          </div>
        ) : null}
      </div>

      {/* ③ 执行之后的可见性（面板能看到的唯一痕迹） */}
      <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
        <h4 className="text-sm font-medium">{copy.aftermathTitle}</h4>
        {props.requested ? (
          <p className="mt-1 text-xs text-neutral-500">
            {copy.requestLocalNote}（{formatDateTime(props.requested.at)} · {props.requested.image}）
          </p>
        ) : null}
        <p data-testid="upgrade-aftermath" data-state={aftermath.kind} className="mt-2 text-xs">
          {aftermath.kind === "not_requested"
            ? copy.aftermathNotRequested
            : aftermath.kind === "no_new_report"
              ? copy.aftermathNoNewReport
              : copy.aftermathNewReport}
        </p>
        {aftermath.kind === "new_report" ? (
          <p data-testid="upgrade-aftermath-version" className="mt-1 text-xs">
            {aftermath.versionChanged
              ? copy.aftermathVersionChanged(aftermath.versionBefore ?? copy.neverReported, aftermath.versionAfter ?? copy.neverReported)
              : copy.aftermathVersionSame(aftermath.versionAfter ?? copy.neverReported)}
          </p>
        ) : null}
        {props.requested && aftermath.freshness === "stale" ? (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-500">{copy.aftermathStale}</p>
        ) : null}
        {props.requested && aftermath.freshness === "unknown" ? (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-500">{copy.aftermathUnknown}</p>
        ) : null}
        <p className="mt-1 text-xs text-neutral-500">{copy.aftermathLimit}</p>
      </div>
    </section>
  );
}

/* ================================================================== */
/* 接线（只吃 nodeId；读/渲染可注入以便测试）                             */
/* ================================================================== */

export interface NodeUpgradeCardProps {
  nodeId: ID;
  /** 测试注入（客户端组件之间可传函数）。 */
  read?: (nodeId: ID) => Promise<NodeUpgradeState>;
  generate?: (
    nodeId: ID,
    input: { agent_image: string; allow_active?: boolean },
  ) => Promise<NodeUpgradeCommand>;
  copyText?: (text: string) => Promise<void>;
  pollMs?: number;
  locale?: Locale;
}

export function NodeUpgradeCard({
  nodeId,
  read,
  generate,
  copyText,
  pollMs = UPGRADE_POLL_MS,
  locale,
}: NodeUpgradeCardProps) {
  const i18n = useI18nOptional();
  const copy = copyFor(locale ?? i18n?.locale);
  const { currentId, can, permissionsLoading } = useWorkspace();
  const canRead = can("node:read");
  const canManage = can("node:manage");

  const [state, setState] = useState<NodeUpgradeViewState>(() => resetUpgradeViewState());
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState("");
  const [allowActive, setAllowActive] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [script, setScript] = useState<NodeUpgradeCommand | null>(null);
  const [scriptError, setScriptError] = useState<UpgradeErrorInfo | null>(null);
  const [requested, setRequested] = useState<UpgradeRequestRecord | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const guardRef = useRef<UpgradeScopeGuard | null>(null);
  if (guardRef.current === null) guardRef.current = createUpgradeScopeGuard();
  const guard = guardRef.current;
  const inFlightRef = useRef(false);
  // 目标镜像的默认值来自服务端（部署方配置），只在用户没改过时跟随。
  const imageTouchedRef = useRef(false);

  const run = useCallback(
    (options?: { keepState?: boolean }) => {
      const token = guard.claim();
      if (!options?.keepState) setState(resetUpgradeViewState());
      setBusy(true);
      inFlightRef.current = true;
      void loadUpgradeView({ nodeId, token, guard, read })
        .then((result) => {
          if (!result.applied) return; // 切 Workspace / 有更新的请求 ⇒ 丢弃晚到响应
          setState(result.state);
          if (result.state.data && !imageTouchedRef.current) {
            setImage(result.state.data.target.image);
          }
        })
        .finally(() => {
          inFlightRef.current = false;
          setBusy(false);
        });
    },
    [nodeId, guard, read],
  );

  useEffect(() => {
    const gate = upgradeGate({ hasReadPermission: canRead, permissionsLoading });
    if (gate === "wait") return;
    if (gate === "denied") {
      guard.claim();
      setState(deniedUpgradeViewState());
      return;
    }
    // 切空间：先把在途请求作废，再重新读。
    guard.invalidate();
    setRequested(null);
    setScript(null);
    setScriptError(null);
    imageTouchedRef.current = false;
    run();
    return () => guard.invalidate();
  }, [currentId, canRead, permissionsLoading, guard, run]);

  // 只有"生成过命令"之后才跟踪"有没有新上报"（见 upgradePollIntervalMs 的口径）。
  useEffect(() => {
    if (pollMs <= 0) return;
    const interval = upgradePollIntervalMs(state, requested);
    if (interval === null) return;
    const timer = setInterval(() => {
      if (inFlightRef.current) return;
      run({ keepState: true });
    }, Math.max(pollMs, interval));
    return () => clearInterval(timer);
  }, [state, requested, pollMs, run]);

  async function generateCommand() {
    setGenerating(true);
    setScriptError(null);
    setCopied(false);
    setCopyFailed(false);
    try {
      const result = await (generate ?? ((id: ID, input: { agent_image: string; allow_active?: boolean }) =>
        renderUpgradeCommand(id, input)))(nodeId, {
        agent_image: image.trim(),
        allow_active: allowActive,
      });
      setScript(result);
      // 只记录**本机**事实：生成脚本没有副作用，服务端不知道有人正在升级。
      setRequested({
        at: new Date().toISOString(),
        image: result.target_image,
        baseline_version: state.data?.reported?.version ?? null,
      });
    } catch (error) {
      setScript(null);
      setScriptError(upgradeErrorInfo(error));
    } finally {
      setGenerating(false);
    }
  }

  async function copyScript() {
    if (!script) return;
    try {
      if (copyText) await copyText(script.script);
      else if (typeof navigator !== "undefined" && navigator.clipboard) await navigator.clipboard.writeText(script.script);
      else throw new Error("clipboard unavailable");
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <NodeUpgradeDataView
      state={state}
      copy={copy}
      requested={requested}
      script={script}
      scriptError={scriptError}
      canManage={canManage}
      image={image}
      allowActive={allowActive}
      busy={busy}
      generating={generating}
      copied={copied}
      copyFailed={copyFailed}
      onImageChange={(value) => {
        imageTouchedRef.current = true;
        setImage(value);
      }}
      onAllowActiveChange={setAllowActive}
      onGenerate={() => void generateCommand()}
      onCopy={() => void copyScript()}
      onReload={() => run({ keepState: true })}
    />
  );
}

export { copyFor as nodeUpgradeCopy };
