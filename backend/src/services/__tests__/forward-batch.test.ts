/**
 * V4-WP9 §13.6「必要批量操作」——请求校验与汇总的纯函数测试。
 *
 * 这里钉住的是**拒绝语义**：批量接口最容易出的问题是「静默只处理一部分」，
 * 因此上限、去重、非法元素都必须产生显式错误，而不是尽力而为。
 */
import { describe, expect, test } from "bun:test";
import {
  FORWARD_BATCH_ACTIONS,
  FORWARD_BATCH_MAX_IDS,
  forwardBatchFailureCodes,
  forwardBatchSummary,
  isForwardBatchAction,
  parseForwardBatchRequest,
  toForwardBatchAction,
} from "../forward-batch.ts";

describe("V4-WP9 批量动作白名单", () => {
  test("includes deletion but keeps single POST actions reversible", () => {
    expect([...FORWARD_BATCH_ACTIONS]).toEqual(["retry", "suspend", "resume", "delete"]);
    expect(toForwardBatchAction("retry")).toBe("retry");
    expect(toForwardBatchAction("suspend")).toBe("suspend");
    expect(toForwardBatchAction("resume")).toBe("resume");
    expect(isForwardBatchAction("delete")).toBe(true);
  });

  test("delete requires a literal true confirmation; ID normalization still applies", () => {
    for (const confirm_delete of [undefined, false, "true", 1, null]) {
      expect("message" in parseForwardBatchRequest({ action: "delete", ids: [1], confirm_delete })).toBe(true);
    }
    expect(parseForwardBatchRequest({ action: "delete", ids: [3, 1, 3], confirm_delete: true }))
      .toEqual({ action: "delete", ids: [3, 1], confirm_delete: true });
    expect("message" in parseForwardBatchRequest({ action: "delete", ids: [Number.MAX_SAFE_INTEGER + 1], confirm_delete: true })).toBe(true);
    expect("message" in parseForwardBatchRequest({ action: "delete", ids: Array.from({ length: 51 }, (_, i) => i + 1), confirm_delete: true })).toBe(true);
  });

  test("isForwardBatchAction 对非字符串/未知值都为 false", () => {
    for (const value of [undefined, null, 1, {}, [], "DELETE", "remove"]) {
      expect(isForwardBatchAction(value)).toBe(false);
    }
  });
});

describe("V4-WP9 批量请求解析", () => {
  test("合法载荷原样解析", () => {
    expect(parseForwardBatchRequest({ action: "retry", ids: [1, 2, 3] })).toEqual({
      action: "retry",
      ids: [1, 2, 3],
    });
  });

  test("ids 去重且保持首次出现顺序（同一行不做两次 rollout）", () => {
    const parsed = parseForwardBatchRequest({
      action: "suspend",
      ids: [5, 3, 5, 9, 3],
    });
    expect(parsed).toEqual({ action: "suspend", ids: [5, 3, 9] });
  });

  test("动作不在白名单 → 明确报错（不回落成某个默认动作）", () => {
    for (const action of ["remove", "", undefined, 1]) {
      const parsed = parseForwardBatchRequest({ action, ids: [1] });
      expect("message" in parsed).toBe(true);
    }
  });

  test("ids 非数组 / 空数组 → 报错", () => {
    expect("message" in parseForwardBatchRequest({ action: "retry", ids: "1,2" })).toBe(true);
    expect("message" in parseForwardBatchRequest({ action: "retry", ids: [] })).toBe(true);
    expect("message" in parseForwardBatchRequest({ action: "retry" })).toBe(true);
  });

  test("元素非正整数 → 报错（字符串数字不放行：调用方是 JSON API）", () => {
    for (const ids of [[1, "2"], [0], [-1], [1.5], [null], [NaN], [1, {}]]) {
      const parsed = parseForwardBatchRequest({ action: "retry", ids });
      expect("message" in parsed).toBe(true);
    }
  });

  test(`超过 ${FORWARD_BATCH_MAX_IDS} 条 → 拒绝而不是静默截断`, () => {
    const tooMany = Array.from({ length: FORWARD_BATCH_MAX_IDS + 1 }, (_, i) => i + 1);
    const parsed = parseForwardBatchRequest({ action: "retry", ids: tooMany });
    expect("message" in parsed).toBe(true);
    if ("message" in parsed) {
      expect(parsed.message).toContain(String(FORWARD_BATCH_MAX_IDS));
    }
  });

  test("边界：恰好上限条通过；去重后落到上限内也通过", () => {
    const exact = Array.from({ length: FORWARD_BATCH_MAX_IDS }, (_, i) => i + 1);
    expect(parseForwardBatchRequest({ action: "retry", ids: exact })).toEqual({
      action: "retry",
      ids: exact,
    });
    // 51 个元素但只有 40 个不同 id → 去重后合法（去重先于上限判断）
    const dupes = [...exact, ...Array.from({ length: 1 }, (_, i) => i + 1)];
    expect("message" in parseForwardBatchRequest({ action: "retry", ids: dupes })).toBe(false);
  });

  test("非对象载荷（null / 字符串 / 数组）→ 报错", () => {
    for (const payload of [null, undefined, "retry", 42, [1, 2]]) {
      expect("message" in parseForwardBatchRequest(payload)).toBe(true);
    }
  });
});

describe("V4-WP9 批量结果汇总", () => {
  test("requested / succeeded / failed 与逐条结果自洽", () => {
    const summary = forwardBatchSummary([
      { id: 1, ok: true, apply_status: "active" },
      { id: 2, ok: false, apply_status: null, code: "not_found" },
      { id: 3, ok: true, apply_status: "suspended" },
    ]);
    expect(summary).toEqual({ requested: 3, succeeded: 2, failed: 1 });
  });

  test("空结果集全 0（不会出现 undefined）", () => {
    expect(forwardBatchSummary([])).toEqual({ requested: 0, succeeded: 0, failed: 0 });
  });

  test("失败码归并：同一 code 累加，缺 code 归到 unknown", () => {
    const codes = forwardBatchFailureCodes([
      { id: 1, ok: true, apply_status: "active" },
      { id: 2, ok: false, apply_status: null, code: "not_found" },
      { id: 3, ok: false, apply_status: null, code: "not_found" },
      { id: 4, ok: false, apply_status: null },
    ]);
    expect(codes).toEqual({ not_found: 2, unknown: 1 });
  });
});
