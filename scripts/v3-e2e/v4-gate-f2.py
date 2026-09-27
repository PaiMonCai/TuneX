#!/usr/bin/env python3
"""V4-F2 real integration closure gate."""
from __future__ import annotations
import json, os, subprocess, time, urllib.error, urllib.request
from pathlib import Path

HERE=Path(__file__).resolve().parent
STATE=HERE/"state.json"; ENVF=HERE/".env.wp14"; PASSF=HERE/".passwords.env"
API=os.environ.get("API","http://127.0.0.1:18180")
OUT=HERE/"evidence"; OUT.mkdir(exist_ok=True)
RESULT=OUT/"v4-gate-f2-result.txt"
PASS=FAIL=0; RESULTS=[]

def ok(m):
    global PASS; PASS+=1; RESULTS.append("PASS | "+m); print("PASS | "+m,flush=True)
def bad(m):
    global FAIL; FAIL+=1; RESULTS.append("FAIL | "+m); print("FAIL | "+m,flush=True)
def check(v,m,d=""): (ok if v else bad)(m if v or not d else f"{m} [{d}]")
def parse_env(p):
    out={}
    for line in Path(p).read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k,v=line.split("=",1); out[k]=v
    return out
def password():
    return subprocess.check_output(["bash","-c",". \"$1\"; printf %s \"$WP14_USER_PASSWORD\"","_",str(PASSF)],text=True)
def run(args,env=None,allow=False):
    p=subprocess.run(args,text=True,capture_output=True,env=env)
    if p.returncode and not allow: raise RuntimeError(p.stderr or p.stdout)
    return p.stdout.strip()
def mysql(sql):
    e=parse_env(ENVF)
    return run(["docker","exec","wp14-mysql","mysql","-uroot",f"-p{e['MYSQL_ROOT_PASSWORD']}",e.get("MYSQL_DATABASE","tunex"),"-N","-e",sql])
def scalar(sql):
    v=mysql(sql).strip()
    return v.splitlines()[-1].strip() if v else ""
def req(method,path,body=None,cookie=None,workspace=None,headers=None,timeout=90):
    data=json.dumps(body).encode() if body is not None else None
    h={"content-type":"application/json","x-requested-with":"XMLHttpRequest","origin":API}
    if cookie: h["cookie"]=cookie
    if workspace is not None: h["x-workspace-id"]=str(workspace)
    if headers: h.update(headers)
    q=urllib.request.Request(API+path,data=data,method=method,headers=h)
    try:
        with urllib.request.urlopen(q,timeout=timeout) as r:
            raw=r.read().decode(); return r.status,(json.loads(raw) if raw.strip() else {}),r.headers
    except urllib.error.HTTPError as e:
        raw=e.read().decode()
        try: b=json.loads(raw) if raw.strip() else {}
        except Exception: b={"raw":raw}
        return e.code,b,e.headers
def unwrap(b): return b.get("data",b) if isinstance(b,dict) else b
def login(email,pw):
    s,b,h=req("POST","/api/auth/login",{"email":email,"password":pw})
    check(s==200,"F2.0 E2E 用户登录",f"status={s} body={b}")
    return (h.get("set-cookie") or "").split(";",1)[0]
def lifecycle(cookie,nid):
    s,b,_=req("GET",f"/api/admin/node/{nid}/lifecycle",cookie=cookie)
    return s,unwrap(b)
def health(cookie,nid):
    s,b,_=req("GET",f"/api/admin/node/{nid}/health",cookie=cookie)
    return s,unwrap(b)
def patch_lifecycle(cookie,nid,value,note=None):
    body={"lifecycle":value}
    if note is not None: body["note"]=note
    return req("PATCH",f"/api/admin/node/{nid}/lifecycle",body,cookie)
def wait_until(fn,timeout=150,interval=2):
    end=time.time()+timeout; last=None
    while time.time()<end:
        try:
            last=fn()
            if last: return last
        except Exception as e: last=e
        time.sleep(interval)
    return None
def wait_forward(fid):
    def one():
        row=scalar(f"SELECT CONCAT(IFNULL(applied_revision,0),'|',IFNULL(config_revision,0),'|',IFNULL(apply_status,'')) FROM tunnel WHERE id={fid};")
        if not row: return None
        a,c,s=row.split("|")
        return row if a==c and s=="active" else None
    return wait_until(one,180,2)
def probe(host,port):
    return run(["docker","exec","wp14-client","sh","-c",f"nc -w 4 {host} {port} </dev/null"],allow=True).replace("\r","").replace("\n","").strip()

if not (STATE.exists() and ENVF.exists() and PASSF.exists()): raise SystemExit("missing e2e state")
state=json.loads(STATE.read_text())
email=state["user"]["email"]; pw=password(); ws=state["workspaces"]["primary"]["id"]
ing=state["nodes"]["ingress"]["id"]; eg=state["nodes"]["egress"]["id"]; fid=state["forward"]["id"]
group=state["nodeGroups"]["ingress"]["id"]

# Disposable E2E fixture: exercise real admin routes and allow one temporary Node.
mysql(f"UPDATE user SET super_admin=1 WHERE email='{email}';")
mysql("UPDATE capability_policy SET max_nodes=8, revision=revision+1 WHERE applies_to='team' AND source='system_default' AND is_default=1;")
cookie=login(email,pw)

# waiting -> retiring dependency preview/delete gate
s,b,_=req("POST",f"/api/node-groups/{group}/nodes",{"node_id":"WP14-F2-WAIT-NODE","connect_ip":"172.31.10.99","role":"ingress"},cookie,ws)
node=unwrap(b).get("node",{}) if s in (200,201) and isinstance(unwrap(b),dict) else {}
wid=node.get("id")
check(s in (200,201) and bool(wid),"F2.1 临时 Node 通过真实 provision API 创建",f"status={s} body={b}")
if wid:
    s,v=lifecycle(cookie,wid)
    check(s==200 and v.get("connection")=="waiting","F2.2 未 enrollment Node = waiting",f"view={v}")
    s,h=health(cookie,wid)
    check(s==200 and h.get("health")=="unknown" and h.get("telemetry") is None,"F2.3 waiting Node health=unknown",f"health={h}")
    s,b,_=req("POST",f"/api/nodes/{wid}/bindings",{"egress_node_id":eg},cookie,ws)
    check(s in (200,201),"F2.4 建立真实 Binding 依赖",f"status={s} body={b}")
    s,b,_=req("GET",f"/api/admin/node/{wid}/impact",cookie=cookie)
    impact=(unwrap(b).get("impact") or {}) if isinstance(unwrap(b),dict) else {}
    check(s==200 and int(impact.get("binding_count",0))>=1,"F2.5 impact 显示 Binding 依赖",f"impact={impact}")
    s,b,_=patch_lifecycle(cookie,wid,"retiring","F2 dependency gate")
    check(s==200,"F2.6 active→retiring",f"status={s} body={b}")
    s,b,_=req("DELETE",f"/api/admin/node/{wid}/lifecycle",cookie=cookie)
    check(s==409 and b.get("code")=="dependency_blocked","F2.7 有依赖时删除 fail-closed",f"status={s} body={b}")
    s,b,_=req("DELETE",f"/api/nodes/{wid}/bindings/{eg}",cookie=cookie,workspace=ws)
    check(s==200,"F2.8 清理临时 Binding",f"status={s} body={b}")
    s,b,_=req("DELETE",f"/api/admin/node/{wid}/lifecycle",cookie=cookie)
    check(s==200 and unwrap(b).get("deleted") is True,"F2.9 依赖清空后 retiring Node 可删除",f"status={s} body={b}")

# online + telemetry
s,v=lifecycle(cookie,ing)
check(s==200 and v.get("connection")=="online" and v.get("lifecycle")=="active","F2.10 Agent = online / active",f"view={v}")
s,h=health(cookie,ing); tele=h.get("telemetry") if isinstance(h,dict) else None
check(s==200 and h.get("connection")=="online" and isinstance(tele,dict),"F2.11 health 返回在线 telemetry",f"health={h}")
if isinstance(tele,dict):
    check(bool(tele.get("version")) and isinstance(tele.get("used_ports"),list) and isinstance(tele.get("runtime"),dict),
          "F2.12 version/runtime/used_ports facts 完整",f"telemetry={tele}")

# role / port-range impact fail closed
s,b,_=req("GET",f"/api/admin/node/{ing}/impact?next_role=egress&current_role=ingress",cookie=cookie)
rc=(unwrap(b).get("role_check") or {}) if isinstance(unwrap(b),dict) else {}
check(s==200 and rc.get("ok") is False,"F2.13 impact preview 阻止 ingress→egress",f"role_check={rc}")
s,b,_=req("PATCH",f"/api/admin/node/{ing}/role",{"role":"egress"},cookie)
check(s==409,"F2.14 role mutation fail-closed",f"status={s} body={b}")
check(scalar(f"SELECT role FROM node WHERE id={ing};")=="ingress","F2.15 role 拒绝后 DB 不变")
old_range=scalar(f"SELECT CONCAT(IFNULL(port_range_min,0),'|',IFNULL(port_range_max,0)) FROM node WHERE id={ing};")
s,b,_=req("PATCH",f"/api/admin/node/{ing}/role",{"role":"ingress","port_range_min":30000,"port_range_max":30010},cookie)
check(s==409,"F2.16 port-range 收缩 orphan lease 时 fail-closed",f"status={s} body={b}")
check(scalar(f"SELECT CONCAT(IFNULL(port_range_min,0),'|',IFNULL(port_range_max,0)) FROM node WHERE id={ing};")==old_range,
      "F2.17 port-range 拒绝后 DB 不变")

# maintenance saves revisions but does not apply; exit converges newest only
s,b,_=req("GET",f"/api/forwards/{fid}",cookie=cookie,workspace=ws); cur=unwrap(b)
rev=int(cur.get("config_revision") or 0)
if cur.get("target_host")!="target-a":
    s,b,_=req("PATCH",f"/api/forwards/{fid}",{"target_host":"target-a","target_port":3030,"expected_revision":rev},cookie,ws,timeout=120)
    check(s==200,"F2.18 maintenance 前归一 target-a",f"status={s} body={b}")
    wait_forward(fid)
    s,b,_=req("GET",f"/api/forwards/{fid}",cookie=cookie,workspace=ws); cur=unwrap(b); rev=int(cur.get("config_revision") or 0)
applied=int(cur.get("applied_revision") or 0)
s,b,_=patch_lifecycle(cookie,ing,"maintenance","F2 maintenance")
check(s==200,"F2.19 active→maintenance",f"status={s} body={b}")
s,b,_=req("PATCH",f"/api/forwards/{fid}",{"target_host":"target-b","target_port":3030,"expected_revision":rev},cookie,ws,timeout=120)
one=unwrap(b) if s==200 else {}; r1=int(one.get("config_revision") or 0)
check(s==200 and r1>rev,"F2.20 maintenance 保存 revision #1",f"status={s} body={b}")
s,b,_=req("PATCH",f"/api/forwards/{fid}",{"target_host":"target-a","target_port":3030,"expected_revision":r1},cookie,ws,timeout=120)
two=unwrap(b) if s==200 else {}; r2=int(two.get("config_revision") or 0)
check(s==200 and r2>r1,"F2.21 maintenance 保存 revision #2",f"status={s} body={b}")
time.sleep(3)
check(int(scalar(f"SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id={fid};") or 0)==applied,"F2.22 maintenance 期间 applied 不前进")
s,b,_=patch_lifecycle(cookie,ing,"active","F2 maintenance exit")
check(s==200,"F2.23 maintenance→active",f"status={s} body={b}")
ledger=wait_forward(fid)
check(bool(ledger) and ledger.split("|")[0]==str(r2),"F2.24 退出 maintenance 后只收敛最新 revision",f"ledger={ledger}")
port=int(scalar(f"SELECT IFNULL(listen_port,0) FROM tunnel WHERE id={fid};") or 0)
check(probe("172.31.10.20",port)=="WP14-TARGET-A","F2.25 收敛后真实数据面可用",f"port={port}")

# disabled admission
s,b,_=patch_lifecycle(cookie,ing,"disabled","F2 disabled")
check(s==200,"F2.26 active→disabled",f"status={s} body={b}")
s,b,_=req("POST","/api/forwards",{"name":"v4-f2-disabled-reject","mode":"direct","ingress_node_id":ing,"listen_port":None,"target_host":"target-a","target_port":3030},cookie,ws,timeout=90)
cond=((b.get("data") or {}).get("condition") if isinstance(b,dict) else None)
check(s==409 and cond=="node_disabled","F2.27 disabled 拒绝新业务",f"status={s} body={b}")
s,b,_=patch_lifecycle(cookie,ing,"active","F2 disabled exit")
check(s==200,"F2.28 disabled→active",f"status={s} body={b}")

# online -> offline -> reinstall -> online, preserving identity/relations
agent_id=scalar(f"SELECT agent_id FROM node WHERE id={ing};")
forward_ids=scalar(f"SELECT GROUP_CONCAT(id ORDER BY id) FROM tunnel WHERE ingress_node_id={ing};")
run(["docker","stop","wp14-ingress-agent"])
offline=wait_until(lambda: (lambda x: x if x[0]==200 and x[1].get("connection")=="offline" else None)(lifecycle(cookie,ing)),125,3)
check(bool(offline),"F2.29 Agent stop 后 online→offline",f"last={offline}")
s,b,_=req("POST",f"/api/nodes/{ing}/enrollment",cookie=cookie,workspace=ws)
enr=unwrap(b) if s in (200,201) else {}; token=enr.get("token") if isinstance(enr,dict) else None
check(s in (200,201) and bool(token),"F2.30 同一 Node 重新签发 enrollment",f"status={s} body={b}")
s,b,_=req("POST","/api/internal/node/enroll",headers={"authorization":f"Enrollment {token}"},timeout=30)
enrolled=unwrap(b) if s==200 else {}; cred=enrolled.get("credential") if isinstance(enrolled,dict) else None
check(s==200 and enrolled.get("agent_id")==agent_id and bool(cred),"F2.31 reinstall enrollment 保持 agent_id",f"status={s} body={b}")
if cred:
    state["nodes"]["ingress"]["credential"]=cred
    STATE.write_text(json.dumps(state,indent=2)); os.chmod(STATE,0o600)
    env=os.environ.copy()
    env["TUNEX_BACKEND_IMAGE"]=run(["docker","inspect","-f","{{.Config.Image}}","wp14-panel"])
    env["WP14_AGENT_IMAGE"]=run(["docker","inspect","-f","{{.Config.Image}}","wp14-egress-agent"])
    for key,prefix in [("ingress","WP14_INGRESS"),("egress","WP14_EGRESS"),("ingress_secondary","WP14_INGRESS_B"),("egress_secondary","WP14_EGRESS_B")]:
        env[prefix+"_CREDENTIAL"]=state["nodes"][key]["credential"]; env[prefix+"_AGENT_ID"]=state["nodes"][key]["agent_id"]
    run(["docker","compose","-f",str(HERE/"docker-compose.e2e.yaml"),"--env-file",str(ENVF),"up","-d","--force-recreate","ingress-agent"],env=env)
    online=wait_until(lambda: (lambda x: x if x[0]==200 and x[1].get("connection")=="online" else None)(lifecycle(cookie,ing)),120,2)
    check(bool(online),"F2.32 reinstall 后 offline→online",f"last={online}")
    check(scalar(f"SELECT agent_id FROM node WHERE id={ing};")==agent_id,"F2.33 reinstall 后 agent_id 不变")
    check(scalar(f"SELECT GROUP_CONCAT(id ORDER BY id) FROM tunnel WHERE ingress_node_id={ing};")==forward_ids,"F2.34 reinstall 后 Node/Forward 关系不变")
    hr=wait_until(lambda: (lambda x: x[1] if x[0]==200 and isinstance(x[1].get("telemetry"),dict) else None)(health(cookie,ing)),90,2)
    check(bool(hr),"F2.35 reinstall 后 health/state report 恢复",f"health={hr}")
    if hr:
        t=hr.get("telemetry") or {}
        check(bool(t.get("version")) and isinstance(t.get("used_ports"),list) and isinstance(t.get("runtime"),dict),
              "F2.36 reinstall 后 version/runtime/port facts 正确",f"telemetry={t}")
    port=int(scalar(f"SELECT IFNULL(listen_port,0) FROM tunnel WHERE id={fid};") or 0)
    check(probe("172.31.10.20",port)=="WP14-TARGET-A","F2.37 reinstall 后数据面恢复",f"port={port}")

RESULT.write_text("# V4-F2 managed-node closure\n"+f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"+"\n".join(RESULTS)+f"\nTOTAL PASS={PASS} FAIL={FAIL}\n")
print(f"V4-F2 TOTAL: PASS={PASS} FAIL={FAIL} evidence={RESULT}")
raise SystemExit(1 if FAIL else 0)
