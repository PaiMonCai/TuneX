/** WP10 negative HTTP gate. Run mocks in a child process so Bun's global module
 * registry cannot replace workspace authorization in unrelated route suites. */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const root = new URL("../..", import.meta.url).pathname;
const scenario = String.raw`
import { mock, expect } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
const root = process.env.TUNEX_RBAC_ROOT;
let role = "member", roleId = null, permissions = null, customWorkspace = 2, active = true;
let writes = [], previews = 0;
const rows = [
  { id: 11, workspace_id: 2, user_id: 7, ingress_node_id: 21, category: "port_forward", tunnel_mode: "direct", desired_status: "inactive" },
  { id: 12, workspace_id: 2, user_id: 8, ingress_node_id: 21, category: "port_forward", tunnel_mode: "direct", desired_status: "inactive" },
  { id: 99, workspace_id: 3, user_id: 7, ingress_node_id: 31, category: "port_forward" },
];
function scoped(id, ws, ingress) {
  return rows.find(r => r.id === id && r.workspace_id === ws && (ingress === undefined || r.ingress_node_id === ingress)) ?? null;
}
function member(id, userId) {
  if (id !== 2 || !active) return null;
  if (userId === 9) return { id: 90, workspace_id: 2, user_id: 9, role: "owner", active: true };
  if (userId === 8) return { id: 80, workspace_id: 2, user_id: 8, role: "member", active: true };
  return {
    id: 70, workspace_id: 2, user_id: 7, role, active: true, role_id: roleId,
    custom_role: roleId === null || permissions === null ? null : { id: roleId, workspace_id: customWorkspace, permissions },
    workspace: { id: 2, kind: "team", name: "Team" },
  };
}
mock.module(root + "db.ts", () => ({ db: {
  workspace: { findUnique: async () => ({ id: 1 }) },
  workspaceMember: {
    findUnique: async ({where}) => member(where.workspace_id_user_id.workspace_id, where.workspace_id_user_id.user_id),
    findMany: async () => [],
    update: async () => { writes.push("member"); return {}; },
  },
  tunnel: {
    findFirst: async ({where}) => scoped(where.id, where.workspace_id, where.ingress_node_id),
    update: async ({where}) => { writes.push(where.id); return rows.find(r => r.id === where.id); },
  },
  node: {
    findFirst: async ({where}) => where.node_group.workspace_id === 2 && where.id === 21 ? { id: 21, role: "ingress" } : null,
    findMany: async () => [],
  },
  nodeBinding: { upsert: async () => { writes.push("binding"); return {}; } },
  auditEvent: { create: async () => ({}) },
  $transaction: async (fn) => fn({
    $queryRaw: async () => [{ id: 2 }],
    workspaceMember: {
      findUnique: async ({where}) => member(where.workspace_id_user_id.workspace_id, where.workspace_id_user_id.user_id),
      update: async () => { writes.push("member"); return {}; },
    },
    auditEvent: { create: async () => ({}) },
  }),
}}));
mock.module(root + "services/policy-service.ts", () => ({
  assignDefaultPolicy: async () => {}, withWorkspaceQuotaLock: async () => { throw Error("unexpected quota write"); },
  countWorkspaceTunnels: async () => 0, sumWorkspaceTraffic: async () => 0,
  // V5-WP20-6：services/traffic.ts 的用量汇总会带上联邦缺口字段，替身要给同一出口。
  sumFederatedUnattributedTraffic: async () => 0,
  // dashboard 的「已用流量」读路径改用策略窗口（生效策略 + 窗口求和），替身同样补齐。
  getEffectivePolicy: async () => ({ limits: { traffic_period: "total", traffic_limit: null } }),
}));
mock.module(root + "services/node-enrollment.ts", () => ({ createNodeEnrollment: async () => { writes.push("enrollment"); return {}; } }));
mock.module(root + "services/node-view.ts", () => ({ projectUserNode: () => ({}) }));
mock.module(root + "services/node-group-access.ts", () => ({ canUseNodeGroup: async () => false }));
mock.module(root + "services/relay-wiring.ts", () => ({ getOrchestrator: () => null }));
mock.module(root + "services/scheduler.ts", () => ({ reapplyDirectTunnel: async () => { writes.push("apply"); return {ok:true}; } }));
// V5-WP20-6：routes/tunnels.ts 与 routes/dashboard.ts 现在从本模块导入 fillDays
// （图表键的唯一实现）。替身必须语义完整，否则具名导入处会炸 SyntaxError ——
// 这正是 src/__tests__/lifecycle-db-stub.ts 顶部记录过的同族问题。
// 注意：本文件整体在 String.raw 模板串里，注释里不得出现反引号（会终止模板串）。
mock.module(root + "services/traffic.ts", () => ({
  getWorkspaceTrafficSummary: async () => ({ total: 0 }),
  fillDays: () => [],
  dayKeyOf: (d) => d.toISOString().slice(0, 10),
}));
function mutation(id, ws) {
  const row = scoped(id, ws);
  if (!row) return {ok:false, status:404, code:"not_found", message:"missing"};
  writes.push(id);
  return {ok:true, data:row, tunnel:row};
}
mock.module(root + "services/forward-service.ts", () => ({
  listForwards: async () => [], listForwardsPage: async () => ({ data:[], total:0 }),
  createForward: async () => ({ok:true,data:{}}),
  getForward: async (id, ws) => scoped(id,ws), getForwardSummary: async () => ({}), getForwardTraffic: async () => ({ok:true,data:[]}),
  patchForward: async (id,ws) => mutation(id,ws), deleteForward: async (id,ws) => mutation(id,ws),
  previewForwardUpdate: async (id,ws) => { previews++; return {ok:true,data:scoped(id,ws)}; },
  runForwardAction: async (id,action,ws) => mutation(id,ws),
  runForwardBatch: async (ids,action,ws,authorize) => {
    const results = ids.map(id => {
      const row = scoped(id,ws);
      if (!row) return {id,ok:false,code:"not_found"};
      if (!authorize(row)) return {id,ok:false,code:"forbidden",error_layer:"rbac"};
      mutation(id,ws); return {id,ok:true};
    });
    return {results,succeeded:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length};
  },
}));
mock.module(root + "services/tunnel-api.ts", () => ({
  listTunnels: async () => ({items:[],total:0}), createTunnel: async () => ({ok:true,tunnelId:11}),
  getTunnelState: async (id,ws) => ({ok:true,tunnel:scoped(id,ws)}),
  updateTunnel: async (id,body,ws) => mutation(id,ws),
  runTunnelAction: async (id,action,ws) => mutation(id,ws),
  parseApplyStatusFilter: () => null, parseTunnelMode: () => null,
  TUNNEL_API_ERROR_STATUS: {not_found:404,forbidden:403},
}));
const { forwardsRoutes } = await import(root + "routes/forwards.ts");
const { nodesRoutes } = await import(root + "routes/nodes.ts");
const { tunnelsRoutes } = await import(root + "routes/tunnels.ts");
const { workspaceRoutes } = await import(root + "routes/workspaces.ts");
const app = new Hono();
app.use("*",async(c,next)=>{c.set("user",{id:7,email:"a@example.com"});await next();});
app.onError((e,c) => e instanceof HTTPException ? e.getResponse() : c.json({error:e.message},500));
app.route("/api/forwards",forwardsRoutes); app.route("/api/nodes",nodesRoutes);
app.route("/api/tunnels",tunnelsRoutes); app.route("/api/workspaces",workspaceRoutes);
async function request(path,method="GET",body,extra={}) {
  return app.request(path,{method,headers:{"x-workspace-id":"2","content-type":"application/json",...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
function identity(base, custom=null) { role=base;roleId=custom===null?null:44;permissions=custom;customWorkspace=2;active=true;writes=[];previews=0; }
let checks = 0;
async function status(path,method,body,expected) {
  const response=await request(path,method,body);
  expect(response.status).toBe(expected); checks++; return response;
}
// Members can mutate their own Forward only, across all product/compat surfaces.
identity("member");
await status("/api/forwards/11","PATCH",{name:"own"},200);
expect(writes).toEqual([11]); writes=[];
for (const [path,method,body] of [
 ["/api/forwards/12","PATCH",{name:"other"}], ["/api/forwards/12","DELETE"],
 ["/api/forwards/12/preview","POST",{name:"other"}], ["/api/forwards/12/resume","POST"],
 ["/api/nodes/21/forwards/12/resume","POST"], ["/api/nodes/21/forwards/12","DELETE"],
 ["/api/tunnels/12","PATCH",{name:"other"}], ["/api/tunnels/12/toggle","POST"],
 ["/api/tunnels/12/reset-traffic","POST"], ["/api/tunnels/12","DELETE"],
 ["/api/tunnels/v3/12/retry","POST"], ["/api/tunnels/v3/12/suspend","POST"],
 ["/api/tunnels/v3/12/resume","POST"], ["/api/tunnels/v3/12","DELETE"],
]) { await status(path,method,body,403); }
expect(writes).toEqual([]); expect(previews).toBe(0);
for (const path of ["/api/forwards/99","/api/tunnels/99","/api/tunnels/v3/99"]) await status(path,"DELETE",undefined,404);
expect(writes).toEqual([]);
const batch = await status("/api/forwards/batch","POST",{ids:[11,12,99],action:"resume"},200);
expect((await batch.json()).data.results.map(r=>r.ok)).toEqual([true,false,false]); expect(writes).toEqual([11]);
// All fixed identities plus replacement and canonical/legacy alias precedence.
for (const base of ["owner","admin"]) {identity(base);await status("/api/forwards/12","PATCH",{name:"allowed"},200);expect(writes).toEqual([12]);}
identity("viewer"); await status("/api/forwards/11","PATCH",{name:"deny"},403);expect(writes).toEqual([]);
identity("admin",{});await status("/api/forwards/12","PATCH",{name:"deny"},403);expect(writes).toEqual([]);
identity("admin",{"forward:update":false,"tunnel:update":true});await status("/api/tunnels/12","PATCH",{name:"deny"},403);expect(writes).toEqual([]);
identity("viewer",{"tunnel:update":true});await status("/api/forwards/12","PATCH",{name:"alias"},200);
await status("/api/tunnels/12","PATCH",{name:"alias"},200);await status("/api/tunnels/v3/12/resume","POST",undefined,200);
// update permission is not conditioned on read permission by legacy middleware.
await status("/api/tunnels/12","GET",undefined,403);
identity("viewer",{"forward:update":true});await status("/api/tunnels/12","PATCH",{name:"canonical"},200);
identity("owner",{});await status("/api/forwards/12","PATCH",{name:"breakglass"},200);
identity("admin",{"forward:update":true});customWorkspace=3;await status("/api/forwards/12","PATCH",{name:"foreign-role"},403);
identity("admin");roleId=44;permissions=null;await status("/api/forwards/12","PATCH",{name:"dangling-role"},403);
// Nodes/enrollment management never derives from Forward permissions or creator.
identity("member");await status("/api/nodes/21/enrollment","POST",undefined,403);expect(writes).toEqual([]);
identity("admin",{"forward:update":true});await status("/api/nodes/21/enrollment","POST",undefined,403);expect(writes).toEqual([]);
identity("viewer",{"node:manage":true});await status("/api/nodes/21/enrollment","POST",undefined,201);
expect(writes).toEqual(["enrollment"]);writes=[];await status("/api/nodes/31/enrollment","POST",undefined,404);expect(writes).toEqual([]);
// Member family independent from node/forward family, with owner protection.
identity("admin",{"node:manage":true});await status("/api/workspaces/2/members","GET",undefined,403);
await status("/api/workspaces/2/members/8","DELETE",undefined,403);expect(writes).toEqual([]);
identity("viewer",{"member:read":true});await status("/api/workspaces/2/members","GET",undefined,200);
await status("/api/workspaces/2/members/8","DELETE",undefined,403);expect(writes).toEqual([]);
identity("viewer",{"member:manage":true});await status("/api/workspaces/2/members/8","DELETE",undefined,200);
expect(writes).toEqual(["member"]);writes=[];await status("/api/workspaces/2/members/9","DELETE",undefined,403);expect(writes).toEqual([]);
await status("/api/workspaces/3/members/8","DELETE",undefined,404);
identity("admin",{"member:manage":true});customWorkspace=3;await status("/api/workspaces/2/members/8","DELETE",undefined,403);expect(writes).toEqual([]);
identity("admin");roleId=44;await status("/api/workspaces/2/members/8","DELETE",undefined,403);expect(writes).toEqual([]);
identity("owner",{});await status("/api/workspaces/2/members","GET",undefined,200);
const bearer=await request("/api/forwards/11","PATCH",{name:"no-team"},{authorization:"Bearer fixture"});expect(bearer.status).toBe(403);checks++;
console.log("WP10 HTTP checks:",checks);
`;

test("WP10 real Hono routes enforce scoped creator, replacement roles, aliases, batch and member boundaries", () => {
  const result = spawnSync(process.execPath, ["-e", scenario], {
    cwd: root,
    env: { ...process.env, TUNEX_RBAC_ROOT: root },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  expect(result.stdout).toContain("WP10 HTTP checks:");
});
