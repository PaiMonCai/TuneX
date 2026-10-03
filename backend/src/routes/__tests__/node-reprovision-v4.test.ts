import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
const root = new URL("../..", import.meta.url).pathname;
const scenario = String.raw`
import { mock, expect } from 'bun:test';
import { Hono } from 'hono';
const root=process.env.TUNEX_RBAC_ROOT;
const existing={id:21,node_id:'immutable',agent_id:'agent-21',node_group_id:10,role:'both',connect_ip:'192.0.2.21',port_range_min:10000,port_range_max:20000,lb_strategy:'rand'};
let writes=0,enrolls=0;
const tx={
 nodeGroup:{findFirst:async()=>({id:10,workspace_id:2,node_type:'in',port_range:'15000-16000'})},
 node:{findUnique:async()=>({...existing}),findUniqueOrThrow:async()=>({...existing}),count:async()=>1,update:async()=>{writes++;throw Error('runtime config must not be overwritten');}},
 auditEvent:{create:async()=>({})},
 egressPool:{upsert:async()=>{writes++;throw Error('existing targets must not be overwritten');}},
};
mock.module(root+'db.ts',()=>({db:tx}));
mock.module(root+'services/workspace.ts',()=>({resolveWorkspaceAccess:async()=>({id:2,role:'owner',personalWorkspaceId:1,kind:'team',customRoleId:null})}));
mock.module(root+'services/policy-service.ts',()=>({withWorkspaceQuotaLock:async(_id,fn)=>fn(tx,{deny_scope:false,limits:{max_nodes:10}})}));
mock.module(root+'services/node-enrollment.ts',()=>({createNodeEnrollment:async()=>{enrolls++;return{token:'fixture'};}}));
const {nodeGroupsRoutes}=await import(root+'routes/node-groups.ts');
const app=new Hono();app.use('*',async(c,next)=>{c.set('user',{id:7});await next();});app.route('/api/node-groups',nodeGroupsRoutes);
const post=body=>app.request('/api/node-groups/10/nodes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
let res=await post({node_id:'immutable',connect_ip:'192.0.2.99'});
expect(res.status).toBe(201);let node=(await res.json()).data.node;
expect(node).toEqual(existing);expect(writes).toBe(0);expect(enrolls).toBe(1);
res=await post({node_id:'immutable',role:'both',targets:[{host:'192.0.2.99',port:80}]});
expect(res.status).toBe(409);expect((await res.json()).code).toBe('runtime_edit_requires_impact_check');expect(writes).toBe(0);expect(enrolls).toBe(1);
res=await post({node_id:'immutable',role:'ingress'});expect(res.status).toBe(409);expect(writes).toBe(0);
console.log('reprovision guard verified');
`;
test("reinstall cannot overwrite active node range/role/address/lb or targets", () => {
  const result = spawnSync(process.execPath, ["-e", scenario], { cwd: root, env: { ...process.env, TUNEX_RBAC_ROOT: root }, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  expect(result.stdout).toContain("reprovision guard verified");
});
