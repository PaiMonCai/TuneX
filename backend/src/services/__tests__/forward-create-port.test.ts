import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("Forward create precheck separates TCP/UDP and conservatively rejects overlapping or unknown facts", () => {
  const modulePath = (relative: string) => JSON.stringify(fileURLToPath(new URL(relative, import.meta.url)));
  // Module mocks stay in a child process so this test cannot replace C's policy
  // fixtures or the real allocator in other suites. Run the actual create path.
  const scenario = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    process.env.AUTH_SECRET = "offline-forward-port-test";
    process.env.DATABASE_URL = "mysql://unused:unused@127.0.0.1:1/unused";
    const rows = [], reads = [];
    const matches = (row, where) => Object.entries(where ?? {}).every(([key, value]) => row[key] === value);
    const db = {
      node: { findFirst: async ({where}) => ({ id:where.id, node_id:"fixture", agent_id:"fixture", role:"both",
        node_group_id:1, node_group:{workspace_id:7}, lifecycle:"active", status:"active",
        node_credential_hash:"fixture", credential_revoked:false, last_seen_at:new Date(),
        port_range_min:23000,port_range_max:23010, connect_ip:"127.0.0.1" }) },
      tunnel: {
        findFirst:async({where}) => rows.find(row=>matches(row,where)) ?? null,
        findMany:async({where,select}) => { reads.push(select); return rows.filter(row=>matches(row,where)); },
        aggregate:async()=>({_max:{order_by:0}}),
        create:async({data})=> {const row={id:rows.length+1,...data};rows.push(row);return row;},
      },
    };
    const policy={deny_scope:null,limits:{max_tunnels:100,traffic_limit:null,traffic_period:"month",
      bandwidth_limit:null,client_limit:null,ip_limit:null}, entitlements:{tunnel_types:["tcp","udp","tls","ws"],
      allowed_in_group_ids:null,allowed_out_group_ids:null}};
    mock.module(${modulePath("../../db.ts")},()=>({db}));
    mock.module("ioredis",()=>({default:class OfflineRedis {on(){return this;} disconnect(){} }}));
    mock.module(${modulePath("../policy-service.ts")},()=>({getEffectivePolicy:async()=>policy,
      countWorkspaceTunnels:async()=>rows.length,sumWorkspaceTraffic:async()=>0,
      sumFederatedUnattributedTraffic:async()=>0,
      withWorkspaceQuotaLock:async(_id,fn)=>fn(db,policy)}));
    mock.module(${modulePath("../relay-wiring.ts")},()=>({getOrchestrator:()=>null}));
    const {createForward}=await import(${modulePath("../forward-service.ts")});
    const create=(protocol,port=23000)=>createForward(1,7,{name:"port-rule",mode:"direct",protocol,
      ingress_node_id:11,listen_port:port,target_host:"127.0.0.1",target_port:8080,
      ...(protocol==="tls"?{tls_cert_path:"/fixture/cert",tls_key_path:"/fixture/key"}:{})});
    for(const order of [["tcp","udp"],["udp","tcp"]]) {
      rows.length=0;
      for(const protocol of order) {const result=await create(protocol);assert.equal(result.ok,true,JSON.stringify(result));}
      assert.equal(rows.length,2);assert.equal(rows[0].listen_port,rows[1].listen_port);
      for(const protocol of ["tcp","tls","ws","udp"]) {
        const result=await create(protocol);assert.equal(result.ok,false);assert.equal(result.code,"port_conflict");
      }
      assert.equal(rows.length,2);
    }
    // findMany must inspect every holder, rather than accepting the first
    // disjoint row and overlooking a later same-protocol reservation.
    rows.length=0;
    rows.push({id:1,ingress_node_id:11,listen_port:23000,forward_protocol:"tcp",tunnel_type:"tcp",listen_ip:"127.0.0.1"},
      {id:2,ingress_node_id:11,listen_port:23000,forward_protocol:"udp",tunnel_type:"udp",listen_ip:"::1"});
    assert.equal((await create("udp")).code,"port_conflict");
    for(const stored of [
      {forward_protocol:null,tunnel_type:"udp",listen_ip:"::"},
      {forward_protocol:"future",tunnel_type:"tcp",listen_ip:"localhost"},
      {forward_protocol:null,tunnel_type:"future",listen_ip:null},
    ]) {
      rows.length=0;rows.push({id:1,ingress_node_id:11,listen_port:23000,...stored});
      assert.equal((await create("udp")).code,"port_conflict");
    }
    rows.length=0;rows.push({id:1,ingress_node_id:11,listen_port:23000,forward_protocol:null,tunnel_type:"udp",listen_ip:"::"});
    assert.equal((await create("tcp")).ok,true,"legacy UDP facts must also remain disjoint from TCP");
    rows.length=0;rows.push({id:1,ingress_node_id:12,listen_port:23000,forward_protocol:"tcp",tunnel_type:"tcp"});
    assert.equal((await create("tcp")).ok,true,"another physical node does not conflict");
    assert.ok(reads.every(select=>select.forward_protocol&&select.tunnel_type&&select.listen_ip));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", scenario], { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  expect(child.exitCode).toBe(0);
});
