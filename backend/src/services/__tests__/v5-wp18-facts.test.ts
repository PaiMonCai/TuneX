/**
 * V5-WP18.1 —— 通知派生纯函数核心（`services/notification-facts.ts`）。
 *
 * 覆盖的行为（全部离线：注入内存替身 + 注入时钟，不碰 DB / Redis / 网络）：
 *   A. 确定性（DoD1）：同一输入两次派生逐字段一致，含 `dedupe_key`。
 *   B. 幂等键（F4.2 / R2）：五段组成里任何一段变化都必须换键；同一时间窗内稳定，
 *      跨窗换键；`window_start` 是 epoch 对齐的固定桶。
 *   C. 静默期数值（O2 裁决）：节点离线 5min / 下发被拒 15min / 其余 30min，且只有一处表。
 *   D. fail-closed（C3 / DoD4）：未知来源、未实现来源、缺 source_id、未知原因码、
 *      坏严重度、坏作用域、坏时间戳 —— 七种拒绝各有用例。
 *   E. **不新造原因码**：源码扫描 `attention.ts` 的原因码联合类型，与运行期白名单**集合相等**。
 *   F. **不重新判定 / 不重新评级**：喂真实 `collectAttention` 的结论，逐条断言
 *      `reason_code` 与 `severity` 原样透传（F8 强化断言的可执行形式：维护中的节点
 *      必须得到 `node_in_maintenance`，而不是被通知层改写成「离线故障」）。
 *   G. 静态守卫：本模块不 import db/redis/网络、不出现在线窗口等第二判定常量。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp18-facts.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { collectAttention, type AttentionItem, type AttentionPayload } from "../attention.ts";
import { CONNECTION_ONLINE_WINDOW_MS } from "../node-lifecycle.ts";
import {
  DEFAULT_NOTIFICATION_COOLDOWN_SECONDS,
  DERIVABLE_SOURCE_KINDS,
  NOTIFICATION_COOLDOWN_SECONDS,
  NOTIFICATION_REASON_CODES,
  NOTIFICATION_SOURCE_KINDS,
  buildNotificationFact,
  cooldownSecondsForReason,
  deriveNotificationFacts,
  isNotificationScope,
  notificationCooldownKey,
  notificationDedupeKey,
  notificationScopeKey,
  notificationWindowStartMs,
  platformNotificationScope,
  workspaceNotificationScope,
  type NotificationFactSeed,
  type NotificationRejectionReason,
  type NotificationScope,
} from "../notification-facts.ts";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const OCCURRED = new Date("2026-01-01T11:58:00.000Z");
const WS = workspaceNotificationScope(7);

/* ------------------------------------------------------------------ */
/* A. 确定性                                                           */
/* ------------------------------------------------------------------ */

function item(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    kind: "node",
    id: 11,
    name: "hk-in-01",
    severity: "warning",
    reason_code: "connection_offline",
    retryable: null,
    ...over,
  };
}

function seed(over: Partial<NotificationFactSeed> = {}): NotificationFactSeed {
  return { item: item(), occurred_at: OCCURRED, ...over };
}

function factsOf(seeds: NotificationFactSeed[], scope: NotificationScope = WS) {
  return deriveNotificationFacts({ scope, seeds });
}

describe("A. 派生的确定性（DoD1）", () => {
  test("同一输入两次派生逐字段一致（含 dedupe_key）", () => {
    const seeds = [
      seed(),
      seed({ item: item({ kind: "forward", id: 3, name: "fwd-a", severity: "error", reason_code: "forward_apply_error", apply_error_code: "no_capacity", retryable: false }), occurred_at: new Date("2026-01-01T11:40:00.000Z") }),
    ];
    const first = factsOf(seeds);
    const second = factsOf(seeds);
    expect(first.rejected).toEqual([]);
    expect(first.facts).toEqual(second.facts);
    // 逐字段点名（不是只看 deep equal 通过了）——契约 F1 的每一列都要确定。
    expect(first.facts[0]).toEqual({
      scope: { kind: "workspace", workspace_id: 7 },
      source_kind: "node",
      source_id: "11",
      reason_code: "connection_offline",
      severity: "warning",
      resource_type: "node",
      resource_id: "11",
      resource_name: "hk-in-01",
      occurred_at: "2026-01-01T11:58:00.000Z",
      window_start: "2026-01-01T11:55:00.000Z",
      dedupe_key: first.facts[0]!.dedupe_key,
      detail_code: null,
    });
    expect(first.facts[0]!.dedupe_key).toMatch(/^[0-9a-f]{64}$/);
    // 输出顺序 = 输入顺序（attention 已确定性排序，本层不引入第二套顺序口径）。
    expect(first.facts.map((f) => f.source_id)).toEqual(["11", "3"]);
  });

  test("发生时刻来自**来源表**：同一事实换扫描时刻不换键（若用 now 分桶，静默期会被绕过）", () => {
    const a = factsOf([seed()]).facts[0]!;
    const b = factsOf([seed()]).facts[0]!;
    expect(a.dedupe_key).toBe(b.dedupe_key);
    expect(a.window_start).toBe(b.window_start);
  });

  test("detail_code 取既有诊断码，且不进幂等键（F4.2 的键组成写死为五段）", () => {
    const plain = factsOf([seed({ item: item({ kind: "forward", reason_code: "forward_apply_error" }) })]).facts[0]!;
    const detailed = factsOf([
      seed({ item: item({ kind: "forward", reason_code: "forward_apply_error", apply_error_code: "no_capacity" }) }),
    ]).facts[0]!;
    expect(plain.detail_code).toBeNull();
    expect(detailed.detail_code).toBe("no_capacity");
    expect(detailed.dedupe_key).toBe(plain.dedupe_key);
  });

  test("resource_type 用既有表名（Forward 落库在 tunnel），且与 source_id 分开承载", () => {
    const node = factsOf([seed()]).facts[0]!;
    const forward = factsOf([seed({ item: item({ kind: "forward", id: 3, reason_code: "forward_apply_error" }) })]).facts[0]!;
    expect(node.resource_type).toBe("node");
    expect(forward.resource_type).toBe("tunnel");
    expect(forward.source_id).toBe("3");
  });
});

/* ------------------------------------------------------------------ */
/* B. 幂等键                                                           */
/* ------------------------------------------------------------------ */

describe("B. 幂等键（F4.2 / R2）", () => {
  const base = { scope: WS, source_kind: "node", source_id: "11", reason_code: "connection_offline", window_start_ms: 1_767_267_300_000 };

  test("五段里任何一段变化都必须换键", () => {
    const key = notificationDedupeKey(base);
    expect(notificationDedupeKey({ ...base, scope: workspaceNotificationScope(8) })).not.toBe(key);
    expect(notificationDedupeKey({ ...base, scope: platformNotificationScope() })).not.toBe(key);
    expect(notificationDedupeKey({ ...base, source_kind: "forward" })).not.toBe(key);
    expect(notificationDedupeKey({ ...base, source_id: "12" })).not.toBe(key);
    expect(notificationDedupeKey({ ...base, reason_code: "node_in_maintenance" })).not.toBe(key);
    expect(notificationDedupeKey({ ...base, window_start_ms: base.window_start_ms + 300_000 })).not.toBe(key);
  });

  test("段边界无法被业务值伪造（含冒号的 id 不会撞上另一条事实）", () => {
    // JSON 数组编码：`a:b` / `c` 与 `a` / `b:c` 必须得到不同的键（分隔符拼接会撞）。
    const left = notificationDedupeKey({ ...base, source_id: "a:b", reason_code: "c" });
    const right = notificationDedupeKey({ ...base, source_id: "a", reason_code: "b:c" });
    expect(left).not.toBe(right);
  });

  test("window_start 是 epoch 对齐的固定桶：窗内稳定、跨窗换键", () => {
    const cooldown = NOTIFICATION_COOLDOWN_SECONDS.connection_offline;
    const windowMs = cooldown * 1_000;
    const inside = notificationWindowStartMs(OCCURRED.getTime(), cooldown);
    expect(inside).toBe(Date.UTC(2026, 0, 1, 11, 55, 0));
    const laterInside = notificationWindowStartMs(inside + windowMs - 1, cooldown);
    const nextWindow = notificationWindowStartMs(inside + windowMs, cooldown);
    expect(laterInside).toBe(inside);
    expect(nextWindow - inside).toBe(windowMs);

    // 事实层：**同一个桶内**两次派生同键，跨桶派生换键（DoD3 的一半；Redis 静默期在 18.2）。
    const sameWindow = factsOf([seed({ occurred_at: new Date(inside + windowMs - 1_000) })]).facts[0]!;
    const nextBucket = factsOf([seed({ occurred_at: new Date(inside + windowMs) })]).facts[0]!;
    expect(sameWindow.dedupe_key).toBe(factsOf([seed()]).facts[0]!.dedupe_key);
    expect(nextBucket.dedupe_key).not.toBe(sameWindow.dedupe_key);
  });

  test("静默期键按 (scope, source_kind, source_id, reason_code) —— 不同原因码互不吞掉", () => {
    const offline = factsOf([seed()]).facts[0]!;
    const behind = factsOf([seed({ item: item({ reason_code: "runtime_revision_behind" }) })]).facts[0]!;
    const otherNode = factsOf([seed({ item: item({ id: 12 }) })]).facts[0]!;
    // 键带**渠道**（WP18.5 修：不带渠道会让同一事实的第 2 个渠道被静默掉，见该函数注释）。
    expect(notificationCooldownKey(offline, "email")).toBe(
      "ws:7:notification:cooldown:node:11:connection_offline:email",
    );
    expect(notificationCooldownKey(behind, "email")).not.toBe(notificationCooldownKey(offline, "email"));
    expect(notificationCooldownKey(otherNode, "email")).not.toBe(notificationCooldownKey(offline, "email"));
    // 同一事实、不同渠道 = **两条配额**（F3 每渠道各自一条记录；用户靠静音渠道少收通知）。
    expect(notificationCooldownKey(offline, "telegram")).not.toBe(notificationCooldownKey(offline, "email"));
    // 平台级事实落 ws:global，不落进任何租户的键域。
    const platform = factsOf([seed()], platformNotificationScope()).facts[0]!;
    expect(notificationCooldownKey(platform, "email")).toBe(
      "ws:global:notification:cooldown:node:11:connection_offline:email",
    );
  });
});

/* ------------------------------------------------------------------ */
/* B'. 类型与值一致：输出侧 string / 输入侧 Date（Lead 2026-10-05 反馈） */
/* ------------------------------------------------------------------ */

describe("B'. `occurred_at` 的两侧类型：输出**字符串**、输入 **Date**（同名不同型，钉死）", () => {
  test("事实侧是 ISO 字符串，不是 Date（写 `.getTime()` 会 TypeError）", () => {
    const fact = factsOf([seed()]).facts[0]!;
    expect(typeof fact.occurred_at).toBe("string");
    expect(typeof fact.window_start).toBe("string");
    expect(fact.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 字符串能被边界层安全地转回来（这正是调用方该用的方式）。
    expect(new Date(fact.occurred_at).getTime()).toBe(OCCURRED.getTime());
    // 断言 `Date` 方法在这里**不存在**：写错时立刻红，而不是等到运行期崩。
    expect((fact.occurred_at as unknown as Date).getTime).toBeUndefined();
  });

  test("种子侧必须是 Date：传字符串 ⇒ `invalid_occurred_at`（fail-closed，不猜）", () => {
    const bad = buildNotificationFact(workspaceNotificationScope(7), {
      item: item(),
      // 故意传"看起来一样"的 ISO 串：这是最容易犯的错（两侧同名）。
      occurred_at: "2026-01-01T11:58:00.000Z" as unknown as Date,
    });
    expect(bad).toEqual({ ok: false, reason: "invalid_occurred_at" });
  });
});

/* ------------------------------------------------------------------ */
/* C. 静默期数值（O2 裁决）                                             */
/* ------------------------------------------------------------------ */

describe("C. 静默期数值集中在一处（R1 / O2）", () => {
  test("节点离线 5min / 下发被拒 15min / 其余 30min", () => {
    expect(cooldownSecondsForReason("connection_offline")).toBe(300);
    expect(cooldownSecondsForReason("forward_apply_error")).toBe(900);
    expect(cooldownSecondsForReason("runtime_revision_behind")).toBe(DEFAULT_NOTIFICATION_COOLDOWN_SECONDS);
    expect(cooldownSecondsForReason("node_in_maintenance")).toBe(DEFAULT_NOTIFICATION_COOLDOWN_SECONDS);
    expect(DEFAULT_NOTIFICATION_COOLDOWN_SECONDS).toBe(1_800);
    // 未列表里没有的码：不猜，回落默认值（仍能算出一个可用的键）。
    expect(cooldownSecondsForReason("some_future_code")).toBe(DEFAULT_NOTIFICATION_COOLDOWN_SECONDS);
    // 表里每一项都必须覆盖一个词表内的码（否则就是一条永远不会生效的配置）。
    for (const code of Object.keys(NOTIFICATION_COOLDOWN_SECONDS)) {
      expect(NOTIFICATION_REASON_CODES as readonly string[]).toContain(code);
    }
  });
});

/* ------------------------------------------------------------------ */
/* D. fail-closed 反例（C3 / DoD4）                                     */
/* ------------------------------------------------------------------ */

describe("D. fail-closed：坏种子既不投递也不静默", () => {
  const cases: Array<[string, AttentionItem, NotificationRejectionReason]> = [
    ["未知 source_kind", item({ kind: "nodes" as unknown as AttentionItem["kind"] }), "unknown_source_kind"],
    ["尚无派生实现的来源", item({ kind: "announcement" as unknown as AttentionItem["kind"] }), "source_kind_not_derivable"],
    ["缺 source_id（0 / 非整数）", item({ id: 0 }), "missing_source_id"],
    ["source_id 不是数字", item({ id: 1.5 }), "missing_source_id"],
    ["未知原因码", item({ reason_code: "node_deleted" as unknown as AttentionItem["reason_code"] }), "unknown_reason_code"],
    ["未知严重度", item({ severity: "critical" as unknown as AttentionItem["severity"] }), "unknown_severity"],
  ];

  for (const [name, bad, reason] of cases) {
    test(`${name} → ${reason}`, () => {
      const out = factsOf([seed({ item: bad })]);
      expect(out.facts).toEqual([]);
      expect(out.rejected).toEqual([{ index: 0, reason }]);
    });
  }

  test("坏作用域 → invalid_scope（platform 不得带 workspace_id）", () => {
    const bad = { kind: "platform", workspace_id: 7 } as unknown as NotificationScope;
    expect(isNotificationScope(bad)).toBe(false);
    const out = deriveNotificationFacts({ scope: bad, seeds: [seed()] });
    expect(out.facts).toEqual([]);
    expect(out.rejected).toEqual([{ index: 0, reason: "invalid_scope" }]);
    expect(isNotificationScope({ kind: "workspace", workspace_id: 0 })).toBe(false);
    expect(isNotificationScope(platformNotificationScope())).toBe(true);
    expect(isNotificationScope(WS)).toBe(true);
  });

  test("坏时间戳 → invalid_occurred_at", () => {
    const out = factsOf([seed({ occurred_at: new Date("nope") })]);
    expect(out.rejected).toEqual([{ index: 0, reason: "invalid_occurred_at" }]);
    const notADate = factsOf([seed({ occurred_at: "2026-01-01" as unknown as Date })]);
    expect(notADate.rejected).toEqual([{ index: 0, reason: "invalid_occurred_at" }]);
  });

  test("坏种子不阻断好种子，且拒绝项带输入下标", () => {
    const out = factsOf([seed(), seed({ item: item({ id: 0 }) }), seed({ item: item({ id: 13 }) })]);
    expect(out.facts.map((f) => f.source_id)).toEqual(["11", "13"]);
    expect(out.rejected).toEqual([{ index: 1, reason: "missing_source_id" }]);
  });

  test("作用域工厂拒绝非正整数（拼错的 id 不能悄悄变成平台级通知）", () => {
    expect(() => workspaceNotificationScope(0)).toThrow();
    expect(() => workspaceNotificationScope(-1)).toThrow();
    expect(() => workspaceNotificationScope(1.5)).toThrow();
    expect(notificationScopeKey(WS)).toBe("ws:7");
    expect(notificationScopeKey(platformNotificationScope())).toBe("ws:global");
  });

  test("单条派生也走同一条拒绝通道（buildNotificationFact）", () => {
    const bad = buildNotificationFact(WS, seed({ item: item({ reason_code: "unknown" as unknown as AttentionItem["reason_code"] }) }));
    expect(bad).toEqual({ ok: false, reason: "unknown_reason_code" });
    const good = buildNotificationFact(WS, seed());
    expect(good.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* E. 词表同源（不新造原因码）                                          */
/* ------------------------------------------------------------------ */

describe("E. 原因码只读消费 attention 的词表", () => {
  test("运行期白名单与 attention.ts 的联合类型集合相等（源码扫描，双向）", () => {
    const raw = readFileSync(new URL("../attention.ts", import.meta.url), "utf8");
    const block = /export type AttentionReasonCode =([\s\S]*?);/.exec(raw);
    expect(block).not.toBeNull();
    const declared = [...block![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(0);
    expect([...NOTIFICATION_REASON_CODES].sort() as string[]).toEqual([...declared].sort());
  });

  test("来源枚举是闭集，且 N1/N2 之外没有派生实现", () => {
    expect([...NOTIFICATION_SOURCE_KINDS]).toEqual([
      "node",
      "forward",
      "reconcile_finding",
      "workspace_event",
      "federation_event",
      "announcement",
    ]);
    expect([...DERIVABLE_SOURCE_KINDS]).toEqual(["node", "forward"]);
  });
});

/* ------------------------------------------------------------------ */
/* F. 与既有判定链一致（F8 强化断言的可执行形式）                       */
/* ------------------------------------------------------------------ */

const stale = new Date(NOW.getTime() - CONNECTION_ONLINE_WINDOW_MS - 1_000);

interface FakeNode {
  id: number;
  node_id: string;
  status?: string | null;
  lifecycle?: string | null;
  last_seen_at?: Date | null;
  node_credential_hash?: string | null;
  credential_revoked?: boolean;
}

interface FakeForward {
  id: number;
  name: string;
  apply_status?: string | null;
  apply_error_code?: string | null;
  config_revision?: number | null;
  applied_revision?: number | null;
  updated_at?: Date | null;
}

function fakeDb(nodes: FakeNode[], forwards: FakeForward[]) {
  return {
    node: { async findMany() { return nodes; } },
    tunnel: { async findMany() { return forwards; } },
  };
}

/** 把**真实** `collectAttention` 的结论（判定仍然只有一份）交给本层派生。 */
function deriveFromAttention(payload: AttentionPayload, scope: NotificationScope = WS) {
  return deriveNotificationFacts({
    scope,
    seeds: payload.items.map((it) => ({
      item: it,
      occurred_at: it.kind === "node" ? OCCURRED : new Date("2026-01-01T11:40:00.000Z"),
    })),
  });
}

const NODE_ROWS: FakeNode[] = [
  // 维护中且掉线：**预期行为**，必须得到 node_in_maintenance。
  { id: 21, node_id: "hk-maint", status: "inactive", lifecycle: "maintenance", last_seen_at: stale, node_credential_hash: "a".repeat(64) },
  // 掉线：连接故障。
  { id: 22, node_id: "hk-off", status: "inactive", lifecycle: "active", last_seen_at: stale, node_credential_hash: "a".repeat(64) },
  // 健康：不得产生任何通知。
  { id: 23, node_id: "hk-ok", status: "active", lifecycle: "active", last_seen_at: new Date(NOW.getTime() - 5_000), node_credential_hash: "a".repeat(64) },
];

const FORWARD_ROWS: FakeForward[] = [
  { id: 31, name: "fwd-denied", apply_status: "error", apply_error_code: "no_capacity", config_revision: 3, applied_revision: 2, updated_at: new Date("2026-01-01T11:40:00.000Z") },
  { id: 32, name: "fwd-ok", apply_status: "active", apply_error_code: null, config_revision: 2, applied_revision: 2, updated_at: OCCURRED },
];

describe("F. 通知的 reason_code / severity 原样透传既有判定（F8）", () => {
  test("维护中的掉线节点 → node_in_maintenance（不是「离线故障」）；健康节点不产生通知", async () => {
    const payload = await collectAttention(7, { db: fakeDb(NODE_ROWS, FORWARD_ROWS), now: () => NOW, isRetryable: () => true });
    const attentionCodes = payload.items.map((i) => `${i.kind}:${i.id}:${i.reason_code}`).sort();

    const { facts, rejected } = deriveFromAttention(payload);
    expect(rejected).toEqual([]);
    expect(facts.map((f) => `${f.source_kind}:${Number(f.source_id)}:${f.reason_code}`).sort()).toEqual(attentionCodes);

    const byId = new Map(facts.map((f) => [f.source_id, f]));
    expect(byId.get("21")!.reason_code).toBe("node_in_maintenance");
    expect(byId.get("22")!.reason_code).toBe("connection_offline");
    expect(byId.get("31")!.reason_code).toBe("forward_apply_error");
    expect(byId.get("31")!.detail_code).toBe("no_capacity");
    expect(byId.has("23")).toBe(false);
    expect(byId.has("32")).toBe(false);
  });

  test("severity 直传（通知层不重新评级）", async () => {
    const payload = await collectAttention(7, { db: fakeDb(NODE_ROWS, FORWARD_ROWS), now: () => NOW, isRetryable: () => true });
    const { facts } = deriveFromAttention(payload);
    const severities = new Map(payload.items.map((i) => [String(i.id), i.severity]));
    for (const fact of facts) {
      expect(fact.severity).toBe(severities.get(fact.source_id)!);
    }
    // 具体口径钉一遍：离线 = warning，下发被拒 = error（都来自 attention，不是本层选的）。
    expect(facts.find((f) => f.source_id === "22")!.severity).toBe("warning");
    expect(facts.find((f) => f.source_id === "31")!.severity).toBe("error");
  });
});

/* ------------------------------------------------------------------ */
/* G. 静态守卫：纯函数、不复制判定                                      */
/* ------------------------------------------------------------------ */

describe("G. 静态守卫", () => {
  const raw = readFileSync(new URL("../notification-facts.ts", import.meta.url), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  test("不 import db / redis / 网络（纯函数，可在无依赖环境断言）", () => {
    expect(code).not.toMatch(/from "\.\.\/db\.ts"/);
    expect(code).not.toMatch(/from "\.\.\/redis\.ts"/);
    expect(code).not.toMatch(/from "node:(net|tls|http|https)"/);
    expect(code).not.toMatch(/\b(?:ioredis|PrismaClient)\b/);
  });

  test("不出现第二套连接判定（在线窗口 / status 比较 / deriveConnection 直调）", () => {
    expect(code).not.toMatch(/90_000|90000/);
    expect(code).not.toMatch(/status\s*===\s*"active"/);
    expect(code).not.toMatch(/CONNECTION_ONLINE_WINDOW/);
    expect(code).not.toMatch(/deriveConnection\s*\(/);
  });

  test("静默期数值只在这一处（且是抑制窗口，不是在线阈值）", () => {
    // 负向后顾：不能把 `DEFAULT_NOTIFICATION_COOLDOWN_SECONDS` 也数进来。
    expect(code.match(/(?<![_A-Za-z])NOTIFICATION_COOLDOWN_SECONDS\s*=/g)).toHaveLength(1);
    expect(code.match(/(?<![_A-Za-z])DEFAULT_NOTIFICATION_COOLDOWN_SECONDS\s*=/g)).toHaveLength(1);
  });
});
