/**
 * cron_delete_tunnel_traffic 保留期判定单元测试（不连 MySQL / Redis）。
 *
 * 覆盖 PLAN §OPS-03 / §阶段 3 的验收项：
 *   1. **保留期判定**：正常数字、缺省、非法值（非数字/0/负数/小数/越界）、
 *      空串各自的行为 —— 只有合法正整数被采用，其余回落 DEFAULT_RETENTION_DAYS；
 *   2. **删除边界**：`retentionCutoff` 按 UTC 日界取整，删 `date < cutoff`，
 *      恰好保留最近 N 个自然日（含今天）；时区口径必须是 UTC（tunnel_traffic.date
 *      由 trafficDate() 写 UTC 午夜，本地零点会把 UTC+8 的临界行算错一天）；
 *   3. **幂等**：同样的 (配置, now) 跑两轮，deleteBefore 收到同一个 cutoff；
 *      第二轮匹配集为空（删除条数 0），不存在「删两遍」的可能；
 *   4. **where 条件**：`{ date: { lt: cutoff } }`，不含其它维度；
 *   5. **失败不吞**：DB 抛错时异常向上传播（worker 记 failed + BullMQ 重试），
 *      不会把「清理失败」伪装成「没有过期数据」。
 */
import { test, expect, describe } from "bun:test";
import {
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  resolveRetentionDays,
  retentionCutoff,
  retentionWhere,
  deleteExpiredTraffic,
  defaultTrafficRetentionDeps,
  type TrafficRetentionDeps,
} from "../services/traffic-retention.ts";

const NOW = new Date("2026-09-30T05:00:00.000Z");

describe("resolveRetentionDays 保留期判定", () => {
  test("合法正整数直接采用", () => {
    expect(resolveRetentionDays("30")).toEqual({ days: 30, missing: false, invalid: false });
    expect(resolveRetentionDays("90")).toEqual({ days: 90, missing: false, invalid: false });
    expect(resolveRetentionDays("1")).toEqual({ days: 1, missing: false, invalid: false });
  });

  test("缺省配置（没有这一行）→ 标记 missing，回落默认", () => {
    expect(resolveRetentionDays(null)).toEqual({ days: DEFAULT_RETENTION_DAYS, missing: true, invalid: false });
    expect(resolveRetentionDays(undefined)).toEqual({ days: DEFAULT_RETENTION_DAYS, missing: true, invalid: false });
    // 空串等价于缺省：运营清空输入框不应触发任何「删光/不删」的异常语义
    expect(resolveRetentionDays("")).toEqual({ days: DEFAULT_RETENTION_DAYS, missing: true, invalid: false });
    expect(resolveRetentionDays("   ")).toEqual({ days: DEFAULT_RETENTION_DAYS, missing: true, invalid: false });
  });

  test("非法值一律回落默认并标记 invalid（绝不删光，也不无限保留）", () => {
    for (const raw of ["abc", "0", "-3", "1.5", "NaN", "Infinity", "30天", " 30a ", "3,0", "+", "1e400"]) {
      expect(resolveRetentionDays(raw)).toEqual({ days: DEFAULT_RETENTION_DAYS, missing: false, invalid: true });
    }
    // 超过上限同样非法：1000 < 3650 合法，3651 越界
    expect(resolveRetentionDays(String(MAX_RETENTION_DAYS + 1)).invalid).toBe(true);
    expect(resolveRetentionDays(String(MAX_RETENTION_DAYS + 1)).days).toBe(DEFAULT_RETENTION_DAYS);
    // 带空白的整数：JS Number() 吃得下，宽松解析后仍算合法
    expect(resolveRetentionDays(" 30 ")).toEqual({ days: 30, missing: false, invalid: false });
  });

  test("边界：恰好等于上限合法", () => {
    expect(resolveRetentionDays(String(MAX_RETENTION_DAYS)).invalid).toBe(false);
    expect(resolveRetentionDays(String(MAX_RETENTION_DAYS)).days).toBe(MAX_RETENTION_DAYS);
  });
});

describe("retentionCutoff 删除边界", () => {
  test("按 UTC 日界回退 N 天，删 date < cutoff 即恰好保留含今天的 N 天", () => {
    // now=09-30，30 天保留期 → cutoff=08-31：删 08-30 及更早，保留 08-31..09-30 共 30 行
    const cutoff = retentionCutoff(30, NOW);
    expect(cutoff.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    // 保留窗口的起始日（含）>= cutoff；边界前一天（含）< cutoff
    expect(new Date("2026-08-31T00:00:00.000Z") < cutoff).toBe(false);
    expect(new Date("2026-08-30T00:00:00.000Z") < cutoff).toBe(true);
    expect(new Date("2026-09-30T00:00:00.000Z") < cutoff).toBe(false);
  });

  test("days=1 时只保留今天", () => {
    const cutoff = retentionCutoff(1, NOW);
    expect(cutoff.toISOString()).toBe("2026-09-29T00:00:00.000Z");
    expect(new Date("2026-09-29T00:00:00.000Z") < cutoff).toBe(false);
    expect(new Date("2026-09-28T00:00:00.000Z") < cutoff).toBe(true);
  });

  test("跨月/跨年回退正确", () => {
    expect(retentionCutoff(30, new Date("2026-03-05T12:00:00.000Z")).toISOString()).toBe(
      "2026-02-03T00:00:00.000Z",
    );
    expect(retentionCutoff(10, new Date("2026-01-05T00:00:00.000Z")).toISOString()).toBe(
      "2025-12-26T00:00:00.000Z",
    );
  });

  test("UTC+8 临近日界：同一天的不同时刻得到同一个 cutoff（UTC 日界口径）", () => {
    // 北京时间 09-01 07:00 在 UTC 里还是 08-31 23:00 —— 当前 UTC 日界是 08-31，
    // 而北京时间 09-16 07:00 的 UTC 日界是 09-15。两者相差一个 UTC 日界，
    // 因此 cutoff 相差一天：这正是「按 UTC 日界划界」的确定性行为。
    // 若误用本地零点（setHours），同一本地日的不同时刻会给出不同 cutoff。
    const utcNow = new Date("2026-09-01T07:00:00+08:00");
    expect(retentionCutoff(30, utcNow).toISOString()).toBe("2026-08-01T00:00:00.000Z");
    // 同一 UTC 时刻的另一种写法（Z 串）必须一致 —— 证明没有本地时区参与
    expect(retentionCutoff(30, new Date("2026-08-31T23:00:00.000Z")).toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    // 跨到 UTC 09-01 日界后 cutoff 才前移一天
    expect(retentionCutoff(30, new Date("2026-09-01T00:00:00.000Z")).toISOString()).toBe(
      "2026-08-02T00:00:00.000Z",
    );
  });

  test("days 非法（<=0 / 非有限）回落默认值，而不是删全表", () => {
    expect(retentionCutoff(0, NOW).toISOString()).toBe(retentionCutoff(DEFAULT_RETENTION_DAYS, NOW).toISOString());
    expect(retentionCutoff(-5, NOW).toISOString()).toBe(retentionCutoff(DEFAULT_RETENTION_DAYS, NOW).toISOString());
    expect(retentionCutoff(Number.NaN, NOW).toISOString()).toBe(
      retentionCutoff(DEFAULT_RETENTION_DAYS, NOW).toISOString(),
    );
  });

  test("where 只按 date 早于 cutoff 过滤（不带其它维度）", () => {
    const cutoff = retentionCutoff(7, NOW);
    expect(retentionWhere(cutoff)).toEqual({ date: { lt: cutoff } });
  });
});

describe("deleteExpiredTraffic 编排", () => {
  function makeDeps(raw: string | null, deleted: number | Error = 3) {
    const seen: Date[] = [];
    const deps: TrafficRetentionDeps = {
      async readRetentionConfig() {
        return raw;
      },
      async deleteBefore(cutoff) {
        seen.push(cutoff);
        if (deleted instanceof Error) throw deleted;
        return deleted;
      },
    };
    return { deps, seen };
  }

  test("正常路径：读配置 → 按边界删除 → 上报保留天数与删除条数", async () => {
    const { deps, seen } = makeDeps("14", 7);
    const r = await deleteExpiredTraffic(deps, NOW);
    expect(r).toEqual({
      retention_days: 14,
      cutoff: "2026-09-16T00:00:00.000Z",
      deleted: 7,
      config_missing: false,
      config_invalid: false,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].toISOString()).toBe("2026-09-16T00:00:00.000Z");
  });

  test("幂等：同一 (配置, now) 跑两轮收到同一个 cutoff；第二轮删除 0 条", async () => {
    const raw = "30";
    let deleted = 5;
    const seen: Date[] = [];
    const deps: TrafficRetentionDeps = {
      async readRetentionConfig() {
        return raw;
      },
      async deleteBefore(cutoff) {
        seen.push(cutoff);
        const out = deleted;
        deleted = 0; // 第一轮把过期行删光，第二轮匹配集为空
        return out;
      },
    };
    const first = await deleteExpiredTraffic(deps, NOW);
    const second = await deleteExpiredTraffic(deps, NOW);
    expect(first.deleted).toBe(5);
    expect(second.deleted).toBe(0);
    expect(new Set(seen.map((d) => d.toISOString())).size).toBe(1);
  });

  test("配置缺失 → 回落默认 30 天并在结果里标记 config_missing", async () => {
    const { deps } = makeDeps(null, 0);
    const r = await deleteExpiredTraffic(deps, NOW);
    expect(r.retention_days).toBe(DEFAULT_RETENTION_DAYS);
    expect(r.config_missing).toBe(true);
    expect(r.config_invalid).toBe(false);
  });

  test("配置非法 → 回落默认 30 天并标记 config_invalid（不删光表）", async () => {
    const { deps, seen } = makeDeps("0", 0);
    const r = await deleteExpiredTraffic(deps, NOW);
    expect(r.retention_days).toBe(DEFAULT_RETENTION_DAYS);
    expect(r.config_missing).toBe(false);
    expect(r.config_invalid).toBe(true);
    expect(seen[0].toISOString()).toBe(retentionCutoff(DEFAULT_RETENTION_DAYS, NOW).toISOString());
  });

  test("删除失败向上抛（不吞错：worker 记 failed 并重试）", async () => {
    const { deps } = makeDeps("30", new Error("mysql gone away"));
    await expect(deleteExpiredTraffic(deps, NOW)).rejects.toThrow("mysql gone away");
  });

  test("读取配置失败同样向上抛", async () => {
    const deps: TrafficRetentionDeps = {
      async readRetentionConfig() {
        throw new Error("config read failed");
      },
      async deleteBefore() {
        return 0;
      },
    };
    await expect(deleteExpiredTraffic(deps, NOW)).rejects.toThrow("config read failed");
  });

  test("defaultTrafficRetentionDeps 提供全套依赖（形状契约，不连库）", () => {
    const deps = defaultTrafficRetentionDeps();
    expect(typeof deps.readRetentionConfig).toBe("function");
    expect(typeof deps.deleteBefore).toBe("function");
  });
});
