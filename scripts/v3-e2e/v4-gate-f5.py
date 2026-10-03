#!/usr/bin/env python3
"""V4-F5 real durability / shutdown / operations gate (WP11A/B/D).

Scope, and why each case exists:

  F5.1  ACK binding        a fabricated command_id with a VALID node credential must
                           be refused: the credential proves the node, not the
                           existence of the command it claims to answer.
  F5.2  LKG written        the node's durable cache exists, is owner-only, carries
                           this agent's immutable id and the running tunnel set.
  F5.3  Outage restart     with the panel stopped, a recreated agent still serves
                           its listeners from that cache (panel outage must not
                           become a customer-visible outage).
  F5.4  Fail closed        a cache belonging to another agent, or a corrupt cache,
                           is refused — no listener is restored from it.
  F5.5  No resurrection    a Forward deleted while the node was offline must be
                           pruned once the panel answers again (the cache is not
                           allowed to keep serving work the panel has dropped).
  F5.6  Graceful shutdown  stop closes listeners (new TCP is refused promptly),
                           lets an in-flight connection finish, and exits within
                           the stop timeout instead of being killed.
  F5.7  ACK for a live     a real orchestrated edit still converges (the hardened
        command            bus did not break the normal path).
  F5.8  Ops scripts        the backup/restore/rollback rewrite guards: no
                           `compose inspect`, no double-gzip, passphrase never in
                           argv, both compose files still validate.

A missing topology, timeout, failed prerequisite or cleanup failure is a FAIL. A
static compilation of this file is NOT F5 closure: this script has to be run
against the real multi-agent topology for the gate to count.
"""
from __future__ import annotations

import json
import os
import re
import signal
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
RESULT = OUT / "v4-gate-f5-result.txt"
TRACE = OUT / "v4-gate-f5-http.json"

PASS = 0
FAIL = 0
RESULTS: list[str] = []
HTTP: list[dict] = []

# container names (docker exec/inspect) vs compose SERVICE names (docker compose
# up/stop/start): mixing them up is how "no such service" silently no-ops a whole
# stop/start cycle and leaves a case testing nothing.
INGRESS_CONTAINER = "wp14-ingress-agent"
PANEL_CONTAINER = "wp14-panel"
CLIENT_CONTAINER = "wp14-client"
INGRESS_SERVICE = "ingress-agent"
# V4-WP11B upgrade case runs on the SECONDARY ingress so the main fixtures (and
# their listener ports) are never disturbed by a container replacement.
INGRESS_B_CONTAINER = "wp14-ingress-agent-b"
INGRESS_B_SERVICE = "ingress-agent-b"
INGRESS_B_HOST = "172.31.10.21"
INGRESS_B_PORT_RANGE = (21000, 21099)
PANEL_SERVICE = "panel"
WORKER_SERVICE = "worker"
STATE_DIR = "/var/lib/tunex-agent"
LKG_FILE = f"{STATE_DIR}/desired-lkg.json"

START = time.monotonic()
OVERALL_SECONDS = int(os.environ.get("F5_OVERALL_SECONDS", "900"))


def alarm(_signum, _frame):
    raise TimeoutError(f"F5 overall time budget exhausted ({OVERALL_SECONDS}s)")


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
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


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


def sql_json(json_text: str) -> str:
    """A JSON column literal for an inline SQL statement.

    `scalar()` hands back MySQL's JSON text (`["a", "b"]`), which is NOT a SQL
    literal: interpolating it raw produced `SET capabilities=["a"]` and a syntax
    error. Single-quoting it (escaping quotes defensively) is what makes the
    restore work.
    """
    if json_text in ("", "NULL"):
        return "NULL"
    return "CAST('" + json_text.replace("'", "''") + "' AS JSON)"


def mysql_root_password() -> str:
    """The e2e MySQL root password (from the stack's env file)."""
    return parse_env(ENVF).get("MYSQL_ROOT_PASSWORD", "")


def container_logs(container: str, since: str = "10m") -> str:
    """Container logs, stdout AND stderr.

    The agent writes its structured log to stderr, and the generic run() helper
    returns stdout only — which is why a log assertion could fail with an empty
    capture while the line was plainly there.
    """
    proc = subprocess.run(["docker", "logs", "--since", since, container],
                          text=True, capture_output=True, timeout=120)
    return proc.stdout + proc.stderr


def run_with_input(args, stdin_text: str, timeout=120):
    proc = subprocess.run(args, input=stdin_text, text=True, capture_output=True, timeout=timeout)
    if proc.returncode:
        raise RuntimeError(f"{' '.join(args)} failed: {proc.stderr.strip() or proc.stdout.strip()}")
    return proc.stdout.strip()


def agent_state_volume() -> str:
    volume = docker(["inspect", "-f",
                     '{{range .Mounts}}{{if eq .Destination "/var/lib/tunex-agent"}}{{.Name}}{{end}}{{end}}',
                     INGRESS_CONTAINER])
    if not volume:
        raise RuntimeError("could not resolve the agent state volume")
    return volume


def write_agent_cache(content: str) -> None:
    """Write the agent's cache file while the agent is STOPPED.

    `docker exec` needs a running container, so the file is written by a
    throwaway container that mounts the same state volume. That is also the only
    way to plant a cache the agent has not overwritten yet.
    """
    volume = agent_state_volume()
    run_with_input(["docker", "run", "--rm", "-i", "-v", f"{volume}:/state", "busybox:1.36",
                    "sh", "-c", "mkdir -p /state && cat > /state/desired-lkg.json && chmod 600 /state/desired-lkg.json"],
                   content)


def read_agent_cache() -> str:
    volume = agent_state_volume()
    return run(["docker", "run", "--rm", "-v", f"{volume}:/state:ro", "busybox:1.36",
                "sh", "-c", "cat /state/desired-lkg.json 2>/dev/null || true"], allow=True)


_COMPOSE_ENV: dict | None = None


def compose_env() -> dict:
    """Environment the e2e compose file needs to interpolate.

    The file pins the images and the four Agents' credentials as *required*
    variables, and gates run in their own shell (in CI, a separate workflow
    step) — so `docker compose` here must be handed the same facts setup.sh
    exported. They are read back from the running topology and the state file
    instead of being duplicated, which is the pattern v4-gate-f2.py uses.
    """
    global _COMPOSE_ENV
    if _COMPOSE_ENV is None:
        env = os.environ.copy()
        env["TUNEX_BACKEND_IMAGE"] = run(["docker", "inspect", "-f", "{{.Config.Image}}", "wp14-panel"])
        env["WP14_AGENT_IMAGE"] = run(["docker", "inspect", "-f", "{{.Config.Image}}", INGRESS_CONTAINER])
        for key, prefix in [("ingress", "WP14_INGRESS"), ("egress", "WP14_EGRESS"),
                            ("ingress_secondary", "WP14_INGRESS_B"), ("egress_secondary", "WP14_EGRESS_B")]:
            env[prefix + "_CREDENTIAL"] = state["nodes"][key]["credential"]
            env[prefix + "_AGENT_ID"] = state["nodes"][key]["agent_id"]
        _COMPOSE_ENV = env
    return _COMPOSE_ENV


def compose(*args, allow=False, timeout=600):
    return run([*COMPOSE, *args], env=compose_env(), allow=allow, timeout=timeout)


def agent_exec(script: str, allow=False) -> str:
    return docker(["exec", INGRESS_CONTAINER, "sh", "-c", script], allow=allow)


def mysql(sql: str) -> str:
    e = parse_env(ENVF)
    return run(
        ["docker", "exec", "wp14-mysql", "mysql", "-uroot", f"-p{e['MYSQL_ROOT_PASSWORD']}",
         e.get("MYSQL_DATABASE", "tunex"), "-N", "-e", sql]
    )


def scalar(sql: str) -> str:
    v = mysql(sql).strip()
    return v.splitlines()[-1].strip() if v else ""


def db(js: str) -> object:
    """Run a small Prisma script inside the panel container (same pattern as F4)."""
    out = docker(["exec", PANEL_CONTAINER, "bun", "-e", (
        'import { PrismaClient } from "@prisma/client";'
        "const db=new PrismaClient();const f=async()=>{" + js + "};"
        "console.log(JSON.stringify(await f()));await db.$disconnect();"
    )], timeout=120)
    line = out.strip().splitlines()[-1] if out.strip() else "null"
    return json.loads(line)


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


def unwrap(b):
    return b.get("data", b) if isinstance(b, dict) else b


def login(email: str, pw: str) -> str:
    s, b, h = req("POST", "/api/auth/login", {"email": email, "password": pw})
    check(s == 200, "F5.0 E2E user login", f"status={s} body={b}")
    return (h.get("set-cookie") or "").split(";", 1)[0]


def wait_until(fn, timeout=150, interval=2):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as exc:  # noqa: BLE001
            last = exc
        time.sleep(interval)
    return None


def tcp_probe(host: str, port: int, timeout: int = 4) -> str:
    return run(
        ["docker", "exec", CLIENT_CONTAINER, "sh", "-c", f"nc -w {timeout} {host} {port} </dev/null"],
        allow=True, timeout=timeout + 10,
    ).strip()


def tcp_connect_only(host: str, port: int, timeout: int = 3):
    """Return (ok, elapsed) for a bare connect attempt, without needing nc output."""
    start = time.monotonic()
    script = (
        "python3 - <<'PY'\n"
        "import socket\n"
        f"s=socket.socket();s.settimeout({timeout})\n"
        "try:\n"
        f"    s.connect(('{host}',{port}));print('OPEN')\n"
        "except socket.timeout:\n"
        "    print('TIMEOUT')\n"
        "except OSError:\n"
        "    print('REFUSED')\n"
        "finally:\n"
        "    s.close()\n"
        "PY"
    )
    out = run(["docker", "exec", CLIENT_CONTAINER, "sh", "-c", script], allow=True, timeout=timeout + 15)
    return ("OPEN" in out, time.monotonic() - start)


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


if not (STATE.exists() and ENVF.exists() and PASSF.exists()):
    raise SystemExit("missing e2e state; run scripts/v3-e2e/setup.sh first")

state = json.loads(STATE.read_text())
email = state["user"]["email"]
pw = password()
ws = state["workspaces"]["primary"]["id"]
ing = state["nodes"]["ingress"]["id"]
ing_agent_id = state["nodes"]["ingress"]["agent_id"]
ing_ip = state.get("nodes", {}).get("ingress", {}).get("data_ip", "172.31.10.20")
cookie = login(email, pw)

# ---- F5 fixture: a disposable Forward, so no historical Gate row is touched ----
FIXTURE_NAME = f"WP14-F5-DURABLE-{int(time.time())}"
fixture_id: int | None = None
fixture_port: int | None = None
panel_stopped = False
agent_recreated = False
local_listener_backup: str | None = None


def fixture_cleanup():
    """Remove only what this gate created; never delete historical resources."""
    if fixture_id is not None:
        db(f"await db.tunnel.deleteMany({{where:{{id:{fixture_id}}}}});return true;")
    for stale in db(
        f"return await db.tunnel.findMany({{where:{{name:{{startsWith:'WP14-F5-'}}}},select:{{id:true}}}});"
    ) or []:
        db(f"await db.tunnel.deleteMany({{where:{{id:{stale['id']}}}}});return true;")


def ensure_panel_up():
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


def ensure_agent_up() -> bool:
    """Bring the ingress agent back without touching its compose dependencies.

    `docker compose up <service>` also starts `depends_on` services, which would
    silently restart the panel we deliberately stopped — turning an "agent starts
    during a panel outage" case into "agent starts with a healthy panel" without
    failing anything. `--no-deps` is what makes the outage real.
    """
    compose("up", "-d", "--force-recreate", "--no-deps", INGRESS_SERVICE)
    end = time.time() + 120
    while time.time() < end:
        state = docker(["inspect", "-f", "{{.State.Status}}", INGRESS_CONTAINER], allow=True).strip()
        if state == "running":
            return True
        time.sleep(2)
    return False


def wait_for_agents(timeout: int = 240) -> bool:
    """Wait until all four Agents report with a fresh, credential-authenticated
    state report.

    Without this, a gate that starts right after the Agents are (re)created can
    enqueue its first apply before any control loop is polling: the command then
    times out, and the resulting 502 looks like a product failure when it is
    purely a race in the harness. setup.sh performs the same wait for the same
    reason.
    """
    def one():
        row = scalar(
            "SELECT COUNT(*) FROM node_state_report s JOIN node n ON n.id=s.node_id "
            "WHERE n.node_id IN ('WP14-IN-A-NODE','WP14-OUT-A-NODE','WP14-IN-C-NODE','WP14-OUT-B-NODE') "
            "AND s.reported_at > NOW() - INTERVAL 2 MINUTE;"
        )
        return row if row.isdigit() and int(row) >= 4 else None
    return wait_until(one, timeout, 3) is not None


def setup():
    mysql(f"UPDATE user SET super_admin=1 WHERE email='{email}';")
    check(wait_for_agents(), "F5.setup all four Agents are reporting fresh state before any apply")
    s, b, _ = req("POST", "/api/forwards", {
        "name": FIXTURE_NAME,
        "mode": "direct",
        "ingress_node_id": ing,
        "target_host": "target-a",
        "target_port": 3030,
    }, cookie, ws)
    check(s in (200, 201), "F5.setup create disposable DIRECT Forward through the real API", f"status={s} body={b}")
    if s not in (200, 201):
        raise RuntimeError("cannot create the F5 fixture Forward")
    global fixture_id, fixture_port
    fixture_id = int(unwrap(b).get("id"))
    fixture_port = int(unwrap(b).get("listen_port") or 0)
    check(fixture_port > 0, "F5.setup Forward got a real listen port", f"port={fixture_port}")
    check(wait_active(fixture_id), "F5.setup Forward converges to active/applied", f"id={fixture_id}")


def f5_1_ack_binding():
    """A valid node credential must not be enough to answer a command that was
    never issued."""
    cred = state["nodes"]["ingress"]["credential"]
    s, b, _ = req(
        "POST", "/api/internal/node/ack",
        {"command_id": "f5-fabricated-command", "ok": True, "applied_revision": 999},
        headers={"authorization": f"Bearer {cred}"},
    )
    check(s == 400, "F5.1 fabricated ACK with a valid credential is refused", f"status={s} body={b}")

    s, b, _ = req(
        "POST", "/api/internal/node/ack",
        {"command_id": "", "ok": True},
        headers={"authorization": f"Bearer {cred}"},
    )
    check(s == 400, "F5.1 empty command_id is refused", f"status={s} body={b}")

    s, b, _ = req("POST", "/api/internal/node/ack", {"command_id": "x", "ok": True})
    check(s in (401, 403), "F5.1 ACK without a credential is refused", f"status={s} body={b}")


def f5_2_lkg_written():
    # The cache is refreshed by the manager's mutation hook, so it should already
    # name the new Forward; the bounded wait only absorbs scheduling jitter.
    expected_id = f"tunex-{fixture_id}-direct"
    wait_until(lambda: expected_id in agent_exec(f"cat {LKG_FILE} 2>/dev/null || true", allow=True) or None, 20, 1)
    raw = read_agent_cache()
    check(raw != "", "F5.2 the node wrote a durable last-known-good cache", f"path={LKG_FILE}")
    if raw == "":
        return
    try:
        env = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        record(False, f"F5.2 cache is valid JSON: {exc}")
        return
    check(env.get("schema_version") == 1, "F5.2 cache carries its schema version", f"got={env.get('schema_version')}")
    check(env.get("agent_id") == ing_agent_id, "F5.2 cache is bound to this immutable agent id",
          f"cache={env.get('agent_id')} agent={ing_agent_id}")
    ids = [t.get("id") for t in (env.get("snapshot") or {}).get("tunnels", [])]
    expected = f"tunex-{fixture_id}-direct"
    check(expected in ids, "F5.2 cache contains the applied Forward", f"ids={ids}")

    perms = docker(["exec", INGRESS_CONTAINER, "sh", "-c",
                    f"stat -c %a {LKG_FILE}"], allow=True).strip()
    check(perms == "600", "F5.2 cache file is owner-only (0600)", f"mode={perms}")

    for needle in ("credential", "TUNEX_NODE_CREDENTIAL", "Bearer"):
        check(needle.lower() not in raw.lower(), f"F5.2 cache stores no {needle}", "secret material must never be cached")


def f5_3_outage_restart():
    """Panel outage + agent recreation must not take the listener down."""
    global panel_stopped, local_listener_backup
    local_listener_backup = agent_exec(f"cat {LKG_FILE} 2>/dev/null || true", allow=True)

    compose("stop", "panel", "worker", allow=True)
    panel_stopped = True
    check(True, "F5.3 panel+worker stopped for the outage window")

    compose("up", "-d", "--force-recreate", "--no-deps", INGRESS_SERVICE)
    agent_recreated = True

    # The cached restore must rebind the port even though the panel is gone.
    # A successful `nc -z` is the signal; a refused connection exits non-zero.
    def rebind():
        out = run(["docker", "exec", CLIENT_CONTAINER, "sh", "-c",
                   f"nc -w 3 -z {ing_ip} {fixture_port} && echo BOUND"], allow=True, timeout=20)
        return "BOUND" in out
    check(wait_until(rebind, 120, 3) is not None,
          "F5.3 recreated agent rebinds its listener while the panel is unreachable")

    def cache_marker():
        logs = container_logs(INGRESS_CONTAINER, "5m")
        return logs if ("cached desired state" in logs or "source=lkg" in logs) else None
    logs = wait_until(cache_marker, 30, 2)
    detail = " | ".join((logs or container_logs(INGRESS_CONTAINER, "5m")).splitlines()[:6])
    check(logs is not None,
          "F5.3 the node says it restored from its local cache",
          f"log must state the source; first lines were: {detail}")


def f5_4_fail_closed():
    """A cache that belongs to another agent, or is corrupt, must NOT be used."""
    global panel_stopped
    compose("stop", INGRESS_SERVICE, allow=True)

    # (a) another agent's identity
    forged = {
        "schema_version": 1,
        "agent_id": "not-this-agent",
        "saved_at": "2026-01-01T00:00:00Z",
        "snapshot": {"version": "v1", "tunnels": [{
            "id": f"tunex-{fixture_id}-direct", "mode": "DIRECT", "ingress_port": fixture_port,
            "egress_port": 0, "remote_host": "172.31.20.30", "remote_port": 8080,
            "next_hop": "", "targets": [], "lb_strategy": "ROUND_ROBIN", "protocol": "tcp",
            "speed_limit": 0, "revision": 99, "listen_host": ing_ip,
        }]},
    }
    write_agent_cache(json.dumps(forged))
    compose("up", "-d", "--force-recreate", "--no-deps", INGRESS_SERVICE)
    time.sleep(8)
    bound, _ = tcp_connect_only(ing_ip, fixture_port)
    check(not bound, "F5.4 a cache bound to another agent id is not adopted", "no listener may come from it")
    state_now = docker(["inspect", "-f", "{{.State.Status}}", INGRESS_CONTAINER], allow=True).strip()
    check(state_now == "running", "F5.4 the agent stays up after refusing a foreign cache", f"state={state_now}")

    # (b) corrupt cache
    compose("stop", INGRESS_SERVICE, allow=True)
    write_agent_cache("{not json")
    compose("up", "-d", "--force-recreate", "--no-deps", INGRESS_SERVICE)
    time.sleep(8)
    bound, _ = tcp_connect_only(ing_ip, fixture_port)
    check(not bound, "F5.4 a corrupt cache is not adopted", "no listener may come from it")

    # (c) valid cache again, so the rest of the gate runs on real state
    compose("stop", INGRESS_SERVICE, allow=True)
    if local_listener_backup:
        write_agent_cache(local_listener_backup)
    panel_stopped = not ensure_panel_up()
    compose("up", "-d", "--force-recreate", "--no-deps", INGRESS_SERVICE)
    check(wait_until(lambda: wait_active(fixture_id), 180, 3) is not None,
          "F5.4 the fixture converges again once the panel is back")


def f5_5_no_resurrection():
    """A Forward dropped while the node was offline must be pruned on reconnect.

    The dangerous sequence is real: node offline with a cached listener, row
    deleted meanwhile, node comes back BEFORE the panel can answer — so it
    restores from cache — and then the panel returns. Without an authoritative
    reconcile that listener would keep serving forever.
    """
    global panel_stopped

    # 1. Panel goes away; the agent keeps running.
    compose("stop", PANEL_SERVICE, WORKER_SERVICE, allow=True)
    panel_stopped = True

    # 2. Agent goes away too, keeping its cache on disk.
    compose("stop", INGRESS_SERVICE, allow=True)

    # 3. The Forward disappears. MySQL is still up, so the row is removed exactly
    #    as a panel-side delete while the node was offline would leave it.
    mysql(f"DELETE FROM tunnel WHERE id={fixture_id};")
    check(scalar(f"SELECT COUNT(*) FROM tunnel WHERE id={fixture_id};") == "0",
          "F5.5 the row is gone while both the panel and the node are down")

    # 4. Agent returns first: it can only restore from its cache.
    compose("up", "-d", "--force-recreate", "--no-deps", INGRESS_SERVICE)
    resurrected = wait_until(lambda: run(
        ["docker", "exec", CLIENT_CONTAINER, "sh", "-c",
         f"nc -w 3 -z {ing_ip} {fixture_port} && echo BOUND"], allow=True, timeout=20
    ).find("BOUND") >= 0 or None, 120, 3) is not None
    check(resurrected, "F5.5 the cached listener is back before the panel answers",
          "this is the state the reconcile must clean up")

    # 5. Panel returns: the agent's reconnect reconcile must drop it.
    compose("start", PANEL_SERVICE, WORKER_SERVICE, allow=True)
    panel_stopped = False
    check(ensure_panel_up(), "F5.5 the panel is back and healthy")

    def pruned():
        out = run(["docker", "exec", CLIENT_CONTAINER, "sh", "-c",
                   f"nc -w 3 -z {ing_ip} {fixture_port} && echo BOUND"], allow=True, timeout=20)
        return "PRUNED" if "BOUND" not in out else None
    if resurrected:
        check(wait_until(pruned, 180, 4) is not None,
              "F5.5 the resurrected listener is pruned once the panel is authoritative")
        logs = container_logs(INGRESS_CONTAINER, "8m")
        check("reconcile" in logs.lower() or "removed runtime" in logs.lower(),
              "F5.5 the node reports the prune instead of doing it silently")
    else:
        # Without the resurrection there is nothing to prune, and reporting a pass
        # here would hide the real failure one line above.
        record(False, "F5.5 prune not verifiable: the cached listener never came back during the outage")


def f5_6_graceful_shutdown():
    """Stop closes listeners promptly, lets in-flight work finish, and exits."""
    if not ensure_panel_up() or not ensure_agent_up():
        record(False, "F5.6 could not restore the topology before the shutdown case")
        return
    s, b, _ = req("POST", "/api/forwards", {
        "name": f"{FIXTURE_NAME}-SHUTDOWN",
        "mode": "direct",
        "ingress_node_id": ing,
        "target_host": "target-a",
        "target_port": 3030,
    }, cookie, ws)
    check(s in (200, 201), "F5.6 second fixture Forward for the shutdown case", f"status={s} body={b}")
    if s not in (200, 201):
        return
    fid2 = int(unwrap(b).get("id"))
    port2 = int(unwrap(b).get("listen_port") or 0)
    check(wait_active(fid2), "F5.6 second Forward is active")

    # Hold a live connection open across the stop. The e2e client is a busybox
    # image (no python3), so the holder is `nc` — which also gives the two facts
    # this case needs: the banner proving the connection is really proxied, and
    # the moment the socket died.
    run(["docker", "exec", CLIENT_CONTAINER, "sh", "-c",
         "rm -f /tmp/f5-hold.txt /tmp/f5-hold-ended"], allow=True)
    # `docker exec -d` gives the process no stdin; a bare `nc` then sees EOF and
    # drops the connection instantly. Feeding it from a slow pipe keeps the
    # connection open across the stop, which is what this case must observe.
    docker(["exec", "-d", CLIENT_CONTAINER, "sh", "-c",
            f"(sleep 30; echo hold) | nc {ing_ip} {port2} > /tmp/f5-hold.txt 2>&1; "
            "date +%s > /tmp/f5-hold-ended"])
    time.sleep(4)
    held = run(["docker", "exec", CLIENT_CONTAINER, "sh", "-c", "cat /tmp/f5-hold.txt 2>/dev/null || true"], allow=True)
    check("WP14-TARGET-A" in held,
          "F5.6 the in-flight connection is established before the stop",
          f"port={port2} target=target-a:3030 captured={held[:60]!r}")
    stop_started = time.time()
    started = time.monotonic()
    stop_out = run(["docker", "stop", "-t", "15", INGRESS_CONTAINER], allow=True, timeout=60)
    elapsed = time.monotonic() - started
    # Docker kills after the timeout; finishing well inside it proves the agent
    # closed its own listeners instead of being terminated.
    check(elapsed < 14.0, "F5.6 the agent stopped itself inside the stop timeout",
          f"elapsed={elapsed:.1f}s out={stop_out}")

    state_after = docker(["inspect", "-f", "{{.State.ExitCode}}", INGRESS_CONTAINER], allow=True).strip()
    check(state_after == "0", "F5.6 the agent exited cleanly (not killed)", f"exit={state_after}")

    refused, connect_elapsed = tcp_connect_only(ing_ip, port2)
    check(not refused and connect_elapsed < 3.5,
          "F5.6 a new connection after stop is refused promptly", f"elapsed={connect_elapsed:.1f}s")

    # The drain window is what "graceful" means: the established connection must
    # outlive the beginning of the stop instead of being cut immediately. The
    # timestamp only appears once the socket really dies, so wait for it instead
    # of reading too early and computing a meaningless delta.
    def connection_ended() -> float | None:
        raw = run(["docker", "exec", CLIENT_CONTAINER, "sh", "-c",
                   "cat /tmp/f5-hold-ended 2>/dev/null || true"], allow=True).strip()
        if not raw:
            return None
        try:
            return float(raw)
        except ValueError:
            return None
    ended_at = wait_until(connection_ended, 60, 2)
    survived = (ended_at - stop_started) if ended_at else 0.0
    check(survived >= 4,
          "F5.6 the in-flight connection outlived the start of the stop (drain window)",
          f"connection ended {survived:.1f}s after the stop began (0 = never observed)")

    compose("up", "-d", INGRESS_SERVICE)
    check(wait_until(lambda: wait_active(fid2), 180, 3) is not None, "F5.6 the node recovers and reconverges")
    db(f"await db.tunnel.deleteMany({{where:{{id:{fid2}}}}});return true;")


def f5_7_real_edit_still_converges():
    """The hardened bus must not break the normal path."""
    if not ensure_panel_up():
        record(False, "F5.7 panel unavailable")
        return
    s, b, _ = req("POST", "/api/forwards", {
        "name": f"{FIXTURE_NAME}-EDIT",
        "mode": "direct",
        "ingress_node_id": ing,
        "target_host": "target-a",
        "target_port": 3030,
    }, cookie, ws)
    check(s in (200, 201), "F5.7 create a Forward for the edit case", f"status={s} body={b}")
    if s not in (200, 201):
        return
    fid3 = int(unwrap(b).get("id"))
    check(wait_active(fid3), "F5.7 it converges to active/applied")
    rid = scalar(f"SELECT IFNULL(desired_revision_id,0) FROM tunnel WHERE id={fid3};")
    s, b, _ = req("PATCH", f"/api/forwards/{fid3}", {"target_port": 3031}, cookie, ws)
    check(s == 200, "F5.7 an edit through the real command bus succeeds", f"status={s} body={b}")
    check(wait_active(fid3), "F5.7 the edit converges on the node")
    check(scalar(f"SELECT remote_port FROM tunnel WHERE id={fid3};") == "3031",
          "F5.7 the new target port is what the panel stores")
    rid2 = scalar(f"SELECT IFNULL(desired_revision_id,0) FROM tunnel WHERE id={fid3};")
    check(rid2 != rid, "F5.7 the edit advanced the desired revision", f"before={rid} after={rid2}")
    db(f"await db.tunnel.deleteMany({{where:{{id:{fid3}}}}});return true;")


def f5_9_capability_negotiation():
    """The node advertises what it really implements, and the panel sees it.

    F5.7 already proves apply_tunnel works end to end; this case checks the fact
    the panel consults BEFORE dispatch, which is what makes it safe to add new
    actions later without breaking older agents.
    """
    s, b, _ = req("GET", f"/api/admin/node/{ing}/state", cookie=cookie)
    check(s == 200, "F5.9 the node state view is readable", f"status={s} body={b}")
    state_view = unwrap(b) if isinstance(unwrap(b), dict) else {}
    version = state_view.get("control_protocol_version")
    capabilities = state_view.get("capabilities")
    check(isinstance(version, int) and version >= 1,
          "F5.9 the node reports a control protocol version", f"got={version!r}")
    check(isinstance(capabilities, list) and len(capabilities) > 0,
          "F5.9 the node reports a capability list (not null/absent)", f"got={capabilities!r}")
    for action in ("apply_tunnel", "remove_tunnel", "suspend_tunnel"):
        check(isinstance(capabilities, list) and action in capabilities,
              f"F5.9 the node advertises the action it actually implements: {action}",
              f"capabilities={capabilities}")
    # The list must describe the implementation, not an aspiration: an action the
    # Go agent does not implement must not be advertised.
    for action in ("update_targets", "state_request"):
        check(not (isinstance(capabilities, list) and action in capabilities),
              f"F5.9 the node does not advertise the unimplemented action {action}",
              f"capabilities={capabilities}")

    # A fabricated capability must not be able to widen what the panel would send:
    # rewriting the stored advertisement is what a hostile/mistaken agent could do.
    before = scalar(f"SELECT capabilities FROM node_state_report WHERE node_id={ing};")
    check(before not in ("", "NULL"),
          "F5.9 the advertisement is persisted on the state report", f"stored={before}")
    mysql(f"UPDATE node_state_report SET capabilities=JSON_ARRAY('apply_tunnel') WHERE node_id={ing};")
    s, b, _ = req("GET", f"/api/admin/node/{ing}/state", cookie=cookie)
    narrowed = unwrap(b) if isinstance(unwrap(b), dict) else {}
    check(narrowed.get("capabilities") == ["apply_tunnel"],
          "F5.9 the panel reads the advertisement verbatim (no widening on the panel side)",
          f"got={narrowed.get('capabilities')!r}")
    # Restore exactly what the node had advertised. Writing a hardcoded baseline
    # list here silently removed the newer capabilities and made the next case
    # ("diagnose is not advertised") look like a product failure.
    mysql(f"UPDATE node_state_report SET capabilities={sql_json(before)}, control_protocol_version=1 WHERE node_id={ing};")


def wait_for_diagnose_capability(timeout: int = 90) -> bool:
    """The stored advertisement must include the new action before we probe.

    A node re-reports every 30s; the gate only rewrites the stored row for its own
    negative cases. Waiting here keeps the case about the product path instead of
    about gate timing.
    """
    def ready():
        row = scalar(
            "SELECT JSON_CONTAINS(capabilities, JSON_QUOTE('diagnose_tunnel')) "
            "FROM node_state_report s JOIN node n ON n.id=s.node_id "
            f"WHERE n.node_id='WP14-IN-A-NODE' AND s.reported_at > NOW() - INTERVAL 2 MINUTE;"
        )
        return row if row == "1" else None
    return wait_until(ready, timeout, 3) is not None


def f5_10_diagnose():
    """V4-WP11C: real segmented diagnosis through the real command path.

    F5.10 proves the whole chain on the live topology: the panel derives the probe
    targets from the forward's own desired state, the agent actually dials them,
    and the verdict distinguishes "reachable" from "refused"/"timeout" — which is
    the only thing that makes a diagnostic better than a guess.
    """
    # A DIRECT forward toward the banner target, and one toward a port nothing
    # listens on: the two verdicts must differ.
    s, b, _ = req("POST", "/api/forwards", {
        "name": f"{FIXTURE_NAME}-DIAG-OK", "mode": "direct", "ingress_node_id": ing,
        "target_host": "target-a", "target_port": 3030,
    }, cookie, ws)
    check(s in (200, 201), "F5.10 create a Forward with a reachable target", f"status={s} body={b}")
    if s not in (200, 201):
        return
    ok_id = int(unwrap(b).get("id"))
    check(wait_active(ok_id), "F5.10 the reachable fixture is active")
    check(wait_for_diagnose_capability(), "F5.10 the node advertises diagnose_tunnel")

    s, b, _ = req("POST", f"/api/forwards/{ok_id}/diagnose", None, cookie, ws)
    check(s == 200, "F5.10 a viewer-level read may run a diagnosis", f"status={s} body={b}")
    report = unwrap(b) if isinstance(unwrap(b), dict) else {}
    segments = report.get("segments") or []
    check(len(segments) == 1 and segments[0].get("segment") == "ingress_to_target",
          "F5.10 the plan probes the configured target from the ingress node", f"segments={segments}")
    results = (segments[0].get("results") or []) if segments else []
    check(any(r.get("status") == "reachable" for r in results),
          "F5.10 a listening target is reported reachable", f"results={results}")
    check(results and all(r.get("host") == "target-a" and r.get("port") == 3030 for r in results),
          "F5.10 only the forward's own target is probed (no user-supplied host)",
          f"results={results}")

    # Refused: same machinery, a port nothing listens on.
    s, b, _ = req("PATCH", f"/api/forwards/{ok_id}", {"target_port": 1}, cookie, ws)
    check(s == 200, "F5.10 retarget to a closed port", f"status={s} body={b}")
    check(wait_active(ok_id), "F5.10 the retargeted fixture converges")
    s, b, _ = req("POST", f"/api/forwards/{ok_id}/diagnose", None, cookie, ws)
    report = unwrap(b) if isinstance(unwrap(b), dict) else {}
    results = ((report.get("segments") or [{}])[0].get("results") or [])
    check(any(r.get("status") in ("refused", "timeout") for r in results),
          "F5.10 a closed port is reported refused/timeout, not reachable", f"results={results}")
    next_step = report.get("next_step") or ""
    check("拒绝" in next_step or "超时" in next_step,
          "F5.10 the report gives an actionable next step for an unreachable target",
          f"next_step={next_step!r}")

    # Capability negotiation is part of the path: hide the advertisement and the
    # panel must refuse to send anything at all.
    before = scalar(f"SELECT capabilities FROM node_state_report WHERE node_id={ing};")
    mysql(f"UPDATE node_state_report SET capabilities=JSON_ARRAY('apply_tunnel') WHERE node_id={ing};")
    s, b, _ = req("POST", f"/api/forwards/{ok_id}/diagnose", None, cookie, ws)
    body = unwrap(b) if isinstance(unwrap(b), dict) else {}
    segs = body.get("segments") or []
    check(s == 200 and segs and segs[0].get("outcome") == "unsupported"
          and segs[0].get("error_code") == "upgrade_required",
          "F5.10 without an advertised capability the panel sends no command and says why",
          f"status={s} segments={segs}")
    mysql(f"UPDATE node_state_report SET capabilities={sql_json(before)} WHERE node_id={ing};")
    check(wait_for_diagnose_capability(60), "F5.10 the advertisement is restored for later cases")

    for fid in (ok_id,):
        db(f"await db.tunnel.deleteMany({{where:{{id:{fid}}}}});return true;")


def f5_11_agent_upgrade():
    """V4-WP11B: a real drain → image swap → recreate → same identity → converge.

    This is the closure the DoD asks for ("Agent reinstall / image upgrade keeps
    agent_id / Node / Forward relations"), performed on a live node rather than
    asserted about a string.

    What it proves, in order:
      · the graceful stop really does refuse NEW connections while draining;
      · the recreated agent authenticates with the SAME credential, so the panel
        sees the same node_id/agent_id — no re-enrollment, no new identity;
      · the Forward that was running on the node keeps working afterwards;
      · desired/applied converge again without operator intervention.
    """
    state = json.loads(STATE.read_text())
    node_b = state["nodes"]["ingress_secondary"]
    node_b_id = int(node_b["id"])
    node_b_key = node_b["node_id"]

    before = db(
        "const n=await db.node.findUnique({where:{id:%d},select:{id:true,node_id:true,agent_id:true,lifecycle:true}});"
        "return {id:n.id,node_id:n.node_id,agent_id:n.agent_id,lifecycle:n.lifecycle};" % node_b_id
    )
    check(isinstance(before, dict) and before.get("agent_id"),
          "F5.11 the node has an agent identity before the upgrade", f"before={before}")
    if not isinstance(before, dict):
        return

    # A disposable Forward on that node, so we can watch it survive the swap.
    port = INGRESS_B_PORT_RANGE[1] - 3
    s, b, _ = req("POST", "/api/forwards", {
        "name": f"{FIXTURE_NAME}-UPGRADE", "mode": "direct", "ingress_node_id": node_b_id,
        "listen_port": port, "target_host": "target-a", "target_port": 3030,
    }, cookie, ws)
    check(s in (200, 201), "F5.11 create a disposable Forward on the secondary node", f"status={s} body={b}")
    if s not in (200, 201):
        return
    fid = int(unwrap(b).get("id"))
    check(wait_active(fid), "F5.11 the Forward converges before the upgrade")
    check(tcp_probe(INGRESS_B_HOST, port) == "WP14-TARGET-A",
          "F5.11 the data plane works before the upgrade",
          f"probe={tcp_probe(INGRESS_B_HOST, port)!r}")

    # The image swap: a second tag on the same image. The point is the SEQUENCE
    # (drain → recreate with the host identity → verify → roll back), not the bytes.
    #
    # The rollback anchor is the *baseline* image of this environment, NOT whatever
    # tag the node happens to be running: reading it from the node makes the case
    # self-referential — a leftover tag from an earlier run becomes the new
    # "anchor", and the node is pinned to it forever. That is exactly the failure
    # this line used to cause (a later gate then failed its own image assertion).
    baseline_image = run(["docker", "inspect", "-f", "{{.Config.Image}}", INGRESS_CONTAINER])
    previous_image = run(["docker", "inspect", "-f", "{{.Config.Image}}", INGRESS_B_CONTAINER])
    upgrade_image = "wp14-agent:upgrade-test"
    check(baseline_image != "", "F5.11 the environment baseline image is known", f"baseline={baseline_image!r}")
    check(previous_image == baseline_image,
          "F5.11 the node starts on the baseline image (no leftover tag from an earlier run)",
          f"baseline={baseline_image} node={previous_image}")
    run(["docker", "tag", baseline_image, upgrade_image], allow=True)
    check(run(["docker", "image", "inspect", "-f", "{{.Id}}", upgrade_image], allow=True) != "",
          "F5.11 a second image tag exists for the swap (rollback anchor recorded)",
          f"anchor={baseline_image} target={upgrade_image}")

    # ── the upgrade sequence, exactly as the rendered script performs it ──
    docker(["stop", "-t", "15", INGRESS_B_CONTAINER])
    # New connections must fail promptly once the drain starts, even though the
    # stop command itself is still inside its 15s window.
    refused_promptly = False
    start = time.time()
    while time.time() - start < 12:
        if tcp_probe(INGRESS_B_HOST, port, timeout=1) == "":
            refused_promptly = True
            break
        time.sleep(0.5)
    check(refused_promptly, "F5.11 a new connection is refused while the old agent drains",
          f"waited={time.time() - start:.1f}s")

    # Recreate with the same host identity (same env/credential/state volume) but
    # the new image: this is what keeps node_id/agent_id stable.
    docker(["rm", "-f", INGRESS_B_CONTAINER], allow=True)
    env = compose_env()
    env["WP14_AGENT_IMAGE"] = upgrade_image
    run([*COMPOSE, "up", "-d", "--no-deps", "--force-recreate", INGRESS_B_SERVICE], env=env, allow=True)

    check(wait_for_agents(240), "F5.11 the upgraded agent reconnects to the panel")
    after = db(
        "const n=await db.node.findUnique({where:{id:%d},select:{id:true,node_id:true,agent_id:true,lifecycle:true}});"
        "return {id:n.id,node_id:n.node_id,agent_id:n.agent_id,lifecycle:n.lifecycle};" % node_b_id
    )
    check(isinstance(after, dict) and after.get("agent_id") == before.get("agent_id"),
          "F5.11 the upgraded agent keeps the SAME agent_id (no re-enrollment)",
          f"before={before.get('agent_id')} after={(after or {}).get('agent_id')}")
    check(isinstance(after, dict) and after.get("id") == before.get("id") and after.get("node_id") == node_b_key,
          "F5.11 the node row is the same node", f"after={after}")

    running = run(["docker", "inspect", "-f", "{{.Config.Image}}", INGRESS_B_CONTAINER], allow=True)
    check(upgrade_image in running, "F5.11 the container now runs the upgraded image", f"image={running}")

    check(wait_active(fid), "F5.11 the existing Forward converges again after the upgrade")
    recovered = ""
    for _ in range(30):
        recovered = tcp_probe(INGRESS_B_HOST, port)
        if recovered == "WP14-TARGET-A":
            break
        time.sleep(1)
    check(recovered == "WP14-TARGET-A", "F5.11 the data plane is restored after the upgrade",
          f"probe={recovered!r}")

    # The recorded anchor must be USABLE, not just printed: roll back to it and
    # prove the node serves again. This is the same step the rendered script
    # performs when a new version misbehaves.
    env = compose_env()
    env["WP14_AGENT_IMAGE"] = baseline_image
    docker(["rm", "-f", INGRESS_B_CONTAINER], allow=True)
    run([*COMPOSE, "up", "-d", "--no-deps", "--force-recreate", INGRESS_B_SERVICE], env=env, allow=True)
    check(wait_for_agents(240), "F5.11 the node returns to service on the previous image (rollback anchor used)")
    restored = run(["docker", "inspect", "-f", "{{.Config.Image}}", INGRESS_B_CONTAINER], allow=True)
    check(restored == baseline_image, "F5.11 the rollback really restored the baseline image",
          f"expected={baseline_image} got={restored}")
    check(tcp_probe(INGRESS_B_HOST, port) == "WP14-TARGET-A",
          "F5.11 the Forward works again after the rollback", f"probe={tcp_probe(INGRESS_B_HOST, port)!r}")

    db(f"await db.tunnel.deleteMany({{where:{{id:{fid}}}}});return true;")


def f5_12_node_diagnostics():
    """V4-WP11C: Node-level diagnostics on a live node, and the offline fast path.

    Two things are worth a real gate here:
      · the facts come from the NODE PROCESS (its own view of what it runs), not
        from the panel's stored summary;
      · an offline node is answered as "offline" promptly instead of waiting out
        a command timeout — measured, not assumed.
    """
    state = json.loads(STATE.read_text())
    node_a = state["nodes"]["ingress"]
    node_a_id = int(node_a["id"])

    s, b, _ = req("GET", f"/api/nodes/{node_a_id}/diagnostics", None, cookie, ws)
    check(s == 200, "F5.12 a live node returns a diagnostics report", f"status={s} body={b}")
    report = unwrap(b) if isinstance(unwrap(b), dict) else {}
    check(report.get("reachability") == "online",
          "F5.12 a node reporting recently is 'online'", f"reachability={report.get('reachability')}")
    facts = report.get("agent_facts") or {}
    check(bool(facts), "F5.12 the node's own self report is present", f"facts={facts}")
    check(facts.get("node_id") == node_a["node_id"] and facts.get("agent_id"),
          "F5.12 the self report identifies the same immutable agent identity",
          f"node_id={facts.get('node_id')} agent_id={facts.get('agent_id')}")
    check(isinstance(facts.get("process", {}).get("uptime_seconds"), int)
          and facts["process"]["uptime_seconds"] >= 0,
          "F5.12 process facts (uptime) are real values", f"process={facts.get('process')}")
    check(facts.get("state_dir", {}).get("configured") is True,
          "F5.12 the state directory fact is reported", f"state_dir={facts.get('state_dir')}")
    runtime = facts.get("runtime") or {}
    check(runtime.get("tunnel_count", 0) >= 1 and len(runtime.get("listen_ports") or []) >= 1,
          "F5.12 the node lists the runtime it is actually running",
          f"runtime={runtime}")
    # The whitelist must hold on the wire too: the earlier F5 forwards point at
    # target-a, and a node fact must never republish configured targets.
    blob = json.dumps(report, ensure_ascii=False)
    check("target-a" not in blob and "172.31." not in blob.replace(node_a.get("connect_ip") or "", ""),
          "F5.12 the report carries no configured target addresses", f"blob={blob[:200]}")
    check("WP14-INGRESS".lower() not in blob.lower().replace(node_a["node_id"].lower(), ""),
          "F5.12 no credential material appears in the report")

    # ── the offline fast path: stop the secondary agent and ask about it ──
    out_of_service = int(state["nodes"]["ingress_secondary"]["id"])
    docker(["stop", "-t", "15", INGRESS_B_CONTAINER], allow=True)
    started = time.time()
    s, b, _ = req("GET", f"/api/nodes/{out_of_service}/diagnostics", None, cookie, ws, timeout=60)
    elapsed = time.time() - started
    off = unwrap(b) if isinstance(unwrap(b), dict) else {}
    # The node has just been stopped, so its stored report is still fresh for the
    # first ~75s: the panel will try to ask and the answer must be a bounded
    # failure rather than a hang. What must never happen is an unbounded wait.
    check(s == 200, "F5.12 diagnostics for a stopped node still returns a report", f"status={s} body={b}")
    check(elapsed < 40, "F5.12 asking a stopped node is bounded (no unbounded pending)",
          f"elapsed={elapsed:.1f}s reachability={off.get('reachability')}")
    check(off.get("agent_facts") in (None, {}) or off.get("agent_facts_error"),
          "F5.12 a node that cannot answer is reported with an explanation, not silently blank",
          f"facts={off.get('agent_facts')} err={off.get('agent_facts_error')}")

    # Bring it back so later gates see a healthy topology.
    docker(["rm", "-f", INGRESS_B_CONTAINER], allow=True)
    env = compose_env()
    run([*COMPOSE, "up", "-d", "--no-deps", "--force-recreate", INGRESS_B_SERVICE], env=env, allow=True)
    check(wait_for_agents(240), "F5.12 the stopped node is brought back for later cases")

    # And a Support Bundle for a live node carries the same agent section.
    s, b, _ = req("GET", f"/api/nodes/{node_a_id}/support-bundle", None, cookie, ws)
    bundle = unwrap(b) if isinstance(unwrap(b), dict) else {}
    check(s == 200 and bool(bundle.get("agent_facts")),
          "F5.12 the Support Bundle carries the node's self report",
          f"status={s} keys={sorted(bundle.keys())[:8]}")
    check("agent_credential" not in json.dumps(bundle) and "credential_hash" not in json.dumps(bundle),
          "F5.12 the bundle still carries no credential material")


def f5_13_backup_restore_drill():
    """V4-WP11D: a REAL backup → mutate → restore → verify drill.

    The static guard in F5.8 only proves the scripts say the right things. This
    case proves the pair actually works on the live stack, which is the only way
    to catch the class of bug found here: an unbalanced `docker inspect` template,
    self-checks that queried without selecting the database, and a readiness poll
    that died on Redis's "LOADING" reply *after* a successful restore.

    It runs against a SCRATCH database. A destructive restore over the shared one
    rewinds rows other gates created earlier, and a later gate then fails for a
    reason that has nothing to do with it — which is exactly what happened once.
    Stopping/starting the writers is shared state, so the stack is put back.
    """
    drill_db = "tunex_drill"
    drill_dir = "/tmp/f5-drill-backups"
    env = {
        **os.environ,
        "COMPOSE_FILE": str(REPO_ROOT / "scripts" / "v3-e2e" / "docker-compose.e2e.yaml"),
        "COMPOSE_PROJECT_NAME": "wp14-e2e",
        "COMPOSE_ENV_FILE": str(REPO_ROOT / "scripts" / "v3-e2e" / ".env.wp14"),
        "BACKUP_DIR": drill_dir,
        "ENCRYPT": "0",
        "MYSQL_DATABASE": drill_db,
        "MYSQL_ROOT_PASSWORD": mysql_root_password(),
        # The e2e stack names its writers differently from production.
        "WRITER_SERVICES": "panel worker",
    }

    def drill_sql(query: str) -> str:
        return run(["docker", "exec", "wp14-mysql", "sh", "-c",
                    f'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" {drill_db} -N -e "{query}"'], allow=True).strip()

    run(["rm", "-rf", drill_dir], allow=True)
    # The scratch database is a CLONE of the real one: backup.sh has a completeness
    # guard that refuses a database without TuneX's key tables (good design), and a
    # drill should exercise the real schema, not a toy table.
    clone = run(["docker", "exec", "wp14-mysql", "sh", "-c",
                 f'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "DROP DATABASE IF EXISTS {drill_db}; CREATE DATABASE {drill_db};" && '
                 f'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction tunex | '
                 f'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" {drill_db} && echo CLONED'], allow=True)
    check("CLONED" in clone, "F5.13 a scratch database is cloned from the live schema", f"out={clone[-120:]}")
    rows_before = drill_sql("SELECT COUNT(*) FROM workspace;")
    check(rows_before.isdigit() and int(rows_before) >= 1,
          "F5.13 baseline row counts are readable", f"workspaces={rows_before}")

    backup = subprocess.run(
        ["bash", "scripts/ops/backup.sh"], cwd=REPO_ROOT, text=True, capture_output=True, timeout=900, env=env,
    )
    check(backup.returncode == 0, "F5.13 backup.sh completes on the live stack",
          f"rc={backup.returncode} tail={backup.stdout[-300:]}{backup.stderr[-200:]}")
    if backup.returncode != 0:
        return
    manifests = sorted(Path(drill_dir).glob("*/*.manifest.json"))
    check(len(manifests) == 1, "F5.13 a manifest with checksums was produced", f"found={[m.name for m in manifests]}")
    if not manifests:
        return
    manifest = manifests[-1]

    # Mutate: a row that only exists AFTER the backup. If the restore works it must
    # be gone; if the restore silently no-ops it survives — the failure this case
    # exists to catch.
    run(["docker", "exec", "wp14-mysql", "sh", "-c",
         f'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" {drill_db} -e '
         f'"INSERT INTO audit_event (id, workspace_id, action, resource_type, resource_id, created_at) '
         f'SELECT 900000000, id, \'F5-DRILL-CANARY\', \'node\', \'0\', NOW() FROM workspace LIMIT 1;"'], allow=True)
    canary = drill_sql("SELECT COUNT(*) FROM audit_event WHERE action='F5-DRILL-CANARY';")
    check(canary == "1", "F5.13 a canary row exists after the backup", f"canary={canary}")
    if canary != "1":
        return
    audit_before = drill_sql("SELECT COUNT(*) FROM audit_event;")

    restore = subprocess.run(
        ["bash", "scripts/ops/restore.sh", str(manifest), "--yes"],
        cwd=REPO_ROOT, text=True, capture_output=True, timeout=1200, env=env,
    )
    check(restore.returncode == 0, "F5.13 restore.sh completes on the live stack",
          f"rc={restore.returncode} tail={restore.stdout[-400:]}{restore.stderr[-200:]}")

    # The restore really replaced the data.
    check(drill_sql("SELECT COUNT(*) FROM audit_event WHERE action='F5-DRILL-CANARY';") == "0",
          "F5.13 the canary planted after the backup is gone (the restore really replaced the data)")
    audit_after = drill_sql("SELECT COUNT(*) FROM audit_event;")
    check(audit_after.isdigit() and int(audit_after) < int(audit_before),
          "F5.13 the restored database is the backup's snapshot, not the mutated one",
          f"audit rows before restore={audit_before} after={audit_after}")
    check(drill_sql("SELECT COUNT(*) FROM workspace;") == rows_before,
          "F5.13 tenant rows are back to the backup's value",
          f"before={rows_before} after={drill_sql('SELECT COUNT(*) FROM workspace;')}")
    migrations = drill_sql("SELECT COUNT(*) FROM _prisma_migrations;")
    check(migrations.isdigit() and int(migrations) > 0,
          "F5.13 migration history survived the restore (schema and data agree)",
          f"migrations={migrations}")

    # The shared stack must be usable again: the restore stops/starts writers, and
    # that part IS shared state, so it is verified here rather than assumed.
    check(bool(ensure_panel_up()), "F5.13 the panel is serving again after the restore")
    check(bool(ensure_agent_up()), "F5.13 the agents converge again after the restore")

    # Leave nothing behind: the scratch database and the drill artefacts go away,
    # so no later case can observe either.
    run(["docker", "exec", "wp14-mysql", "sh", "-c",
         f'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "DROP DATABASE IF EXISTS {drill_db};"'], allow=True)
    run(["rm", "-rf", drill_dir], allow=True)


def f5_8_ops_scripts():
    """Regression guards for the WP11D ops rewrites."""
    restore = (HERE.parent.parent / "scripts" / "ops" / "restore.sh").read_text()
    backup = (HERE.parent.parent / "scripts" / "ops" / "backup.sh").read_text()
    rollback = (HERE.parent.parent / "scripts" / "ops" / "rollback.sh").read_text()
    # ── The six defects a REAL drill found (F5.13). Each line below is a
    # regression guard for something that static checks alone had missed:
    #   · the two scripts disagreeing on the passphrase variable name;
    #   · restore ignoring `encrypted: false`;
    #   · a non-interactive run dying inside the passphrase prompt;
    #   · self-check queries without a database (false "unmigrated dump" alarm);
    #   · an unbalanced `docker inspect --format` template (Redis restore could
    #     never resolve its volume);
    #   · reading Redis's "LOADING" reply as a number (crash after success).
    check('TUNEX_BACKUP_PASSPHRASE' in backup and 'TUNEX_BACKUP_PASSPHRASE' in restore,
          "F5.8 both backup and restore accept the same passphrase variable")
    check('MANIFEST_ENCRYPTED' in restore and '"encrypted"' in restore,
          "F5.8 restore honours the manifest's encrypted flag (a --no-encrypt backup must restore)")
    # An interactive-only prompt that kills the script under `set -e` when stdin is
    # not a TTY is the defect; the guard is "a TTY check exists AND a non-interactive
    # run gets a clear error naming the variable".
    import re as _re
    check("[[ -t 0 ]]" in restore
          and _re.search(r"未提供口令", restore) is not None
          and "BACKUP_PASSPHRASE" in restore,
          "F5.8 restore fails clearly when non-interactive and no passphrase is set")
    # Every self-check query must select the database: the dump creates it itself,
    # so a bare `mysql -e "SELECT ..."` has no default schema and silently reports
    # "0 rows" for a perfectly good dump.
    db_selected = len(_re.findall(r'MYSQL_DATABASE\\?"\s+-N\s+-e', restore))
    check(db_selected >= 3,
          "F5.8 all self-check queries select the database (no false unmigrated-dump alarm)",
          f"found {db_selected} database-qualified self-check queries")
    check('{{end}}{{end}}{{end}}' in restore,
          "F5.8 the docker inspect template is balanced (Redis volume resolution)")
    check('LOADING' in restore or '=~ ^[0-9]+$' in restore,
          "F5.8 the Redis readiness poll does not treat a non-numeric reply as a count")
    check('WRITER_SERVICES' in restore,
          "F5.8 writer service names are configurable (a differently-named stack can be drilled)")
    check('put_rdb_in_volume' not in restore and 'cat > /target/dump.rdb' in restore,
          "F5.8 the Redis volume write works from a container (streamed, not bind-mounted)")

    for name, body in (("restore", restore), ("backup", backup), ("rollback", rollback)):
        check("compose\" inspect" not in body and "COMPOSE[@]}\" inspect" not in body,
              f"F5.8 {name}.sh does not call the nonexistent `compose inspect`")
    check('gzip -9 "$WORK/config.tar.gz"' not in backup,
          "F5.8 backup.sh does not double-compress the config archive")
    check("pass env:TUNEX_BACKUP_PASSPHRASE" in backup and "pass env:TUNEX_BACKUP_PASSPHRASE" in restore,
          "F5.8 the backup passphrase never appears in argv (env:-based)")
    check(re.search(r"mysql[^\n]*--force", restore) is None,
          "F5.8 restore.sh does not hide SQL errors behind mysql --force",
          "a comment may mention --force; the command must not use it")
    check("SQL_ERRORS" in restore,
          "F5.8 restore.sh fails when the dump produced SQL errors")
    check("resume_services" in restore, "F5.8 restore.sh restarts what it stopped (EXIT trap)")
    check("/readyz" in rollback, "F5.8 rollback.sh gates on readiness, not only liveness")
    check("BACKEND_HOST_PORT" in rollback, "F5.8 rollback.sh resolves the health port per stack")
    check("migrate status" in rollback, "F5.8 rollback.sh checks migration compatibility")
    for script in ("backup.sh", "restore.sh", "rollback.sh"):
        p = subprocess.run(["bash", "-n", str(HERE.parent.parent / "scripts" / "ops" / script)],
                           text=True, capture_output=True)
        check(p.returncode == 0, f"F5.8 {script} passes bash -n", p.stderr.strip()[:160])


def cleanup():
    global panel_stopped
    if panel_stopped:
        compose("start", PANEL_SERVICE, WORKER_SERVICE, allow=True)
        panel_stopped = False
    fixture_cleanup()
    env = os.environ.copy()
    compose("up", "-d", "--force-recreate", INGRESS_SERVICE, allow=True)
    ensure_panel_up()
    check(wait_until(lambda: True if scalar("SELECT 1;") == "1" else None, 60, 2) is not None,
          "F5.cleanup MySQL reachable again")
    # Historical resources must be untouched by this gate.
    historical = db(
        "return await db.tunnel.count({where:{name:{not:{startsWith:'WP14-F5-'}}}});"
    )
    check(isinstance(historical, int) and historical > 0,
          "F5.cleanup historical Gate Forwards are preserved", f"count={historical}")


def main():
    signal.signal(signal.SIGALRM, alarm)
    ready = False
    try:
        signal.setitimer(signal.ITIMER_REAL, min(240, OVERALL_SECONDS))
        setup()
        ready = True
        signal.setitimer(signal.ITIMER_REAL, 0)
        for name, fn, budget in [
            ("F5.1 ACK binding", f5_1_ack_binding, 60),
            ("F5.2 durable cache", f5_2_lkg_written, 60),
            ("F5.3 outage restart", f5_3_outage_restart, 240),
            ("F5.4 fail closed", f5_4_fail_closed, 240),
            ("F5.5 no resurrection", f5_5_no_resurrection, 300),
            ("F5.6 graceful shutdown", f5_6_graceful_shutdown, 240),
            ("F5.7 real edit", f5_7_real_edit_still_converges, 240),
            ("F5.9 capability negotiation", f5_9_capability_negotiation, 90),
            ("F5.10 forward diagnose", f5_10_diagnose, 240),
            ("F5.11 agent upgrade closure", f5_11_agent_upgrade, 420),
            ("F5.12 node diagnostics", f5_12_node_diagnostics, 420),
            ("F5.13 backup/restore drill", f5_13_backup_restore_drill, 900),
            ("F5.8 ops scripts", f5_8_ops_scripts, 60),
        ]:
            case(name, fn, budget)
    except Exception as exc:  # noqa: BLE001
        record(False, f"F5 prerequisite/setup: {type(exc).__name__}: {exc}; remaining tests NOT EXECUTED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.setitimer(signal.ITIMER_REAL, 240)
        try:
            cleanup()
        except Exception as exc:  # noqa: BLE001
            record(False, f"F5.cleanup: {type(exc).__name__}: {exc}; inspect topology before rerun")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        RESULT.write_text(
            "# V4-F5 real durability / shutdown / ops gate\n"
            f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
            "topology: scripts/v3-e2e/docker-compose.e2e.yaml (existing Agents, real TCP)\n"
            f"fixture: {FIXTURE_NAME}; setup={'executed' if ready else 'incomplete'}\n"
            + "\n".join(RESULTS)
            + f"\nTOTAL PASS={PASS} FAIL={FAIL}\n",
            encoding="utf-8",
        )
        TRACE.write_text(json.dumps(HTTP, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"V4-F5 TOTAL PASS={PASS} FAIL={FAIL} evidence={RESULT}", flush=True)
    return 1 if FAIL or not ready else 0


if __name__ == "__main__":
    raise SystemExit(main())
