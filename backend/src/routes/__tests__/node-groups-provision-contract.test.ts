import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
const root = new URL("../..", import.meta.url).pathname;

/**
 * `POST /api/node-groups/:id/nodes` 的拒绝契约。
 *
 * 这条用例守的是一个真实缺陷：节点组没有合法 `port_range` 时，锁内返回
 * `{ rangeConflict: true }`，但外层没有对应分支，于是 HTTP 落到兜底 500
 * 「创建节点失败」—— 用户看到的是服务端故障，实际是他选/建了一个没有端口区间的
 * 组。修复后这里必须是可区分的 409 + `PORT_RANGE_REQUIRED`（与 web mock 同码），
 * 且**不产生任何副作用**（不落 node、不签发 enrollment）。
 *
 * 同一个用例同时锁住既有分支不被新分支打乱：合法区间 201、同名复用 201（重新签发
 * 而不是新建行）、额度耗尽 403 `node_limit`、以及三种 409 冲突。
 */
const scenario = String.raw`
import { mock, expect } from 'bun:test';
import { Hono } from 'hono';
const root = process.env.TUNEX_ROUTE_ROOT;

// ---------------------------------------------------------------- fixtures
// group/node/policy 都是可变的，用例在同一个进程里顺序切换它们。
const group = { id: 10, node_type: 'in', port_range: null };
const policy = { deny_scope: false, limits: { max_nodes: 10 } };
const nodes = new Map();   // node_id -> row
let creates = 0, enrolls = 0, audits = 0, seq = 100;

function row(data) {
  const id = ++seq;
  return {
    id,
    node_id: data.node_id,
    agent_id: 'agent-' + id,
    connect_ip: data.connect_ip ?? null,
    node_group_id: data.node_group_id,
    role: data.role,
    port_range_min: data.port_range_min ?? null,
    port_range_max: data.port_range_max ?? null,
  };
}

const tx = {
  nodeGroup: {
    findFirst: async () => ({ id: group.id, node_type: group.node_type, port_range: group.port_range }),
  },
  node: {
    findUnique: async (args) => nodes.get(args.where.node_id) ?? null,
    findUniqueOrThrow: async (args) => {
      for (const n of nodes.values()) if (n.id === args.where.id) return n;
      throw new Error('missing node ' + args.where.id);
    },
    count: async () => nodes.size,
    create: async (args) => { creates++; const r = row(args.data); nodes.set(r.node_id, r); return r; },
  },
  auditEvent: { create: async () => { audits++; return {}; } },
  egressPool: { upsert: async () => ({ id: 1 }) },
  egressTarget: { deleteMany: async () => ({}), createMany: async () => ({}) },
};

mock.module(root + 'db.ts', () => ({ db: tx }));
mock.module(root + 'services/workspace.ts', () => ({
  resolveWorkspaceAccess: async () => ({ id: 2, role: 'owner', personalWorkspaceId: 2, kind: 'personal', customRoleId: null }),
}));
// withWorkspaceQuotaLock 直接把 fixture 的 policy 交给真实 checkNodeCreation。
mock.module(root + 'services/policy-service.ts', () => ({
  withWorkspaceQuotaLock: async (_id, fn) => fn(tx, policy),
}));
mock.module(root + 'services/node-enrollment.ts', () => ({
  createNodeEnrollment: async (id) => { enrolls++; return { token: 'tok-' + enrolls, node_id: id }; },
}));

const { nodeGroupsRoutes } = await import(root + 'routes/node-groups.ts');
const app = new Hono();
app.use('*', async (c, next) => { c.set('user', { id: 7 }); await next(); });
app.route('/api/node-groups', nodeGroupsRoutes);

const post = (body, id = 10) => app.request('/api/node-groups/' + id + '/nodes', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

// ------------------------------------------------- 1. 节点组没有可用端口区间
// 每一种「拿不出合法区间」的形状都必须走同一条 4xx，且零副作用。
const badRanges = [
  ['无 port_range', null],
  ['非数字区间', 'abc'],
  ['单端区间', '31000'],
  ['上下限倒置', '100-50'],
  ['越界区间', '0-70000'],
  ['空串区间', ''],
];
for (const [label, range] of badRanges) {
  group.port_range = range;
  const before = { creates, enrolls, audits };
  const res = await post({ node_id: 'no-range-' + label });
  const body = await res.json();
  if (res.status !== 409 || body.code !== 'PORT_RANGE_REQUIRED') {
    throw new Error(label + ' -> HTTP ' + res.status + ' ' + JSON.stringify(body));
  }
  expect(res.status).toBe(409);
  expect(body.code).toBe('PORT_RANGE_REQUIRED');
  expect(typeof body.error).toBe('string');
  expect(body.error.length).toBeGreaterThan(0);
  expect(body.error).toContain('端口范围');
  expect(Object.keys(body).sort()).toEqual(['code', 'error']);
  // 拒绝必须无副作用：不落 node、不签发 enrollment、不写审计。
  expect(creates).toBe(before.creates);
  expect(enrolls).toBe(before.enrolls);
  expect(audits).toBe(before.audits);
}
// 兜底 500 绝不能再被这条路径命中。
console.log('no-range -> 409 PORT_RANGE_REQUIRED, zero side effects');

// ------------------------------------------------------- 2. 合法区间 -> 201
group.port_range = '31000-31999';
let res = await post({ node_id: 'ok-node' });
expect(res.status).toBe(201);
let body = await res.json();
expect(body.data.node.node_id).toBe('ok-node');
expect(body.data.node.node_group_id).toBe(10);
expect(body.data.node.role).toBe('ingress');
// 组的区间成为 per-node 端口所有权域（不猜、不回落别处）。
expect(body.data.node.port_range_min).toBe(31000);
expect(body.data.node.port_range_max).toBe(31999);
expect(typeof body.data.enrollment.token).toBe('string');
expect(creates).toBe(1);
expect(enrolls).toBe(1);
const firstId = body.data.node.id;
console.log('valid range -> 201 with node + enrollment');

// ------------------------------------------- 3. 同名节点复用 -> 201 幂等重签
res = await post({ node_id: 'ok-node' });
expect(res.status).toBe(201);
body = await res.json();
expect(body.data.node.id).toBe(firstId);
expect(creates).toBe(1);          // 没有第二行
expect(enrolls).toBe(2);          // 命令被重新签发
console.log('same node_id -> 201 idempotent reuse (re-signed, no new row)');

// ------------------------------------------------- 4. 额度耗尽 -> 403 node_limit
policy.limits.max_nodes = 1;      // nodes.size 已经是 1
res = await post({ node_id: 'over-quota-node' });
body = await res.json();
expect(res.status).toBe(403);
expect(body.code).toBe('node_limit');
expect(typeof body.error).toBe('string');
expect(creates).toBe(1);
expect(enrolls).toBe(2);
policy.limits.max_nodes = 10;
console.log('quota exhausted -> 403 node_limit');

// -------------------------------------- 5. 既有冲突分支没有被新分支挤掉
// 5a. node_id 已属于另一个节点组 -> 409（无 code，保持原样）
const other = nodes.get('ok-node');
other.node_group_id = 99;
res = await post({ node_id: 'ok-node' });
body = await res.json();
expect(res.status).toBe(409);
expect(body.error).toContain('其它节点组');
expect(body.code).toBeUndefined();
other.node_group_id = 10;

// 5b. 已存在节点 + 显式不同 role -> 409（无 code）
res = await post({ node_id: 'ok-node', role: 'egress' });
body = await res.json();
expect(res.status).toBe(409);
expect(body.error).toContain('已存在节点角色');

// 5c. 重装 + targets -> 409 runtime_edit_requires_impact_check
res = await post({ node_id: 'ok-node', targets: [{ host: '192.0.2.99', port: 80 }] });
body = await res.json();
expect(res.status).toBe(409);
expect(body.code).toBe('runtime_edit_requires_impact_check');
expect(creates).toBe(1);
expect(enrolls).toBe(2);

// 5d. 组不存在 -> 404（未受本次改动影响）
const savedFindFirst = tx.nodeGroup.findFirst;
tx.nodeGroup.findFirst = async () => null;
res = await post({ node_id: 'any-node' });
expect(res.status).toBe(404);
tx.nodeGroup.findFirst = savedFindFirst;

// 5e. 入参非法 -> 400（未受本次改动影响）
res = await post({ node_id: '' });
expect(res.status).toBe(400);
console.log('existing conflict/404/400 branches intact');
`;

test("node provision contract: missing/invalid group port_range is 409 PORT_RANGE_REQUIRED, valid range still 201", () => {
  const result = spawnSync(process.execPath, ["-e", scenario], {
    cwd: root,
    env: { ...process.env, TUNEX_ROUTE_ROOT: root },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  expect(result.stdout).toContain("no-range -> 409 PORT_RANGE_REQUIRED, zero side effects");
  expect(result.stdout).toContain("valid range -> 201 with node + enrollment");
  expect(result.stdout).toContain("same node_id -> 201 idempotent reuse (re-signed, no new row)");
  expect(result.stdout).toContain("quota exhausted -> 403 node_limit");
  expect(result.stdout).toContain("existing conflict/404/400 branches intact");
});
