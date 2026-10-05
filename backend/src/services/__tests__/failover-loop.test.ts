/**
 * V5.3 WP10 —— 自动迁移循环的**策略闸门**与**汇总**。
 *
 * 最重要的断言是第一条：**策略没配置过 ⇒ 什么都不做**。
 * §8 要求"自动迁移必须是显式 policy"，而"默认打开、出事再关"正好违背它 —— 迁移会中断服务，
 * 不该由缺省值开启。这条规则必须能在不起数据库的情况下被钉住，否则它会被某个"顺手打开"的
 * 改动悄悄推翻。
 */
import { describe, expect, test } from "bun:test";

import { readFailoverPolicy, runFailoverSweep, FAILOVER_POLICY_CONFIG_KEY } from "../failover-loop.ts";

describe("V5.3 WP10: the automatic loop is fail-closed on policy", () => {
  test("the config key is the one the migration added", () => {
    expect(FAILOVER_POLICY_CONFIG_KEY).toBe("FAILOVER_POLICY");
  });

  test("both switches default to OFF when nothing is configured", async () => {
    // 读不到（没有行 / DB 不可用）都必须落到 false。
    const { systemConfig } = await import("../config.ts");
    const original = systemConfig.getConfig;
    try {
      (systemConfig as unknown as { getConfig: () => Promise<null> }).getConfig = async () => null;
      const policy = await readFailoverPolicy();
      expect(policy.auto_failover).toBe(false);
      expect(policy.auto_failback).toBe(false);
    } finally {
      (systemConfig as unknown as { getConfig: unknown }).getConfig = original;
    }
  });

  test("a MALFORMED policy is off AND reported, never silently on", async () => {
    const { systemConfig } = await import("../config.ts");
    const original = systemConfig.getConfig;
    try {
      (systemConfig as unknown as { getConfig: () => Promise<string> }).getConfig = async () => "{not json";
      const policy = await readFailoverPolicy();
      expect(policy.auto_failover).toBe(false);
      expect(policy.auto_failback).toBe(false);
      // 坏配置必须被**报告**：静默按关闭处理会让"运维以为开了"变成长期错觉。
      expect(typeof (policy as { parse_error?: string }).parse_error).toBe("string");
    } finally {
      (systemConfig as unknown as { getConfig: unknown }).getConfig = original;
    }
  });

  test("an explicit policy is honoured, and only `true` counts", async () => {
    const { systemConfig } = await import("../config.ts");
    const original = systemConfig.getConfig;
    try {
      (systemConfig as unknown as { getConfig: () => Promise<string> }).getConfig = async () =>
        JSON.stringify({ auto_failover: true, auto_failback: "yes" });
      const policy = await readFailoverPolicy();
      expect(policy.auto_failover).toBe(true);
      // 字符串 "yes" 不是 true：策略是显式布尔，不做真值猜测。
      expect(policy.auto_failback).toBe(false);
    } finally {
      (systemConfig as unknown as { getConfig: unknown }).getConfig = original;
    }
  });

  test("with the policy off, the sweep evaluates NOTHING (it cannot even see the tunnels)", async () => {
    let executed = 0;
    const result = await runFailoverSweep({
      readPolicy: async () => ({ auto_failover: false, auto_failback: false }),
      execute: (async () => {
        executed += 1;
        return { outcome: "hold" } as never;
      }) as never,
      tunnelIds: [1, 2, 3],
      log: () => undefined,
    });
    expect(executed).toBe(0);
    expect(result).toMatchObject({ evaluated: 0, moved: 0, held: 0, results: [] });
  });

  test("with the policy on, every evaluated tunnel produces a structured result", async () => {
    const outcomes = ["moved", "hold", "waiting_lease"] as const;
    let i = 0;
    const result = await runFailoverSweep({
      readPolicy: async () => ({ auto_failover: true, auto_failback: false }),
      execute: (async () => ({ outcome: outcomes[i++ % outcomes.length], reason: "x" }) as never) as never,
      // V5-WP17.4：扫描新增了两个协作者（DNS 就绪闸门 / DNS 后继）。与 `readPolicy`、`execute`
      // 同一取向：**注入替身**，于是这条"计数只统计终态"的断言完全不依赖数据库。
      dnsGate: async () => ({ applicable: false, ready: true }),
      dnsSuccessor: async () => ({ outcome: "not_applicable" }),
      tunnelIds: [1, 2, 3],
      log: () => undefined,
    });
    expect(result.evaluated).toBe(3);
    expect(result.results).toHaveLength(3);
    expect(result.dns_gated).toEqual([]);
    // 计数只统计终态：hold 不算 moved，也不需要被当成失败。
    expect(result.moved).toBe(1);
    expect(result.held).toBe(1);
  });
});
