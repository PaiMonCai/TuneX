#!/usr/bin/env python3
"""WP14 v3 E2E Harness —— fixture bootstrap（由 setup.sh 调用，也可单独跑）。

版权纪律：与 scripts/net01-e2e/bootstrap-tenants.sh 相同——所有对象都经
**真实 HTTP API** 创建（不直接写业务表），保证与控制面语义一致。

创建内容（以 fixtures/*.json 为静态输入）：
  · 测试用户（已存在 → 409 视为成功）
  · primary workspace（DIRECT/RELAY 主租户）
  · isolation workspace（跨租户隔离负面用例）
  · 三个节点组：WP14-IN-A(in) / WP14-OUT-A(out) / WP14-IN-B(in, 另一 workspace)
  · 三条隧道：wp14-direct / wp14-relay / wp14-foreign

产出 state.json（600，不入 git）——verify.sh 与 setup.sh 的 agent 重启步骤都从这里读。

本文件是运行期脚手架：由 setup.sh 在需要时生成，任务结束不随交付物提交
（见 .gitignore 的 scripts/v3-e2e/_bootstrap.py）。此处保留以便审阅与手动执行。
"""
import json
import os
import secrets
import subprocess
import urllib.error
import urllib.request

ERR = "[wp14-bootstrap] "
MYSQL = "wp14-mysql"

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")


def _load(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as fh:
        return json.load(fh)


WORKSPACE_FIX = _load("workspaces.json")
TUNNEL_FIX = _load("tunnels.json")

WORKSPACES = {w["key"]: w for w in WORKSPACE_FIX["workspaces"]}
GROUP_SPECS = {g["key"]: g for g in TUNNEL_FIX["node_groups"]}
TUNNEL_SPECS = {t["key"]: t for t in TUNNEL_FIX["tunnels"]}

USER_EMAIL = os.environ.get("WP14_USER_EMAIL") or "wp14-e2e@tunex.local"
USER_PASSWORD = os.environ.get("WP14_USER_PASSWORD") or secrets.token_hex(16)

# ---------------------------------------------------------------- http helpers


def req(method, path, body=None, cookie=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json"}
    if cookie:
        h["cookie"] = cookie
    if headers:
        h.update(headers)
    r = urllib.request.Request(API + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw.strip() else {}), resp.headers.get("set-cookie")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            body_json = json.loads(raw)
        except Exception:
            body_json = {"raw": raw}
        return e.code, body_json, e.headers.get("set-cookie")


def unwrap(d):
    return d.get("data", d) if isinstance(d, dict) else d


def as_list(d):
    x = unwrap(d)
    if isinstance(x, dict) and "data" in x:
        return x["data"]
    return x if isinstance(x, list) else []


def login(email, password):
    st, body, sc = req("POST", "/api/auth/login", {"email": email, "password": password})
    assert st == 200, f"{ERR}login {email} -> {st} {body}"
    return (sc or "").split(";")[0]


def session(email, password):
    st, _, _ = req("POST", "/api/auth/register", {"email": email, "password": password})
    assert st in (200, 201, 409), f"{ERR}register {email} -> {st}"
    return login(email, password)


def ensure_workspace(cookie, name):
    st, body, _ = req("GET", "/api/workspaces", None, cookie)
    assert st == 200, f"{ERR}workspaces -> {st} {body}"
    for w in as_list(body):
        if w.get("name") == name:
            return w
    st, body, _ = req("POST", "/api/workspaces", {"name": name}, cookie)
    assert st in (200, 201), f"{ERR}create workspace -> {st} {body}"
    return unwrap(body)


def list_groups(cookie, ws_id):
    st, body, _ = req("GET", "/api/node-groups?page=1&page_size=200", None, cookie,
                      {"x-workspace-id": str(ws_id)})
    assert st == 200, f"{ERR}node-groups -> {st} {body}"
    return as_list(body)


def db_read_token(ws_id, grp_name):
    """节点组 token 只在创建响应返回一次；已存在的组直读 wp14-mysql。"""
    pw = os.environ.get("MYSQL_ROOT_PASSWORD", "")
    db = os.environ.get("MYSQL_DATABASE", "tunex")
    out = subprocess.run(
        ["docker", "exec", MYSQL, "mysql", "-uroot", f"-p{pw}", db, "-N", "-e",
         f"SELECT token FROM node_group WHERE workspace_id={ws_id} AND name='{grp_name}';"],
        capture_output=True, text=True)
    if out.returncode != 0:
        raise AssertionError(f"{ERR}read token: {out.stderr.strip()}")
    lines = [line.strip() for line in out.stdout.strip().splitlines() if line.strip()]
    assert lines and lines[-1], f"{ERR}empty token for {grp_name}"
    return lines[-1]


def ensure_group(cookie, ws_id, spec):
    name, node_type, port_range = spec["name"], spec["node_type"], spec["port_range"]
    for g in list_groups(cookie, ws_id):
        if g["name"] == name and g["node_type"] == node_type:
            return g, db_read_token(ws_id, name)
    st, body, _ = req("POST", "/api/node-groups",
                      {"name": name, "node_type": node_type, "port_range": port_range},
                      cookie, {"x-workspace-id": str(ws_id)})
    if st == 403:
        raise AssertionError(
            f"{ERR}创建 {node_type} 节点组被拒（策略未授予 allow_custom_{node_type}_group）：{body}")
    assert st in (200, 201), f"{ERR}create group -> {st} {body}"
    g = unwrap(body)
    return g, g["token"]


def ensure_tunnel(cookie, ws_id, spec, in_group_id, out_group_id):
    name, port, forward = spec["name"], spec["listen_port"], spec["forward_addresses"][0]
    st, body, _ = req("GET", "/api/tunnels?page=1&page_size=200", None, cookie,
                      {"x-workspace-id": str(ws_id)})
    assert st == 200, f"{ERR}tunnels -> {st} {body}"
    for t in as_list(body):
        if t["name"] == name:
            return t
    payload = {
        "name": name,
        "in_node_group_id": in_group_id,
        "tunnel_type": "tcp",
        "listen_port": port,
        "forward_addresses": [forward],
    }
    if out_group_id is not None:
        payload["out_node_group_id"] = out_group_id
    st, body, _ = req("POST", "/api/tunnels", payload, cookie,
                      {"x-workspace-id": str(ws_id)})
    assert st in (200, 201), f"{ERR}create tunnel {name} -> {st} {body}"
    return unwrap(body)


# ---------------------------------------------------------------- main
API = os.environ["API"]
STATE = os.environ["STATE"]

cookie = session(USER_EMAIL, USER_PASSWORD)

ws = {key: ensure_workspace(cookie, spec["name"]) for key, spec in WORKSPACES.items()}

groups, tokens = {}, {}
for key, spec in GROUP_SPECS.items():
    g, token = ensure_group(cookie, ws[spec["workspace"]]["id"], spec)
    groups[key], tokens[key] = g, token

tunnels = {}
for key, spec in TUNNEL_SPECS.items():
    in_group = groups[spec["in_node_group"]]
    out_group = groups[spec["out_node_group"]] if spec.get("out_node_group") else None
    tunnels[key] = ensure_tunnel(
        cookie, ws[GROUP_SPECS[spec["in_node_group"]]["workspace"]]["id"],
        spec, in_group["id"], out_group["id"] if out_group else None)

# ---------------------------------------------------------------- invariants
# 隔离不变量：任何一项不满足都不写 state.json（避免把错误拓扑喂给 verify.sh）。
pri, iso = ws["primary"]["id"], ws["isolation"]["id"]
assert pri != iso, "workspace 未隔离"
assert tokens["ingress"] != tokens["egress"], "ingress/egress token 未隔离"
assert groups["ingress"]["id"] != groups["foreign-ingress"]["id"], "节点组 id 未隔离"
assert tunnels["direct"]["id"] != tunnels["relay"]["id"], "tunnel id 未隔离"

state = {
    "api": API,
    "siteUrl": os.environ.get("SITE_URL", API),
    "user": {"email": USER_EMAIL, "password": USER_PASSWORD},
    "workspaces": {
        "primary": {"id": pri, "name": ws["primary"]["name"]},
        "isolation": {"id": iso, "name": ws["isolation"]["name"]},
    },
    "nodeGroups": {
        key: {
            "id": groups[key]["id"],
            "name": groups[key]["name"],
            "node_type": groups[key]["node_type"],
            "token": tokens[key],
            "workspace": spec["workspace"],
            "port_range": spec["port_range"],
            "node_id": spec["node_id"],
        }
        for key, spec in GROUP_SPECS.items()
    },
    "tunnels": {
        key: {
            "id": tunnels[key]["id"],
            "name": tunnels[key]["name"],
            "workspace": GROUP_SPECS[spec["in_node_group"]]["workspace"],
            "listen_port": spec["listen_port"],
            "expected_marker": spec["expected_marker"],
        }
        for key, spec in TUNNEL_SPECS.items()
    },
    "markers": {"target_a": "WP14-TARGET-A", "target_b": "WP14-TARGET-B"},
    "hostPorts": {
        "direct": int(os.environ.get("WP14_INGRESS_PORT_DIRECT", "18201")),
        "relay": int(os.environ.get("WP14_INGRESS_PORT_RELAY", "18202")),
    },
}

with open(STATE, "w", encoding="utf-8") as fh:
    json.dump(state, fh, indent=2)
os.chmod(STATE, 0o600)

print(f"{ERR}primary ws={pri} iso ws={iso}")
print(f"{ERR}groups in={groups['ingress']['id']} out={groups['egress']['id']} "
      f"foreign={groups['foreign-ingress']['id']}")
print(f"{ERR}tunnels direct={tunnels['direct']['id']} relay={tunnels['relay']['id']} "
      f"foreign={tunnels['foreign']['id']}")
print(f"{ERR}user={USER_EMAIL}")
print(f"{ERR}wrote {STATE}")
