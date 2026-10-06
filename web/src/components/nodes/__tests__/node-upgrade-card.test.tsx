/**
 * task-17 / 退出条件 #7 —— 用户侧「Agent 升级」卡片（`node-upgrade-card.tsx`）的行为不变量。
 *
 * 这个文件守的是**读法**，不是像素。逐条对应本任务的硬纪律：
 *
 *   1. **`online` ≠ 升级成功 ≠ 健康**：新鲜度只描述"面板还在收到上报"（连接事实）；
 *      "命令已生成"必须显式写成**不代表已升级**；
 *   2. **当前运行版本只能来自服务端上报**（`reported.version`），**不能**用管理员配置字段
 *      `node.version` 顶替（R1-A 的真机形状：配置字段 `unknown`、上报是 `0.13.22`）——
 *      两个字段都在卡片上，但必须各自说清自己是什么；
 *   3. **身份校验结论如实**：面板收不到脚本在节点主机上的探针结果，所以渲染文本里
 *      **不得**出现任何通过性结论；
 *   4. **前置提示与后端同源**：`precondition.message` 是服务端 `checkUpgradePrecondition`
 *      的原文，卡片逐字渲染；`allow_active` 勾选框只在服务端说"原因是未进入 maintenance"
 *      时出现（`node_retired` / `node_has_no_agent_id` 加它也没用）；
 *   5. **取不到 ⇒ 降级可重试**：`unavailable` 是独立状态，且**不得**出现「正常/健康/可达」
 *      这类词（否则"取不到"会被读成"没问题"）；
 *   6. **切 Workspace 丢弃晚到响应**（scope guard）。
 *
 * 真实样本来源：scratch 集成拓扑（Panel 127.0.0.1:18180，2026-10-06）的真实响应形状：
 * `node.version` 全为 `unknown`、`node_state_report.version` 为 `0.13.22`。
 *
 * 跑法（web 目录）：bun test src/components/nodes/__tests__/node-upgrade-card.test.tsx
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "@/lib/api/core";
import {
  UPGRADE_POLL_MS,
  classifyUpgradeRecovery,
  upgradeAftermath,
  upgradeErrorInfo,
  type NodeUpgradeState,
  type UpgradeRequestRecord,
} from "@/lib/api/node-upgrade";
import {
  NodeUpgradeDataView,
  createUpgradeScopeGuard,
  deniedUpgradeViewState,
  loadUpgradeView,
  nodeUpgradeCopy,
  resetUpgradeViewState,
  upgradeGate,
  upgradePollIntervalMs,
  type NodeUpgradeViewProps,
} from "@/components/nodes/node-upgrade-card";
import type { NodeUpgradeCommand } from "@/lib/types";

/* ================================================================== */
/* 真实形状的样本                                                       */
/* ================================================================== */

/** `GET /api/nodes/:id/upgrade-state` 的响应（真实字段形状；配置字段 unknown vs 上报 0.13.22）。 */
function upgradeState(over: Partial<NodeUpgradeState> = {}): NodeUpgradeState {
  const base: NodeUpgradeState = {
    node: { id: 1, node_key: "Integration-IN-A-NODE", agent_id: "e3ee9c09", role: "ingress", lifecycle: "active" },
    reported: {
      version: "0.13.22",
      role: "INGRESS",
      reported_at: "2026-10-06T17:29:49.601Z",
      age_seconds: 12,
      last_error: null,
    },
    report_freshness: "fresh",
    configured_version: "unknown",
    target: {
      image: "ghcr.io/paimoncai/tunex-agent:latest",
      image_source: "builtin_default",
      expected_version: null,
      version_drift: "unknown",
    },
    precondition: { ok: false, code: "node_not_in_maintenance", message: "升级前请先把节点置为 maintenance（避免在调度窗口内替换 Agent）；确认可以带业务升级时传 allow_active=true" },
    offline_after_seconds: 75,
    generated_at: "2026-10-06T17:40:00.000Z",
  };
  return { ...base, ...over };
}

const SCRIPT: NodeUpgradeCommand = {
  node: { id: 1, node_id: "Integration-IN-A-NODE", agent_id: "e3ee9c09", lifecycle: "active" },
  target_image: "ghcr.io/paimoncai/tunex-agent:1.5.0",
  allow_active: false,
  script: "#!/bin/sh\n# TuneX Agent 升级脚本\ndocker pull ghcr.io/paimoncai/tunex-agent:1.5.0\n",
  preserves: { node_identity: true, credential: true, lkg_state: true, forwards: true },
  rollback_hint: "docker stop -t 15 tunex-agent && docker rm -f tunex-agent，再用旧镜像重新运行安装脚本",
  downtime: "升级窗口内该节点不接受新业务；在途连接最多等待 15 秒完成排空",
};

function viewProps(over: Partial<NodeUpgradeViewProps> = {}): NodeUpgradeViewProps {
  return {
    state: { status: "ready", data: upgradeState(), error: null },
    copy: nodeUpgradeCopy("zh"),
    requested: null,
    script: null,
    scriptError: null,
    canManage: true,
    image: "ghcr.io/paimoncai/tunex-agent:latest",
    allowActive: false,
    busy: false,
    generating: false,
    copied: false,
    copyFailed: false,
    onImageChange: () => {},
    onAllowActiveChange: () => {},
    onGenerate: () => {},
    onCopy: () => {},
    onReload: () => {},
    ...over,
  };
}

function render(over: Partial<NodeUpgradeViewProps> = {}): string {
  return renderToStaticMarkup(<NodeUpgradeDataView {...viewProps(over)} />);
}

/** 全文禁用词：这些词一旦出现在渲染文本里，用户就会把缺数据读成"没问题"。 */
const FORBIDDEN = ["正常", "健康", "可达", "成功", "已完成", "一切正常", "校验通过"];

function expectNoForbidden(markup: string) {
  for (const word of FORBIDDEN) {
    expect(markup.includes(word)).toBe(false);
  }
}

/* ================================================================== */
/* ① 当前运行版本 = 服务端上报，不是配置字段                              */
/* ================================================================== */

describe("运行版本来自上报，不与配置字段混淆", () => {
  test("上报 0.13.22 / 配置 unknown：运行版本槽位显示上报值", () => {
    const markup = render();
    expect(markup).toContain('data-testid="upgrade-running-version"');
    expect(markup).toContain("0.13.22");
    // 配置字段单独一格，并且带显式说明（R1-A：它不代表实际运行版本）。
    expect(markup).toContain('data-testid="upgrade-configured-version"');
    expect(markup).toContain("unknown");
    expect(markup).toContain("不是实际上报版本");
    // 运行版本槽位里绝不能出现配置字段的值。
    const slot = /data-testid="upgrade-running-version"[^>]*>([^<]*)</.exec(markup);
    expect(slot?.[1]).toContain("0.13.22");
  });

  test("反过来也不成立：配置为 1.2.3、从未上报 ⇒ 运行版本是「从未上报」", () => {
    const markup = render({
      state: {
        status: "ready",
        data: upgradeState({ reported: null, report_freshness: "unknown", configured_version: "1.2.3" }),
        error: null,
      },
    });
    const slot = /data-testid="upgrade-running-version"[^>]*>([^<]*)</.exec(markup);
    expect(slot?.[1]).toBe("从未上报");
    expect(slot?.[1]).not.toContain("1.2.3");
    expect(markup).toContain('data-state="unknown"');
    expectNoForbidden(markup);
  });

  test("新鲜度是连接事实，且 stale 保留两种解释（掉线 / 正在排空重建）", () => {
    const markup = render({
      state: { status: "ready", data: upgradeState({ report_freshness: "stale" }), error: null },
    });
    expect(markup).toContain('data-testid="upgrade-freshness"');
    expect(markup).toContain('data-state="stale"');
    expect(markup).toContain("无法区分");
    expect(markup).toContain("排空/重建");
    // 「连接事实」这句话属于 fresh（面板还在收上报）那一态，这里不该出现。
    expect(markup).not.toContain("这是连接事实");
    expectNoForbidden(markup);
  });

  test("目标镜像与版本基线读服务端；基线未声明 ⇒ 不判落后", () => {
    const markup = render();
    expect(markup).toContain("ghcr.io/paimoncai/tunex-agent:latest");
    expect(markup).toContain("未声明");
    expect(markup).toContain('data-state="unknown"');
    // 「未声明」不该被渲染成"配置有问题"那条（两者是两件事）。
    expect(markup).not.toContain('data-testid="upgrade-baseline-uncomparable"');
    expect(markup).toContain('data-state="unset"');
    expectNoForbidden(markup);
  });

  test("基线配了但不可比较（旧版安装器写 git sha）⇒ 单独说明，不折算成落后 / 最新", () => {
    const SHA = "0123456789abcdef0123456789abcdef01234567";
    const markup = render({
      state: {
        status: "ready",
        data: upgradeState({
          target: {
            image: "ghcr.io/paimoncai/tunex-agent:latest",
            image_source: "builtin_default",
            expected_version: SHA,
            version_drift: "unknown",
          },
        }),
        error: null,
      },
    });
    expect(markup).toContain('data-testid="upgrade-baseline-uncomparable"');
    expect(markup).toContain("不可比较");
    expect(markup).toContain("--agent-version");
    expect(markup).toContain(SHA); // 原值透传：面板不吞掉配置值
    expect(markup).not.toContain("未声明 ——");
    expectNoForbidden(markup);
  });

  test("基线可比较且落后 ⇒ 显示落后，且不出现不可比较那段", () => {
    const markup = render({
      state: {
        status: "ready",
        data: upgradeState({
          target: {
            image: "ghcr.io/paimoncai/tunex-agent:0.14.0",
            image_source: "env:TUNEX_AGENT_IMAGE",
            expected_version: "0.14.0",
            version_drift: "behind",
          },
        }),
        error: null,
      },
    });
    expect(markup).toContain('data-testid="upgrade-drift"');
    expect(markup).toContain('data-state="behind"');
    expect(markup).not.toContain('data-testid="upgrade-baseline-uncomparable"');
    expectNoForbidden(markup);
  });
});

/* ================================================================== */
/* ② 前置：服务端原文 + allow_active 只在有意义时出现                      */
/* ================================================================== */

describe("前置提示与后端 checkUpgradePrecondition 同源", () => {
  test("not_in_maintenance：逐字渲染服务端 message，并给出 allow_active 勾选框", () => {
    const message = "升级前请先把节点置为 maintenance（避免在调度窗口内替换 Agent）；确认可以带业务升级时传 allow_active=true";
    const markup = render({
      state: { status: "ready", data: upgradeState({ precondition: { ok: false, code: "node_not_in_maintenance", message } }), error: null },
    });
    expect(markup).toContain(message); // 原文，不是前端自己编的话
    expect(markup).toContain('data-state="node_not_in_maintenance"');
    expect(markup).toContain("allow_active=true");
  });

  test("retired：渲染服务端 message，但**不**提供 allow_active（加了也没用）", () => {
    const message = "该节点已退役（单向状态），不再接受升级";
    const markup = render({
      state: { status: "ready", data: upgradeState({ precondition: { ok: false, code: "node_retired", message } }), error: null },
    });
    expect(markup).toContain(message);
    expect(markup).not.toContain("allow_active=true");
    // 生成按钮被禁用（前置不通过 + 不可豁免）。
    expect(markup).toContain("disabled");
  });

  test("没有 agent_id：渲染服务端 message（先完成安装）", () => {
    const message = "该节点还没有 agent_id，请先完成安装";
    const markup = render({
      state: { status: "ready", data: upgradeState({ precondition: { ok: false, code: "node_has_no_agent_id", message } }), error: null },
    });
    expect(markup).toContain(message);
    expect(markup).not.toContain("allow_active=true");
  });

  test("前置通过：给出「可以生成」的服务端结论", () => {
    const markup = render({
      state: { status: "ready", data: upgradeState({ precondition: { ok: true, code: null, message: null } }), error: null },
    });
    expect(markup).toContain('data-state="ok"');
    expect(markup).toContain("服务端前置通过");
  });
});

/* ================================================================== */
/* ③ 生成脚本：不代表已升级；身份校验没有面板侧结论                        */
/* ================================================================== */

describe("升级脚本的呈现边界", () => {
  const requested: UpgradeRequestRecord = {
    at: "2026-10-06T17:41:00.000Z",
    image: "ghcr.io/paimoncai/tunex-agent:1.5.0",
    baseline_version: "0.13.22",
  };

  test("已生成：明说「生成脚本不代表已升级」，并渲染脚本文本", () => {
    const markup = render({ script: SCRIPT, requested, image: "ghcr.io/paimoncai/tunex-agent:1.5.0" });
    expect(markup).toContain("生成脚本不代表已升级");
    expect(markup).toContain('data-testid="upgrade-script"');
    expect(markup).toContain("docker pull ghcr.io/paimoncai/tunex-agent:1.5.0");
    expect(markup).toContain("本机记录"); // 「命令已生成」是本机记录，不是服务端事实
    expectNoForbidden(markup);
  });

  test("身份校验：渲染文本里没有任何通过性结论，并写明以节点主机输出为准", () => {
    const markup = render({ script: SCRIPT, requested });
    expect(markup).toContain('data-testid="upgrade-identity-boundary"');
    expect(markup).toContain("面板收不到");
    expect(markup).toContain("未校验");
    expect(markup).toContain("节点主机");
    // 关键：不得出现任何"校验通过"字样（未校验不得写成通过）。
    expect(markup.includes("校验通过")).toBe(false);
    expect(markup.includes("通过校验")).toBe(false);
  });

  test("未生成时不显示脚本区（生成 ≠ 已升级，也不暗示已经生成过）", () => {
    const markup = render();
    expect(markup).not.toContain('data-testid="upgrade-script"');
  });
});

/* ================================================================== */
/* ④ 执行之后：面板只能看到"有没有新上报"                                */
/* ================================================================== */

describe("执行之后的可见性（面板唯一能看到的痕迹）", () => {
  const requested: UpgradeRequestRecord = {
    at: "2026-10-06T17:41:00.000Z",
    image: "ghcr.io/paimoncai/tunex-agent:1.5.0",
    baseline_version: "0.13.22",
  };

  test("未生成过命令 ⇒ 说明这块将来会显示什么，且不暗示正在升级", () => {
    const markup = render();
    expect(markup).toContain('data-state="not_requested"');
    expectNoForbidden(markup);
  });

  test("生成后没有新上报 ⇒ 两种解释都留着（分不清排空重建与掉线）", () => {
    const state = upgradeState({
      reported: { version: "0.13.22", role: "INGRESS", reported_at: "2026-10-06T17:40:00.000Z", age_seconds: 65, last_error: null },
      report_freshness: "stale",
    });
    const markup = render({ state: { status: "ready", data: state, error: null }, requested });
    expect(markup).toContain('data-state="no_new_report"');
    expect(markup).toContain("两种解释");
    expect(markup).toContain("无法区分");
    expectNoForbidden(markup);
  });

  test("生成后有新上报且版本变了 ⇒ 只报面板观测，不下任何结论", () => {
    const state = upgradeState({
      reported: { version: "0.14.0", role: "INGRESS", reported_at: "2026-10-06T17:42:30.000Z", age_seconds: 10, last_error: null },
    });
    const markup = render({ state: { status: "ready", data: state, error: null }, requested });
    expect(markup).toContain('data-state="new_report"');
    expect(markup).toContain("0.13.22 → 0.14.0");
    expect(markup).toContain("面板观测");
    expectNoForbidden(markup);
  });

  test("生成后有新上报但版本没变 ⇒ 不解释成失败，也不解释成成功", () => {
    const state = upgradeState({
      reported: { version: "0.13.22", role: "INGRESS", reported_at: "2026-10-06T17:42:30.000Z", age_seconds: 10, last_error: null },
    });
    const markup = render({ state: { status: "ready", data: state, error: null }, requested });
    expect(markup).toContain('data-state="new_report"');
    expect(markup).toContain("同一个版本重新起来了");
    expectNoForbidden(markup);
  });
});

/* ================================================================== */
/* ⑤ 降级 / 无权限：取不到 ≠ 一切正常                                    */
/* ================================================================== */

describe("降级与无权限", () => {
  test("取不到：独立降级态 + 可重试 + 明确「不构成任何结论」", () => {
    const markup = render({
      state: {
        status: "error",
        data: null,
        error: { status: 503, code: "db_unavailable", message: "面板暂时不可用", layer: null, recovery: "retry" },
      },
    });
    expect(markup).toContain('data-testid="upgrade-unavailable"');
    expect(markup).toContain("取不到");
    expect(markup).toContain("不构成任何结论");
    expect(markup).toContain("重新读取");
    expect(markup).not.toContain('data-testid="upgrade-running-version"');
    expectNoForbidden(markup);
  });

  test("无 node:read：独立无权限面，不渲染任何节点事实", () => {
    const markup = render({ state: deniedUpgradeViewState() });
    expect(markup).toContain('data-testid="upgrade-denied"');
    expect(markup).not.toContain('data-testid="upgrade-running-version"');
    expectNoForbidden(markup);
  });

  test("脚本渲染失败：给出与该失败对应的下一步（不是笼统的「重试」）", () => {
    const markup = render({
      scriptError: {
        status: 409,
        code: "node_not_in_maintenance",
        message: "升级前请先把节点置为 maintenance（避免在调度窗口内替换 Agent）；确认可以带业务升级时传 allow_active=true",
        layer: "runtime_admission",
        recovery: "enable_allow_active",
      },
    });
    expect(markup).toContain('data-testid="upgrade-script-error"');
    expect(markup).toContain("maintenance");
    expect(markup).toContain("allow_active");
    expectNoForbidden(markup);
  });
});

/* ================================================================== */
/* ⑥ 纯函数：三态映射、失败分类、轮询口径、晚到响应                        */
/* ================================================================== */

describe("读法与状态机（纯函数）", () => {
  test("失败分类：每一种失败对应一种具体修法", () => {
    expect(classifyUpgradeRecovery(403, "forbidden")).toBe("permission");
    expect(classifyUpgradeRecovery(404, "not_found")).toBe("not_found");
    expect(classifyUpgradeRecovery(400, "invalid_image")).toBe("fix_image");
    expect(classifyUpgradeRecovery(409, "node_not_in_maintenance")).toBe("enable_allow_active");
    expect(classifyUpgradeRecovery(409, "node_has_no_agent_id")).toBe("install_first");
    expect(classifyUpgradeRecovery(409, "node_retired")).toBe("retired");
    expect(classifyUpgradeRecovery(503, null)).toBe("retry");
    expect(classifyUpgradeRecovery(429, null)).toBe("retry");
    expect(classifyUpgradeRecovery(null, null)).toBe("retry");
  });

  test("upgradeErrorInfo 从 ApiError 取 code / layer / 原文", () => {
    const error = new ApiError(409, "该节点已退役（单向状态），不再接受升级", {
      error: "该节点已退役（单向状态），不再接受升级",
      code: "node_retired",
      error_layer: "runtime_admission",
    });
    const info = upgradeErrorInfo(error);
    expect(info.status).toBe(409);
    expect(info.code).toBe("node_retired");
    expect(info.layer).toBe("runtime_admission");
    expect(info.recovery).toBe("retired");
    expect(info.message).toContain("退役");
  });

  test("aftermath 四态：未生成 / 无新上报 / 有新上报（版本变与不变）", () => {
    const state = upgradeState();
    expect(upgradeAftermath(state, null).kind).toBe("not_requested");

    const before = { at: "2026-10-07T00:00:00.000Z", image: "img:1", baseline_version: "0.13.22" };
    const older = upgradeState({
      reported: { version: "0.13.22", role: null, reported_at: "2026-10-06T23:59:00.000Z", age_seconds: 60, last_error: null },
    });
    expect(upgradeAftermath(older, before).kind).toBe("no_new_report");

    const newer = upgradeState({
      reported: { version: "0.14.0", role: null, reported_at: "2026-10-07T00:00:30.000Z", age_seconds: 10, last_error: null },
    });
    const aftermath = upgradeAftermath(newer, before);
    expect(aftermath.kind).toBe("new_report");
    expect(aftermath.versionChanged).toBe(true);

    const same = upgradeAftermath(upgradeState({ reported: { version: "0.13.22", role: null, reported_at: "2026-10-07T00:00:30.000Z", age_seconds: 10, last_error: null } }), before);
    expect(same.kind).toBe("new_report");
    expect(same.versionChanged).toBe(false);
  });

  test("轮询口径：生成过命令才跟踪，且只在读投影就绪时轮询", () => {
    const record: UpgradeRequestRecord = { at: "2026-10-07T00:00:00.000Z", image: "img:1", baseline_version: null };
    expect(upgradePollIntervalMs({ status: "ready", data: upgradeState(), error: null }, null)).toBeNull();
    expect(upgradePollIntervalMs({ status: "ready", data: upgradeState(), error: null }, record)).toBe(UPGRADE_POLL_MS);
    expect(
      upgradePollIntervalMs(
        { status: "error", data: null, error: { status: 503, code: null, message: "x", layer: null, recovery: "retry" } },
        record,
      ),
    ).toBeNull();
    expect(upgradePollIntervalMs(resetUpgradeViewState(), record)).toBeNull();
  });

  test("权限还没读出来时不是「没有权限」", () => {
    expect(upgradeGate({ hasReadPermission: false, permissionsLoading: true })).toBe("wait");
    expect(upgradeGate({ hasReadPermission: false, permissionsLoading: false })).toBe("denied");
    expect(upgradeGate({ hasReadPermission: true, permissionsLoading: false })).toBe("load");
  });

  test("切 Workspace：晚到响应必须被丢弃（applied=false）", async () => {
    const guard = createUpgradeScopeGuard();
    const token = guard.claim();
    let release!: (value: NodeUpgradeState) => void;
    const pending = loadUpgradeView({
      nodeId: 1,
      token,
      guard,
      read: () => new Promise<NodeUpgradeState>((resolve) => { release = resolve; }),
    });
    guard.invalidate(); // 切空间：在途请求作废
    release(upgradeState());
    const result = await pending;
    expect(result.applied).toBe(false);
    expect(result.state.status).toBe("ready"); // 数据本身有效，但**不得**应用到界面
  });

  test("切 Workspace 之后新的请求仍然生效", async () => {
    const guard = createUpgradeScopeGuard();
    guard.invalidate();
    const token = guard.claim();
    const result = await loadUpgradeView({ nodeId: 1, token, guard, read: async () => upgradeState() });
    expect(result.applied).toBe(true);
    expect(result.state.status).toBe("ready");
  });

  test("读取失败被分类成可重试，而不是被当成没问题", async () => {
    const guard = createUpgradeScopeGuard();
    const token = guard.claim();
    const result = await loadUpgradeView({
      nodeId: 1,
      token,
      guard,
      read: async () => {
        throw new ApiError(503, "面板暂时不可用", { code: "db_unavailable" });
      },
    });
    expect(result.state.status).toBe("error");
    expect(result.state.error?.recovery).toBe("retry");
  });
});

/* ================================================================== */
/* ⑦ 中英双语都在（且英文面同样不给通过性结论）                            */
/* ================================================================== */

describe("zh/en 双语", () => {
  test("英文面渲染英文文案", () => {
    const markup = render({ copy: nodeUpgradeCopy("en") });
    expect(markup).toContain("Agent upgrade");
    expect(markup).toContain("Current running version");
    expect(markup).toContain("Panel configuration field");
  });

  test("英文面也不出现通过性 / 健康性结论", () => {
    const markup = render({
      copy: nodeUpgradeCopy("en"),
      script: SCRIPT,
      requested: { at: "2026-10-06T17:41:00.000Z", image: "ghcr.io/paimoncai/tunex-agent:1.5.0", baseline_version: "0.13.22" },
    });
    for (const word of ["success", "succeeded", "healthy", "reachable", "identity verified"]) {
      expect(markup.toLowerCase().includes(word)).toBe(false);
    }
  });
});
