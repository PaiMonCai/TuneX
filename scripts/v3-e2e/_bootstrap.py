#!/usr/bin/env python3
"""TuneX v3 real E2E bootstrap.

Two phases are intentional:
  provision: user/workspaces/groups -> concrete Nodes + one-time credentials.
  tunnels:   after Agents are polling -> create DIRECT + RELAY and wait for the
             real HTTP request to return only after Agent ACK.

No business table is written directly.
"""
import json
import os
import urllib.error
import urllib.request

ERR = "[v3-e2e] "
HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
API = os.environ["API"]
STATE = os.environ["STATE"]
PHASE = os.environ.get("WP14_BOOTSTRAP_PHASE", "provision").strip().lower()
USER_EMAIL = os.environ.get("WP14_USER_EMAIL", "wp14-e2e@tunex.local")
USER_PASSWORD = os.environ["WP14_USER_PASSWORD"]


def _load(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as fh:
        return json.load(fh)


WORKSPACE_FIX = _load("workspaces.json")
TUNNEL_FIX = _load("tunnels.json")
WORKSPACES = {w["key"]: w for w in WORKSPACE_FIX["workspaces"]}
GROUP_SPECS = {g["key"]: g for g in TUNNEL_FIX["node_groups"]}
TUNNEL_SPECS = {t["key"]: t for t in TUNNEL_FIX["tunnels"]}


def req(method, path, body=None, cookie=None, headers=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    # Browser-equivalent CSRF headers. The harness uses the public HTTP API,
    # so mutating bootstrap requests must satisfy the same Origin/custom-header
    # checks as the real Web client instead of bypassing CSRF middleware.
    h = {
        "content-type": "application/json",
        "x-requested-with": "XMLHttpRequest",
        "origin": API,
    }
    if cookie:
        h["cookie"] = cookie
    if headers:
        h.update(headers)
    request = urllib.request.Request(API + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw.strip() else {}), resp.headers.get("set-cookie")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            body_json = json.loads(raw)
        except Exception:
            body_json = {"raw": raw}
        return e.code, body_json, e.headers.get("set-cookie")


def unwrap(value):
    return value.get("data", value) if isinstance(value, dict) else value


def as_list(value):
    value = unwrap(value)
    if isinstance(value, dict) and "data" in value:
        return value["data"]
    return value if isinstance(value, list) else []


def login():
    status, body, set_cookie = req("POST", "/api/auth/login", {
        "email": USER_EMAIL,
        "password": USER_PASSWORD,
    })
    assert status == 200, f"{ERR}login -> {status} {body}"
    return (set_cookie or "").split(";")[0]


def session():
    status, body, _ = req("POST", "/api/auth/register", {
        "email": USER_EMAIL,
        "password": USER_PASSWORD,
    })
    assert status in (200, 201, 409), f"{ERR}register -> {status} {body}"
    return login()


def ensure_workspace(cookie, name):
    status, body, _ = req("GET", "/api/workspaces", cookie=cookie)
    assert status == 200, f"{ERR}workspaces -> {status} {body}"
    for item in as_list(body):
        if item.get("name") == name:
            return item
    status, body, _ = req("POST", "/api/workspaces", {"name": name}, cookie)
    assert status in (200, 201), f"{ERR}create workspace -> {status} {body}"
    return unwrap(body)


def list_groups(cookie, workspace_id):
    status, body, _ = req(
        "GET",
        "/api/node-groups?page=1&page_size=200",
        cookie=cookie,
        headers={"x-workspace-id": str(workspace_id)},
    )
    assert status == 200, f"{ERR}node groups -> {status} {body}"
    return as_list(body)


def ensure_group(cookie, workspace_id, spec):
    for group in list_groups(cookie, workspace_id):
        if group.get("name") == spec["name"] and group.get("node_type") == spec["node_type"]:
            return group
    status, body, _ = req(
        "POST",
        "/api/node-groups",
        {
            "name": spec["name"],
            "node_type": spec["node_type"],
            "port_range": spec["port_range"],
        },
        cookie,
        {"x-workspace-id": str(workspace_id)},
    )
    assert status in (200, 201), f"{ERR}create group {spec['name']} -> {status} {body}"
    return unwrap(body)


def enroll_node(enrollment):
    token = enrollment["token"]
    request = urllib.request.Request(
        API + "/api/internal/node/enroll",
        data=b"",
        method="POST",
        headers={
            "authorization": f"Enrollment {token}",
            "accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status = response.status
            raw = response.read().decode()
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw = exc.read().decode()
    body = json.loads(raw) if raw else {}
    assert status == 200, f"{ERR}enroll node -> {status} {body}"
    enrolled = unwrap(body)

    # Enrollment is strictly one-time. A replay must fail closed.
    replay = urllib.request.Request(
        API + "/api/internal/node/enroll",
        data=b"",
        method="POST",
        headers={
            "authorization": f"Enrollment {token}",
            "accept": "application/json",
        },
    )
    try:
        urllib.request.urlopen(replay, timeout=30)
        raise AssertionError(f"{ERR}enrollment replay unexpectedly succeeded")
    except urllib.error.HTTPError as exc:
        assert exc.code == 401, f"{ERR}enrollment replay -> {exc.code}"

    return enrolled


def provision_node(cookie, workspace_id, group, spec):
    if not spec.get("node_id"):
        return None
    is_ingress = spec["node_type"] == "in"
    payload = {
        "node_id": spec["node_id"],
        "connect_ip": "172.31.10.20" if is_ingress else "172.31.20.20",
        "role": "ingress" if is_ingress else "egress",
    }
    if not is_ingress:
        payload["targets"] = [{"host": "target-b", "port": 3030, "weight": 1}]
    status, body, _ = req(
        "POST",
        f"/api/node-groups/{group['id']}/nodes",
        payload,
        cookie,
        {"x-workspace-id": str(workspace_id)},
    )
    assert status in (200, 201), f"{ERR}provision {spec['node_id']} -> {status} {body}"
    provisioned = unwrap(body)
    enrolled = enroll_node(provisioned["enrollment"])
    provisioned["credential"] = enrolled["credential"]
    return provisioned


def list_tunnels(cookie, workspace_id):
    status, body, _ = req(
        "GET",
        "/api/tunnels?page=1&page_size=200",
        cookie=cookie,
        headers={"x-workspace-id": str(workspace_id)},
    )
    assert status == 200, f"{ERR}list tunnels -> {status} {body}"
    return as_list(body)


def delete_named(cookie, workspace_id, name):
    for tunnel in list_tunnels(cookie, workspace_id):
        if tunnel.get("name") == name:
            status, body, _ = req(
                "DELETE",
                f"/api/tunnels/{tunnel['id']}",
                cookie=cookie,
                headers={"x-workspace-id": str(workspace_id)},
                timeout=40,
            )
            assert status == 200, f"{ERR}delete {name} -> {status} {body}"


def _target(spec):
    value = spec["forward_addresses"][0]
    host, port = value.rsplit(":", 1)
    return host.strip("[]"), int(port)


def create_direct(cookie, workspace_id, ingress_node, spec):
    delete_named(cookie, workspace_id, spec["name"])
    host, port = _target(spec)
    status, body, _ = req(
        "POST",
        f"/api/nodes/{ingress_node['id']}/forwards",
        {
            "name": spec["name"],
            "listen_port": spec["listen_port"],
            "target_host": host,
            "target_port": port,
        },
        cookie,
        {"x-workspace-id": str(workspace_id)},
        timeout=45,
    )
    assert status in (200, 201), f"{ERR}DIRECT PortForward create -> {status} {body}"
    forward = unwrap(body)
    assert forward.get("mode") == "direct", f"{ERR}DIRECT mode mismatch: {forward}"
    assert forward.get("apply_status") == "active", f"{ERR}DIRECT not active: {forward}"
    assert forward.get("ingress_node_id") == ingress_node["id"], f"{ERR}DIRECT concrete ingress mismatch"
    return forward


def create_relay(cookie, workspace_id, ingress_node, egress_node, spec):
    delete_named(cookie, workspace_id, spec["name"])

    bind_status, bind_body, _ = req(
        "POST",
        f"/api/nodes/{ingress_node['id']}/bindings",
        {"egress_node_id": egress_node["id"]},
        cookie,
        {"x-workspace-id": str(workspace_id)},
    )
    assert bind_status in (200, 201), f"{ERR}bind egress -> {bind_status} {bind_body}"

    host, port = _target(spec)
    status, body, _ = req(
        "POST",
        f"/api/nodes/{ingress_node['id']}/forwards",
        {
            "name": spec["name"],
            "listen_port": spec["listen_port"],
            "target_host": host,
            "target_port": port,
            "egress_node_id": egress_node["id"],
        },
        cookie,
        {"x-workspace-id": str(workspace_id)},
        timeout=60,
    )
    assert status in (200, 201), f"{ERR}RELAY PortForward create -> {status} {body}"
    forward = unwrap(body)
    assert forward.get("mode") == "relay", f"{ERR}RELAY mode mismatch: {forward}"
    assert forward.get("apply_status") == "active", f"{ERR}RELAY not active: {forward}"
    assert forward.get("ingress_node_id") == ingress_node["id"], f"{ERR}RELAY ingress mismatch"
    assert forward.get("egress_node_id") == egress_node["id"], f"{ERR}RELAY egress mismatch"
    return forward

def write_state(state):
    with open(STATE, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
    os.chmod(STATE, 0o600)


if PHASE == "provision":
    cookie = session()
    workspaces = {key: ensure_workspace(cookie, spec["name"]) for key, spec in WORKSPACES.items()}

    groups = {}
    for key, spec in GROUP_SPECS.items():
        groups[key] = ensure_group(cookie, workspaces[spec["workspace"]]["id"], spec)

    ingress = provision_node(cookie, workspaces["primary"]["id"], groups["ingress"], GROUP_SPECS["ingress"])
    egress = provision_node(cookie, workspaces["primary"]["id"], groups["egress"], GROUP_SPECS["egress"])
    assert ingress and egress

    state = {
        "api": API,
        "user": {"email": USER_EMAIL, "password": USER_PASSWORD},
        "workspaces": {
            key: {"id": workspaces[key]["id"], "name": workspaces[key]["name"]}
            for key in workspaces
        },
        "nodeGroups": {
            key: {
                "id": groups[key]["id"],
                "name": groups[key]["name"],
                "node_type": groups[key]["node_type"],
                "workspace": spec["workspace"],
                "port_range": spec["port_range"],
                "node_id": spec.get("node_id"),
            }
            for key, spec in GROUP_SPECS.items()
        },
        "nodes": {
            "ingress": {
                **ingress["node"],
                "credential": ingress["credential"],
            },
            "egress": {
                **egress["node"],
                "credential": egress["credential"],
            },
        },
        "tunnels": {},
        "markers": {"target_a": "WP14-TARGET-A", "target_b": "WP14-TARGET-B"},
    }
    write_state(state)
    print(f"{ERR}provisioned ingress={ingress['node']['id']} egress={egress['node']['id']}")
    print(f"{ERR}wrote {STATE}")

elif PHASE == "tunnels":
    with open(STATE, encoding="utf-8") as fh:
        state = json.load(fh)
    cookie = login()
    primary = state["workspaces"]["primary"]["id"]
    direct = create_direct(
        cookie,
        primary,
        state["nodes"]["ingress"],
        TUNNEL_SPECS["direct"],
    )
    relay = create_relay(
        cookie,
        primary,
        state["nodes"]["ingress"],
        state["nodes"]["egress"],
        TUNNEL_SPECS["relay"],
    )
    state["tunnels"] = {
        "direct": direct,
        "relay": relay,
    }
    write_state(state)
    print(f"{ERR}tunnels direct={direct['id']} relay={relay['id']}")
    print(f"{ERR}wrote {STATE}")
else:
    raise SystemExit(f"{ERR}unknown WP14_BOOTSTRAP_PHASE={PHASE!r}")
