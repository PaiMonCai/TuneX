/**
 * V4-WP11B — 状态上报里的能力协商字段。
 *
 * 校验纪律与遥测一致（缺失容忍、类型错拒绝），但这里多守一条：**坏形状绝不允许
 * 退化成"未上报"**。因为"未上报"在面板侧等于"按基线放行"，把坏载荷降级成未上报
 * 就是把 fail-closed 悄悄变成 fail-open，方向恰好错反。
 */
import { describe, expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import { telemetryColumns, validateStateReport } from "../node-state.ts";

const BASE = { agent_id: "a".repeat(32), version: "0.13.22", role: "BOTH" };

describe("control protocol fields in the state report", () => {
  test("accepts an agent that reports both facts", () => {
    const r = validateStateReport({
      ...BASE,
      control_protocol_version: 1,
      capabilities: ["apply_tunnel", "remove_tunnel"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.control_protocol_version).toBe(1);
    expect(r.report.capabilities).toEqual(["apply_tunnel", "remove_tunnel"]);
  });

  test("accepts an old agent that reports neither (absence is a valid shape)", () => {
    const r = validateStateReport({ ...BASE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.control_protocol_version).toBeUndefined();
    expect(r.report.capabilities).toBeUndefined();
  });

  test("rejects a version that is not a non-negative integer", () => {
    for (const value of [-1, 1.5, "1", true, {}, []]) {
      const r = validateStateReport({ ...BASE, control_protocol_version: value });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("bad_capabilities");
    }
  });

  test("rejects a capability list that is not an array of bounded strings", () => {
    const bad: unknown[] = [
      "apply_tunnel",
      { apply_tunnel: true },
      [1],
      [""],
      ["x".repeat(65)],
      Array.from({ length: 64 }, (_v, i) => `action_${i}`),
    ];
    for (const capabilities of bad) {
      const r = validateStateReport({ ...BASE, capabilities });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("bad_capabilities");
    }
  });

  test("an empty capability array is accepted and stays an empty array", () => {
    const r = validateStateReport({ ...BASE, capabilities: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.capabilities).toEqual([]);
  });

  test("'never reported' and 'reported nothing' map to different columns", () => {
    const absent = validateStateReport({ ...BASE });
    const empty = validateStateReport({ ...BASE, capabilities: [], control_protocol_version: 1 });
    if (!absent.ok || !empty.ok) throw new Error("both shapes must validate");

    const absentCols = telemetryColumns(absent.report);
    const emptyCols = telemetryColumns(empty.report);

    // Absent → SQL NULL (Prisma.JsonNull); empty → a real JSON array value.
    expect(absentCols.capabilities).toBe(Prisma.JsonNull);
    expect(absentCols.control_protocol_version).toBeNull();
    expect(emptyCols.capabilities).toEqual([]);
    expect(emptyCols.control_protocol_version).toBe(1);
    expect(absentCols.capabilities).not.toEqual(emptyCols.capabilities);
  });

  test("normalization on the way to the column is deterministic", () => {
    const r = validateStateReport({
      ...BASE,
      capabilities: [" remove_tunnel ", "apply_tunnel", "apply_tunnel"],
      control_protocol_version: 2,
    });
    if (!r.ok) throw new Error("must validate");
    expect(telemetryColumns(r.report).capabilities).toEqual(["apply_tunnel", "remove_tunnel"]);
  });
});
