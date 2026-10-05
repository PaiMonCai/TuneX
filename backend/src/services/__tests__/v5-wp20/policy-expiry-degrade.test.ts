/**
 * V5-WP20-5 到期降级与可观测 —— 单元测试（离线，全部走**纯函数**）。
 *
 * 契约：`docs/v5-wp20-subscription-billing-runtime-contract.md` §3.2（到期转终态：
 * **不引入状态机、不引入翻转任务**，到期只是 `expires_at` 上的时间比较）、§3.3.2/§4.0（`traffic_used`
 * 冻结）、**DoD 第 6 条**（到期语义可证）。
 *
 * 这一文件要证明的三件事（顺序就是用户实际经历的三种状态）：
 *   ① **宽限内**：一条有效发放都没有、但仍有在宽限期内的已到期发放 ⇒ 仍然放行，
 *      `grace_policies` 非空 + `deny_reason="policy_expired"`；
 *   ② **自动降级**：`purchase` 发放过期而 `system_default` 还在 ⇒ 权限收窄到剩下的那份
 *      （并集自然收窄），`deny_scope=false`、`deny_reason=null` —— **不需要任何新代码**；
 *   ③ **fail-closed**：越过宽限期且一条有效发放都没有 ⇒ `deny_scope=true`。
 * 外加可观测投影 `buildUsageExpiryView`（含复用 `describeDeny` 的文案）。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp20/policy-expiry-degrade.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  composeEffectivePolicy,
  describeDeny,
  type ComposeInput,
  type PolicyRecord,
} from "../../capability-policy.ts";
import { buildUsageExpiryView } from "../../policy-service.ts";

const NOW = new Date("2026-10-05T05:30:00.000Z");
/** 与 `policy-service.ts` 的 `POLICY_GRACE_MS` 默认值一致（3 天）。 */
const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** 造一条策略（只填判定用得上的字段）。 */
function policy(over: Partial<PolicyRecord> & { id: number; key: string }): PolicyRecord {
  return {
    id: over.id,
    key: over.key,
    name: over.name ?? over.key,
    source: over.source ?? "purchase",
    applies_to: over.applies_to ?? null,
    is_ceiling: over.is_ceiling ?? false,
    status: over.status ?? "active",
    revision: over.revision ?? 1,
    tunnel_types: over.tunnel_types ?? ["tcp"],
    allow_custom_in_group: over.allow_custom_in_group ?? false,
    allow_custom_out_group: over.allow_custom_out_group ?? false,
    allowed_in_group_ids: over.allowed_in_group_ids ?? null,
    allowed_out_group_ids: over.allowed_out_group_ids ?? null,
    allow_shared_entry: over.allow_shared_entry ?? false,
    max_tunnels: over.max_tunnels ?? null,
    max_nodes: over.max_nodes ?? null,
    max_members: over.max_members ?? null,
    traffic_limit: over.traffic_limit ?? null,
    traffic_period: over.traffic_period ?? "total",
    bandwidth_limit: over.bandwidth_limit ?? null,
    client_limit: over.client_limit ?? null,
    ip_limit: over.ip_limit ?? null,
    whitelist_ips: over.whitelist_ips ?? null,
  };
}

/** 一份「买了就比免费额度大」的对照：purchase 更宽，system_default 更窄。 */
const PURCHASE = policy({
  id: 10,
  key: "pro_monthly",
  source: "purchase",
  tunnel_types: ["tcp", "udp"],
  max_tunnels: 10,
  traffic_limit: 100_000,
  traffic_period: "month",
});
const DEFAULT = policy({
  id: 1,
  key: "free_personal",
  source: "system_default",
  tunnel_types: ["tcp"],
  max_tunnels: 1,
  traffic_limit: 1_000,
  traffic_period: "month",
});

function compose(assignments: ComposeInput["assignments"], now = NOW) {
  return composeEffectivePolicy({ workspace_id: 7, now, graceMs: GRACE_MS, assignments });
}

/** 造一条发放（`PolicyAssignment` 形状：note 是必填字段，置 null 表示无备注）。 */
const assign = (
  p: PolicyRecord,
  expires_at: Date | null,
  over: { revoked_at?: Date | null; effective_at?: Date } = {},
) => ({
  policy: p,
  source: p.source,
  effective_at: over.effective_at ?? new Date(NOW.getTime() - 30 * DAY),
  expires_at,
  revoked_at: over.revoked_at ?? null,
  note: null,
});

// ─────────────────────────── A. ① 宽限内：仍放行但已到期 ───────────────────────────

describe("A. 宽限内（DoD 6 前半）：grace_policies 非空 + deny_reason=policy_expired + 仍放行", () => {
  test("只有 purchase、刚过期 1 小时 ⇒ 吃宽限，额度不变、deny_scope=false", () => {
    const expired = new Date(NOW.getTime() - 1 * HOUR);
    const composed = compose([assign(PURCHASE, expired)]);

    expect(composed.grace_policies).toEqual(["pro_monthly"]);
    expect(composed.deny_reason).toBe("policy_expired");
    expect(composed.deny_scope).toBe(false);
    // 宽限内**权限不缩水**：这正是 F3「宽限内仍放行」的可观测证据
    expect(composed.limits.max_tunnels).toBe(10);
    expect(composed.entitlements.tunnel_types.sort()).toEqual(["tcp", "udp"]);
    // 注意 `active_policies` 的语义：它是**当前有效**的发放集合 —— 宽限内的已到期发放
    // 也算「当前有效」（这正是宽限期内仍放行的实现方式），`grace_policies` 只是给它们打标记。
    expect(composed.active_policies.map((p) => p.key)).toEqual(["pro_monthly"]);
    expect(composed.active_policies[0]!.expires_at).toBe(expired.toISOString());
    expect(composed.grace_expires_at).not.toBeNull();
  });

  test("宽限窗口终点 = 已到期发放的到期点（过它就 fail-closed）", () => {
    const expired = new Date(NOW.getTime() - 1 * HOUR);
    const composed = compose([assign(PURCHASE, expired)]);
    expect(composed.grace_expires_at).toBe(expired.toISOString());
  });

  test("反例守卫：还有一条**有效**发放时不吃宽限（宽限只在该工作空间一条都不剩时启用）", () => {
    const expired = new Date(NOW.getTime() - 1 * HOUR);
    const composed = compose([assign(PURCHASE, expired), assign(DEFAULT, null)]);
    expect(composed.grace_policies).toEqual([]);
    expect(composed.grace_expires_at).toBeNull();
    expect(composed.deny_reason).toBeNull();
  });
});

// ─────────────────────────── B. ② 自动降级：并集自然收窄 ───────────────────────────

describe("B. 自动降级（§3.2.2 ① / DoD 6 后半）：purchase 失效后收窄到剩下的发放，不需要新代码", () => {
  test("过期前 = 并集（10 条 / 2 协议）；过期后 = 只剩 system_default（1 条 / tcp）", () => {
    const future = new Date(NOW.getTime() + 10 * DAY);
    const before = compose([assign(PURCHASE, future), assign(DEFAULT, null)]);
    const after = compose([assign(PURCHASE, new Date(NOW.getTime() - 1 * HOUR)), assign(DEFAULT, null)]);

    // 基线：并集取各授予的较大值
    expect(before.limits.max_tunnels).toBe(10);
    expect(before.limits.traffic_limit).toBe(100_000);
    expect(before.entitlements.tunnel_types.sort()).toEqual(["tcp", "udp"]);
    expect(before.deny_reason).toBeNull();

    // 降级：**没有新状态机、没有翻转任务**，只是那条发放不再参与合成
    expect(after.limits.max_tunnels).toBe(1);
    expect(after.limits.traffic_limit).toBe(1_000);
    expect(after.entitlements.tunnel_types).toEqual(["tcp"]);
    expect(after.deny_scope).toBe(false);
    expect(after.deny_reason).toBeNull();
    expect(after.active_policies.map((p) => p.key)).toEqual(["free_personal"]);
  });

  test("降级是**单调收窄**：额度只会变小或持平（不会因为一条过期而变大）", () => {
    const future = new Date(NOW.getTime() + 10 * DAY);
    const before = compose([assign(PURCHASE, future), assign(DEFAULT, null)]);
    const after = compose([assign(PURCHASE, new Date(NOW.getTime() - 1 * HOUR)), assign(DEFAULT, null)]);
    expect(after.limits.max_tunnels!).toBeLessThanOrEqual(before.limits.max_tunnels!);
    expect(after.limits.traffic_limit!).toBeLessThanOrEqual(before.limits.traffic_limit!);
    expect(after.entitlements.tunnel_types.length).toBeLessThanOrEqual(before.entitlements.tunnel_types.length);
  });

  test("宽限期不影响降级判定顺序：先看有没有有效发放，再谈宽限", () => {
    // purchase 刚过期 + system_default 有效 ⇒ 直接降级，**不进宽限**（宽限不是"叠加一层"）
    const composed = compose([assign(PURCHASE, new Date(NOW.getTime() - HOUR)), assign(DEFAULT, null)]);
    expect(composed.grace_policies).toEqual([]);
    expect(composed.limits.max_tunnels).toBe(1);
  });
});

// ─────────────────────────── C. ③ fail-closed：宽限过后一条都不剩 ───────────────────────────

describe("C. fail-closed（§3.2.2 ③）：越过宽限期且无任何有效发放 ⇒ deny_scope", () => {
  test("过期超过宽限期（无其它发放）⇒ deny_scope=true + no_active_policy", () => {
    const composed = compose([assign(PURCHASE, new Date(NOW.getTime() - GRACE_MS - HOUR))]);
    expect(composed.deny_scope).toBe(true);
    expect(composed.deny_reason).toBe("no_active_policy");
    expect(composed.grace_policies).toEqual([]);
    expect(composed.active_policies).toEqual([]);
  });

  test("宽限边界：窗口内 1ms vs 窗口外 1ms（边界即契约）", () => {
    const inside = compose([assign(PURCHASE, new Date(NOW.getTime() - GRACE_MS + 1))]);
    const outside = compose([assign(PURCHASE, new Date(NOW.getTime() - GRACE_MS - 1))]);
    expect(inside.deny_scope).toBe(false);
    expect(inside.deny_reason).toBe("policy_expired");
    expect(outside.deny_scope).toBe(true);
  });

  test("显式撤销没有宽限期（§F3：revoked 立即生效）", () => {
    const composed = compose([assign(PURCHASE, new Date(NOW.getTime() + 10 * DAY), { revoked_at: new Date(NOW.getTime() - HOUR) })]);
    expect(composed.deny_scope).toBe(true);
    expect(composed.grace_policies).toEqual([]);
  });
});

// ─────────────────────────── D. 可观测投影（复用 describeDeny 文案） ───────────────────────────

describe("D. buildUsageExpiryView：到期/宽限的可观测投影（文案唯一实现 = describeDeny）", () => {
  test("有效发放：取**最早**到期点（不是最晚）", () => {
    const composed = compose([
      assign(PURCHASE, new Date(NOW.getTime() + 10 * DAY)),
      assign(DEFAULT, new Date(NOW.getTime() + 2 * DAY)),
    ]);
    const view = buildUsageExpiryView(composed);
    expect(view.policy_expires_at).toBe(new Date(NOW.getTime() + 2 * DAY).toISOString());
    expect(view.in_grace).toBe(false);
    expect(view.grace_expires_at).toBeNull();
    expect(view.deny_reason).toBeNull();
    expect(view.deny_message).toBeNull();
  });

  test("全部终身 ⇒ policy_expires_at = null（不是『很远的一天』）", () => {
    const view = buildUsageExpiryView(compose([assign(DEFAULT, null)]));
    expect(view.policy_expires_at).toBeNull();
    expect(view.deny_scope).toBe(false);
  });

  test("宽限内的 policy_expires_at 是**已经过去**的那个到期点（配合 in_grace 读成『已到期，宽限至 X』）", () => {
    const expired = new Date(NOW.getTime() - HOUR);
    const view = buildUsageExpiryView(compose([assign(PURCHASE, expired)]));
    expect(view.policy_expires_at).toBe(expired.toISOString());
    expect(view.in_grace).toBe(true);
    expect(view.grace_expires_at).toBe(expired.toISOString());
  });

  test("宽限内：in_grace=true、grace_expires_at 有值、deny_message 就是 describeDeny 的原文", () => {
    const view = buildUsageExpiryView(compose([assign(PURCHASE, new Date(NOW.getTime() - HOUR))]));
    expect(view.in_grace).toBe(true);
    expect(view.grace_expires_at).not.toBeNull();
    expect(view.deny_reason).toBe("policy_expired");
    expect(view.deny_message).toBe(describeDeny("policy_expired"));
    expect(view.deny_message).toContain("已到期");
  });

  test("fail-closed：deny_scope=true + 文案来自同一条 describeDeny", () => {
    const view = buildUsageExpiryView(compose([assign(PURCHASE, new Date(NOW.getTime() - GRACE_MS - HOUR))]));
    expect(view.deny_scope).toBe(true);
    expect(view.deny_reason).toBe("no_active_policy");
    expect(view.deny_message).toBe(describeDeny("no_active_policy"));
  });
});

// ─────────────────────────── E. 静态守卫：没有新状态机 / 字段落在真实端点上 ───────────────────────────

describe("E. 守卫：不新增状态机、文案只有一份、投影落在已挂载的端点上", () => {
  const ROOT = new URL("../../../", import.meta.url).pathname;

  test("到期仍然只是时间比较：没有新增 `*Status` 枚举、没有翻转任务的写入", () => {
    const schema = readFileSync(`${ROOT}../prisma/schema.prisma`, "utf8");
    const statusEnums = [...schema.matchAll(/^enum (\w*Status\w*) \{/gm)].map((m) => m[1]);
    expect(statusEnums).toEqual(["Status", "TopupOrderStatus", "WithdrawStatus", "TicketStatus"]);
    // 本 WP 的文件里不出现「把发放标成 expired」这类写入
    const policyService = readFileSync(`${ROOT}services/policy-service.ts`, "utf8");
    expect(policyService).not.toContain("status: \"expired\"");
    expect(policyService).not.toMatch(/AssignmentStatus/);
  });

  test("拒绝文案只有一份实现：投影复用 describeDeny，前端不自造中文", () => {
    const policyService = readFileSync(`${ROOT}services/policy-service.ts`, "utf8");
    expect(policyService).toContain("describeDeny(policy.deny_reason)");
    // 反例守卫：这里不该出现硬编码的中文拒绝文案（那样就成了第二份口径）
    expect(policyService).not.toContain("已到期，请管理员重新发放");
  });

  test("投影出现在两条真实读路径上：用量报告 + 仪表盘 /stats", () => {
    const policyService = readFileSync(`${ROOT}services/policy-service.ts`, "utf8");
    const dashboard = readFileSync(`${ROOT}routes/dashboard.ts`, "utf8");
    expect(policyService).toContain("expiry: buildUsageExpiryView(policy)");
    expect(dashboard).toContain("expiry: policyView ? buildUsageExpiryView(policyView) : null");
  });
});
