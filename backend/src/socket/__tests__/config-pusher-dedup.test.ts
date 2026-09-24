import { test, expect, describe, beforeEach, mock } from "bun:test";

/**
 * `pushNodeConfig` 增量去重（Redis `node_group:config_hash`）的离线验证。
 *
 * 屏蔽 config-generator（避免 DB）、redis（可控 hash）、keys/license-sign
 * （避免真实 Fernet 与 env 密钥），用可控指纹驱动「变化 / 未变 / force」三条路径，
 * 断言 emit 次数与缓存写入。这是 DEVELOPMENT.md §7 P2「指纹去重」的回归。
 */
const ROOT = "/opt/TuneX/backend/src";

// ── 可控状态 ──
let fingerprint = "fp-1";
let jsonBody = "{\"v\":1}";

// 可控 redis hash（field=groupId, value=fingerprint）
const hash = new Map<string, string>();
let redisThrowOnGet = false;
let redisThrowOnSet = false;

mock.module(`${ROOT}/socket/config-generator.ts`, () => ({
  generateNodeConfig: async (groupId: number) => ({
    nodeGroupId: groupId,
    nodeType: "in",
    config: {},
    json: jsonBody,
    fingerprint,
  }),
}));

mock.module(`${ROOT}/redis.ts`, () => ({
  redis: {
    hget: async (_k: string, f: string) => {
      if (redisThrowOnGet) throw new Error("redis down");
      return hash.get(f) ?? null;
    },
    hset: async (_k: string, f: string, v: string) => {
      if (redisThrowOnSet) throw new Error("redis down");
      hash.set(f, v);
      return 1;
    },
    hdel: async (_k: string, f: string) => {
      hash.delete(f);
      return 1;
    },
  },
}));

mock.module(`${ROOT}/crypto/keys.ts`, () => ({ configKey: () => "test-key" }));
mock.module(`${ROOT}/services/license-sign.ts`, () => ({
  fernetEncryptWith: (_k: string, plaintext: string) => `enc:${plaintext}`,
}));

const { pushNodeConfig, getPushedFingerprint, clearConfigFingerprint, NODE_GROUP_CONFIG_HASH_KEY } =
  await import("../config-pusher.ts");

// 捕获 emit
let emitted: { room: string; event: string; args: unknown[] }[];
(globalThis as Record<string, unknown>).__io = {
  to: (room: string) => ({
    emit: (event: string, ...args: unknown[]) => {
      emitted.push({ room, event, args });
    },
  }),
};

const GROUP = 7;

function reset(override?: { fingerprint?: string }) {
  emitted = [];
  hash.clear();
  redisThrowOnGet = false;
  redisThrowOnSet = false;
  fingerprint = override?.fingerprint ?? "fp-1";
  jsonBody = "{\"v\":1}";
}

describe("pushNodeConfig 增量去重", () => {
  beforeEach(() => reset());

  test("首次（缓存缺失）→ 下发并写缓存", async () => {
    const pushed = await pushNodeConfig(GROUP);
    expect(pushed).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].room).toBe(`node_group/${GROUP}`);
    expect(emitted[0].event).toBe("config");
    expect(emitted[0].args[0]).toBe("enc:{\"v\":1}");
    expect(hash.get(String(GROUP))).toBe("fp-1");
  });

  test("指纹未变 → 跳过去重，不再 emit", async () => {
    await pushNodeConfig(GROUP); // 首次，写缓存 fp-1
    emitted = [];
    const pushed = await pushNodeConfig(GROUP); // 相同指纹
    expect(pushed).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  test("指纹变化 → 再次下发并更新缓存", async () => {
    await pushNodeConfig(GROUP);
    emitted = [];
    fingerprint = "fp-2";
    jsonBody = "{\"v\":2}";
    const pushed = await pushNodeConfig(GROUP);
    expect(pushed).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].args[0]).toBe("enc:{\"v\":2}");
    expect(hash.get(String(GROUP))).toBe("fp-2");
  });

  test("force:true 指纹未变也强制下发", async () => {
    await pushNodeConfig(GROUP); // 缓存 fp-1
    emitted = [];
    const pushed = await pushNodeConfig(GROUP, { force: true });
    expect(pushed).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  test("force:true 同样写入缓存 → 后续默认调用可被去重", async () => {
    // 先 force 下发（缓存被写为 fp-1），随后默认调用应跳过
    await pushNodeConfig(GROUP, { force: true });
    emitted = [];
    const pushed = await pushNodeConfig(GROUP);
    expect(pushed).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  test("Redis 读故障 → fail-open（视为变化，照样下发）", async () => {
    redisThrowOnGet = true;
    const pushed = await pushNodeConfig(GROUP);
    expect(pushed).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  test("Redis 写故障 → 仍下发且返回 true（写失败不阻断）", async () => {
    redisThrowOnSet = true;
    const pushed = await pushNodeConfig(GROUP);
    expect(pushed).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(hash.get(String(GROUP))).toBeUndefined();
  });

  test("Socket.IO 未初始化 → 返回 false，不抛错", async () => {
    const saved = (globalThis as Record<string, unknown>).__io;
    (globalThis as Record<string, unknown>).__io = undefined;
    try {
      expect(await pushNodeConfig(GROUP)).toBe(false);
    } finally {
      (globalThis as Record<string, unknown>).__io = saved;
    }
  });

  test("getPushedFingerprint / clearConfigFingerprint", async () => {
    await pushNodeConfig(GROUP);
    expect(await getPushedFingerprint(GROUP)).toBe("fp-1");
    await clearConfigFingerprint(GROUP);
    expect(await getPushedFingerprint(GROUP)).toBeNull();
  });

  test("key 名与原版一致", () => {
    expect(NODE_GROUP_CONFIG_HASH_KEY).toBe("node_group:config_hash");
  });
});
