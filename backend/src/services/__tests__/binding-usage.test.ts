/**
 * V4-WP9 §13.6「Binding usage」——使用量投影与阻塞判定的纯函数测试。
 *
 * 钉住的核心不变量：**列表里显示的 `unbind_blocked` 必须与解绑时 409 的判定
 * 是同一条规则**。否则用户在列表看到「可用」却在解绑时被拒（或反之），
 * 这类不一致在前端表现为「按钮状态随机」。
 */
import { describe, expect, test } from "bun:test";
import {
  bindingUsage,
  bindingUsageKey,
  bindingUsageMap,
  lookupBindingUsage,
  unbindBlockedMessage,
  unbindHint,
} from "../binding-usage.ts";

describe("V4-WP9 bindingUsage", () => {
  test("0 条 → 不阻塞", () => {
    expect(bindingUsage(0)).toEqual({ used_by_forward_count: 0, unbind_blocked: false });
  });

  test("> 0 条 → 阻塞，且数量原样透出（用户要知道影响面有多大）", () => {
    expect(bindingUsage(1)).toEqual({ used_by_forward_count: 1, unbind_blocked: true });
    expect(bindingUsage(37)).toEqual({ used_by_forward_count: 37, unbind_blocked: true });
  });

  test("坏数据（负数 / NaN / 小数）不产生自相矛盾的响应", () => {
    expect(bindingUsage(-3)).toEqual({ used_by_forward_count: 0, unbind_blocked: false });
    expect(bindingUsage(Number.NaN)).toEqual({ used_by_forward_count: 0, unbind_blocked: false });
    expect(bindingUsage(2.7)).toEqual({ used_by_forward_count: 2, unbind_blocked: true });
  });
});

describe("V4-WP9 解绑文案单点", () => {
  test("409 文案含数量与下一步（只说「无法解绑」等于没说）", () => {
    const msg = unbindBlockedMessage(4);
    expect(msg).toContain("4");
    expect(msg).toContain("删除");
    expect(msg).toContain("出口");
  });

  test("负数不会渲染成 '-3 条'", () => {
    expect(unbindBlockedMessage(-3)).toContain("0");
    expect(unbindBlockedMessage(-3)).not.toContain("-3");
  });

  test("确认框语气区分「阻塞」与「仅提示」", () => {
    const blocked = unbindHint(bindingUsage(2));
    const free = unbindHint(bindingUsage(0));
    expect(blocked).toBe(unbindBlockedMessage(2));
    expect(free).not.toBe(blocked);
    expect(free).toContain("没有");
  });
});

describe("V4-WP9 bindingUsageMap", () => {
  test("pair 键由单点函数拼装（路由与 mock 不会各自拼出不同分隔符）", () => {
    expect(bindingUsageKey(3, 9)).toBe("3:9");
  });

  test("成对统计落表，未出现的 pair 视为 0（新绑定）", () => {
    const map = bindingUsageMap([
      { ingress_node_id: 1, egress_node_id: 2, count: 5 },
      { ingress_node_id: 1, egress_node_id: 3, count: 0 },
    ]);
    expect(lookupBindingUsage(map, 1, 2)).toEqual({
      used_by_forward_count: 5,
      unbind_blocked: true,
    });
    expect(lookupBindingUsage(map, 1, 3).unbind_blocked).toBe(false);
    expect(lookupBindingUsage(map, 1, 99)).toEqual({
      used_by_forward_count: 0,
      unbind_blocked: false,
    });
  });

  test("egress_node_id / ingress_node_id 为 null 的组被跳过（不是可用绑定）", () => {
    const map = bindingUsageMap([
      { ingress_node_id: null, egress_node_id: 2, count: 9 },
      { ingress_node_id: 1, egress_node_id: null, count: 9 },
    ]);
    expect(map.size).toBe(0);
  });

  test("by 只取 ingress/egress 两列：不会把 direct 转发算进使用量", () => {
    // 类型与调用点由路由保证（where.tunnel_mode = "relay"），这里断言空输入安全。
    expect(bindingUsageMap([]).size).toBe(0);
  });
});
