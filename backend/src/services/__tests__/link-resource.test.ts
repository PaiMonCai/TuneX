import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("Link lifecycle reserves before restore, fences late ACKs, preserves other bindings and retries retirement", () => {
  const modulePath = (relative: string) => JSON.stringify(fileURLToPath(new URL(relative, import.meta.url)));
  const scenario = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    process.env.TUNEX_FXP_LINKS_ENABLED = "true";
    process.env.TUNEX_LINK_SEAL_KEY = "53".repeat(32);
    mock.module(${modulePath("../federation/forward-hop.ts")},()=>({FEDERATED_EGRESS_UNSUPPORTED_PROTOCOLS:["tls"]}));
    const tables = {};
    let usageRows = [];
    let reportedVersion = "0.0.0-dev", legacyVersion = "unknown", fxpAdvertised = true;
    const matches = (r,w={}) => Object.entries(w).every(([k,v]) => {
      if (v && typeof v === "object" && "in" in v) return v.in.includes(r[k]);
      if (v && typeof v === "object" && "not" in v) return r[k] !== v.not;
      if (v && typeof v === "object") return matches(r[k]??{},v);
      return r[k] === v;
    });
    const table = (name) => {
      const rows = tables[name] = [];
      const expand = (r) => name === "deployment" ? { ...r, placements: tables.placement.filter(p=>p.deployment_id===r.id),
        link: tables.link.find(l=>l.id===r.link_id) } : name === "placement" ? { ...r,
        deployment: db.linkDeployment.expand(tables.deployment.find(d=>d.id===r.deployment_id)) } : r;
      const patch = (r,data) => { for(const [k,v] of Object.entries(data)) r[k] = v && typeof v === "object" && "increment" in v ? (r[k]??0)+v.increment : v; };
      const find = (where) => rows.find(r=>matches(r, Object.values(where??{}).some(v=>v&&typeof v==="object"&&("version" in v||"generation" in v)) ? Object.values(where)[0] : where));
      return { expand, rows,
        findFirst: async({where})=>find(where)??null,
        findUnique: async({where})=> {const r=find(where); return r?expand(r):null;},
        findUniqueOrThrow: async({where})=> {const r=find(where); if(!r)throw Error("fixture_not_found"); return expand(r);},
        findMany: async(args={})=>rows.map(expand).filter(r=>matches(r,args.where)),
        count: async({where})=>rows.filter(r=>matches(r,where)).length,
        create: async({data})=> {const r={ id:rows.length+1, config_revision:0, generation:0, desired_version:1, status:"draft", ...data }; delete r.placements; rows.push(r);
          if(data.placements) for(const p of data.placements.create) await db.linkPlacement.create({data:{...p,deployment_id:r.id,applied_generation:null}});
          return expand(r); },
        update: async({where,data})=> {const r=find(where); if(!r)throw Error("fixture_not_found"); patch(r,data);return expand(r);},
        updateMany: async({where,data})=> {let count=0;for(const r of rows)if(matches(r,where)){patch(r,data);count++;}return {count};},
        deleteMany: async({where})=> {let count=0;for(let i=rows.length-1;i>=0;i--)if(matches(rows[i],where)){rows.splice(i,1);count++;}return {count};},
      };
    };
    const db = {
      linkResource:table("link"),linkVersion:table("version"),linkTransportCredential:table("credential"),
      linkDeployment:table("deployment"),linkPlacement:table("placement"),tunnel:table("tunnel"),
      nodePortLease:table("lease"),forwardRevision:table("revision"),
      nodeStateReport:{findMany:async()=>[]},
      linkTrafficCheckpoint:{groupBy:async({where})=>{assert.equal(where.workspace_id,3);assert.equal(where.link_id,1);return usageRows.filter(row=>where.forward_id.in.includes(row.forward_id));}},
      node:{ findMany:async({where,include})=> {assert.equal(include.state_report.select.version,true);return [11,12].filter(id=>where.id.in.includes(id)&&where.node_group.workspace_id===3).map(id=>({id,
        lifecycle:"active",role:id===11?"ingress":"egress",node_group_id:id,connect_ip:"127.0.0.1",version:legacyVersion,
        state_report:reportedVersion===null?null:{version:reportedVersion},node_group:{workspace_id:3}}));} },
      $queryRaw:async()=>[], $transaction:async(fn)=>fn(db),
    };
    const policy={deny_scope:null,limits:{max_tunnels:100,traffic_limit:null,traffic_period:"month",bandwidth_limit:null,client_limit:null,ip_limit:null},
      entitlements:{tunnel_types:["tcp","udp"],allowed_in_group_ids:null,allowed_out_group_ids:null}};
    mock.module(${modulePath("../../db.ts")},()=>({db}));
    let trafficUsed=0;
    mock.module(${modulePath("../policy-service.ts")},()=>({getEffectivePolicy:async()=>policy, countWorkspaceTunnels:async()=>tables.tunnel.length,
      sumWorkspaceTraffic:async()=>trafficUsed,withWorkspaceQuotaLock:async(_id,fn)=>fn(db,policy)}));
    mock.module(${modulePath("../runtime-admission.ts")},()=>({loadNodeCapabilityFacts:async()=>({capabilities:fxpAdvertised?["forward.link.fxp.v1"]:[]})}));
    let blocked=false,failIngress=false,lateAck=false;
    const sent=[], acquired=[];
    mock.module(${modulePath("../portPool.ts")},()=>({
      acquirePort:async(input)=> {acquired.push(input);return blocked?{ok:false,code:"port_taken"}:{ok:true,result:{leaseId:acquired.length,port:input.preferredPort}};},
      releaseLease:async()=>true,
    }));
    mock.module(${modulePath("../link-transport.ts")},()=>({sendLinkPlacement:async(config,remove)=>{
      sent.push({config,remove});
      if(failIngress&&config.role==="ingress")throw Error("link_apply_unconfirmed");
      if(lateAck&&config.role==="ingress")tables.tunnel[0].config_revision++;
    }}));
    const service=await import(${modulePath("../link-resource.ts")});
    const initial={name:"shared",config:{ingress_node_id:11,egress_node_id:12,carrier_port:25000}};
    legacyVersion="0.0.0-dev";
    for (const current of [null,"unknown",""]) {
      reportedVersion=current;
      await assert.rejects(()=>service.createLink(3,8,initial),e=>e.code==="agent_version_unknown"&&e.status===409);
      assert.equal(tables.link.length,0);
    }
    reportedVersion="not-semver";
    await assert.rejects(()=>service.createLink(3,8,initial),e=>e.code==="agent_version_invalid"&&e.status===409);
    reportedVersion="0.0.0-dev";fxpAdvertised=false;
    await assert.rejects(()=>service.createLink(3,8,initial),e=>e.code==="agent_fxp_capability_missing"&&e.status===409);
    assert.equal(tables.link.length,0);
    legacyVersion="unknown";fxpAdvertised=true;
    const link=await service.createLink(3,8,initial);
    await assert.rejects(()=>service.createLink(4,8,{name:"cross",config:{ingress_node_id:11,egress_node_id:12,carrier_port:25000}}),/link_node_not_found/);
    const rule=(name,listen_port)=>({name,protocol:"both",listen_port,listen_host:"127.0.0.1",target_host:"127.0.0.1",target_port:27000});
    const a=await service.createLinkForward(3,link.id,8,rule("A",26000));
    const b=await service.createLinkForward(3,link.id,8,rule("B",26001));
    assert.equal((await service.getLink(3,link.id)).forwards[0].traffic,null);
    usageRows=[{forward_id:a.id,_sum:{bytes_in:9007199254740993n,bytes_out:43n,connections:2n},_max:{updated_at:new Date("2026-10-07T12:00:00Z")}}];
    const accounted=await service.getLink(3,link.id);
    assert.deepEqual(accounted.forwards[0].traffic,{bytes_in:"9007199254740993",bytes_out:"43",connections:"2",last_received_at:"2026-10-07T12:00:00.000Z"});
    assert.equal(accounted.forwards[1].traffic,null);
    usageRows=[];
    const healthyGeneration=tables.link[0].generation;
    await assert.rejects(()=>service.createLinkForward(3,link.id,8,rule("conflict",26001)),/binding_listener_conflict/);
    assert.equal(tables.tunnel.length,2);assert.equal(tables.link[0].generation,healthyGeneration);
    blocked=true;
    await assert.rejects(()=>service.createLinkForward(3,link.id,8,rule("foreign busy",26002)),/port_taken/);
    blocked=false;
    assert.equal(tables.tunnel.length,2);assert.equal(tables.link[0].generation,healthyGeneration);
    assert.equal(tables.revision.length,2);assert.equal(tables.tunnel[0].applied_revision,1);
    assert.equal(acquired.some(p=>p.protocol==="tcp"&&p.preferredPort===26000),true);
    assert.equal(acquired.some(p=>p.protocol==="udp"&&p.preferredPort===26000),true);
    assert.equal(acquired.every(p=>p.linkId===link.id&&p.tunnelId==null),true);
    const priorGeneration=tables.link[0].generation;
    await assert.rejects(()=>service.retireLink(3,link.id),/link_has_references/);
    assert.equal(tables.link[0].generation,priorGeneration);
    await service.actionLinkForward(3,link.id,a.id,"delete");
    const latest=sent.at(-1).config.runner_config;
    assert.equal(latest.entries.length,1);assert.equal(latest.entries[0].ruleId,b.id);
    assert.equal(tables.tunnel.length,1);
    lateAck=true; await service.deployLink(3,link.id); lateAck=false;
    assert.equal(tables.tunnel[0].applied_revision<tables.tunnel[0].config_revision,true);
    const healthyDeployments=tables.deployment.length, beforeBlocked=tables.link[0].generation;
    blocked=true;await assert.rejects(()=>service.deployLink(3,link.id),/port_taken/);blocked=false;
    assert.equal(tables.deployment.length,healthyDeployments);assert.equal(tables.link[0].generation,beforeBlocked);
    assert.equal(tables.deployment.at(-1).status,"active");
    failIngress=true;await assert.rejects(()=>service.deployLink(3,link.id),/link_apply_unconfirmed/);failIngress=false;
    assert.equal(tables.link[0].status,"degraded");assert.equal(tables.deployment.at(-1).status,"degraded");
    await service.deployLink(3,link.id);
    const capGeneration=tables.link[0].generation;
    policy.limits.bandwidth_limit=1;
    assert.equal((await service.desiredNodeLinks(11)).length,0);
    assert.equal((await service.reconcileLinks()).errors,0);
    assert.equal(tables.link[0].generation,capGeneration+1);
    assert.equal(sent.at(-1).config.runner_config.entries[0].limitIn,125000);
    assert.equal((await service.desiredNodeLinks(11)).length,1);
    await service.reconcileLinks();assert.equal(tables.link[0].generation,capGeneration+1);
    policy.deny_scope=true;
    assert.equal((await service.reconcileLinks()).errors,1);
    assert.equal(tables.deployment.at(-1).status,"policy_blocked");
    assert.equal(sent.at(-1).remove,true);
    assert.equal((await service.desiredNodeLinks(11)).length,0);
    policy.deny_scope=false;
    assert.equal((await service.reconcileLinks()).errors,0);
    assert.equal(tables.link[0].generation,capGeneration+2);
    policy.limits.traffic_limit=1;trafficUsed=2;
    assert.equal((await service.reconcileLinks()).errors,1);
    assert.equal(tables.deployment.at(-1).status,"policy_blocked");
    trafficUsed=0;policy.limits.traffic_limit=null;
    assert.equal((await service.reconcileLinks()).errors,0);
    const revisions=tables.revision.length;
    await service.actionLinkForward(3,link.id,b.id,"suspend");
    assert.equal(tables.revision.length,revisions+1);
    assert.equal(tables.revision.at(-1).desired_status,"inactive");
    await service.actionLinkForward(3,link.id,b.id,"resume");
    assert.equal(tables.revision.at(-1).desired_status,"active");
    await service.actionLinkForward(3,link.id,b.id,"delete");
    failIngress=true;await assert.rejects(()=>service.retireLink(3,link.id),/link_apply_unconfirmed/);failIngress=false;
    assert.equal(tables.link[0].status,"retiring");
    await service.retireLink(3,link.id);assert.equal(tables.link[0].status,"retired");
    assert.equal(tables.credential.every(c=>!c.secret_enc.includes("51".repeat(32))),true);
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", scenario], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  expect(result.exitCode).toBe(0);
});
