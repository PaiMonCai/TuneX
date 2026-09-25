/**
 * WP7 — 节点凭据 / 状态上报离线测试（不连 MySQL / Redis / 网络）。
 *
 * 用内存替身替换 `../db.ts` 与 `../redis.ts`，逐条覆盖 §7.10 的验收口径：
 *   1. **hash at rest**：DB 里任何列都不含明文；落库的是 sha256 hex（64 字符）；
 *   2. **A token 不能冒充 B**：A 的明文只在 A 行命中；拿 A 的明文查库永远拿不到 B；
 *   3. **revoked token 不能重连**：revoke 后同一把钥匙认证失败（原因 revoked）；
 *   4. **rotate 后旧 token 失效**：rotate 覆盖哈希列，旧明文立即失效、新明文可用；
 *   5. **token 不写日志**：全流程捕获的日志/审计写入里不含明文片段；
 *   6. **NAT Agent 只靠出站**：本模块不含任何 listen/connect 调用（静态断言 +
 *      形状断言：服务只 export 函数，没有 Server/Transport 构造）。
 *   7. issue / rotate 的分工：已持有有效凭据的节点 issue 报 409，未签发的节点
 *      rotate 报 404（fail-closed，不静默生成）。
 *   8. 状态上报：载荷校验 fail-closed + upsert 每节点一行 + 重连快照只回自己那份。
 */
import { test, expect, describe, beforeEach, mock } from "bun:test";
import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ */
/* 内存 DB / Redis 替身                                                 */
/* ------------------------------------------------------------------ */

interface NodeRow {
  id: number;
  node_id: string;
  node_credential_hash: string | null;
  credential_revoked: boolean;
  credential_rotated_at: Date | null;
  credential_last_rejected_at: Date | null;
  node_group: { workspace_id: number | null; is_shared: boolean | null };
}

interface StateRow {
  node_id: number;
  version: string | null;
  role: string | null;
  reported_revision: number | null;
  tunnels: unknown;
  egress_pools: unknown;
  used_ports: unknown;
  last_error: string | null;
}

const nodes: NodeRow[] = [];
const stateReports = new Map<number, StateRow>();

/** 每次 update/updateMany 调用的日志，用于断言「明文没有落库」。 */
const writes: { model: string; op: string; data: Record<string, unknown> }[] = [];

function resetState(): void {
  nodes.length = 0;
  stateReports.clear();
  writes.length = 0;
  // nextNodeId 刻意**不**重置：每个测试拿到不同的 node_id 数字，避免
  // 「上一个测试残留的行被下一个测试的 node_id 撞上」。
}

let nextNodeId = 1;

function seedNode(over: Partial<NodeRow> = {}): NodeRow {
  const row: NodeRow = {
    id: nextNodeId++,
    node_id: `node-${nextNodeId}`,
    node_credential_hash: null,
    credential_revoked: false,
    credential_rotated_at: null,
    credential_last_rejected_at: null,
    node_group: { workspace_id: 42, is_shared: false },
    ...over,
  };
  nodes.push(row);
  return row;
}

/** sha256 hex，与实现同源（不 import，保持测试独立）。 */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/* Prisma 风格唯一冲突：两个节点不许拿同一哈希。 */
function prismaUniqueError(column: string): Error {
  const e = new Error(`Unique constraint failed on the fields: (\`${column}\`)`);
  (e as Error & { code: string }).code = "P2002";
  return e;
}

const dbStub = {
  node: {
    async findUnique({ where }: { where: Record<string, unknown> }) {
      if ("node_credential_hash" in where) {
        const row = nodes.find((n) => n.node_credential_hash === where.node_credential_hash);
        return row ? { ...row, node_group: { ...row.node_group } } : null;
      }
      if ("id" in where) {
        const row = nodes.find((n) => n.id === where.id);
        return row ? { ...row, node_group: { ...row.node_group } } : null;
      }
      if ("node_id" in where) {
        const row = nodes.find((n) => n.node_id === where.node_id);
        return row ? { ...row, node_group: { ...row.node_group } } : null;
      }
      return null;
    },
    async update({ where, data }: { where: { id: number }; data: Record<string, unknown> }) {
      const row = nodes.find((n) => n.id === where.id);
      if (!row) throw new Error("P2025");
      assertHashUnique(nodes, row, data);
      Object.assign(row, data);
      writes.push({ model: "node", op: "update", data });
      return { ...row, node_group: { ...row.node_group } };
    },
    async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      const rows = nodes.filter((n) =>
        Object.entries(where).every(([k, v]) => {
          if (k === "node_credential_hash" && v && typeof v === "object" && "not" in (v as object)) {
            const notNull = (v as { not: unknown }).not;
            return notNull === null ? n.node_credential_hash !== null : true;
          }
          return (n as unknown as Record<string, unknown>)[k] === v;
        }),
      );
      for (const row of rows) {
        assertHashUnique(nodes, row, data);
        Object.assign(row, data);
      }
      writes.push({ model: "node", op: "updateMany", data });
      return { count: rows.length };
    },
  },
  nodeStateReport: {
    async upsert({
      where,
      create,
      update,
    }: {
      where: { node_id: number };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) {
      const existing = stateReports.get(where.node_id);
      if (existing) {
        Object.assign(existing, update);
        writes.push({ model: "nodeStateReport", op: "update", data: update });
      } else {
        stateReports.set(where.node_id, create as unknown as StateRow);
        writes.push({ model: "nodeStateReport", op: "create", data: create });
      }
      return stateReports.get(where.node_id);
    },
    async findUnique({ where }: { where: { node_id: number } }) {
      return stateReports.get(where.node_id) ?? null;
    },
  },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(dbStub),
};

/** 哈希唯一性守卫（模拟 DB 唯一索引；测试替身也要有这个不变式）。 */
function assertHashUnique(all: NodeRow[], row: NodeRow, data: Record<string, unknown>): void {
  const incoming = data.node_credential_hash;
  if (incoming === undefined) return;
  if (incoming === null) return;
  const clash = all.find((n) => n.id !== row.id && n.node_credential_hash === incoming);
  if (clash) throw prismaUniqueError("node_credential_hash");
}

/* Redis 替身：只实现 authenticateNode 用到的 get/incr/expire/set。
 *
 * `RedisKeys` **不能**自己造一个空对象 —— 它必须复用真实模块：
 * bun 把 mock.module 存进进程级注册表，同进程内后加载的测试文件（如
 * middlewares/__tests__/rate-limit.test.ts）如果之前没 import 过 redis.ts，
 * 也会拿到这个替身，然后 `RedisKeys.rateLimit(...)` 直接 undefined 报错。
 * 所以这里把 `RedisKeys` 原样转发，只覆盖 `redis` 客户端本身。
 */
const realRedis = await import("../../redis.ts");

type RedisStub = {
  store: Map<string, string>;
  failNext: boolean;
};
const redisStub: RedisStub = { store: new Map(), failNext: false };

const redisMock = {
  redis: {
    async get(key: string) {
      if (redisStub.failNext) {
        redisStub.failNext = false;
        throw new Error("redis down");
      }
      return redisStub.store.get(key) ?? null;
    },
    async incr(key: string) {
      const next = Number(redisStub.store.get(key) ?? "0") + 1;
      redisStub.store.set(key, String(next));
      return next;
    },
    async expire(_key: string, _seconds: number) {
      return 1;
    },
    async set(key: string, value: string, ..._rest: unknown[]) {
      redisStub.store.set(key, value);
      return "OK";
    },
  },
  RedisKeys: realRedis.RedisKeys,
};

// mock.module 必须在被测模块 import **之前**注册（与 user-keys 测试同一模式）。
// 副作用提醒：这是进程级替换。本文件把 db/redis 的**全部**导出面都补齐了
// （redis 的 RedisKeys 直接转发真模块），同进程后续加载的测试文件拿到的
// 替身仍是可用的，见 redisStub 上方的批注。
mock.module(new URL("../../db.ts", import.meta.url).pathname, () => ({ db: dbStub }));
mock.module(new URL("../../redis.ts", import.meta.url).pathname, () => redisMock);

// 复用 user-keys 测试的初始化顺序：db/redis 替身注册完，再 import 被测模块。
const cred = await import("../node-credential.ts");
const state = await import("../node-state.ts");

// 把 console 也钉住：断言「token 不写日志」需要能看见被测模块的任何 console 调用。
// 注意：mock.module("console", …) 是进程级副作用，会污染同一进程内后续加载的
// 其他测试文件。所以这里**不** mock console，改成在用例内部临时替换
// globalThis.console，用例结束再恢复（见 captureConsole）。
type ConsoleFn = (...args: unknown[]) => void;

function captureConsole(): { lines: () => string[]; release: () => void } {
  const originals = new Map<string, ConsoleFn>();
  const lines: string[] = [];
  const names = ["log", "info", "warn", "error", "debug"];
  for (const name of names) {
    const fn = (console as unknown as Record<string, ConsoleFn>)[name];
    originals.set(name, fn);
    (console as unknown as Record<string, ConsoleFn>)[name] = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
  }
  return {
    lines: () => lines,
    release: () => {
      for (const [name, fn] of originals) {
        (console as unknown as Record<string, ConsoleFn>)[name] = fn;
      }
    },
  };
}

let consoleCapture: { lines: () => string[]; release: () => void } | null = null;

beforeEach(() => {
  resetState();
  redisStub.store.clear();
  redisStub.failNext = false;
});

/* ------------------------------------------------------------------ */
/* 纯函数                                                               */
/* ------------------------------------------------------------------ */

describe("hashNodeCredential / credentialEquals", () => {
  test("sha256 hex：64 个小写十六进制字符，且与明文可配平", () => {
    const plain = cred.generateNodeCredential();
    expect(cred.hashNodeCredential(plain)).toMatch(/^[0-9a-f]{64}$/);
    expect(cred.hashNodeCredential(plain)).toBe(sha256(plain));
  });

  test("同一输入恒定，不同输入必定不同", () => {
    expect(cred.hashNodeCredential("a")).toBe(cred.hashNodeCredential("a"));
    expect(cred.hashNodeCredential("a")).not.toBe(cred.hashNodeCredential("b"));
  });

  test("恒定时间比较：长度不同直接 false（不会抛错）", () => {
    expect(cred.credentialEquals("abc", "abc")).toBe(true);
    expect(cred.credentialEquals("abc", "abcd")).toBe(false);
    expect(cred.credentialEquals("", "x")).toBe(false);
  });

  test("生成器：每次不同，base64url 安全（无 + / =，适合 Authorization 头）", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const c = cred.generateNodeCredential();
      expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(50);
  });
});

describe("decideNodeAuth — 三条硬规则", () => {
  const hash = sha256("plain-a");

  test("哈希命中 + 未撤销 → 放行", () => {
    expect(decideOk({ node_credential_hash: hash, credential_revoked: false }, hash)).toBe(true);
  });

  test("A token 不能冒充 B：哈希不等一律拒（即使行存在）", () => {
    const rowB = { node_credential_hash: sha256("plain-b"), credential_revoked: false };
    const d = cred.decideNodeAuth(rowB, hash);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("invalid_credential");
  });

  test("revoked 优先级最高：撤销后连正确明文也拒", () => {
    const row = { node_credential_hash: hash, credential_revoked: true };
    const d = cred.decideNodeAuth(row, hash);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("revoked");
  });

  test("从未签发（hash 为 null）→ 拒绝，且不回落", () => {
    const d = cred.decideNodeAuth({ node_credential_hash: null, credential_revoked: false }, hash);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("invalid_credential");
  });

  test("行不存在 → 拒绝", () => {
    const d = cred.decideNodeAuth(null, hash);
    expect(d.ok).toBe(false);
  });
});

/** decideNodeAuth ok=true 的类型收窄小工具。 */
function decideOk(
  row: { node_credential_hash: string | null; credential_revoked: boolean },
  hash: string,
): boolean {
  return cred.decideNodeAuth(row, hash).ok === true;
}

/* ------------------------------------------------------------------ */
/* 签发 / 轮换 / 撤销                                                   */
/* ------------------------------------------------------------------ */

describe("issueNodeCredential", () => {
  test("hash at rest：DB 落 sha256 hex，明文只在返回值里", async () => {
    const node = seedNode();
    const { plaintext } = await cred.issueNodeCredential(node.id);
    expect(plaintext).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nodes[0].node_credential_hash).toBe(sha256(plaintext));
    // DB 全量 dump 里不含明文。
    const dump = JSON.stringify(nodes);
    expect(dump).not.toContain(plaintext);
    // 写入记录里同样不含明文。
    expect(JSON.stringify(writes)).not.toContain(plaintext);
  });

  test("重复签发已持有有效凭据的节点 → 409 credential_exists，且不动旧凭据", async () => {
    const node = seedNode();
    const first = await cred.issueNodeCredential(node.id);
    await expect(cred.issueNodeCredential(node.id)).rejects.toMatchObject({
      code: "credential_exists",
      status: 409,
    });
    // 旧凭据仍然有效（没有被动过）。
    expect(nodes[0].node_credential_hash).toBe(sha256(first.plaintext));
  });

  test("撤销后可以重新签发（revoked 的节点不挡 issue）", async () => {
    const node = seedNode();
    const first = await cred.issueNodeCredential(node.id);
    await cred.revokeNodeCredential(node.id);
    const second = await cred.issueNodeCredential(node.id);
    expect(second.plaintext).not.toBe(first.plaintext);
    expect(nodes[0].credential_revoked).toBe(false);
    expect((await cred.authenticateNode(second.plaintext)).ok).toBe(true);
  });

  test("节点不存在 → 404", async () => {
    await expect(cred.issueNodeCredential(999)).rejects.toMatchObject({
      code: "node_not_found",
      status: 404,
    });
  });

  test("哈希唯一性冲突（两个节点被签到同一把钥匙）→ 抛 P2002", async () => {
    // 反常状态：直接手工构造两行同哈希，验证唯一守卫。
    const a = seedNode();
    seedNode();
    await expect(
      dbStub.node.update({ where: { id: a.id }, data: { node_credential_hash: "dup" } }),
    ).resolves.toBeTruthy();
    await expect(
      dbStub.node.update({ where: { id: a.id + 1 }, data: { node_credential_hash: "dup" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("rotateNodeCredential", () => {
  test("rotate 后旧 token 失效、新 token 可用（GodD）", async () => {
    const node = seedNode();
    const first = await cred.issueNodeCredential(node.id);
    expect((await cred.authenticateNode(first.plaintext)).ok).toBe(true);

    const second = await cred.rotateNodeCredential(node.id);
    expect(second.plaintext).not.toBe(first.plaintext);
    const oldAuth = await cred.authenticateNode(first.plaintext);
    expect(oldAuth.ok).toBe(false);
    if (!oldAuth.ok) expect(oldAuth.reason).toBe("invalid_credential");
    const newAuth = await cred.authenticateNode(second.plaintext);
    expect(newAuth.ok).toBe(true);
  });

  test("rotate 覆盖哈希列：DB 里只剩新哈希", async () => {
    const node = seedNode();
    await cred.issueNodeCredential(node.id);
    const rotated = await cred.rotateNodeCredential(node.id);
    expect(nodes[0].node_credential_hash).toBe(sha256(rotated.plaintext));
    const dump = JSON.stringify(nodes);
    expect(dump).not.toContain(rotated.plaintext);
  });

  test("rotate 会把 credential_revoked 清掉（撤销后管理员选择轮换而不是重签）", async () => {
    const node = seedNode();
    await cred.issueNodeCredential(node.id);
    await cred.revokeNodeCredential(node.id);
    const rotated = await cred.rotateNodeCredential(node.id);
    expect(nodes[0].credential_revoked).toBe(false);
    expect((await cred.authenticateNode(rotated.plaintext)).ok).toBe(true);
  });

  test("从未签发的节点 rotate → 404（fail-closed，不静默生成）", async () => {
    const node = seedNode();
    await expect(cred.rotateNodeCredential(node.id)).rejects.toMatchObject({
      code: "node_not_found",
      status: 404,
    });
    expect(nodes[0].node_credential_hash).toBeNull();
  });
});

describe("revokeNodeCredential", () => {
  test("revoked token 不能重连（GodD）", async () => {
    const node = seedNode();
    const { plaintext } = await cred.issueNodeCredential(node.id);
    expect((await cred.authenticateNode(plaintext)).ok).toBe(true);

    await cred.revokeNodeCredential(node.id);
    const after = await cred.authenticateNode(plaintext);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("revoked");
  });

  test("撤销保留哈希 + 置 revoked：旧钥匙再来敲门报的是 revoked 而不是瞎猜", async () => {
    const node = seedNode();
    const { plaintext } = await cred.issueNodeCredential(node.id);
    await cred.revokeNodeCredential(node.id);
    // 哈希留着（sha256(32 字节)；暴力反推不可行），但 refused 键明说「撤销」。
    expect(nodes[0].node_credential_hash).toBe(sha256(plaintext));
    const after = await cred.authenticateNode(plaintext);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("revoked");
  });

  test("节点不存在 → 404", async () => {
    await expect(cred.revokeNodeCredential(999)).rejects.toMatchObject({ status: 404 });
  });
});

/* ------------------------------------------------------------------ */
/* 认证（身份归属 + 防爆破 + 无回落）                                    */
/* ------------------------------------------------------------------ */

describe("authenticateNode", () => {
  test("A token 不能冒充 B：凭证绑定单节点，scope 由该节点组归属派生", async () => {
    const a = seedNode({ node_id: "node-a", node_group: { workspace_id: 42, is_shared: false } });
    const b = seedNode({ node_id: "node-b", node_group: { workspace_id: 43, is_shared: false } });
    const aKey = await cred.issueNodeCredential(a.id);
    const bKey = await cred.issueNodeCredential(b.id);

    const aAuth = await cred.authenticateNode(aKey.plaintext);
    expect(aAuth.ok).toBe(true);
    if (aAuth.ok) {
      expect(aAuth.node_id).toBe(a.id);
      expect(aAuth.scope).toBe(42); // A 的 workspace，不是 B 的
    }

    const bAuth = await cred.authenticateNode(bKey.plaintext);
    if (bAuth.ok) {
      expect(bAuth.node_id).toBe(b.id);
      expect(bAuth.scope).toBe(43);
    }

    // 拿 A 的明文查不到 B：一次查找只可能命中一行（哈希唯一列）。
    expect(nodes.filter((n) => n.node_credential_hash === sha256(aKey.plaintext))).toHaveLength(1);
  });

  test("平台共享节点组折叠到 GLOBAL_SCOPE(0)", async () => {
    const shared = seedNode({ node_group: { workspace_id: 7, is_shared: true } });
    const key = await cred.issueNodeCredential(shared.id);
    const auth = await cred.authenticateNode(key.plaintext);
    if (auth.ok) expect(auth.scope).toBe(0);
  });

  test("从未签发凭据的节点：任何明文都认证不了（不回落 node_group.token）", async () => {
    seedNode({ node_id: "legacy" });
    const auth = await cred.authenticateNode("the-group-token-itself");
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.reason).toBe("invalid_credential");
  });

  test("空字符串 / 无意义输入 → 拒绝，不抛错", async () => {
    expect((await cred.authenticateNode("")).ok).toBe(false);
    expect((await cred.authenticateNode(" ")).ok).toBe(false);
    expect((await cred.authenticateNode("x".repeat(43))).ok).toBe(false);
  });

  test("认证失败留痕：credential_last_rejected_at 被写上", async () => {
    const node = seedNode();
    const { plaintext } = await cred.issueNodeCredential(node.id);
    await cred.revokeNodeCredential(node.id);
    await cred.authenticateNode(plaintext);
    expect(nodes[0].credential_last_rejected_at).toBeInstanceOf(Date);
  });

  test("撤销后旧 token 敲门：写入 rejected 时间戳（rotate 后则无从归因——哈希已被覆盖）", async () => {
    const node = seedNode();
    const { plaintext } = await cred.issueNodeCredential(node.id);
    await cred.revokeNodeCredential(node.id);
    // 撤销保留哈希 → 旧钥敲门仍能定位到那一行 → 留痕供管理员看见。
    expect((await cred.authenticateNode(plaintext)).ok).toBe(false);
    expect(nodes[0].credential_last_rejected_at).toBeInstanceOf(Date);
    // 旋转覆盖哈希后，旧明文再也定位不到行：不是 bug，留痕需要有主。
    await cred.revokeNodeCredential(node.id);
    // 重新签发一把，再 rotate 它，然后用旧钥敲门：查无此行 → 拒绝 + 无留痕。
    const key2 = await cred.issueNodeCredential(node.id);
    await cred.rotateNodeCredential(node.id);
    nodes[0].credential_last_rejected_at = null;
    expect((await cred.authenticateNode(key2.plaintext)).ok).toBe(false);
    expect(nodes[0].credential_last_rejected_at).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* token 不写日志                                                        */
/* ------------------------------------------------------------------ */

describe("token 不写日志", () => {
  test("签发 / 轮换 / 撤销 / 认证全流程：console 输出里没有明文", async () => {
    consoleCapture = captureConsole();
    try {
      const node = seedNode();
      const issued = await cred.issueNodeCredential(node.id);
      const rotated = await cred.rotateNodeCredential(node.id);
      await cred.revokeNodeCredential(node.id);
      // 旧明文（撤销/轮换后的失效钥）继续敲门：最可能触发日志的路径。
      await cred.authenticateNode(issued.plaintext);
      await cred.authenticateNode(rotated.plaintext);
      await state.submitStateReport(bearer(rotated.plaintext), VALID_REPORT);

      const consoleLines = consoleCapture.lines();
      // 被测模块一次 console 都不该调（连正常日志也不行，理由见 node-credential.ts）。
      expect(consoleLines).toHaveLength(0);
      expect(consoleLines.join("\n")).not.toContain(issued.plaintext);
      expect(consoleLines.join("\n")).not.toContain(rotated.plaintext);
    } finally {
      consoleCapture!.release();
      consoleCapture = null;
    }
    });

  test("Redis 防爆破键用的是哈希，不是明文", async () => {
    const node = seedNode();
    const { plaintext } = await cred.issueNodeCredential(node.id);
    await cred.authenticateNode(plaintext);
    // 键里必须只有 sha256；明文不出现在任何 Redis key 中。
    for (const key of redisStub.store.keys()) {
      expect(key).toContain(sha256(plaintext));
      expect(key).not.toContain(plaintext);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 防爆破                                                               */
/* ------------------------------------------------------------------ */

describe("认证防爆破（Redis 计数 + 封禁）", () => {
  test("同一指纹连续失败超过阈值 → blocked 封禁", async () => {
    const node = seedNode();
    const { plaintext } = await cred.issueNodeCredential(node.id);
    await cred.revokeNodeCredential(node.id);
    // 一直用同一把（已失效的）钥匙敲门。
    let lastReason = "";
    for (let i = 0; i < cred.NODE_AUTH_MAX_FAILURES + 2; i++) {
      const r = await cred.authenticateNode(plaintext);
      lastReason = r.ok ? "ok" : r.reason;
    }
    expect(lastReason).toBe("blocked");
  });

  test("封禁按指纹：重新签发的新凭据是不同指纹，不受旧指纹封禁影响", async () => {
    const node = seedNode();
    const key = await cred.issueNodeCredential(node.id);
    await cred.revokeNodeCredential(node.id);
    for (let i = 0; i < cred.NODE_AUTH_MAX_FAILURES + 2; i++) {
      await cred.authenticateNode(key.plaintext); // 旧指纹把爆破计数刷满
    }
    // 封禁键是 sha256(明文) —— 新钥是新指纹，爆破者拿新钥=b
    // 等于换钥匙，本来就不该被旧指纹的封禁挡住；反之，拿旧明文继续试仍然 blocked。
    const second = await cred.issueNodeCredential(node.id);
    const oldR = await cred.authenticateNode(key.plaintext);
    expect(oldR.ok).toBe(false);
    if (!oldR.ok) expect(oldR.reason).toBe("blocked");
    // 新凭据不受旧指纹封禁影响（凭据本身是有效的）。
    const newR = await cred.authenticateNode(second.plaintext);
    expect(newR.ok).toBe(true);
  });

  test("不同指纹互不干扰（封禁不误伤别的节点）", async () => {
    const victim = seedNode();
    const bystander = seedNode();
    const vKey = await cred.issueNodeCredential(victim.id);
    const bKey = await cred.issueNodeCredential(bystander.id);
    await cred.revokeNodeCredential(victim.id);
    for (let i = 0; i < cred.NODE_AUTH_MAX_FAILURES + 2; i++) {
      await cred.authenticateNode(vKey.plaintext);
    }
    // 旁观节点照样认证成功。
    expect((await cred.authenticateNode(bKey.plaintext)).ok).toBe(true);
  });

  test("Redis 故障：封禁检查失败也继续走 DB 判定（fail-open 到认证，不 fail-open 认证本身）", async () => {
    const node = seedNode();
    const key = await cred.issueNodeCredential(node.id);
    redisStub.failNext = true; // 第一次 get 抛错
    const auth = await cred.authenticateNode(key.plaintext);
    expect(auth.ok).toBe(true); // 认证照常，凭据本身没坏
  });
});

/* ------------------------------------------------------------------ */
/* 状态上报                                                             */
/* ------------------------------------------------------------------ */

const VALID_REPORT = {
  version: "0.13.22",
  role: "BOTH",
  tunnels: [
    {
      id: "t-1",
      mode: "relay",
      ingress_port: 8443,
      egress_port: 30001,
      revision: 17,
      remote_host: "10.0.0.2",
      remote_port: 80,
    },
    {
      id: "t-2",
      mode: "direct",
      ingress_port: 9443,
      revision: 18,
      // Agent 侧字段名是 host（forwarder.Target），不是 address。
      targets: [{ host: "10.0.0.2", port: 80, weight: 1 }],
    },
  ],
  used_ports: [8443, 30001, 9443],
  egress_pools: { "t-1": { strategy: "round", targets: ["10.0.0.2:80"] } },
  reported_revision: 18,
  last_error: null,
};

function bearer(plaintext: string): string {
  return `Bearer ${plaintext}`;
}

describe("validateStateReport", () => {
  test("合法载荷通过，字段原样带出", () => {
    const r = state.validateStateReport(VALID_REPORT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.version).toBe("0.13.22");
      expect(r.report.tunnels).toHaveLength(2);
      expect(r.report.used_ports).toEqual([8443, 30001, 9443]);
      expect(r.report.reported_revision).toBe(18);
    }
  });

  test("空对象合法（Agent 可能刚启动、啥都没报）", () => {
    expect(state.validateStateReport({}).ok).toBe(true);
  });

  test("坏形状一律拒绝（fail-closed）", () => {
    expect(state.validateStateReport(null).ok).toBe(false);
    expect(state.validateStateReport("string").ok).toBe(false);
    expect(state.validateStateReport([]).ok).toBe(false);
    for (const bad of [
      { version: 1 },
      { role: 2 },
      { tunnels: "no" },
      { tunnels: [{}] }, // 缺 id
      { tunnels: [{ id: "x", ingress_port: "80" }] }, // 端口类型错
      { used_ports: "80" },
      { used_ports: [8443, "9443"] },
      { egress_pools: [] },
      { egress_pools: { "t-1": { strategy: "round" } } }, // 缺 targets
      { egress_pools: { "t-1": { targets: [] } } }, // 缺 strategy
      { reported_revision: "17" },
      { last_error: 5 },
      // targets 必须是数组，且每项 port 是数字（Agent 侧字段是 host 不是 address）。
      { tunnels: [{ id: "x", targets: "no" }] },
      { tunnels: [{ id: "x", targets: [null] }] },
      { tunnels: [{ id: "x", targets: [{ host: "10.0.0.2", port: "80" }] }] },
      // 但 host 缺失不拦：Agent 可能只报了 id + 端口，形状演进容忍。
    ]) {
      const r = state.validateStateReport(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBeTruthy();
    }
  });

  test("targets 容忍新旧形状（address / host 都收，缺 host 不拦）", () => {
    expect(state.validateStateReport({ tunnels: [{ id: "x", targets: [{ host: "1.2.3.4", port: 80 }] }] }).ok).toBe(true);
    expect(state.validateStateReport({ tunnels: [{ id: "x", targets: [{ address: "1.2.3.4", port: 80 }] }] }).ok).toBe(true);
    expect(state.validateStateReport({ tunnels: [{ id: "x", targets: [{}] }] }).ok).toBe(true);
    expect(state.validateStateReport({ tunnels: [{ id: "x", targets: [] }] }).ok).toBe(true);
  });

  test("last_error 允许 null（无错误是合法状态）", () => {
    const r = state.validateStateReport({ last_error: null });
    expect(r.ok).toBe(true);
  });

  test("未知顶层字段不拒绝（快照形状演进：载荷允许带 WK 字段）", () => {
    const r = state.validateStateReport({ ...VALID_REPORT, future_field: { a: 1 } });
    expect(r.ok).toBe(true);
  });
});

describe("extractBearerCredential", () => {
  test("Bearer <token> 抽取；大小写不敏感的头名由 HTTP 层处理", () => {
    expect(state.extractBearerCredential("Bearer abc")).toBe("abc");
    expect(state.extractBearerCredential("bearer abc")).toBe("abc");
    expect(state.extractBearerCredential("  Bearer   abc  ")).toBe("abc");
  });

  test("非 Bearer / 空值 / 缺失 → null", () => {
    expect(state.extractBearerCredential(null)).toBeNull();
    expect(state.extractBearerCredential("")).toBeNull();
    expect(state.extractBearerCredential("Basic dXNlcjpwYXNz")).toBeNull();
    expect(state.extractBearerCredential("Bearer ")).toBeNull();
    expect(state.extractBearerCredential("Bearer")).toBeNull();
  });
});

describe("submitStateReport", () => {
  test("合法凭据 + 合法载荷 → 落库（upsert create 路径）", async () => {
    const node = seedNode();
    const key = await cred.issueNodeCredential(node.id);
    const r = await state.submitStateReport(bearer(key.plaintext), VALID_REPORT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node_id).toBe(node.id);
      expect(r.scope).toBe(42);
    }
    const row = stateReports.get(node.id)!;
    expect(row.version).toBe("0.13.22");
    expect(row.role).toBe("BOTH");
    expect(row.reported_revision).toBe(18);
    expect(row.last_error).toBeNull();
    // 上报不该写凭据列。
    expect(JSON.stringify(row)).not.toContain(key.plaintext);
    expect(JSON.stringify(row)).not.toContain(sha256(key.plaintext));
  });

  test("同一节点第二次上报走 update（每节点一行，不是时序追加）", async () => {
    const node = seedNode();
    const key = await cred.issueNodeCredential(node.id);
    await state.submitStateReport(bearer(key.plaintext), VALID_REPORT);
    await state.submitStateReport(bearer(key.plaintext), { ...VALID_REPORT, reported_revision: 19 });

    expect(stateReports.size).toBe(1);
    expect(stateReports.get(node.id)!.reported_revision).toBe(19);
    const ops = writes.filter((w) => w.model === "nodeStateReport").map((w) => w.op);
    expect(ops).toEqual(["create", "update"]);
  });

  test("缺 Authorization → 401 missing_credential，不落库", async () => {
    const r = await state.submitStateReport(null, VALID_REPORT);
    expect(r).toEqual({ ok: false, status: 401, reason: "missing_credential" });
    expect(writes.filter((w) => w.model === "nodeStateReport")).toHaveLength(0);
  });

  test("revoked token 上报 → 401 revoked，不落库", async () => {
    const node = seedNode();
    const key = await cred.issueNodeCredential(node.id);
    await cred.revokeNodeCredential(node.id);
    const r = await state.submitStateReport(bearer(key.plaintext), VALID_REPORT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.reason).toBe("revoked");
    }
    expect(stateReports.has(node.id)).toBe(false);
  });

  test(" rotate 后旧 token 上报 → 401（GodD：旧 token 什么都不该能做）", async () => {
    const node = seedNode();
    const first = await cred.issueNodeCredential(node.id);
    await cred.rotateNodeCredential(node.id);
    const r = await state.submitStateReport(bearer(first.plaintext), VALID_REPORT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  test("坏形状 → 400，且不写库", async () => {
    const node = seedNode();
    const key = await cred.issueNodeCredential(node.id);
    const r = await state.submitStateReport(bearer(key.plaintext), { tunnels: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(stateReports.has(node.id)).toBe(false);
  });

  test("A token 上报落成 A 自己，不会串到 B 的节点上", async () => {
    const a = seedNode({ node_id: "a" });
    const b = seedNode({ node_id: "b" });
    const aKey = await cred.issueNodeCredential(a.id);
    const bKey = await cred.issueNodeCredential(b.id);
    await state.submitStateReport(bearer(aKey.plaintext), VALID_REPORT);
    expect(stateReports.has(a.id)).toBe(true);
    expect(stateReports.has(b.id)).toBe(false);
    // B 再上报不会覆盖 A 的行（upsert 键是 node_id 数字主键）。
    await state.submitStateReport(bearer(bKey.plaintext), { ...VALID_REPORT, role: "EGRESS" });
    expect(stateReports.get(a.id)!.role).toBe("BOTH");
    expect(stateReports.get(b.id)!.role).toBe("EGRESS");
  });

  test("被爆破封禁的指纹上报 → 401 blocked", async () => {
    const node = seedNode();
    const key = await cred.issueNodeCredential(node.id);
    await cred.revokeNodeCredential(node.id);
    for (let i = 0; i < cred.NODE_AUTH_MAX_FAILURES + 2; i++) {
      await state.submitStateReport(bearer(key.plaintext), VALID_REPORT);
    }
    const r = await state.submitStateReport(bearer(key.plaintext), VALID_REPORT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked");
  });
});

/* ------------------------------------------------------------------ */
/* reconnect snapshot                                                   */
/* ------------------------------------------------------------------ */

describe("reconnect snapshot", () => {
  test("上报后能取回本节点那份快照", async () => {
    const node = seedNode();
    const key = await cred.issueNodeCredential(node.id);
    await state.submitStateReport(bearer(key.plaintext), VALID_REPORT);
    const snap = await state.loadNodeSnapshot(node.id);
    expect(snap).not.toBeNull();
    expect(snap!.version).toBe("0.13.22");
    expect(snap!.reported_revision).toBe(18);
  });

  test("从未上报 → null（新节点 / 刚签发凭据）", async () => {
    const node = seedNode();
    expect(await state.loadNodeSnapshot(node.id)).toBeNull();
  });

  test("buildReconnectSnapshot：不含 reported_at 之类面板内部字段", async () => {
    const node = seedNode();
    const key = await cred.issueNodeCredential(node.id);
    await state.submitStateReport(bearer(key.plaintext), VALID_REPORT);
    const snap = await state.buildReconnectSnapshot(node.id);
    expect(snap).not.toBeNull();
    expect(Object.keys(snap!).sort()).toEqual(
      ["egress_pools", "reported_revision", "role", "tunnels", "used_ports", "version"].sort(),
    );
    // 绝不含凭据痕迹。
    expect(JSON.stringify(snap)).not.toContain(sha256(key.plaintext));
  });

  test("空数组原样回（Agent「现在没有隧道」= 有效状态）", async () => {
    const node = seedNode();
    const key = await cred.issueNodeCredential(node.id);
    await state.submitStateReport(bearer(key.plaintext), { tunnels: [], used_ports: [] });
    const snap = await state.buildReconnectSnapshot(node.id);
    expect(snap).not.toBeNull();
    expect(snap!.tunnels).toEqual([]);
    expect(snap!.used_ports).toEqual([]);
  });

  test("指纹：内容变化则指纹变，重复上报同内容则不变", async () => {
    const node = seedNode();
    const key = await cred.issueNodeCredential(node.id);
    await state.submitStateReport(bearer(key.plaintext), VALID_REPORT);
    const fp1 = state.snapshotFingerprint(await state.loadNodeSnapshot(node.id));
    await state.submitStateReport(bearer(key.plaintext), VALID_REPORT);
    const fp2 = state.snapshotFingerprint(await state.loadNodeSnapshot(node.id));
    await state.submitStateReport(bearer(key.plaintext), { ...VALID_REPORT, reported_revision: 19 });
    const fp3 = state.snapshotFingerprint(await state.loadNodeSnapshot(node.id));
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fp3);
  });

  test("指纹：空快照 = 空串", () => {
    expect(state.snapshotFingerprint(null)).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* NAT Agent 只靠出站                                                    */
/* ------------------------------------------------------------------ */

describe("NAT Agent 只靠出站连接工作", () => {
  test("服务模块不 import 任何传输层（无 http / socket.io / net）", async () => {
    const credSrc = await Bun.file(
      new URL("../node-credential.ts", import.meta.url).pathname,
    ).text();
    const stateSrc = await Bun.file(new URL("../node-state.ts", import.meta.url).pathname).text();
    for (const src of [credSrc, stateSrc]) {
      expect(src).not.toMatch(/from "(node:)?(net|http|https|dgram|socket\.io)"/);
      expect(src).not.toMatch(/\blisten\s*\(/);
    }
  });

  test("只 export 纯函数/服务函数，没有 Server / Transport 构造器", () => {
    for (const [modName, v] of [["node-credential", cred] as const, ["node-state", state] as const]) {
      for (const [name, exported] of Object.entries(v)) {
        if (typeof exported === "function") {
          const src = Function.prototype.toString.call(exported);
          // 服务模块只准导出「函数」（async 或普通）。class 会把实例绑在模块上，
          // 那是 service locator 的形状；NodeCredentialError 是唯一例外（错误类型）。
          if (src.startsWith("class ") && name !== "NodeCredentialError") {
            throw new Error(`${modName} exported class ${name}`);
          }
        } else if (exported !== null && typeof exported === "object") {
          throw new Error(`${modName} exported object ${name}`);
        }
        expect(name).not.toMatch(/server|transport|listen/i);
      }
    }
  });
});
