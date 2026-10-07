/**
 * R2 —— 最小「自建入口节点组」表单的**行为**测试（纯校验 + 静态渲染，无浏览器）。
 *
 * 盯的是批准方案里写死的几条：
 *
 *   A. **必填且合法**：名称非空且在 60 字符内；端口范围格式 `start-end`、两端 1..65535、
 *      `start <= end`。按钮禁用必须**就地说明原因**，而不是让用户反复点；
 *   B. **错误分支精确**：403 `custom_group_not_allowed`（能力未开通）显示后端原文后
 *      **不再提供提交按钮**；403 `node_limit` 给真实额度原因；409/400 给对应原因 +
 *      下一步。原因用后端原文，前端只补「下一步」那句话；
 *   C. **token 绝不渲染**：组凭据从 API 投影处就被丢掉，界面上不存在这条渲染路径；
 *   D. 文案键在 zh/en 两本字典都存在且非空。
 *
 * 跑法（web 目录）：bun test src/components/nodes/__tests__/node-group-create.test.tsx
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import { Dialog } from "@/components/ui/dialog";
import {
  canSubmitNodeGroupForm,
  NODE_GROUP_NAME_ERROR_KEYS,
  NodeGroupCreateDialogBody,
  PORT_RANGE_ERROR_KEYS,
  parsePortRange,
  validateNodeGroupName,
  validatePortRange,
  type NodeGroupCreateDialogBodyProps,
} from "@/components/nodes/node-group-create-dialog";
import { ApiError } from "@/lib/api/core";
import type { WorkspaceCapabilities } from "@/lib/api/capabilities";
import { nodeGroupApiErrorInfo, projectCreatedNodeGroup } from "@/lib/api/nodeGroups";
import { en, zh } from "@/lib/i18n/dictionaries";
import type { Dict } from "@/lib/i18n/dictionaries";

/* ================================================================== */
/* helpers                                                             */
/* ================================================================== */

function renderBody(over: Partial<NodeGroupCreateDialogBodyProps> = {}): string {
  const props: NodeGroupCreateDialogBodyProps = {
    name: "",
    onNameChange: () => undefined,
    portRange: "",
    onPortRangeChange: () => undefined,
    nameErrorKey: null,
    portRangeErrorKey: null,
    pending: false,
    failure: null,
    denied: false,
    capabilities: null,
    onCancel: () => undefined,
    onSubmit: () => undefined,
    ...over,
  };
  // `DialogTitle` 需要 Radix Root 的上下文：外面只包 `<Dialog open>`（Root 不走 Portal，
  // 静态渲染能拿到正文），与本仓 `ui/__tests__/dialog.test.tsx`、I1 的对话框测试同一手法。
  return renderToStaticMarkup(
    <I18nProvider locale="zh" dict={zh}>
      <Dialog open>
        <NodeGroupCreateDialogBody {...props} />
      </Dialog>
    </I18nProvider>,
  );
}

const caps = (over: Partial<WorkspaceCapabilities> = {}): WorkspaceCapabilities => ({
  allow_custom_in_group: true,
  allow_custom_out_group: false,
  max_nodes: 1,
  nodes_used: 1,
  max_tunnels: 2,
  tunnels_used: 0,
  policy_missing: false,
  deny_message: null,
  ...over,
});

function lookup(dict: Dict, key: string): unknown {
  return key.split(".").reduce<unknown>(
    (cur, part) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[part] : undefined),
    dict,
  );
}

/* ================================================================== */
/* A. 纯校验                                                           */
/* ================================================================== */

describe("A. 名称与端口范围的校验（与后端 schema/边界同口径）", () => {
  const nameCases: [string, string, ReturnType<typeof validateNodeGroupName>][] = [
    ["空字符串 → 必填", "", "required"],
    ["只有空白 → 必填", "   ", "required"],
    ["正常名称通过", "香港-入口", null],
    ["首尾空白被 trim 后仍合法", "  hk-in  ", null],
    ["60 字符通过", "a".repeat(60), null],
    ["61 字符超长", "a".repeat(61), "too_long"],
  ];
  for (const [name, input, expected] of nameCases) {
    test(`名称：${name}`, () => {
      expect(validateNodeGroupName(input)).toBe(expected);
    });
  }

  const portCases: [string, string, ReturnType<typeof validatePortRange>][] = [
    ["空 → 必填（本切片必填：没有区间之后无法 provision）", "", "required"],
    ["只有空白 → 必填", "   ", "required"],
    ["缺一端 → 格式错", "20000-", "format"],
    ["不是区间 → 格式错", "20000", "format"],
    ["多余的段 → 格式错", "20000-20100-1", "format"],
    ["非数字 → 格式错", "a-b", "format"],
    ["中文连字符 → 格式错", "20000—20100", "format"],
    ["起点 0 → 越界", "0-100", "bounds"],
    ["终点 65536 → 越界", "100-65536", "bounds"],
    ["起止颠倒 → 顺序错", "20100-20000", "order"],
    ["单端口区间合法", "20000-20000", null],
    ["合法区间", "20000-20100", null],
    ["边界值合法", "1-65535", null],
  ];
  for (const [name, input, expected] of portCases) {
    test(`端口：${name}`, () => {
      expect(validatePortRange(input)).toBe(expected);
    });
  }

  test("parsePortRange：只在完全匹配时给出数字，不猜", () => {
    expect(parsePortRange("20000-20100")).toEqual({ start: 20000, end: 20100 });
    expect(parsePortRange(" 1-2 ")).toEqual({ start: 1, end: 2 });
    expect(parsePortRange("20000")).toBeNull();
    expect(parsePortRange("20000-")).toBeNull();
    expect(parsePortRange("1.5-2")).toBeNull();
  });

  test("canSubmitNodeGroupForm：只有名称与范围都合法且不在提交中才允许提交", () => {
    expect(canSubmitNodeGroupForm({ name: "hk", portRange: "20000-20100", pending: false })).toBe(true);
    expect(canSubmitNodeGroupForm({ name: "", portRange: "20000-20100", pending: false })).toBe(false);
    expect(canSubmitNodeGroupForm({ name: "hk", portRange: "", pending: false })).toBe(false);
    expect(canSubmitNodeGroupForm({ name: "hk", portRange: "20100-20000", pending: false })).toBe(false);
    expect(canSubmitNodeGroupForm({ name: "hk", portRange: "20000-20100", pending: true })).toBe(false);
  });

  test("每个校验错误都有自己的词典键，且两本字典都有非空文案", () => {
    for (const key of [
      ...Object.values(NODE_GROUP_NAME_ERROR_KEYS),
      ...Object.values(PORT_RANGE_ERROR_KEYS),
    ]) {
      for (const dict of [zh, en]) {
        const text = lookup(dict, key);
        expect(typeof text).toBe("string");
        expect(String(text).trim().length).toBeGreaterThan(0);
        expect(text).not.toBe(key);
      }
    }
  });
});

/* ================================================================== */
/* B. 表单渲染与错误分支                                                */
/* ================================================================== */

describe("B. 表单：方向固定入口、必填字段、就地校验", () => {
  test("默认状态：字段与提交按钮都在，方向写清「入口」，没有额度行（不知道就不说）", () => {
    const html = renderBody();
    expect(html).toContain('data-testid="node-group-create-name"');
    expect(html).toContain('data-testid="node-group-create-port-range"');
    expect(html).toContain('data-testid="node-group-create-submit"');
    expect(html).toContain('data-testid="node-group-create-direction"');
    expect(html).toContain(zh.node.groupCreateTitle);
    expect(zh.node.groupCreateTitle).toBe("创建节点池");
    expect(html).toContain(zh.node.groupCreateDirectionIngress);
    expect(zh.node.groupCreateDirectionIngress).toContain("用途：入口");
    expect(zh.node.groupCreateDirectionIngress).not.toContain("allow_custom_out_group");
    expect(html).not.toContain('data-testid="node-group-create-quota"');
    // 没有可访问名称为空的输入：两个字段都有 label（htmlFor/id 关联）。
    expect(html).toContain('id="node-group-create-name"');
    expect(html).toContain('id="node-group-create-port-range"');
  });

  test("提交过一次后的校验错误就地显示（名称必填 / 端口必填）", () => {
    const html = renderBody({
      nameErrorKey: NODE_GROUP_NAME_ERROR_KEYS.required,
      portRangeErrorKey: PORT_RANGE_ERROR_KEYS.required,
    });
    expect(html).toContain('data-testid="node-group-create-name-error"');
    expect(html).toContain(zh.node.groupCreateNameRequired);
    expect(html).toContain('data-testid="node-group-create-port-error"');
    expect(html).toContain(zh.node.groupCreatePortRequired);
    // 字段被标记为无效（屏幕阅读器能读到）。
    expect(html).toContain('aria-invalid="true"');
  });

  test("额度行来自 capabilities 安全投影（已用/上限），null 时不显示", () => {
    const html = renderBody({ capabilities: caps({ nodes_used: 1, max_nodes: 1, tunnels_used: 0, max_tunnels: 2 }) });
    expect(html).toContain('data-testid="node-group-create-quota"');
    expect(html).toContain("1 / 1");
    expect(html).toContain("0 / 2");
    expect(renderBody({ capabilities: null })).not.toContain('data-testid="node-group-create-quota"');
  });

  test("提交中：按钮禁用并显示进行中文案", () => {
    const html = renderBody({ name: "hk", portRange: "20000-20100", pending: true });
    expect(html).toContain(zh.node.groupCreating);
    expect(html).toContain("disabled");
  });
});

describe("B2. 三个错误码分支：原因来自后端，下一步来自词典", () => {
  const cases: [string, number, string, string, string, boolean][] = [
    // [名称, status, code, 后端原文, 期望出现的下一步文案, 是否仍然提供提交按钮]
    [
      "能力未开通（403 custom_group_not_allowed）",
      403,
      "custom_group_not_allowed",
      "当前策略不允许自建入口节点组",
      zh.node.groupErrorNextPolicy,
      false,
    ],
    [
      "节点额度耗尽（403 node_limit）",
      403,
      "node_limit",
      "已达节点数量上限（1 个）",
      zh.node.groupErrorNextNodeLimit,
      true,
    ],
    [
      "端口范围冲突（409 PORT_RANGE_REQUIRED）",
      409,
      "PORT_RANGE_REQUIRED",
      "节点组未配置端口范围，无法添加节点",
      zh.node.groupErrorNextPortRange,
      true,
    ],
  ];

  for (const [name, status, code, backendMessage, nextText, keepsSubmit] of cases) {
    test(name, () => {
      const info = nodeGroupApiErrorInfo(new ApiError(status, backendMessage, { error: backendMessage, code }));
      const html = renderBody({
        name: "hk",
        portRange: "20000-20100",
        failure: { message: info.message, nextStepKey: info.nextStepKey, code: info.code },
        denied: info.code === "custom_group_not_allowed",
      });
      expect(html).toContain('role="alert"');
      expect(html).toContain(`data-code="${code}"`);
      // 原因：后端原文（前端不重写）。
      expect(html).toContain(backendMessage);
      // 下一步：词典文案。
      expect(html).toContain(nextText);
      if (keepsSubmit) {
        expect(html).toContain('data-testid="node-group-create-submit"');
      } else {
        // 能力未开通：再点一次必然同样失败，按钮不再提供（只留取消）。
        expect(html).not.toContain('data-testid="node-group-create-submit"');
        expect(html).toContain('data-testid="node-group-create-cancel"');
      }
    });
  }

  test("400 表单类错误（无 code）：只显示后端原因，不编下一步", () => {
    const info = nodeGroupApiErrorInfo(new ApiError(400, "端口范围不合法", { error: "端口范围不合法" }));
    expect(info.nextStepKey).toBeNull();
    const html = renderBody({
      failure: { message: info.message, nextStepKey: info.nextStepKey, code: info.code },
    });
    expect(html).toContain("端口范围不合法");
    expect(html).not.toContain('data-testid="node-group-create-error-next"');
    // 仍然可以改了再提交。
    expect(html).toContain('data-testid="node-group-create-submit"');
  });

  test("网络级失败（没有后端原文）：显示通用失败文案，仍然可以重试", () => {
    const html = renderBody({ failure: { message: null, nextStepKey: null, code: null } });
    expect(html).toContain(zh.node.groupCreateFailed);
    expect(html).toContain('data-testid="node-group-create-submit"');
  });
});

/* ================================================================== */
/* C. 组凭据 token 绝不渲染                                             */
/* ================================================================== */

describe("C. 组凭据（token）不进 UI", () => {
  test("表单在任何状态下都不含 token 字样或 token 形态的字符串", () => {
    const states: Partial<NodeGroupCreateDialogBodyProps>[] = [
      {},
      { name: "hk", portRange: "20000-20100" },
      { pending: true, name: "hk", portRange: "20000-20100" },
      { nameErrorKey: NODE_GROUP_NAME_ERROR_KEYS.required, portRangeErrorKey: PORT_RANGE_ERROR_KEYS.format },
      {
        failure: { message: "当前策略不允许自建入口节点组", nextStepKey: zh.node.groupErrorNextPolicy, code: "custom_group_not_allowed" },
        denied: true,
      },
      { failure: { message: "节点组未配置端口范围，无法添加节点", nextStepKey: zh.node.groupErrorNextPortRange, code: "PORT_RANGE_REQUIRED" } },
    ];
    for (const state of states) {
      const html = renderBody(state);
      expect(html).not.toContain("token");
      expect(html).not.toMatch(/ng_[A-Za-z0-9]/);
      expect(html).not.toContain("ng_in_hk_01");
    }
  });

  test("API 投影是唯一入口：投影后的组对象里根本没有凭据字段", () => {
    const projected = projectCreatedNodeGroup({
      id: 9,
      name: "香港-入口",
      node_type: "in",
      token: "ng_9_leak_me_not",
      workspace_id: 1,
    });
    expect(Object.keys(projected).sort()).toEqual(["id", "name", "node_type"]);
    expect(JSON.stringify(projected)).not.toContain("leak_me_not");
  });
});
