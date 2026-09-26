import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * V4-WP1 — Forward Revision 迁移测试（expand-and-contract 验证）。
 *
 * 目标：证明 `20260927090000_v4_wp1_forward_revisions` 在**带存量数据的库**
 * 上 apply 之后：
 *   ① 存量 `tunnel` 行零改动（数量 / 端口 / 地址投影列 / revision 账本原样）。
 *   ② 新增的 `forward_revision` 表存在且为空（没有伪造历史）。
 *   ③ `desired_revision_id` 全为 NULL —— 存量 Forward 没有 snapshot，
 *      代码读 NULL 时按当前投影列合成基线（services/forward-revision.ts）。
 *   ④ 迁移可重复 apply 且幂等（migrate deploy 第二次 no-op）。
 *   ⑤ 唯一约束 `@@unique([tunnel_id, revision])` 真实存在（并发编辑器防线）。
 *   ⑥ 反向验证：本迁移不 DROP / 不 MODIFY 任何既有列（expand-and-contract）。
 *
 * 环境变量：
 *   TUNEX_DB_TEST=1   本文件才真正执行（未设置时整文件 skip）
 *   DATABASE_URL      CI 的 mysql service；本地用 .env.local
 *   REDIS_URL         prisma client import 的传递依赖需要可连
 */

const DB_TEST = process.env.TUNEX_DB_TEST === "1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(HERE, "..");
const MIGRATIONS_ROOT = path.join(BACKEND_ROOT, "prisma", "migrations");

/** WP1 迁移目录名（对应 prisma/migrations 下的目录）。 */
const WP1_MIGRATION = "20260927090000_v4_wp1_forward_revisions";

/** v3 之前的全部迁移（「存量」基线，含 legacy backfill 与 integration repair）。 */
const PRE_MIGRATIONS = [
  "20260923170000_init",
  "20260924100000_node_group_grant",
  "20260924130000_add_audit_log",
  "20260924153000_workspace_foundation",
  "20260924170000_capability_policy",
  "20260924190000_email_verification",
  "20260924210000_user_key_hashes",
  "20260924213000_legacy_key_columns_nullable",
  "20260925000000_tunnel_traffic_idempotent",
  "20260926000000_workspace_custom_role",
  "20260926040000_v3_schema_contract",
  "20260926120000_v3_legacy_backfill",
  "20260926180000_v3_integration_repair",
];

const CI_ENV = {
  AUTH_SECRET: "ci-only-auth-secret-must-not-be-used-in-production", // secret-scan:allow
  LICENSE_SECRET: "ci-only-license-secret-must-not-be-used-in-production", // secret-scan:allow
  TUNEX_CONFIG_KEY: "Y2ktb25seS1jb25maWcta2V5LW11c3Qtbm90LXByb2Q=", // secret-scan:allow
  TUNEX_LICENSE_KEY: "Y2ktb25seS1zdWNlbnNlLWtleS1tdXN0LW5vdC1wcm8=", // secret-scan:allow
};

function prismaCli() {
  const explicit = process.env.PRISMA_CLI;
  if (explicit) return [process.execPath, explicit];
  for (const c of [
    path.join(BACKEND_ROOT, "node_modules", "prisma", "build", "index.js"),
    path.join(BACKEND_ROOT, "..", "node_modules", "prisma", "build", "index.js"),
  ]) {
    if (fs.existsSync(c)) return [process.execPath, c];
  }
  return [process.execPath, "node_modules/prisma/build/index.js"];
}

/** 在临时 schema 目录上跑 migrate deploy（不碰工作树）。 */
function migrateDeploy(url, migrations) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tunex-v4wp1-mig-"));
  fs.copyFileSync(
    path.join(MIGRATIONS_ROOT, "..", "schema.prisma"),
    path.join(tmp, "schema.prisma"),
  );
  fs.mkdirSync(path.join(tmp, "migrations"));
  for (const m of migrations) {
    fs.cpSync(path.join(MIGRATIONS_ROOT, m), path.join(tmp, "migrations", m), {
      recursive: true,
    });
  }
  const [bin, cli] = prismaCli();
  try {
    return execFileSync(
      bin,
      [cli, "migrate", "deploy", "--schema", path.join(tmp, "schema.prisma")],
      { encoding: "utf8", env: { ...process.env, ...CI_ENV, DATABASE_URL: url }, timeout: 120_000 },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 用 `prisma db execute` 跑一段 SQL 字符串。 */
function executeSql(url, sql) {
  const f = path.join(os.tmpdir(), `tunex-v4wp1-exec-${process.pid}-${Date.now()}.sql`);
  fs.writeFileSync(f, sql);
  const [bin, cli] = prismaCli();
  try {
    execFileSync(bin, [cli, "db", "execute", "--url", url, "--file", f], {
      encoding: "utf8",
      env: { ...process.env, ...CI_ENV },
      timeout: 120_000,
    });
  } finally {
    fs.rmSync(f, { force: true });
  }
}

/** 建一个匿名库：连 server（不带库名）→ CREATE DATABASE → 返回可用 URL。 */
function freshDb(label) {
  const src = new URL(
    process.env.DATABASE_URL ?? "mysql://root:@127.0.0.1:3306/tunex_ci",
  );
  const name = `tunex_v4wp1_${label}_${Date.now().toString(36)}`;
  const url = new URL(src);
  url.pathname = `/${name}`;
  const serverUrl = new URL(src);
  serverUrl.pathname = "/";
  executeSql(
    serverUrl.toString(),
    `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
  );
  return { url: url.toString(), name };
}

function dropIfPossible(handle) {
  if (!handle) return;
  try {
    const src = new URL(
      process.env.DATABASE_URL ?? "mysql://root:@127.0.0.1:3306/tunex_ci",
    );
    const serverUrl = new URL(src);
    serverUrl.pathname = "/";
    executeSql(serverUrl.toString(), `DROP DATABASE IF EXISTS \`${handle.name}\`;`);
  } catch {
    /* best-effort */
  }
}

/** COUNT(*) 在 mysql 驱动里是 BigInt，assert.equal 会静默失败 —— 统一转 Number。 */
async function count(db, sql) {
  const out = await db.$queryRawUnsafe(sql);
  return Number(Object.values(out[0])[0]);
}

const n = (v) => Number(v);

/**
 * 灌最小存量 Forward 数据（v3 schema 之后可插入的形状）。
 * 目标是「够跑迁移、够断言零改动」的最小集合，不是完整产品数据。
 *
 * 依赖链（按 FK 顺序）：user → workspace → node_group → node → tunnel。
 * 每个 NOT NULL 无默认值的列都显式给值（MySQL 的 DEFAULT 规则与 Prisma 的
 * `@default(uuid())` 语义不同，raw INSERT 必须自己补）。
 *
 * 注意：这些表的真实列集以 `prisma/migrations` 链（含 v3 legacy backfill /
 * integration repair 两条）落地后的 information_schema 为准——写死列名时
 * 必须核对实际 DDL，否则 CI 上会以「Field 'token' doesn't have a default
 * value」失败。
 */
const SEED_SQL = [
  "INSERT INTO `user` (`id`, `email`, `updated_at`) " +
    "VALUES (1, 'wp1-seed@example.invalid', NOW(6))",
  "INSERT INTO `workspace` (`id`, `slug`, `name`, `kind`, `created_by_id`, `updated_at`) " +
    "VALUES (1, 'wp1-seed', 'wp1-seed', 'personal', 1, NOW(6))",
  "INSERT INTO `node_group` (" +
    "`id`, `token`, `name`, `node_type`, `user_id`, `workspace_id`, `updated_at`) VALUES (" +
    "1, 'wp1-seed-group-token', 'wp1-seed-group', 'in', 1, 1, NOW(6))",
  // pre-v3 的 `node` 表既没有 `name` 也没有 `agent_id`（后两列由 v3 的
  // integration repair 迁移补上），因此这里只插 pre-v3 真实存在的列。
  "INSERT INTO `node` (" +
    "`id`, `node_id`, `node_group_id`, `role`, `status`, " +
    "`connect_ip`, `updated_at`) VALUES (" +
    "1, 'seed-in', 1, 'ingress', 'active', '10.0.0.1', NOW(6))",
  "INSERT INTO `tunnel` (" +
    "`id`, `name`, `category`, `in_node_group_id`, `ingress_node_id`, " +
    "`tunnel_mode`, `listen_ip`, `listen_port`, `remote_host`, `remote_port`, " +
    "`forward_addresses`, `forward_addresses_protocol`, `load_balance_type`, " +
    "`tunnel_type`, `status`, `ip_type`, `order_by`, `traffic`, `traffic_cost`, " +
    "`proxy_protocol`, `user_id`, `workspace_id`, " +
    "`desired_status`, `apply_status`, `config_revision`, `applied_revision`, " +
    "`updated_at`) VALUES (" +
    "1, 'seed-direct', 'port_forward', 1, 1, " +
    "'direct', '10.0.0.1', 20001, '10.1.1.1', 8080, " +
    "'[\"10.1.1.1:8080\"]', '[\"tcp\"]', 'round', " +
    "'tcp', 'active', 'ipv4', 0, 0, 0, " +
    "0, 1, 1, " +
    "'active', 'active', 3, 3, " +
    "NOW(6))",
].join(";\n") + ";";

if (!DB_TEST) {
  test("v4-wp1 forward revision migration (requires TUNEX_DB_TEST=1)", { skip: true }, () => {});
} else {
  let PrismaClient;

  before(async () => {
    PrismaClient = (await import("@prisma/client")).PrismaClient;
  });

  describe("V4-WP1 additive migration", () => {
    let db, handle;

    before(async () => {
      handle = freshDb("legacy");
      db = new PrismaClient({ datasources: { db: { url: handle.url } } });
      // 先只跑到 v3（= WP1 之前的「生产现状」），灌存量，再 apply WP1 迁移。
      migrateDeploy(handle.url, PRE_MIGRATIONS);
      executeSql(handle.url, SEED_SQL);
      migrateDeploy(handle.url, [...PRE_MIGRATIONS, WP1_MIGRATION]);
    });

    after(async () => {
      await db?.$disconnect();
      dropIfPossible(handle);
    });

    test("① 存量 Forwards 零改动：数量 / 端口 / 地址 / revision 账本原样", async () => {
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tunnel"), 1);
      const row = (await db.$queryRawUnsafe(
        "SELECT listen_port, listen_ip, remote_host, remote_port, forward_addresses, " +
          "forward_addresses_protocol, config_revision, applied_revision, tunnel_mode " +
          "FROM tunnel WHERE id = 1",
      ))[0];
      assert.equal(n(row.listen_port), 20001);
      assert.equal(row.listen_ip, "10.0.0.1");
      assert.equal(row.remote_host, "10.1.1.1");
      assert.equal(n(row.remote_port), 8080);
      assert.deepEqual(row.forward_addresses, ["10.1.1.1:8080"]);
      assert.deepEqual(row.forward_addresses_protocol, ["tcp"]);
      // revision 账本不变：迁移不会凭空造历史。
      assert.equal(n(row.config_revision), 3);
      assert.equal(n(row.applied_revision), 3);
      assert.equal(row.tunnel_mode, "direct");
    });

    test("② forward_revision 表存在且为空（不伪造历史）", async () => {
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM forward_revision"), 0);
    });

    test("③ desired_revision_id 可空且存量行全为 NULL", async () => {
      assert.equal(
        await count(
          db,
          "SELECT COUNT(*) AS n FROM tunnel WHERE desired_revision_id IS NOT NULL",
        ),
        0,
      );
      // 列本身必须真实存在（NULL 可空），否则上面的查询早就报错。
      const cols = await db.$queryRawUnsafe(
        "SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE FROM information_schema.COLUMNS " +
          "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tunnel' AND COLUMN_NAME = 'desired_revision_id'",
      );
      assert.equal(cols.length, 1);
      assert.equal(cols[0].IS_NULLABLE, "YES");
    });

    test("④ 迁移幂等：第二次 migrate deploy 是 no-op", async () => {
      const before = await db.$queryRawUnsafe(
        "SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at",
      );
      migrateDeploy(handle.url, [...PRE_MIGRATIONS, WP1_MIGRATION]);
      const after = await db.$queryRawUnsafe(
        "SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at",
      );
      assert.deepEqual(
        after.map((m) => m.migration_name),
        before.map((m) => m.migration_name),
      );
      assert.ok(
        after.some((m) => m.migration_name === WP1_MIGRATION && m.finished_at !== null),
        "migration recorded as finished exactly once",
      );
    });

    test("⑤ 唯一约束 (tunnel_id, revision) 真实存在", async () => {
      // 先按列集精确锁定 (tunnel_id, revision) 复合索引。
      // 不能只按 INDEX_NAME 子串匹配：`forward_revision_tunnel_id_created_at_idx`
      // 也同样包含 "tunnel_id" 和 "revision"（前者是表名前缀），而它在
      // information_schema 里按 INDEX_NAME 排在复合唯一索引之前，子串匹配会
      // 命中 NON_UNIQUE=1 的普通索引，把「唯一约束存在」误判成「不存在」。
      const idx = await db.$queryRawUnsafe(
        "SELECT INDEX_NAME, NON_UNIQUE, " +
          "GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS cols " +
          "FROM information_schema.STATISTICS " +
          "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'forward_revision' " +
          "GROUP BY INDEX_NAME, NON_UNIQUE",
      );
      const composite = idx.find((i) => i.cols === "tunnel_id,revision");
      assert.ok(
        composite,
        `composite index (tunnel_id, revision) present, got ${JSON.stringify(
          idx.map((i) => [i.INDEX_NAME, i.cols]),
        )}`,
      );
      // Prisma 以 BigInt 回 NON_UNIQUE，n() 已统一转 Number：0 = UNIQUE。
      assert.equal(n(composite.NON_UNIQUE), 0, "composite index is UNIQUE");
    });

    test("⑥ expand-and-contract：无 DROP / 无 MODIFY（纯新增）", () => {
      const sql = fs.readFileSync(
        path.join(MIGRATIONS_ROOT, WP1_MIGRATION, "migration.sql"),
        "utf8",
      );
      // SQL 注释必须先整行剥掉再按 ";" 切分。反过来（先切分再丢 `--` 开头的
      // 片段）会留下大量不带语句种类的注释残片（上一版就是这么写的），于是
      // 后面「只允许 CREATE/ALTER」那条断言永远不匹配任何真实语句——
      // 等于没跑。
      const stripped = sql
        .split("\n")
        .map((line) => (line.trim().startsWith("--") ? "" : line))
        .join("\n");
      const statements = stripped
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      // ADD COLUMN + CREATE TABLE + ADD FOREIGN KEY 恰好三条；多出来就说明
      // 本迁移偷偷塞了不该有的语句（而不是解析坏了）。
      assert.equal(statements.length, 3, `expected 3 statements, got ${statements.length}`);

      for (const stmt of statements) {
        assert.ok(
          !/^\s*DROP\b/i.test(stmt),
          `no DROP allowed in expand-and-contract: ${stmt.slice(0, 80)}`,
        );
        assert.ok(
          !/\bMODIFY\s+COLUMN\b/i.test(stmt),
          `no MODIFY COLUMN allowed: ${stmt.slice(0, 80)}`,
        );
      }
      // 只允许 CREATE TABLE / CREATE INDEX / ALTER TABLE ... ADD COLUMN / ADD FOREIGN KEY。
      for (const stmt of statements) {
        assert.ok(
          /^CREATE\s+(TABLE|(UNIQUE\s+)?INDEX)|^ALTER\s+TABLE/i.test(stmt),
          `unexpected statement kind: ${stmt.slice(0, 80)}`,
        );
      }
    });

    test("⑦ snapshot 唯一约束可插入同一 revision 两次（第二次必须失败）", async () => {
      // 先插一条合法 snapshot，确认新表真的能用。
      await executeSql(
        handle.url,
        "INSERT INTO `forward_revision` " +
          "(`tunnel_id`, `revision`, `name`, `desired_status`, `mode`, `ingress_node_id`, " +
          "`listen_ip`, `listen_port`, `created_at`) VALUES " +
          "(1, 4, 'seed-direct', 'active', 'direct', 1, '10.0.0.1', 20001, NOW(6));",
      );
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM forward_revision"), 1);

      // `prisma db execute` 会把 MySQL 的 Duplicate entry 包装成 P2002，
      // 所以这里匹配 P2002（断言的是约束存在的语义，不是驱动措辞）。
      // executeSql 用的是 execFileSync（同步抛出），因此必须用 assert.throws。
      assert.throws(
        () =>
          executeSql(
            handle.url,
            "INSERT INTO `forward_revision` " +
              "(`tunnel_id`, `revision`, `name`, `desired_status`, `mode`, `ingress_node_id`, " +
              "`listen_ip`, `listen_port`, `created_at`) VALUES " +
              "(1, 4, 'seed-direct-dup', 'active', 'direct', 1, '10.0.0.1', 20001, NOW(6));",
          ),
        /P2002|Duplicate entry/i,
      );
    });
  });
}
