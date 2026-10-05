/**
 * V5-WP20-1 计费时钟纯函数（`services/billing-time.ts`）单元测试 —— 离线，不碰 DB/Redis。
 *
 * 契约：`docs/v5-wp20-subscription-billing-runtime-contract.md` §3.1（计费时钟）、§7.2（时间夹具）、
 * 风险 R1；DoD 第 3 条（**同一组断言在三个进程时区下逐字相等**）。
 *
 * 覆盖：
 *   A. **静态守卫**：模块不出现任何跟随进程时区的 API（`setHours`/`setDate`/`getHours`/
 *      `Date.now`/`process.env.TZ`），也不 import 判定层（`capability-policy`/`policy-service`，
 *      契约 §8.3）；且必须显式声明固定时区与 `Intl.DateTimeFormat`。
 *   B. `billingCalendarParts`：UTC 日与上海日错开的临界时刻、午夜渲染为 `00`（`hourCycle: "h23"`）。
 *   C. `billingMonthStart`：窗口起点 = 上海当月 1 日 00:00（= 上月末 16:00Z）；月界前后各 1ms。
 *   D. `billingMonthlyBoundary`：`monthOffset` 取上一/下一周期、`resetDay` 的**两条夹取**
 *      （28 天上限 + 该月实际天数）、`SystemConfig` 字符串入参、非法回落 `1`。
 *   E. `billingAddMonthsClamped`：**保留上海墙钟时分秒毫秒** + 月日夹取（1/31 + 1 月 = 2/28，
 *      闰年 = 2/29），跨年、+0 恒等。
 *   F. **进程时区无关**：同一组金样本（`billing-clock-canonical.ts`）在
 *      `TZ=UTC` / `TZ=Asia/Shanghai` / `TZ=America/Los_Angeles` 三个**子进程**里逐字相等，
 *      且与当前进程结果一致（子进程真跑 `bun -e`，不是 mock；跑不出来即 FAIL，不 skip）。
 *
 * 跑法（backend 目录）：
 *   bun test src/services/__tests__/v5-wp20/billing-time.test.ts
 * 三时区证据（同一文件跑三遍，输出需逐字相等）：
 *   for tz in UTC Asia/Shanghai America/Los_Angeles; do TZ=$tz bun test src/services/__tests__/v5-wp20/billing-time.test.ts; done
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BILLING_TIME_ZONE,
  billingAddMonthsClamped,
  billingCalendarParts,
  billingMonthStart,
  billingMonthlyBoundary,
} from "../../billing-time.ts";
import { CANONICAL_INSTANTS, canonicalText } from "./billing-clock-canonical.ts";

const SOURCE_PATH = new URL("../../billing-time.ts", import.meta.url);
const SOURCE = readFileSync(SOURCE_PATH, "utf8");
/** 去掉注释后的**代码**：契约里被禁止的东西出现在注释里是解释，出现在代码里才是违规。 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'])\/\/[^\n]*/g, "$1");
const CANONICAL_PATH = new URL("./billing-clock-canonical.ts", import.meta.url).pathname;

describe("A. 静态守卫：模块不依赖进程时区、不越界判定层", () => {
  test("固定时区声明 + 只用 Intl.DateTimeFormat 派生日历分量", () => {
    expect(BILLING_TIME_ZONE).toBe("Asia/Shanghai");
    expect(SOURCE).toContain('BILLING_TIME_ZONE = "Asia/Shanghai"');
    expect(SOURCE).toContain("timeZone: BILLING_TIME_ZONE");
    expect(SOURCE).toContain("hourCycle: \"h23\"");
    expect(SOURCE).toContain("Intl.DateTimeFormat");
  });

  test("禁止跟随进程时区的 API / 读系统时钟 / 读 TZ 环境变量（R1 的成因）", () => {
    // 先自检「注释剥离」没把整个文件吃掉（否则下面的 not.toContain 会假绿）
    expect(CODE).toContain("export function billingCalendarParts");
    expect(CODE.length).toBeLessThan(SOURCE.length);
    for (const forbidden of [
      ".setHours(",
      ".setDate(",
      ".setMonth(",
      ".getHours(",
      ".getDate(",
      ".getMonth(",
      ".getTimezoneOffset(",
      ".toLocaleString(",
      ".toLocaleDateString(",
      "process.env",
      "Date.now(",
      "new Date()",
    ]) {
      expect({ forbidden, hits: CODE.includes(forbidden) }).toEqual({ forbidden, hits: false });
    }
  });

  test("不 import 判定层：计费模块不得读 max_tunnels/traffic_limit（契约 §8.3）", () => {
    expect(SOURCE).toContain("不改 `policy-service.ts`"); // 证明注释只做说明、不构成依赖
    for (const forbidden of ["capability-policy", "policy-service", "checkTunnelCreation", "max_tunnels", "traffic_limit"]) {
      expect({ forbidden, hits: CODE.includes(forbidden) }).toEqual({ forbidden, hits: false });
    }
  });
});

describe("B. billingCalendarParts：上海墙钟分量", () => {
  test("UTC 日与上海日错开的两个临界时刻", () => {
    expect(billingCalendarParts(new Date("2026-01-31T15:59:59.999Z"))).toEqual({
      year: 2026,
      month: 1,
      day: 31,
      hour: 23,
      minute: 59,
      second: 59,
    });
    expect(billingCalendarParts(new Date("2026-01-31T16:00:00.000Z"))).toEqual({
      year: 2026,
      month: 2,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
  });

  test("上海午夜渲染为 00 而不是 24（hourCycle h23）", () => {
    expect(billingCalendarParts(new Date("2026-03-31T16:00:00.000Z")).hour).toBe(0);
    expect(billingCalendarParts(new Date("2026-12-31T16:00:00.000Z"))).toEqual({
      year: 2027,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
  });

  test("非法时间点 fail-closed", () => {
    expect(() => billingCalendarParts(new Date("nope"))).toThrow(RangeError);
    expect(() => billingCalendarParts(Number.NaN)).toThrow(RangeError);
  });
});

describe("C. billingMonthStart：上海自然月月首（= 上月末 16:00Z）", () => {
  test("固定 UTC 戳", () => {
    expect(billingMonthStart(new Date("2026-03-15T10:00:00.000Z")).toISOString()).toBe("2026-02-28T16:00:00.000Z");
    expect(billingMonthStart(new Date("2026-01-01T00:00:00.000Z")).toISOString()).toBe("2025-12-31T16:00:00.000Z");
  });

  test("月界两侧各 1ms：起点只差一个月", () => {
    const before = billingMonthStart(new Date("2026-02-28T15:59:59.999Z"));
    const at = billingMonthStart(new Date("2026-02-28T16:00:00.000Z"));
    expect(before.toISOString()).toBe("2026-01-31T16:00:00.000Z");
    expect(at.toISOString()).toBe("2026-02-28T16:00:00.000Z");
    expect(at.getTime() - before.getTime()).toBe(28 * 86_400_000);
  });

  test("性质：结果的上海墙钟必须是 1 日 00:00:00", () => {
    const instants = [
      "2026-01-01T00:00:00.000Z",
      "2026-01-31T16:00:00.000Z",
      "2026-06-15T23:59:59.999Z",
      "2026-12-31T16:00:00.000Z",
      "2028-02-29T12:00:00.000Z",
      "2029-01-01T00:00:00.000Z",
    ];
    for (const instant of instants) {
      const parts = billingCalendarParts(billingMonthStart(new Date(instant)));
      expect({ day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second }).toEqual({
        day: 1,
        hour: 0,
        minute: 0,
        second: 0,
      });
    }
  });
});

describe("D. billingMonthlyBoundary：周期边界与两条夹取", () => {
  test("resetDay=1 且 offset=0 时与 billingMonthStart 同源", () => {
    for (const instant of ["2026-01-31T16:00:00.000Z", "2026-08-09T03:04:05.006Z"]) {
      const at = new Date(instant);
      expect(billingMonthlyBoundary(at, 1).toISOString()).toBe(billingMonthStart(at).toISOString());
    }
  });

  test("monthOffset=-1 取上一周期边界（跨年）", () => {
    expect(billingMonthlyBoundary(new Date("2026-01-01T00:00:00.000Z"), 1, -1).toISOString()).toBe(
      "2025-11-30T16:00:00.000Z",
    );
    // 上海 2026-02-01 00:00（UTC 还在 1 月）：上一周期是上海的 1 月，不是 UTC 的 1 月
    expect(billingMonthlyBoundary(new Date("2026-01-31T16:00:00.000Z"), 1, -1).toISOString()).toBe(
      "2025-12-31T16:00:00.000Z",
    );
  });

  test("monthOffset=+1 取下一周期边界", () => {
    expect(billingMonthlyBoundary(new Date("2026-12-31T16:00:00.000Z"), 1, 1).toISOString()).toBe(
      "2027-01-31T16:00:00.000Z",
    );
  });

  test("第一层夹取：28 天上限（默认）避免 2 月跳变", () => {
    // 上海 1 月：min(31, 28, 31) = 28
    expect(billingMonthlyBoundary(new Date("2026-01-10T00:00:00.000Z"), 31).toISOString()).toBe(
      "2026-01-27T16:00:00.000Z",
    );
    // 上海 2 月：min(31, 28, 28) = 28
    expect(billingMonthlyBoundary(new Date("2026-02-10T00:00:00.000Z"), 31).toISOString()).toBe(
      "2026-02-27T16:00:00.000Z",
    );
    // 显式放宽上限后才落到月内 31 日
    expect(billingMonthlyBoundary(new Date("2026-01-10T00:00:00.000Z"), 31, 0, 31).toISOString()).toBe(
      "2026-01-30T16:00:00.000Z",
    );
  });

  test("第二层夹取：目标月实际天数（闰年 2 月 = 29）", () => {
    expect(billingMonthlyBoundary(new Date("2028-02-10T00:00:00.000Z"), 29, 0, 31).toISOString()).toBe(
      "2028-02-28T16:00:00.000Z",
    );
    expect(billingMonthlyBoundary(new Date("2026-02-10T00:00:00.000Z"), 29, 0, 31).toISOString()).toBe(
      "2026-02-27T16:00:00.000Z",
    );
  });

  test("resetDay 来自 SystemConfig 字符串；非法值回落 1（fail-closed）", () => {
    const at = new Date("2026-05-20T00:00:00.000Z");
    expect(billingMonthlyBoundary(at, "1").toISOString()).toBe(billingMonthStart(at).toISOString());
    expect(billingMonthlyBoundary(at, "5").toISOString()).toBe("2026-05-04T16:00:00.000Z");
    for (const invalid of ["", " ", "abc", "0", "-5", "NaN", Number.NaN, undefined, null]) {
      expect(billingMonthlyBoundary(at, invalid).toISOString()).toBe(billingMonthStart(at).toISOString());
    }
    // 小数向下取整；1.9 仍是 1 日
    expect(billingMonthlyBoundary(at, 1.9).toISOString()).toBe(billingMonthStart(at).toISOString());
  });

  test("maximumResetDay 非法时上限回落 1（比下限更严，不放宽）", () => {
    const at = new Date("2026-05-20T00:00:00.000Z");
    expect(billingMonthlyBoundary(at, 10, 0, "abc").toISOString()).toBe("2026-04-30T16:00:00.000Z");
  });

  test("monthOffset 非法 fail-closed", () => {
    expect(() => billingMonthlyBoundary(new Date(0), 1, Number.NaN)).toThrow(RangeError);
    expect(() => billingMonthlyBoundary(new Date(0), 1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("E. billingAddMonthsClamped：按月推进 + 保留上海墙钟", () => {
  test("月日夹取：1/31 + 1 月 = 2/28（非闰年）", () => {
    expect(billingAddMonthsClamped(new Date("2026-01-31T15:59:59.999Z"), 1).toISOString()).toBe(
      "2026-02-28T15:59:59.999Z",
    );
  });

  test("闰年：1/31 + 1 月 = 2/29", () => {
    expect(billingAddMonthsClamped(new Date("2028-01-31T02:30:00.000Z"), 1).toISOString()).toBe(
      "2028-02-29T02:30:00.000Z",
    );
  });

  test("保留上海墙钟时分秒毫秒（不是保留 UTC 偏移）", () => {
    const source = new Date("2026-01-31T02:30:45.123Z"); // 上海 2026-01-31 10:30:45.123
    const shifted = billingAddMonthsClamped(source, 1);
    expect(shifted.toISOString()).toBe("2026-02-28T02:30:45.123Z");
    expect(billingCalendarParts(shifted)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
      hour: 10,
      minute: 30,
      second: 45,
    });
  });

  test("+0 恒等、+12 同月日、-1 回退、跨年", () => {
    const source = new Date("2026-03-15T07:08:09.010Z");
    expect(billingAddMonthsClamped(source, 0).toISOString()).toBe(source.toISOString());
    expect(billingAddMonthsClamped(source, 12).toISOString()).toBe("2027-03-15T07:08:09.010Z");
    expect(billingAddMonthsClamped(source, -1).toISOString()).toBe("2026-02-15T07:08:09.010Z");
    expect(billingAddMonthsClamped(new Date("2026-12-31T16:00:00.000Z"), 1).toISOString()).toBe(
      "2027-01-31T16:00:00.000Z",
    );
  });

  test("小数月份向下取整；非法 months fail-closed", () => {
    const source = new Date("2026-01-15T00:00:00.000Z");
    expect(billingAddMonthsClamped(source, 1.9).toISOString()).toBe("2026-02-15T00:00:00.000Z");
    expect(() => billingAddMonthsClamped(source, Number.NaN)).toThrow(RangeError);
    expect(() => billingAddMonthsClamped(new Date("nope"), 1)).toThrow(RangeError);
  });
});

describe("F. 进程时区无关：三个子进程逐字相等（DoD 第 3 条）", () => {
  const ZONES = ["UTC", "Asia/Shanghai", "America/Los_Angeles"] as const;

  test("金样本在三个 TZ 子进程里的输出逐字相等，且与本进程一致", () => {
    const inProcess = canonicalText();
    expect(CANONICAL_INSTANTS.length).toBeGreaterThanOrEqual(7);

    const results = ZONES.map((zone) => {
      const child = Bun.spawnSync({
        cmd: [process.execPath, "-e", `import { canonicalText } from ${JSON.stringify(CANONICAL_PATH)}; process.stdout.write(canonicalText());`],
        env: { ...process.env, TZ: zone },
        stdout: "pipe",
        stderr: "pipe",
      });
      // 子进程跑不起来 / 报错必须 FAIL（契约 §7.1 失败语义：不得 skip）
      if (child.exitCode !== 0) {
        throw new Error(`TZ=${zone} 子进程失败（exit ${child.exitCode}）：${child.stderr.toString()}`);
      }
      return { zone, text: child.stdout.toString() };
    });

    for (const { zone, text } of results) {
      expect({ zone, text }).toEqual({ zone, text: inProcess });
    }
  }, 30_000);

  test("金样本覆盖了 UTC/上海日界、月末、闰年（防止样本退化后仍「全绿」）", () => {
    const text = canonicalText();
    expect(text).toContain("2026-01-31T15:59:59.999Z");
    expect(text).toContain("2026-01-31T16:00:00.000Z");
    expect(text).toContain("2028-01-31T02:30:00.000Z");
    expect(text).toContain("2028-02-29T02:30:00.000Z"); // 闰年夹取的金样本确实在里面
    expect(text).toContain("2026-02-28T15:59:59.999Z"); // 非闰年夹取
    expect(text).toContain(BILLING_TIME_ZONE);
  });
});
