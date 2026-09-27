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
  forwardProductBadgeVariant,
  forwardProductStatus,
  type ForwardProductState,
} from "../../../lib/forward-status";
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

describe("C. 静态守卫：产品状态只有一处实现", () => {
  const workspace = readWeb("components/forwards/forward-workspace.tsx");
  const detail = readWeb("components/forwards/forward-detail.tsx");

  test("列表页与详情页都复用 forwardProductStatus（不自己算 revision 关系）", () => {
    expect(workspace).toContain("forwardProductStatus");
    expect(detail).toContain("forwardProductStatus");
    for (const [name, src] of [["workspace", workspace], ["detail", detail]] as const) {
      expect(`${name}:${/applied_revision\s*<\s*/.test(src)}`).toBe(`${name}:false`);
    }
  });

  test("列表页不再把 apply_status 原始枚举渲染成用户可见文本", () => {
    // Badge 里直接插值 apply_status 是 WP8 修掉的那个形态。
    expect(workspace).not.toMatch(/\{forward\.apply_status\s*\?\?\s*"pending"\}/);
  });

  test("列表页与详情页都消费「错误 → 下一步动作」", () => {
    expect(workspace).toContain("applyErrorAction");
    expect(detail).toContain("applyErrorAction");
  });

  test("详情页的 raw revision / desired internals 默认折叠（<details>）", () => {
    expect(detail).toContain("<details");
    expect(detail).toMatch(/<details(?![^>]*\bopen\b)/);
  });
});
