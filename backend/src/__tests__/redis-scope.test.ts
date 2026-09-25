/**
 * TEN-02：Redis key 作用域（`ws:<scope>:` 前缀）+ 跨租户隔离验证。
 *
 * 这些断言是「规范」的可执行版本：
 *   · 任何 Redis key 都必须带 `ws:<scope>:` 前缀；
 *   · 同一个资源 id 在不同 scope 下必须是不同 key（否则两个租户的同 ID 资源
 *     会撞在同一个键上，互相覆盖心跳/指纹/离线标记/端口表）；
 *   · 全局共享的 key（系统配置、支付回调、token 自作用域）走 `ws:global:`；
 *   · key 的解析必须与生成同源（worker 扫描用的是同一套解析器）。
 *
 * 为什么值得单测：读取方（worker SCAN、config-generator、offline-detector）
 * 拿到的只是一串字符串，拼错一段不会报错，只会**静默读到别的租户数据**。
 * 键位的正确性无法靠运行期发现，只能在这层用断言钉住。
 *
 * 本文件用 Bun 的 `mock.module` 屏蔽 env/redis 客户端，避免真实连接。
 */
import { test, expect, describe, mock } from "bun:test";

const ROOT = new URL("..", import.meta.url).pathname;

// env.ts 顶部会 fail-fast 校验 DATABASE_URL / AUTH_SECRET 等，屏蔽掉。
mock.module(`${ROOT}/env.ts`, () => ({
  env: {
    redisUrl: "redis://127.0.0.1:6399/0",
    databaseUrl: "mysql://x/y",
    licenseType: "business",
    siteUrl: "http://127.0.0.1:8788",
  },
}));

// redis.ts 顶层就 `new Redis(...)` 并连接；换成惰性占位，只测 key 生成。
mock.module("ioredis", () => ({
  default: class FakeRedis {
    on() {}
    async ping() {
      return "PONG";
    }
  },
}));

const {
  GLOBAL_SCOPE,
  GLOBAL_SCOPE_TAG,
  scopedKey,
  parseScopedKey,
  scopedPattern,
  scopeId,
  scopeTag,
  configHashKey,
  outListenKey,
  trafficBufferPrefix,
  observerBufferKey,
  aliveGroupsKey,
  registerBlockKey,
  nodeRegisterBlockKey,
  nodeScope,
  portLeaseLockKey,
  portLeaseLockPattern,
  parsePortLeaseLockKey,
  heartbeatKey,
  heartbeatPattern,
  parseHeartbeatKey,
  disconnectMarkerKey,
  offlinePattern,
  parseDisconnectMarkerKey,
  socketRoom,
  parseSocketRoom,
  classifyGroupForWorkspace,
  isGroupUsableByWorkspace,
  isGroupOwnedByWorkspace,
  tunnelBelongsToWorkspace,
} = await import("../tenant-scope.ts");

/* ================================================================== */
/* 前缀规范                                                            */
/* ================================================================== */

describe("scopedKey 前缀规范", () => {
  test("租户 key 形如 ws:<workspaceId>:<segments>", () => {
    expect(scopedKey(7, "node", 3, "n1", "heartbeat")).toBe("ws:7:node:3:n1:heartbeat");
    expect(scopedKey(1, "license")).toBe("ws:1:license");
  });

  test("0/null/undefined/非法 scope → ws:global（显式的全局选择）", () => {
    expect(scopedKey(0, "license")).toBe(`ws:${GLOBAL_SCOPE_TAG}:license`);
    expect(scopedKey(null, "license")).toBe(`ws:${GLOBAL_SCOPE_TAG}:license`);
    expect(scopedKey(undefined, "license")).toBe(`ws:${GLOBAL_SCOPE_TAG}:license`);
    expect(scopedKey(-5, "license")).toBe(`ws:${GLOBAL_SCOPE_TAG}:license`);
    expect(scopedKey(1.5, "license")).toBe(`ws:${GLOBAL_SCOPE_TAG}:license`);
  });

  test("每个 key 都带 ws: 前缀（没有任何裸名 key）", () => {
    const keys = [
      scopedKey(7, "node_group", "config_hash"),
      scopedKey(7, "tunnel", "out_listen"),
      scopedKey(7, "tunnel", "traffic"),
      scopedKey(0, "license"),
      scopedKey(0, "register_block", "tok"),
    ];
    for (const k of keys) {
      expect(k.startsWith("ws:")).toBe(true);
      // 前缀必须紧跟一个非空段（scope tag），不能是 "ws:" 直接结束或空 tag
      expect(/^ws:(global|\d+):.+$/.test(k)).toBe(true);
    }
  });

  test("没有任何业务 key 落在无作用域（裸名）形态", () => {
    // 无作用域的键 = 不以 `ws:` 开头、或 scope 段为空。这些正是上个周期的裸名键
    // （`license` / `tunnel:out_listen` / `sysinfo:<gid>:<node>`），必须被规范拒绝。
    const unscoped = ["license", "tunnel:out_listen", "sysinfo:1:n1", "dc:1:7:n1", "ws:", "ws::x"];
    const scopedShape = /^ws:(global|\d+):.+$/;
    for (const k of unscoped) {
      expect(scopedShape.test(k)).toBe(false);
    }
    // 对照组：合法形态
    expect(scopedShape.test("ws:7:node:3:n1:offline")).toBe(true);
    expect(scopedShape.test("ws:global:license")).toBe(true);
  });

  test("拒绝无资源段的调用（只有 scope 不是合法 key）", () => {
    expect(() => scopedKey(7)).toThrow();
    expect(() => scopedKey(0, "")).toThrow();
  });
});

describe("段内转义（node_id 可含冒号/反斜杠）", () => {
  test("冒号被转义，不会伪造出新的段", () => {
    const k = scopedKey(1, "node", 2, "a:b", "offline");
    expect(k).toBe("ws:1:node:2:a\\:b:offline");
    expect(k.split(":").length).toBeGreaterThan(4); // 冒号在值里，不是分隔符
  });

  test("反斜杠被转义（反转义后取回原值）", () => {
    const k = scopedKey(1, "node", 2, "a\\b", "offline");
    const parsed = parseDisconnectMarkerKey(k);
    expect(parsed).not.toBeNull();
    expect(parsed!.nodeId).toBe("a\\b");
  });

  test("解析端把冒号还原成一个整体 nodeId", () => {
    const k = scopedKey(3, "node", 9, "a:b c", "offline");
    expect(parseDisconnectMarkerKey(k)).toEqual({ scope: 3, groupId: 9, nodeId: "a:b c" });
  });
});

describe("parseScopedKey / scopedPattern", () => {
  test("round-trip", () => {
    const k = scopedKey(12, "tunnel", "traffic", 99);
    expect(parseScopedKey(k)).toEqual({ scope: 12, segments: ["tunnel", "traffic", "99"] });
  });

  test("ws:global 解析为 scope 0", () => {
    expect(parseScopedKey("ws:global:license")?.scope).toBe(GLOBAL_SCOPE);
  });

  test("非法形态返回 null", () => {
    for (const bad of ["license", "ws:abc:x", "ws::x", "ws:-1:x", "ws:1:x:y", "x"]) {
      if (bad === "ws:1:x:y") continue; // 合法，单独断言
      expect(parseScopedKey(bad)).toBeNull();
    }
    expect(parseScopedKey("ws:1:x:y")).toEqual({ scope: 1, segments: ["x", "y"] });
  });

  test("scan pattern：全部 scope / 指定 scope", () => {
    expect(scopedPattern("*", "node", "*", "*", "offline")).toBe("ws:*:node:*:*:offline");
    expect(scopedPattern(7, "node", "*", "*", "offline")).toBe("ws:7:node:*:*:offline");
    expect(scopedPattern(null, "node")).toBe("ws:global:node");
  });
});

/* ================================================================== */
/* 跨租户隔离                                                          */
/* ================================================================== */

describe("TEN-02：同一资源 id 在不同租户下 key 互不相同", () => {
  test("离线标记", () => {
    expect(disconnectMarkerKey(1, 7, "n1")).not.toBe(disconnectMarkerKey(2, 7, "n1"));
    expect(disconnectMarkerKey(0, 7, "n1")).not.toBe(disconnectMarkerKey(1, 7, "n1"));
  });

  test("心跳", () => {
    expect(heartbeatKey(1, 7, "n1")).not.toBe(heartbeatKey(2, 7, "n1"));
    expect(heartbeatKey(1, 7, "n1")).not.toBe(heartbeatKey(0, 7, "n1"));
  });

  test("出口端口表 / 流量缓冲 / observer 队列 / 活跃组集合 / 指纹缓存", () => {
    expect(outListenKey(1)).not.toBe(outListenKey(2));
    expect(trafficBufferPrefix(1)).not.toBe(trafficBufferPrefix(2));
    expect(observerBufferKey(1)).not.toBe(observerBufferKey(2));
    expect(aliveGroupsKey(1)).not.toBe(aliveGroupsKey(2));
    expect(configHashKey(1)).not.toBe(configHashKey(2));
  });

  test("key 形态：租户 id 出现在第二个段", () => {
    expect(heartbeatKey(42, 7, "n1")).toBe("ws:42:node:7:n1:heartbeat");
    expect(outListenKey(42)).toBe("ws:42:tunnel:out_listen");
    expect(observerBufferKey(42)).toBe("ws:42:tunnel:observer:raw");
    expect(configHashKey(42)).toBe("ws:42:node_group:config_hash");
  });
});

describe("TEN-02：离线标记 / 心跳解析与生成同源", () => {
  test("round-trip（含 scope）", () => {
    expect(parseDisconnectMarkerKey("ws:1:node:3:Node-A:offline")).toEqual({
      scope: 1,
      groupId: 3,
      nodeId: "Node-A",
    });
    expect(parseHeartbeatKey("ws:2:node:3:Node-A:heartbeat")).toEqual({
      scope: 2,
      groupId: 3,
      nodeId: "Node-A",
    });
  });

  test("拒绝无作用域的旧形态", () => {
    // 旧的裸名形态（dc:<gid>:<node> / sysinfo:<gid>:<node>）必须被拒绝，
    // 否则 worker 会把旧键当成本租户标记，凭空翻转别的节点状态。
    expect(parseDisconnectMarkerKey("dc:3:Node-A")).toBeNull();
    expect(parseHeartbeatKey("sysinfo:3:Node-A")).toBeNull();
    expect(parseDisconnectMarkerKey("ws:3:node:1:n1:heartbeat")).toBeNull();
    expect(parseHeartbeatKey("ws:3:node:1:n1:offline")).toBeNull();
  });

  test("拒绝异形 key", () => {
    expect(parseDisconnectMarkerKey("ws:abc:node:1:n1:offline")).toBeNull();
    expect(parseDisconnectMarkerKey("ws:1:node:1:offline")).toBeNull();
    expect(parseDisconnectMarkerKey("ws:1:other:1:n1:offline")).toBeNull();
    expect(parseDisconnectMarkerKey("")).toBeNull();
    expect(parseDisconnectMarkerKey("ws:1:node:1:n1")).toBeNull();
  });

  test("scan pattern 与生成端同源", () => {
    expect(offlinePattern()).toBe("ws:*:node:*:*:offline");
    expect(heartbeatPattern()).toBe("ws:*:node:*:*:heartbeat");
    expect(offlinePattern(7)).toBe("ws:7:node:*:*:offline");
  });

  test("scan pattern 能匹配生成端产物（worker 不会漏扫）", () => {
    // redis KEYS/SCAN 的 MATCH 是 glob：`*` 匹配任意字符（跨越 `:`）。
    // 断言两个方向：新产物必须命中；旧裸名形态必须不命中。
    const globToRe = (p: string) =>
      new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    const re = globToRe(offlinePattern());
    // 租户 scope 与平台 scope（tag=`global`）都要被同一次 SCAN 覆盖：
    // 漏扫意味着平台组的离线节点永远不被翻转。
    expect(re.test(disconnectMarkerKey(1, 7, "n1"))).toBe(true);
    expect(re.test(disconnectMarkerKey(0, 7, "n1"))).toBe(true);
    // node_id 含冒号/空格（已转义）也必须命中：否则这些节点永远不被扫描。
    expect(re.test(disconnectMarkerKey(42, 3, "a:b c"))).toBe(true);
    // 旧裸名形态不应被新 pattern 命中。
    expect(re.test("dc:1:7:n1")).toBe(false);
    expect(re.test("ws:1:node:7:n1:heartbeat")).toBe(false);
  });
});

/* ================================================================== */
/* Socket room 作用域（隔离的第二条链路）                              */
/* ================================================================== */

describe("TEN-02：Socket room 带 scope", () => {
  test("room 名形如 ws:<scope>:node_group/<groupId>", () => {
    expect(socketRoom(1, 5)).toBe("ws:1:node_group/5");
    expect(socketRoom(null, 5)).toBe(`ws:${GLOBAL_SCOPE_TAG}:node_group/5`);
  });

  test("同 groupId 不同 scope → 不同 room", () => {
    expect(socketRoom(1, 5)).not.toBe(socketRoom(2, 5));
  });

  test("parseSocketRoom round-trip / 拒异形", () => {
    expect(parseSocketRoom("ws:3:node_group/8")).toEqual({ scope: 3, groupId: 8 });
    expect(parseSocketRoom(`ws:${GLOBAL_SCOPE_TAG}:node_group/8`)).toEqual({ scope: 0, groupId: 8 });
    expect(parseSocketRoom("node_group/8")).toBeNull();
    expect(parseSocketRoom("ws:3:room/8")).toBeNull();
  });
});

/* ================================================================== */
/* redis.ts 导出的工厂（业务代码唯一的取键入口）                       */
/* ================================================================== */

describe("RedisKeys 工厂（集中于 redis.ts）", () => {
  test("所有工厂产出都带 ws: 前缀", async () => {
    const { RedisKeys } = await import("../redis.ts");
    const produced = [
      RedisKeys.license,
      RedisKeys.registerBlock("tok-a"),
      RedisKeys.observerBuffer(1),
      RedisKeys.payCallback("epay"),
      RedisKeys.rateLimit("auth-login", "ip:1.2.3.4"),
      RedisKeys.userSub("sub-1"),
      RedisKeys.impersonation("tok-b"),
      RedisKeys.topupOrderLock(9),
      RedisKeys.nodeGroupConfigHash(1),
      RedisKeys.aliveNodeGroups(1),
    ];
    for (const k of produced) {
      expect(k.startsWith("ws:")).toBe(true);
      expect(k).not.toContain("::");
      expect(k).not.toMatch(/:$/); // 不能以冒号结尾（空段）
    }
  });

  test("全局/平台段键不含租户 id 段", async () => {
    const { RedisKeys } = await import("../redis.ts");
    // license 是实例级配置
    expect(RedisKeys.license).toBe("ws:global:license");
    // 注册防爆破：token 自作用域
    expect(RedisKeys.registerBlock("tok-a")).toBe("ws:global:register_block:tok-a");
    expect(RedisKeys.registerBlock("tok-a")).not.toBe(RedisKeys.registerBlock("tok-b"));
    // 账户数据
    expect(RedisKeys.userSub("abc")).toBe("ws:global:user:abc:id");
    expect(RedisKeys.impersonation("abc")).toBe("ws:global:impersonation:abc");
    // 限流计数 / 支付回调：值只是计数或留痕
    expect(RedisKeys.rateLimit("r", "ip:1")).not.toBe(RedisKeys.rateLimit("r", "ip:2"));
    expect(RedisKeys.payCallback("epay")).toBe("ws:global:pay:callback:epay");
  });

  test("租户段键带 workspace id", async () => {
    const { RedisKeys } = await import("../redis.ts");
    expect(RedisKeys.observerBuffer(3)).toBe("ws:3:tunnel:observer:raw");
    expect(RedisKeys.nodeGroupConfigHash(3)).toBe("ws:3:node_group:config_hash");
    expect(RedisKeys.aliveNodeGroups(3)).toBe("ws:3:alive_groups");
    // 同 workspace → 同 key（否则缓存永远命中不了）
    expect(RedisKeys.observerBuffer(3)).toBe(RedisKeys.observerBuffer(3));
  });
});

/* ================================================================== */
/* 节点组 / 隧道作用域判定（fail-closed）                              */
/* ================================================================== */

describe("节点组可用性判定", () => {
  const own = { id: 1, workspace_id: 10 };
  const foreign = { id: 2, workspace_id: 20 };
  const shared = { id: 3, workspace_id: 30, is_shared: true };
  const orphan = { id: 4, workspace_id: null };

  test("own 可用且可管理", () => {
    expect(isGroupUsableByWorkspace(own, 10)).toBe(true);
    expect(isGroupOwnedByWorkspace(own, 10)).toBe(true);
    expect(classifyGroupForWorkspace(own, 10)).toBe("own");
  });

  test("他租户私有组：不可用、不可管理、classified cross_tenant", () => {
    expect(isGroupUsableByWorkspace(foreign, 10)).toBe(false);
    expect(isGroupOwnedByWorkspace(foreign, 10)).toBe(false);
    expect(classifyGroupForWorkspace(foreign, 10)).toBe("cross_tenant");
  });

  test("平台共享组：只读可用、不可管理", () => {
    expect(isGroupUsableByWorkspace(shared, 10)).toBe(true);
    expect(isGroupOwnedByWorkspace(shared, 10)).toBe(false);
    expect(classifyGroupForWorkspace(shared, 10)).toBe("shared");
  });

  test("无归属组：不归属任何租户（fail-closed）", () => {
    expect(isGroupUsableByWorkspace(orphan, 10)).toBe(false);
    expect(isGroupOwnedByWorkspace(orphan, 10)).toBe(false);
    expect(classifyGroupForWorkspace(orphan, 10)).toBe("cross_tenant");
  });

  test("scope 折叠：孤儿/platform → 0，且与任一真实租户不同", () => {
    expect(scopeId(orphan.workspace_id)).toBe(GLOBAL_SCOPE);
    expect(scopeId(shared.workspace_id)).not.toBe(GLOBAL_SCOPE); // 判定与 is_shared 解耦
    expect(scopeTag(10)).toBe("10");
    expect(scopeTag(0)).toBe(GLOBAL_SCOPE_TAG);
  });
});

describe("隧道归属判定", () => {
  test("同 workspace 才归属；null 不归属任何租户", () => {
    expect(tunnelBelongsToWorkspace({ workspace_id: 10 }, 10)).toBe(true);
    expect(tunnelBelongsToWorkspace({ workspace_id: 20 }, 10)).toBe(false);
    expect(tunnelBelongsToWorkspace({ workspace_id: null }, 10)).toBe(false);
  });
});

/* ================================================================== */
/* v3（WP1）节点侧资源作用域                                           */
/* ================================================================== */

describe("WP1：nodeScope —— 节点侧资源归属派生", () => {
  test("归属沿 Node → node_group 单向上查", () => {
    expect(nodeScope({ node_group: { workspace_id: 10 } })).toBe(10);
    expect(nodeScope({ node_group: { workspace_id: 10, is_shared: true } })).toBe(GLOBAL_SCOPE);
  });

  test("无 node_group（未 include）/ 孤儿组 → GLOBAL_SCOPE（fail-closed）", () => {
    expect(nodeScope({})).toBe(GLOBAL_SCOPE);
    expect(nodeScope({ node_group: null })).toBe(GLOBAL_SCOPE);
    expect(nodeScope({ node_group: { workspace_id: null } })).toBe(GLOBAL_SCOPE);
  });

  test("同 ID 节点在不同租户下派生出的租约锁不同", () => {
    // 否则两个租户的同 ID 节点会在同一个物理端口上互抢
    expect(portLeaseLockKey(1, "n1", 20000)).not.toBe(portLeaseLockKey(2, "n1", 20000));
    expect(portLeaseLockKey(0, "n1", 20000)).not.toBe(portLeaseLockKey(1, "n1", 20000));
  });

  test("key / pattern / parse 三段同源", () => {
    expect(portLeaseLockKey(42, "Node-A", 20000)).toBe("ws:42:node_port_lease:lock:Node-A:20000");
    expect(portLeaseLockKey(0, "Node-A", 20000)).toBe(
      `ws:${GLOBAL_SCOPE_TAG}:node_port_lease:lock:Node-A:20000`,
    );
    expect(portLeaseLockPattern()).toBe("ws:*:node_port_lease:lock:*:*");
    expect(portLeaseLockPattern(42)).toBe("ws:42:node_port_lease:lock:*:*");
    expect(parsePortLeaseLockKey("ws:42:node_port_lease:lock:Node-A:20000")).toEqual({
      scope: 42,
      nodeId: "Node-A",
      port: 20000,
    });
  });

  test("node_id 含冒号仍能正确还原（末段才是端口）", () => {
    const key = portLeaseLockKey(7, "a:b", 30000);
    expect(parsePortLeaseLockKey(key)).toEqual({ scope: 7, nodeId: "a:b", port: 30000 });
  });

  test("拒绝异形 key", () => {
    expect(parsePortLeaseLockKey("ws:1:tunnel:traffic:9")).toBeNull();
    expect(parsePortLeaseLockKey("ws:1:node_port_lease:Node-A:20000")).toBeNull();
    expect(parsePortLeaseLockKey("ws:1:node_port_lease:lock:Node-A:abc")).toBeNull();
    expect(parsePortLeaseLockKey("ws:global:node_port_lease:lock:Node-A")).toBeNull();
  });

  test("scan pattern 能命中生成端产物（reconciler 不漏扫）", () => {
    const globToRe = (p: string) =>
      new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    const re = globToRe(portLeaseLockPattern());
    expect(re.test(portLeaseLockKey(1, "n1", 20000))).toBe(true);
    expect(re.test(portLeaseLockKey(0, "n1", 20000))).toBe(true);
    expect(re.test(portLeaseLockKey(42, "a:b", 30000))).toBe(true);
    // 旧裸名形态不应被命中
    expect(re.test("port_lock:1:20000")).toBe(false);
  });

  test("节点凭据防爆破键走 global 段（身份解析前不知道租户）", () => {
    expect(nodeRegisterBlockKey("fp-1")).toBe("ws:global:node_register_block:fp-1");
    expect(nodeRegisterBlockKey("fp-1")).not.toBe(nodeRegisterBlockKey("fp-2"));
  });
});

describe("WP1：RedisKeys 工厂覆盖新键", () => {
  test("端口租约锁 / 节点防爆破键都带 ws: 前缀", async () => {
    const { RedisKeys } = await import("../redis.ts");
    const produced = [
      RedisKeys.portLeaseLock(1, "n1", 20000),
      RedisKeys.nodeRegisterBlock("fp-1"),
    ];
    for (const k of produced) {
      expect(k.startsWith("ws:")).toBe(true);
      expect(/^ws:(global|\d+):.+$/.test(k)).toBe(true);
      expect(k).not.toContain("::");
      expect(k).not.toMatch(/:$/);
    }
  });

  test("portLeaseLockScan 是 pattern，不是 key", async () => {
    const { RedisKeys } = await import("../redis.ts");
    expect(RedisKeys.portLeaseLockScan()).toContain("*");
    expect(RedisKeys.portLeaseLockScan(9)).toBe("ws:9:node_port_lease:lock:*:*");
  });
});
