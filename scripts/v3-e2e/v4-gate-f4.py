#!/usr/bin/env python3
"""WP10 real multi-user negative gate on the existing WP14 Compose topology.

Run AFTER F3: python3 scripts/v3-e2e/v4-gate-f4.py
No mocks, signed-token fabrication, alternate server, or new Agent channel.
Users register/login and join by single-use HTTP invites. DB fixtures ONLY install
isolated entitlements/grants and deliberately damaged stored roles. They do not
replace the authentication/authorization under test. Every negative mutation is
checked against persistent desired/revision/lease/rollout facts and, where an
active fixture exists, the existing Agent's real TCP listener.

Evidence never includes passwords, cookies, invitation/enrollment tokens or keys.
A missing topology, failed prerequisite, timeout or cleanup failure is FAIL, not
PASS. Static compilation does not execute this gate or constitute F4 closure.
"""
from __future__ import annotations

import traceback
import json
import os
import secrets
import signal
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
API = os.environ.get("API", "http://127.0.0.1:18180").rstrip("/")
OUT = HERE / "evidence"
RESULT = OUT / "v4-gate-f4-result.txt"
TRACE = OUT / "v4-gate-f4-http.json"
OVERALL_SECONDS = int(os.environ.get("F4_TIMEOUT_SECONDS", "1200"))
CASE_SECONDS = 180
RESULTS: list[str] = []
HTTP: list[dict] = []
PASS = FAIL = 0
START = time.monotonic()
SECRETS: set[str] = set()


class GateTimeout(Exception):
    pass


def alarm(_signum, _frame):
    raise GateTimeout("bounded gate/case deadline exceeded")


def safe(value):
    text = str(value)
    for secret in sorted(SECRETS, key=len, reverse=True):
        if secret:
            text = text.replace(secret, "[REDACTED]")
    return text


def record(passed, message):
    global PASS, FAIL
    if passed:
        PASS += 1
    else:
        FAIL += 1
    line = ("PASS | " if passed else "FAIL | ") + safe(message)
    RESULTS.append(line)
    print(line, flush=True)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def check(condition, message):
    require(condition, message)
    record(True, message)


def case(name, fn, timeout=CASE_SECONDS):
    remaining = OVERALL_SECONDS - (time.monotonic() - START)
    if remaining <= 0:
        record(False, name + ": overall timeout; NOT EXECUTED")
        return
    signal.setitimer(signal.ITIMER_REAL, min(timeout, remaining))
    try:
        fn()
    except Exception as exc:
        # The traceback belongs in the evidence: the bare exception name was not
        # enough to tell a product defect from a defect in this script.
        record(False, f"{name}: {type(exc).__name__}: {exc}\n{traceback.format_exc()}")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


def run(args, timeout=30, allow=False):
    process = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if process.returncode and not allow:
        # Never echo commands (bun eval may contain fixture secrets).
        raise RuntimeError(safe(process.stderr or process.stdout))
    return process.stdout.strip()


def db(expression):
    """Use the backend already built by setup.sh, not host deps or a new service."""
    program = (
        "import {db} from './src/db.ts'; "
        "try { const result = await (async()=>{" + expression + "})(); "
        "console.log('F4JSON:'+JSON.stringify(result,(_,v)=>typeof v==='bigint'?String(v):v)); "
        "} finally {await db.$disconnect();}"
    )
    raw = run(["docker", "exec", "-w", "/app", "wp14-panel", "bun", "--eval", program])
    lines = [line[7:] for line in raw.splitlines() if line.startswith("F4JSON:")]
    require(bool(lines), "backend DB fixture returned no JSON")
    return json.loads(lines[-1])


def q(value):
    return json.dumps(value, ensure_ascii=False)


def unwrap(body):
    return body.get("data", body) if isinstance(body, dict) else body


def rows(body):
    data = unwrap(body)
    return data.get("data", []) if isinstance(data, dict) else data


def layer(body):
    """Error layer of a response body, tolerating array payloads.

    Several endpoints answer `{"data": [ ... ]}` (role list, node-group list).
    Unwrapping `data` blindly made every such response crash the caller while it
    was merely recording a trace entry — which is how a healthy GET /roles looked
    like a broken gate.
    """
    if not isinstance(body, dict):
        return None
    direct = body.get("error_layer")
    if direct:
        return direct
    data = body.get("data")
    return data.get("error_layer") if isinstance(data, dict) else None


def req(method, path, body=None, cookie=None, workspace=None, bearer=None, timeout=75, headers=None):
    request_headers = {"content-type": "application/json", "x-requested-with": "XMLHttpRequest", "origin": API}
    if cookie:
        request_headers["cookie"] = cookie
    if workspace is not None:
        request_headers["x-workspace-id"] = str(workspace)
    if bearer:
        request_headers["authorization"] = "Bearer " + bearer
    # Explicit overrides exist for machine endpoints whose identity is not a
    # session or a user key (e.g. the one-time `Enrollment <token>` header).
    if headers:
        request_headers.update(headers)
    headers = request_headers
    request = urllib.request.Request(API + path, method=method, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status, raw, response_headers = response.status, response.read().decode(), response.headers
    except urllib.error.HTTPError as exc:
        status, raw, response_headers = exc.code, exc.read().decode(), exc.headers
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = {"error": "non-JSON response"}
    # Minimal metadata is intentional: login/invite/install responses contain secrets.
    HTTP.append({"method": method, "path": path, "workspace": workspace,
                 "credential": "bearer" if bearer else "session" if cookie else "none",
                 "status": status, "code": payload.get("code") if isinstance(payload, dict) else None,
                 "error_layer": layer(payload) if isinstance(payload, dict) else None})
    return status, payload, response_headers


def expect(response, status, name, error_layer=None, code=None):
    actual, body, _ = response
    # Some endpoints answer with a JSON array (role list, node-group list). Building
    # the diagnostic must not crash: an AttributeError here used to abort the whole
    # case and hide the real status mismatch behind a script bug.
    detail = body.get("code") if isinstance(body, dict) else type(body).__name__
    require(actual == status, f"{name}: expected HTTP {status}, got {actual}, code={detail}")
    if error_layer:
        require(layer(body) == error_layer, f"{name}: expected layer={error_layer}, got {layer(body)}")
    if code:
        require(body.get("code") == code, f"{name}: expected code={code}, got {body.get('code')}")
    return unwrap(body)


def auth_request(method, path, body):
    """Respect the real auth limiter; do not clear Redis or spoof a client IP."""
    deadline = time.monotonic() + 75
    while True:
        response = req(method, path, body, timeout=15)
        if response[0] != 429:
            return response
        delay = max(1, min(61, int(response[2].get("retry-after", "5"))))
        require(time.monotonic() + delay < deadline, "auth rate-limit retry budget exhausted")
        time.sleep(delay)


def login(email, password):
    response = auth_request("POST", "/api/auth/login", {"email": email, "password": password})
    data = expect(response, 200, "real password login")
    cookie = (response[2].get("set-cookie") or "").split(";", 1)[0]
    require(bool(cookie), "login issued no session cookie")
    SECRETS.add(cookie)
    return {"id": int(data["user"]["id"]), "email": email, "cookie": cookie}


def probe(port):
    return run(["docker", "exec", "wp14-client", "sh", "-c",
                f"nc -w 3 172.31.10.20 {int(port)} </dev/null"], timeout=8, allow=True).strip()


def snapshot(ids):
    """Stable business facts, not traffic counters/heartbeat timestamps."""
    ids = [int(x) for x in ids]
    return db(f"""
      const ids={q(ids)};
      return {{
        tunnels:await db.tunnel.findMany({{where:{{id:{{in:ids}}}},orderBy:{{id:'asc'}},
          select:{{id:true,name:true,user_id:true,workspace_id:true,ingress_node_id:true,egress_node_id:true,
            in_node_group_id:true,out_node_group_id:true,listen_port:true,remote_host:true,remote_port:true,
            desired_status:true,apply_status:true,config_revision:true,applied_revision:true}}}}),
        leases:await db.nodePortLease.findMany({{where:{{tunnel_id:{{in:ids}}}},orderBy:{{id:'asc'}},
          select:{{id:true,node_id:true,tunnel_id:true,port:true,status:true}}}}),
        revisions:await db.forwardRevision.count({{where:{{tunnel_id:{{in:ids}}}}}}),
        rollouts:await db.forwardRollout.count({{where:{{tunnel_id:{{in:ids}}}}}})
      }};
    """)


def active(fid, timeout=60):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        snap = snapshot([fid])
        if snap["tunnels"]:
            row = snap["tunnels"][0]
            if row["apply_status"] == "active" and row["desired_status"] == "active" and row["config_revision"] == row["applied_revision"]:
                return row
        time.sleep(1)
    raise GateTimeout(f"Forward {fid} did not converge desired/applied in {timeout}s")


class Gate:
    def __init__(self):
        self.suffix = secrets.token_hex(5)
        self.prefix = "v4-f4-" + self.suffix
        self.users = {}
        self.roles = []
        self.forwards = []  # (id, actor, workspace)
        self.policies = []
        self.assignments = []
        self.groups = []
        self.nodes = []
        self.historical = None
        self.history_relations = None
        self.owner = None
        self.ws = None
        self.foreign_ws = None
        self.policy = None
        self.base = None
        self.mine = None
        self.shared = None
        self.temp_node = None
        self.temp_group = None

    def setup(self):
        for file in [HERE / "state.json", HERE / ".passwords.env", HERE / ".env.wp14"]:
            require(file.exists(), "missing E2E prerequisite: " + file.name)
        run(["docker", "info", "--format", "{{.ServerVersion}}"], timeout=10)
        state = json.loads((HERE / "state.json").read_text())
        self.ws = int(state["workspaces"]["primary"]["id"])
        # Node lifecycle (maintenance/disabled/retiring) is exposed on the platform
        # admin surface today — V4-WP10 deliberately left the workspace-facing
        # question open — so the E2E user gets the role that route requires (the
        # same fixture F2 uses). Workspace-level assertions are unaffected: they run
        # against ordinary owner/admin/member/viewer/custom memberships.
        db(f"""return await db.user.update({{where:{{email:{json.dumps(state['user']['email'])}}},
          data:{{super_admin:true}}}});""")
        self.foreign_ws = int(state["workspaces"]["isolation"]["id"])
        self.ing = int(state["nodes"]["ingress"]["id"])
        self.group = int(state["nodeGroups"]["ingress"]["id"])
        password = run(["bash", "-c", '. "$1"; printf %s "$WP14_USER_PASSWORD"', "_", str(HERE / ".passwords.env")])
        SECRETS.add(password)
        self.owner = login(state["user"]["email"], password)
        self.users["owner"] = self.owner
        # Save exact old assignment timestamps; never mutate a shared policy template.
        self.assignments = db(f"return await db.workspacePolicyAssignment.findMany({{where:{{workspace_id:{self.ws}}},select:{{id:true,revoked_at:true,updated_at:true}}}});")
        self.history_ids = db("return (await db.tunnel.findMany({select:{id:true}})).map(x=>x.id);")
        self.historical = snapshot(self.history_ids)
        self.history_relations = self.relations()
        self.policy = self.install_policy(self.ws)
        for key, role in [("admin", "admin"), ("member", "member"), ("viewer", "viewer"), ("custom", "admin")]:
            email = f"{self.prefix}-{key}@tunex.local"
            pw = "F4-" + secrets.token_urlsafe(24)
            SECRETS.add(pw)
            expect(auth_request("POST", "/api/auth/register", {"email": email, "password": pw}), 201, "real registration")
            # Track the account before login/invitation can fail.
            uid = db(f"return (await db.user.findUniqueOrThrow({{where:{{email:{q(email)}}},select:{{id:true}}}})).id;")
            user = {"id": uid, "email": email, "cookie": None}
            self.users[key] = user
            user.update(login(email, pw))
            invite = expect(req("POST", f"/api/workspaces/{self.ws}/invites", {"email": email, "role": role}, self.owner["cookie"]), 201, "owner invite")
            token = invite["token"]
            SECRETS.add(token)
            expect(req("POST", "/api/workspaces/invites/accept", {"token": token}, user["cookie"]), 200, "invite acceptance")
            user["personal"] = db(f"return (await db.workspace.findUniqueOrThrow({{where:{{personal_user_id:{uid}}},select:{{id:true}}}})).id;")
        self.base = self.create("owner", "owner")
        self.mine = self.create("member", "member")
        check(probe(self.base["listen_port"]) == "WP14-TARGET-A" and probe(self.mine["listen_port"]) == "WP14-TARGET-A",
              "F4.0 authenticated owner/member creates converge through existing Agent and TCP target")

    def relations(self):
        return db("""return {
          nodes:await db.node.findMany({orderBy:{id:'asc'},select:{id:true,node_group_id:true,agent_id:true,role:true,port_range_min:true,port_range_max:true}}),
          bindings:await db.nodeBinding.findMany({orderBy:{id:'asc'},select:{id:true,ingress_node_id:true,egress_node_id:true}}),
          groups:await db.nodeGroup.findMany({orderBy:{id:'asc'},select:{id:true,workspace_id:true,user_id:true,port_range:true}})
        };""")

    def install_policy(self, ws, shared=False):
        # New template is private to this test workspace. Revocation/restoration is
        # explicit and captured; old Gate templates/resources remain intact.
        result = db(f"""
          return await db.$transaction(async tx=>{{
            const old=await tx.workspacePolicyAssignment.findMany({{where:{{workspace_id:{ws}}},select:{{id:true,revoked_at:true,updated_at:true}}}});
            const p=await tx.capabilityPolicy.create({{data:{{key:{q(self.prefix+'-policy-'+str(ws))},name:{q(self.prefix)},source:'admin_grant',
              tunnel_types:['tcp'],allow_custom_in_group:true,allow_custom_out_group:true,allow_shared_entry:{str(shared).lower()},
              allowed_in_group_ids:{q([self.group] if shared else None)},max_tunnels:100,max_nodes:16,max_members:20}}}});
            await tx.workspacePolicyAssignment.updateMany({{where:{{workspace_id:{ws}}},data:{{revoked_at:new Date()}}}});
            await tx.workspacePolicyAssignment.create({{data:{{workspace_id:{ws},policy_id:p.id,source:'admin_grant'}}}});
            return {{id:p.id,old}};
          }});
        """)
        self.policies.append({"id": result["id"], "ws": ws, "old": result["old"]})
        return result["id"]

    def policy_patch(self, **fields):
        db(f"return await db.capabilityPolicy.update({{where:{{id:{self.policy}}},data:{{...{q(fields)},revision:{{increment:1}}}}}});")

    def cookie(self, who):
        return self.users[who]["cookie"]

    def call(self, who, method, path, body=None, ws=None):
        return req(method, path, body, self.cookie(who), self.ws if ws is None else ws)

    def free_port(self):
        return db(f"""const n=await db.node.findUniqueOrThrow({{where:{{id:{self.ing}}}}});
          const leases=await db.nodePortLease.findMany({{where:{{node_id:n.id}},select:{{port:true}}}});
          const used=new Set(leases.map(x=>x.port));
          for(let p=n.port_range_max;p>=n.port_range_min;p--) if(!used.has(p)) return p;
          throw new Error('no unused fixture port');""")

    def create(self, who, label):
        name = self.prefix + "-" + label
        body = {"name": name, "mode": "direct", "ingress_node_id": self.ing,
                "listen_port": self.free_port(), "target_host": "target-a", "target_port": 3030}
        response = self.call(who, "POST", "/api/forwards", body)
        # Even a failed apply may have persisted a row: track by unique test name.
        created = db(f"return (await db.tunnel.findMany({{where:{{name:{q(name)},workspace_id:{self.ws}}},select:{{id:true}}}})).map(x=>x.id);")
        self.forwards.extend((fid, "owner", self.ws) for fid in created)
        value = expect(response, 201, "create test Forward")
        require(int(value["id"]) in created, "HTTP create and DB fixture identity disagree")
        return active(int(value["id"]))

    def deny(self, who, method, path, body=None, status=403, error_layer="rbac", ws=None, ids=None, marker=True):
        watched = ids if ids is not None else [self.base["id"], self.mine["id"]]
        before = snapshot(watched)
        response = self.call(who, method, path, body, ws)
        expect(response, status, path, error_layer)
        require(snapshot(watched) == before, path + ": denial changed desired/revision/leases/rollout history")
        if marker:
            require(probe(self.base["listen_port"]) == "WP14-TARGET-A", path + ": rejected operation changed real listener")
        return response

    def assign(self, who, role_id=None, base_role=None):
        body = {"role": base_role} if base_role else {"role_id": role_id}
        return expect(self.call("owner", "PATCH", f"/api/workspaces/{self.ws}/members/{self.users[who]['id']}/role", body), 200, "owner assign role")

    def role(self, label, permissions, ws=None):
        ws = self.ws if ws is None else ws
        value = expect(self.call("owner", "POST", f"/api/workspaces/{ws}/roles", {"name": self.prefix + "-" + label, "permissions": permissions}, ws), 201, "create scoped custom role")
        self.roles.append((int(value["id"]), ws))
        return value

    def fixed_roles(self):
        for who in ["owner", "admin", "member", "viewer"]:
            value = expect(self.call(who, "GET", f"/api/forwards/{self.base['id']}"), 200, who + " read")
            check(value["id"] == self.base["id"], "F4.1 fixed " + who + " can read exact workspace Forward")
        self.deny("viewer", "POST", "/api/forwards", {"name": self.prefix + "-viewer-denied", "mode": "direct", "ingress_node_id": self.ing, "target_host": "target-b", "target_port": 3030})
        check(db(f"return await db.tunnel.count({{where:{{name:{q(self.prefix+'-viewer-denied')}}}}});") == 0,
              "F4.2 viewer create denied before persistence/runtime")
        for who in ["viewer", "member"]:
            self.deny(who, "PATCH", f"/api/forwards/{self.base['id']}", {"target_host": "target-b"})
            check(True, "F4.3 " + who + " cannot edit another creator; revision/lease/runtime unchanged")
        for who, fid in [("member", self.mine["id"]), ("admin", self.base["id"]), ("owner", self.mine["id"])]:
            expect(self.call(who, "PATCH", f"/api/forwards/{fid}", {"name": self.prefix + "-edited-" + who}), 200, who + " metadata update")
            row = active(fid)
            check(row["name"] == self.prefix + "-edited-" + who and probe(row["listen_port"]) == "WP14-TARGET-A",
                  "F4.4 " + who + " allowed creator/workspace update is persisted with live runtime")
        self.deny("member", "DELETE", f"/api/forwards/{self.base['id']}")
        self.deny("viewer", "POST", f"/api/forwards/{self.base['id']}/suspend")
        check(True, "F4.5 member other-delete and viewer action are side-effect-free")
        for who in ["member", "viewer"]:
            before = db("return {nodes:await db.node.count(),enrollments:await db.nodeEnrollment.count()};")
            expect(self.call(who, "POST", f"/api/nodes/{self.ing}/enrollment"), 403, who + " enrollment", "rbac")
            check(db("return {nodes:await db.node.count(),enrollments:await db.nodeEnrollment.count()};") == before,
                  "F4.6 " + who + " Forward rights do not grant enrollment")

    def legacy_and_batch(self):
        for method, ending, body in [("PATCH", "", {"forward_addresses": ["target-b:3030"]}), ("DELETE", "", None), ("POST", "/toggle", None)]:
            self.deny("member", method, f"/api/tunnels/{self.base['id']}" + ending, body)
        check(True, "F4.7 compatibility PATCH/DELETE/toggle use creator RBAC and leave DB/runtime untouched")
        expect(self.call("member", "PATCH", f"/api/tunnels/{self.mine['id']}", {"name": self.prefix + "-legacy-own"}), 200, "legacy creator update")
        check(active(self.mine["id"])["name"] == self.prefix + "-legacy-own", "F4.8 legacy own update really persists and ACKs")
        before = snapshot([self.base["id"]])
        result = expect(self.call("member", "POST", "/api/forwards/batch", {"action": "suspend", "ids": [self.mine["id"], self.base["id"]]}), 200, "partial batch")
        items = {item["id"]: item for item in result.get("results", [])}
        check(result.get("succeeded") == 1 and result.get("failed") == 1 and items.get(self.mine["id"], {}).get("ok") is True
              and items.get(self.base["id"], {}).get("code") == "forbidden", "F4.9 batch returns real per-item success/denial")
        mine = snapshot([self.mine["id"]])["tunnels"][0]
        check(mine["desired_status"] == "inactive" and mine["apply_status"] == "suspended" and probe(mine["listen_port"]) == "",
              "F4.10 allowed batch item stopped actual Agent listener")
        check(snapshot([self.base["id"]]) == before and probe(self.base["listen_port"]) == "WP14-TARGET-A",
              "F4.11 refused batch item emitted no revision/rollout/lease effect and stays reachable")
        expect(self.call("member", "POST", f"/api/forwards/{self.mine['id']}/resume"), 200, "resume own batch item")
        active(self.mine["id"])

    def scope(self):
        for method, ending, body in [("GET", "", None), ("PATCH", "", {"target_host": "target-b"}), ("DELETE", "", None), ("POST", "/suspend", None)]:
            self.deny("owner", method, f"/api/forwards/{self.base['id']}" + ending, body, status=404,
                      error_layer=None, ws=self.foreign_ws)
        self.deny("owner", "PATCH", f"/api/tunnels/{self.base['id']}", {"forward_addresses": ["target-b:3030"]}, status=404, error_layer=None, ws=self.foreign_ws)
        check(True, "F4.12 foreign-workspace IDs are 404 across product/compatibility APIs and cannot mutate runtime")
        response = self.call("owner", "POST", "/api/forwards/batch", {"action": "suspend", "ids": [self.base["id"]]}, self.foreign_ws)
        value = expect(response, 200, "foreign batch")
        check(value.get("failed") == 1 and value.get("results", [{}])[0].get("code") == "not_found",
              "F4.13 foreign batch returns scoped not_found, not a successful action")
        expect(self.call("member", "GET", "/api/forwards", ws=self.foreign_ws), 404, "nonmember workspace")
        check(True, "F4.14 nonmember workspace never falls back to personal/selected workspace")

    def custom_roles(self):
        self.read_role = self.role("read-replacement", {"forward:read": True, "node:read": True})
        self.assign("custom", self.read_role["id"])
        self.deny("custom", "PATCH", f"/api/forwards/{self.base['id']}", {"target_host": "target-b"})
        check(True, "F4.15 bound read-only custom role REPLACES admin base privileges")
        write_role = self.role("write", {"forward:read": True, "forward:update": True})
        self.assign("custom", write_role["id"])
        expect(self.call("custom", "PATCH", f"/api/forwards/{self.base['id']}", {"name": self.prefix + "-custom-other"}), 200, "custom explicit update")
        check(active(self.base["id"])["name"] == self.prefix + "-custom-other", "F4.16 explicit custom update applies to another creator in same workspace")
        conflict = self.role("canonical-false", {"forward:read": True, "forward:update": False, "tunnel:update": True})
        stored = db(f"return (await db.workspaceCustomRole.findUniqueOrThrow({{where:{{id:{conflict['id']}}}}})).permissions;")
        check(stored.get("forward:update") is False and "tunnel:update" not in stored,
              "F4.17 role HTTP writes canonicalize boolean map; false overrides legacy true")
        self.assign("custom", conflict["id"])
        self.deny("custom", "PATCH", f"/api/forwards/{self.base['id']}", {"target_host": "target-b"})
        self.deny("custom", "PATCH", f"/api/tunnels/{self.base['id']}", {"forward_addresses": ["target-b:3030"]})
        check(True, "F4.18 canonical false rejects both Forward and legacy Tunnel writes without effects")
        # Deliberate stored legacy map validates READ compatibility as well as API normalization.
        db(f"return await db.workspaceCustomRole.update({{where:{{id:{conflict['id']}}},data:{{permissions:{{'forward:read':true,'tunnel:update':true}}}}}});")
        expect(self.call("custom", "PATCH", f"/api/forwards/{self.base['id']}", {"name": self.prefix + "-legacy-map"}), 200, "stored legacy permission")
        check(active(self.base["id"])["name"] == self.prefix + "-legacy-map", "F4.19 stored tunnel:update legacy-only permission remains read-compatible")
        db(f"return await db.workspaceCustomRole.update({{where:{{id:{conflict['id']}}},data:{{permissions:{{'forward:read':true,'forward:update':false,'tunnel:update':true}}}}}});")
        self.deny("custom", "PATCH", f"/api/tunnels/{self.base['id']}", {"forward_addresses": ["target-b:3030"]})
        check(True, "F4.20 persisted canonical false also wins over unnormalized legacy true")
        expect(self.call("owner", "DELETE", f"/api/workspaces/{self.ws}/roles/{conflict['id']}"), 409, "bound role deletion")
        check(db(f"return (await db.workspaceMember.findUniqueOrThrow({{where:{{workspace_id_user_id:{{workspace_id:{self.ws},user_id:{self.users['custom']['id']}}}}}}})).role_id;") == conflict["id"],
              "F4.21 bound-role DELETE 409 preserves binding, does not restore base admin")
        db(f"return await db.workspaceCustomRole.update({{where:{{id:{conflict['id']}}},data:{{permissions:{{'forward:read':'true'}}}}}});")
        self.deny("custom", "GET", f"/api/forwards/{self.base['id']}")
        check(True, "F4.22 malformed stored permission map fails closed without admin fallback")
        foreign = self.role("foreign-role", {"forward:read": True, "forward:update": True}, self.foreign_ws)
        before = db(f"return (await db.workspaceMember.findUniqueOrThrow({{where:{{workspace_id_user_id:{{workspace_id:{self.ws},user_id:{self.users['custom']['id']}}}}}}})).role_id;")
        expect(self.call("owner", "PATCH", f"/api/workspaces/{self.ws}/members/{self.users['custom']['id']}/role", {"role_id": foreign["id"]}), 404, "foreign role assignment", "resource_scope")
        check(db(f"return (await db.workspaceMember.findUniqueOrThrow({{where:{{workspace_id_user_id:{{workspace_id:{self.ws},user_id:{self.users['custom']['id']}}}}}}})).role_id;") == before,
              "F4.23 HTTP cannot bind foreign role and leaves membership unchanged")
        db(f"return await db.workspaceMember.update({{where:{{workspace_id_user_id:{{workspace_id:{self.ws},user_id:{self.users['custom']['id']}}}}},data:{{role_id:{foreign['id']}}}}});")
        self.deny("custom", "GET", f"/api/forwards/{self.base['id']}")
        check(True, "F4.24 deliberately corrupt foreign role binding cannot restore base admin")
        self.assign("custom", self.read_role["id"])

    def role_management(self):
        manager = self.role("limited-manager", {"member:read": True, "member:manage": True})
        self.assign("custom", manager["id"])
        before = db(f"return await db.workspaceCustomRole.count({{where:{{workspace_id:{self.ws}}}}});")
        expect(self.call("custom", "POST", f"/api/workspaces/{self.ws}/roles", {"name": self.prefix + "-elevate", "permissions": {"node:manage": True}}), 403, "role privilege elevation", "rbac")
        check(db(f"return await db.workspaceCustomRole.count({{where:{{workspace_id:{self.ws}}}}});") == before,
              "F4.25 member:manage cannot manufacture node:manage role beyond actor rights")
        before_member = db(f"return await db.workspaceMember.findUniqueOrThrow({{where:{{workspace_id_user_id:{{workspace_id:{self.ws},user_id:{self.users['viewer']['id']}}}}},select:{{role:true,role_id:true}}}});")
        expect(self.call("custom", "PATCH", f"/api/workspaces/{self.ws}/members/{self.users['viewer']['id']}/role", {"role": "admin"}), 403, "base-role elevation", "rbac")
        check(db(f"return await db.workspaceMember.findUniqueOrThrow({{where:{{workspace_id_user_id:{{workspace_id:{self.ws},user_id:{self.users['viewer']['id']}}}}},select:{{role:true,role_id:true}}}});") == before_member,
              "F4.26 limited role manager cannot restore or assign broader fixed admin rights")
        expect(self.call("admin", "PATCH", f"/api/workspaces/{self.ws}/members/{self.owner['id']}/role", {"role": "viewer"}), 403, "owner protection", "rbac")
        check(db(f"return (await db.workspaceMember.findUniqueOrThrow({{where:{{workspace_id_user_id:{{workspace_id:{self.ws},user_id:{self.owner['id']}}}}}}})).role;") == "owner",
              "F4.27 fixed admin cannot downgrade owner")
        expect(self.call("owner", "POST", f"/api/workspaces/{self.ws}/roles", {"name": self.prefix + "-array", "permissions": ["forward:read"]}), 400, "array permissions rejected")
        expect(self.call("owner", "PATCH", f"/api/workspaces/{self.ws}/roles/{self.read_role['id']}", {"permissions": {"forward:read": True, "forward:update": False}}), 200, "role PATCH")
        listing = expect(self.call("owner", "GET", f"/api/workspaces/{self.ws}/roles"), 200, "role GET")
        check(any(x["id"] == self.read_role["id"] and x["permissions"].get("forward:update") is False for x in listing),
              "F4.28 real role GET/PATCH roundtrip returns boolean permissions, rejects array input")
        # Explicitly unbind before deletion; this is the only permitted base-right reset.
        self.assign("custom", base_role="viewer")
        unused = self.role("delete-unbound", {"forward:read": True})
        expect(self.call("owner", "DELETE", f"/api/workspaces/{self.ws}/roles/{unused['id']}"), 200, "unbound role delete")
        check(db(f"return await db.workspaceCustomRole.count({{where:{{id:{unused['id']}}}}});") == 0,
              "F4.29 unbound role DELETE really removes exact row")

    def grant_and_bearer(self):
        user = self.users["custom"]
        personal = user["personal"]
        self.install_policy(personal, shared=True)
        db(f"return await db.nodeGroupGrant.create({{data:{{user_id:{user['id']},node_group_id:{self.group},direction:'in'}}}});")
        value = expect(self.call("custom", "GET", "/api/node-groups", ws=personal), 200, "personal shared group list")
        shared_group = next((x for x in rows({"data": value}) if x["id"] == self.group), None)
        check(shared_group is not None and "token" not in shared_group, "F4.30 personal direction grant exposes group use without enrollment token")
        before = db("return {nodes:await db.node.count(),enrollments:await db.nodeEnrollment.count()};")
        expect(self.call("custom", "POST", f"/api/node-groups/{self.group}/nodes", {"node_id": self.prefix + "-grant-enroll", "role": "ingress"}, personal), 404, "grant not ownership")
        expect(self.call("custom", "POST", f"/api/nodes/{self.ing}/enrollment", ws=personal), 404, "grant not enrollment")
        check(db("return {nodes:await db.node.count(),enrollments:await db.nodeEnrollment.count()};") == before,
              "F4.31 use grant cannot provision/enroll existing Agent or mint enrollment")
        team_groups = rows(self.call("viewer", "GET", "/api/node-groups")[1])
        # The foreign owner is not a member of primary; grant must not make it one.
        expect(self.call("custom", "GET", "/api/node-groups", ws=self.foreign_ws), 404, "grant cannot cross team membership")
        check(isinstance(team_groups, list), "F4.32 personal grant does not authorize foreign team workspace")
        name = self.prefix + "-shared-legacy"
        response = self.call("custom", "POST", "/api/tunnels", {"name": name, "tunnel_type": "tcp", "in_node_group_id": self.group,
                             "listen_port": self.free_port(), "forward_addresses": ["target-a:3030"]}, personal)
        created = db(f"return (await db.tunnel.findMany({{where:{{name:{q(name)},workspace_id:{personal}}},select:{{id:true}}}})).map(x=>x.id);")
        self.forwards.extend((fid, "custom", personal) for fid in created)
        value = expect(response, 200, "granted legacy shared DIRECT")
        self.shared = active(int(value["id"]))
        check(probe(self.shared["listen_port"]) == "WP14-TARGET-A", "F4.33 direction use grant creates a real shared legacy TCP runtime")
        expect(self.call("custom", "POST", f"/api/tunnels/{self.shared['id']}/toggle", ws=personal), 200, "suspend shared runtime")
        before = snapshot([self.shared["id"]])
        db(f"return await db.nodeGroupGrant.updateMany({{where:{{user_id:{user['id']},node_group_id:{self.group}}},data:{{active:false}}}});")
        denied = self.call("custom", "POST", f"/api/tunnels/{self.shared['id']}/toggle", ws=personal)
        expect(denied, 403, "revoked grant resume", "resource_scope")
        check(snapshot([self.shared["id"]]) == before and probe(self.shared["listen_port"]) == "",
              "F4.34 revoked grant cannot resume: desired/revision/lease unchanged and listener stays closed")
        listing = rows(self.call("custom", "GET", "/api/node-groups", ws=personal)[1])
        check(not any(x["id"] == self.group for x in listing), "F4.35 revoked group disappears from personal list")
        expect(self.call("custom", "GET", f"/api/tunnels/{self.shared['id']}", ws=personal), 200, "revocation retains own resource read")
        key = expect(req("POST", "/api/settings/api-key", cookie=user["cookie"]), 200, "real API key rotation")["api_key"]
        SECRETS.add(key)
        value = expect(req("GET", "/api/tunnels", bearer=key), 200, "Bearer personal default")
        check(any(x["id"] == self.shared["id"] for x in rows({"data": value})), "F4.36 real issued Bearer key authenticates personal resource access")
        before = snapshot([self.base["id"], self.shared["id"]])
        expect(req("POST", f"/api/forwards/{self.base['id']}/suspend", workspace=self.ws, bearer=key), 403, "Bearer team mutation")
        expect(req("GET", f"/api/workspaces/{self.ws}/roles", bearer=key), 403, "Bearer roles need session")
        check(snapshot([self.base["id"], self.shared["id"]]) == before and probe(self.base["listen_port"]) == "WP14-TARGET-A",
              "F4.37 personal-only Bearer cannot use team membership or manage roles; no runtime effect")

    def capability_quota(self):
        body = {"name": self.prefix + "-quota-reject", "mode": "direct", "ingress_node_id": self.ing,
                "listen_port": self.free_port(), "target_host": "target-b", "target_port": 3030}
        count = db(f"return await db.tunnel.count({{where:{{workspace_id:{self.ws}}}}});")
        before = snapshot([self.base["id"], self.mine["id"]])
        self.policy_patch(max_tunnels=count)
        expect(self.call("owner", "POST", "/api/forwards", body), 403, "creation quantity exhausted", "quota", "tunnel_limit")
        check(db(f"return await db.tunnel.count({{where:{{workspace_id:{self.ws}}}}});") == count and snapshot([self.base["id"], self.mine["id"]]) == before,
              "F4.38 creation quota rejects before row/lease/revision/runtime side effects")
        expect(self.call("owner", "POST", f"/api/forwards/{self.base['id']}/suspend"), 200, "quota does not block suspend")
        expect(self.call("owner", "POST", f"/api/forwards/{self.base['id']}/resume"), 200, "quantity limit not runtime-use limit")
        check(probe(active(self.base["id"])["listen_port"]) == "WP14-TARGET-A",
              "F4.39 full creation quantity does not reject existing runtime resume")
        self.policy_patch(max_tunnels=100, tunnel_types=[])
        before = snapshot([self.base["id"], self.mine["id"]])
        expect(self.call("owner", "POST", "/api/forwards", {**body, "name": self.prefix + "-capability-reject"}), 403,
               "protocol capability revoked", "capability", "protocol_not_allowed")
        check(snapshot([self.base["id"], self.mine["id"]]) == before and db(f"return await db.tunnel.count({{where:{{name:{q(self.prefix+'-capability-reject')}}}}});") == 0,
              "F4.40 capability denial is distinct from quantity and persists no new resource")
        expect(self.call("owner", "POST", f"/api/forwards/{self.base['id']}/suspend"), 200, "capability still allows safe suspend")
        self.deny("owner", "POST", f"/api/forwards/{self.base['id']}/resume", error_layer="capability", marker=False)
        check(probe(self.base["listen_port"]) == "", "F4.41 revoked capability blocks existing runtime-use and keeps listener closed")
        self.policy_patch(tunnel_types=["tcp"])
        expect(self.call("owner", "POST", f"/api/forwards/{self.base['id']}/resume"), 200, "restore isolated policy")
        active(self.base["id"])

    def install_and_admission(self):
        value = expect(self.call("owner", "POST", "/api/node-groups", {"name": self.prefix + "-install", "node_type": "in", "port_range": "35000-35020"}), 201, "disposable install group")
        self.temp_group = int(value["id"])
        self.groups.append(self.temp_group)
        name = self.prefix + "-waiting"
        response = self.call("owner", "POST", f"/api/node-groups/{self.temp_group}/nodes", {"node_id": name, "role": "ingress", "connect_ip": "172.31.10.99"})
        # Do not include enrollment data in logs or evidence.
        value = expect(response, 201, "disposable provision")
        self.temp_node = int(value["node"]["id"])
        self.nodes.append(self.temp_node)
        def node_facts():
            return db(f"return await db.node.findUniqueOrThrow({{where:{{id:{self.temp_node}}},select:{{id:true,agent_id:true,role:true,connect_ip:true,port_range_min:true,port_range_max:true}}}});")
        before = node_facts()
        db(f"return await db.nodeGroup.update({{where:{{id:{self.temp_group}}},data:{{port_range:'35010-35020'}}}});")
        reinstalled = expect(self.call("owner", "POST", f"/api/node-groups/{self.temp_group}/nodes", {"node_id": name, "role": "ingress", "connect_ip": "172.31.10.98"}), 201, "reinstall existing identity")
        check(node_facts() == before, "F4.42 reinstall does not rewrite existing Node port range/address/role/agent_id from group defaults")
        # Consume the one-time enrollment so this node HAS a credential: an
        # unenrolled node is rejected as `node_waiting_install` before lifecycle
        # is even consulted (services/node-lifecycle.ts: "先安装，再谈管理态").
        # Without this the case would assert the wrong layer entirely.
        # The reinstall above minted a NEW enrollment token and revoked the first
        # one (§1.1.2: a reinstall must explicitly regenerate it), so the token to
        # consume is the one from the *latest* provision response.
        enrollment = reinstalled.get("enrollment") or {}
        require(bool(enrollment.get("token")), "disposable provision returned no enrollment token")
        enrolled = req("POST", "/api/internal/node/enroll", None, None,
                       headers={"authorization": "Enrollment " + enrollment["token"], "accept": "application/json"})
        expect(enrolled, 200, "disposable enrollment")
        expect(req("PATCH", f"/api/admin/node/{self.temp_node}/lifecycle", {"lifecycle": "disabled", "note": "F4 disposable admission"}, self.owner["cookie"]), 200, "disable disposable node")
        body = {"name": self.prefix + "-disabled-reject", "mode": "direct", "ingress_node_id": self.temp_node, "target_host": "target-a", "target_port": 3030}
        before = snapshot([self.base["id"], self.mine["id"]])
        response = self.call("owner", "POST", "/api/forwards", body)
        expect(response, 409, "runtime disabled admission", "runtime_admission")
        check((unwrap(response[1]) or {}).get("condition") == "node_disabled" and snapshot([self.base["id"], self.mine["id"]]) == before
              and db(f"return await db.tunnel.count({{where:{{name:{q(body['name'])}}}}});") == 0,
              "F4.43 runtime lifecycle admission is independent from owner RBAC/capability/quota and has no effect")

    def cleanup(self):
        """Only touch recorded new IDs; never delete a historical Gate relationship."""
        # Restore test capabilities before removing resources (delete should still
        # work after revoke, but cleanup must also work if an earlier assertion failed).
        if self.policy:
            self.policy_patch(max_tunnels=100, tunnel_types=["tcp"])
        for key, user in self.users.items():
            if key != "owner" and self.ws:
                db(f"return await db.workspaceMember.updateMany({{where:{{workspace_id:{self.ws},user_id:{user['id']}}},data:{{role_id:null}}}});")
        # Find rows left by a timed-out HTTP create as well as tracked successes.
        if self.ws:
            discovered = db(f"return await db.tunnel.findMany({{where:{{name:{{startsWith:{q(self.prefix)}}}}},select:{{id:true,workspace_id:true,user_id:true}}}});")
            known = {item[0] for item in self.forwards}
            for row in discovered:
                if row["id"] not in known:
                    actor = next((key for key, user in self.users.items() if user["id"] == row["user_id"]), "owner")
                    self.forwards.append((row["id"], actor, row["workspace_id"]))
        for fid, actor, ws in reversed(self.forwards):
            def remove(fid=fid, actor=actor, ws=ws):
                exists = db(f"return await db.tunnel.count({{where:{{id:{fid}}}}});")
                if exists:
                    expect(self.call(actor, "DELETE", f"/api/forwards/{fid}", ws=ws), 200, "cleanup Forward")
                check(db(f"return {{rows:await db.tunnel.count({{where:{{id:{fid}}}}}),leases:await db.nodePortLease.count({{where:{{tunnel_id:{fid},status:'active'}}}})}};") == {"rows": 0, "leases": 0},
                      f"F4.cleanup removed fixture Forward {fid} through real Agent/lease cleanup")
            case("F4.cleanup Forward", remove, 90)
        for nid in self.nodes:
            def remove_node(nid=nid):
                expect(req("PATCH", f"/api/admin/node/{nid}/lifecycle", {"lifecycle": "retiring", "note": "F4 cleanup"}, self.owner["cookie"]), 200, "cleanup retiring node")
                expect(req("DELETE", f"/api/admin/node/{nid}/lifecycle", cookie=self.owner["cookie"]), 200, "cleanup node delete")
                check(db(f"return await db.node.count({{where:{{id:{nid}}}}});") == 0, "F4.cleanup temporary Node deleted")
            case("F4.cleanup Node", remove_node, 45)
        for rid, ws in reversed(self.roles):
            if db(f"return await db.workspaceCustomRole.count({{where:{{id:{rid}}}}});"):
                expect(self.call("owner", "DELETE", f"/api/workspaces/{ws}/roles/{rid}", ws=ws), 200, "cleanup unbound role")
        for gid in self.groups:
            # Deleting a group that still has nodes is an opaque foreign-key crash;
            # detach leftovers first so the failure would describe the real state.
            if db(f"return await db.node.count({{where:{{node_group_id:{gid}}}}});"):
                db(f"await db.node.deleteMany({{where:{{node_group_id:{gid}}}}});return true;")
            db(f"return await db.nodeGroup.delete({{where:{{id:{gid}}}}});")
        for key, user in self.users.items():
            if key != "owner":
                # Retain audit/account evidence, but revoke all new fixture access.
                # No old account/workspace, key, grant or member row is changed.
                db(f"""await db.nodeGroupGrant.deleteMany({{where:{{user_id:{user['id']}}}}});
                  await db.workspaceMember.updateMany({{where:{{user_id:{user['id']}}},data:{{active:false,role_id:null}}}});
                  await db.user.update({{where:{{id:{user['id']}}},data:{{status:'inactive',api_key:null,api_key_hash:null}}}});
                  return true;""")
        for policy in reversed(self.policies):
            db(f"""await db.$transaction(async tx=>{{
              await tx.workspacePolicyAssignment.deleteMany({{where:{{policy_id:{policy['id']}}}}});
              for(const row of {q(policy['old'])}) await tx.workspacePolicyAssignment.update({{where:{{id:row.id}},data:{{revoked_at:row.revoked_at?new Date(row.revoked_at):null,updated_at:new Date(row.updated_at)}}}});
              await tx.capabilityPolicy.delete({{where:{{id:{policy['id']}}}}});
            }}); return true;""")
        if self.historical is not None:
            check(snapshot(self.history_ids) == self.historical, "F4.cleanup preserves every historical Gate Forward desired/revision/lease/rollout fact")
            check(self.relations() == self.history_relations, "F4.cleanup preserves historical Nodes, agent_id, ranges, groups and Bindings")
            restored = db(f"return await db.workspacePolicyAssignment.findMany({{where:{{workspace_id:{self.ws}}},select:{{id:true,revoked_at:true,updated_at:true}}}});")
            check(restored == self.assignments, "F4.cleanup restores exact original primary policy assignments")


def main():
    global OVERALL_SECONDS
    OUT.mkdir(exist_ok=True)
    signal.signal(signal.SIGALRM, alarm)
    gate = Gate()
    ready = False
    try:
        signal.setitimer(signal.ITIMER_REAL, min(300, OVERALL_SECONDS))
        gate.setup()
        ready = True
        signal.setitimer(signal.ITIMER_REAL, 0)
        for name, fn in [
            ("F4 fixed roles", gate.fixed_roles),
            ("F4 legacy and partial batch", gate.legacy_and_batch),
            ("F4 foreign resource scope", gate.scope),
            ("F4 custom replacement/canonical/corrupt", gate.custom_roles),
            ("F4 non-elevating role CRUD", gate.role_management),
            ("F4 grant/revoke/Bearer", gate.grant_and_bearer),
            ("F4 capability versus quantity", gate.capability_quota),
            ("F4 reinstall range/runtime admission", gate.install_and_admission),
        ]:
            case(name, fn)
    except Exception as exc:
        record(False, f"F4 prerequisite/setup: {type(exc).__name__}: {exc}; remaining tests NOT EXECUTED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        # Cleanup has its own bounded budget even when the overall test expired.
        OVERALL_SECONDS = max(OVERALL_SECONDS, int(time.monotonic() - START) + 240)
        signal.setitimer(signal.ITIMER_REAL, 240)
        try:
            gate.cleanup()
        except Exception as exc:
            record(False, f"F4.cleanup: {type(exc).__name__}: {exc}; inspect topology before rerun")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        RESULT.write_text("# V4-F4 real multi-user authorization negative gate\n"
                          + f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
                          + f"topology: scripts/v3-e2e/docker-compose.e2e.yaml (existing Agents)\n"
                          + f"fixture: {gate.prefix}; setup={'executed' if ready else 'incomplete'}\n"
                          + "\n".join(RESULTS) + f"\nTOTAL PASS={PASS} FAIL={FAIL}\n", encoding="utf-8")
        TRACE.write_text(json.dumps(HTTP, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"V4-F4 TOTAL PASS={PASS} FAIL={FAIL} evidence={RESULT}", flush=True)
    return 1 if FAIL or not ready else 0


if __name__ == "__main__":
    raise SystemExit(main())
