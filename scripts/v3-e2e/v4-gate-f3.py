#!/usr/bin/env python3
"""V4-F3 real product-closure gate."""
from __future__ import annotations
import json, os, subprocess, time, urllib.error, urllib.request
from pathlib import Path

HERE=Path(__file__).resolve().parent
STATE=HERE/"state.json"; ENVF=HERE/".env.wp14"; PASSF=HERE/".passwords.env"
API=os.environ.get("API","http://127.0.0.1:18180")
OUT=HERE/"evidence"; OUT.mkdir(exist_ok=True)
RESULT=OUT/"v4-gate-f3-result.txt"
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
def run(args,allow=False):
    p=subprocess.run(args,text=True,capture_output=True)
    if p.returncode and not allow: raise RuntimeError(p.stderr or p.stdout)
    return p.stdout.strip()
def mysql(sql):
    e=parse_env(ENVF)
    return run(["docker","exec","wp14-mysql","mysql","-uroot",f"-p{e['MYSQL_ROOT_PASSWORD']}",e.get("MYSQL_DATABASE","tunex"),"-N","-e",sql])
def scalar(sql):
    v=mysql(sql).strip()
    return v.splitlines()[-1].strip() if v else ""
def req(method,path,body=None,cookie=None,workspace=None,timeout=120):
    data=json.dumps(body).encode() if body is not None else None
    h={"content-type":"application/json","x-requested-with":"XMLHttpRequest","origin":API}
    if cookie: h["cookie"]=cookie
    if workspace is not None: h["x-workspace-id"]=str(workspace)
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
    check(s==200,"F3.0 E2E 用户登录",f"status={s} body={b}")
    return (h.get("set-cookie") or "").split(";",1)[0]
def wait_active(ids,timeout=180):
    end=time.time()+timeout
    while time.time()<end:
        n=int(scalar(f"SELECT COUNT(*) FROM tunnel WHERE id IN ({','.join(map(str,ids))}) AND apply_status='active' AND applied_revision=config_revision;") or 0)
        if n==len(ids): return True
        time.sleep(2)
    return False
def probe(host,port):
    return run(["docker","exec","wp14-client","sh","-c",f"nc -w 4 {host} {port} </dev/null"],allow=True).replace("\r","").replace("\n","").strip()

state=json.loads(STATE.read_text())
ws=state["workspaces"]["primary"]["id"]; ing=state["nodes"]["ingress"]["id"]; eg=state["nodes"]["egress"]["id"]
cookie=login(state["user"]["email"],password())

def page(n,size=2,extra=""):
    s,b,_=req("GET",f"/api/forwards?page={n}&page_size={size}&sort=name&order=asc{extra}",cookie=cookie,workspace=ws)
    return s,unwrap(b)

# server pagination/filter/sort
s,p1=page(1); s2,p2=page(2)
i1=p1.get("data",[]) if isinstance(p1,dict) else []; i2=p2.get("data",[]) if isinstance(p2,dict) else []
check(s==200 and s2==200 and p1.get("page")==1 and p1.get("page_size")==2,"F3.1 服务端分页信封正确",f"p1={p1}")
ids1=[x.get("id") for x in i1]; ids2=[x.get("id") for x in i2]
check(not set(ids1)&set(ids2),"F3.2 相邻页无重复 Forward",f"page1={ids1} page2={ids2}")
names=[str(x.get("name","")) for x in i1+i2]
check(names==sorted(names),"F3.3 name asc 跨页稳定",f"names={names}")

s,direct=page(1,200,"&mode=direct"); ditems=direct.get("data",[]) if isinstance(direct,dict) else []
check(s==200 and all(x.get("mode")=="direct" for x in ditems),"F3.4 mode=direct 服务端筛选",f"items={ditems}")
s,egress=page(1,200,f"&egress_node_id={eg}"); eitems=egress.get("data",[]) if isinstance(egress,dict) else []
check(s==200 and all(int(x.get("egress_node_id") or 0)==eg for x in eitems),"F3.5 egress_node_id 服务端筛选",f"items={eitems}")

# Binding usage + blocked unbind
s,b,_=req("GET",f"/api/nodes/{ing}/bindings",cookie=cookie,workspace=ws)
bindings=unwrap(b) if s==200 else []
used=next((x for x in bindings if int(x.get("used_by_forward_count") or 0)>0),None) if isinstance(bindings,list) else None
check(s==200 and used is not None,"F3.6 Binding 列表带真实 usage",f"bindings={bindings}")
if used:
    count=int(used.get("used_by_forward_count") or 0); eid=int(used["egress_node_id"])
    s,b,_=req("DELETE",f"/api/nodes/{ing}/bindings/{eid}",cookie=cookie,workspace=ws)
    check(s==409 and b.get("code")=="binding_in_use" and int(b.get("used_by_forward_count") or 0)==count,
          "F3.7 使用中的 Binding 删除返回 409 + usage",f"status={s} body={b}")

# auto-port and final real access address
s,b,_=req("GET","/api/forwards",cookie=cookie,workspace=ws)
allrows=unwrap(b) if s==200 else []
for x in (allrows if isinstance(allrows,list) else []):
    if x.get("name")=="v4-f3-auto-port":
        req("DELETE",f"/api/forwards/{x['id']}",cookie=cookie,workspace=ws)
s,b,_=req("POST","/api/forwards",{"name":"v4-f3-auto-port","mode":"direct","ingress_node_id":ing,"listen_port":None,"target_host":"target-a","target_port":3030},cookie,ws)
auto=unwrap(b) if s==201 else {}; auto_id=auto.get("id"); auto_port=int(auto.get("listen_port") or 0)
connect_ip=((auto.get("ingress_node") or {}).get("connect_ip") if isinstance(auto,dict) else None)
check(s==201 and bool(auto_id) and 1<=auto_port<=65535,"F3.8 auto-port 返回最终端口",f"status={s} body={b}")
check(bool(connect_ip),"F3.9 返回 Ingress connect_ip，可形成最终访问地址",f"ingress={auto.get('ingress_node') if isinstance(auto,dict) else None}")
if auto_port:
    check(probe("172.31.10.20",auto_port)=="WP14-TARGET-A","F3.10 auto-port 最终地址真实可访问",f"address=172.31.10.20:{auto_port}")

# batch actions with per-item summary
s,b,_=req("GET","/api/forwards",cookie=cookie,workspace=ws)
allrows=unwrap(b) if s==200 else []
active=[int(x["id"]) for x in (allrows if isinstance(allrows,list) else []) if x.get("apply_status")=="active" and int(x.get("ingress_node_id") or 0)==ing][:2]
check(len(active)>=2,"F3.11 至少两条 active Forward 可批量操作",f"ids={active}")
if len(active)>=2:
    s,b,_=req("POST","/api/forwards/batch",{"action":"suspend","ids":active},cookie,ws,timeout=180)
    payload=unwrap(b) if s==200 else {}
    check(s==200 and isinstance(payload,dict) and int(payload.get("succeeded") or 0)==len(active) and int(payload.get("failed") or 0)==0,
          "F3.12 batch suspend 逐条成功",f"body={b}")
    n=int(scalar(f"SELECT COUNT(*) FROM tunnel WHERE id IN ({','.join(map(str,active))}) AND apply_status='suspended';") or 0)
    check(n==len(active),"F3.13 batch suspend 持久状态一致",f"count={n}")
    s,b,_=req("POST","/api/forwards/batch",{"action":"resume","ids":active},cookie,ws,timeout=180)
    payload=unwrap(b) if s==200 else {}
    check(s==200 and isinstance(payload,dict) and int(payload.get("succeeded") or 0)==len(active) and int(payload.get("failed") or 0)==0,
          "F3.14 batch resume 逐条成功",f"body={b}")
    check(wait_active(active),"F3.15 batch resume 后 desired/applied 全收敛")

# Dashboard actionable attention uses lifecycle truth
s,b,_=req("PATCH",f"/api/admin/node/{ing}/lifecycle",{"lifecycle":"maintenance","note":"F3 attention gate"},cookie=cookie)
check(s==200,"F3.16 临时 maintenance 生成真实待办",f"status={s} body={b}")
s,b,_=req("GET","/api/dashboard/attention",cookie=cookie,workspace=ws)
att=unwrap(b) if s==200 else {}; items=att.get("items",[]) if isinstance(att,dict) else []
hit=next((x for x in items if x.get("kind")=="node" and int(x.get("id") or 0)==ing),None)
check(s==200 and hit is not None and hit.get("reason_code")=="node_in_maintenance",
      "F3.17 Dashboard attention 与 Lifecycle 真相一致",f"attention={att}")
s,b,_=req("PATCH",f"/api/admin/node/{ing}/lifecycle",{"lifecycle":"active","note":None},cookie=cookie)
check(s==200,"F3.18 maintenance 恢复 active",f"status={s} body={b}")

# Product summary agrees with persistent truth
s,b,_=req("GET","/api/forwards/summary",cookie=cookie,workspace=ws)
summary=unwrap(b) if s==200 else {}
db_total=int(scalar(f"SELECT COUNT(*) FROM tunnel WHERE workspace_id={ws} AND category='port_forward';") or 0)
check(s==200 and int(summary.get("total") or -1)==db_total,"F3.19 Forward summary 与 DB 总数一致",f"summary={summary} db={db_total}")

if auto_id:
    s,b,_=req("DELETE",f"/api/forwards/{auto_id}",cookie=cookie,workspace=ws)
    check(s==200,"F3.20 临时 auto-port Forward 清理",f"status={s} body={b}")

RESULT.write_text("# V4-F3 product closure\n"+f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"+"\n".join(RESULTS)+f"\nTOTAL PASS={PASS} FAIL={FAIL}\n")
print(f"V4-F3 TOTAL: PASS={PASS} FAIL={FAIL} evidence={RESULT}")
raise SystemExit(1 if FAIL else 0)
