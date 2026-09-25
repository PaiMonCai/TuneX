import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WP2 — Legacy Backfill / Upgrade（DEVELOPMENT.md §7.5，§7.2 Track A）
 *
 * 目标：证明**现有数据库升级不破坏 DIRECT**。
 *
 * 三条防线，每条一个独立数据库（避免跨用例的顺序耦合）：
 *
 *  ① empty DB：legacy 基线 + 全部 v3 迁移全部 apply；空库无残留。
 *  ② legacy fixture：把 **pre-v3 基线**（只到 `20260926000000`）跑起来 → 灌
 *     纯存量数据 → 升级到 v3（WP1 + WP2 迁移）→ 追加 post-v3 引用。
 *     断言 §7.5 的全部「不变」要求：tunnel 数量 / listen_port /
 *     forward_addresses / workspace-user-policy 关系全部原样，同时新列被
 *     确定性回填；混挂组与无隧道组的 Node.role 保持 NULL（绝不 'both'）。
 *  ③ v3 upgrade fixture（幂等）：在**已回填**的库上重复执行同一条迁移，
 *     断言数值 / 计数不变，且显式声明过的值永不被回改。
 *
 * 旧 Agent 的 legacy config 兼容路径另有一组断言：驱动**真实的**
 * `buildInNodeConfig` / `normalizeForwardAddresses`，证明配置下发用的仍是
 * `forward_addresses` 与 `listen_port`，而不是 WP1/WP2 加的新列——所以存量
 * Agent 拿到的配置不变。
 *
 * 环境变量：
 *   TUNEX_DB_TEST=1        本文件才真正执行（未设置时整文件 skip）
 *   DATABASE_URL           CI 的 mysql service；本地容器直接用 .env.local
 *   REDIS_URL              config-generator 的 transitive import 需要可连
 *                          （ioredis 默认 eager connect；不可达时用例挂起）
 *   PRISMA_CLI             prisma CLI 入口（缺省 node_modules/prisma/build/index.js）
 */

const DB_TEST = process.env.TUNEX_DB_TEST === "1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(HERE, "..");
const MIGRATIONS_ROOT = path.join(BACKEND_ROOT, "prisma", "migrations");

/** WP2 迁移目录名（对应 prisma/migrations 下的目录）。 */
const WP2_MIGRATION = "20260926120000_v3_legacy_backfill";

/** 与 CI 的 backend job 完全一致的 env（见 .github/workflows/ci.yml）。 */
const CI_ENV = {
  AUTH_SECRET: "ci-only-auth-secret-must-not-be-used-in-production", // secret-scan:allow
  LICENSE_SECRET: "ci-only-license-secret-must-not-be-used-in-production", // secret-scan:allow
  TUNEX_CONFIG_KEY: "Y2ktb25seS1jb25maWcta2V5LW11c3Qtbm90LXByb2Q=", // secret-scan:allow
  TUNEX_LICENSE_KEY: "Y2ktb25seS1saWNlbnNlLWtleS1tdXN0LW5vdC1wcm9=", // secret-scan:allow
};

/** WP1 之前的所有迁移（"legacy 基线"）。顺序 = 目录名的时间序。 */
const LEGACY_MIGRATIONS = [
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
];

/** v3 迁移：WP1 schema 契约 + 本包的回填。 */
const V3_MIGRATIONS = ["20260926040000_v3_schema_contract", WP2_MIGRATION];

const LEGACY_ROWS = path.join(HERE, "fixtures", "legacy-backfill-rows.sql");
const POST_V3_ROWS = path.join(HERE, "fixtures", "legacy-backfill-post-v3.sql");
const WP2_SQL = path.join(MIGRATIONS_ROOT, WP2_MIGRATION, "migration.sql");

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

/**
 * 在对一个**匿名临时库**上跑 migrate deploy。
 *
 * schema 与 migrations 都复制到 tmp，不碰工作树；`--schema` 让 prisma 用
 * 传入的 `DATABASE_URL`。每个 describe 各建一个库，互不污染。
 */
function migrateDeploy(url, migrations) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tunex-wp2-mig-"));
  fs.copyFileSync(path.join(MIGRATIONS_ROOT, "..", "schema.prisma"), path.join(tmp, "schema.prisma"));
  fs.mkdirSync(path.join(tmp, "migrations"));
  for (const m of migrations) {
    fs.cpSync(path.join(MIGRATIONS_ROOT, m), path.join(tmp, "migrations", m), { recursive: true });
  }
  const [bin, cli] = prismaCli();
  try {
    return execFileSync(bin, [cli, "migrate", "deploy", "--schema", path.join(tmp, "schema.prisma")], {
      encoding: "utf8",
      env: { ...process.env, ...CI_ENV, DATABASE_URL: url },
      timeout: 120_000,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 用 `prisma db execute` 跑 SQL 文件（不走 mysql CLI，密码不进命令行）。 */
function executeSqlFile(url, file) {
  const [bin, cli] = prismaCli();
  execFileSync(bin, [cli, "db", "execute", "--url", url, "--file", file], {
    encoding: "utf8",
    env: { ...process.env, ...CI_ENV },
    timeout: 120_000,
  });
}

/** 用 `prisma db execute` 跑一段 SQL 字符串。 */
function executeSql(url, sql) {
  const f = path.join(os.tmpdir(), `tunex-wp2-exec-${process.pid}-${Date.now()}.sql`);
  fs.writeFileSync(f, sql);
  try {
    executeSqlFile(url, f);
  } finally {
    fs.rmSync(f, { force: true });
  }
}

/** 建一个匿名库：连 server（不带库名）→ CREATE DATABASE → 返回可用 URL + 库名。 */
function freshDb(label) {
  const src = new URL(process.env.DATABASE_URL ?? "mysql://root:@127.0.0.1:3306/tunex_ci");
  const name = `tunex_wp2_${label}_${Date.now().toString(36)}`;
  const url = new URL(src);
  url.pathname = `/${name}`;
  const serverUrl = new URL(src);
  serverUrl.pathname = "/";
  executeSql(serverUrl.toString(), `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  return { url: url.toString(), name };
}

/** 收尾：删掉匿名库。失败只吞掉，避免掩盖真正的断言结果。 */
function dropIfPossible(handle) {
  if (!handle) return;
  try {
    const src = new URL(process.env.DATABASE_URL ?? "mysql://root:@127.0.0.1:3306/tunex_ci");
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

/** Prisma 的 raw 结果按 BigInt 回 id：统一转 Number 方便断言。 */
const n = (v) => Number(v);

if (!DB_TEST) {
  test("legacy backfill MySQL integration (requires TUNEX_DB_TEST=1)", { skip: true }, () => {});
} else {
  let PrismaClient;

  before(async () => {
    PrismaClient = (await import("@prisma/client")).PrismaClient;
  });

  /* ================================================================ */
  /* ① 空库                                                            */
  /* ================================================================ */
  describe("① empty database", () => {
    let db, handle;
    before(async () => {
      handle = freshDb("empty");
      db = new PrismaClient({ datasources: { db: { url: handle.url } } });
      migrateDeploy(handle.url, LEGACY_MIGRATIONS);
      migrateDeploy(handle.url, [...LEGACY_MIGRATIONS, ...V3_MIGRATIONS]);
    });
    after(async () => {
      await db?.$disconnect();
      dropIfPossible(handle);
    });

    test("legacy baseline then the full v3 chain all apply on an empty MySQL database", async () => {
      // `_prisma_migrations` 不是 Prisma model（上方的 delegate 列表里没有它），
      // 用 raw query 按 started_at 顺序核对：每一条都必须 finished_at 非空。
      const applied = await db.$queryRawUnsafe(
        "SELECT migration_name, finished_at, applied_steps_count FROM _prisma_migrations ORDER BY started_at",
      );
      assert.deepEqual(
        applied.map((m) => m.migration_name),
        [...LEGACY_MIGRATIONS, ...V3_MIGRATIONS],
        "every migration recorded, in order",
      );
      for (const m of applied) assert.ok(m.finished_at !== null, `migration ${m.migration_name} finished`);
    });

    test("nothing to backfill, but the v3 columns exist", async () => {
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tunnel"), 0);
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM node"), 0);
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM node_group"), 0);
      // 列本身存在（NULL 可空）——空库里没有行可回填，确保 schema 落地即可。
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tunnel WHERE tunnel_mode IS NULL"), 0);
    });
  });

  /* ================================================================ */
  /* ② legacy fixture → v3                                              */
  /* ================================================================ */
  describe("② legacy database upgraded to v3 (DIRECT must survive)", () => {
    let db, handle;

    before(async () => {
      handle = freshDb("legacy");
      db = new PrismaClient({ datasources: { db: { url: handle.url } } });
      // 1. pre-v3 基线
      migrateDeploy(handle.url, LEGACY_MIGRATIONS);
      // 2. 灌纯存量数据（只写 legacy 列）
      executeSqlFile(handle.url, LEGACY_ROWS);
      // 3. 升级到 v3（WP1 + WP2 的迁移）
      migrateDeploy(handle.url, [...LEGACY_MIGRATIONS, ...V3_MIGRATIONS]);
      // 4. 追加 v3 列已存在才能构造的引用（混挂组 / 半条 v3 行 / 无隧道组）
      executeSqlFile(handle.url, POST_V3_ROWS);
      // 5. 再跑一次 WP2 迁移：证明迁移之后新增的行也被同一条迁移覆盖
      executeSqlFile(handle.url, WP2_SQL);
    });

    after(async () => {
      await db?.$disconnect();
      dropIfPossible(handle);
    });

    const q = async (sql) => db.$queryRawUnsafe(sql);

    test("tunnel count / listen_port / forward_addresses / in-out group refs all survive", async () => {
      const rows = await q("SELECT id, listen_port, forward_addresses, user_id, workspace_id, in_node_group_id, out_node_group_id FROM tunnel ORDER BY id");
      // 7 条 legacy 隧道 + 3 条 post-v3 隧道
      assert.equal(rows.length, 10, "all tunnels still exist (7 legacy + 3 post-v3)");
      const expected = [
        { id: 901, port: 19001, forward: ["127.0.0.1:8080"], user: 701, ws: 701 },
        { id: 902, port: 19002, forward: [{ address: "192.168.1.10:80", weight: 2 }], user: 701, ws: 701 },
        { id: 903, port: 19003, forward: ["nonsense-without-port"], user: 701, ws: 701 },
        { id: 904, port: 19004, forward: ["[::1]:8080"], user: 701, ws: 701 },
        { id: 905, port: 19005, forward: ["10.9.9.9:7000", "10.9.9.10:7001"], user: 701, ws: 701 },
        { id: 906, port: 19006, forward: ["127.0.0.1:9090"], user: 702, ws: 702 },
        { id: 910, port: 19010, forward: [{ address: "no-port-here", weight: 1 }], user: 701, ws: 701 },
        { id: 907, port: 19007, forward: ["127.0.0.1:9091"], user: 701, ws: 701 },
        { id: 909, port: 19009, forward: ["127.0.0.1:9092"], user: 701, ws: 701 },
        { id: 908, port: 19008, forward: ["10.1.1.1:9090"], user: 701, ws: 701 },
      ];
      for (const e of expected) {
        const row = rows.find((r) => n(r.id) === e.id);
        assert.ok(row, `tunnel ${e.id} exists`);
        assert.equal(n(row.listen_port), e.port, `tunnel ${e.id} listen_port unchanged`);
        assert.equal(n(row.user_id), e.user, `tunnel ${e.id} user_id unchanged`);
        assert.equal(n(row.workspace_id), e.ws, `tunnel ${e.id} workspace_id unchanged`);
        assert.deepEqual(
          JSON.parse(JSON.stringify(row.forward_addresses)),
          e.forward,
          `tunnel ${e.id} forward_addresses unchanged`,
        );
      }
      // in / out 组指针不变
      assert.equal(n(rows.find((r) => n(r.id) === 909).out_node_group_id), 803);
      assert.equal(n(rows.find((r) => n(r.id) === 908).out_node_group_id), 802);
      assert.equal(n(rows.find((r) => n(r.id) === 906).in_node_group_id), 804);
    });

    test("workspace / user / member / node_group / node relations are untouched", async () => {
      const users = await q("SELECT id, email FROM user ORDER BY id");
      assert.deepEqual(users.map((u) => [n(u.id), u.email]), [
        [701, "upgrade-a@example.test"],
        [702, "upgrade-b@example.test"],
      ]);
      const ws = await q("SELECT id, slug, kind, personal_user_id FROM workspace ORDER BY id");
      assert.deepEqual(
        ws.map((w) => [n(w.id), w.slug, w.kind, n(w.personal_user_id)]),
        [
          [701, "personal-701", "personal", 701],
          [702, "personal-702", "personal", 702],
        ],
      );
      const members = await q("SELECT workspace_id, user_id, role, active FROM workspace_member ORDER BY workspace_id, user_id");
      assert.deepEqual(
        members.map((m) => [n(m.workspace_id), n(m.user_id), m.role, m.active]),
        [
          [701, 701, "owner", 1],
          [702, 702, "owner", 1],
        ],
      );
      // 组归属与 legacy `node_type` 不变（§7.5 的「workspace/user 关系不变」）
      const groups = await q("SELECT id, user_id, workspace_id, node_type FROM node_group ORDER BY id");
      assert.deepEqual(
        groups.map((g) => [n(g.id), n(g.user_id), n(g.workspace_id), g.node_type]),
        [
          [801, 701, 701, "in"],
          [802, 701, 701, "out"],
          [803, 701, 701, "in"],
          [804, 702, 702, "in"],
          [805, 701, 701, "out"],
        ],
      );
      // 节点只可能改 role：组归属 / connect_ip 不动
      const nodes = await q("SELECT id, node_group_id, connect_ip FROM node ORDER BY id");
      assert.deepEqual(
        nodes.map((x) => [n(x.id), n(x.node_group_id), x.connect_ip]),
        [
          [901, 801, "10.0.0.1"],
          [902, 802, "10.0.0.2"],
          [903, 803, "10.0.0.3"],
          [904, 804, "10.0.0.4"],
          [905, 805, "10.0.0.5"],
        ],
      );
    });

    test("tunnel_mode: every remaining NULL without a RELAY pointer becomes 'direct'", async () => {
      const modes = await q("SELECT id, tunnel_mode, egress_node_id, egress_pool_id FROM tunnel ORDER BY id");
      for (const m of modes) {
        if (n(m.id) === 908) {
          assert.equal(m.tunnel_mode, null, "half-written v3 row keeps an egress pointer → WP8 finishes it");
          continue;
        }
        assert.equal(m.tunnel_mode, "direct", `tunnel ${n(m.id)} → direct`);
      }
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tunnel WHERE tunnel_mode IS NULL"), 1, "only the half-written v3 row stays NULL");
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tunnel WHERE tunnel_mode = 'direct'"), 9);
    });

    test("remote_host / remote_port backfill from forward_addresses (both shapes + edge cases)", async () => {
      const byId = new Map((await q("SELECT id, remote_host, remote_port FROM tunnel ORDER BY id")).map((r) => [n(r.id), r]));
      // 字符串形态
      assert.equal(byId.get(901).remote_host, "127.0.0.1");
      assert.equal(n(byId.get(901).remote_port), 8080);
      // 对象形态
      assert.equal(byId.get(902).remote_host, "192.168.1.10");
      assert.equal(n(byId.get(902).remote_port), 80);
      // IPv6：[] 剥掉，端口取最后一个冒号之后
      assert.equal(byId.get(904).remote_host, "::1");
      assert.equal(n(byId.get(904).remote_port), 8080);
      // 多目标：只回填第一个
      assert.equal(byId.get(905).remote_host, "10.9.9.9");
      assert.equal(n(byId.get(905).remote_port), 7000);
      // 906 / 907 / 909 的形态各不相同
      assert.equal(byId.get(906).remote_host, "127.0.0.1");
      assert.equal(n(byId.get(906).remote_port), 9090);
      assert.equal(n(byId.get(909).remote_port), 9092);
      assert.equal(byId.get(907).remote_host, "127.0.0.1");
      // 脏数据 / 无端口对象：解析不出 → NULL，绝不写 0 端口
      for (const id of [903, 910]) {
        assert.equal(byId.get(id).remote_host, null, `tunnel ${id} unparseable → NULL`);
        assert.equal(byId.get(id).remote_port, null, `tunnel ${id} unparseable → NULL (never 0)`);
      }
      // 带 egress 指针的半条 v3 行：RELAY 目标在 EgressTarget 上，本列留 NULL
      assert.equal(byId.get(908).remote_host, null);
      assert.equal(byId.get(908).remote_port, null);
      // 整库没有 0 端口
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tunnel WHERE remote_port = 0"), 0);
    });

    test("Node.role deterministic backfill — never 'both', never guessed", async () => {
      const byId = new Map((await q("SELECT id, node_group_id, role FROM node ORDER BY id")).map((r) => [n(r.id), r]));
      // 801 / 804 只被 in 引用 → ingress
      assert.equal(byId.get(901).role, "ingress", "in-only group → ingress");
      assert.equal(byId.get(904).role, "ingress", "in-only group → ingress");
      // 802 只被 out 引用 → egress
      assert.equal(byId.get(902).role, "egress", "out-only group → egress");
      // 803 混挂（907 作入口、909 作出口）→ 不可判定 → NULL
      assert.equal(byId.get(903).role, null, "mixed-usage group must stay NULL, never 'both'");
      // 805 无任何隧道引用 → NULL
      assert.equal(byId.get(905).role, null, "unreferenced group must stay NULL");
      // 铁律：整库不出现 'both'
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM node WHERE role = 'both'"), 0, "'both' is an explicit admin action");
      // 只有 3 行被回填，另外 2 行保持「未声明」
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM node WHERE role = 'ingress'"), 2);
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM node WHERE role = 'egress'"), 1);
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM node WHERE role IS NULL"), 2);
    });

    test("DIRECT runtime columns survive for the legacy agent", async () => {
      const t = await q("SELECT listen_port, forward_addresses, listen_ip FROM tunnel WHERE id = 901");
      assert.equal(n(t[0].listen_port), 19001);
      assert.deepEqual(JSON.parse(JSON.stringify(t[0].forward_addresses)), ["127.0.0.1:8080"]);
    });
  });

  /* ================================================================ */
  /* ③ 幂等                                                             */
  /* ================================================================ */
  describe("③ idempotency (re-run the same migration)", () => {
    let db, handle;

    before(async () => {
      handle = freshDb("idem");
      db = new PrismaClient({ datasources: { db: { url: handle.url } } });
      migrateDeploy(handle.url, [...LEGACY_MIGRATIONS, ...V3_MIGRATIONS]);
      executeSqlFile(handle.url, LEGACY_ROWS);
      executeSqlFile(handle.url, POST_V3_ROWS);
      executeSqlFile(handle.url, WP2_SQL);
    });

    after(async () => {
      await db?.$disconnect();
      dropIfPossible(handle);
    });

    const snap = async () => JSON.stringify(await db.$queryRawUnsafe("SELECT id, tunnel_mode, remote_host, remote_port FROM tunnel ORDER BY id"));
    const snapNodes = async () => JSON.stringify(await db.$queryRawUnsafe("SELECT id, role FROM node ORDER BY id"));

    test("re-running the backfill changes nothing", async () => {
      const beforeT = await snap();
      const beforeN = await snapNodes();
      executeSqlFile(handle.url, WP2_SQL);
      executeSqlFile(handle.url, WP2_SQL);
      executeSqlFile(handle.url, WP2_SQL);
      assert.equal(await snap(), beforeT, "tunnel_mode / remote_host / remote_port are stable");
      assert.equal(await snapNodes(), beforeN, "Node.role is stable");
    });

    test("explicitly-set values are never overwritten", async () => {
      // 管理员显式动作：把 906 标成 relay 并清空 remote_*；把 904 的节点标成 both。
      executeSql(handle.url, "UPDATE tunnel SET tunnel_mode = 'relay', remote_host = NULL, remote_port = NULL WHERE id = 906;");
      executeSql(handle.url, "UPDATE node SET role = 'both' WHERE id = 904;");
      executeSqlFile(handle.url, WP2_SQL);
      const t = await db.$queryRawUnsafe("SELECT tunnel_mode, remote_host, remote_port FROM tunnel WHERE id = 906");
      assert.equal(t[0].tunnel_mode, "relay", "explicit relay is never downgraded to direct");
      assert.equal(t[0].remote_host, null, "explicitly-cleared remote_host stays NULL");
      assert.equal(t[0].remote_port, null, "explicitly-cleared remote_port stays NULL");
      const r = await db.$queryRawUnsafe("SELECT role FROM node WHERE id = 904");
      assert.equal(r[0].role, "both", "explicit role (incl. both) is never overwritten");
      // 再跑一次仍然不动
      executeSqlFile(handle.url, WP2_SQL);
      assert.equal((await db.$queryRawUnsafe("SELECT tunnel_mode FROM tunnel WHERE id = 906"))[0].tunnel_mode, "relay");
      assert.equal((await db.$queryRawUnsafe("SELECT role FROM node WHERE id = 904"))[0].role, "both");
      // 同一份数据里的其它行依旧正确
      assert.equal((await db.$queryRawUnsafe("SELECT tunnel_mode FROM tunnel WHERE id = 901"))[0].tunnel_mode, "direct");
      assert.equal((await db.$queryRawUnsafe("SELECT role FROM node WHERE id = 901"))[0].role, "ingress");
    });
  });

  /* ================================================================ */
  /* 旧 Agent 的 legacy config 兼容路径                                  */
  /* ================================================================ */
  describe("legacy agent config compatibility", () => {
    // config-generator.ts 传递 import 了 src/redis.ts，ioredis 默认 eager
    // connect 且 `redis.disconnect()` 不在 finally 里调用时，node --test 的
    // 进程会一直挂着不退出。在这里显式断开。
    after(async () => {
      try {
        const { redis } = await import("../src/redis.ts");
        redis.disconnect();
      } catch {
        /* redis 不可用时 import 本身会失败，忽略 */
      }
    });

    test("buildInNodeConfig still serves forward_addresses + listen_port (no v3 columns)", async () => {
      const { buildInNodeConfig } = await import("../src/socket/config-generator.ts");
      // 与 config-generator-ports.test.ts / config-generator-policy.test.ts
      // 相同的 tunnel 形状：只含 legacy 列（没有 tunnel_mode / remote_host）。
      const tunnel = {
        id: 901,
        name: "Legacy TCP",
        tunnel_type: "tcp",
        category: "port_forward",
        listen_ip: "",
        listen_port: 19001,
        listen_protocol: null,
        forward_addresses: ["127.0.0.1:8080"],
        forward_addresses_protocol: null,
        load_balance_type: "round",
        ip_type: "ipv4",
        ip_limit: null,
        client_limit: null,
        bandwidth_limit: null,
        proxy_protocol: false,
        status: "active",
        in_node_group_id: 801,
        in_node_group: { id: 801, user_id: 701, workspace_id: 701 },
        out_node_group_id: null,
        out_node_group: null,
        tunnel_chains: [],
        user_id: 701,
        workspace_id: 701,
        user: { id: 701 },
      };

      const cfg = buildInNodeConfig({
        inNodeGroupId: 801,
        portRange: null,
        allowListenProtocol: false,
        allTunnels: [tunnel],
        outListens: {},
        tunnelLimits: new Map(),
        siteUrl: "http://127.0.0.1:8788",
        observerPeriod: "5s",
      });

      const json = JSON.stringify(cfg);
      const services = cfg.services ?? [];
      const svc = services.find((s) => s.name === "tcp-901");
      assert.ok(svc, "in-node service exists for tunnel 901");
      assert.equal(svc.addr, ":19001", "listen address still comes from listen_port");
      assert.ok(json.includes("127.0.0.1:8080"), "forwarder still targets forward_addresses[0]");
      // 不下发任何 v3 概念字段
      assert.ok(!json.includes("tunnel_mode"), "legacy config must not carry tunnel_mode");
      assert.ok(!json.includes("remote_host"), "legacy config must not carry remote_host");
      assert.ok(!json.includes("apply_status"), "legacy config must not carry apply_status");
    });

    test("normalizeForwardAddresses still handles both historical shapes", async () => {
      const { normalizeForwardAddresses } = await import("../src/socket/config-generator.ts");
      assert.deepEqual(normalizeForwardAddresses(["127.0.0.1:8080"]), [{ address: "127.0.0.1:8080", weight: 1 }]);
      assert.deepEqual(normalizeForwardAddresses([{ address: "192.168.1.10:80", weight: 2 }]), [
        { address: "192.168.1.10:80", host: undefined, weight: 2 },
      ]);
      assert.deepEqual(normalizeForwardAddresses(null), []);
      assert.deepEqual(normalizeForwardAddresses(["  ", { nope: 1 }]), []);
    });
  });
}
