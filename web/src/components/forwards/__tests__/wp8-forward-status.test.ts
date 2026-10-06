/**
 * V4-WP8 §13.7 Wave 4 —— Forward 产品状态与「错误 → 下一步」契约测试。
 *
 * 三件事：
 *   A. `forwardProductStatus()` 的组合表（apply_status × revision 关系）；
 *   B. `applyErrorAction()` 的**键集与后端一致**（直接读
 *      `backend/src/services/scheduler.ts` 源码做集合断言），且 `retryable`
 *      分流与后端 `RETRYABLE` 一致；
 *   C. 静态守卫：产品状态只有一处实现（`lib/forward-status.ts`），列表页 /
 *      详情页 / Dashboard **不得**再自己判 `applied < desired`，也**不得**把
 *      `apply_status` 原始枚举直接渲染成用户可见文本。
 *
 * 目录说明：本文件位于 CI 已执行的 `components/forwards/__tests__/`（见
 * `.github/workflows/ci.yml` 的 `bun test` 列表）。放到未被 CI 执行的目录里的
 * 测试一次都不会跑 —— 那是 WP8 报告 F6 记录的问题。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  APPLY_ERROR_CODES,
  RETRYABLE_APPLY_ERROR_CODES,
  applyErrorAction,
  applyErrorIsRetryable,
  forwardErrorActions,
  forwardErrorInfo,
  forwardProductBadgeVariant,
  forwardProductStatus,
  type ForwardProductState,
} from "../../../lib/forward-status";
import { conditionAction } from "../../../lib/node-lifecycle-i18n";
import type { PortForward } from "../../../lib/types";

const readBackend = (rel: string) =>
  readFileSync(new URL(`../../../../../backend/src/${rel}`, import.meta.url), "utf8");
const readWeb = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");

/** 构造最小 forward（只带产品状态需要的字段）。 */
function fwd(over: Partial<PortForward>): PortForward {
  return {
    apply_status: "active",
    config_revision: 1,
    applied_revision: 1,
    latest_revision: 1,
    apply_error_code: null,
    apply_error: null,
    ...over,
  } as PortForward;
}

describe("A. forwardProductStatus 组合表", () => {
  const cases: [string, Partial<PortForward>, ForwardProductState][] = [
    ["已下发且版本一致 → synced", { apply_status: "active", config_revision: 3, applied_revision: 3 }, "synced"],
    ["已保存但落后 → pending", { apply_status: "active", config_revision: 5, applied_revision: 3 }, "pending"],
    ["pending → pending", { apply_status: "pending", config_revision: 3, applied_revision: 3 }, "pending"],
    ["applying → pending", { apply_status: "applying", config_revision: 3, applied_revision: 3 }, "pending"],
    ["error → error（即使版本一致）", { apply_status: "error", config_revision: 3, applied_revision: 3 }, "error"],
    ["error → error（即使落后）", { apply_status: "error", config_revision: 5, applied_revision: 3 }, "error"],
    ["suspended → suspended", { apply_status: "suspended", config_revision: 3, applied_revision: 3 }, "suspended"],
    ["legacy（无编排字段）→ synced", { apply_status: null, config_revision: null, applied_revision: null, latest_revision: 0 }, "synced"],
  ];

  for (const [name, over, expected] of cases) {
    test(name, () => {
      expect(forwardProductStatus(fwd(over)).state).toBe(expected);
    });
  }

  test("error 优先于 pending：上一版仍在跑，不能报「正在同步」", () => {
    const s = forwardProductStatus(fwd({ apply_status: "error", config_revision: 9, applied_revision: 4 }));
    expect(s.state).toBe("error");
    // 进度数字仍如实给出（详情页折叠区会用），但状态不因此变成 pending。
    expect(s.applied).toBe(4);
    expect(s.desired).toBe(9);
  });

  test("缺 config_revision 时回落 latest_revision", () => {
    const s = forwardProductStatus(fwd({ config_revision: null, latest_revision: 7, applied_revision: 5 }));
    expect(s.desired).toBe(7);
    expect(s.state).toBe("pending");
  });

  test("applied > desired 不猜成回滚（前端不做状态机推导）", () => {
    // 后端写入的语义，前端不解释；只按已知规则归类 → 落到 synced。
    expect(forwardProductStatus(fwd({ apply_status: "active", config_revision: 3, applied_revision: 4 })).state).toBe("synced");
  });

  test("四种状态各有 badge 变体，error 与 pending 可区分", () => {
    const variants = (["synced", "pending", "error", "suspended"] as ForwardProductState[]).map(forwardProductBadgeVariant);
    expect(variants).toEqual(["success", "outline", "destructive", "secondary"]);
  });

  test("null 输入不抛错（详情页 SSR 早期可能拿到空对象）", () => {
    expect(forwardProductStatus(null).state).toBe("synced");
    expect(forwardProductStatus(undefined).desired).toBeNull();
  });
});

describe("B. 错误码表与后端 SCHEDULER_ERROR_CODES 一致", () => {
  const scheduler = readBackend("services/scheduler.ts");

  function backendCodes(): string[] {
    const start = scheduler.indexOf("export const SCHEDULER_ERROR_CODES");
    const body = scheduler.slice(start, scheduler.indexOf("} as const;", start));
    return [...body.matchAll(/^\s{2}(\w+):\s*"/gm)].map((m) => m[1]);
  }

  function backendRetryable(): string[] {
    const start = scheduler.indexOf("const RETRYABLE");
    const body = scheduler.slice(start, scheduler.indexOf("]);", start));
    return [...body.matchAll(/SCHEDULER_ERROR_CODES\.(\w+)/g)].map((m) => m[1]);
  }

  test("守卫自身有效：确实解析出了后端码（不是空集）", () => {
    expect(backendCodes().length).toBeGreaterThan(10);
    expect(backendRetryable().length).toBeGreaterThan(3);
  });

  test("前端词条键集 == 后端 SCHEDULER_ERROR_CODES（漏一个就红）", () => {
    expect([...APPLY_ERROR_CODES].sort()).toEqual([...backendCodes()].sort());
  });

  test("retryable 子集 == 后端 RETRYABLE（分流不能漂移）", () => {
    expect([...RETRYABLE_APPLY_ERROR_CODES].sort()).toEqual([...backendRetryable()].sort());
  });

  test("node_credential_missing 不可重试（补签凭据不是用户能做的事）", () => {
    expect(applyErrorIsRetryable("node_credential_missing")).toBe(false);
    expect(applyErrorAction("zh", "node_credential_missing")).toContain("管理员");
  });

  test("未知码 → null 动作 + 不可重试（不编造建议、不给注定失败的按钮）", () => {
    expect(applyErrorAction("zh", "brand_new_code")).toBeNull();
    expect(applyErrorAction("zh", null)).toBeNull();
    expect(applyErrorIsRetryable("brand_new_code")).toBe(false);
  });

  test("中英双语都有词条，且英文里不含中文", () => {
    for (const code of APPLY_ERROR_CODES) {
      const zh = applyErrorAction("zh", code);
      const en = applyErrorAction("en", code);
      expect(zh).toBeTruthy();
      expect(en).toBeTruthy();
      expect(/[\u4e00-\u9fff]/.test(en as string)).toBe(false);
    }
  });

  test("动作文案不是复述错误码（必须是可执行的一句话）", () => {
    for (const code of APPLY_ERROR_CODES) {
      const zh = applyErrorAction("zh", code) as string;
      expect(zh.length).toBeGreaterThan(8);
      expect(zh).not.toBe(code);
    }
  });
});

// 展示层是否复用产品状态 helper 属于实现结构，不在这里锁死。
// 本文件只保护状态组合、错误码映射和写失败解析这些稳定产品契约。

describe("D. 写失败解析：消费 409 condition（WP8 F5）", () => {
  test("后端 forwards 族的错误体形状：code / data.condition / apply_error_code 全部取到", () => {
    const info = forwardErrorInfo({
      status: 409,
      message: "该节点维护中，不接受新业务",
      data: { error: "该节点维护中，不接受新业务", code: "conflict", condition: "node_in_maintenance" },
    });
    expect(info.status).toBe(409);
    expect(info.code).toBe("conflict");
    expect(info.condition).toBe("node_in_maintenance");
    expect(info.message).toBe("该节点维护中，不接受新业务");
  });

  test("容忍 mock 通用 fail() 的一层嵌套（data.data），契约仍以后端顶层为准", () => {
    const info = forwardErrorInfo({
      status: 409,
      message: "conflict",
      data: { data: { code: "conflict", condition: "node_waiting_install" } },
    });
    expect(info.condition).toBe("node_waiting_install");

    // 顶层与嵌套同时存在时，顶层优先（真实后端形状不能被 mock 形状覆盖）。
    const both = forwardErrorInfo({
      status: 409,
      message: "m",
      data: { condition: "node_disabled", data: { condition: "node_retiring" } },
    });
    expect(both.condition).toBe("node_disabled");
  });

  test("准入拒绝优先于编排错误（请求没进编排时给编排建议是误导）", () => {
    const info = forwardErrorInfo({
      status: 409,
      message: "m",
      data: { condition: "node_in_maintenance", apply_error_code: "port_allocation_failed" },
    });
    const actions = forwardErrorActions("zh", info);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toBe(conditionAction("zh", "node_in_maintenance"));
    expect(actions[1]).toBe(applyErrorAction("zh", "port_allocation_failed"));
  });

  test("两类后端错误体形状都能解析（forwards 顶层 / node-lifecycle 顶层 message）", () => {
    // node-lifecycle 族：condition 在顶层，且**没有** data。
    const lifecycleShaped = forwardErrorInfo({
      status: 409,
      message: "该节点尚未完成安装",
      data: { code: "conflict", condition: "node_waiting_install" },
    });
    expect(forwardErrorActions("zh", lifecycleShaped)[0]).toBe(conditionAction("zh", "node_waiting_install"));

    // 完全没有可识别字段 → 不动，只剩原文（不编造动作）。
    const opaque = forwardErrorInfo({ status: 500, message: "boom", data: {} });
    expect(forwardErrorActions("zh", opaque)).toEqual([]);
    expect(opaque.message).toBe("boom");
  });

  test("非 Error 输入不抛错（字符串 / null / undefined）", () => {
    expect(forwardErrorInfo("boom").message).toBe("boom");
    expect(forwardErrorInfo(null).status).toBeNull();
    expect(forwardErrorInfo(undefined).code).toBeNull();
    expect(forwardErrorActions("zh", forwardErrorInfo(null))).toEqual([]);
  });

  test("condition 的下一步复用 WP7 的 conditionAction，不在本文件另写一份", () => {
    for (const code of ["node_in_maintenance", "node_disabled", "node_retiring", "node_waiting_install"]) {
      const actions = forwardErrorActions("zh", forwardErrorInfo({ status: 409, message: "m", data: { condition: code } }));
      expect(`${code}:${actions[0]}`).toBe(`${code}:${conditionAction("zh", code)}`);
    }
  });
});
