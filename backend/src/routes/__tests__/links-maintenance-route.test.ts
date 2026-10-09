import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";

test("F5 preview HTTP preserves manage permission, Workspace scoping, strict input, no-store and safe errors", () => {
  const modulePath = (p: string) => JSON.stringify(fileURLToPath(new URL(p, import.meta.url)));
  const fixture = fileURLToPath(new URL(`.links-maintenance-${randomUUID()}.ts`, import.meta.url));
  const scenario = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    import { Hono } from "hono";
    import { HTTPException } from "hono/http-exception";
    import { LinkMaintenancePreviewSchema } from ${modulePath("../../integrations/forwardx/link-maintenance.ts")};
    let authed=true, allowed=true, failure=null;
    const calls=[], permissions=[];
    mock.module(${modulePath("../../services/workspace.ts")},()=>({resolveWorkspaceAccess:async(c,action,resource)=>{
      permissions.push([action,resource]);
      if(!c.get("user"))throw new HTTPException(401,{message:"login_required"});
      if(!allowed)throw new HTTPException(403,{message:"permission_denied"});
      return {id:5};
    }}));
    class LinkResourceError extends Error { constructor(code,status=409){super(code);this.code=code;this.status=status;} }
    const unused=async()=>{throw Error("unexpected_mutation");};
    mock.module(${modulePath("../../services/link-resource.ts")},()=>({LinkResourceError,
      listLinks:unused,getLink:unused,createLink:unused,updateLink:unused,deployLink:unused,retireLink:unused,
      createLinkForward:unused,updateLinkForward:unused,actionLinkForward:unused,
      previewLinkMaintenance:async(ws,id,raw)=>{const input=LinkMaintenancePreviewSchema.parse(raw);
        calls.push([ws,id,input]);if(failure)throw failure;
        return {link_id:id,workspace_id:ws,execution:{supported:false}};
      }}));
    const {linksRoutes}=await import(${modulePath("../links.ts")});
    const app=new Hono();app.use("*",async(c,next)=>{if(authed)c.set("user",{id:8});await next();});app.route("/api/links",linksRoutes);
    const body={expected_version:2,expected_generation:4,change:{type:"rotate_key"}};
    const req=(input=body,id="3")=>app.request("http://localhost/api/links/"+id+"/maintenance/preview",{
      method:"POST",headers:{"content-type":"application/json","x-workspace-id":"999"},body:JSON.stringify(input)});
    let response=await req();assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
    assert.deepEqual(await response.json(),{data:{link_id:3,workspace_id:5,execution:{supported:false}}});
    assert.deepEqual(calls,[[5,3,body]]);assert.deepEqual(permissions,[["manage","node"]]);
    authed=false;response=await req();assert.equal(response.status,401);assert.equal(calls.length,1);
    authed=true;allowed=false;response=await req();assert.equal(response.status,403);assert.equal(calls.length,1);allowed=true;
    for(const invalid of [{...body,key:"private"},{...body,expected_generation:-1},{...body,change:{type:"rotate_key",key:"private"}}]){
      response=await req(invalid);assert.equal(response.status,400);assert.equal((await response.json()).code,"invalid_input");
    }
    response=await req(body,"2147483648");assert.equal(response.status,400);assert.equal(calls.length,1);
    response=await app.request("http://localhost/api/links/3/maintenance/preview",{
      method:"POST",headers:{"content-type":"application/json"},body:"not-json"});
    assert.equal(response.status,400);assert.equal((await response.json()).code,"invalid_input");assert.equal(calls.length,1);
    for(const code of ["link_version_conflict","link_generation_conflict","fxp_links_not_enabled"]){
      failure=new LinkResourceError(code);response=await req();assert.equal(response.status,409);
      assert.equal(response.headers.get("cache-control"),"no-store");assert.equal((await response.json()).code,code);
    }
    failure=Error("runner key=must-not-leak");response=await req();assert.equal(response.status,503);
    assert.deepEqual(await response.json(),{error:"连接资源操作未完成",code:"link_operation_failed"});
  `;
  writeFileSync(fixture, scenario, { flag: "wx" });
  try {
    const result = Bun.spawnSync([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error(result.stderr.toString());
    expect(result.exitCode).toBe(0);
  } finally { unlinkSync(fixture); }
});
