import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";

test("Link lifecycle preserves F2 targets and F3 sources, gates writes/restores and fences snapshots", () => {
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
    const targetCapNodes = new Set([11,12]);
    const sourceCapNodes = new Set([11,12]);
    const staleCapNodes = new Set();
    let previewTxOnly=false,previewTx=null,liveReports=[];
    const jsonFields = new Set(["link_target_config","link_source_config","targets","binding_snapshot","config"]);
    const matches = (r,w={}) => Object.entries(w).every(([k,v]) => {
      if (v && typeof v === "object" && "in" in v) return v.in.includes(r[k]);
      if (v && typeof v === "object" && "not" in v) return r[k] !== v.not;
      if (v && typeof v === "object") return matches(r[k]??{},v);
      return r[k] === v;
    });
    const table = (name) => {
      const rows = tables[name] = []; let nextId = 1;
      const expand = (r) => name === "deployment" ? { ...r, placements: tables.placement.filter(p=>p.deployment_id===r.id),
        link: tables.link.find(l=>l.id===r.link_id) } : name === "placement" ? { ...r,
        deployment: db.linkDeployment.expand(tables.deployment.find(d=>d.id===r.deployment_id)) } : r;
      const patch = (r,data) => { for(const [k,v] of Object.entries(data)) r[k] = ["link_target_config","link_source_config"].includes(k) && v?.constructor?.name === "JsonNull"
        ? null : v && typeof v === "object" && "increment" in v ? (r[k]??0)+v.increment
        : jsonFields.has(k) && v != null ? structuredClone(v) : v; };
      const find = (where) => rows.find(r=>matches(r, Object.values(where??{}).some(v=>v&&typeof v==="object"&&("version" in v||"generation" in v)) ? Object.values(where)[0] : where));
      return { expand, rows,
        findFirst: async({where})=>find(where)??null,
        findUnique: async({where})=> {const r=find(where); return r?expand(r):null;},
        findUniqueOrThrow: async({where})=> {const r=find(where); if(!r)throw Error("fixture_not_found"); return expand(r);},
        findMany: async(args={})=>rows.map(expand).filter(r=>matches(r,args.where)),
        count: async({where})=>rows.filter(r=>matches(r,where)).length,
        create: async({data})=> {const r={ id:nextId++, config_revision:0, generation:0, desired_version:1, status:"draft" }; patch(r,data); delete r.placements; rows.push(r);
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
      nodePortLease:table("lease"),forwardRevision:table("revision"),linkMaintenanceMigration:table("maintenance"),
      nodeStateReport:{findMany:async()=>liveReports},
      linkTrafficCheckpoint:{groupBy:async({where})=>{assert.equal(where.workspace_id,3);assert.equal(where.link_id,1);return usageRows.filter(row=>where.forward_id.in.includes(row.forward_id));}},
      node:{ findMany:async({where,include})=> {assert.equal(include.state_report.select.version,true);return [11,12].filter(id=>where.id.in.includes(id)&&where.node_group.workspace_id===3).map(id=>({id,
        lifecycle:"active",role:id===11?"ingress":"egress",node_group_id:id,connect_ip:"127.0.0.1",version:legacyVersion,
        state_report:reportedVersion===null?null:{version:reportedVersion},node_group:{workspace_id:3}}));} },
      $queryRaw:async()=>[], $transaction:async(fn)=>fn(previewTxOnly?previewTx:db),
    };
    const nodeReader=db.node.findMany;
    previewTx={...db,node:{findMany:nodeReader}};
    db.node.findMany=async(args)=>{assert.equal(previewTxOnly,false,"global node reads would deadlock a one-connection pool");return nodeReader(args);};
    const policy={deny_scope:null,limits:{max_tunnels:100,traffic_limit:null,traffic_period:"month",bandwidth_limit:null,client_limit:null,ip_limit:null},
      entitlements:{tunnel_types:["tcp","udp"],allowed_in_group_ids:null,allowed_out_group_ids:null}};
    mock.module(${modulePath("../../db.ts")},()=>({db}));
    let trafficUsed=0;
    mock.module(${modulePath("../policy-service.ts")},()=>({getEffectivePolicy:async()=>policy, countWorkspaceTunnels:async()=>tables.tunnel.length,
      sumWorkspaceTraffic:async()=>trafficUsed,withWorkspaceQuotaLock:async(_id,fn)=>fn(db,policy)}));
    mock.module(${modulePath("../runtime-admission.ts")},()=>({loadNodeCapabilityFacts:async(id,client)=>{
      if(previewTxOnly)assert.equal(client,previewTx,"capability reads must use the locked transaction");
      return {advertisementCurrent:!staleCapNodes.has(id),capabilities:fxpAdvertised
        ? ["forward.link.fxp.v1",...(targetCapNodes.has(id)?["forward.targets.fxp.v1"]:[]),...(sourceCapNodes.has(id)?["forward.client-source.fxp.v1"]:[])] : []};
    }}));
    let blocked=false,failIngress=false,lateAck=false,lateAckForwardId=null;
    const sent=[], acquired=[];
    mock.module(${modulePath("../portPool.ts")},()=>({
      acquirePort:async(input)=> {acquired.push(input);return blocked?{ok:false,code:"port_taken"}:{ok:true,result:{leaseId:acquired.length,port:input.preferredPort}};},
      releaseLease:async()=>true,
    }));
    mock.module(${modulePath("../link-transport.ts")},()=>({sendLinkPlacement:async(config,remove)=>{
      sent.push({config,remove});
      if(failIngress&&config.role==="ingress")throw Error("link_apply_unconfirmed");
      if(lateAck&&config.role==="ingress")
        (lateAckForwardId==null?tables.tunnel[0]:tables.tunnel.find(r=>r.id===lateAckForwardId)).config_revision++;
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
    // A compiler-backed F5 read must never reserve sockets, dispatch or write credentials/revisions.
    const maintenanceState=()=>structuredClone(tables);
    const previewInput=()=>({expected_version:tables.link[0].desired_version,
      expected_generation:tables.link[0].generation,change:{type:"rotate_key"}});
    const beforePreview=maintenanceState(),beforeSent=sent.length,beforeAcquired=acquired.length;
    previewTxOnly=true;
    const rotationPreview=await service.previewLinkMaintenance(3,link.id,previewInput());
    previewTxOnly=false;
    staleCapNodes.add(11);
    await assert.rejects(()=>service.previewLinkMaintenance(3,link.id,previewInput()),e=>e.code==="agent_fxp_capability_stale");
    staleCapNodes.clear();
    assert.equal(rotationPreview.references.total,2);assert.equal(rotationPreview.references.active,2);
    assert.equal(rotationPreview.runtime.state,"unknown","ACK without a fresh report never grants Ready");
    const previewDeployment=db.linkDeployment.expand(tables.deployment.at(-1));
    liveReports=previewDeployment.placements.map(p=>({node_id:p.node_id,reported_at:new Date(),link_placements:[{
      id:p.runtime_id,link_id:link.id,workspace_id:3,node_id:p.node_id,role:p.role,generation:p.generation,
      observed_generation:p.generation,config_digest:p.config_digest,desired_config_digest:p.config_digest,
      ready:true,state:"ready",lease_expires_at:previewDeployment.lease_expires_at.toISOString(),ports:[],runtime_ids:[]}]}));
    const baselinePreview=await service.previewLinkMaintenance(3,link.id,previewInput());
    assert.equal(baselinePreview.runtime.state,"ready");
    policy.limits.bandwidth_limit=1;
    const policyDriftPreview=await service.previewLinkMaintenance(3,link.id,previewInput());
    assert.equal(policyDriftPreview.runtime.state,"not_ready");
    assert.notEqual(policyDriftPreview.snapshot.state_token,baselinePreview.snapshot.state_token);
    policy.limits.bandwidth_limit=null;liveReports=[];
    assert.equal(rotationPreview.runtime.tcp_connections,null);assert.equal(rotationPreview.runtime.udp_mappings,null);
    assert.equal(rotationPreview.execution.supported,false);assert.equal(rotationPreview.ports.reserved,false);
    assert.equal(rotationPreview.ports.candidate.filter(p=>p.role==="egress").length,2);
    const moved=await service.previewLinkMaintenance(3,link.id,{...previewInput(),change:{type:"update_endpoints",
      config:{...initial.config,carrier_port:25001}}});
    assert.equal(moved.candidate.version,2);assert.equal(moved.changes.carrier_port_changed,true);
    assert.equal(moved.references.total,2);assert.equal(moved.impact.tcp,"drain_required");
    assert.notEqual(moved.snapshot.state_token,rotationPreview.snapshot.state_token);
    assert.deepEqual(maintenanceState(),beforePreview);assert.equal(sent.length,beforeSent);assert.equal(acquired.length,beforeAcquired);
    await assert.rejects(()=>service.previewLinkMaintenance(4,link.id,previewInput()),e=>e.code==="link_not_found"&&e.status===404);
    await assert.rejects(()=>service.previewLinkMaintenance(3,link.id,{...previewInput(),expected_version:2}),e=>e.code==="link_version_conflict");
    await assert.rejects(()=>service.previewLinkMaintenance(3,link.id,{...previewInput(),expected_generation:0}),e=>e.code==="link_generation_conflict");
    await assert.rejects(()=>service.previewLinkMaintenance(3,link.id,{...previewInput(),change:{type:"update_endpoints",
      config:{...initial.config,egress_node_id:999}}}),e=>e.code==="link_node_not_found");
    process.env.TUNEX_FXP_LINKS_ENABLED="false";
    await assert.rejects(()=>service.previewLinkMaintenance(3,link.id,previewInput()),e=>e.code==="fxp_links_not_enabled");
    process.env.TUNEX_FXP_LINKS_ENABLED="true";
    // The production writer entrypoints, not only the guard helper, must respect the same Link fence.
    tables.maintenance.push({id:1,link_id:link.id,active_link_id:link.id,status:"awaiting_executor",
      state_version:1,hold_expires_at:new Date(Date.now()+300000)});
    const fencedState=maintenanceState(),fencedSent=sent.length,fencedAcquired=acquired.length;
    for(const write of [
      ()=>service.createLinkForward(3,link.id,8,rule("fenced",26002)),
      ()=>service.updateLinkForward(3,link.id,a.id,8,1,rule("fenced A",26000)),
      ()=>service.updateLink(3,link.id,1,{...initial.config,carrier_port:25001}),
      ()=>service.deployLink(3,link.id),()=>service.deployLink(3,link.id,true),()=>service.retireLink(3,link.id),
      ...["suspend","resume","retry","delete"].map(action=>()=>service.actionLinkForward(3,link.id,a.id,action,8)),
    ]) await assert.rejects(write,e=>e.code==="link_maintenance_in_progress");
    await service.previewLinkMaintenance(3,link.id,previewInput()); // Read-only previews remain allowed.
    assert.deepEqual(maintenanceState(),fencedState);assert.equal(sent.length,fencedSent);assert.equal(acquired.length,fencedAcquired);
    tables.maintenance.length=0;
    await assert.rejects(()=>service.updateLink(3,link.id,1,{...initial.config,carrier_port:25001}),e=>e.code==="link_has_references");
    await assert.rejects(()=>service.deployLink(3,link.id,true),e=>e.code==="link_has_references");
    const baseReferenceCount=tables.tunnel.length;
    tables.tunnel.push(...Array.from({length:499},(_,i)=>({...tables.tunnel[0],id:1000+i,desired_status:"inactive"})));
    await assert.rejects(()=>service.previewLinkMaintenance(3,link.id,previewInput()),e=>e.code==="link_maintenance_preview_too_large");
    tables.tunnel.splice(baseReferenceCount);
    tables.lease.push(...Array.from({length:2049},(_,i)=>({id:i+1,link_id:link.id,status:"active"})));
    await assert.rejects(()=>service.previewLinkMaintenance(3,link.id,previewInput()),e=>e.code==="link_maintenance_preview_too_large");
    tables.lease.length=0;
    assert.deepEqual(maintenanceState(),beforePreview);assert.equal(sent.length,beforeSent);assert.equal(acquired.length,beforeAcquired);
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

    // The service uses the real revision writer; only storage, policy and ACK I/O are mocked.
    const completeSet={version:1,targets:[{host:"127.0.0.1",port:27000},
      {host:"backup.example",port:27001},{host:"::1",port:27002}],strategy:"fallback",
      failure_seconds:10,recover_seconds:3600,probe:"tcp"};
    const multi=(set,name="F2")=>({...rule(name,26002),target_set:structuredClone(set)});
    const persisted=()=>structuredClone({tunnels:tables.tunnel,revisions:tables.revision,
      deployments:tables.deployment,credentials:tables.credential,generation:tables.link[0].generation,
      sent:sent.length,reserved:acquired.length});
    for(const missing of [11,12]) {
      targetCapNodes.delete(missing);
      const before=persisted();
      await assert.rejects(()=>service.createLinkForward(3,link.id,8,multi(completeSet)),
        e=>e.code==="agent_fxp_targets_capability_missing");
      assert.deepEqual(persisted(),before,"both endpoint capabilities are required before any durable write or reservation");
      targetCapNodes.add(missing);
    }
    const c=await service.createLinkForward(3,link.id,8,multi(completeSet));
    const current=()=>tables.tunnel.find(r=>r.id===c.id);
    const snapshots=()=>tables.revision.filter(r=>r.tunnel_id===c.id);
    const expectedTargets=set=>set.targets.map((target,order_by)=>({...target,weight:1,order_by}));
    const assertSaved=(set,status="active")=>{
      const row=current(),snapshot=snapshots().at(-1);
      assert.deepEqual(row.link_target_config,set);
      assert.deepEqual(snapshot.link_target_config,set);
      assert.deepEqual(snapshot.targets,expectedTargets(set),"snapshot freezes every target in order");
      assert.equal(snapshot.revision,row.config_revision);
      assert.equal(row.desired_revision_id,snapshot.id);
      assert.equal(row.desired_status,status);assert.equal(snapshot.desired_status,status);
      assert.equal(row.remote_host,set.targets[0].host);assert.equal(row.remote_port,set.targets[0].port);
      assert.equal(snapshot.target_host,set.targets[0].host);assert.equal(snapshot.target_port,set.targets[0].port);
      assert.equal(row.egress_pool_id,null);assert.equal(snapshot.egress_pool_id,null);
    };
    const assertRuntime=(config,set)=>{
      const runtime={version:1,ruleId:c.id,protocol:"both",targets:set.targets,strategy:set.strategy,
        failureSeconds:set.failure_seconds,recoverSeconds:set.recover_seconds,probe:set.probe};
      if(config.role==="ingress")assert.deepEqual(config.runner_config.entries.find(e=>e.ruleId===c.id).targetSet,runtime);
      else {
        assert.deepEqual(config.runner_config.targetSets.find(s=>s.ruleId===c.id),runtime);
        assert.deepEqual(config.runner_config.allowedBindings.filter(s=>s.ruleId===c.id),
          ["tcp","udp"].flatMap(protocol=>set.targets.map(t=>({ruleId:c.id,protocol,targetIp:t.host,targetPort:t.port}))));
      }
    };
    const assertRestorable=async set=>{
      const deployment=tables.deployment.at(-1),snapshot=structuredClone(deployment.binding_snapshot);
      assert.deepEqual(snapshot.spec.bindings.find(r=>r.forward_id===c.id).target_set,set);
      assert.deepEqual(snapshot.revisions,tables.tunnel.filter(r=>r.desired_status==="active")
        .map(r=>({id:r.id,revision:r.config_revision})));
      for(const id of [11,12]) {
        const configs=await service.desiredNodeLinks(id);assert.equal(configs.length,1);
        assertRuntime(configs[0],set);
        assert.equal(configs[0].generation,deployment.generation);
        assert.equal(configs[0].config_digest,tables.placement.find(p=>p.deployment_id===deployment.id&&p.node_id===id).config_digest);
      }
      assert.deepEqual(deployment.binding_snapshot,snapshot,"lease renewal never rewrites immutable target/revision facts");
    };
    assertSaved(completeSet);await assertRestorable(completeSet);
    const publicLink=await service.getLink(3,link.id);
    assert.deepEqual(publicLink.forwards.find(r=>r.id===c.id).target_set,completeSet);
    assert.equal("link_target_config" in publicLink.forwards.find(r=>r.id===c.id),false);
    const legacy=publicLink.forwards.find(r=>r.id===b.id);
    assert.equal("target_set" in legacy,false);assert.equal("link_target_config" in legacy,false);
    assert.equal(tables.tunnel.find(r=>r.id===b.id).link_target_config,null);
    assert.equal(tables.revision.find(r=>r.tunnel_id===b.id).link_target_config,null);
    assert.deepEqual(tables.revision.find(r=>r.tunnel_id===b.id).targets,
      [{host:"127.0.0.1",port:27000,weight:1,order_by:1000}]);
    const firstSnapshot=structuredClone(snapshots()[0]),firstDeployment=structuredClone(tables.deployment.at(-1).binding_snapshot);
    const firstDeploymentId=tables.deployment.at(-1).id;
    const oldDigests=sent.slice(-2).map(s=>s.config.config_digest);
    const edited={...structuredClone(completeSet),strategy:"random",probe:"none"};
    edited.targets[1].port=28001;
    for(const missing of [11,12]) {
      targetCapNodes.delete(missing);const before=persisted();
      await assert.rejects(()=>service.updateLinkForward(3,link.id,c.id,8,current().config_revision,multi(edited)),
        e=>e.code==="agent_fxp_targets_capability_missing");
      await assert.rejects(()=>service.deployLink(3,link.id),e=>e.code==="agent_fxp_targets_capability_missing");
      assert.deepEqual(persisted(),before);targetCapNodes.add(missing);
    }
    await service.updateLinkForward(3,link.id,c.id,8,current().config_revision,multi(edited));
    assertSaved(edited);await assertRestorable(edited);
    assert.deepEqual(snapshots()[0],firstSnapshot);
    assert.deepEqual(tables.deployment.find(d=>d.id===firstDeploymentId).binding_snapshot,firstDeployment);
    assert.ok(sent.slice(-2).every((s,i)=>s.config.config_digest!==oldDigests[i]),"backup-only edits change both config identities");
    for(const [expected,body,code] of [[current().config_revision,rule("F2",26002),"link_target_set_required"],
      [current().config_revision-1,multi(completeSet),"revision_conflict"]]) {
      const before=persisted();
      await assert.rejects(()=>service.updateLinkForward(3,link.id,c.id,8,expected,body),e=>e.code===code);
      assert.deepEqual(persisted(),before,"omitted set and stale CAS cannot fall back to the first target");
    }
    await service.actionLinkForward(3,link.id,c.id,"suspend",8);assertSaved(edited,"inactive");
    assert.equal(current().apply_status,"suspended");
    const suspendedPreview=await service.previewLinkMaintenance(3,link.id,previewInput());
    assert.equal(suspendedPreview.references.total,3);assert.equal(suspendedPreview.references.suspended,1);
    assert.equal(suspendedPreview.references.forwards.find(r=>r.id===c.id).config_revision,current().config_revision);
    assert.equal(tables.deployment.at(-1).binding_snapshot.spec.bindings.some(r=>r.forward_id===c.id),false);
    assert.equal(sent.at(-2).config.runner_config.allowedBindings.some(r=>r.ruleId===c.id),false);
    const suspendedSet={...structuredClone(edited),strategy:"round_robin",failure_seconds:3600,recover_seconds:10};
    suspendedSet.targets=[suspendedSet.targets[0],suspendedSet.targets[2],suspendedSet.targets[1]];
    targetCapNodes.delete(12);const beforeSuspended=persisted();
    await assert.rejects(()=>service.updateLinkForward(3,link.id,c.id,8,current().config_revision,multi(suspendedSet)),
      e=>e.code==="agent_fxp_targets_capability_missing");
    assert.deepEqual(persisted(),beforeSuspended);targetCapNodes.add(12);
    await service.updateLinkForward(3,link.id,c.id,8,current().config_revision,multi(suspendedSet,"F2 suspended edit"));
    assertSaved(suspendedSet,"inactive");
    assert.equal(tables.deployment.at(-1).binding_snapshot.spec.bindings.some(r=>r.forward_id===c.id),false);
    await service.actionLinkForward(3,link.id,c.id,"resume",8);assertSaved(suspendedSet);await assertRestorable(suspendedSet);

    const recoveredSet={...structuredClone(suspendedSet),strategy:"fallback",probe:"tcp"};
    recoveredSet.targets[2].host="recovered.example";
    failIngress=true;
    await assert.rejects(()=>service.updateLinkForward(3,link.id,c.id,8,current().config_revision,multi(recoveredSet)),/link_apply_unconfirmed/);
    failIngress=false;assertSaved(recoveredSet);await assertRestorable(recoveredSet);
    const failedDeployment=tables.deployment.at(-1),failedFacts=structuredClone(failedDeployment.binding_snapshot);
    const failedGeneration=failedDeployment.generation,failedRevision=current().config_revision;
    assert.equal(failedDeployment.status,"degraded");
    assert.equal((await service.reconcileLinks()).errors,0);
    assert.equal(tables.link[0].generation,failedGeneration,"recovery hydrates the committed deployment");
    assert.equal(current().applied_revision,failedRevision);assertSaved(recoveredSet);
    assert.deepEqual(failedDeployment.binding_snapshot,failedFacts);
    await assertRestorable(recoveredSet);
    const retryRevisionCount=snapshots().length;
    await service.actionLinkForward(3,link.id,c.id,"retry",8);
    assert.equal(snapshots().length,retryRevisionCount);assertSaved(recoveredSet);await assertRestorable(recoveredSet);

    lateAck=true;lateAckForwardId=c.id;
    await service.deployLink(3,link.id);lateAck=false;lateAckForwardId=null;
    const staleFacts=structuredClone(tables.deployment.at(-1).binding_snapshot),staleGeneration=tables.link[0].generation;
    assert.ok(current().applied_revision<current().config_revision,"an ACK cannot apply a later Forward revision");
    for(const id of [11,12])assert.equal((await service.desiredNodeLinks(id)).length,0,"same targets with stale revision facts cannot restore");
    assert.equal((await service.reconcileLinks()).errors,0);
    assert.equal(tables.link[0].generation,staleGeneration+1);
    assert.deepEqual(tables.deployment.find(d=>d.generation===staleGeneration).binding_snapshot,staleFacts);
    await assertRestorable(recoveredSet);

    failIngress=true;
    await assert.rejects(()=>service.actionLinkForward(3,link.id,c.id,"delete",8),/link_apply_unconfirmed/);
    failIngress=false;assertSaved(recoveredSet,"inactive");
    assert.equal(tables.deployment.at(-1).binding_snapshot.spec.bindings.some(r=>r.forward_id===c.id),false);
    assert.equal(sent.at(-2).config.runner_config.allowedBindings.some(r=>r.ruleId===c.id),false);
    assert.equal((await service.reconcileLinks()).errors,0);
    await service.actionLinkForward(3,link.id,c.id,"delete",8);
    assert.equal(current(),undefined);
    assert.deepEqual(snapshots().at(-1).link_target_config,recoveredSet);
    assert.deepEqual(snapshots().at(-1).targets,expectedTargets(recoveredSet));
    assert.deepEqual(snapshots()[0],firstSnapshot);
    assert.deepEqual((await service.getLink(3,link.id)).forwards.map(r=>r.id),[a.id,b.id]);


    // F3 is shared FXP TCP only; source trust is immutable and capability-gated.
    const rawSource={version:1,receive_proxy:true,trusted_cidrs:["192.0.2.129/24","2001:0DB8:1234::1/48"],send_proxy:"v2"};
    const canonicalSource={...rawSource,trusted_cidrs:["192.0.2.0/24","2001:db8:1234::/48"]};
    const disabledSource={version:1,receive_proxy:false,trusted_cidrs:[],send_proxy:"off"};
    const hashSet={...structuredClone(completeSet),strategy:"ip_hash"};
    const sourceBody=(source=rawSource,set=hashSet)=>({...rule("F3",26003),protocol:"tcp",target_set:set,client_source:source});
    assert.deepEqual(service.LinkBindingSchema.parse(sourceBody()).client_source,canonicalSource);
    for(const client_source of [null,{...rawSource,extra:true},{...rawSource,trusted_cidrs:["192.0.2.1/24","192.0.2.129/24"]},{...rawSource,trusted_cidrs:["::ffff:192.0.2.1/104"]}])
      assert.equal(service.LinkBindingSchema.safeParse({...sourceBody(),client_source}).success,false);
    for(const missing of [11,12]) {
      sourceCapNodes.delete(missing);const before=persisted();
      for(const body of [sourceBody(),sourceBody(disabledSource)]) {
        await assert.rejects(()=>service.createLinkForward(3,link.id,8,body),e=>e.code==="agent_fxp_source_capability_missing");
        assert.deepEqual(persisted(),before,"source admission precedes reservations and durable writes");
      }
      sourceCapNodes.add(missing);
      targetCapNodes.delete(missing);
      await assert.rejects(()=>service.createLinkForward(3,link.id,8,sourceBody()),e=>e.code==="agent_fxp_targets_capability_missing");
      assert.deepEqual(persisted(),before);targetCapNodes.add(missing);
    }
    for(const protocol of ["udp","both"])for(const source of [rawSource,disabledSource]) {
      const before=persisted();
      await assert.rejects(()=>service.createLinkForward(3,link.id,8,{...sourceBody(source),protocol}));
      assert.deepEqual(persisted(),before);
    }
    const d=await service.createLinkForward(3,link.id,8,sourceBody());
    const sourceRow=()=>tables.tunnel.find(r=>r.id===d.id);
    const sourceSnapshots=()=>tables.revision.filter(r=>r.tunnel_id===d.id);
    const assertSource=(expected,status="active")=>{
      const row=sourceRow(),snapshot=sourceSnapshots().at(-1);
      assert.deepEqual(row.link_source_config,expected);assert.deepEqual(snapshot.link_source_config,expected);
      assert.deepEqual(row.link_target_config,hashSet);assert.deepEqual(snapshot.targets,expectedTargets(hashSet));
      assert.equal(row.desired_status,status);assert.equal(snapshot.desired_status,status);
      assert.equal(row.config_revision,snapshot.revision);assert.equal(row.desired_revision_id,snapshot.id);
    };
    const assertSourceRestore=async expected=>{
      const deployment=tables.deployment.at(-1),frozen=structuredClone(deployment.binding_snapshot);
      assert.deepEqual(frozen.spec.bindings.find(b=>b.forward_id===d.id).client_source,expected);
      for(const nodeId of [11,12]) {
        const config=(await service.desiredNodeLinks(nodeId))[0];assert.ok(config);
        const runtime={version:1,receiveProxy:expected.receive_proxy,trustedCIDRs:expected.trusted_cidrs,sendProxy:expected.send_proxy};
        if(nodeId===11) {
          const entry=config.runner_config.entries.find(b=>b.ruleId===d.id);
          assert.deepEqual(entry.clientSource,runtime);assert.equal("ruleId" in entry.clientSource,false);
        } else {
          assert.deepEqual(config.runner_config.clientSources.find(b=>b.ruleId===d.id),{...runtime,ruleId:d.id});
          assert.deepEqual(config.runner_config.allowedBindings.filter(b=>b.ruleId===d.id),
            hashSet.targets.map(t=>({ruleId:d.id,protocol:"tcp",targetIp:t.host,targetPort:t.port})));
        }
      }
      assert.deepEqual(deployment.binding_snapshot,frozen);
    };
    assertSource(canonicalSource);assert.equal(sourceRow().config_revision,1);
    assert.deepEqual(sourceSnapshots()[0].link_source_config,canonicalSource);await assertSourceRestore(canonicalSource);
    const publicSource=(await service.getLink(3,link.id)).forwards.find(b=>b.id===d.id);
    assert.deepEqual(publicSource.client_source,canonicalSource);
    assert.equal("link_source_config" in publicSource,false);
    const legacySource=(await service.getLink(3,link.id)).forwards.find(f=>f.id===b.id);
    assert.equal("link_source_config" in legacySource,false);assert.equal("client_source" in legacySource,false);
    const firstSourceSnapshot=structuredClone(sourceSnapshots()[0]);
    const firstSourceDeployment=structuredClone(tables.deployment.at(-1).binding_snapshot);
    const firstSourceGeneration=tables.link[0].generation;
    const omitted={...sourceBody(),target_set:{...hashSet,strategy:"fallback"}};delete omitted.client_source;
    const beforeOmitted=persisted();
    await assert.rejects(()=>service.updateLinkForward(3,link.id,d.id,8,sourceRow().config_revision,omitted),
      e=>e.code==="link_client_source_required");assert.deepEqual(persisted(),beforeOmitted);
    const omittedAll={...rule("old client",26003),protocol:"tcp"};
    await assert.rejects(()=>service.updateLinkForward(3,link.id,d.id,8,sourceRow().config_revision,omittedAll),
      e=>e.code==="link_client_source_required");assert.deepEqual(persisted(),beforeOmitted);
    const omittedHash=sourceBody();delete omittedHash.client_source;
    await assert.rejects(()=>service.updateLinkForward(3,link.id,d.id,8,sourceRow().config_revision,omittedHash),
      e=>e.code==="link_client_source_required");assert.deepEqual(persisted(),beforeOmitted);
    const beforeCAS=persisted();
    await assert.rejects(()=>service.updateLinkForward(3,link.id,d.id,8,sourceRow().config_revision-1,sourceBody()),
      e=>e.code==="revision_conflict");assert.deepEqual(persisted(),beforeCAS);

    // Both active and suspended edits preflight the merged config before writes.
    const normalRows=tables.tunnel.length,normalStatus=sourceRow().desired_status;
    const largeTargets={...structuredClone(hashSet),strategy:"fallback",targets:Array.from({length:10},(_,i)=>({host:"x".repeat(250),port:443+i}))};
    tables.tunnel.push(...Array.from({length:350},(_,i)=>({...sourceRow(),id:10000+i,listen_port:30000+i,
      remote_host:largeTargets.targets[0].host,remote_port:443,link_target_config:structuredClone(largeTargets)})));
    for(const desired_status of ["active","inactive"]) {
      sourceRow().desired_status=desired_status;const before=persisted();
      await assert.rejects(()=>service.updateLinkForward(3,link.id,d.id,8,sourceRow().config_revision,sourceBody()),
        e=>e.code==="link_config_too_large");
      assert.deepEqual(persisted(),before,"byte budget refusal precedes revisions, reservations and deployments");
    }
    tables.tunnel.splice(normalRows);sourceRow().desired_status=normalStatus;

    await service.actionLinkForward(3,link.id,d.id,"suspend",8);assertSource(canonicalSource,"inactive");
    for(const missing of [11,12]) {
      sourceCapNodes.delete(missing);const before=persisted();
      await assert.rejects(()=>service.updateLinkForward(3,link.id,d.id,8,sourceRow().config_revision,sourceBody(disabledSource)),
        e=>e.code==="agent_fxp_source_capability_missing");
      await assert.rejects(()=>service.actionLinkForward(3,link.id,d.id,"resume",8),e=>e.code==="agent_fxp_source_capability_missing");
      assert.deepEqual(persisted(),before);sourceCapNodes.add(missing);
      targetCapNodes.delete(missing);
      await assert.rejects(()=>service.updateLinkForward(3,link.id,d.id,8,sourceRow().config_revision,sourceBody()),
        e=>e.code==="agent_fxp_targets_capability_missing");
      assert.deepEqual(persisted(),before);targetCapNodes.add(missing);
    }
    const editedSource={...canonicalSource,send_proxy:"v1"};
    await service.updateLinkForward(3,link.id,d.id,8,sourceRow().config_revision,sourceBody(editedSource));
    assertSource(editedSource,"inactive");
    assert.equal(tables.deployment.at(-1).binding_snapshot.spec.bindings.some(b=>b.forward_id===d.id),false);
    await service.actionLinkForward(3,link.id,d.id,"resume",8);assertSource(editedSource);await assertSourceRestore(editedSource);
    failIngress=true;
    await assert.rejects(()=>service.updateLinkForward(3,link.id,d.id,8,sourceRow().config_revision,sourceBody(disabledSource)),/link_apply_unconfirmed/);
    failIngress=false;assertSource(disabledSource);
    const failedSource=structuredClone(tables.deployment.at(-1).binding_snapshot),failedSourceGeneration=tables.link[0].generation;
    assert.equal((await service.reconcileLinks()).errors,0);
    assert.equal(tables.link[0].generation,failedSourceGeneration);assertSource(disabledSource);await assertSourceRestore(disabledSource);
    assert.deepEqual(tables.deployment.at(-1).binding_snapshot,failedSource);
    const sourceRevisionCount=sourceSnapshots().length;
    await service.actionLinkForward(3,link.id,d.id,"retry",8);
    assert.equal(sourceSnapshots().length,sourceRevisionCount);assertSource(disabledSource);await assertSourceRestore(disabledSource);
    assert.deepEqual(sourceSnapshots()[0],firstSourceSnapshot);
    assert.deepEqual(tables.deployment.find(b=>b.generation===firstSourceGeneration).binding_snapshot,firstSourceDeployment);
    // Snapshot-era capabilities are not permanent attestations.
    sourceCapNodes.delete(12);
    assert.equal((await service.desiredNodeLinks(11)).length,0);
    assert.equal((await service.reconcileLinks()).errors,1);
    assert.equal(tables.deployment.at(-1).status,"policy_blocked");
    sourceCapNodes.add(12);assert.equal((await service.reconcileLinks()).errors,0);
    assertSource(disabledSource);await assertSourceRestore(disabledSource);
    await service.actionLinkForward(3,link.id,d.id,"delete",8);
    assert.equal(sourceRow(),undefined);assert.deepEqual(sourceSnapshots().at(-1).link_source_config,disabledSource);

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
  // Keep module mocks isolated without exceeding Windows command-line limits.
  const fixture = fileURLToPath(new URL(".link-resource-" + randomUUID() + ".ts", import.meta.url));
  writeFileSync(fixture, scenario, { flag: "wx" });
  try {
    const result = Bun.spawnSync([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    expect(result.exitCode).toBe(0);
  } finally {
    unlinkSync(fixture);
  }
});
