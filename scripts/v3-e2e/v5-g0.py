#!/usr/bin/env python3
"""V5-G0 contract compatibility gate (DEVELOPMENT.md §5.5).

The question this gate answers is narrow and absolute:

    did the V5 contract work (WP0 protocol facts, WP1 capability negotiation,
    WP2 runtime abstraction) break anything V4 already promised?

Note what it is NOT: it does not test new capabilities. At G0 the product still
offers exactly TCP DIRECT/RELAY. Everything here is a regression claim.

The twenty checks of §5.5, in order:

  G0.1  V4 TCP DIRECT does not regress
  G0.2  V4 TCP RELAY does not regress
  G0.3  an old Forward needs no rebuild
  G0.4  old Agent + new Panel: the V4 baseline still works
  G0.5  new Agent executes the V4 baseline and advertises a v2 manifest
  G0.6  an omitted protocol is TCP
  G0.7  an explicit unknown protocol is rejected before dispatch
  G0.8  an explicit unknown transport is rejected
  G0.9  a malformed capability manifest fails closed
  G0.10 protocol/transport mismatch is rejected
  G0.11 revision / ACK semantics are unchanged
  G0.12 a stale revision is still rejected
  G0.13 LKG cache in the OLD schema shape is safe
  G0.14 LKG cache in the NEW schema shape is safe
  G0.15 panel desired overrides LKG after reconnect
  G0.16 diagnostics are still redacted
  G0.17 deprecated /api/tunnels TCP create still canonicalises
  G0.18 the existing DB migration preserved historical protocol facts
  G0.19 a non-TCP historical fact is not accidentally admitted
  G0.20 no second listener / orphan lease after a rejected config

Two rules from §5.5 that this script enforces mechanically:

  · a missing topology, timeout, failed prerequisite or cleanup failure is a
    FAIL — never a skip, never a warning;
  · FAIL > 0 means V5.1 must not start. The exit code is non-zero, and the
    integration workflow runs this gate before anything else in V5.

A static compilation of this file is NOT G0 closure. It has to be run against the
real multi-agent topology.
"""
from __future__ import annotations

import json
import os
import signal
import traceback
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
STATE = HERE / "state.json"
ENVF = HERE / ".env.wp14"
PASSF = HERE / ".passwords.env"
API = os.environ.get("API", "http://127.0.0.1:18180")
COMPOSE = ["docker", "compose", "-f", str(HERE / "docker-compose.e2e.yaml"), "--env-file", str(ENVF)]
OUT = HERE / "evidence"
OUT.mkdir(exist_ok=True)
RESULT = OUT / "v5-g0-result.txt"
TRACE = OUT / "v5-g0-http.json"

PASS = 0
FAIL = 0
RESULTS: list[str] = []
HTTP: list[dict] = []
TRACEBACKS: list[dict] = []

# Container names (docker exec/inspect) vs compose SERVICE names (compose
# up/stop/start). Mixing them up silently no-ops a stop/start cycle and leaves a
# case testing nothing — the same trap v4-gate-f5.py documents.
INGRESS_CONTAINER = "wp14-ingress-agent"
EGRESS_CONTAINER = "wp14-egress-agent"
PANEL_CONTAINER = "wp14-panel"
CLIENT_CONTAINER = "wp14-client"
MYSQL_CONTAINER = "wp14-mysql"
INGRESS_SERVICE = "ingress-agent"
EGRESS_SERVICE = "egress-agent"
PANEL_SERVICE = "panel"
WORKER_SERVICE = "worker"
STATE_DIR = "/var/lib/tunex-agent"
LKG_FILE = f"{STATE_DIR}/desired-lkg.json"

START = time.monotonic()
OVERALL_SECONDS = int(os.environ.get("G0_OVERALL_SECONDS", "1500"))

# Fixtures created by this gate. Every check uses its own disposable Forward so no
# historical Gate row is ever touched, and cleanup deletes only these.
FIXTURE_PREFIX = f"V5-G0-{int(time.time())}"
created_ids: list[int] = []
planted_ids: list[int] = []
# Forwards a refusal case created and expects to find UNTOUCHED. Kept separate
# from created_ids because "apply_status == error" is not the same fact: a row
# can be in error for an unrelated reason (a planted legacy row, a case the
# harness broke), and asserting on those turns a harness fault into a claim
# about the product.
refused_ids: list[int] = []
# A planted legacy row that was refused too, but which comes from a Forward that
# really ran first — so it may legitimately still hold a port reservation. Kept
# apart so the fresh-refusal assertions stay exact.
legacy_refused_ids: list[int] = []
panel_stopped = False
recreated_agents: list[str] = []


def alarm(_signum, _frame):
    raise TimeoutError(f"V5-G0 overall time budget exhausted ({OVERALL_SECONDS}s)")


def record(passed: bool, message: str) -> None:
    global PASS, FAIL
    if passed:
        PASS += 1
    else:
        FAIL += 1
    line = ("PASS | " if passed else "FAIL | ") + message
    RESULTS.append(line)
    print(line, flush=True)


def check(condition, message, detail=""):
    record(bool(condition), message if condition or not detail else f"{message} [{detail}]")


def case(name: str, fn, seconds: int):
    """Run one case under its own alarm so one hang cannot eat the whole gate."""
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        fn()
    except Exception as exc:  # noqa: BLE001 - a case failure is a gate failure
        record(False, f"{name}: {type(exc).__name__}: {exc}")
        # The traceback goes to the trace artifact, not the result lines: a bare
        # exception type in the evidence forces a re-run to find out which line
        # broke, and a re-run of a real topology is expensive.
        TRACEBACKS.append({"case": name, "traceback": traceback.format_exc()})
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


# ---------------------------------------------------------------------------
# process / container helpers
# ---------------------------------------------------------------------------

def parse_env(path: Path) -> dict:
    out = {}
    for line in Path(path).read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k] = v
    return out


def password() -> str:
    return subprocess.check_output(
        ["bash", "-c", '. "$1"; printf %s "$WP14_USER_PASSWORD"', "_", str(PASSF)], text=True
    )


def run(args, env=None, allow=False, timeout=600):
    p = subprocess.run(args, text=True, capture_output=True, env=env, timeout=timeout)
    if p.returncode and not allow:
        raise RuntimeError(f"{' '.join(args)} failed: {p.stderr.strip() or p.stdout.strip()}")
    return p.stdout.strip()


def docker(args, allow=False, timeout=600):
    return run(["docker", *args], allow=allow, timeout=timeout)


def run_with_input(args, stdin_text: str, timeout=120):
    proc = subprocess.run(args, input=stdin_text, text=True, capture_output=True, timeout=timeout)
    if proc.returncode:
        raise RuntimeError(f"{' '.join(args)} failed: {proc.stderr.strip() or proc.stdout.strip()}")
    return proc.stdout.strip()


def compose_env() -> dict:
    global _COMPOSE_ENV
    if _COMPOSE_ENV is None:
        env = os.environ.copy()
        env["TUNEX_BACKEND_IMAGE"] = run(["docker", "inspect", "-f", "{{.Config.Image}}", PANEL_CONTAINER])
        env["WP14_AGENT_IMAGE"] = run(["docker", "inspect", "-f", "{{.Config.Image}}", INGRESS_CONTAINER])
        for key, prefix in [("ingress", "WP14_INGRESS"), ("egress", "WP14_EGRESS"),
                            ("ingress_secondary", "WP14_INGRESS_B"), ("egress_secondary", "WP14_EGRESS_B")]:
            env[prefix + "_CREDENTIAL"] = state["nodes"][key]["credential"]
            env[prefix + "_AGENT_ID"] = state["nodes"][key]["agent_id"]
        _COMPOSE_ENV = env
    return _COMPOSE_ENV


_COMPOSE_ENV: dict | None = None


def compose(*args, allow=False, timeout=600):
    return run([*COMPOSE, *args], env=compose_env(), allow=allow, timeout=timeout)


def mysql(sql: str) -> str:
    e = parse_env(ENVF)
    return run(
        ["docker", "exec", MYSQL_CONTAINER, "mysql", "-uroot", f"-p{e['MYSQL_ROOT_PASSWORD']}",
         e.get("MYSQL_DATABASE", "tunex"), "-N", "-e", sql]
    )


def scalar(sql: str) -> str:
    v = mysql(sql).strip()
    return v.splitlines()[-1].strip() if v else ""


def db(js: str) -> object:
    """Run a small Prisma script inside the panel container (the F4/F5 pattern).

    Used where the panel's own HTTP surface deliberately does not expose a field
    (capability_manifest) or where the gate must plant a fact only a migration or
    a corrupt store could produce.
    """
    out = docker(["exec", PANEL_CONTAINER, "bun", "-e", (
        'import { PrismaClient } from "@prisma/client";'
        "const db=new PrismaClient();const f=async()=>{" + js + "};"
        "console.log(JSON.stringify(await f()));await db.$disconnect();"
    )], timeout=120)
    line = out.strip().splitlines()[-1] if out.strip() else "null"
    return json.loads(line)


def container_logs(container: str, since: str = "10m") -> str:
    """Container logs, stdout AND stderr (the agent logs to stderr)."""
    proc = subprocess.run(["docker", "logs", "--since", since, container],
                          text=True, capture_output=True, timeout=120)
    return proc.stdout + proc.stderr


def req(method: str, path: str, body=None, cookie=None, workspace=None, headers=None, timeout=90):
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json", "x-requested-with": "XMLHttpRequest", "origin": API}
    if cookie:
        h["cookie"] = cookie
    if workspace is not None:
        h["x-workspace-id"] = str(workspace)
    if headers:
        h.update(headers)
    q = urllib.request.Request(API + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(q, timeout=timeout) as r:
            raw = r.read().decode()
            parsed = json.loads(raw) if raw.strip() else {}
            HTTP.append({"method": method, "path": path, "status": r.status, "body": parsed})
            return r.status, parsed, r.headers
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            parsed = json.loads(raw) if raw.strip() else {}
        except Exception:  # noqa: BLE001
            parsed = {"raw": raw}
        HTTP.append({"method": method, "path": path, "status": e.code, "body": parsed})
        return e.code, parsed, e.headers
    except (urllib.error.URLError, OSError) as e:
        # A stopped panel (or a container that has not rejoined DNS yet) raises
        # URLError, which is NOT an HTTPError — without this branch the "is the
        # panel down?" probe used by the LKG cases throws instead of answering,
        # and the case fails for a reason that has nothing to do with the contract.
        detail = f"{type(e).__name__}: {e}"
        HTTP.append({"method": method, "path": path, "status": 0, "error": detail})
        return 0, {"error": detail}, {}


def unwrap(b):
    return b.get("data", b) if isinstance(b, dict) else b


def login(email: str, pw: str) -> str:
    s, b, h = req("POST", "/api/auth/login", {"email": email, "password": pw})
    if s != 200:
        raise SystemExit(f"cannot log in the e2e user: status={s} body={b}")
    return (h.get("set-cookie") or "").split(";", 1)[0]


def wait_until(fn, timeout=150, interval=2):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
        except Exception:  # noqa: BLE001 - a transient probe failure is a retry, not a verdict
            last = None
        if last:
            return last
        time.sleep(interval)
    return None


def wait_active(fid: int, timeout: int = 180) -> bool:
    def one():
        row = scalar(
            f"SELECT CONCAT(IFNULL(applied_revision,0),'|',IFNULL(config_revision,0),'|',IFNULL(apply_status,'')) "
            f"FROM tunnel WHERE id={fid};"
        )
        if not row:
            return None
        applied, configured, status = row.split("|")
        return row if applied == configured and status == "active" else None
    return wait_until(one, timeout, 2) is not None


def tcp_probe(port: int, timeout: int = 6, payload: str = "v5-g0") -> bool:
    """Open a real TCP connection to the ingress node's listener and echo a byte.

    Run from the client container so the traffic crosses the topology rather than
    looping back on the runner. `nc` availability is why this uses the client
    image's own shell (setup.sh installs busybox there).
    """
    script = (
        f"printf '{payload}' | nc -w {timeout} 172.31.10.20 {port} >/dev/null 2>&1 && echo OPEN || echo CLOSED"
    )
    out = run(["docker", "exec", CLIENT_CONTAINER, "sh", "-c", script], allow=True, timeout=timeout + 15)
    return "OPEN" in out


def agent_exec(container: str, script: str, allow=False) -> str:
    return docker(["exec", container, "sh", "-c", script], allow=allow)


def agent_state_volume(container: str) -> str:
    volume = docker(["inspect", "-f",
                     '{{range .Mounts}}{{if eq .Destination "/var/lib/tunex-agent"}}{{.Name}}{{end}}{{end}}',
                     container])
    if not volume:
        raise RuntimeError(f"could not resolve the state volume of {container}")
    return volume


def write_agent_cache(container: str, content: str) -> None:
    """Write the agent's cache file while the agent is STOPPED.

    `docker exec` needs a running container, so the file is written by a
    throwaway container mounting the same volume — that is also the only way to
    plant a cache the agent has not already overwritten. The content goes in over
    stdin: interpolating a multi-line JSON blob into a shell command is how a
    quote in the payload silently truncates the file.
    """
    volume = agent_state_volume(container)
    run_with_input(
        ["docker", "run", "--rm", "-i", "-v", f"{volume}:{STATE_DIR}", "busybox:1.36", "sh", "-c",
         f"cat > {LKG_FILE} && chmod 600 {LKG_FILE}"],
        content,
    )


def read_agent_cache(container: str) -> str:
    volume = agent_state_volume(container)
    return run(["docker", "run", "--rm", "-v", f"{volume}:{STATE_DIR}:ro", "busybox:1.36",
                "sh", "-c", f"cat {LKG_FILE} 2>/dev/null || true"], allow=True)


def ensure_panel_up() -> bool:
    global panel_stopped
    if panel_stopped:
        compose("start", PANEL_SERVICE, WORKER_SERVICE, allow=True)
        panel_stopped = False
    end = time.time() + 120
    while time.time() < end:
        s, _, _ = req("GET", "/healthz", timeout=10)
        if s == 200:
            return True
        time.sleep(2)
    return False


def stop_panel() -> bool:
    global panel_stopped
    compose("stop", PANEL_SERVICE, WORKER_SERVICE, allow=True)
    panel_stopped = True
    end = time.time() + 60
    while time.time() < end:
        s, _, _ = req("GET", "/healthz", timeout=5)
        if s != 200:
            return True
        time.sleep(1)
    return False


def recreate_agent(service: str, container: str) -> bool:
    """Recreate one agent WITHOUT touching its compose dependencies.

    `docker compose up <service>` also starts `depends_on` services, which would
    silently restart a panel we deliberately stopped — turning "agent starts
    during a panel outage" into "agent starts with a healthy panel" without
    failing anything. `--no-deps` is what makes the outage real.
    """
    compose("up", "-d", "--force-recreate", "--no-deps", service)
    if container not in recreated_agents:
        recreated_agents.append(container)
    end = time.time() + 120
    while time.time() < end:
        if docker(["inspect", "-f", "{{.State.Status}}", container], allow=True).strip() == "running":
            return True
        time.sleep(2)
    return False


def wait_for_agents(timeout: int = 240) -> bool:
    """All four Agents report with a fresh, credential-authenticated state report."""
    def one():
        row = scalar(
            "SELECT COUNT(*) FROM node_state_report s JOIN node n ON n.id=s.node_id "
            "WHERE n.node_id IN ('WP14-IN-A-NODE','WP14-OUT-A-NODE','WP14-IN-C-NODE','WP14-OUT-B-NODE') "
            "AND s.reported_at > NOW() - INTERVAL 2 MINUTE;"
        )
        return row if row.isdigit() and int(row) >= 4 else None
    return wait_until(one, timeout, 3) is not None


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

def create_forward(name: str, mode: str = "direct", target_port: int = 3030) -> tuple[int, int, int, dict]:
    """Create a disposable Forward through the real API.

    Returns (status, id, listen_port, body). A REFUSED create is a legitimate
    outcome here: the panel refuses before dispatch, and it still persists the
    Forward so the operator can see why (that is §7.11's "keep the business row,
    record the error"). Raising on a 4xx/5xx would make the gate unable to assert
    exactly the behaviour it is testing, so the status is returned instead — but
    a create that produced NO row at all is still a harness error.
    """
    body = {
        "name": f"{FIXTURE_PREFIX}-{name}",
        "mode": mode,
        "ingress_node_id": ing,
        "target_host": "target-a",
        "target_port": target_port,
    }
    if mode == "relay":
        body["egress_node_id"] = egr
    status, resp, _ = req("POST", "/api/forwards", body, cookie, ws)
    data = unwrap(resp)
    fid = data.get("id") if isinstance(data, dict) else None
    if fid is None:
        raise RuntimeError(f"create {name} produced no Forward row: status={status} body={resp}")
    fid = int(fid)
    if fid not in created_ids:
        created_ids.append(fid)
    return status, fid, int(data.get("listen_port") or 0), resp


def new_forward(name: str, mode: str = "direct", target_port: int = 3030) -> tuple[int, int]:
    """Create a Forward that is expected to be ACCEPTED (the happy-path helper)."""
    status, fid, port, body = create_forward(name, mode, target_port)
    if status not in (200, 201):
        raise RuntimeError(f"cannot create {name}: status={status} body={body}")
    return fid, port


def node_facts(node_id: int) -> dict:
    return db(
        "const r = await db.nodeStateReport.findUnique({"
        f"where:{{node_id:{node_id}}},"
        "select:{control_protocol_version:true,capabilities:true,capability_manifest:true,reported_at:true}"
        "});return r ? {version:r.control_protocol_version,capabilities:r.capabilities,"
        "manifest:r.capability_manifest,reported_at:r.reported_at} : null;"
    ) or {}


def set_manifest(node_id: int, manifest: object) -> None:
    """Plant a capability_manifest directly in the store.

    The gate needs shapes the panel's own validator will never accept: a corrupt
    row, or an agent that advertises a transport it does not implement. Going
    through the store is how those states arise in reality too — a bad write, a
    downgraded binary, or a row written by a different version.

    `Prisma.DbNull` (not JSON `null`) is what writes SQL NULL for a JSON column;
    using the JS value null would store the JSON literal and read back as an
    empty-but-present manifest, i.e. a different fact.
    """
    value = "Prisma.DbNull" if manifest is None else f"JSON.parse({json.dumps(json.dumps(manifest))})"
    # %-formatting rather than an f-string: the generated JS is full of braces, and
    # `{{`/`}}` escaping next to an interpolation is exactly where a wrong count
    # silently produces a different statement.
    db(
        "const {Prisma} = await import('@prisma/client');"
        "await db.nodeStateReport.update({where:{node_id:%d},"
        "data:{capability_manifest:%s}});"
        "return true;"
        % (node_id, value)
    )


def restore_node_facts(node_id: int) -> None:
    """Put back whatever the agent last reported (it re-reports within 30s)."""
    wait_until(
        lambda: (node_facts(node_id).get("manifest") is not None) or None,
        timeout=90, interval=3,
    )


def cleanup_fixtures() -> None:
    """Remove every fixture through the real delete path.

    Deleting rows with Prisma alone is not enough: the Agent keeps its listener
    until it is told to remove the tunnel. The orphaned listener then makes the
    node's port guard refuse the NEXT run's fixture with
    "port N is already used by another tunnel" — a gate that fails because of its
    own leftovers, which reads exactly like a product regression. So the API
    delete runs first, and the Prisma sweep afterwards is only a safety net for
    rows the API could not touch.
    """
    for fid in created_ids + planted_ids:
        try:
            req("DELETE", f"/api/forwards/{fid}", None, cookie, ws, timeout=60)
        except Exception:  # noqa: BLE001 - cleanup continues, the sweep below covers it
            pass
    db(f"await db.tunnel.deleteMany({{where:{{name:{{startsWith:'{FIXTURE_PREFIX}'}}}}}});return true;")
    # Give the Agents a moment to stop their listeners before the next run binds.
    time.sleep(3)


def active_leases_for(tunnel_ids: list[int]) -> int:
    if not tunnel_ids:
        return 0
    ids = ",".join(str(i) for i in tunnel_ids)
    row = scalar(f"SELECT COUNT(*) FROM node_port_lease WHERE tunnel_id IN ({ids}) AND status='active';")
    return int(row) if row.isdigit() else -1


def listener_count(container: str, script: str) -> int:
    out = agent_exec(container, script, allow=True).strip()
    return int(out.splitlines()[-1]) if out.strip().splitlines() else -1


# ---------------------------------------------------------------------------
# self-check: this gate refuses to run if its own generated JS is malformed
# ---------------------------------------------------------------------------

def self_check_db_bodies() -> None:
    """Render every `db(...)` argument this file builds and check brace balance.

    The `db()` helper generates a Prisma script by string concatenation, and the
    JS is full of braces. Getting one `{{`/`}}` wrong does not fail loudly: it
    produces a *different* statement (or a syntax error the panel reports as a
    generic 500), and a gate whose planting step silently did not happen is a
    gate that passes for the wrong reason. Running this at import time means a
    malformed body is caught before the topology is touched.

    Written after the author shipped two such bodies in the first draft; the
    lint found both.
    """
    import ast as _ast

    source = Path(__file__).read_text()
    tree = _ast.parse(source)
    dummy = {"node_id": 7, "fid": 42, "egr": 7, "ing": 5, "ws": 9, "in_group": 11,
             "out_group": 22, "FIXTURE_PREFIX": "V5-G0-SELFCHECK", "value": "Prisma.DbNull",
             "tunnel_id": 42}

    def eval_expr(node):
        if isinstance(node, _ast.Name):
            return dummy.get(node.id, 0)
        if isinstance(node, (_ast.Attribute, _ast.Subscript, _ast.Call)):
            return 0
        if isinstance(node, _ast.Constant):
            return node.value
        if isinstance(node, _ast.BinOp):
            return str(eval_expr(node.left)) + str(eval_expr(node.right))
        if isinstance(node, _ast.Tuple):
            return tuple(eval_expr(e) for e in node.elts)
        if isinstance(node, _ast.JoinedStr):
            return render(node)
        raise TypeError(_ast.dump(node)[:80])

    def render(node):
        if isinstance(node, _ast.Constant):
            return str(node.value)
        if isinstance(node, _ast.JoinedStr):
            out = []
            for part in node.values:
                if isinstance(part, _ast.Constant):
                    out.append(str(part.value))
                elif isinstance(part, _ast.FormattedValue):
                    out.append(str(eval_expr(part.value)))
            return "".join(out)
        if isinstance(node, _ast.BinOp):
            left = render(node.left)
            if isinstance(node.op, _ast.Mod):
                right = eval_expr(node.right)
                items = right if isinstance(right, tuple) else (right,)
                for item in items:
                    marker = "%d" if isinstance(item, int) else "%s"
                    left = left.replace(marker, str(item), 1)
                return left
            return left + str(eval_expr(node.right))
        raise TypeError(_ast.dump(node)[:80])

    problems = []
    for call in [n for n in _ast.walk(tree)
                 if isinstance(n, _ast.Call) and isinstance(n.func, _ast.Name) and n.func.id == "db"]:
        js = render(call.args[0])
        depth = 0
        for ch in js:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth < 0:
                    break
        if depth != 0:
            problems.append(f"line {call.lineno}: {js[:120]}")
    if problems:
        raise SystemExit("G0 self-check failed: unbalanced JS in db() bodies:\n  " + "\n  ".join(problems))


self_check_db_bodies()


# ---------------------------------------------------------------------------
# setup
# ---------------------------------------------------------------------------

def setup():
    mysql(f"UPDATE user SET super_admin=1 WHERE email='{email}';")
    # E2E-only fixture: the gate keeps several Forwards alive on purpose (one per
    # live scenario, plus the refusal cases that still persist a row), and the
    # shared system default caps a team workspace at 10. Raising it here is the
    # same deliberate exception setup.sh already makes for max_nodes — the
    # disposable topology is raised, the product default is not touched. A quota
    # failure inside a contract gate reads as "the contract broke" when it is
    # really the harness running out of headroom.
    mysql("UPDATE capability_policy SET max_tunnels=200, revision=revision+1 WHERE max_tunnels IS NOT NULL;")
    headroom = scalar("SELECT MIN(max_tunnels) FROM capability_policy WHERE max_tunnels IS NOT NULL;")
    check(headroom == "200", "G0.setup the disposable workspace has tunnel headroom", f"min={headroom}")
    check(wait_for_agents(), "G0.setup all four Agents report fresh state before any apply")
    # Recreate the two data-plane Agents so the run begins with an empty port
    # guard. A previous interrupted run can leave a listener behind; the agent's
    # guard then refuses the next fixture's port and the gate would report a
    # product failure that is really harness residue. The Agents restore their
    # desired state from the panel, so this also re-proves the restore path.
    check(recreate_agent(INGRESS_SERVICE, INGRESS_CONTAINER), "G0.setup ingress Agent recreated")
    check(recreate_agent(EGRESS_SERVICE, EGRESS_CONTAINER), "G0.setup egress Agent recreated")
    check(wait_for_agents(180), "G0.setup all four Agents re-report after the recreate")


# ---------------------------------------------------------------------------
# G0.1 – G0.2: the V4 data plane still works
# ---------------------------------------------------------------------------

def g0_1_direct():
    fid, port = new_forward("DIRECT")
    check(port > 0, "G0.1 a DIRECT Forward still gets a real listen port", f"port={port}")
    check(wait_active(fid), "G0.1 a DIRECT Forward still converges to active/applied", f"id={fid}")
    check(tcp_probe(port), "G0.1 the DIRECT listener really forwards TCP end to end", f"port={port}")
    check(scalar(f"SELECT forward_protocol FROM tunnel WHERE id={fid};") == "tcp",
          "G0.1 the canonical protocol fact is written for a new V5 Forward")


def g0_2_relay():
    fid, port = new_forward("RELAY", mode="relay")
    check(port > 0, "G0.2 a RELAY Forward still gets a real listen port", f"port={port}")
    check(wait_active(fid), "G0.2 a RELAY Forward still converges to active/applied", f"id={fid}")
    check(tcp_probe(port), "G0.2 the RELAY listener really forwards TCP across both hops", f"port={port}")


# ---------------------------------------------------------------------------
# G0.3 / G0.18 / G0.19: historical protocol facts
# ---------------------------------------------------------------------------

def plant_legacy_row(name: str, tunnel_type: str = "tcp", target_port: int = 3030) -> tuple[int, int]:
    """Create a real Forward, stop it, then strip the canonical protocol fact.

    Hand-writing the row with Prisma means guessing every NOT NULL column (one
    wrong guess fails the whole case with an opaque validation error). Taking a
    row the product created and removing *only* the fact under test produces
    exactly the legacy shape — a Forward whose sole protocol evidence is
    `tunnel_type` — without inventing a row shape no version ever wrote.

    The runtime is suspended first, on purpose: the case is about a Forward
    coming back from a legacy-shaped row, not about a listener that happened to
    still be running. It also leaves the row in the `error` state the retry
    endpoint requires, which is exactly the state an operator finds after the
    panel refused a legacy protocol.
    """
    fid, port = new_forward(name, target_port=target_port)
    s, b, _ = req("POST", f"/api/forwards/{fid}/suspend", {}, cookie, ws)
    check(s == 200, f"{name}: suspend is accepted for the fixture", f"status={s} body={b}")
    # Verify the outcome instead of assuming it: the assertions this fixture
    # supports are "no listener, no lease", and they can only mean something if
    # the runtime the fixture created is really gone first. A fixture that leaves
    # its own runtime running would make the case fail for a reason that has
    # nothing to do with the protocol fact under test — which is exactly what the
    # first executions of this gate did.
    # Suspend stops the runtime but **keeps the port lease**: the port is
    # reserved so a later resume cannot silently move it (§7.12). So the
    # precondition to verify is "nothing is listening any more", not "no lease" —
    # waiting on the lease would fail forever and blame the wrong thing.
    port_now = int(scalar(f"SELECT IFNULL(listen_port,0) FROM tunnel WHERE id={fid};") or 0)
    stopped = wait_until(
        lambda: (f"tunex-{fid}-direct" not in scalar(
            "SELECT IFNULL(tunnels,'[]') FROM node_state_report WHERE node_id=%d;" % ing)
            and (port_now == 0 or not tcp_probe(port_now, timeout=3)))
        or None,
        timeout=120, interval=3,
    )
    reported_now = scalar("SELECT IFNULL(tunnels,'[]') FROM node_state_report WHERE node_id=%d;" % ing)
    check(bool(stopped), f"{name}: the fixture runtime is really stopped before planting",
          f"lease={active_leases_for([fid])} port_open={tcp_probe(port_now, timeout=3) if port_now else 'n/a'} "
          f"reported={reported_now[:120]}")
    db(
        "await db.tunnel.update({"
        f"where:{{id:{fid}}},"
        f"data:{{forward_protocol:null, tunnel_type:'{tunnel_type}',"
        "desired_status:'active', apply_status:'error', apply_error_code:null,"
        # config_revision is deliberately NOT reset: the node has already applied
        # a higher revision for this tunnel (the suspend bumped it), and a rewound
        # value would make the retry issue a stale command — a correct refusal
        # that has nothing to do with the legacy protocol fact under test.
        "apply_error:null}});return true;"
    )
    return fid, port


def g0_3_legacy_forward_no_rebuild():
    """A Forward created by V4 must keep working without being rebuilt."""
    fid, _port = plant_legacy_row("LEGACY-DIRECT", tunnel_type="tcp")
    check(scalar(f"SELECT IFNULL(forward_protocol,'NULL') FROM tunnel WHERE id={fid};") == "NULL",
          "G0.3 the planted row really has no canonical protocol fact (legacy shape)")

    s, b, _ = req("POST", f"/api/forwards/{fid}/retry", {}, cookie, ws)
    check(s in (200, 202), "G0.3 retry is accepted for a legacy Forward", f"status={s} body={b}")
    check(wait_active(fid), "G0.3 the legacy Forward converges without being recreated", f"id={fid}")
    port = int(scalar(f"SELECT IFNULL(listen_port,0) FROM tunnel WHERE id={fid};") or 0)
    check(port > 0 and tcp_probe(port),
          "G0.3 its listener really forwards: the legacy fact fell back to tunnel_type", f"port={port}")
    check(scalar(f"SELECT IFNULL(forward_protocol,'NULL') FROM tunnel WHERE id={fid};") == "tcp",
          "G0.3 orchestrating it canonicalised the fact instead of relabelling history")


def g0_18_migration_preserved_facts():
    """The WP0/WP1 migrations must have preserved what history actually said."""
    cols = mysql("SHOW COLUMNS FROM tunnel LIKE 'forward_protocol';")
    check("forward_protocol" in cols, "G0.18 the tunnel.forward_protocol column exists", cols)
    cols_rev = mysql("SHOW COLUMNS FROM forward_revision LIKE 'protocol';")
    check("protocol" in cols_rev, "G0.18 the forward_revision.protocol snapshot column exists", cols_rev)
    check("capability_manifest" in mysql("SHOW COLUMNS FROM node_state_report LIKE 'capability_manifest';"),
          "G0.18 the node_state_report.capability_manifest column exists")

    # Every user-facing port_forward that predates V5 must carry a protocol fact.
    missing = scalar(
        "SELECT COUNT(*) FROM tunnel WHERE category='port_forward' AND (forward_protocol IS NULL OR forward_protocol='');"
    )
    check(missing == "0", "G0.18 every historical port_forward kept a protocol fact (backfill held)",
          f"rows_without_fact={missing}")
    # And the revision snapshots inherit it rather than defaulting to a constant.
    orphans = scalar(
        "SELECT COUNT(*) FROM forward_revision r JOIN tunnel t ON t.id=r.tunnel_id "
        "WHERE r.protocol IS NULL OR r.protocol='';"
    )
    check(orphans == "0", "G0.18 existing revision snapshots still know their protocol", f"orphans={orphans}")


def g0_19_historical_non_tcp_not_admitted():
    """A historical wss fact is PRESERVED but must never become runnable."""
    fid, _port = plant_legacy_row("LEGACY-WSS", tunnel_type="wss")
    legacy_refused_ids.append(fid)

    s, b, _ = req("POST", f"/api/forwards/{fid}/retry", {}, cookie, ws)
    body = json.dumps(b, ensure_ascii=False)
    # Two layers may refuse a historical non-TCP fact, and which one fires first
    # is an implementation detail the gate must not pin: the workspace policy
    # (`protocol_not_allowed`, error_layer=capability) and the runtime admission
    # gate (`unsupported_protocol`) both mean "this fact is not runnable". What
    # the check demands is that the refusal is about the protocol — never a
    # timeout, never "node offline".
    check(any(token in body for token in ("protocol_not_allowed", "unsupported_protocol", "协议")),
          "G0.19 retry of a historical non-TCP Forward is refused with a protocol reason",
          f"status={s} body={b}")
    check(s >= 400 or b.get("ok") is False,
          "G0.19 the refusal is not reported as success", f"status={s}")
    check(not wait_active(fid, timeout=45),
          "G0.19 it never converges to active: the historical fact is not an admission")
    check(scalar(f"SELECT IFNULL(forward_protocol,'NULL') FROM tunnel WHERE id={fid};") == "NULL",
          "G0.19 the historical row was not rewritten to hide its protocol")
    check(scalar(f"SELECT tunnel_type FROM tunnel WHERE id={fid};") == "wss",
          "G0.19 the legacy tunnel_type fact is preserved verbatim")
    row = scalar(
        f"SELECT CONCAT(IFNULL(apply_status,''),'|',IFNULL(apply_error_code,''),'|',"
        f"IFNULL(applied_revision,0),'|',IFNULL(config_revision,0)) FROM tunnel WHERE id={fid};"
    )
    status, code, applied, configured = row.split("|")
    check(status == "error",
          "G0.19 the historical Forward stays in error instead of reporting success", f"row={row}")
    check(int(applied) <= int(configured),
          "G0.19 the refusal did not apply anything (applied never leads config)", f"row={row}")
    # Nothing was resurrected on the node either: the suspend removed the runtime
    # and the refused retry must not have created a new one.
    reported = scalar(f"SELECT IFNULL(tunnels,'[]') FROM node_state_report WHERE node_id={ing};")
    check(f"tunex-{fid}-direct" not in reported,
          "G0.19 no runtime was created for the refused historical Forward")
    _ = code


# ---------------------------------------------------------------------------
# G0.4 / G0.5 / G0.9 / G0.10: capability negotiation in the real topology
# ---------------------------------------------------------------------------

def g0_5_new_agent_baseline_and_manifest():
    facts = node_facts(ing)
    check(isinstance(facts.get("version"), int) and facts["version"] >= 2,
          "G0.5 the new Agent reports control protocol version >= 2", f"version={facts.get('version')!r}")
    caps = facts.get("capabilities")
    check(isinstance(caps, list) and "apply_tunnel" in caps,
          "G0.5 it still advertises the V4 baseline actions", f"capabilities={caps!r}")
    manifest = facts.get("manifest")
    check(isinstance(manifest, dict), "G0.5 it reports a v2 capability_manifest", f"manifest={manifest!r}")
    if isinstance(manifest, dict):
        check(manifest.get("schema_version") == 2,
              "G0.5 the manifest declares schema_version 2", f"got={manifest.get('schema_version')!r}")
        check(manifest.get("protocols") == ["tcp"],
              "G0.5 it advertises exactly the protocol the runtime implements", f"protocols={manifest.get('protocols')!r}")
        check(manifest.get("transports") == ["stream"],
              "G0.5 and exactly the transport that carries it", f"transports={manifest.get('transports')!r}")
        for absent in ("udp", "quic", "tls", "ws"):
            check(absent not in (manifest.get("protocols") or []),
                  f"G0.5 it does not advertise the unimplemented protocol {absent}")
        # The diagnostics dimension must agree with the action list, otherwise the
        # panel would have two sources of truth for the same permission.
        diagnostics = manifest.get("diagnostics") or []
        check(set(diagnostics) <= {"tunnel_probe", "node_snapshot"},
              "G0.5 the diagnostics dimension only names implemented diagnostics", f"got={diagnostics!r}")
    # And the baseline really executes (G0.1/G0.2 ran applies through this agent).
    check(wait_for_agents(60), "G0.5 the new Agent keeps reporting after the applies")


def g0_4_old_agent_baseline():
    """Old Agent + new Panel: no manifest, no capabilities, still orchestrated."""
    check(egr is not None, "G0.4 a second node exists for the old-Agent case")
    original = node_facts(egr)
    try:
        db(
            "await db.nodeStateReport.update({"
            f"where:{{node_id:{egr}}},"
            "data:{control_protocol_version:null, capabilities:null, capability_manifest:null,"
            "reported_at:new Date(Date.now()-3600*1000)}"
            "});return true;"
        )
        stripped = node_facts(egr)
        check(stripped.get("version") is None and stripped.get("capabilities") is None,
              "G0.4 the old-Agent shape is really planted (no negotiation facts)",
              f"got={stripped!r}")
        fid, port = new_forward("OLDAGENT", mode="relay")
        check(wait_active(fid), "G0.4 a RELAY Forward still converges while the egress node has no facts",
              f"id={fid}")
        check(tcp_probe(port), "G0.4 and it really forwards: absence means baseline, not 'unsupported'")
    finally:
        # The Agent re-reports on its own within one heartbeat interval; wait for
        # that rather than writing the row back by hand. Hand-writing it would let
        # a broken reporter pass this case.
        restored = wait_until(lambda: (node_facts(egr).get("manifest") is not None) or None, timeout=150, interval=3)
        check(restored, "G0.4 the Agent's real facts came back after the planted outage",
              f"manifest={node_facts(egr).get('manifest')!r}")


def g0_9_malformed_manifest_fails_closed():
    """A corrupt manifest must be refused, not silently downgraded to baseline."""
    try:
        set_manifest(ing, {"schema_version": 2, "protocols": "tcp"})
        # The panel reads the stored value at admission time, so the create itself
        # is where the refusal lands.
        status, fid, _port, body = create_forward("MALFORMED")
        refused_ids.append(fid)
        check(status not in (200, 201),
              "G0.9 the create is refused outright rather than queued", f"status={status}")
        check("runtime_capability_denied" in json.dumps(body),
              "G0.9 the refusal is a runtime_admission denial", f"body={json.dumps(body)[:300]}")
        converged = wait_active(fid, timeout=30)
        check(not converged, "G0.9 a malformed manifest fails closed instead of dispatching",
              f"id={fid} converged={converged}")
        row = scalar(
            f"SELECT CONCAT(IFNULL(apply_status,''),'|',IFNULL(apply_error_code,''),'|',IFNULL(apply_error,'')) "
            f"FROM tunnel WHERE id={fid};"
        )
        check("malformed_capability_manifest" in row or "runtime_admission" in row,
              "G0.9 the refusal names the malformed manifest", f"row={row}")
        check(active_leases_for([fid]) == 0, "G0.9 the refusal produced no port lease")
        check(scalar(f"SELECT IFNULL(listen_port,0) FROM tunnel WHERE id={fid};") in ("0", ""),
              "G0.9 and no listener port was recorded for it")
    finally:
        set_manifest(ing, None)
        restore_node_facts(ing)


def g0_8_transport_not_supported():
    """A node that proves tcp but not the stream transport must be refused."""
    try:
        set_manifest(ing, {"schema_version": 2, "protocols": ["tcp"], "transports": [],
                           "runtime": ["hot_reload"], "diagnostics": []})
        status, fid, _port, body = create_forward("NOTRANSPORT")
        refused_ids.append(fid)
        check(status not in (200, 201), "G0.8 the create is refused outright", f"status={status}")
        check("transport_not_supported" in json.dumps(body),
              "G0.8 the refusal names the transport dimension", f"body={json.dumps(body)[:300]}")
        converged = wait_active(fid, timeout=30)
        check(not converged, "G0.8 a missing transport is refused before dispatch", f"id={fid}")
        row = scalar(f"SELECT IFNULL(apply_error,'') FROM tunnel WHERE id={fid};")
        check("transport_not_supported" in row,
              "G0.8 the refusal names the transport dimension", f"apply_error={row!r}")
        check(active_leases_for([fid]) == 0, "G0.8 no lease was created for the refused config")
    finally:
        set_manifest(ing, None)
        restore_node_facts(ing)


def g0_10_protocol_transport_mismatch():
    """The node must advertise the protocol AND the transport that carries it."""
    try:
        set_manifest(ing, {"schema_version": 2, "protocols": [], "transports": ["stream"],
                           "runtime": [], "diagnostics": []})
        status, fid, _port, body = create_forward("NOPROTOCOL")
        refused_ids.append(fid)
        check(status not in (200, 201), "G0.10 the create is refused outright", f"status={status}")
        check("protocol_not_supported" in json.dumps(body),
              "G0.10 the refusal names the protocol dimension", f"body={json.dumps(body)[:300]}")
        converged = wait_active(fid, timeout=30)
        check(not converged, "G0.10 a manifest without the protocol is refused", f"id={fid}")
        row = scalar(f"SELECT IFNULL(apply_error,'') FROM tunnel WHERE id={fid};")
        check("protocol_not_supported" in row,
              "G0.10 the refusal names the protocol dimension", f"apply_error={row!r}")
    finally:
        set_manifest(ing, None)
        restore_node_facts(ing)


# ---------------------------------------------------------------------------
# G0.6 / G0.7 / G0.17: the deprecated create paths
# ---------------------------------------------------------------------------

def g0_17_deprecated_tunnels_canonicalises():
    # The fixture state uses camelCase "nodeGroups"; read the id from the running
    # Forward instead of guessing the shape — the topology is the source of truth.
    group_id = int(scalar(
        f"SELECT in_node_group_id FROM tunnel WHERE workspace_id={ws} AND in_node_group_id IS NOT NULL "
        "ORDER BY id LIMIT 1;"
    ))
    # The deprecated surface takes `targets` (its own wire contract), not the V4
    # forward's target_host/target_port pair.
    s, b, _ = req("POST", "/api/tunnels", {
        "name": f"{FIXTURE_PREFIX}-DEPRECATED",
        "tunnel_type": "tcp",
        "in_node_group_id": group_id,
        "forward_addresses": ["target-a:3030"],
    }, cookie, ws)
    check(s in (200, 201), "G0.17 the deprecated /api/tunnels TCP create still succeeds", f"status={s} body={b}")
    if s in (200, 201):
        fid = int(unwrap(b).get("id"))
        created_ids.append(fid)
        check(scalar(f"SELECT forward_protocol FROM tunnel WHERE id={fid};") == "tcp",
              "G0.17 it dual-writes the canonical protocol fact")
        check(scalar(f"SELECT tunnel_type FROM tunnel WHERE id={fid};") == "tcp",
              "G0.17 and the legacy column agrees")


def g0_6_omitted_protocol_is_tcp():
    """A V4 client omits the protocol. That must still mean tcp, everywhere.

    This is the *create* side of the compatibility contract, so it is checked on
    the surface a V4 client actually used: the deprecated /api/tunnels route with
    no `tunnel_type` key at all.
    """
    group_id = int(scalar(
        f"SELECT in_node_group_id FROM tunnel WHERE workspace_id={ws} AND in_node_group_id IS NOT NULL "
        "ORDER BY id LIMIT 1;"
    ))
    s, b, _ = req("POST", "/api/tunnels", {
        "name": f"{FIXTURE_PREFIX}-OMITTED",
        "in_node_group_id": group_id,
        "forward_addresses": ["target-a:3030"],
    }, cookie, ws)
    check(s in (200, 201), "G0.6 a create that omits the protocol is accepted", f"status={s} body={b}")
    if s not in (200, 201):
        return
    fid = int(unwrap(b).get("id"))
    created_ids.append(fid)
    check(scalar(f"SELECT forward_protocol FROM tunnel WHERE id={fid};") == "tcp",
          "G0.6 the omitted protocol materialised as the canonical tcp fact")
    check(scalar(f"SELECT tunnel_type FROM tunnel WHERE id={fid};") == "tcp",
          "G0.6 and the legacy column agrees")
    check(wait_active(fid), "G0.6 it converges as a TCP Forward", f"id={fid}")
    port = int(scalar(f"SELECT IFNULL(listen_port,0) FROM tunnel WHERE id={fid};") or 0)
    check(port > 0 and tcp_probe(port), "G0.6 and the listener really carries TCP", f"port={port}")


def g0_7_unknown_protocol_rejected_before_dispatch():
    """An explicit, unopened protocol must be refused before anything is queued."""
    group_id = int(scalar(f"SELECT in_node_group_id FROM tunnel WHERE id={created_ids[0]};"))
    before_rows = scalar("SELECT COUNT(*) FROM tunnel;")
    before_leases = scalar("SELECT COUNT(*) FROM node_port_lease WHERE status='active';")
    s, b, _ = req("POST", "/api/tunnels/v3/relay", {
        "name": f"{FIXTURE_PREFIX}-UDP",
        "tunnel_type": "udp",
        "in_node_group_id": group_id,
        "out_node_group_id": int(scalar(f"SELECT out_node_group_id FROM tunnel WHERE id={created_ids[1]};")),
        "targets": [{"host": "target-b", "port": 3030}],
    }, cookie, ws)
    check(s >= 400, "G0.7 an explicit udp create is refused", f"status={s} body={b}")
    # ensure_ascii=False: json.dumps escapes non-ASCII by default, so a plain
    # `"协议" in json.dumps(b)` could never match and the check would always fail.
    blob = json.dumps(b, ensure_ascii=False)
    check("tcp" in blob.lower() or "协议" in blob,
          "G0.7 the refusal explains that the protocol is not open", f"body={b}")
    check(scalar("SELECT COUNT(*) FROM tunnel;") == before_rows,
          "G0.7 no Forward row was created for an unopened protocol")
    check(scalar("SELECT COUNT(*) FROM node_port_lease WHERE status='active';") == before_leases,
          "G0.7 and no port lease was taken")


# ---------------------------------------------------------------------------
# G0.11 / G0.12: revision and ACK semantics
# ---------------------------------------------------------------------------

def g0_11_revision_semantics():
    fid, port = new_forward("REVISION", target_port=3030)
    check(wait_active(fid), "G0.11 the fixture converges before the revision check", f"id={fid}")
    before = scalar(f"SELECT CONCAT(IFNULL(config_revision,0),'|',IFNULL(applied_revision,0)) FROM tunnel WHERE id={fid};")
    cfg_before, applied_before = (int(x) for x in before.split("|"))
    check(cfg_before == applied_before and cfg_before > 0,
          "G0.11 an applied Forward has applied_revision == config_revision", f"got={before}")

    s, b, _ = req("PATCH", f"/api/forwards/{fid}", {"target_port": 3031}, cookie, ws)
    check(s == 200, "G0.11 an edit through the real command bus succeeds", f"status={s} body={b}")
    check(wait_active(fid), "G0.11 the edit converges on the node")
    after = scalar(f"SELECT CONCAT(IFNULL(config_revision,0),'|',IFNULL(applied_revision,0)) FROM tunnel WHERE id={fid};")
    cfg_after, applied_after = (int(x) for x in after.split("|"))
    check(cfg_after == cfg_before + 1,
          "G0.11 the edit advanced the revision by exactly one", f"before={cfg_before} after={cfg_after}")
    check(applied_after == cfg_after,
          "G0.11 the ACK carried the revision that was issued", f"applied={applied_after} config={cfg_after}")
    check(scalar(f"SELECT remote_port FROM tunnel WHERE id={fid};") == "3031",
          "G0.11 the new target is what the panel stores")
    # The node's own report must agree: same revision, same listener. This is a
    # heartbeat-backed fact (30s interval), so it can lag a fresh apply — waiting
    # is correct here, sampling once would make the gate depend on timing.
    seen = wait_until(
        lambda: (scalar(
            f"SELECT COUNT(*) FROM node_state_report s JOIN tunnel t ON t.ingress_node_id=s.node_id "
            f"WHERE t.id={fid} AND s.reported_revision >= {cfg_after};"
        ) or "0") not in ("0", "") or None,
        timeout=90, interval=5,
    )
    check(bool(seen), "G0.11 the node reports having seen the new revision", f"fid={fid} want>={cfg_after}")


def g0_12_stale_revision_rejected():
    """A command below what the node already applied must not be accepted."""
    fid, port = new_forward("STALE")
    check(wait_active(fid), "G0.12 the fixture converges first", f"id={fid}")
    # Two edits first: the node must have applied a revision ABOVE the one the
    # rewound panel will issue, otherwise the command is merely duplicate (which
    # is legitimately idempotent) rather than stale.
    for target in (3031, 3032):
        s_edit, b_edit, _ = req("PATCH", f"/api/forwards/{fid}", {"target_port": target}, cookie, ws)
        check(s_edit == 200 and wait_active(fid), f"G0.12 edit to port {target} converges",
              f"status={s_edit} body={b_edit}")
    applied = int(scalar(f"SELECT IFNULL(applied_revision,0) FROM tunnel WHERE id={fid};") or 0)
    check(applied >= 3, "G0.12 the fixture has a revision to go stale against", f"applied={applied}")

    # Rewind the desired revision so the next orchestration issues a value the
    # node has already moved past. That is exactly the "panel lost its ledger"
    # shape the revision gate exists for.
    db(f"await db.tunnel.update({{where:{{id:{fid}}},data:{{config_revision:1}}}});return true;")
    s, b, _ = req("POST", f"/api/forwards/{fid}/retry", {}, cookie, ws)
    converged = wait_active(fid, timeout=45)
    row = scalar(f"SELECT CONCAT(IFNULL(apply_status,''),'|',IFNULL(apply_error_code,''),'|',"
                 f"IFNULL(applied_revision,0),'|',IFNULL(config_revision,0)) FROM tunnel WHERE id={fid};")
    status, code, applied_after, cfg_after = row.split("|")
    check(not converged or int(applied_after) >= 2,
          "G0.12 a rewound revision does not silently 'succeed' against a newer applied state",
          f"status={status} code={code} applied={applied_after} config={cfg_after}")
    check(int(applied_after) >= applied,
          "G0.12 the node's applied revision never went backwards", f"before={applied} after={applied_after}")
    check(status == "error" or int(applied_after) >= int(cfg_after),
          "G0.12 the outcome is either a recorded failure or a genuine newer apply",
          f"status={status} applied={applied_after} config={cfg_after} body={b}")


# ---------------------------------------------------------------------------
# G0.13 – G0.15: the durable cache across the schema change
# ---------------------------------------------------------------------------

# The on-disk envelope is `{schema_version, agent_id, saved_at, snapshot:{version, tunnels}}`
# (agent/internal/restore/lkg.go). Writing the tunnels at the top level instead
# produces "lkg cache is corrupt: schema version 0", the agent correctly refuses to
# restore from it, and the gate then blames the product for its own malformed
# fixture — which is exactly what happened the first time these cases ran.
LEGACY_CACHE_TEMPLATE = """{
  "schema_version": 1,
  "agent_id": "%(agent_id)s",
  "saved_at": "2026-10-03T00:00:00Z",
  "snapshot": {
    "version": "0.13.22",
    "tunnels": [
      {
        "id": "tunex-%(tunnel_id)s-direct",
        "mode": "DIRECT",
        "ingress_port": %(port)d,
        "egress_port": 0,
        "remote_host": "target-a",
        "remote_port": 3030,
        "next_hop": "",
        "lb_strategy": "ROUND_ROBIN",
        "speed_limit": 0,
        "revision": %(revision)d,
        "listen_host": ""
      }
    ]
  }
}"""

NEW_CACHE_TEMPLATE = """{
  "schema_version": 1,
  "agent_id": "%(agent_id)s",
  "saved_at": "2026-10-03T00:00:00Z",
  "snapshot": {
    "version": "0.13.22",
    "tunnels": [
      {
        "id": "tunex-%(tunnel_id)s-direct",
        "mode": "DIRECT",
        "ingress_port": %(port)d,
        "egress_port": 0,
        "remote_host": "target-a",
        "remote_port": 3030,
        "next_hop": "",
        "lb_strategy": "ROUND_ROBIN",
        "protocol": "tcp",
        "speed_limit": 0,
        "revision": %(revision)d,
        "listen_host": ""
      }
    ]
  }
}"""


def cache_case(name: str, template: str, expect_protocol: str) -> None:
    """Plant a cache, restart the Agent with the panel DOWN, and require it to serve.

    Both schema shapes must be safe: the OLD one (pre-WP0, no protocol field) is
    what an upgraded node really has on disk, and the NEW one is what it writes
    after the upgrade. A cache that only one of them can restore turns a panel
    outage into a customer-visible outage for whichever half of the fleet upgraded.
    """
    fid, port = new_forward(name)
    check(wait_active(fid), f"{name} fixture converges before the outage", f"id={fid}")
    revision = int(scalar(f"SELECT IFNULL(applied_revision,1) FROM tunnel WHERE id={fid};") or 1)
    docker(["stop", INGRESS_CONTAINER])
    try:
        cache = template % {
            "agent_id": state["nodes"]["ingress"]["agent_id"],
            "tunnel_id": fid,
            "port": port,
            "revision": revision,
        }
        write_agent_cache(INGRESS_CONTAINER, cache)
        cached = json.loads(read_agent_cache(INGRESS_CONTAINER) or "{}")
        check(cached.get("schema_version") == 1,
              f"{name} the planted cache carries the on-disk schema version",
              f"cached={json.dumps(cached)[:160]}")
        entries = (cached.get("snapshot") or {}).get("tunnels") or []
        check(bool(entries) and str(fid) in str(entries[0].get("id", "")),
              f"{name} the planted cache describes the fixture",
              f"cached={json.dumps(cached)[:200]}")
        check(stop_panel(), f"{name} the panel is really down before the restart")

        docker(["start", INGRESS_CONTAINER])
        served = wait_until(lambda: tcp_probe(port, timeout=4) or None, timeout=90, interval=3)
        logs = container_logs(INGRESS_CONTAINER, "5m")
        reason = " | ".join(
            line.strip() for line in logs.splitlines()
            if "v3 restore" in line or "no usable local cache" in line
        )[-400:]
        check(bool(served), f"{name} the node serves its listener from the cache during the outage",
              f"port={port} restore={reason}")
        check("restoring cached desired state" in logs,
              f"{name} the restore really came from the local cache, not the panel", reason)
        if expect_protocol == "tcp":
            check(scalar(f"SELECT forward_protocol FROM tunnel WHERE id={fid};") in ("tcp", "wss"),
                  f"{name} the restored tunnel keeps its protocol fact")
    finally:
        docker(["stop", INGRESS_CONTAINER], allow=True)
        ensure_panel_up()
        docker(["start", INGRESS_CONTAINER], allow=True)
        wait_for_agents(120)


def g0_13_lkg_old_schema():
    cache_case("LKG-OLD", LEGACY_CACHE_TEMPLATE, "tcp")


def g0_14_lkg_new_schema():
    cache_case("LKG-NEW", NEW_CACHE_TEMPLATE, "tcp")


def g0_15_panel_desired_overrides_lkg():
    """After the panel is back, its desired state is authoritative again."""
    fid, port = new_forward("PRUNE")
    check(wait_active(fid), "G0.15 the fixture converges", f"id={fid}")
    docker(["stop", INGRESS_CONTAINER])
    try:
        cache = NEW_CACHE_TEMPLATE % {
            "agent_id": state["nodes"]["ingress"]["agent_id"],
            "tunnel_id": fid,
            "port": port,
            "revision": int(scalar(f"SELECT IFNULL(applied_revision,1) FROM tunnel WHERE id={fid};") or 1),
        }
        write_agent_cache(INGRESS_CONTAINER, cache)
        stop_panel()
        docker(["start", INGRESS_CONTAINER])
        check(bool(wait_until(lambda: tcp_probe(port, timeout=4) or None, timeout=90, interval=3)),
              "G0.15 the node is serving from the cache during the outage")

        # The panel is authoritative again the moment it answers; the write itself
        # needs the panel container running (db() executes inside it), so bring it
        # back FIRST. The node is stopped underneath, which is what makes the next
        # start a real "panel desired vs cached runtime" reconciliation.
        check(ensure_panel_up(), "G0.15 the panel comes back")
        db(f"await db.tunnel.update({{where:{{id:{fid}}},data:{{desired_status:'inactive'}}}});return true;")
        check(scalar(f"SELECT desired_status FROM tunnel WHERE id={fid};") == "inactive",
              "G0.15 the panel's stored desired state is now inactive")
        docker(["stop", INGRESS_CONTAINER], allow=True)
        docker(["start", INGRESS_CONTAINER], allow=True)
        pruned = wait_until(lambda: None if tcp_probe(port, timeout=3) else True, timeout=150, interval=4)
        check(bool(pruned),
              "G0.15 the panel's desired state wins: the cached-only listener is gone",
              f"port={port}")
    finally:
        ensure_panel_up()
        docker(["start", INGRESS_CONTAINER], allow=True)
        wait_for_agents(120)


# ---------------------------------------------------------------------------
# G0.16 / G0.20: redaction and no orphan resources
# ---------------------------------------------------------------------------

def g0_16_diagnostics_redacted():
    fid, _ = new_forward("DIAGNOSE")
    check(wait_active(fid), "G0.16 the fixture converges", f"id={fid}")
    s, b, _ = req("POST", f"/api/forwards/{fid}/diagnose", {}, cookie, ws, timeout=120)
    blob = json.dumps(b)
    check(s in (200, 201, 202), "G0.16 the diagnose entry point still answers", f"status={s}")
    credential = state["nodes"]["ingress"]["credential"]
    check(credential not in blob, "G0.16 the node credential never appears in a diagnostic")
    check((state["nodes"]["ingress"].get("credential_hash") or "no-hash") not in blob,
          "G0.16 nor its stored hash")
    for token in ("-----BEGIN", "password", "AUTH_SECRET", "TUNEX_CONFIG_KEY"):
        check(token not in blob, f"G0.16 no secret-shaped material leaks: {token}")

    # The node-level self report goes through the same rails.
    s2, b2, _ = req("GET", f"/api/admin/node/{ing}/support-bundle", cookie=cookie, timeout=180)
    if s2 == 200:
        blob2 = json.dumps(b2)
        check(credential not in blob2, "G0.16 the support bundle carries no node credential")
        check("-----BEGIN" not in blob2, "G0.16 and no PEM material")


def g0_20_no_orphan_resources():
    """Everything refused above must have left the node untouched.

    Two independent readings, because they can disagree and the disagreement is
    the interesting case:

      · the panel's own records (no active lease, no listener port) — what the
        operator sees and what the next reconcile reads;
      · the node's own state report (no runtime for a refused id) — the fact the
        panel never gets to invent.

    This is also a cross-check over the WHOLE topology, not just this gate's
    bookkeeping: any Forward that is inactive in its desired state must not have
    a lease. If that fails, the evidence below names the row, so the next person
    starts from the data instead of from a re-run.
    """
    rejected = list(refused_ids)
    check(bool(rejected), "G0.20 the gate really produced refused configs to check", f"ids={rejected}")
    # `refused_ids` only holds FRESH refusals: a Forward created and refused in
    # one step. The planted legacy row is checked separately, because it comes
    # from a Forward that really ran first (and whose port lease is deliberately
    # still reserved for a resume).
    for fid in rejected:
        check(scalar(f"SELECT IFNULL(apply_status,'') FROM tunnel WHERE id={fid};") == "error",
              f"G0.20 Forward {fid} is recorded as refused")
        row = scalar(
            f"SELECT CONCAT(IFNULL(desired_status,''),'|',IFNULL(apply_status,''),'|',"
            f"IFNULL(listen_port,0),'|',IFNULL(egress_port,0),'|',IFNULL(apply_error_code,'')) "
            f"FROM tunnel WHERE id={fid};"
        )
        desired, status, listen_port, egress_port, code = row.split("|")
        check(active_leases_for([fid]) == 0 and listen_port == "0" and egress_port == "0",
              f"G0.20 refused Forward {fid} holds no port and no lease",
              f"row={row} leases={active_leases_for([fid])}")
        check(desired == "inactive",
              f"G0.20 refused Forward {fid} was never marked desired-active", f"desired={desired!r}")

    reported = scalar(f"SELECT IFNULL(tunnels,'[]') FROM node_state_report WHERE node_id={ing};")
    leaked = []
    for fid in rejected:
        for suffix in ("direct", "relay", "egress"):
            if f"tunex-{fid}-{suffix}" in reported:
                leaked.append(f"tunex-{fid}-{suffix}")
    check(not leaked,
          "G0.20 no rejected config ever produced a listener on the node",
          f"leaked={leaked} report={reported[:300]}")

    # Topology-wide check for the two shapes that are ALWAYS a defect:
    #   · a lease pointing at a Forward that no longer exists (dangling);
    #   · a lease held by a Forward that is inactive *and* in error — i.e. a
    #     config that was refused, not one that was deliberately suspended.
    #
    # A suspended Forward keeping its lease is NOT a defect: the port stays
    # reserved so a later resume cannot silently move it (§7.12). Writing this
    # check as "every inactive row must be lease-free" made the gate fail on the
    # product's documented behaviour — the first version of this check did
    # exactly that.
    orphans = scalar(
        "SELECT COUNT(*) FROM node_port_lease l LEFT JOIN tunnel t ON t.id = l.tunnel_id "
        "WHERE l.status='active' AND (t.id IS NULL OR (t.desired_status <> 'active' AND t.apply_status = 'error'));"
    )
    dangling = scalar(
        "SELECT COUNT(*) FROM node_port_lease l LEFT JOIN tunnel t ON t.id = l.tunnel_id "
        "WHERE l.status='active' AND t.id IS NULL;"
    )
    check(dangling == "0", "G0.20 no active lease points at a Forward that no longer exists", f"dangling={dangling}")
    lease_detail = scalar(
        "SELECT GROUP_CONCAT(CONCAT(l.tunnel_id, ':', t.desired_status, '/', t.apply_status)) "
        "FROM node_port_lease l JOIN tunnel t ON t.id = l.tunnel_id "
        "WHERE l.status='active' AND t.desired_status <> 'active' AND t.apply_status = 'error';"
    )
    check(orphans == "0",
          "G0.20 no refused Forward holds a port lease anywhere",
          f"orphans={orphans} rows={lease_detail}")

    # The planted legacy row: no runtime, whatever its reservation says.
    for fid in legacy_refused_ids:
        check(f"tunex-{fid}-direct" not in reported,
              f"G0.20 the refused legacy Forward {fid} has no runtime on the node")

    for node_id, label in ((ing, "ingress"), (egr, "egress")):
        row = scalar(f"SELECT IFNULL(reported_revision,0) FROM node_state_report WHERE node_id={node_id};")
        check(row.isdigit(), f"G0.20 the {label} node still reports a revision", f"got={row!r}")


# ---------------------------------------------------------------------------
# cleanup
# ---------------------------------------------------------------------------

def cleanup():
    try:
        cleanup_fixtures()
        check(scalar(f"SELECT COUNT(*) FROM tunnel WHERE name LIKE '{FIXTURE_PREFIX}%';") == "0",
              "G0.cleanup every fixture this gate created was removed")
    except Exception as exc:  # noqa: BLE001
        record(False, f"G0.cleanup fixtures: {type(exc).__name__}: {exc}")
    ensure_panel_up()


def main():
    signal.signal(signal.SIGALRM, alarm)
    ready = False
    try:
        signal.setitimer(signal.ITIMER_REAL, min(300, OVERALL_SECONDS))
        setup()
        ready = True
        signal.setitimer(signal.ITIMER_REAL, 0)
        for name, fn, budget in [
            ("G0.1 DIRECT", g0_1_direct, 240),
            ("G0.2 RELAY", g0_2_relay, 240),
            ("G0.18 migration", g0_18_migration_preserved_facts, 60),
            ("G0.17 deprecated tunnels", g0_17_deprecated_tunnels_canonicalises, 240),
            ("G0.5 new Agent baseline", g0_5_new_agent_baseline_and_manifest, 120),
            ("G0.3 legacy Forward", g0_3_legacy_forward_no_rebuild, 300),
            ("G0.6 omitted protocol", g0_6_omitted_protocol_is_tcp, 300),
            ("G0.7 unknown protocol", g0_7_unknown_protocol_rejected_before_dispatch, 120),
            ("G0.11 revision semantics", g0_11_revision_semantics, 300),
            ("G0.12 stale revision", g0_12_stale_revision_rejected, 300),
            ("G0.19 historical non-TCP", g0_19_historical_non_tcp_not_admitted, 200),
            ("G0.4 old Agent", g0_4_old_agent_baseline, 420),
            ("G0.9 malformed manifest", g0_9_malformed_manifest_fails_closed, 300),
            ("G0.8 unknown transport", g0_8_transport_not_supported, 300),
            ("G0.10 protocol mismatch", g0_10_protocol_transport_mismatch, 300),
            ("G0.16 diagnostics", g0_16_diagnostics_redacted, 420),
            ("G0.13 LKG old schema", g0_13_lkg_old_schema, 420),
            ("G0.14 LKG new schema", g0_14_lkg_new_schema, 420),
            ("G0.15 panel overrides LKG", g0_15_panel_desired_overrides_lkg, 480),
            ("G0.20 no orphans", g0_20_no_orphan_resources, 120),
        ]:
            case(name, fn, budget)
    except Exception as exc:  # noqa: BLE001
        record(False, f"G0 prerequisite/setup: {type(exc).__name__}: {exc}; remaining tests NOT EXECUTED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.setitimer(signal.ITIMER_REAL, 300)
        try:
            cleanup()
        except Exception as exc:  # noqa: BLE001
            record(False, f"G0.cleanup: {type(exc).__name__}: {exc}; inspect topology before rerun")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        RESULT.write_text(
            "# V5-G0 contract compatibility gate\n"
            f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
            "topology: scripts/v3-e2e/docker-compose.e2e.yaml (existing Agents, real TCP)\n"
            f"fixture: {FIXTURE_PREFIX}; setup={'executed' if ready else 'incomplete'}\n"
            f"elapsed_seconds: {int(time.monotonic() - START)}\n"
            + "\n".join(RESULTS)
            + f"\nV5-G0 TOTAL PASS={PASS} FAIL={FAIL}\n",
            encoding="utf-8",
        )
        TRACE.write_text(
            json.dumps({"http": HTTP, "tracebacks": TRACEBACKS}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"V5-G0 TOTAL PASS={PASS} FAIL={FAIL} evidence={RESULT}", flush=True)
    return 1 if FAIL or not ready else 0


if not (STATE.exists() and ENVF.exists() and PASSF.exists()):
    raise SystemExit("missing e2e state; run scripts/v3-e2e/setup.sh first")

state = json.loads(STATE.read_text())
email = state["user"]["email"]
pw = password()
ws = state["workspaces"]["primary"]["id"]
user_id = int(scalar(f"SELECT id FROM user WHERE email='{email}';"))
ing = state["nodes"]["ingress"]["id"]
egr = state["nodes"]["egress"]["id"]
in_group = int(scalar(
    f"SELECT in_node_group_id FROM tunnel WHERE workspace_id={ws} AND in_node_group_id IS NOT NULL ORDER BY id LIMIT 1;"
) or 0)
out_group = int(scalar(
    f"SELECT out_node_group_id FROM tunnel WHERE workspace_id={ws} AND out_node_group_id IS NOT NULL ORDER BY id LIMIT 1;"
) or 0)
cookie = login(email, pw)


if __name__ == "__main__":
    raise SystemExit(main())
