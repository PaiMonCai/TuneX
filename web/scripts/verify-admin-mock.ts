/**
 * 直接驱动 mock handler 验证管理端新增端点（角色 CRUD / 配置 / 授权 / 角色分配）。
 * 运行：cd web && bun run scripts/verify-admin-mock.ts
 */
import { handleMock } from "../src/mocks/handler";
import { resetStore } from "../src/mocks/state";

const CK = "tunex_session=u1";
let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

async function call(method: string, path: string, body?: unknown) {
  // 把 path 上的 query 拆出来，模拟 api 层「path 与 query 分开传」的调用约定。
  const [bare, qs] = path.split("?");
  const query: Record<string, string> = {};
  if (qs) for (const kv of qs.split("&")) {
    const [k, v] = kv.split("=");
    if (k) query[k] = decodeURIComponent(v ?? "");
  }
  return handleMock(method, bare, { body, query, cookie: CK });
}

resetStore();

console.log("== roles ==");
let r = await call("GET", "/admin/role");
check("GET role list", r.status === 200 && Array.isArray(r.body) && r.body.length >= 3, r.status);

r = await call("GET", "/admin/meta/resources");
check("GET meta/resources", r.status === 200 && (r.body as any).resources.length === 20, r.status);

r = await call("POST", "/admin/role", {
  name: "auditor",
  description: "审计",
  permissions: { dashboard: "read", orders: "read", bogus: "write" },
});
const created = r.body as any;
check("POST create role", r.status === 200 && created.name === "auditor", r.status);
check("permissions sanitized (bogus dropped)", !("bogus" in created.permissions) && created.permissions.dashboard === "read", created.permissions);

r = await call("POST", "/admin/role", { name: "auditor" });
check("POST duplicate -> 409", r.status === 409, r.status);

r = await call("PUT", `/admin/role/${created.id}`, { permissions: { nodes: "write" } });
check("PUT update role perms", r.status === 200 && (r.body as any).permissions.nodes === "write", (r.body as any).permissions);

r = await call("PUT", "/admin/user/2/roles", { admin_role_ids: [created.id] });
check("assign roles to user", r.status === 200 && (r.body as any).admin_roles.length === 1, r.status);

r = await call("DELETE", `/admin/role/${created.id}`);
check("DELETE role in use -> 409", r.status === 409, r.status);

await call("PUT", "/admin/user/2/roles", { admin_role_ids: [] });
r = await call("DELETE", `/admin/role/${created.id}`);
check("DELETE role after unassign -> ok", r.status === 200, r.status);

console.log("== system config ==");
r = await call("GET", "/admin/system/config");
check("GET config list", r.status === 200 && Array.isArray(r.body) && (r.body as any).length >= 20, r.status);

r = await call("PUT", "/admin/system/config/SITE_NAME", { value: "TuneX-Dev" });
check("PUT config value", r.status === 200, r.status);
r = await call("GET", "/admin/system/config");
const siteRow = (r.body as any[]).find((c) => c.name === "SITE_NAME");
check("config persisted", siteRow?.value === "TuneX-Dev", siteRow);

r = await call("PUT", "/admin/system/config/BAD", { value: 123 });
check("PUT non-string value -> 400", r.status === 400, r.status);

console.log("== license / balance logs ==");
r = await call("GET", "/admin/license");
check("GET license", r.status === 200 && (r.body as any).type === "business", r.body);

r = await call("GET", "/admin/balance-logs");
check("GET balance logs", r.status === 200 && (r.body as any).total >= 3, r.status);

console.log("== audit logs ==");
r = await call("GET", "/admin/audit-logs");
const auditBody = r.body as any;
check("GET audit logs", r.status === 200 && auditBody.total >= 8, r.status);
check("audit logs sorted desc", r.status === 200 && auditBody.data[0].id >= auditBody.data[auditBody.data.length - 1].id, auditBody.data?.[0]?.id);

r = await call("GET", "/admin/audit-logs?keyword=login");
check("audit keyword filter", r.status === 200 && (r.body as any).data.every((a: any) => `${a.path} ${a.action} ${a.resource}`.includes("login")), r.status);

r = await call("GET", "/admin/audit-logs?actor_type=anonymous");
check("audit actor_type filter", r.status === 200 && (r.body as any).data.every((a: any) => a.actor_type === "anonymous"), r.status);

r = await call("GET", "/admin/audit-logs?method=POST");
check("audit method filter", r.status === 200 && (r.body as any).data.every((a: any) => a.method === "POST"), r.status);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
