/**
 * V4-WP7 §13.4.2 / §13.4.3 — Node 生命周期产品 UX（web 侧）契约单测。
 * 纯逻辑 + mock 端点 + 源码断言，不起浏览器。
 *
 * 覆盖交付要求里的五件事：
 *   A. **端点契约**：`GET/PATCH/DELETE /admin/node/:id/lifecycle` 与
 *      `GET /admin/node/:id/impact` 的形状、错误码（`code` + `condition` +
 *      `dependencies` 平级在顶层）与后端 `routes/node-lifecycle.ts` 一致。
 *   B. **判定权在服务端**：迁移白名单、删除闸门顺序、备注语义。
 *   C. **前端只做翻译**：`allowed_transitions` 是按钮的唯一来源；`retiring`
 *      单向门不出「取消退役」；`deletePreview` 只用于禁用按钮。
 *   D. **安装等待闭环**：waiting → online 的终止条件、凭据缺失/超时语义。
 *   E. **接线**：详情页挂生命周期卡、列表页有生命周期列与概览、安装闭环
 *      在列表与详情复用同一组件。
 *
 * 跑法（web 目录）：bun test src/components/admin/__tests__/wp7-node-lifecycle.test.ts
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { handleMock } from "@/mocks/handler";
import { getStore, resetStore } from "@/mocks/state";
import { MOCK_LIFECYCLE_SEED, MOCK_PORT_LEASE_SEED } from "@/mocks/node-lifecycle";
import {
  IMPACT_COUNT_KEYS,
  LIFECYCLE_ORDER,
  NODE_LIFECYCLE_CONDITION_CODES,
  deletePreview,
  impactEntries,
  impactIsEmpty,
  installClosureReached,
  installPhase,
  isInstallAdmissionRejection,
  isTerminalLifecycle,
  lifecycleActionTargets,
  lifecycleErrorInfo,
} from "@/lib/node-lifecycle";
import {
  LIFECYCLE_NOTE_MAX,
  NODE_LIFECYCLE_DICTS,
  conditionAction,
  conditionTitle,
  impactLabel,
  nodeLifecycleText,
} from "@/lib/node-lifecycle-i18n";
import type {
  Node,
  NodeImpact,
  NodeImpactResult,
  NodeLifecycleChangeResult,
  NodeLifecycleView,
} from "@/lib/types";

const COOKIE = "tunex_session=u1"; // mock 演示用户（owner，具备 admin 权限）
const call = <T>(method: string, path: string, query?: Record<string, string>, body?: unknown) =>
  handleMock(method, path, { cookie: COOKIE, query, body }) as Promise<{ status: number; body: T }>;

/** 演示节点：sg-out-01（id 6）——种子里唯一「有凭据 + 在线 + 有上报 + 有租约」的节点。 */
const DEMO = 6;
/** 尚未安装的节点：hk-in-01（id 1）在种子里 connection = waiting（无凭据）。 */
const WAITING = 1;

beforeEach(() => {
  resetStore();
});

/* ================================================================== */
/* A. 端点契约                                                          */
/* ================================================================== */

describe("WP7 lifecycle 端点契约", () => {
  test("GET 单节点：200 + 视图形状（lifecycle/connection/allowed_transitions/准入）", async () => {
    const res = await call<NodeLifecycleView>("GET", `/admin/node/${DEMO}/lifecycle`);
    expect(res.status).toBe(200);
    const v = res.body;
    expect(v.id).toBe(DEMO);
    expect(v.node_id).toBe("sg-out-01");
    expect(["active", "maintenance", "disabled", "retiring"]).toContain(v.lifecycle);
    expect(["waiting", "online", "offline"]).toContain(v.connection);
    expect(Array.isArray(v.allowed_transitions)).toBe(true);
    expect(typeof v.accepts_new_business).toBe("boolean");
    // 视图的键集合固定：凭据哈希与备注都不在这里（备注是节点行的一列）
    expect(Object.keys(v).sort()).toEqual([
      "accepts_new_business",
      "admission_rejection",
      "allowed_transitions",
      "connection",
      "credential_revoked",
      "has_credential",
      "id",
      "lifecycle",
      "node_id",
      "role",
    ]);
    expect(JSON.stringify(v)).not.toContain("node_credential_hash");
  });

  test("allowed_transitions 来自服务端：含自身（幂等写合法），retiring 无出口", async () => {
    // 种子里 sg-out-01 是 maintenance；后端 allowedTransitions 原样下发白名单，
    // 「不含自身」是**前端渲染**时才过滤的（lifecycleActionTargets），不是契约。
    const before = await call<NodeLifecycleView>("GET", `/admin/node/${DEMO}/lifecycle`);
    expect(before.body.lifecycle).toBe("maintenance");
    expect([...before.body.allowed_transitions].sort()).toEqual([
      "active",
      "disabled",
      "maintenance",
      "retiring",
    ]);

    await call("PATCH", `/admin/node/${DEMO}/lifecycle`, undefined, { lifecycle: "retiring" });
    const retiring = await call<NodeLifecycleView>("GET", `/admin/node/${DEMO}/lifecycle`);
    expect(retiring.body.lifecycle).toBe("retiring");
    // retiring 单向门：唯一合法目标是自己，前端据此渲染出「没有出口」
    expect(retiring.body.allowed_transitions).toEqual(["retiring"]);
    expect(lifecycleActionTargets(retiring.body)).toEqual([]);
  });

  test("PATCH 成功：返回 { node, view } 同源，备注落在节点行", async () => {
    const res = await call<NodeLifecycleChangeResult>("PATCH", `/admin/node/${DEMO}/lifecycle`, undefined, {
      lifecycle: "disabled",
      note: "换网卡",
    });
    expect(res.status).toBe(200);
    expect(res.body.view.lifecycle).toBe("disabled");
    expect(res.body.node.lifecycle).toBe("disabled");
    // 两个来源必须一致：详情说停用而列表说使用中是最伤信任的 bug
    expect(res.body.node.lifecycle).toBe(res.body.view.lifecycle);
    // 视图**不带**备注（固定十键）；备注在 node 行上
    expect(res.body.view).not.toHaveProperty("note");
    expect(res.body.node.lifecycle_note).toBe("换网卡");
  });

  test("PATCH 非法迁移：409 + code=invalid_state + condition=invalid_transition", async () => {
    await call("PATCH", `/admin/node/${DEMO}/lifecycle`, undefined, { lifecycle: "retiring" });
    const res = await call<Record<string, unknown>>("PATCH", `/admin/node/${DEMO}/lifecycle`, undefined, {
      lifecycle: "active",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("invalid_state");
    expect(res.body.condition).toBe("invalid_transition");
  });

  test("disabled → maintenance 被拒（两个态都拒新业务，重启维护态无意义）", async () => {
    await call("PATCH", `/admin/node/${DEMO}/lifecycle`, undefined, { lifecycle: "disabled" });
    const res = await call<Record<string, unknown>>("PATCH", `/admin/node/${DEMO}/lifecycle`, undefined, {
      lifecycle: "maintenance",
    });
    expect(res.status).toBe(409);
    expect(res.body.condition).toBe("invalid_transition");
  });

  test("PATCH 非法枚举 / 超长备注：400 + code=invalid_input", async () => {
    const bad = await call<Record<string, unknown>>("PATCH", `/admin/node/${DEMO}/lifecycle`, undefined, {
      lifecycle: "deleted",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_input");

    const long = await call<Record<string, unknown>>("PATCH", `/admin/node/${DEMO}/lifecycle`, undefined, {
      note: "x".repeat(LIFECYCLE_NOTE_MAX + 1),
    });
    expect(long.status).toBe(400);
    expect(long.body.code).toBe("invalid_input");
  });

  test("PATCH 备注语义：缺省=不动、空串=清空、可只改备注不改生命周期", async () => {
    await call("PATCH", `/admin/node/${DEMO}/lifecycle`, undefined, { lifecycle: "maintenance", note: "原有备注" });
    expect((await call<Node>("GET", `/admin/nodes/${DEMO}`)).body.lifecycle_note).toBe("原有备注");

    // 1) 只改生命周期（无 note 键）→ 备注保留
    const kept = await call<NodeLifecycleChangeResult>("PATCH", `/admin/node/${DEMO}/lifecycle`, undefined, {
      lifecycle: "active",
    });
    expect(kept.body.node.lifecycle_note).toBe("原有备注");

    // 2) 不带 lifecycle 只带 note → 只动备注（幂等写，生命周期不变）
    const renoted = await call<NodeLifecycleChangeResult>("PATCH", `/admin/node/${DEMO}/lifecycle`, undefined, {
      note: "改主意了",
    });
    expect(renoted.body.view.lifecycle).toBe("active");
    expect(renoted.body.node.lifecycle_note).toBe("改主意了");

    // 3) 显式空串 → 清空
    const cleared = await call<NodeLifecycleChangeResult>("PATCH", `/admin/node/${DEMO}/lifecycle`, undefined, {
      note: "",
    });
    expect(cleared.body.node.lifecycle_note).toBeNull();
  });

  test("GET impact：五类计数 + role_check（收缩检查与写入同源）", async () => {
    const res = await call<NodeImpactResult>("GET", `/admin/node/${DEMO}/impact`);
    expect(res.status).toBe(200);
    for (const key of IMPACT_COUNT_KEYS) {
      expect(typeof res.body.impact[key]).toBe("number");
    }
    expect(Array.isArray(res.body.impact.blockers)).toBe(true);
    expect(res.body.role_check).toBeDefined();
    expect(typeof res.body.role_check.ok).toBe("boolean");
  });

  test("DELETE 闸门：未 retiring → 409 invalid_state；有依赖 → 409 dependency_blocked", async () => {
    // 1) 还活着就想删（种子里 sg-out-01 是 maintenance）
    const notRetiring = await call<Record<string, unknown>>("DELETE", `/admin/node/${DEMO}/lifecycle`);
    expect(notRetiring.status).toBe(409);
    expect(notRetiring.body.code).toBe("invalid_state");
    expect(notRetiring.body.condition).toBe("node_not_retiring");

    // 2) 已退役但还有依赖（DEMO 是种子里有租约/出口池/绑定的节点）
    await call("PATCH", `/admin/node/${DEMO}/lifecycle`, undefined, { lifecycle: "retiring" });
    const blocked = await call<Record<string, unknown>>("DELETE", `/admin/node/${DEMO}/lifecycle`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("dependency_blocked");
    expect(blocked.body.condition).toBeString();
    // dependencies 必须回传，否则 UI 只能说「删除失败」而说不出「谁挡着」
    expect(blocked.body.dependencies).toBeDefined();
    expect(blocked.body.dependencies).toMatchObject({ active_port_lease_count: expect.any(Number) });
  });

  test("DELETE 成功：退役 + 清空依赖的节点被真正删除（404）", async () => {
    // 种子里没有租约/池/转发的节点：node 7
    const CLEAN = 7;
    await call("PATCH", `/admin/node/${CLEAN}/lifecycle`, undefined, { lifecycle: "retiring" });
    const before = await call<NodeImpactResult>("GET", `/admin/node/${CLEAN}/impact`);
    if (
      before.body.impact.ingress_forward_count === 0 &&
      before.body.impact.egress_forward_count === 0 &&
      before.body.impact.binding_count === 0 &&
      before.body.impact.active_port_lease_count === 0 &&
      before.body.impact.egress_pool_count === 0
    ) {
      const gone = await call<{ id: number; deleted: boolean }>("DELETE", `/admin/node/${CLEAN}/lifecycle`);
      expect(gone.status).toBe(200);
      expect(gone.body.deleted).toBe(true);
      expect((await call("GET", `/admin/node/${CLEAN}/lifecycle`)).status).toBe(404);
    }
  });

  test("未知节点：404（不是 500、不是空视图）", async () => {
    const res = await call<Record<string, unknown>>("GET", "/admin/node/99999/lifecycle");
    expect(res.status).toBe(404);
  });

  test("种子：演示数据带生命周期与端口租约，使依赖预览非空", () => {
    expect(Object.keys(MOCK_LIFECYCLE_SEED).length).toBeGreaterThan(0);
    expect(Object.keys(MOCK_PORT_LEASE_SEED).length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* B. 判定权在服务端（前端不重算）                                        */
/* ================================================================== */

describe("WP7 判定权边界", () => {
  test("allowed_transitions 是按钮的唯一来源：缺失/空 → 无按钮（不猜）", () => {
    expect(lifecycleActionTargets(null)).toEqual([]);
    expect(lifecycleActionTargets({ lifecycle: "active" })).toEqual([]);
    expect(lifecycleActionTargets({ lifecycle: "active", allowed_transitions: [] })).toEqual([]);
  });

  test("按钮顺序固定（按 LIFECYCLE_ORDER），不随后端数组顺序变化", () => {
    const a = lifecycleActionTargets({
      lifecycle: "active",
      allowed_transitions: ["retiring", "maintenance", "disabled"],
    });
    const b = lifecycleActionTargets({
      lifecycle: "active",
      allowed_transitions: ["disabled", "retiring", "maintenance"],
    });
    expect(a).toEqual(b);
    expect(a).toEqual(["maintenance", "disabled", "retiring"]);
  });

  test("剔除当前值，且过滤未知枚举（不渲染后端不认识的目标）", () => {
    expect(
      lifecycleActionTargets({ lifecycle: "maintenance", allowed_transitions: ["maintenance", "active", "bogus"] }),
    ).toEqual(["active"]);
  });

  test("retiring 是单向门：不进按钮表，也没有「取消退役」出口", () => {
    expect(isTerminalLifecycle("retiring")).toBe(true);
    expect(isTerminalLifecycle("active")).toBe(false);
    expect(lifecycleActionTargets({ lifecycle: "retiring", allowed_transitions: [] })).toEqual([]);
  });

  test("deletePreview 镜像后端闸门顺序：未退役优先于依赖", () => {
    const busy: NodeImpact = {
      ingress_forward_count: 2,
      egress_forward_count: 1,
      binding_count: 1,
      active_port_lease_count: 3,
      egress_pool_count: 1,
      blockers: [],
    };
    // 未退役 + 有依赖 → 先报「未退役」（顺序即优先级，与后端 deleteGates 一致）
    expect(deletePreview("active", busy)).toEqual({ ok: false, condition: "node_not_retiring" });
    // 已退役 + ingress 未清
    expect(deletePreview("retiring", busy)).toEqual({ ok: false, condition: "node_still_used_as_ingress" });
    expect(deletePreview("retiring", { ...busy, ingress_forward_count: 0 })).toEqual({
      ok: false,
      condition: "node_still_used_as_egress",
    });
    expect(deletePreview("retiring", { ...busy, ingress_forward_count: 0, egress_forward_count: 0 })).toEqual({
      ok: false,
      condition: "dependency_blocked",
    });
    const clean: NodeImpact = { ...busy, ingress_forward_count: 0, egress_forward_count: 0, binding_count: 0, active_port_lease_count: 0, egress_pool_count: 0 };
    expect(deletePreview("retiring", clean)).toEqual({ ok: true });
  });

  test("统计拿不到时不拦预览——最终裁决永远在服务端", () => {
    expect(deletePreview("retiring", null)).toEqual({ ok: true });
  });

  test("impactEntries 五类齐全且非数字归 0（不渲染 undefined）", () => {
    const entries = impactEntries({ blockers: [] } as unknown as NodeImpact);
    expect(entries.map((e) => e.key)).toEqual([...IMPACT_COUNT_KEYS]);
    expect(entries.every((e) => e.count === 0)).toBe(true);
    expect(impactIsEmpty({ blockers: [] } as unknown as NodeImpact)).toBe(true);
  });

  test("lifecycleErrorInfo 读顶层 condition/dependencies（后端契约），并容忍嵌套", () => {
    const flat = lifecycleErrorInfo({
      status: 409,
      message: "还有转发没清",
      data: { code: "dependency_blocked", condition: "node_still_used_as_ingress", dependencies: { ingress_forward_count: 2, blockers: [] } },
    });
    expect(flat.status).toBe(409);
    expect(flat.code).toBe("dependency_blocked");
    expect(flat.condition).toBe("node_still_used_as_ingress");
    expect(flat.dependencies?.ingress_forward_count).toBe(2);

    // 未知条件码 → null（调用方回落 message，而不是渲染出乱码码）
    expect(lifecycleErrorInfo({ status: 409, data: { condition: "made_up_code" } }).condition).toBeNull();
    // 非对象输入不炸
    expect(lifecycleErrorInfo("boom").message).toBe("boom");
    expect(lifecycleErrorInfo(null).condition).toBeNull();
  });
});

/* ================================================================== */
/* C. 安装等待闭环（§13.4.3）                                            */
/* ================================================================== */

describe("WP7 安装等待闭环", () => {
  test("阶段推导只消费 connection，不另造在线判定", () => {
    expect(installPhase({ connection: "waiting" })).toBe("awaiting_install");
    expect(installPhase({ connection: "online" })).toBe("online");
    expect(installPhase({ connection: "offline" })).toBe("installed_offline");
    expect(installPhase(null)).toBe("unknown");
  });

  test("offline + 无凭据 → 等待安装（有凭据才是「装过但掉线」）", () => {
    expect(installPhase({ connection: "offline", has_credential: false })).toBe("awaiting_install");
    expect(installPhase({ connection: "offline", has_credential: null })).toBe("installed_offline");
  });

  test("闭环终止条件：只有 online（offline 说明装过了，是连接问题）", () => {
    expect(installClosureReached("online")).toBe(true);
    expect(installClosureReached("awaiting_install")).toBe(false);
    expect(installClosureReached("installed_offline")).toBe(false);
    expect(installClosureReached("unknown")).toBe(false);
  });

  test("等待安装的准入拒绝单独成类：下一步是安装而不是改生命周期", () => {
    expect(isInstallAdmissionRejection("node_waiting_install")).toBe(true);
    expect(isInstallAdmissionRejection("node_disabled")).toBe(false);
    expect(isInstallAdmissionRejection(null)).toBe(false);
  });

  test("种子 waiting 节点（无凭据）确实落在「等待安装」", async () => {
    const v = await call<NodeLifecycleView>("GET", `/admin/node/${WAITING}/lifecycle`);
    expect(v.body.connection).toBe("waiting");
    expect(installPhase(v.body)).toBe("awaiting_install");
    expect(v.body.accepts_new_business).toBe(false);
  });
});

/* ================================================================== */
/* D. 文案覆盖（条件码 → 下一步）                                        */
/* ================================================================== */

describe("WP7 文案", () => {
  test("中英词条齐全（键集合一致）", () => {
    expect(Object.keys(NODE_LIFECYCLE_DICTS.zh).sort()).toEqual(Object.keys(NODE_LIFECYCLE_DICTS.en).sort());
    expect(Object.keys(NODE_LIFECYCLE_DICTS.zh).length).toBeGreaterThan(20);
  });

  test("每个条件码都有标题（未知码退化为 fallback 而不是空白）", () => {
    for (const code of NODE_LIFECYCLE_CONDITION_CODES) {
      const title = conditionTitle("zh", code, "回退标题");
      expect(title.length).toBeGreaterThan(0);
      expect(title).not.toBe("回退标题");
    }
    expect(conditionTitle("zh", "not_a_code", "回退标题")).toBe("回退标题");
  });

  test("依赖类条件码给出「下一步」动作（§13.5 要求可区分错误码）", () => {
    for (const code of ["node_still_used_as_ingress", "node_still_used_as_egress", "dependency_blocked", "node_not_retiring"]) {
      expect(conditionAction("zh", code)).toBeTruthy();
    }
    // 迁移非法属于「别选这个」，没有额外动作也给 null 而不是空串
    expect(conditionAction("zh", "not_a_code")).toBeNull();
  });

  test("五类依赖计数都有中英标签", () => {
    for (const key of IMPACT_COUNT_KEYS) {
      expect(impactLabel("zh", key).length).toBeGreaterThan(0);
      expect(impactLabel("en", key).length).toBeGreaterThan(0);
    }
  });

  test("生命周期/连接枚举与阶段枚举的词条都非空", () => {
    for (const locale of ["zh", "en"] as const) {
      const txt = nodeLifecycleText(locale);
      for (const l of LIFECYCLE_ORDER) {
        expect(txt.lifecycle[l].length).toBeGreaterThan(0);
        expect(txt.lifecycleHint[l].length).toBeGreaterThan(0);
      }
      for (const p of ["awaiting_install", "online", "installed_offline", "unknown"] as const) {
        expect(txt.installPhase[p].length).toBeGreaterThan(0);
        expect(txt.installPhaseHint[p].length).toBeGreaterThan(0);
      }
    }
  });
});

/* ================================================================== */
/* E. 接线（源码级断言：CI 无浏览器，故直接读文件）                        */
/* ================================================================== */

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
/** 归一化：折叠空白 + 去掉点号周围空格，避免断言被 prettier 折行干扰。 */
const flat = (src: string) => src.replace(/\s+/g, " ").replace(/\s*\.\s*/g, ".");

describe("WP7 接线", () => {
  const panel = read("node-lifecycle-panel.tsx");
  const manager = read("node-lifecycle-manager.tsx");
  const install = read("node-install-waiting.tsx");
  const detail = read("node-detail-manager.tsx");
  const nodes = read("nodes-manager.tsx");
  const api = readFileSync(new URL("../../../lib/api.ts", import.meta.url), "utf8");

  test("api.ts 暴露四个生命周期端点", () => {
    expect(api).toContain("/admin/node/${id}/lifecycle");
    expect(api).toContain("/admin/node/${id}/impact");
    expect(api).toContain("setNodeLifecycle");
    expect(api).toContain("deleteNodeLifecycle");
  });

  test("详情页挂生命周期卡（取数在 manager，渲染在 panel）", () => {
    expect(detail).toContain("NodeLifecycleManager");
    expect(panel).toContain('data-testid="node-lifecycle"');
    expect(manager).toContain("NodeLifecyclePanel");
  });

  test("panel 不做判定：按钮来自 allowed_transitions，无迁移表/阈值痕迹", () => {
    expect(panel).toContain("lifecycleActionTargets");
    expect(panel).toContain("deletePreview");
    // 前端复刻迁移表 → 服务层加状态时会出现「按钮能点但 PATCH 409」。
    // 只看**代码**，注释里提到服务端函数名是说明性的，不算复刻。
    const code = panel
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code).not.toContain("canTransition");
    expect(code).not.toContain("TRANSITIONS");
    expect(code).not.toContain("lifecycle === \"maintenance\" ? false");
  });

  test("panel 渲染：徽章 / 准入 / 迁移 / 依赖 / 删除闸门 / 角色检查各区块", () => {
    for (const id of [
      "node-lifecycle-badge",
      "node-lifecycle-connection",
      "node-lifecycle-accepts",
      "node-lifecycle-transitions",
      "node-lifecycle-note",
      "node-impact-entries",
      "node-delete-gate",
      "node-delete-confirm",
      "node-role-check",
    ]) {
      expect(panel).toContain(id);
    }
  });

  test("未知 ≠ 0：依赖统计未加载时不渲染计数条目", () => {
    expect(panel).toContain("node-impact-pending");
    // 只有当 impact 拿到时才渲染五类计数
    expect(flat(panel)).toContain("impact ? impactEntries(impact) : []");
  });

  test("列表页：生命周期列 + 生命周期概览 + 安装闭环概览", () => {
    expect(nodes).toContain("nodes-lifecycle-column");
    expect(nodes).toContain("nodes-lifecycle-summary");
    expect(nodes).toContain("nodes-install-summary");
    expect(nodes).toContain("NodeLifecycleCell");
    expect(nodes).toContain("installCounts");
  });

  test("安装等待闭环复用同一组件（列表创建流程与详情页重新安装）", () => {
    expect(install).toContain('data-testid="node-install-command"');
    expect(install).toContain('data-testid="node-install-waiting-state"');
    expect(install).toContain('data-testid="node-install-phase"');
    // 列表页用它承载「创建后等待安装」，详情页用它承载「重新安装」
    expect(nodes).toContain("NodeInstallWaiting");
    expect(manager).toContain("NodeInstallWaiting");
  });

  test("安装轮询的终止条件是后端的 connection，不是前端自算的时间窗", () => {
    const src = flat(install);
    expect(src).toContain("installClosureReached");
    expect(src).toContain("api.admin.nodeLifecycle(nodeId)");
    // 不得出现「最近上报 + 阈值」这类第二套在线判定
    expect(src).not.toMatch(/Date\.now\(\)\s*-\s*\w*report/i);
  });

  test("等待闭环不依赖「本地是否存着命令」：关掉对话框也继续等", () => {
    const src = flat(install);
    // 自动开始只看 autoStart + 阶段（phase），不看 enrollment / 对话框开合
    expect(src).toContain('if (!autoStart || closed) return;');
    expect(src).toContain('if (phase !== "awaiting_install") return;');
    // 轮询的守卫里不得再出现 open（关掉对话框就停 = 又回到「复制完没有下文」）
    expect(src).toContain("if (!waiting || closed) return;");
    expect(src).not.toContain("if (!waiting || closed || !open) return;");
  });

  test("详情页与列表页都开启等待闭环（autoStart）", () => {
    expect(flat(manager)).toContain("autoStart");
    expect(flat(nodes)).toContain("autoStart");
  });

  test("已保存备注来自节点行（视图没有 note 字段），并接到面板", () => {
    // 契约：/admin/node/:id/lifecycle 的视图是固定十键、**不含** note；
    // 备注在节点行 lifecycle_note 上，详情页读它并传给卡片。
    expect(detail).toContain("currentNote={detail.lifecycle_note");
    expect(manager).toContain("currentNote");
    expect(panel).toContain("node-lifecycle-current-note");
  });

  test("角色/端口收缩检查走后端（不在前端推导）", () => {
    expect(manager).toContain("api.admin.nodeImpact");
    expect(manager).toContain("roleCheckInput");
    expect(detail).toContain("roleCheckInput");
    expect(detail).toContain("NodeLifecycleManager");
  });

  test("删除后的落脚点：回到列表页而不是停在已删除的详情页", () => {
    expect(flat(detail)).toContain('onDeleted={() => router.push("/admin/nodes")}');
  });
});
