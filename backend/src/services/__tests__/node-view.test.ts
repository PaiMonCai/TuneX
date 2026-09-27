/**
 * V4-WP8 §13.4.1 —— 用户侧 Node 三层状态投影（`services/node-view.ts`）。
 *
 * 这份测试回答的问题是**「用户侧 API 是否只投影后端判定」**：
 *   A. Connection 事实层：有/无凭据、撤销、心跳窗口三态齐全；
 *   B. Lifecycle 期望层：四态全部映射，且**不**被 connection 覆盖
 *      （offline 的 active 节点仍 accepts_new_business=true —— §13.4.2）；
 *   C. 准入拒绝码可区分：waiting 给 `node_waiting_install`（去安装），
 *      maintenance/disabled/retiring 各给自己的码（去改生命周期）；
 *   D. 兼容投影：`online` == `connection === "online"`，且不再自带判据；
 *   E. **静态守卫**：本投影不复制判定 —— 源码里不出现 90s 窗口、`status ===
 *      "active"` 或生命周期白名单字面量（出现即说明又抄了一份 §13.4.4 的
 *      判定），且 `deriveConnection` / `nodeAdmission` 确实被调用。
 *
 * 纯函数，无 DB / 无 Redis / 无 React，直接 `bun test` 即可。
 * 跑法（backend 目录）：bun test src/services/__tests__/node-view.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { projectUserNode } from "../node-view.ts";
import { CONNECTION_ONLINE_WINDOW_MS, NODE_LIFECYCLES } from "../node-lifecycle.ts";

/** 新鲜心跳：相对当前时刻，避免固定时间戳随 wall clock 过期（WP5 踩过的坑）。 */
const fresh = (ageMs = 5_000) => new Date(Date.now() - ageMs);
const stale = (ageMs = CONNECTION_ONLINE_WINDOW_MS + 1_000) => new Date(Date.now() - ageMs);

const CRED = "a".repeat(64);

/** 一个「已安装、新鲜上报、正常使用中」的节点。 */
function onlineActive(over: Partial<Parameters<typeof projectUserNode>[0]> = {}) {
  return {
    status: "active",
    last_seen_at: fresh(),
    has_credential: true,
    credential_revoked: false,
    lifecycle: "active",
    ...over,
  };
}

describe("Connection 层（事实：上报 + 凭据推导）", () => {
  test("无凭据 → waiting（还没完成 enrollment）", () => {
    const view = projectUserNode(onlineActive({ has_credential: false }));
    expect(view.connection).toBe("waiting");
    expect(view.online).toBe(false);
    expect(view.has_credential).toBe(false);
    expect(view.registered).toBe(false);
  });

  test("新鲜心跳 + 有效凭据 → online", () => {
    const view = projectUserNode(onlineActive());
    expect(view.connection).toBe("online");
    expect(view.online).toBe(true);
    expect(view.registered).toBe(true);
  });

  test("心跳超出窗口 → offline（offline 是 Connection 状态，不是 Health=error）", () => {
    const view = projectUserNode(onlineActive({ last_seen_at: stale() }));
    expect(view.connection).toBe("offline");
    expect(view.online).toBe(false);
  });

  test("凭据已撤销 → offline 而不是 waiting（撤销是主动断开，不是「等安装」）", () => {
    const view = projectUserNode(onlineActive({ credential_revoked: true }));
    expect(view.connection).toBe("offline");
    // 哈希仍在（凭据存在但被撤销），所以 has_credential=true 而 registered=false
    expect(view.has_credential).toBe(true);
    expect(view.registered).toBe(false);
  });

  test("从未上报（last_seen_at=null）→ offline", () => {
    const view = projectUserNode(onlineActive({ last_seen_at: null }));
    expect(view.connection).toBe("offline");
  });

  test("status 非 active → offline（凭据还在也判离线）", () => {
    const view = projectUserNode(onlineActive({ status: "disabled" }));
    expect(view.connection).toBe("offline");
  });
});

describe("Lifecycle 层（期望：用户设置的管理态）", () => {
  test("四态全部原样投影，不被 connection 改写", () => {
    for (const lifecycle of NODE_LIFECYCLES) {
      const view = projectUserNode(onlineActive({ lifecycle }));
      expect(view.lifecycle).toBe(lifecycle);
    }
  });

  test("lifecycle 缺省（旧行未 select 到）→ 按 schema 默认值 active", () => {
    expect(projectUserNode(onlineActive({ lifecycle: null })).lifecycle).toBe("active");
    expect(projectUserNode(onlineActive({ lifecycle: undefined })).lifecycle).toBe("active");
  });

  test("offline 的 active 节点仍然 accepts_new_business=true（连接是事实、生命周期是期望）", () => {
    const view = projectUserNode(onlineActive({ last_seen_at: stale() }));
    expect(view.connection).toBe("offline");
    expect(view.accepts_new_business).toBe(true);
    expect(view.admission_rejection).toBeNull();
  });

  test("maintenance 节点即使 online 也不接受新业务（维护中 ≠ 故障）", () => {
    const view = projectUserNode(onlineActive({ lifecycle: "maintenance" }));
    expect(view.connection).toBe("online");
    expect(view.accepts_new_business).toBe(false);
    expect(view.admission_rejection).toBe("node_in_maintenance");
  });
});

describe("准入拒绝码可区分（§13.5「Web 才能给用户正确下一步」）", () => {
  test("waiting 节点 → node_waiting_install（下一步是去安装，不是改生命周期）", () => {
    const view = projectUserNode(onlineActive({ has_credential: false }));
    expect(view.connection).toBe("waiting");
    expect(view.accepts_new_business).toBe(false);
    expect(view.admission_rejection).toBe("node_waiting_install");
  });

  test("maintenance / disabled / retiring 各给各自的码", () => {
    expect(projectUserNode(onlineActive({ lifecycle: "maintenance" })).admission_rejection).toBe(
      "node_in_maintenance",
    );
    expect(projectUserNode(onlineActive({ lifecycle: "disabled" })).admission_rejection).toBe(
      "node_disabled",
    );
    expect(projectUserNode(onlineActive({ lifecycle: "retiring" })).admission_rejection).toBe(
      "node_retiring",
    );
  });

  test("waiting 优先于 lifecycle 拒绝（先解决「没装」再谈管理态）", () => {
    const view = projectUserNode(onlineActive({ has_credential: false, lifecycle: "maintenance" }));
    // 与 services/node-lifecycle.ts 的 nodeAdmission 顺序一致：connection 先判。
    expect(view.admission_rejection).toBe("node_waiting_install");
  });

  test("接受新业务时 admission_rejection 必须是 null，不是空串", () => {
    const view = projectUserNode(onlineActive());
    expect(view.accepts_new_business).toBe(true);
    expect(view.admission_rejection).toBeNull();
  });
});

describe("投影不携带凭据材料", () => {
  test("返回键里没有 hash 字段（既不明文也不哈希）", () => {
    const view = projectUserNode(onlineActive()) as unknown as Record<string, unknown>;
    expect(Object.keys(view)).not.toContain("node_credential_hash");
    expect(JSON.stringify(view)).not.toContain(CRED);
    expect(view.has_credential).toBe(true);
  });
});

/* ================================================================== */
/* 静态守卫：判定只有一份实现                                          */
/* ================================================================== */

const source = readFileSync(new URL("../node-view.ts", import.meta.url), "utf8");
/** 去掉注释再扫，避免文档里提到的阈值把守卫自己扫红。 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("静态守卫：用户侧投影复用后端判定，不复制", () => {
  test("确实调用 deriveConnection 与 nodeAdmission（否则就是在自己判）", () => {
    expect(code).toContain("deriveConnection");
    expect(code).toContain("nodeAdmission");
  });

  test("源码里不出现在线窗口阈值（判定的唯一落点是 node-lifecycle.ts）", () => {
    // 90_000 / CONNECTION_ONLINE_WINDOW_MS / 90000 任何一种出现都说明又抄了一份窗口。
    expect(code).not.toMatch(/90_?000|CONNECTION_ONLINE_WINDOW_MS/);
  });

  test("源码里不出现生命周期白名单或 status 比较（判定权在后端）", () => {
    expect(code).not.toMatch(/status\s*===\s*"active"/);
    for (const lifecycle of NODE_LIFECYCLES) {
      if (lifecycle === "active") continue; // active 只作为 schema 默认值的字符串缺省，见下一条
      expect(code).not.toContain(`"${lifecycle}"`);
    }
  });

  test("`active` 只作为 schema 默认值缺省出现一次（不是白名单）", () => {
    const occurrences = code.match(/"active"/g) ?? [];
    expect(occurrences.length).toBe(1);
  });
});
