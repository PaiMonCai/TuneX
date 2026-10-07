/**
 * task-46 —— 节点「可拨号地址」（`node.connect_ip`）写入面的**行为测试**。
 *
 * ── 为什么测服务而不是测路由 ──
 * `routes/nodes.ts` 的传递依赖在 import 期就会连 Redis（既有先例：
 * `routes/__tests__/nodes-projection.test.ts` 因此只做静态守卫）。所以这里：
 *   1. **行为**部分全部打在 `services/node-address.ts` 的纯函数与注入 db 缝隙的写入面上
 *      —— 它是路由与创建前置校验**共用**的那一份判据；
 *   2. 只留一条静态守卫，钉"路由确实把校验/写入委托出去、并且 PATCH 用的是 `node:manage`"，
 *      避免以后有人在路由里再写一份会漂移的判断。
 *
 * 覆盖的拒绝分支（真机同样跑过一遍，见交付报告）：非法地址 / 空白串 / 类型错误 /
 * 缺键 / 多余字段 / 节点不存在 / 清空但仍有 RELAY 依赖（fail-closed）。
 *
 * 跑法（backend 目录）：bun test src/routes/__tests__/nodes-bindings.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  NODE_ADDRESS_CODES,
  connectHostOf,
  hopAddressMissingMessage,
  isDialableHost,
  missingHopAddresses,
  normalizeConnectIpPatch,
  updateNodeConnectIp,
  type NodeAddressDb,
} from "../../services/node-address.ts";

/* ------------------------------------------------------------------ */
/* 纯校验                                                              */
/* ------------------------------------------------------------------ */

describe("connect_ip 的形状校验（PATCH 的唯一入口）", () => {
  test("接受 IPv4 / 裸 IPv6 / 主机名；多候选用逗号分隔并规范化", () => {
    expect(normalizeConnectIpPatch({ connect_ip: "172.33.0.94" })).toEqual({
      ok: true,
      value: "172.33.0.94",
    });
    expect(normalizeConnectIpPatch({ connect_ip: "2001:db8::1" })).toEqual({
      ok: true,
      value: "2001:db8::1",
    });
    expect(normalizeConnectIpPatch({ connect_ip: "edge.example.com" })).toEqual({
      ok: true,
      value: "edge.example.com",
    });
    // 多候选：去掉空白后原样保存（firstConnectIp 取第一个非空项）
    expect(normalizeConnectIpPatch({ connect_ip: " 172.33.0.94 , 172.33.0.95 " })).toEqual({
      ok: true,
      value: "172.33.0.94,172.33.0.95",
    });
    expect(isDialableHost("172.33.0.94")).toBe(true);
    expect(isDialableHost("2001:db8::1")).toBe(true);
  });

  test("拒绝：非法地址 / 带方括号的 IPv6 / 内部空白 / 下划线主机名", () => {
    for (const bad of [
      "not an ip",
      "[::1]",
      // 内部空白拒绝（首尾空白会被规范化掉 —— 见下一条）
      "172.33.0. 94",
      "172.33.0.94/24",
      "my_host.example.com",
      "-bad.example.com",
      "a".repeat(300),
    ]) {
      const result = normalizeConnectIpPatch({ connect_ip: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(NODE_ADDRESS_CODES.invalidConnectIp);
    }
  });

  test("拒绝：空白串（清空必须显式传 null）/ 类型错误 / 缺键 / 非对象", () => {
    const blank = normalizeConnectIpPatch({ connect_ip: "   " });
    expect(blank.ok).toBe(false);
    if (!blank.ok) {
      expect(blank.status).toBe(400);
      expect(blank.message).toContain("null");
    }
    expect(normalizeConnectIpPatch({ connect_ip: 42 }).ok).toBe(false);
    expect(normalizeConnectIpPatch({}).ok).toBe(false);
    expect(normalizeConnectIpPatch(null).ok).toBe(false);
    expect(normalizeConnectIpPatch([]).ok).toBe(false);
  });

  test("多余字段一律 400（否则有人会用这条路径偷改 role/区间/凭据）", () => {
    const result = normalizeConnectIpPatch({ connect_ip: "172.33.0.94", role: "ingress" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toContain("role");
      expect(result.message).toContain("各自的入口");
    }
  });

  test("null 是显式清空（校验层放行，冲突在写入层判）", () => {
    expect(normalizeConnectIpPatch({ connect_ip: null })).toEqual({ ok: true, value: null });
  });

  test("首尾空白会被规范化掉（与全仓 `.trim()` 惯例一致），不是拒绝", () => {
    expect(normalizeConnectIpPatch({ connect_ip: " 172.33.0.94 " })).toEqual({
      ok: true,
      value: "172.33.0.94",
    });
  });
});

/* ------------------------------------------------------------------ */
/* 写入面（注入 db 替身）                                                */
/* ------------------------------------------------------------------ */

interface StubRows {
  node: Record<string, unknown> | null;
  dependents: Array<{ id: number; name: string }>;
}
function stubDb(rows: StubRows) {
  const updates: Array<Record<string, unknown>> = [];
  const db: NodeAddressDb = {
    node: {
      findFirst: async () => rows.node,
      update: async (args) => {
        const input = args as { data: Record<string, unknown> };
        updates.push(input.data);
        if (rows.node) rows.node = { ...rows.node, ...input.data };
        return rows.node;
      },
    },
    tunnel: { findMany: async () => rows.dependents },
  };
  return { db, updates };
}

describe("写入面：写进去、并把冲突挡在前面", () => {
  test("正常写入：值被规范化后落库，并**回读**（响应来自回读，不是请求体）", async () => {
    const rows: StubRows = { node: { id: 14, node_id: "L46-HOP-NODE", connect_ip: null }, dependents: [] };
    const { db, updates } = stubDb(rows);
    const result = await updateNodeConnectIp(db, {
      nodeId: 14,
      workspaceId: 3,
      value: "172.33.0.94",
    });
    expect(result.ok).toBe(true);
    expect(updates).toEqual([{ connect_ip: "172.33.0.94" }]);
    if (result.ok) expect(result.node.connect_ip).toBe("172.33.0.94");
  });

  test("节点不存在 → 404 not_found，且**不写**", async () => {
    const { db, updates } = stubDb({ node: null, dependents: [] });
    const result = await updateNodeConnectIp(db, { nodeId: 999, workspaceId: 3, value: "1.2.3.4" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.code).toBe(NODE_ADDRESS_CODES.notFound);
    }
    expect(updates).toEqual([]);
  });

  test("清空地址：仍有 RELAY/三跳依赖它 ⇒ 409 connect_ip_in_use（fail-closed）并列出依赖", async () => {
    const rows: StubRows = {
      node: { id: 14, node_id: "L46-HOP-NODE", connect_ip: "172.33.0.94" },
      dependents: [
        { id: 42, name: "三跳 A" },
        { id: 43, name: "RELAY B" },
      ],
    };
    const { db, updates } = stubDb(rows);
    const result = await updateNodeConnectIp(db, { nodeId: 14, workspaceId: 3, value: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.code).toBe(NODE_ADDRESS_CODES.connectIpInUse);
      expect(result.message).toContain("#42 三跳 A");
      expect(result.message).toContain("#43 RELAY B");
      expect(result.data).toEqual({ forwards: rows.dependents });
    }
    // 关键：被拒之后**一个字都没写**
    expect(updates).toEqual([]);
  });

  test("清空地址：没有依赖 ⇒ 允许清空（写 null）", async () => {
    const rows: StubRows = { node: { id: 14, connect_ip: "172.33.0.94" }, dependents: [] };
    const { db, updates } = stubDb(rows);
    const result = await updateNodeConnectIp(db, { nodeId: 14, workspaceId: 3, value: null });
    expect(result.ok).toBe(true);
    expect(updates).toEqual([{ connect_ip: null }]);
  });
});

/* ------------------------------------------------------------------ */
/* 创建路径的前置校验（RELAY/三跳）                                      */
/* ------------------------------------------------------------------ */

describe("每一跳都要有可拨号地址（替换 502 invariant_violated）", () => {
  const hops = [
    { id: 14, name: "L46-HOP-NODE", position: "中间跳" as const, connectIp: null },
    { id: 2, name: "Integration-OUT-A-NODE", position: "出口跳" as const, connectIp: "172.33.20.20" },
  ];

  test("只挑出缺地址的那一跳（有地址的不报）", () => {
    const missing = missingHopAddresses(hops);
    expect(missing.map((hop) => hop.id)).toEqual([14]);
    expect(missingHopAddresses([{ ...hops[1]!, connectIp: "  " }]).length).toBe(1);
    expect(missingHopAddresses([hops[1]!])).toEqual([]);
  });

  test("可拨号主机：取第一个非空候选；空串 / 只有逗号 ⇒ 视为缺地址", () => {
    expect(connectHostOf(" 172.33.0.94 , 172.33.0.95 ")).toBe("172.33.0.94");
    expect(connectHostOf("")).toBeNull();
    expect(connectHostOf(" , ")).toBeNull();
    expect(connectHostOf(null)).toBeNull();
  });

  test("文案点名节点 + 说明下一步（用户拿到手就知道该干什么）", () => {
    const message = hopAddressMissingMessage(missingHopAddresses(hops));
    expect(message).toContain("中间跳「L46-HOP-NODE」(#14)");
    expect(message).toContain("connect_ip");
    expect(message).toContain("PATCH /api/nodes/:id");
    // 不再出现无从下手的旧文案
    expect(message).not.toContain("invariant_violated");
    expect(message).not.toContain("RELAY plan needs");
  });
});

/* ------------------------------------------------------------------ */
/* 路由接线守卫（只此一条静态断言，其余都是行为）                        */
/* ------------------------------------------------------------------ */

describe("路由接线（静态守卫）", () => {
  const raw = readFileSync(new URL("../nodes.ts", import.meta.url), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  test("PATCH 走 services/node-address.ts（路由里没有第二套校验/写入）", () => {
    expect(raw).toMatch(/from "\.\.\/services\/node-address\.ts"/);
    expect(code).toContain("normalizeConnectIpPatch(");
    expect(code).toContain("updateNodeConnectIp(");
    // 路由自己不再写 node.update / 不再判定 isIP
    expect(code).not.toContain("isIP(");
    expect(code).not.toContain("db.node.update");
  });

  test("PATCH 的权限动作是 node:manage（`update` 在本仓映射不到任何权限）", () => {
    const branch = raw.slice(raw.indexOf('method === "PATCH"'), raw.indexOf("c.set(\"workspace\""));
    expect(branch).toContain('action = "manage"');
    expect(branch).not.toContain('action = "update"');
  });

  test("创建路径确实调用同一份缺地址判据（否则两处会漂移）", () => {
    const service = readFileSync(
      new URL("../../services/forward-service.ts", import.meta.url),
      "utf8",
    );
    expect(service).toContain("missingHopAddresses(");
    expect(service).toContain("hopAddressMissingMessage(");
    expect(service).toContain('"hop_address_missing"');
  });
});
