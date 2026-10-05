/**
 * V5-WP20-2 的**静态不变量**测试（读 `prisma/schema.prisma` 与迁移文本，不连 DB）。
 *
 * 为什么需要它：本 WP 的交付物是 schema + 迁移，而契约有两条硬不变量只能靠静态检查证明
 * （本环境没有 MySQL 可跑 `migrate deploy`，见契约 §8.6「不跑 Docker 门禁」）：
 *   · **DoD 第 7 条**：`enum .*Status` 数量不得增加 —— 订阅「有效」是时间比较，不是状态列（§8.1）；
 *   · 幂等闸门 `UNIQUE(plan_subscription_id, period_key)` 必须真的在（WP20-3 的接管续跑依赖它）。
 * 另外把「纯 additive」（无 DROP / 无 DELETE、`plan_order.workspace_id` 可空）钉成断言，
 * 防止后续 WP 顺手把 V4 基线改掉。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp20/schema-wp20.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const SCHEMA = readFileSync(new URL("../../../../prisma/schema.prisma", import.meta.url), "utf8");
const MIGRATIONS_DIR = new URL("../../../../prisma/migrations/", import.meta.url);
const MIGRATION_NAME = "20261031000000_v5_wp20_subscription_ledger";
const MIGRATION_PATH = new URL(`${MIGRATION_NAME}/migration.sql`, MIGRATIONS_DIR);
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");

/** WP20-1 之前就存在的 `*Status` 枚举全集（DoD 第 7 条的基准，逐字来自 git HEAD 的 schema）。 */
const PRE_EXISTING_STATUS_ENUMS = ["Status", "TopupOrderStatus", "WithdrawStatus", "TicketStatus"];
/** WP20-2 之前就存在的枚举总数（`grep -c "^enum " prisma/schema.prisma` = 30）。 */
const PRE_EXISTING_ENUM_COUNT = 30;

function modelBlock(name: string): string {
  const match = SCHEMA.match(new RegExp(`^model ${name} \\{[\\s\\S]*?^\\}`, "m"));
  if (!match) throw new Error(`schema.prisma 里找不到 model ${name}`);
  return match[0];
}

function enumNames(): string[] {
  return [...SCHEMA.matchAll(/^enum (\w+) \{/gm)].map((match) => match[1] ?? "");
}

/** 迁移 SQL 里被建出的表名（先剥掉 `--` 注释，避免注释里的示例被当成真语句）。 */
function createdTables(sql: string): string[] {
  return [...stripLineComments(sql).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?`(\w+)`/g)].map(
    (match) => match[1] ?? "",
  );
}

function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

describe("A. DoD 第 7 条：不新增状态机 / 不新增枚举", () => {
  test("枚举总数与 *Status 枚举集合都不变", () => {
    expect(enumNames().length).toBe(PRE_EXISTING_ENUM_COUNT);
    expect(enumNames().filter((name) => name.endsWith("Status"))).toEqual(PRE_EXISTING_STATUS_ENUMS);
  });

  test("订阅相关的状态列是 VARCHAR + 默认值，不是新枚举", () => {
    const settlement = modelBlock("SubscriptionPeriodSettlement");
    expect(settlement).toContain('state                String           @db.VarChar(16) @default("pending")');
    expect(settlement).not.toMatch(/state\s+\w*Status/);
    expect(SCHEMA).not.toContain("SubscriptionStatus");
    expect(SCHEMA).not.toContain("AssignmentStatus");
  });
});

describe("B. 归属：PlanSubscription 是 workspace 级唯一真相", () => {
  const subscription = modelBlock("PlanSubscription");

  test("workspace_id 唯一（一个租户至多一份订阅）", () => {
    expect(subscription).toMatch(/workspace_id\s+Int\s+@unique/);
    expect(subscription).toContain("@@map(\"plan_subscription\")");
  });

  test("auto_renew 默认 false（fail-closed，契约 §3.5.3）", () => {
    expect(subscription).toMatch(/auto_renew\s+Boolean\s+@default\(false\)/);
  });

  test("expires_at 可空（lifetime 套餐没有到期点）", () => {
    expect(subscription).toMatch(/expires_at\s+DateTime\?/);
  });

  test("快照只含商务口径，**不含**额度数字（§8.3 / F5：额度唯一真相是显式发放）", () => {
    expect(subscription).toContain("plan_name");
    expect(subscription).toContain("billing_cycle");
    expect(subscription).toContain("price");
    for (const forbidden of ["max_tunnels", "traffic_limit", "traffic ", "whitelist", "policy_id"]) {
      expect({ forbidden, hits: subscription.includes(forbidden) }).toEqual({ forbidden, hits: false });
    }
  });

  test("Workspace 侧有反向关系，且不引入 user 级归属列", () => {
    expect(modelBlock("Workspace")).toContain("plan_subscription PlanSubscription?");
    expect(subscription).not.toContain("user_id");
  });
});

describe("C. 幂等闸门：SubscriptionPeriodSettlement", () => {
  const settlement = modelBlock("SubscriptionPeriodSettlement");

  test("UNIQUE(plan_subscription_id, period_key) 存在（先占位后执行）", () => {
    expect(settlement).toContain("@@unique([plan_subscription_id, period_key])");
    expect(MIGRATION).toContain("UNIQUE INDEX `subscription_period_settlement_plan_subscription_id_period_k_key`(`plan_subscription_id`, `period_key`)");
  });

  test("接管续跑所需的字段与索引齐全（attempts / started_at / settled_at / error / order_id）", () => {
    // 用正则而不是逐字对齐的字符串：schema 里的列是对齐排版的，缩进变化不该让守卫失效
    const expected: [string, RegExp][] = [
      ["attempts", /attempts\s+Int\s+@default\(0\)/],
      ["started_at", /started_at\s+DateTime\s+@default\(now\(\)\)/],
      ["settled_at", /settled_at\s+DateTime\?/],
      ["error", /error\s+String\?\s+@db\.Text/],
      ["order_id", /order_id\s+Int\?/],
    ];
    for (const [field, pattern] of expected) {
      expect({ field, matches: pattern.test(settlement) }).toEqual({ field, matches: true });
    }
    expect(settlement).toContain("@@index([state, started_at])");
  });

  test("period_key 形状冻结为 VARCHAR(16)（YYYY-MM / YYYY-MM-DD）", () => {
    expect(settlement).toContain('period_key           String           @db.VarChar(16)');
    expect(MIGRATION).toContain("`period_key` VARCHAR(16) NOT NULL");
  });
});

describe("D. PlanOrder.workspace_id：可空，历史行 NULL 是合法历史（R5）", () => {
  test("schema 与迁移都是可空，且没有回填", () => {
    expect(modelBlock("PlanOrder")).toMatch(/workspace_id\s+Int\?/);
    expect(MIGRATION).toContain("ALTER TABLE `plan_order` ADD COLUMN `workspace_id` INTEGER NULL");
    expect(MIGRATION).not.toMatch(/UPDATE `plan_order`/);
  });
});

describe("E. UserPlan 冻结为 legacy 展示视图", () => {
  test("schema 注释写死三条：legacy、traffic_used 禁止回写、判定层不读", () => {
    const schemaBefore = SCHEMA.slice(0, SCHEMA.indexOf("model UserPlan {"));
    const doc = schemaBefore.slice(schemaBefore.lastIndexOf("/// V5-WP20-2"));
    expect(doc).toContain("legacy 展示视图，冻结");
    expect(doc).toContain("traffic_used` **禁止回写**");
    expect(doc).toContain("PlanSubscription");
  });

  test("UserPlan 的唯一约束未被改动（第一步不加破坏性约束，契约 §3.5.2）", () => {
    const userPlan = modelBlock("UserPlan");
    expect(userPlan).toMatch(/user_id\s+Int\s+@unique/);
    expect(userPlan).toContain("@map(\"user_plan\")");
  });
});

describe("F. 迁移是纯 additive：不动 V4 冻结基线（契约 §8.5）", () => {
  test("迁移目录名符合 WP20 约定（20261030 之后且含 wp20）", () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    expect(MIGRATION_NAME).toMatch(/^2026103\d{7}_v5_wp20_/);
    const names = readdirSync(MIGRATIONS_DIR).filter((entry) => entry.startsWith("2026103"));
    expect(names).toContain(MIGRATION_NAME);
  });

  test("没有 DROP / DELETE / TRUNCATE，也没有改既有列", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE", "MODIFY COLUMN", "CHANGE COLUMN"]) {
      expect({ forbidden, hits: MIGRATION.includes(forbidden) }).toEqual({ forbidden, hits: false });
    }
  });

  test("只新增 2 张表 + 1 个可空列 + 1 个索引", () => {
    expect([...MIGRATION.matchAll(/CREATE TABLE/g)]).toHaveLength(2);
    expect(MIGRATION).toContain("CREATE TABLE `plan_subscription`");
    expect(MIGRATION).toContain("CREATE TABLE `subscription_period_settlement`");
    expect([...MIGRATION.matchAll(/ALTER TABLE `\w+` ADD COLUMN/g)]).toHaveLength(1);
    expect(MIGRATION).toContain("CREATE INDEX `plan_order_workspace_id_idx` ON `plan_order`(`workspace_id`)");
  });

  test("本迁移只建自己 WP 的表：没有别的 WP 的表被并发编辑带进来", () => {
    // 真实事故（2026-10-05）：`prisma migrate diff` 是「HEAD schema → 当前工作树 schema」的差集，
    // 期间另一位成员把 `NotificationDelivery` 加进了共享的 schema.prisma，于是别人的建表语句
    // 被夹进本 WP 的迁移，与对方自己的迁移重复建表 ⇒ 空库 `migrate deploy` 会直接失败。
    // 这里把「本迁移建的表集合」钉死，任何人再夹带都会被这条断言拦住。
    const created = createdTables(MIGRATION);
    expect(created.sort()).toEqual(["plan_subscription", "subscription_period_settlement"]);
    expect(MIGRATION).not.toContain("notification_delivery");
  });

  test("全仓守卫：没有任何表被两次建出（跨迁移的重复建表）", () => {
    const createdBy = new Map<string, string>();
    const violations: string[] = [];
    const dirs = readdirSync(MIGRATIONS_DIR)
      .filter((entry) => existsSync(new URL(`${entry}/migration.sql`, MIGRATIONS_DIR)))
      .sort();
    for (const dir of dirs) {
      const sql = stripLineComments(readFileSync(new URL(`${dir}/migration.sql`, MIGRATIONS_DIR), "utf8"));
      for (const statement of sql.split(";")) {
        const create = statement.match(/CREATE TABLE (?:IF NOT EXISTS )?`(\w+)`/);
        if (create?.[1]) {
          const table = create[1];
          const previous = createdBy.get(table);
          if (previous) violations.push(`${table}: ${previous} 与 ${dir} 重复建表`);
          createdBy.set(table, dir);
        }
        const drop = statement.match(/DROP TABLE (?:IF EXISTS )?`(\w+)`/);
        if (drop?.[1]) createdBy.delete(drop[1]);
      }
    }
    expect(violations).toEqual([]);
  });

  test("外键取向是被删用户流程倒推出来的（Cascade / SetNull，见迁移注释）", () => {
    expect(MIGRATION).toContain("FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON DELETE CASCADE");
    expect(MIGRATION).toContain("FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON DELETE SET NULL");
    expect(MIGRATION).toContain("FOREIGN KEY (`order_id`) REFERENCES `plan_order`(`id`) ON DELETE SET NULL");
    expect(MIGRATION).toMatch(/plan_subscription_workspace_id_fkey/);
    // 删除语义的理由必须留在迁移里（接手者能复核），不能只活在提交信息里
    expect(MIGRATION).toContain("routes/admin-extended.ts:400-440");
  });

  test("不新增 enum 类型（DoD 第 7 条在 DDL 层同样成立）", () => {
    expect(MIGRATION).not.toMatch(/^\s*CREATE TYPE/m);
    // 唯一的 ENUM 是复用的既有 BillingCycle 快照列，不是新类型
    expect([...MIGRATION.matchAll(/ENUM\(/g)]).toHaveLength(1);
  });
});

describe("G. WP20-3：接管超时配置项只在既有 ENUM 尾部追加", () => {
  const CONFIG_MIGRATION_NAME = "20261032000000_v5_wp20_settlement_config";
  const CONFIG_MIGRATION = readFileSync(
    new URL(`../../../../prisma/migrations/${CONFIG_MIGRATION_NAME}/migration.sql`, import.meta.url),
    "utf8",
  );

  test("迁移存在、命名符合 WP20 约定、且只做一次 MODIFY", () => {
    expect(CONFIG_MIGRATION_NAME).toMatch(/^2026103\d{7}_v5_wp20_/);
    expect([...CONFIG_MIGRATION.matchAll(/ALTER TABLE/g)]).toHaveLength(1);
    expect([...CONFIG_MIGRATION.matchAll(/MODIFY/g)]).toHaveLength(1);
    expect(CONFIG_MIGRATION).toContain("`config`");
  });

  test("新值追加在**尾部**（MySQL ENUM 按序号存储，中间插入会让存量行含义错位）", () => {
    const enumBody = CONFIG_MIGRATION.match(/ENUM\((.*?)\)/s)?.[1];
    expect(enumBody).toBeDefined();
    const values = [...enumBody!.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
    expect(values[values.length - 1]).toBe("BILLING_SETTLEMENT_TAKEOVER_MINUTES");
    expect(values).toHaveLength(35);
    // 追加不得改动任何既有值的相对顺序（逐字比对前缀）
    expect(values.slice(0, -1)).toEqual([
      "MIN_TOPUP_AMOUNT", "FAILOVER_POLICY", "NOTICE", "NOTICE_POPUP", "NOTICE_POPUP_INTERVAL_HOURS",
      "SITE_NAME", "SITE_DESCRIPTION", "ALLOW_REGISTER", "LOGO_URL", "HIDE_NODE_STATUS",
      "AUTO_UPDATE_AGENT", "CHATWOOT_BASE_URL", "CHATWOOT_TOKEN", "TUNNEL_TRAFFIC_RETENTION_DAYS",
      "HIDE_FOOTER", "HIDE_DOCS", "LANDING_PAGE_URL", "REFERRAL_COMMISSION_RATE", "REFERRAL_FIRST_ONLY",
      "REFERRAL_MODE", "OBSERVER_PERIOD", "EMAIL_PROVIDER", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE",
      "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "RESEND_API_KEY", "RESEND_FROM", "MIN_WITHDRAW_AMOUNT",
      "WITHDRAW_METHODS", "LIMIT_SCOPE", "ENABLE_SUBSCRIPTION",
    ]);
  });

  test("schema 与 seed 都登记了这个配置项（缺省时代码回落 10 分钟）", () => {
    expect(SCHEMA).toContain("BILLING_SETTLEMENT_TAKEOVER_MINUTES");
    const seed = readFileSync(new URL("../../../../prisma/seed.ts", import.meta.url), "utf8");
    expect(seed).toContain('BILLING_SETTLEMENT_TAKEOVER_MINUTES: "10"');
  });
});
