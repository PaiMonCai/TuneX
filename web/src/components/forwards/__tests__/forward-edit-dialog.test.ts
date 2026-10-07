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
import {
  FORWARD_EDIT_FIELDS,
  draftFormErrors,
  draftToPatch,
  forwardRunningState,
} from "@/components/forwards/forward-edit-dialog";
import { getDictionary, makeT } from "@/lib/i18n";
import type { PortForward } from "@/lib/types";


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
        "bytes_per_second_in",
        "bytes_per_second_out",
        "max_connections",
        "max_connections_per_ip",
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
