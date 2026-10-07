/**
 * WP13.5A §9.4.7 —— Console 用户可见状态词表单测（纯函数，无浏览器 / 无 docker）。
 *
 * 要守住的不是「文案对不对」，而是三条结构性结论：
 *   1. 六态都存在、彼此不同（不把状态压成一档）；
 *   2. **不把所有异常压成 failed**：error → failed，suspended → degraded，
 *      掉线 / 维护中 → degraded，未落地 → desired，缺数据 → desired；
 *   3. 词表不是第二个状态机：它只调既有唯一实现（forwardProductStatus /
 *      nodeConnectionValue），源码里不出现原始运维字段。
 *
 * 跑法（web 目录）：bun test src/components/console/__tests__/
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONSOLE_STATUS_KEYS,
  consoleStatusBadge,
  consoleStatusForForward,
  consoleStatusForNode,
  consoleStatusForRouteAvailability,
  consoleStatusText,
  consoleStatusVariant,
  type ConsoleStatusKey,
} from "@/components/console/status-vocabulary";

const CONSOLE_DIR = resolve(import.meta.dir, "..");

/** 一份具备「运行 = 已保存」事实的 Forward */
const synced = {
  apply_status: "active",
  config_revision: 3,
  applied_revision: 3,
  latest_revision: 3,
} as const;

describe("六态词表", () => {
  test("六个状态键齐全且顺序稳定", () => {
    expect([...CONSOLE_STATUS_KEYS]).toEqual(["desired", "applying", "running", "available", "degraded", "failed"]);
  });

  test("中英文案两两互不相同（没有把两档说成一句话）", () => {
    const zh = CONSOLE_STATUS_KEYS.map((k) => consoleStatusText("zh", k));
    const en = CONSOLE_STATUS_KEYS.map((k) => consoleStatusText("en", k));
    expect(new Set(zh).size).toBe(zh.length);
    expect(new Set(en).size).toBe(en.length);
    expect(new Set([...zh, ...en]).size).toBe(zh.length + en.length);
  });

  test("failed 单独用 destructive；running / available 用 success", () => {
    expect(consoleStatusVariant("failed")).toBe("destructive");
    expect(consoleStatusVariant("running")).toBe("success");
    expect(consoleStatusVariant("available")).toBe("success");
    for (const key of CONSOLE_STATUS_KEYS) {
      expect(["success", "secondary", "outline", "muted", "destructive"]).toContain(consoleStatusVariant(key));
    }
  });

  test("徽章描述带稳定 key（供测试/埋点，不依赖文案）", () => {
    for (const key of CONSOLE_STATUS_KEYS) {
      const badge = consoleStatusBadge("zh", key);
      expect(badge.key).toBe(`console:${key}`);
      expect(badge.label).toBe(consoleStatusText("zh", key));
    }
  });
});

describe("Forward → 用户可见状态", () => {
  test("运行的就是已保存那一版 → running", () => {
    expect(consoleStatusForForward(synced)).toBe("running");
  });

  test("已保存未下发 → desired；下发中（等 ACK）→ applying", () => {
    expect(consoleStatusForForward({ ...synced, apply_status: "pending", config_revision: 4 })).toBe("desired");
    expect(consoleStatusForForward({ ...synced, apply_status: "applying", config_revision: 4 })).toBe("applying");
  });

  test("下发失败 → failed（且这是唯一会给出 failed 的档）", () => {
    expect(consoleStatusForForward({ ...synced, apply_status: "error", config_revision: 4 })).toBe("failed");
  });

  test("用户主动暂停 → degraded，不是 failed（暂停不是故障）", () => {
    expect(consoleStatusForForward({ ...synced, apply_status: "suspended" })).toBe("degraded");
  });

  test("缺数据 → desired，绝不显示 failed（避免把「没数据」说成「坏了」）", () => {
    expect(consoleStatusForForward(null)).toBe("desired");
    expect(consoleStatusForForward(undefined)).toBe("desired");
  });

  test("「不把异常压成一个 ERROR」：遍历所有 apply_status，failed 只在 error 出现", () => {
    const statuses = ["pending", "applying", "active", "error", "suspended", null, undefined] as const;
    const seen = new Map<string, ConsoleStatusKey>();
    for (const apply_status of statuses) {
      const result = consoleStatusForForward({ ...synced, apply_status, config_revision: 4, applied_revision: 3 });
      seen.set(String(apply_status), result);
      if (apply_status !== "error") expect({ apply_status, result }).not.toEqual({ apply_status, result: "failed" });
    }
    // 四档异常/中间态彼此可分：desired / applying / degraded / failed 都有独立出处
    expect(seen.get("pending")).toBe("desired");
    expect(seen.get("applying")).toBe("applying");
    expect(seen.get("suspended")).toBe("degraded");
    expect(seen.get("error")).toBe("failed");
    // legacy DIRECT（无 apply_status）且运行版本落后 → 仍是「待应用」，不是 failed
    expect(seen.get("null")).toBe("desired");
    // legacy DIRECT 且运行的就是已保存那一版 → running
    expect(consoleStatusForForward({ ...synced, apply_status: null })).toBe("running");
  });
});

describe("Node → 用户可见状态", () => {
  test("在线且可接新业务 → available", () => {
    expect(consoleStatusForNode({ connection: "online", accepts_new_business: true })).toBe("available");
  });

  test("在线但不接新业务（维护中/停新）→ degraded，不是 failed", () => {
    expect(consoleStatusForNode({ connection: "online", accepts_new_business: false })).toBe("degraded");
  });

  test("掉线 → degraded（可用性下降，但已有转发可能仍在跑，不能报 failed）", () => {
    expect(consoleStatusForNode({ connection: "offline" })).toBe("degraded");
  });

  test("A00: desired 仍 active/可接新业务，但连接事实 stale/offline 时绝不画成 available", () => {
    // accepts_new_business=true 是生命周期/期望层结论，不是“Agent 此刻在线”的证据。
    // 真实 stale 心跳由后端 projectUserNode 投影为 connection=offline；Console 必须
    // 服从这个事实层，不能因为 desired 仍 active 就把节点涂绿。
    expect(consoleStatusForNode({
      connection: "offline",
      accepts_new_business: true,
    })).toBe("degraded");
  });

  test("A00: 尚无连接事实时，即使 desired 允许业务也保持 desired/unknown，而非 available", () => {
    expect(consoleStatusForNode({
      connection: "waiting",
      accepts_new_business: true,
    })).toBe("desired");
  });

  test("尚未连接/等待安装 → desired；缺数据 → desired", () => {
    expect(consoleStatusForNode({ connection: "waiting" })).toBe("desired");
    expect(consoleStatusForNode(null)).toBe("desired");
    expect(consoleStatusForNode(undefined)).toBe("desired");
  });

  test("旧字段兜底（只有 online 布尔）也走既有投影，不自己算窗口", () => {
    expect(consoleStatusForNode({ online: true })).toBe("available");
    expect(consoleStatusForNode({ online: false })).toBe("degraded");
  });
});

describe("线路可用性 → 用户可见状态", () => {
  test("可选的线路 → available；无可用节点 / 降级 → degraded；未启用 → desired", () => {
    expect(consoleStatusForRouteAvailability({ enabled: true, availableNodes: 3 })).toBe("available");
    expect(consoleStatusForRouteAvailability({ enabled: true, availableNodes: 0 })).toBe("degraded");
    expect(consoleStatusForRouteAvailability({ enabled: true, availableNodes: 2, degraded: true })).toBe("degraded");
    expect(consoleStatusForRouteAvailability({ enabled: false, availableNodes: 2 })).toBe("desired");
  });

  test("缺省输入不产生 failed（线路层没有 failed 判定权）", () => {
    expect(consoleStatusForRouteAvailability({})).toBe("degraded");
    expect(consoleStatusForRouteAvailability({ enabled: true })).toBe("degraded");
  });
});

describe("词表不是第二个状态机", () => {
  const src = readFileSync(resolve(CONSOLE_DIR, "status-vocabulary.ts"), "utf8");

  test("只复用既有唯一实现做投影", () => {
    expect(src).toContain('from "@/lib/forward-status"');
    expect(src).toContain("forwardProductStatus");
    expect(src).toContain('from "@/lib/node-status"');
    expect(src).toContain("nodeConnectionValue");
  });

  test("源码里不出现原始运维字段的读取（不自己推导状态 / 不自己算窗口）", () => {
    // 只看代码：注释里可以（也应该）解释 lease epoch 为什么不进 User Console
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const raw of [".applied_revision", ".config_revision", ".latest_revision", ".last_seen_at", "lease", "epoch", "ack"]) {
      expect({ raw, occurrences: code.split(raw).length - 1 }).toEqual({ raw, occurrences: 0 });
    }
    expect(code.includes("90")).toBe(false); // 不复制 90s 心跳窗口判据
  });
});
