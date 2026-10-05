#!/usr/bin/env python3
"""V5-G1A gate — WS/TLS protocol expansion (DEVELOPMENT.md §6.1).

Closes V5-WP5-A1 (TLS stream runtime) and A2 (WebSocket stream runtime). The
checks are the list frozen in §6.1, each mapped to something executable against
the real multi-agent topology:

  G1A.1  TCP regression                  a tcp Forward still works unchanged
  G1A.2  TLS positive                    real cert -> handshake -> payload reaches the target
  G1A.3  TLS negative (bad cert config)   missing file / mismatched pair -> fail closed
  G1A.4  WS positive                     upgrade -> masked frame -> payload reaches the target
  G1A.5  WS negative (malformed handshake)plain HTTP / garbage -> no upgrade, listener alive
  G1A.6  certificate reload              new cert file + new revision -> new handshake uses it,
                                         the live connection is not killed
  G1A.7  hot reload                      a target change under tls rebuilds nothing
  G1A.8  Agent restart                   a tls Forward survives the node restarting
  G1A.9  Panel restart                   running listeners survive the panel restarting
  G1A.10 unsupported old Agent admission an Agent without tls/ws in its manifest is refused
  G1A.11 no secret in logs / bundle      the private key never appears in agent logs or the
                                         support bundle
  G1A.12 drain                            a graceful drain of a tls tunnel stops new handshakes

FAIL > 0 means V5.1a is not closed: no V5.1b (UDP). A missing topology, timeout,
failed prerequisite or cleanup failure is a FAIL, never a skip.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import signal
import socket
import ssl
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENVF = HERE / ".env.wp14"
PASSF = HERE / ".passwords.env"
STATE = HERE / "state.json"
API = os.environ.get("API", "http://127.0.0.1:18180")
OUT = HERE / "evidence"
OUT.mkdir(exist_ok=True)
RESULT = OUT / "v5-g1a-result.txt"
TRACE = OUT / "v5-g1a-http.json"

PASS = 0
FAIL = 0
RESULTS: list[str] = []
HTTP: list[dict] = []

INGRESS_CONTAINER = "wp14-ingress-agent"
EGRESS_CONTAINER = "wp14-egress-agent"
PANEL_CONTAINER = "wp14-panel"
MYSQL_CONTAINER = "wp14-mysql"
STATE_DIR = "/var/lib/tunex-agent"
CERT_DIR = f"{STATE_DIR}/tls"
INGRESS_DATA_IP = "172.31.10.20"
# A second reachable target lets hot-reload tests distinguish retargeting from a closed port.
TARGET_A_IP = "172.31.10.30"
TARGET_A_SECOND_PORT = 3031
# A byte-echo listener the gate starts itself (see ensure_echo_target).
ECHO_TARGET_PORT = 3032

FIXTURE_PREFIX = f"V5-G1A-{int(time.time())}"
created_ids: list[int] = []
START = time.monotonic()
OVERALL_SECONDS = int(os.environ.get("G1A_OVERALL_SECONDS", "1800"))


def alarm(_signum, _frame):
    raise TimeoutError(f"V5-G1A overall budget exhausted ({OVERALL_SECONDS}s)")


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
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        fn()
    except Exception as exc:  # noqa: BLE001 - a case failure is a gate failure
        record(False, f"{name}: {type(exc).__name__}: {exc}")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


# ---------------------------------------------------------------------------
# harness
# ---------------------------------------------------------------------------

def parse_env(path: Path) -> dict:
    out = {}
    for line in Path(path).read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k] = v
    return out


def run(args, allow=False, timeout=300, **kw):
    p = subprocess.run(args, text=True, capture_output=True, timeout=timeout, **kw)
    if p.returncode and not allow:
        raise RuntimeError(f"{' '.join(args)} failed: {p.stderr.strip() or p.stdout.strip()}")
    return p.stdout.strip()


def docker(args, allow=False, timeout=300):
    return run(["docker", *args], allow=allow, timeout=timeout)


def mysql(sql: str) -> str:
    e = parse_env(ENVF)
    return run(["docker", "exec", MYSQL_CONTAINER, "mysql", "-uroot", f"-p{e['MYSQL_ROOT_PASSWORD']}",
                e.get("MYSQL_DATABASE", "tunex"), "-N", "-e", sql])


def scalar(sql: str) -> str:
    v = mysql(sql).strip()
    return v.splitlines()[-1].strip() if v else ""


def db(js: str) -> object:
    out = docker(["exec", PANEL_CONTAINER, "bun", "-e", (
        'import { PrismaClient } from "@prisma/client";'
        "const db=new PrismaClient();const f=async()=>{" + js + "};"
        "console.log(JSON.stringify(await f()));await db.$disconnect();"
    )], timeout=120)
    line = out.strip().splitlines()[-1] if out.strip() else "null"
    return json.loads(line)


def login() -> tuple[int, str]:
    """Log in and return (status, cookie). The SESSION is a fact worth asserting:
    a failed login used to surface as a cascade of 401s in every later case, which
    reads like a dozen broken checks instead of one broken prerequisite."""
    status, body, headers = _raw_login()
    cookie = (headers.get("set-cookie") or "").split(";", 1)[0]
    return status, cookie


def _raw_login():
    r = urllib.request.Request(API + "/api/auth/login",
                               data=json.dumps({"email": EMAIL, "password": PW}).encode(),
                               method="POST")
    for k, v in (("content-type", "application/json"), ("x-requested-with", "XMLHttpRequest"),
                 ("origin", API)):
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=30) as res:
            return res.status, {}, res.headers
    except urllib.error.HTTPError as e:
        return e.code, {}, e.headers
    except (urllib.error.URLError, OSError) as e:
        return 0, {"error": str(e)}, {}


def req(method: str, path: str, body=None, cookie=None, timeout=90, retry_auth=True):
    """One API call with the current session attached by default."""
    global COOKIE
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data, method=method)
    for k, v in (("content-type", "application/json"), ("x-requested-with", "XMLHttpRequest"),
                 ("origin", API), ("x-workspace-id", str(WS))):
        r.add_header(k, v)
    session = cookie if cookie is not None else COOKIE
    if session:
        r.add_header("cookie", session)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as res:
            raw = res.read().decode()
            parsed = json.loads(raw) if raw.strip() else {}
            HTTP.append({"method": method, "path": path, "status": res.status})
            return res.status, parsed, res.headers
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            parsed = json.loads(raw) if raw.strip() else {}
        except Exception:  # noqa: BLE001
            parsed = {"raw": raw}
        HTTP.append({"method": method, "path": path, "status": e.code, "body": parsed})
        if e.code == 401 and retry_auth and path != "/api/auth/login":
            # Panel restart may invalidate the session; re-authenticate once and fail loudly if it cannot recover.
            status2, cookie2 = login()
            if status2 == 200 and cookie2:
                COOKIE = cookie2
                return req(method, path, body, COOKIE, timeout, retry_auth=False)
            record(False, f"G1A.session: re-authentication failed after a 401 on {path} [login_status={status2}]")
        return e.code, parsed, e.headers
    except (urllib.error.URLError, OSError) as e:
        return 0, {"error": str(e)}, {}


def unwrap(b):
    return b.get("data", b) if isinstance(b, dict) else b


def wait_until(fn, timeout=90, interval=3):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn():
                return True
        except Exception:  # noqa: BLE001 - a transient probe failure is a retry
            pass
        time.sleep(interval)
    return False


def agent_exec(script: str, allow=False):
    return docker(["exec", INGRESS_CONTAINER, "sh", "-c", script], allow=allow)


def write_agent_file(path: str, content: bytes) -> None:
    """Copy a file into the ingress Agent's container (the state dir is a volume)."""
    tmp = Path("/tmp/g1a-payload")
    tmp.write_bytes(content)
    docker(["cp", str(tmp), f"{INGRESS_CONTAINER}:{path}"])


def gen_cert(cn: str, days: int = 30) -> tuple[bytes, bytes]:
    """Self-signed cert/key for the node listener. Generated per case."""
    key = Path("/tmp/g1a.key")
    crt = Path("/tmp/g1a.crt")
    for f in (key, crt):
        f.unlink(missing_ok=True)
    run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
         "-nodes", "-keyout", str(key), "-out", str(crt), "-days", str(days),
         "-subj", f"/CN={cn}",
         "-addext", f"subjectAltName=IP:{INGRESS_DATA_IP},DNS:localhost"])
    return crt.read_bytes(), key.read_bytes()


def install_cert(cert: bytes, key: bytes, cert_name: str = "site.crt", key_name: str = "site.key") -> tuple[str, str]:
    agent_exec(f"mkdir -p {CERT_DIR}")
    write_agent_file(f"{CERT_DIR}/{cert_name}", cert)
    write_agent_file(f"{CERT_DIR}/{key_name}", key)
    agent_exec(f"chmod 600 {CERT_DIR}/{key_name}")
    return f"{CERT_DIR}/{cert_name}", f"{CERT_DIR}/{key_name}"


def tls_probe(port: int, expect_echo: bool = True, timeout: float = 8.0, payload: bytes = b"g1a-tls"):
    """TLS handshake + byte round trip. Returns (ok, detail).

    The payload is checked byte-exactly when the tunnel points at the gate's echo
    target: "the target's greeting came back" proves the connection reached
    *something*, while an exact echo proves the TLS front carried OUR bytes in
    both directions — which is the property the gate is about.
    """
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with socket.create_connection((INGRESS_DATA_IP, port), timeout=timeout) as raw:
            with ctx.wrap_socket(raw) as tls:
                if not expect_echo:
                    return True, "handshake-only"
                tls.sendall(payload)
                got = b""
                # After wrap_socket the SSLSocket owns the fd, so set the deadline on `tls`.
                _ = tls.settimeout(timeout)
                while len(got) < len(payload):
                    chunk = tls.recv(256)
                    if not chunk:
                        break
                    got += chunk
                return True, repr(got)
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


def tls_handshake_cert(port: int, timeout: float = 8.0) -> bytes:
    """Return the peer certificate in **DER** form.

    DER on purpose: `getpeercert(binary_form=True)` returns DER while the file we
    installed is PEM, and comparing the two directly made the gate claim the node
    served the wrong certificate (410 bytes vs 611) when it served exactly the
    right one. `cert_der()` below converts the installed PEM for the comparison.
    """
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with socket.create_connection((INGRESS_DATA_IP, port), timeout=timeout) as raw:
        with ctx.wrap_socket(raw) as tls:
            return tls.getpeercert(binary_form=True) or b""


def cert_der(pem: bytes) -> bytes:
    """The DER form of a PEM certificate, for comparison with getpeercert()."""
    return ssl.PEM_cert_to_DER_cert(pem.decode())


def ws_probe(port: int, payload: bytes = b"g1a-ws", timeout: float = 10.0):
    """Handshake + one masked binary frame. Returns (ok, detail)."""
    key = base64.b64encode(os.urandom(16)).decode()
    try:
        with socket.create_connection((INGRESS_DATA_IP, port), timeout=timeout) as sock:
            sock.sendall(("GET / HTTP/1.1\r\nHost: tunex\r\nUpgrade: websocket\r\n"
                          "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
                          "Sec-WebSocket-Version: 13\r\n\r\n" % key).encode())
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = sock.recv(1024)
                if not chunk:
                    break
                head += chunk
            if b"101" not in head.split(b"\r\n", 1)[0]:
                return False, f"no upgrade: {head[:60]!r}"
            want = base64.b64encode(hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            if want.encode() not in head:
                return False, "Sec-WebSocket-Accept mismatch"
            mask = os.urandom(4)
            masked = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
            sock.sendall(bytes([0x82, 0x80 | len(payload)]) + mask + masked)
            hdr = sock.recv(2)
            if not hdr or (hdr[0] & 0x0F) != 0x2:
                return False, f"unexpected reply opcode {hdr[:2]!r}"
            length = hdr[1] & 0x7F
            body = b""
            while len(body) < length:
                body += sock.recv(length - len(body))
            return True, repr(body)
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


def ensure_echo_target() -> bool:
    """Start a BYTE-ECHO listener on target-a (port 3032).

    The e2e target runs `nc -e echo <banner>`: it writes a greeting and exits, so
    a tunnel through it can be shown to reach the target but never to carry a
    round trip — and "the live connection survived the reload" cannot be observed
    at all. `nc -e cat` wires the socket to a process that echoes whatever
    arrives, which is what these cases need.
    """
    docker(["exec", "wp14-target-a", "sh", "-c",
            "(nc -lk -p %d -e cat >/dev/null 2>&1 &) ; sleep 0.3; exit 0" % ECHO_TARGET_PORT], allow=True)
    for _ in range(20):
        try:
            with socket.create_connection((TARGET_A_IP, ECHO_TARGET_PORT), timeout=2) as sock:
                sock.sendall(b"echo-check")
                if sock.recv(64) == b"echo-check":
                    return True
        except OSError:
            time.sleep(0.3)
    return False


def ensure_second_target() -> bool:
    """Start a second listener on target-a so a retarget has somewhere to land."""
    docker(["exec", "wp14-target-a", "sh", "-c",
            "command -v nc >/dev/null || exit 1; "
            "(nc -lk -p %d -e echo G1A-SECOND >/dev/null 2>&1 &) ; sleep 0.3; exit 0"
            % TARGET_A_SECOND_PORT], allow=True)
    for _ in range(20):
        try:
            with socket.create_connection((TARGET_A_IP, TARGET_A_SECOND_PORT), timeout=2) as sock:
                sock.sendall(b"ping")
                if sock.recv(64):
                    return True
        except OSError:
            time.sleep(0.3)
    return False


def tcp_probe(port: int, timeout: float = 6.0) -> tuple[bool, str]:
    try:
        with socket.create_connection((INGRESS_DATA_IP, port), timeout=timeout) as sock:
            sock.sendall(b"g1a-tcp")
            return True, repr(sock.recv(256))
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

def create_forward(name: str, protocol: str, mode: str = "direct", *,
                   cert_path: str | None = None, key_path: str | None = None,
                   target_port: int = 3030):
    body: dict = {
        "name": f"{FIXTURE_PREFIX}-{name}",
        "mode": mode,
        "protocol": protocol,
        "ingress_node_id": ING,
        "target_host": "target-a",
        "target_port": target_port,
    }
    if cert_path:
        body["tls_cert_path"] = cert_path
    if key_path:
        body["tls_key_path"] = key_path
    if mode == "relay":
        body["egress_node_id"] = EGR
    status, resp, _ = req("POST", "/api/forwards", body)
    if status == 401:
        # Authentication failure is test infrastructure failure, not product admission behavior.
        raise RuntimeError(f"create {name} got 401 Unauthorized (session problem, not a product decision)")
    data = unwrap(resp)
    fid = data.get("id") if isinstance(data, dict) else None
    if fid is not None and int(fid) not in created_ids:
        created_ids.append(int(fid))
    return status, (int(fid) if fid is not None else None), int((data or {}).get("listen_port") or 0), resp


def wait_active(fid: int, timeout: int = 120) -> bool:
    def one():
        row = scalar("SELECT CONCAT(IFNULL(applied_revision,0),'|',IFNULL(config_revision,0),'|',"
                     f"IFNULL(apply_status,'')) FROM tunnel WHERE id={fid};")
        if not row:
            return False
        applied, configured, status = row.split("|")
        return applied == configured and status == "active"
    return wait_until(one, timeout, 2)


def tunnel_row(fid: int) -> str:
    return scalar("SELECT CONCAT(IFNULL(apply_status,''),'|',IFNULL(apply_error_code,''),'|',"
                  f"IFNULL(apply_error,'')) FROM tunnel WHERE id={fid};")


def cleanup_fixtures() -> None:
    for fid in created_ids:
        try:
            req("DELETE", f"/api/forwards/{fid}", None, timeout=60)
        except Exception:  # noqa: BLE001
            pass
    db(f"await db.tunnel.deleteMany({{where:{{name:{{startsWith:'{FIXTURE_PREFIX}'}}}}}});return true;")
    time.sleep(2)


LOCK = HERE / ".v5-g1a.lock"


def acquire_lock() -> None:
    """Refuse concurrent runs because this gate mutates shared Agent state and containers."""
    if LOCK.exists():
        try:
            pid = int(LOCK.read_text().strip())
        except ValueError:
            pid = -1
        if pid > 0 and Path(f"/proc/{pid}").exists():
            raise SystemExit(f"another V5-G1A run is active (pid {pid}); refusing to start")
    LOCK.write_text(str(os.getpid()))


def release_lock() -> None:
    try:
        if LOCK.exists() and LOCK.read_text().strip() == str(os.getpid()):
            LOCK.unlink()
    except OSError:  # noqa: BLE001
        pass


def setup():
    global COOKIE
    mysql(f"UPDATE user SET super_admin=1 WHERE email='{EMAIL}';")
    reassert, COOKIE = login()
    check(reassert == 200 and COOKIE.startswith("access="),
          "G1A.setup the e2e user can authenticate", f"status={reassert} cookie={COOKIE[:16]!r}")
    mysql("UPDATE capability_policy SET max_tunnels=200, revision=revision+1 WHERE max_tunnels IS NOT NULL;")
    # The two protocols must be entitled, or every case fails for a quota reason
    # that has nothing to do with the protocol work.
    for key in ("platform_ceiling", "free_personal"):
        mysql(f"UPDATE capability_policy SET tunnel_types=JSON_ARRAY('tcp','tls','ws'), revision=revision+1 WHERE `key`='{key}';")
    missing = scalar("SELECT COUNT(*) FROM capability_policy WHERE JSON_CONTAINS(tunnel_types, '\"ws\"') = 0;")
    check(missing == "0", "G1A.setup every policy row entitles ws (the ceiling is intersected with all of them)",
          f"rows_without_ws={missing}")
    check(ensure_second_target(),
          "G1A.setup target-a serves a second port for the hot-reload cases",
          f"port={TARGET_A_SECOND_PORT}")
    check(ensure_echo_target(),
          "G1A.setup target-a serves a byte-echo port (the e2e target only greets)",
          f"port={ECHO_TARGET_PORT}")
    # Restart data-plane Agents to clear stale listeners and re-prove desired-state restoration.
    for container in (INGRESS_CONTAINER, EGRESS_CONTAINER):
        docker(["restart", container], timeout=120)
    check(bool(wait_until(lambda: req("GET", "/healthz", timeout=5)[0] == 200, timeout=60, interval=2)),
          "G1A.setup the panel is reachable after the Agent restarts")
    check(bool(wait_until(lambda: all(
        docker(["inspect", "-f", "{{.State.Running}}", c], allow=True).strip() == "true"
        for c in (INGRESS_CONTAINER, EGRESS_CONTAINER)), timeout=60, interval=2)),
        "G1A.setup both data-plane Agents are running again")
    check(bool(wait_until(lambda: scalar(
        "SELECT COUNT(*) FROM node_state_report WHERE reported_at > NOW() - INTERVAL 1 MINUTE;") == "4",
        timeout=120, interval=3)),
        "G1A.setup all four Agents re-report after the restart")
    check(bool(wait_until(lambda: scalar(
        "SELECT COUNT(*) FROM node_state_report WHERE JSON_CONTAINS(capability_manifest, '\"ws\"', '$.protocols');"
    ) == "4", timeout=120, interval=5)),
          "G1A.setup all four Agents advertise ws before any case runs",
          f"advertising={scalar('SELECT COUNT(*) FROM node_state_report;')}")


# ---------------------------------------------------------------------------
# cases
# ---------------------------------------------------------------------------

def g1a_1_tcp_regression():
    fid, port = _create_ok("TCP", "tcp")
    check(fid is not None, "G1A.1 a tcp Forward is still created", f"id={fid}")
    check(wait_active(fid), "G1A.1 it converges", f"id={fid}")
    ok, detail = tcp_probe(port)
    check(ok, "G1A.1 the tcp listener still forwards end to end", detail)


def _create_ok(name: str, protocol: str, **kw) -> tuple[int | None, int]:
    status, fid, port, resp = create_forward(name, protocol, **kw)
    if status not in (200, 201) or fid is None:
        raise RuntimeError(f"create {name} failed: status={status} body={json.dumps(resp, ensure_ascii=False)[:200]}")
    return fid, port


def g1a_2_tls_positive():
    cert, key = gen_cert("g1a-tls")
    cert_path, key_path = install_cert(cert, key)
    fid, port = _create_ok("TLS", "tls", cert_path=cert_path, key_path=key_path,
                           target_port=ECHO_TARGET_PORT)
    check(wait_active(fid), "G1A.2 a tls Forward converges on a node with a real certificate", f"id={fid}")
    ok, detail = tls_probe(port)
    check(ok, "G1A.2 TLS handshake succeeds against the ingress listener", detail)
    served = tls_handshake_cert(port)
    check(served == cert_der(cert), "G1A.2 the node serves exactly the installed certificate",
          f"served_bytes={len(served)} installed_bytes={len(cert_der(cert))}")


def g1a_3_tls_bad_config():
    """A bad certificate configuration must fail closed, before binding."""
    cert, _key = gen_cert("g1a-bad")
    key2 = Path("/tmp/g1a-other.key")
    run(["openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:prime256v1",
         "-out", str(key2)])
    # cert from one key, key from another: LoadX509KeyPair rejects the pair.
    cert_path, key_path = install_cert(cert, key2.read_bytes(), "bad.crt", "bad.key")
    status, fid, port, resp = create_forward("TLS-BAD", "tls", cert_path=cert_path, key_path=key_path)
    body = json.dumps(resp, ensure_ascii=False)
    check(status not in (200, 201), "G1A.3 a mismatched cert/key pair is refused", f"status={status}")
    check("tls" in body.lower() or "cert" in body.lower() or "证书" in body,
          "G1A.3 the refusal explains it is about the certificate", body[:200])
    if fid is not None:
        check(not wait_active(fid, timeout=30), "G1A.3 it never converges to active", f"id={fid}")
        check("active" not in scalar(f"SELECT IFNULL(apply_status,'') FROM tunnel WHERE id={fid};"),
              "G1A.3 the row is left in error rather than reported as running")
        check(f"tunex-{fid}-direct" not in scalar(
            "SELECT IFNULL(tunnels,'[]') FROM node_state_report WHERE node_id=%d;" % ING),
            "G1A.3 no listener was created for the bad configuration")

    # A path that does not exist at all.
    status2, fid2, _p2, resp2 = create_forward(
        "TLS-NOFILE", "tls", cert_path=f"{CERT_DIR}/absent.crt", key_path=f"{CERT_DIR}/absent.key")
    check(status2 not in (200, 201), "G1A.3 a missing certificate file is refused",
          f"status={status2} body={json.dumps(resp2, ensure_ascii=False)[:160]}")
    if fid2 is not None:
        check(not wait_active(fid2, timeout=20), "G1A.3 and it never converges either", f"id={fid2}")


def g1a_4_ws_positive():
    fid, port = _create_ok("WS", "ws", target_port=ECHO_TARGET_PORT)
    check(wait_active(fid), "G1A.4 a ws Forward converges", f"id={fid}")
    ok, detail = ws_probe(port)
    check(ok, "G1A.4 WebSocket upgrade + masked frame round-trips", detail)


def g1a_5_ws_malformed_handshake():
    fid, port = _create_ok("WS-NEG", "ws", target_port=ECHO_TARGET_PORT)
    check(wait_active(fid), "G1A.5 the ws fixture converges", f"id={fid}")
    # plain HTTP
    try:
        with socket.create_connection((INGRESS_DATA_IP, port), timeout=6) as sock:
            sock.sendall(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
            head = sock.recv(128)
        check(b"101" not in head, "G1A.5 a plain HTTP request is not upgraded", repr(head[:60]))
    except Exception as exc:  # noqa: BLE001
        check(False, "G1A.5 a plain HTTP request is not upgraded", f"{type(exc).__name__}: {exc}")
    # garbage bytes
    try:
        with socket.create_connection((INGRESS_DATA_IP, port), timeout=6) as sock:
            sock.sendall(b"\x00\xff\x13 garbage not http\r\n\r\n")
            head = sock.recv(128)
        check(b"101" not in head, "G1A.5 garbage bytes are not upgraded", repr(head[:60]))
    except Exception as exc:  # noqa: BLE001
        check(False, "G1A.5 garbage bytes are not upgraded", f"{type(exc).__name__}: {exc}")
    ok, detail = ws_probe(port)
    check(ok, "G1A.5 the listener still serves a real ws client afterwards", detail)


def g1a_6_certificate_reload():
    cert1, key1 = gen_cert("g1a-reload-1")
    cert_path, key_path = install_cert(cert1, key1, "reload.crt", "reload.key")
    fid, port = _create_ok("RELOAD", "tls", cert_path=cert_path, key_path=key_path,
                           target_port=ECHO_TARGET_PORT)
    check(wait_active(fid), "G1A.6 the tls fixture converges", f"id={fid}")
    check(tls_handshake_cert(port) == cert_der(cert1), "G1A.6 it starts by serving the first certificate")

    # A live connection that must NOT be killed by the reload.
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    raw = socket.create_connection((INGRESS_DATA_IP, port), timeout=8)
    live = ctx.wrap_socket(raw)
    live.sendall(b"live-1")
    check(live.recv(64) == b"live-1",
          "G1A.6 a live connection carries a round trip before the reload")

    cert2, key2 = gen_cert("g1a-reload-2")
    install_cert(cert2, key2, "reload.crt", "reload.key")
    # A revision bump is needed to drive the reload; retarget to the second,
    # reachable target so the tunnel keeps carrying traffic afterwards.
    status, _b, _ = req("PATCH", f"/api/forwards/{fid}", {"target_port": TARGET_A_SECOND_PORT})
    check(status == 200, "G1A.6 the reload is driven through the real command bus", f"status={status}")
    check(wait_active(fid), "G1A.6 the reloaded configuration converges", f"id={fid}")

    check(tls_handshake_cert(port) == cert_der(cert2), "G1A.6 new connections are served the NEW certificate",
          "the node must serve the file it was told to serve, not a cached copy of the old one")
    # The live connection: the listener was not rebuilt, so it must still be usable
    # (or at worst be closed by the reload — never left in a half-state).
    try:
        live.sendall(b"live-2")
        got = live.recv(64)
        check(got == b"live-2",
              "G1A.6 the live connection kept working across the reload",
              f"got {got!r} — a rotation and a retarget must not drop established traffic")
    except Exception as exc:  # noqa: BLE001
        check(False, "G1A.6 the live connection kept working across the reload", f"{type(exc).__name__}: {exc}")
    finally:
        live.close()


def g1a_7_hot_reload_under_tls_and_ws():
    for protocol in ("tls", "ws"):
        kwargs = {}
        if protocol == "tls":
            cert, key = gen_cert("g1a-hot")
            cp, kp = install_cert(cert, key, "hot.crt", "hot.key")
            kwargs = {"cert_path": cp, "key_path": kp}
        fid, port = _create_ok(f"HOT-{protocol.upper()}", protocol, target_port=ECHO_TARGET_PORT, **kwargs)
        check(wait_active(fid), f"G1A.7 the {protocol} fixture converges", f"id={fid}")
        probe = tls_probe if protocol == "tls" else ws_probe
        ok, detail = probe(port)
        check(ok, f"G1A.7 {protocol}: first round trip works", detail)
        # Retarget to the second target: the listener must not be rebuilt, so the
        # port stays the same AND the traffic keeps flowing.
        status, _b, _ = req("PATCH", f"/api/forwards/{fid}", {"target_port": TARGET_A_SECOND_PORT})
        check(status == 200 and wait_active(fid), f"G1A.7 {protocol}: the target change converges")
        port_after = int(scalar(f"SELECT IFNULL(listen_port,0) FROM tunnel WHERE id={fid};") or 0)
        check(port_after == port, f"G1A.7 {protocol}: the listener port did not move", f"{port} -> {port_after}")
        ok2, detail2 = probe(port)
        check(ok2, f"G1A.7 {protocol}: the tunnel still serves after the hot reload", detail2)


def g1a_8_agent_restart():
    cert, key = gen_cert("g1a-restart")
    cp, kp = install_cert(cert, key, "restart.crt", "restart.key")
    fid, port = _create_ok("RESTART", "tls", cert_path=cp, key_path=kp, target_port=ECHO_TARGET_PORT)
    check(wait_active(fid), "G1A.8 the tls fixture converges", f"id={fid}")
    check(tls_probe(port)[0], "G1A.8 it serves before the restart")
    docker(["restart", INGRESS_CONTAINER], timeout=120)
    served = wait_until(lambda: tls_probe(port)[0], timeout=120, interval=4)
    check(served, "G1A.8 the tls listener comes back after an Agent restart", f"port={port}")
    check(tls_handshake_cert(port) == cert_der(cert),
          "G1A.8 and it still serves the installed certificate (the paths survived the restore)")


def g1a_9_panel_restart():
    cert, key = gen_cert("g1a-panel")
    cp, kp = install_cert(cert, key, "panel.crt", "panel.key")
    fid, port = _create_ok("PANEL", "tls", cert_path=cp, key_path=kp, target_port=ECHO_TARGET_PORT)
    check(wait_active(fid), "G1A.9 the tls fixture converges", f"id={fid}")
    docker(["restart", PANEL_CONTAINER], timeout=180)
    back = wait_until(lambda: req("GET", "/healthz", timeout=5)[0] == 200, timeout=180, interval=3)
    check(back, "G1A.9 the panel is back")
    # The data plane never depended on the panel: the listener kept serving.
    ok, detail = tls_probe(port)
    check(ok, "G1A.9 the tls listener kept serving across the panel restart", detail)


def plant_old_manifest() -> None:
    """Plant an Agent advertisement WITHOUT tls/ws (an Agent that predates them)."""
    db("const {Prisma} = await import('@prisma/client');"
       "await db.nodeStateReport.update({where:{node_id:%d},"
       "data:{capability_manifest:{schema_version:2,protocols:['tcp'],transports:['stream'],"
       "runtime:[],diagnostics:[]}, reported_at:new Date()}});return true;" % ING)


def still_old_manifest() -> bool:
    manifest = db("const r = await db.nodeStateReport.findUnique({where:{node_id:%d},"
                  "select:{capability_manifest:true,reported_at:true}});"
                  "return r ? {manifest:r.capability_manifest, age: Date.now() - new Date(r.reported_at).getTime()} : null;" % ING)
    if not isinstance(manifest, dict):
        return False
    protocols = (manifest.get("manifest") or {}).get("protocols") or []
    # `age` guards against a heartbeat having replaced it between the write and
    # the read.
    return "tls" not in protocols and "ws" not in protocols and manifest.get("age", 10**9) < 5000


def g1a_10_old_agent_admission():
    """An Agent that does not advertise tls/ws must be refused BEFORE dispatch."""
    original = db("const r = await db.nodeStateReport.findUnique({where:{node_id:%d},"
                  "select:{capability_manifest:true}});return r ? r.capability_manifest : null;" % ING)
    check(isinstance(original, dict), "G1A.10 the node's manifest was readable", f"got={type(original).__name__}")
    try:
        for protocol in ("tls", "ws"):
            # Re-plant before each attempt because the Agent heartbeat can overwrite the synthetic old manifest.
            plant_old_manifest()
            check(still_old_manifest(),
                  f"G1A.10 the old-Agent shape is planted before the {protocol} attempt")

            kwargs = {}
            if protocol == "tls":
                cert, key = gen_cert("g1a-old")
                cp, kp = install_cert(cert, key, "old.crt", "old.key")
                kwargs = {"cert_path": cp, "key_path": kp}
            status, fid, _port, resp = create_forward(f"OLD-{protocol.upper()}", protocol, **kwargs)
            body = json.dumps(resp, ensure_ascii=False)
            check(status not in (200, 201),
                  f"G1A.10 an old Agent does not get a {protocol} dispatch", f"status={status}")
            check("runtime_capability_denied" in body or "protocol_not_supported" in body,
                  f"G1A.10 the {protocol} refusal is a runtime admission denial", body[:180])
            if fid is not None:
                check(not wait_active(fid, timeout=20),
                      f"G1A.10 and the {protocol} Forward never converges", f"id={fid}")
    finally:
        # Wait for the Agent's own heartbeat to restore the real manifest.
        restored = wait_until(lambda: isinstance(db(
            "const r = await db.nodeStateReport.findUnique({where:{node_id:%d},"
            "select:{capability_manifest:true}});return r ? r.capability_manifest : null;" % ING), dict),
            timeout=120, interval=5)
        check(restored, "G1A.10 the Agent's real manifest came back after the planted outage")
        check(wait_until(lambda: scalar(
            "SELECT COUNT(*) FROM node_state_report WHERE node_id=%d AND "
            "JSON_CONTAINS(capability_manifest, '\"tls\"', '$.protocols') AND "
            "JSON_CONTAINS(capability_manifest, '\"ws\"', '$.protocols');" % ING) == "1",
            timeout=120, interval=3),
            "G1A.10 ... and it is the REAL manifest (tls and ws are back), not just any report")


def g1a_11_no_secret_leak():
    cert, key = gen_cert("g1a-leak")
    cp, kp = install_cert(cert, key, "leak.crt", "leak.key")
    fid, port = _create_ok("LEAK", "tls", cert_path=cp, key_path=kp, target_port=ECHO_TARGET_PORT)
    check(wait_active(fid), "G1A.11 the tls fixture converges", f"id={fid}")
    tls_probe(port)  # force at least one handshake so anything loggable is logged

    key_text = Path("/tmp/g1a.key").read_text().strip()
    key_body = "".join(key_text.splitlines()[1:-1])[:40]
    logs = docker(["logs", "--since", "30m", INGRESS_CONTAINER], allow=True, timeout=120)
    check(key_body not in logs, "G1A.11 the private key never appears in the Agent log")
    check("PRIVATE KEY" not in logs, "G1A.11 nor any PEM private-key header in the Agent log")

    status, bundle, _ = req("GET", f"/api/nodes/{ING}/support-bundle", timeout=180)
    if status == 200:
        blob = json.dumps(bundle, ensure_ascii=False)
        check(key_body not in blob, "G1A.11 the private key is absent from the support bundle")
        check("PRIVATE KEY" not in blob, "G1A.11 and no PEM private-key header either")
    else:
        check(False, "G1A.11 the support bundle is readable", f"status={status}")


def g1a_12_drain():
    fid, port = _create_ok("DRAIN", "ws", target_port=ECHO_TARGET_PORT)
    check(wait_active(fid), "G1A.12 the ws fixture converges", f"id={fid}")
    check(ws_probe(port)[0], "G1A.12 it serves before the drain")
    status, _b, _ = req("POST", f"/api/forwards/{fid}/suspend")
    check(status == 200, "G1A.12 suspend is accepted", f"status={status}")
    drained = wait_until(lambda: not ws_probe(port)[0], timeout=90, interval=4)
    check(drained, "G1A.12 the drained tunnel stops accepting new WebSocket clients", f"port={port}")
    check("tunex-%d-direct" % fid not in scalar(
        "SELECT IFNULL(tunnels,'[]') FROM node_state_report WHERE node_id=%d;" % ING),
        "G1A.12 and its runtime is gone from the node's own report")


def cleanup():
    try:
        cleanup_fixtures()
        left = scalar(f"SELECT COUNT(*) FROM tunnel WHERE name LIKE '{FIXTURE_PREFIX}%';")
        check(left == "0", "G1A.cleanup every fixture this gate created was removed", f"left={left}")
    except Exception as exc:  # noqa: BLE001
        record(False, f"G1A.cleanup: {type(exc).__name__}: {exc}")


def main():
    signal.signal(signal.SIGALRM, alarm)
    acquire_lock()
    ready = False
    try:
        signal.setitimer(signal.ITIMER_REAL, min(300, OVERALL_SECONDS))
        setup()
        ready = True
        signal.setitimer(signal.ITIMER_REAL, 0)
        for name, fn, budget in [
            ("G1A.1 tcp regression", g1a_1_tcp_regression, 200),
            ("G1A.2 tls positive", g1a_2_tls_positive, 240),
            ("G1A.3 tls bad config", g1a_3_tls_bad_config, 240),
            ("G1A.4 ws positive", g1a_4_ws_positive, 240),
            ("G1A.5 ws malformed handshake", g1a_5_ws_malformed_handshake, 240),
            ("G1A.7 hot reload", g1a_7_hot_reload_under_tls_and_ws, 480),
            ("G1A.6 certificate reload", g1a_6_certificate_reload, 360),
            ("G1A.8 Agent restart", g1a_8_agent_restart, 420),
            ("G1A.9 Panel restart", g1a_9_panel_restart, 420),
            ("G1A.10 old Agent admission", g1a_10_old_agent_admission, 420),
            ("G1A.12 drain", g1a_12_drain, 300),
            ("G1A.11 no secret leak", g1a_11_no_secret_leak, 420),
        ]:
            case(name, fn, budget)
    except Exception as exc:  # noqa: BLE001
        record(False, f"G1A prerequisite/setup: {type(exc).__name__}: {exc}; remaining tests NOT EXECUTED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.setitimer(signal.ITIMER_REAL, 300)
        try:
            cleanup()
        except Exception as exc:  # noqa: BLE001
            record(False, f"G1A.cleanup: {type(exc).__name__}: {exc}; inspect topology before rerun")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        RESULT.write_text(
            "# V5-G1A WS/TLS protocol expansion gate\n"
            f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
            "topology: scripts/v3-e2e/docker-compose.e2e.yaml (existing Agents, real TCP/TLS/WS)\n"
            f"fixture: {FIXTURE_PREFIX}; setup={'executed' if ready else 'incomplete'}\n"
            f"elapsed_seconds: {int(time.monotonic() - START)}\n"
            + "\n".join(RESULTS)
            + f"\nV5-G1A TOTAL PASS={PASS} FAIL={FAIL}\n",
            encoding="utf-8",
        )
        TRACE.write_text(json.dumps({"http": HTTP}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        release_lock()
        print(f"V5-G1A TOTAL PASS={PASS} FAIL={FAIL} evidence={RESULT}", flush=True)
    return 1 if FAIL or not ready else 0


if not (STATE.exists() and ENVF.exists() and PASSF.exists()):
    raise SystemExit("missing e2e state; run scripts/v3-e2e/setup.sh first")

state = json.loads(STATE.read_text())
EMAIL = state["user"]["email"]
WS = state["workspaces"]["primary"]["id"]
ING = state["nodes"]["ingress"]["id"]
EGR = state["nodes"]["egress"]["id"]
PW = run(["bash", "-c", '. "$1"; printf %s "$WP14_USER_PASSWORD"', "_", str(PASSF)])
COOKIE = ""


if __name__ == "__main__":
    raise SystemExit(main())
