/**
 * 生产首启可用性（task-35）。
 *
 * ── 两条被真实部署演练（task-31）撞到的产品缺陷 ──
 *
 * 1. **演示种子占满新空间的节点额度**：`prisma/seed.ts` 的演示节点组建在**管理员个人空间**
 *    （`seedNodeGroups` 里 `workspace_id: workspace.id`，workspace 取自
 *    `personal_user_id: adminUserId`）⇒ 演示数据会占用该空间 `max_nodes` 的额度。
 *    免费额度是 **1 台**，而演示种子插 2 台 ⇒ 全新生产部署的管理员**加不了第一台真实节点**
 *    （`POST /api/node-groups/:id/nodes` → 403 `node_limit`）。这与 `.env.example` 的承诺
 *    （"生产绝不因为照抄模板就获得示例套餐/节点"）直接矛盾。
 *    仓库侧的修法（`SEED_DEMO_DATA=false` 跳过演示种子）**已经在位**；本次把它变成可测的
 *    纯函数并加守卫，避免以后有人改回无条件插入。
 * 2. **License 缺省必须 fail-closed**：`env.licenseType` 在 production 下缺省必须是 `"none"`
 *    （不是在镜像里写死的 `"business"`）。
 *
 * ── 这个文件**不**做什么 ──
 *
 * 它不连数据库。真实库计数（全新库 + `SEED_DEMO_DATA=false` ⇒ 零演示组/节点/套餐；
 * 以及 `=true` 时复现 403 `node_limit`）是**带外证据**，见 task-35 报告的"真实库计数"一节
 * —— 那需要一次性 MySQL，不适合放进 `bun test src`。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { describeSeedDemoDecision, shouldSeedDemoData } from "../seed-scope.ts";
import { checkNodeCreation, type EffectivePolicy } from "../capability-policy.ts";

const BACKEND = new URL("../../../", import.meta.url).pathname; // …/backend/
const SEED_SOURCE = readFileSync(`${BACKEND}prisma/seed.ts`, "utf8");
const ENV_MODULE = `${BACKEND}src/env.ts`;

/* ================================================================== */
/* 1. 判定本身（行为测试：跑真实函数，不是读源码字符串）                  */
/* ================================================================== */

describe("SEED_DEMO_DATA 的判定语义（真实函数）", () => {
  test("显式 true ⇒ 插（无论 NODE_ENV）", () => {
    expect(shouldSeedDemoData({ SEED_DEMO_DATA: "true" })).toBe(true);
    expect(shouldSeedDemoData({ SEED_DEMO_DATA: "true", NODE_ENV: "production" })).toBe(true);
  });

  test("显式 false ⇒ 不插（这就是 .env.example 那句承诺）", () => {
    expect(shouldSeedDemoData({ SEED_DEMO_DATA: "false" })).toBe(false);
    expect(shouldSeedDemoData({ SEED_DEMO_DATA: "false", NODE_ENV: "production" })).toBe(false);
    expect(shouldSeedDemoData({ SEED_DEMO_DATA: "false", NODE_ENV: "development" })).toBe(false);
  });

  test("未设置 + production ⇒ 不插（缺省 fail-closed）", () => {
    expect(shouldSeedDemoData({ NODE_ENV: "production" })).toBe(false);
    // 没写 NODE_ENV 时按 development 处理 —— 但不能反过来被当成 production。
    expect(shouldSeedDemoData({ NODE_ENV: "" })).toBe(true);
  });

  test("未设置 + 开发/测试 ⇒ 插（本地栈开箱有数据）", () => {
    expect(shouldSeedDemoData({})).toBe(true);
    expect(shouldSeedDemoData({ NODE_ENV: "development" })).toBe(true);
    expect(shouldSeedDemoData({ NODE_ENV: "test" })).toBe(true);
  });

  test("给了看不懂的值（0/no/空串）也按不插处理（fail-closed，不猜意图）", () => {
    for (const raw of ["0", "no", "off", "FALSE", ""]) {
      expect(`${raw}→${shouldSeedDemoData({ SEED_DEMO_DATA: raw })}`).toBe(`${raw}→false`);
      // 即使 NODE_ENV 是 development：显式给了值就按值走。
      expect(`${raw}→${shouldSeedDemoData({ SEED_DEMO_DATA: raw, NODE_ENV: "development" })}`).toBe(`${raw}→false`);
    }
  });

  test("原因文案与判定同源（排障时不再靠猜）", () => {
    expect(describeSeedDemoDecision({ SEED_DEMO_DATA: "false" })).toContain("SEED_DEMO_DATA=\"false\"");
    expect(describeSeedDemoDecision({ NODE_ENV: "production" })).toContain("NODE_ENV=production");
    expect(describeSeedDemoDecision({ SEED_DEMO_DATA: "true" })).toContain("SEED_DEMO_DATA=true");
  });
});

/* ================================================================== */
/* 2. 种子脚本必须**只用这个判定**（结构守卫，反向可变）                    */
/* ================================================================== */

describe("种子脚本的演示块只能由该判定开启", () => {
  const demoHelpers = ["seedPlans", "seedNodeGroups", "seedNodes", "seedPlanNodeGroups"];

  test("演示块被 SEED_DEMO_DATA 判定守卫，且判定来自 seed-scope 的纯函数", () => {
    // 判定必须来自被上面 truth table 钉住的纯函数 —— 否则那套测试管不到脚本。
    expect(SEED_SOURCE).toContain("shouldSeedDemoData(process.env)");
    expect(SEED_SOURCE).toContain('if (SEED_DEMO_DATA) {');
  });

  test("四个演示函数**只**在守卫块里被调用（改回无条件插入 ⇒ 这条必红）", () => {
    const guardAt = SEED_SOURCE.indexOf("if (SEED_DEMO_DATA) {");
    const elseAt = SEED_SOURCE.indexOf("demo plans/nodes skipped", guardAt);
    expect(guardAt).toBeGreaterThan(-1);
    expect(elseAt).toBeGreaterThan(guardAt);
    for (const helper of demoHelpers) {
      // 一处是函数定义，另一处必须是守卫块内的调用 —— 多出第三处（例如搬到块外无条件调用）
      // 就说明有人绕过了判定。
      const all = [...SEED_SOURCE.matchAll(new RegExp(`(^|[^A-Za-z_])${helper}\\s*\\(`, "g"))].map((m) => m.index!);
      expect(`${helper}:${all.length}`).toBe(`${helper}:2`);
      const callAt = Math.max(...all);
      expect(`${helper}@${callAt > guardAt && callAt < elseAt}`).toBe(`${helper}@true`);
    }
  });

  test("跳过分支必须留一行可读日志（含原因），不能静默", () => {
    expect(SEED_SOURCE).toContain("describeSeedDemoDecision(process.env)");
    expect(SEED_SOURCE).toContain("[seed] demo plans/nodes skipped");
  });
});

/* ================================================================== */
/* 3. 为什么演示数据是"首启可用性"问题（额度语义）                        */
/* ================================================================== */

describe("演示数据会占用新空间的节点额度（这是缺陷的机制）", () => {
  const freePolicy = {
    workspace_id: 1,
    revision: 1,
    deny_scope: false,
    deny_reason: null,
    limits: { max_nodes: 1, max_tunnels: 100, max_members: 1, traffic_limit: null, traffic_period: "total", bandwidth_limit: null, client_limit: null, ip_limit: null },
    entitlements: {
      tunnel_types: ["tcp"],
      allow_custom_in_group: true,
      allow_custom_out_group: true,
      allowed_in_group_ids: null,
      allowed_out_group_ids: null,
      allow_shared_entry: false,
      whitelist_ips: null,
    },
    sources: [],
    expires_at: null,
  } as unknown as EffectivePolicy;

  test("全新空间（0 台）⇒ 第一台真实节点可以加", () => {
    const decision = checkNodeCreation(freePolicy, 0);
    expect(decision.allowed).toBe(true);
  });

  test("演示种子插了 2 台之后 ⇒ 403 node_limit（task-31 撞到的正是这个）", () => {
    const decision = checkNodeCreation(freePolicy, 2);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("node_limit");
  });
});

/* ================================================================== */
/* 4. License 缺省 fail-closed（子进程里读真实 env 模块）                  */
/* ================================================================== */

describe("License 缺省：production 下不得凭空得到 business", () => {
  /** 在一个**全新进程**里 import 真实 env 模块，读它算出来的 licenseType。 */
  function licenseTypeIn(overrides: Record<string, string | undefined>): string {
    const code = `const { env } = await import(${JSON.stringify(ENV_MODULE)}); process.stdout.write(String(env.licenseType));`;
    const env: Record<string, string> = { ...(process.env as Record<string, string>), DATABASE_URL: "mysql://seed-test/seed-test" };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const proc = Bun.spawnSync([process.execPath, "-e", code], {
      cwd: BACKEND,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    if (proc.exitCode !== 0) throw new Error(`env 模块加载失败: ${stderr}`);
    return stdout.trim();
  }

  test("LICENSE_TYPE 未声明 + NODE_ENV=production ⇒ none（fail-closed）", () => {
    expect(licenseTypeIn({ NODE_ENV: "production", LICENSE_TYPE: undefined })).toBe("none");
  });

  test("显式声明仍然生效（两种取值都原样保留）", () => {
    expect(licenseTypeIn({ NODE_ENV: "production", LICENSE_TYPE: "business" })).toBe("business");
    expect(licenseTypeIn({ NODE_ENV: "production", LICENSE_TYPE: "personal" })).toBe("personal");
    expect(licenseTypeIn({ NODE_ENV: "production", LICENSE_TYPE: "none" })).toBe("none");
  });

  test("非生产环境缺省仍是 business（本地栈的便利，且与上面刻意不同）", () => {
    expect(licenseTypeIn({ NODE_ENV: "development", LICENSE_TYPE: undefined })).toBe("business");
  });
});
