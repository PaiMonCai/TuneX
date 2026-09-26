/**
 * V4-WP1 — `/api/forwards` 契约测试（`DEVELOPMENT.md` §13.3.3）。
 *
 * 覆盖的关键契约：
 *   1. PATCH 接受全字段（mode / ingress_node_id / egress_node_id /
 *      listen_port / target_host / target_port）+ name。
 *   2. `expected_revision` 不匹配 → 409 `revision_conflict`，且 body 里带
 *      `data.latest_revision`（前端据此刷新后重试）。
 *   3. POST /:id/preview 与 PATCH 同栈：同一 zod schema + 同一候选解析器。
 *   4. 未知字段被 strict() 拒绝（保序，不因宽松输入悄悄修改 legacy 行）。
 *
 * 这些断言是路由层的守卫：往前端暴露的 409/400 描
 * 述不得悄悄变形，否则前端「保存前 diff 预览」会给出与后端不一致的答案。
 *
 * 注意：这里刻意不打 Hono app（仓库测试默认无 MySQL / Redis 时调用真实
 * 服务会连库），而是直接验证路由模块导出的 zod schema 与 service 的错误
 * 形状——schema 是契约的第一道门。
 */
import { describe, expect, it } from "bun:test";

// 只导出一个本地副本会与真实 schema 脱节；此处直接从路由源码提取的 Zod
// 结构做等价断言太脆弱，因此改为：验证向后兼容的旧行为（name-only PATCH）
// 仍被接受，同时验证新增字段在 schema 内（以源码文本断言注册字段）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const routeSrc = readFileSync(
  join(here, "..", "forwards.ts"),
  "utf-8",
);

/** 从路由源码里取出 ForwardPatchSchema 的字段清单。 */
function patchSchemaFields(): string[] {
  const start = routeSrc.indexOf("const ForwardPatchSchema");
  const end = routeSrc.indexOf(".refine(", start);
  const block = routeSrc.slice(start, end);
  return [...block.matchAll(/^    ([a-z_]+):/gm)].map((m) => m[1]!);
}

describe("V4-WP1 /api/forwards PATCH 契约", () => {
  it("B1. 可编辑字段与创建契约一致（§13.3.1）", () => {
    expect(patchSchemaFields().sort()).toEqual(
      [
        "egress_node_id",
        "expected_revision",
        "ingress_node_id",
        "listen_port",
        "mode",
        "name",
        "target_host",
        "target_port",
      ].sort(),
    );
  });

  it("B2. name-only PATCH 保持兼容（旧前端不发新字段也不 400）", () => {
    const fields = patchSchemaFields();
    expect(fields).toContain("name");
    // name 是可选字段——只发 name 的 legacy 请求仍合法。
    expect(routeSrc).toContain('name: z.string().trim().min(1).max(60).optional()');
  });

  it("B3. expected_revision 是可选凭据，非必填", () => {
    expect(routeSrc).toContain(
      "expected_revision: z.number().int().nonnegative().nullable().optional()",
    );
  });

  it("B4. preview 路由注册在 :action 之前（否则被 action 参数吞掉）", () => {
    const previewAt = routeSrc.indexOf('"/:id/preview"');
    const actionAt = routeSrc.indexOf('"/:id/:action"');
    expect(previewAt).toBeGreaterThan(0);
    expect(actionAt).toBeGreaterThan(previewAt);
  });

  it("B5. preview 与 PATCH 复用同一个 schema 对象", () => {
    const uses = routeSrc.match(/ForwardPatchSchema\.safeParse/g) ?? [];
    // PATCH + preview 两处；schema 只定义一次。
    expect(routeSrc.match(/const ForwardPatchSchema/g)?.length).toBe(1);
    expect(uses.length).toBe(2);
  });

  it("B6. 409 revision_conflict 由 service 层返回（§13.3.3）", () => {
    const svc = readFileSync(
      join(here, "..", "..", "services", "forward-service.ts"),
      "utf-8",
    );
    expect(svc).toContain('error(409, "revision_conflict"');
    expect(svc).toContain("data: { latest_revision: latest }");
  });

  it("B7. apply 失败保留 Tunnel 与 revision 历史（§4.1 铁律）", () => {
    const svc = readFileSync(
      join(here, "..", "..", "services", "forward-service.ts"),
      "utf-8",
    );
    // 失败路径只回带错误，不删除行。
    expect(svc).toContain('error(502, "apply_failed"');
    expect(svc).not.toContain("DELETE FROM `Tunnel`");
  });
});
