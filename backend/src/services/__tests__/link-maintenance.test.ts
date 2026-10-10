import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";

test("F5 intents preserve immutable baselines, idempotency, CAS, cancellation, expiry and conservative recovery", () => {
  const modulePath = (p: string) => JSON.stringify(fileURLToPath(new URL(p, import.meta.url)));
  const fixture = fileURLToPath(new URL(`.link-maintenance-${randomUUID()}.ts`, import.meta.url));
  const scenario = `
    import {mock} from "bun:test";
    import assert from "node:assert/strict";
    import {randomUUID} from "node:crypto";
    import {canonicalConfigDigest} from ${modulePath("../../integrations/forwardx/core-contract.ts")};
    import {signMaintenanceReceipt,maintenanceRequestDigest} from ${modulePath("../../integrations/forwardx/link-maintenance-state.ts")};
    import {LinkResourceError} from ${modulePath("../link-errors.ts")};
    process.env.TUNEX_FXP_LINKS_ENABLED="true";process.env.TUNEX_LINK_MAINTENANCE_ENABLED="true";
    const key="53".repeat(32),stateToken="ab".repeat(32);
    let state=stateToken,ready=true,captureFailure=null,failEvent=false;
    const rows=[],events=[];
    let next=1,captures=0;
    const matches=(row,where={})=>Object.entries(where).every(([k,v])=>{
      if(k==="link_id_idempotency_key")return matches(row,v);
      if(v&&typeof v==="object"&&"in"in v)return v.in.includes(row[k]);
      return row[k]===v;
    });
    const storage={
      findUnique:async({where})=>rows.find(r=>matches(r,where))??null,
      findFirst:async({where})=>rows.find(r=>matches(r,where))??null,
      findUniqueOrThrow:async({where})=>{const r=rows.find(r=>matches(r,where));if(!r)throw Error("missing_fixture");return r;},
      findMany:async({where})=>rows.filter(r=>matches(r,where)),
      create:async({data})=>{const r={...structuredClone(data),id:next++,reason_code:null};delete r.events;rows.push(r);
        if(data.events)await db.linkMaintenanceEvent.create({data:{...data.events.create,migration_id:r.id}});return r;},
      updateMany:async({where,data})=>{let count=0;for(const r of rows)if(matches(r,where)){Object.assign(r,data);count++;}return{count};},
    };
    const db={linkMaintenanceMigration:storage,linkMaintenanceEvent:{
      create:async({data})=>{if(failEvent)throw Error("fixture_event_write_failure");const e={...data,id:events.length+1,reason_code:data.reason_code??null};events.push(e);return e;},
      findMany:async({where})=>events.filter(e=>matches(e,where)),
    },$transaction:async(fn)=>{const savedRows=structuredClone(rows),savedEvents=structuredClone(events);
      try{return await fn(db);}catch(error){rows.splice(0,rows.length,...savedRows);events.splice(0,events.length,...savedEvents);throw error;}}};
    mock.module(${modulePath("../../db.ts")},()=>({db}));
    const lockScopedLink=async(tx,ws,id)=>{assert.equal(tx,db);if(ws!==3||id!==7)throw new LinkResourceError("link_not_found",404);return{id,workspace_id:ws};};
    const capture=async(tx,ws,id,request)=>{captures++;await lockScopedLink(tx,ws,id);if(captureFailure)throw captureFailure;
      const config={ingress_node_id:11,egress_node_id:12,carrier_port:25000};
      return{preview:{snapshot:{state_token:state},runtime:{state:ready?"ready":"unknown"},changes:{credentials_changed:request.change.type==="rotate_key",carrier_port_changed:request.change.type==="update_endpoints"}},
        snapshot:{schema_version:1,request,state_token:state,baseline:{config,generation:4,desired_version:2},
          admission:{references:[{id:9,revision:2,desired_status:"active",target_host:"must-not-leak.example"},
            {id:10,revision:3,desired_status:"inactive",target_host:"must-not-leak.example"}]}}};};
    mock.module(${modulePath("../link-resource.ts")},()=>({assertLinkFeature:()=>{if(process.env.TUNEX_FXP_LINKS_ENABLED!=="true")throw new LinkResourceError("fxp_links_not_enabled");},
      captureLinkMaintenance:capture,lockScopedLink,sealKey:()=>key}));
    const service=await import(${modulePath("../link-maintenance.ts")});
    const guard=await import(${modulePath("../link-maintenance-guard.ts")});
    const request={expected_version:2,expected_generation:4,change:{type:"rotate_key"}};
    const input=(now=new Date())=>({...request,idempotency_key:randomUUID(),receipt:signMaintenanceReceipt({workspace_id:3,link_id:7,state_token:state,
      request_digest:maintenanceRequestDigest(request)},key,now)});
    const write=(body,actor=8)=>service.commitLinkMaintenance(3,7,actor,body);
    const fails=(fn,code)=>assert.rejects(fn,e=>e.code===code);
    process.env.TUNEX_LINK_MAINTENANCE_ENABLED="false";await fails(()=>write(input()),"link_maintenance_not_enabled");
    process.env.TUNEX_LINK_MAINTENANCE_ENABLED="true";
    await fails(()=>service.commitLinkMaintenance(4,7,8,input()),"link_not_found");
    await fails(()=>write(input(new Date(Date.now()-60_000))),"link_maintenance_preview_expired");
    ready=false;await fails(()=>write(input()),"link_runtime_unconfirmed");ready=true;
    const stale=input();state="cd".repeat(32);await fails(()=>write(stale),"link_maintenance_preview_invalid");state=stateToken;
    assert.equal(rows.length,0);assert.equal(events.length,0);
    failEvent=true;await assert.rejects(()=>write(input()),/fixture_event_write_failure/);failEvent=false;
    assert.equal(rows.length,0,"record and initial event roll back together");
    const original=input(),saved=await write(original);assert.equal(saved.replayed,false);
    assert.equal(saved.migration.status,"awaiting_executor");assert.equal(saved.migration.state_version,1);
    assert.equal(saved.migration.execution.supported,false);assert.equal(saved.migration.ports.reserved,false);
    assert.deepEqual(saved.migration.references,{total:2,active:1,suspended:1});
    assert.equal(JSON.stringify(saved).includes("must-not-leak"),false);assert.equal("snapshot"in saved.migration,false);
    const privateSnapshot=structuredClone(rows[0].snapshot),id=saved.migration.id;
    assert.equal((await write(original)).migration.id,id);assert.equal(rows.length,1);assert.equal(events.length,1);
    await fails(()=>write({...original,change:{type:"update_endpoints",config:{ingress_node_id:11,egress_node_id:12,carrier_port:25001}}}),"link_maintenance_idempotency_conflict");
    await fails(()=>write(original,9),"link_maintenance_idempotency_conflict");
    await fails(()=>write(input()),"link_maintenance_in_progress");
    await fails(()=>guard.assertNoMaintenanceIntent(db,7),"link_maintenance_in_progress");
    const detail=await service.getLinkMaintenance(3,7,id);assert.equal(detail.events.length,1);
    assert.equal((await service.listLinkMaintenance(3,7)).length,1);
    await fails(()=>service.getLinkMaintenance(4,7,id),"link_not_found");
    await fails(()=>service.getLinkMaintenance(3,7,id+1),"link_maintenance_not_found");
    const beforeCancel=structuredClone({rows,events});
    await fails(()=>service.cancelLinkMaintenance(3,7,id,8,{expected_state_version:2}),"link_maintenance_state_conflict");
    assert.deepEqual({rows,events},beforeCancel);
    assert.deepEqual(await service.reconcileLinkMaintenance(),{scanned:1,closed:0,errors:0});
    process.env.TUNEX_FXP_LINKS_ENABLED="false";process.env.TUNEX_LINK_MAINTENANCE_ENABLED="false";
    const cancelled=await service.cancelLinkMaintenance(3,7,id,8,{expected_state_version:1});
    assert.equal(cancelled.status,"cancelled");assert.equal(cancelled.state_version,2);assert.equal(rows[0].active_link_id,null);
    assert.equal((await service.cancelLinkMaintenance(3,7,id,8,{expected_state_version:1})).status,"cancelled");
    assert.equal(events.length,2);assert.deepEqual(rows[0].snapshot,privateSnapshot,"closing never rebases immutable facts");
    await guard.assertNoMaintenanceIntent(db,7);
    assert.equal((await service.getLinkMaintenance(3,7,id)).events.length,2,"read/cancel works with flags off");
    process.env.TUNEX_FXP_LINKS_ENABLED="true";process.env.TUNEX_LINK_MAINTENANCE_ENABLED="true";
    assert.equal((await write(original)).migration.status,"cancelled","idempotency cannot reopen terminal intent");
    const second=await write(input());rows.at(-1).hold_expires_at=new Date(0);
    await guard.assertNoMaintenanceIntent(db,7);assert.equal(rows.at(-1).status,"expired");
    await fails(()=>service.cancelLinkMaintenance(3,7,second.migration.id,8,{expected_state_version:2}),"link_maintenance_terminal");
    const third=await write(input());state="ef".repeat(32);
    assert.deepEqual(await service.reconcileLinkMaintenance(),{scanned:1,closed:1,errors:0});
    assert.equal(rows.at(-1).status,"invalidated");assert.equal(rows.at(-1).reason_code,"link_maintenance_state_changed");state=stateToken;
    await write(input());captureFailure=Error("database_connection_lost");
    assert.deepEqual(await service.reconcileLinkMaintenance(),{scanned:1,closed:0,errors:1});
    assert.equal(rows.at(-1).status,"awaiting_executor","infrastructure errors are not evidence of invalid state");captureFailure=null;
    ready=false;assert.equal((await service.reconcileLinkMaintenance()).closed,1);ready=true;
    assert.equal(rows.at(-1).reason_code,"link_runtime_unconfirmed");
    await write(input());rows.at(-1).snapshot.baseline.config.carrier_port++;
    assert.equal((await service.reconcileLinkMaintenance()).closed,1);assert.equal(rows.at(-1).reason_code,"link_maintenance_snapshot_corrupt");
    await write(input());captureFailure=new LinkResourceError("agent_fxp_capability_stale");
    assert.equal((await service.reconcileLinkMaintenance()).closed,1);assert.equal(rows.at(-1).reason_code,"agent_fxp_capability_stale");captureFailure=null;
    await write(input());process.env.TUNEX_LINK_MAINTENANCE_ENABLED="false";
    assert.equal((await service.reconcileLinkMaintenance()).closed,1);assert.equal(rows.at(-1).active_link_id,null);
    assert.equal(events.every(e=>e.reason_code==null||/^[a-z_]+$/.test(e.reason_code)),true);
    assert.equal(captures>5,true);
  `;
  writeFileSync(fixture, scenario, { flag: "wx" });
  try {
    const result = Bun.spawnSync([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error(result.stderr.toString());
    expect(result.exitCode).toBe(0);
  } finally { unlinkSync(fixture); }
});
