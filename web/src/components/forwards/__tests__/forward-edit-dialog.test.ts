/**
 * V4-WP4 §13.3 编辑产品 UX — 纯逻辑 + 契约固化单测（不起浏览器）。
 *
 * 三类断言，全部可离线运行：
 *  A. 字段集：编辑器字段 == 创建表单字段（§13.3.1）。直接读源码断文本串，
 *     任何人把编辑器退回「只能改名」，这里立刻红。
 *  B. 单 PATCH 语义：draftToPatch 只产出被改动的字段；§13.3.3 禁止把
 *     一次编辑拆成多个 PATCH——断言 patch 的键集合即可。
 *  C. 运行态语义：forwardRunningState 把 (config/applied/apply_status)
 *     折叠成「同步 / 下发中 / 异常」四种产品状态（§13.4）。
 *  D. 保存闸门：保存前必须要么预览通过、要么有 409，并且 expected_revision
 *     必须来自 config_revision（desired 指针），不能来自 applied_revision。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  FORWARD_EDIT_FIELDS,
  draftFormErrors,
  draftToPatch,
  forwardRunningState,
} from "@/components/forwards/forward-edit-dialog";
import { getDictionary, makeT } from "@/lib/i18n";
import type { PortForward } from "@/lib/types";

const COMPONENT = readFileSync(
  new URL("../forward-edit-dialog.tsx", import.meta.url),
  "utf8",
);

/**
 * 归一化源码：折叠空白 + 去掉点号周围的空格，让调用点断言不受 prettier
 * 折行影响（`api.forwards\n  .preview(...)` → `api.forwards.preview(...)`）。
 */
const SRC = COMPONENT.replace(/\s+/g, " ").replace(/\s*\.\s*/g, ".");

/** mock 种子：/forwards/1 是 DIRECT active，revision 4 / applied 4。 */
const base: PortForward = {
  id: 1,
  name: "群晖 Web 面板",
  mode: "direct",
  ingress_node_id: 1,
  egress_node_id: null,
  listen_port: 20001,
  target_host: "nas.lan",
  target_port: 5000,
  desired_status: "active",
  apply_status: "active",
  online: true,
  config_revision: 4,
  applied_revision: 4,
  latest_revision: 4,
  desired_revision_id: 40,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
} as PortForward;

/** 构造一个与 base 一致的草稿（= 打开编辑器时的初始状态）。 */
function editDraft(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: base.name,
    mode: "direct" as const,
    ingressId: String(base.ingress_node_id),
    egressId: "",
    listenPort: String(base.listen_port),
    targetHost: String(base.target_host),
    targetPort: String(base.target_port),
    ...overrides,
  };
}

describe("V4 forward edit UX — 字段集等同于创建表单", () => {
  test("编辑字段覆盖创建字段全集（§13.3.1 创建后可全编辑）", () => {
    expect([...FORWARD_EDIT_FIELDS].sort()).toEqual(
      [
        "egress_node_id",
        "ingress_node_id",
        "listen_port",
        "mode",
        "name",
        "target_host",
        "target_port",
      ].sort(),
    );
  });

  test("源码里每个字段都有对应输入控件（防止字段集常量与实际表单脱节）", () => {
    // FORWARD_EDIT_FIELDS 用后端字段名；草稿状态用 camelCase，
    // 因此按字段→草稿键映射逐一核对控件存在。
    const draftKey: Record<string, string> = {
      name: "draft.name",
      mode: "draft.mode",
      ingress_node_id: "draft.ingressId",
      egress_node_id: "draft.egressId",
      listen_port: "draft.listenPort",
      target_host: "draft.targetHost",
      target_port: "draft.targetPort",
    };
    const patchKey: Record<string, string> = {
      name: "patch.name",
      mode: "patch.mode",
      ingress_node_id: "patch.ingress_node_id",
      egress_node_id: "patch.egress_node_id",
      listen_port: "patch.listen_port",
      target_host: "patch.target_host",
      target_port: "patch.target_port",
    };
    for (const field of FORWARD_EDIT_FIELDS) {
      expect(COMPONENT).toContain(draftKey[field]);
      expect(COMPONENT).toContain(patchKey[field]);
    }
    // mode / ingress / egress 走 Select 控件
    expect(COMPONENT).toContain("<SelectItem value=\"relay\">");
    expect(COMPONENT).toContain("<SelectItem key={String(node.id)}");
  });

  test("只调用一次 PATCH，且 preview 与 update 共用同一份 patch", () => {
    // 归一化后统计：全文只出现一次 api.forwards.update(
    const updateCalls = SRC.match(/api\.forwards\.update\(/g) ?? [];
    expect(updateCalls.length).toBe(1);
    // preview 与 update 共用同一份 patch 计算（一次改全部字段，不是分步落库）
    expect(SRC).toContain("api.forwards.preview(forward.id, patch)");
    expect(SRC).toContain("api.forwards.update(forward.id, {...patch,");
    expect(SRC).toContain("expected_revision: expectedRevision");
  });

  test("expected_revision 取 desired（config_revision），不是 applied", () => {
    expect(COMPONENT).toContain("forward.config_revision ?? forward.latest_revision");
    // 不能出现拿 applied 当闸门的写法
    expect(COMPONENT).not.toContain("expected_revision: forward.applied_revision");
  });
});

describe("V4 forward edit UX — 单 PATCH 增量语义", () => {
  test("未改动的字段不进 patch（后端沿用 current desired）", () => {
    const patch = draftToPatch(base, editDraft());
    expect(Object.keys(patch)).toEqual([]);
  });

  test("一次改多个字段只会产生一个对象，键集合 == 改动集合", () => {
    const patch = draftToPatch(
      base,
      editDraft({ name: "新名字", targetHost: "10.0.0.5", targetPort: "8443" }),
    );
    expect(Object.keys(patch).sort()).toEqual(["name", "target_host", "target_port"]);
    expect(patch.name).toBe("新名字");
    expect(patch.target_host).toBe("10.0.0.5");
    expect(patch.target_port).toBe(8443);
  });

  test("direct 模式显式清空出口：egress_node_id -> null（mode_topology_mismatch 的前置保证）", () => {
    const relayBase = { ...base, mode: "relay", egress_node_id: 4 } as PortForward;
    const patch = draftToPatch(relayBase, editDraft({ mode: "direct", egressId: "" }));
    expect(patch.egress_node_id).toBeNull();
    expect(patch.mode).toBe("direct");
  });

  test("relay 模式换出口：只改 egress，其余保持 desired", () => {
    const relayBase = { ...base, mode: "relay", egress_node_id: 4 } as PortForward;
    const patch = draftToPatch(
      relayBase,
      editDraft({ mode: "relay", egressId: "7" }),
    );
    expect(Object.keys(patch)).toEqual(["egress_node_id"]);
    expect(patch.egress_node_id).toBe(7);
  });

  test("listen_port 清空表示自动分配（null），不是 0 / 空串", () => {
    const patch = draftToPatch(base, editDraft({ listenPort: "" }));
    expect(patch.listen_port).toBeNull();
  });
});

describe("V4 forward edit UX — 形态预检（语义判定仍归 preview）", () => {
  const t = makeT(getDictionary("zh"));

  test("端口越界被表单拦下，不发请求", () => {
    const errors = draftFormErrors(editDraft({ targetPort: "70000" }), t);
    expect(errors.target_port).toBeTruthy();
  });

  test("端口区间内不产生错误", () => {
    const errors = draftFormErrors(
      editDraft({ targetPort: "8443", listenPort: "20002" }),
      t,
    );
    expect(Object.keys(errors)).toEqual([]);
  });

  test("relay 未选出口被拦下（binding 不是猜出来的）", () => {
    const errors = draftFormErrors(editDraft({ mode: "relay", egressId: "" }), t);
    expect(errors.egress_node_id).toBeTruthy();
  });

  test("direct 缺目标主机被拦下", () => {
    const errors = draftFormErrors(editDraft({ targetHost: "" }), t);
    expect(errors.target_host).toBeTruthy();
  });
});

describe("V4 forward edit UX — running-vs-desired 状态折叠", () => {
  test("已保存且已下发 = synced（不再是两个 revision 数字）", () => {
    const state = forwardRunningState({
      ...base,
      config_revision: 5,
      applied_revision: 5,
      apply_status: "active",
    } as PortForward);
    expect(state.state).toBe("synced");
    expect(state.applied).toBe(5);
    expect(state.desired).toBe(5);
  });

  test("desired 领先 applied = pending（滚动中）", () => {
    const state = forwardRunningState({
      ...base,
      config_revision: 6,
      applied_revision: 4,
      apply_status: "active",
    } as PortForward);
    expect(state.state).toBe("pending");
    expect(state.applied).toBe(4);
    expect(state.desired).toBe(6);
  });

  test("apply_status 未结束也算 pending（即使 revision 已相等）", () => {
    expect(
      forwardRunningState({ ...base, apply_status: "applying" } as PortForward).state,
    ).toBe("pending");
    expect(
      forwardRunningState({ ...base, apply_status: "pending" } as PortForward).state,
    ).toBe("pending");
  });

  test("异常状态优先于任何 revision 对比", () => {
    const errored = forwardRunningState({
      ...base,
      apply_status: "error",
      config_revision: 6,
      applied_revision: 6,
    } as PortForward);
    expect(errored.state).toBe("error");
    const suspended = forwardRunningState({
      ...base,
      apply_status: "suspended",
      config_revision: 6,
      applied_revision: 4,
    } as PortForward);
    expect(suspended.state).toBe("suspended");
  });

  test("缺 revision 的存量行不炸，退化成 synced", () => {
    const legacy = { ...base, config_revision: undefined, applied_revision: undefined, latest_revision: undefined } as PortForward;
    const state = forwardRunningState(legacy);
    expect(state.state).toBe("synced");
    expect(state.desired).toBeNull();
    expect(state.applied).toBeNull();
  });
});

describe("V4 forward edit UX — 影响面/复制 UX 契约", () => {
  test("impact 展示只消费 preview 返回值，前端不自行推导 rollout 规则", () => {
    // 影响面必须来自 POST /:id/preview（§13.3.3 单一实现）
    expect(SRC).toContain("api.forwards.preview(forward.id, patch)");
    // 前端不得自行计算这些 rollout 规则
    expect(SRC).not.toContain("changes_external_address:");
    expect(SRC).not.toContain("listener_replacement:");
    // 但要读取 preview 返回的对应字段
    expect(SRC).toContain("impact.changes_external_address");
    expect(SRC).toContain("impact.listener_replacement");
  });

  test("metadata-only 时提示不重新下发（§13.3.2 rename-only 不 bump）", () => {
    expect(COMPONENT).toContain("impact.metadata_only");
    expect(COMPONENT).toContain("forward.impactMetadataOnly");
  });

  test("保存成功提示里带新 revision（用户能对上「改到第几版」）", () => {
    expect(COMPONENT).toContain("forward.savedApplying");
    expect(COMPONENT).toContain("updated.config_revision ?? updated.latest_revision");
  });

  test("409 走到「刷新后重试」，不自动重发（防止用旧草稿覆盖）", () => {
    expect(COMPONENT).toContain("setConflict(apiError.data.latest_revision)");
    expect(COMPONENT).toContain("forward.reloadAndRetry");
    // 冲突面板里不能再出现保存按钮
    const conflictBlock = COMPONENT.slice(
      COMPONENT.indexOf("revisionConflictTitle"),
      COMPONENT.indexOf(") : ("),
    );
    expect(conflictBlock).not.toContain("void save()");
  });

  test("复制按钮只在拿到地址后出现（没有地址不渲染空按钮）", () => {
    expect(COMPONENT).toContain("navigator.clipboard.writeText");
    expect(COMPONENT).toContain("if (!value) return null;");
  });

  test("打开编辑器后草稿重置为当前行（不允许拿旧草稿覆盖别人已保存的配置）", () => {
    // open 或 forward 变化时用 draftFrom 重建草稿 + 清掉 409 冲突态
    expect(SRC).toContain("if (open) { setDraft(draftFrom(forward)); setConflict(null); }");
  });

  test("preview 结果带节流去抖，并且旧响应不会覆盖新响应", () => {
    expect(COMPONENT).toContain("const seq = useRef(0)");
    expect(COMPONENT).toContain("++seq.current");
    expect(COMPONENT).toMatch(/if \(cancelled \|\| current !== seq\.current\) return;/);
  });

  test("列表页也能进入编辑器（§13.3.1 不要求先进详情）", () => {
    const workspace = readFileSync(
      new URL("../forward-workspace.tsx", import.meta.url),
      "utf8",
    );
    expect(workspace).toContain("ForwardEditDialog");
    expect(workspace).toContain("setEditTarget(forward)");
    // 保存后按 id 回填列表行，避免整页刷新打断筛选
    expect(workspace).toMatch(/rows\.map\(\(row\) => \(Number\(row\.id\) === Number\(updated\.id\) \? updated : row\)\)/);
  });
});
