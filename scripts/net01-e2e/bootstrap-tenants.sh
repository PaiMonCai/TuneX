#!/usr/bin/env bash
# NET-01 双租户 E2E —— 租户 scaffolding（幂等、可重复）
#
# 通过真实 HTTP API 建两个租户（不直接写库，保证与控制面一致）：
#   租户 A: workspace A（team）+ 入口组 NET01-IN-A（20000-20099）+ 隧道 A-tunnel -> 127.0.0.1:39001
#   租户 B: workspace B（team）+ 入口组 NET01-IN-B（21000-21099）+ 隧道 B-tunnel -> 127.0.0.1:39002
#
# 幂等设计：用户/工作空间/节点组/隧道均「先查后建」；
# 口令与 token 落在 scripts/net01-e2e/state.json（权限 600，不入 git），
# 重复执行不会重置已建对象（节点组 token 只在创建响应里返回一次，
# 已存在的组从 net01-mysql 直读）。
#
# 输出：scripts/net01-e2e/state.json（verify.sh 与 agent 启动脚本都从这里读）
set -euo pipefail

REPO=${REPO:-/opt/TuneX-email-auth}
HERE="$REPO/scripts/net01-e2e"
API=${API:-http://127.0.0.1:8787}
ENVF="$HERE/.env.net01"
STATE="$HERE/state.json"

# ---- 口令（幂等复用） -------------------------------------------------------
if [[ -f "$HERE/.passwords.env" ]]; then
  . "$HERE/.passwords.env"          # EMAIL_A/PW_A/EMAIL_B/PW_B
else
  umask 077
  EMAIL_A="net01-a@tunex.local"; PW_A="$(openssl rand -hex 12)"
  EMAIL_B="net01-b@tunex.local"; PW_B="$(openssl rand -hex 12)"
  {
    echo "EMAIL_A=$EMAIL_A"; echo "PW_A=$PW_A"
    echo "EMAIL_B=$EMAIL_B"; echo "PW_B=$PW_B"
  } > "$HERE/.passwords.env"
  chmod 600 "$HERE/.passwords.env"
fi

# ---- python 驱动（内联生成，便于整体审阅） --------------------------------
cat > "$HERE/_bootstrap.py" <<'PY'
import json, os, subprocess, urllib.request, urllib.error

API = os.environ["API"]
ERR = "[bootstrap] "

def req(method, path, body=None, cookie=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json"}
    if cookie: h["cookie"] = cookie
    if headers: h.update(headers)
    r = urllib.request.Request(API + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw.strip() else {}), resp.headers.get("set-cookie")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try: body = json.loads(raw)
        except Exception: body = {"raw": raw}
        return e.code, body, e.headers.get("set-cookie")

def unwrap(d):
    return d.get("data", d) if isinstance(d, dict) else d

def as_list(d):
    x = unwrap(d)
    if isinstance(x, dict) and "data" in x: return x["data"]
    return x if isinstance(x, list) else []

def login(email, pw):
    st, body, sc = req("POST", "/api/auth/login", {"email": email, "password": pw})
    assert st == 200, f"{ERR}login {email} -> {st} {body}"
    return sc.split(";")[0]

def session(email, pw):
    """注册（已存在 → 409）后登录，返回 cookie。"""
    st, _, _ = req("POST", "/api/auth/register", {"email": email, "password": pw})
    assert st in (200, 201, 409), f"{ERR}register {email} -> {st}"
    return login(email, pw)

def ensure_workspace(cookie, name):
    st, body, _ = req("GET", "/api/workspaces", None, cookie)
    assert st == 200, f"{ERR}workspaces -> {st} {body}"
    for w in as_list(body):
        if w.get("name") == name: return w
    st, body, _ = req("POST", "/api/workspaces", {"name": name}, cookie)
    assert st in (200, 201), f"{ERR}create workspace -> {st} {body}"
    return unwrap(body)

def list_groups(cookie, ws_id):
    st, body, _ = req("GET", "/api/node-groups?page=1&page_size=200", None, cookie,
                      {"x-workspace-id": str(ws_id)})
    assert st == 200, f"{ERR}node-groups -> {st} {body}"
    return as_list(body)

def db_read_token(ws_id, grp_name):
    """节点组 token 只在创建响应返回一次；已存在的组直读 net01-mysql。"""
    out = subprocess.run(
        ["docker", "exec", "net01-mysql", "mysql", "-uroot", "-p" + os.environ["MYSQL_ROOT_PASSWORD"],
         os.environ["MYSQL_DATABASE"], "-N", "-e",
         f"SELECT token FROM node_group WHERE workspace_id={ws_id} AND name='{grp_name}';"],
        capture_output=True, text=True)
    if out.returncode != 0:
        raise AssertionError(f"{ERR}read token: {out.stderr.strip()}")
    lines = [l.strip() for l in out.stdout.strip().splitlines() if l.strip()]
    assert lines and lines[-1], f"{ERR}empty token for {grp_name}"
    return lines[-1]

def ensure_group(cookie, ws_id, name, node_type, port_range):
    for g in list_groups(cookie, ws_id):
        if g["name"] == name and g["node_type"] == node_type:
            return g, db_read_token(ws_id, name)
    st, body, _ = req("POST", "/api/node-groups",
                      {"name": name, "node_type": node_type, "port_range": port_range},
                      cookie, {"x-workspace-id": str(ws_id)})
    assert st in (200, 201), f"{ERR}create group -> {st} {body}"
    g = unwrap(body)
    return g, g["token"]

def ensure_tunnel(cookie, ws_id, name, group_id, port, forward):
    st, body, _ = req("GET", "/api/tunnels?page=1&page_size=200", None, cookie,
                      {"x-workspace-id": str(ws_id)})
    assert st == 200, f"{ERR}tunnels -> {st} {body}"
    for t in as_list(body):
        if t["name"] == name: return t
    st, body, _ = req("POST", "/api/tunnels", {
        "name": name, "in_node_group_id": group_id, "tunnel_type": "tcp",
        "listen_port": port, "forward_addresses": [forward],
    }, cookie, {"x-workspace-id": str(ws_id)})
    assert st in (200, 201), f"{ERR}create tunnel -> {st} {body}"
    return unwrap(body)

def tenant(prefix, email, pw, ws_name, grp_name, port_range, tcp_port, fwd):
    cookie = session(email, pw)
    ws = ensure_workspace(cookie, ws_name)
    ws_id = ws["id"]
    grp, token = ensure_group(cookie, ws_id, grp_name, "in", port_range)
    tun = ensure_tunnel(cookie, ws_id, f"{prefix}-tunnel", grp["id"], tcp_port, fwd)
    return {"email": email, "workspaceId": ws_id, "workspace": ws_name,
            "groupId": grp["id"], "groupName": grp_name, "token": token,
            "tunnelId": tun["id"], "listenPort": tcp_port, "forward": fwd}

A = tenant("A", os.environ["EMAIL_A"], os.environ["PW_A"],
           "NET01 Tenant A", "NET01-IN-A", "20000-20099", 20001, "127.0.0.1:39001")
B = tenant("B", os.environ["EMAIL_B"], os.environ["PW_B"],
           "NET01 Tenant B", "NET01-IN-B", "21000-21099", 21001, "127.0.0.1:39002")

# 隔离断言：任何一项不满足都不写 state.json
assert A["workspaceId"] != B["workspaceId"], "workspace 未隔离"
assert A["groupId"] != B["groupId"], "node_group 未隔离"
assert A["token"] != B["token"], "token 未隔离"
assert A["tunnelId"] != B["tunnelId"], "tunnel 未隔离"
assert A["listenPort"] != B["listenPort"], "listen_port 未隔离"

json.dump({"tenantA": A, "tenantB": B}, open(os.environ["STATE"], "w"), indent=2)
print(f"{ERR}A ws={A['workspaceId']} grp={A['groupId']} tun={A['tunnelId']} port={A['listenPort']}")
print(f"{ERR}B ws={B['workspaceId']} grp={B['groupId']} tun={B['tunnelId']} port={B['listenPort']}")
print(f"{ERR}A.token={A['token']}")
print(f"{ERR}B.token={B['token']}")
print(f"{ERR}wrote {os.environ['STATE']}")
PY

export API STATE EMAIL_A PW_A EMAIL_B PW_B
set -a; . "$HERE/.passwords.env"; . "$ENVF"; set +a
python3 "$HERE/_bootstrap.py"
printf '== tenants ready: %s\n' "$STATE"
