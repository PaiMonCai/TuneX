/**
 * V5-WP20 —— 策略缓存的**时间语义**回归（`getEffectivePolicy` 的 `noCache` 与 TTL 基准）。
 *
 * 契约 §3.2.1 要求「判定侧每次重算（`getEffectivePolicy(..., { noCache: true })`）」；
 * 而缓存曾经有两条自相矛盾的行为（由 V5-G7 门禁在调试中撞出来）：
 *   ① **`noCache: true` 仍然写缓存** ⇒ 一个声明"我要按这个时刻重算"的调用方反而成了**污染源**；
 *   ② 有效期判定用 **`调用方 now − 计算时 now`** ⇒ 传**未来时刻**的调用方（门禁 / 回填 /
 *      将来的 `TUNNEL_BILLING_NOW` 类开关）让条目"永远年轻"，把"未来那一刻"的策略钉给所有人。
 *
 * 一句语义（写进契约 §5.9）：**缓存的到期是墙钟概念，策略的计算时刻是调用方概念。**
 *
 * 本文件在**子进程**里跑（`mock.module` 是进程级注册表；与其它套件同进程会互相污染），
 * 且必须在 import 被测模块**之前**设好 `POLICY_CACHE_TTL_MS`（模块在 import 期读它）。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp20/policy-cache-time.test.ts
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const root = new URL("../../../../", import.meta.url).pathname; // → backend/（四级：v5-wp20→__tests__→services→src→backend）

const scenario = String.raw`
import { mock, expect } from "bun:test";
const root = process.env.TUNEX_CACHE_ROOT;

// 可控的"数据库"：只覆盖 loadPolicyInputs 的两个查询面。
let assignments = [];
let ceilings = [];
const rows = () => assignments.map((policy) => ({
  source: policy.source ?? "purchase",
  effective_at: new Date(Date.now() - 30 * 86400000),
  expires_at: null,
  revoked_at: null,
  note: null,
  policy: {
    id: policy.id, key: policy.key, name: policy.key, source: policy.source ?? "purchase",
    is_default: false, applies_to: null, is_ceiling: false, status: "active", revision: 1,
    tunnel_types: ["tcp"], allow_custom_in_group: false, allow_custom_out_group: false,
    allowed_in_group_ids: null, allowed_out_group_ids: null, allow_shared_entry: false,
    max_tunnels: policy.max_tunnels ?? null, max_nodes: null, max_members: null,
    traffic_limit: null, traffic_period: policy.traffic_period ?? "total",
    bandwidth_limit: null, client_limit: null, ip_limit: null, whitelist_ips: null,
  },
}));
mock.module(root + "src/db.ts", () => ({
  db: {
    workspacePolicyAssignment: { findMany: async () => rows() },
    capabilityPolicy: { findMany: async () => ceilings },
  },
}));

const { getEffectivePolicy, invalidatePolicyCache } = await import(root + "src/services/policy-service.ts");

const WS = 7;
const TTL = 50; // 与场景里设置的 POLICY_CACHE_TTL_MS 一致
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MONTH = { id: 1, key: "m", traffic_period: "month" };

// ── ① 正常缓存命中：TTL 内不重算 ──
invalidatePolicyCache();
assignments = [MONTH];
const first = await getEffectivePolicy(WS, { now: new Date() });
expect(first.limits.traffic_period).toBe("month");
assignments = [];                              // 库里已经没有发放了
const cached = await getEffectivePolicy(WS, { now: new Date() });
expect(cached.deny_scope).toBe(false);         // 仍然命中缓存（TTL 内）
expect(cached.limits.traffic_period).toBe("month");

// ── ② TTL 到期（按**墙钟**）：重算并看到真相 ──
await sleep(TTL + 30);
const afterTtl = await getEffectivePolicy(WS, { now: new Date() });
expect(afterTtl.deny_scope).toBe(true);        // 现在只剩"没有发放"这个事实

// ── ③ 关键回归：按**未来时刻**重算不得污染缓存 ──
// 修前：这次调用会以 at = 未来 写缓存，随后任何调用方（哪怕是"现在"）都会命中它 ——
// 因为它算出来的是"未来那一刻"的策略（这里：有 month 授予），且 now - at 恒为负。
invalidatePolicyCache();
assignments = [MONTH];
const FUTURE = new Date(Date.now() + 10 * 86400000);
const futureView = await getEffectivePolicy(WS, { now: FUTURE, noCache: true });   // 判定侧路径
expect(futureView.limits.traffic_period).toBe("month");
assignments = [];                               // 未来视角之后，现实里发放已被撤销
await sleep(TTL + 30);                          // 即使按墙钟也算"过期"
const realNow = await getEffectivePolicy(WS, { now: new Date() });
expect(realNow.deny_scope).toBe(true);          // 修前这里是 false（命中了未来那条缓存）

// ── ④ noCache: true 不读缓存：同一个 TTL 窗口内两次调用各自看到当时的真相 ──
invalidatePolicyCache();
assignments = [MONTH];
const t1 = await getEffectivePolicy(WS, { now: new Date() });
expect(t1.limits.traffic_period).toBe("month");
assignments = [];
const t2 = await getEffectivePolicy(WS, { now: new Date(), noCache: true });
expect(t2.deny_scope).toBe(true);               // 不吃缓存（否则会拿到上面的 month 视图）
const t3 = await getEffectivePolicy(WS, { now: new Date() });
expect(t3.limits.traffic_period).toBe("month"); // 而 ③/④ 都**没有**把缓存改写成 deny 视图

console.log("CACHE TIME CHECKS OK");
`;

test("策略缓存：noCache 不写、TTL 按墙钟（未来时刻不得污染展示路径）", () => {
  const result = spawnSync(process.execPath, ["-e", scenario], {
    cwd: root,
    env: {
      ...process.env,
      TUNEX_CACHE_ROOT: root,
      // 模块在 import 期读这个值 ⇒ 必须在 import 之前设好（子进程环境里给）
      POLICY_CACHE_TTL_MS: "50",
      DATABASE_URL: process.env.DATABASE_URL ?? "mysql://tunex-test:tunex-test@127.0.0.1:3306/tunex_test_unused", // secret-scan:allow — local test fixture
      REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15",
      AUTH_SECRET: process.env.AUTH_SECRET ?? "tunex-unit-test-auth-secret-not-a-real-secret", // secret-scan:allow — local test fixture
      LICENSE_SECRET: process.env.LICENSE_SECRET ?? "tunex-unit-test-license-secret-not-a-real-secret", // secret-scan:allow — local test fixture
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  expect(result.stdout).toContain("CACHE TIME CHECKS OK");
});
