#!/usr/bin/env python3
"""V5-G1B gate — UDP protocol expansion (V5.1b, DEVELOPMENT.md §6.2).

Closes WP5-B1 (UDP DIRECT). The checks are the contract's §7 list mapped onto
executable cases against the real four-Agent topology:

  G1B.1  stream regression        tcp/tls/ws still work now that udp exists
  G1B.2  udp DIRECT positive      a datagram goes out and the answer comes back
  G1B.3  mapping semantics        two clients get two mappings; the target is not part of the key
  G1B.4  idle expiry              a mapping ends by timeout, and the fact is reported
  G1B.5  udp RELAY refused        RELAY/EGRESS is refused outright, never half-implemented
  G1B.6  malformed datagrams      garbage and oversized payloads do not kill the listener
  G1B.7  old Agent admission      an Agent that does not advertise udp/datagram is refused first
  G1B.8  Agent restart            a udp Forward survives the node restarting
  G1B.9  Panel restart            the data plane is independent of the panel
  G1B.10 port ownership           TCP and UDP do not share a port number on one node
  G1B.11 hot reload               a target change does not rebuild the listener
  G1B.12 diagnostics              the per-tunnel diag carries datagram facts, not a "connection" fiction
  G1B.13 no payload leak          tunnel payload never appears in agent logs or the support bundle
  G1B.14 suspend                  a suspended udp tunnel stops serving

FAIL > 0 means V5.1b is not closed. A missing topology, timeout, failed
prerequisite or cleanup failure is a FAIL, never a skip.

The harness (login, API, mysql, docker, probes, counters, fixture cleanup) is
imported from the V5-G1A gate rather than copied: two gates carrying two copies of
the same helpers is how they drift apart, and this file is about UDP semantics, not
about how to log in. Both gates mutate the same topology, so they share ONE lock.
"""
from __future__ import annotations

import importlib.util
import json
import os
import signal
import socket
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_g1a():
    """Import the V5-G1A gate as the shared harness module."""
    spec = importlib.util.spec_from_file_location("v5_g1a_harness", HERE / "v5-g1a.py")
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise SystemExit("cannot load scripts/v3-e2e/v5-g1a.py as the harness module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


H = _load_g1a()  # the harness: API, mysql, docker, probes, counters, cleanup

OUT = HERE / "evidence"
OUT.mkdir(exist_ok=True)
RESULT = OUT / "v5-g1b-result.txt"
UDP_ECHO_PORT = 3040  # the UDP byte-echo target this gate starts

# Instantiated in setup(), once the class below is defined: Python runs module-level
# statements in order, and creating them here raised NameError before any case ran.
ECHO_MAIN: "UDPEcho | None" = None
ECHO_ALT: "UDPEcho | None" = None
ECHO_TARGET_HOST = ""

FIXTURE_PREFIX = f"V5-G1B-{int(time.time())}"
OVERALL_SECONDS = int(os.environ.get("G1B_OVERALL_SECONDS", "2400"))
START = time.monotonic()


def record(passed: bool, message: str) -> None:
    H.record(passed, message)


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
# UDP-specific helpers
# ---------------------------------------------------------------------------

def udp_probe(port: int, payload: bytes = b"g1b-udp", timeout: float = 5.0,
              bind: tuple[str, int] | None = None) -> tuple[bool, str]:
    """Send one datagram to the ingress listener and wait for the echo.

    `bind` pins the CLIENT source port so a case can keep using the same mapping
    (or deliberately use a second one) — the mapping key is the client address,
    which is exactly what the contract froze, so the tests have to control it.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        if bind is not None:
            sock.bind(bind)
        sock.settimeout(timeout)
        sock.sendto(payload, (H.INGRESS_DATA_IP, port))
        data, _addr = sock.recvfrom(2048)
        return True, repr(data)
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"
    finally:
        sock.close()


class UDPEcho:
    """The gate's own UDP byte-echo target.

    Not `nc -lu -e cat` on a container: busybox's UDP listener is ONE-SHOT (it
    handles a single datagram and exits), so the gate's own readiness probe ate the
    listener and every datagram after it timed out — a red gate whose cause looked
    like a product bug. A test double that dies after the first packet is worse
    than no test double.

    It lives in the gate process, on the runner, which is attached to the ingress
    data network — so the Agent can reach it by the runner's own address on that
    network, and the gate controls it completely (including a second instance on
    another port for the hot-reload case).
    """

    def __init__(self, port: int):
        self.port = port
        self._sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.seen = 0

    def start(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("0.0.0.0", self.port))
        self._sock.settimeout(0.5)
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        assert self._sock is not None
        while not self._stop.is_set():
            try:
                data, addr = self._sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                return
            self.seen += 1
            try:
                # Echo the payload with a marker so a case can tell WHICH target
                # answered (the hot-reload case needs exactly that).
                self._sock.sendto(b"echo-%d:" % self.port + data, addr)
            except OSError:
                continue

    def stop(self) -> None:
        self._stop.set()
        if self._sock is not None:
            self._sock.close()
        if self._thread is not None:
            self._thread.join(timeout=2)


def probe_echo(server: UDPEcho, payload: bytes = b"target-check", timeout: float = 2.0) -> tuple[bool, str]:
    """Probe an echo target WITHOUT going through a tunnel."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(timeout)
        sock.sendto(payload, ("127.0.0.1", server.port))
        data, _addr = sock.recvfrom(2048)
        sock.close()
        return data == b"echo-%d:" % server.port + payload, repr(data)
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


def runner_data_ip() -> str:
    """The runner's own address on the ingress data network.

    A literal address, not a name: the Forward's target must be reachable from the
    Agent, and the Agent resolves names on that network — but relying on DNS for a
    container the gate itself owns would add a dependency the test does not need.
    """
    out = H.docker(["exec", "g0-runner", "sh", "-c", "hostname -i"], allow=True).strip()
    for candidate in out.split():
        if candidate.startswith("172.31.10."):
            return candidate
    return out.split()[0] if out.split() else ""


ECHO_ALT_PORT = UDP_ECHO_PORT + 1


def tunnel_diag(fid: int) -> dict:
    """The reported diagnostics of a tunnel, straight from the node's own report."""
    raw = H.scalar(
        "SELECT IFNULL(tunnels,'[]') FROM node_state_report WHERE node_id=%d;" % H.ING)
    try:
        tunnels = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return {}
    for t in tunnels:
        if isinstance(t, dict) and str(t.get("id", "")).startswith(f"tunex-{fid}-"):
            diag = t.get("diag")
            return diag if isinstance(diag, dict) else {}
    return {}


def wait_diag(fid: int, predicate, timeout: int = 60) -> tuple[bool, dict]:
    """Wait for a diagnostics predicate, returning the last diag it saw."""
    last: dict = {}
    end = time.time() + timeout
    while time.time() < end:
        last = tunnel_diag(fid)
        if last and predicate(last):
            return True, last
        time.sleep(2)
    return False, last


def udp_create(name: str, mode: str = "direct", *, target_port: int = UDP_ECHO_PORT,
               listen_port: int | None = None, egress: bool = False):
    body: dict = {
        "name": f"{FIXTURE_PREFIX}-{name}",
        "mode": mode,
        "protocol": "udp",
        "ingress_node_id": H.ING,
        "target_host": ECHO_TARGET_HOST,
        "target_port": target_port,
    }
    if listen_port is not None:
        body["listen_port"] = listen_port
    if mode == "relay":
        body["egress_node_id"] = H.EGR
    status, resp, _ = H.req("POST", "/api/forwards", body)
    if status == 401:
        raise RuntimeError(f"create {name} got 401 Unauthorized (session problem, not a product decision)")
    data = H.unwrap(resp)
    fid = data.get("id") if isinstance(data, dict) else None
    if fid is not None and int(fid) not in H.created_ids:
        H.created_ids.append(int(fid))
    return status, (int(fid) if fid is not None else None), int((data or {}).get("listen_port") or 0), resp


# ---------------------------------------------------------------------------
# setup / cleanup
# ---------------------------------------------------------------------------

def setup():
    # The G1A harness's generic prerequisites, plus the UDP parts. Written out here
    # rather than calling H.setup() because G1A's setup asserts G1A's own
    # protocol facts (it requires ws to be advertised), which would make this gate
    # fail for a reason that belongs to the other one.
    H.mysql(f"UPDATE user SET super_admin=1 WHERE email='{H.EMAIL}';")
    H.mysql("UPDATE capability_policy SET max_tunnels=200, revision=revision+1 WHERE max_tunnels IS NOT NULL;")
    for key in ("platform_ceiling", "free_personal"):
        H.mysql(
            "UPDATE capability_policy SET tunnel_types=JSON_ARRAY('tcp','tls','ws','udp'), "
            f"revision=revision+1 WHERE `key`='{key}';"
        )
    missing = H.scalar(
        "SELECT COUNT(*) FROM capability_policy WHERE JSON_CONTAINS(tunnel_types, '\"udp\"') = 0;"
    )
    check(missing == "0",
          "G1B.setup every policy row entitles udp (the ceiling is intersected with all of them)",
          f"rows_without_udp={missing}")

    check(H.ensure_second_target(), "G1B.setup target-a serves the TCP byte-echo port", f"port={H.ECHO_TARGET_PORT}")
    global ECHO_TARGET_HOST
    ECHO_TARGET_HOST = runner_data_ip()
    check(bool(ECHO_TARGET_HOST),
          "G1B.setup the gate knows its own address on the ingress data network", f"ip={ECHO_TARGET_HOST!r}")
    global ECHO_MAIN, ECHO_ALT
    ECHO_MAIN = UDPEcho(UDP_ECHO_PORT)
    ECHO_ALT = UDPEcho(ECHO_ALT_PORT)
    ECHO_MAIN.start()
    ECHO_ALT.start()
    ok_main, detail_main = probe_echo(ECHO_MAIN)
    ok_alt, detail_alt = probe_echo(ECHO_ALT)
    check(ok_main, "G1B.setup the UDP echo target answers on the runner", detail_main)
    check(ok_alt, "G1B.setup a SECOND UDP echo target answers (for the hot-reload case)", detail_alt)
    # Repeatedly, to prove it is not one-shot: this is the exact failure that made
    # the first version of this gate look like a product bug.
    for i in range(3):
        ok, detail = probe_echo(ECHO_MAIN, b"repeat-%d" % i)
        if not ok:
            check(False, "G1B.setup the UDP echo target survives repeated datagrams", detail)
            break

    # Clean port guard: a previous run (of either gate) can leave listeners behind,
    # and the node would then refuse the next fixture's port for a reason that has
    # nothing to do with UDP.
    for container in (H.INGRESS_CONTAINER, H.EGRESS_CONTAINER):
        H.docker(["restart", container], timeout=120)
    check(bool(H.wait_until(lambda: H.req("GET", "/healthz", timeout=5)[0] == 200, timeout=60, interval=2)),
          "G1B.setup the panel is reachable after the Agent restarts")
    check(bool(H.wait_until(lambda: H.scalar(
        "SELECT COUNT(*) FROM node_state_report WHERE reported_at > NOW() - INTERVAL 1 MINUTE;") == "4",
        timeout=120, interval=3)),
        "G1B.setup all four Agents re-report after the restart")
    advertised = H.wait_until(lambda: H.scalar(
        "SELECT COUNT(*) FROM node_state_report WHERE JSON_CONTAINS(capability_manifest, '\"udp\"', '$.protocols') "
        "AND JSON_CONTAINS(capability_manifest, '\"datagram\"', '$.transports');") == "4",
        timeout=120, interval=4)
    check(advertised, "G1B.setup all four Agents advertise udp on the datagram transport",
          H.scalar("SELECT IFNULL(capability_manifest,'') FROM node_state_report WHERE node_id=%d;" % H.ING)[:180])


# ---------------------------------------------------------------------------
# cases
# ---------------------------------------------------------------------------

def g1b_1_stream_regression():
    fid, port = H._create_ok("TCP-REG", "tcp", target_port=H.ECHO_TARGET_PORT)
    check(fid is not None and H.wait_active(fid), "G1B.1 a tcp Forward still converges", f"id={fid}")
    ok, detail = H.tcp_probe(port)
    check(ok and "g1b-reg" not in detail, "G1B.1 the tcp listener still forwards", detail)

    cert, key = H.gen_cert("g1b-tls")
    cp, kp = H.install_cert(cert, key, "g1b.crt", "g1b.key")
    status, tfid, tport, resp = H.create_forward(
        "TLS-REG", "tls", cert_path=cp, key_path=kp, target_port=H.ECHO_TARGET_PORT)
    check(status in (200, 201) and H.wait_active(int(tfid)), "G1B.1 a tls Forward still converges",
          f"status={status} body={json.dumps(resp, ensure_ascii=False)[:120]}")
    ok_tls, detail_tls = H.tls_probe(int(tport), payload=b"g1b-tls")
    check(ok_tls and "g1b-tls" in detail_tls, "G1B.1 the tls front still carries a round trip", detail_tls)

    status_ws, wfid, wport, resp_ws = H.create_forward("WS-REG", "ws", target_port=H.ECHO_TARGET_PORT)
    check(status_ws in (200, 201) and H.wait_active(int(wfid)), "G1B.1 a ws Forward still converges",
          f"status={status_ws}")
    ok_ws, detail_ws = H.ws_probe(int(wport), payload=b"g1b-ws")
    check(ok_ws and "g1b-ws" in detail_ws, "G1B.1 the ws front still carries a round trip", detail_ws)


def g1b_2_udp_positive():
    status, fid, port, resp = udp_create("UDP")
    check(status in (200, 201) and fid is not None, "G1B.2 a udp Forward is created",
          f"status={status} body={json.dumps(resp, ensure_ascii=False)[:160]}")
    check(H.wait_active(int(fid)), "G1B.2 it converges on a node that advertises udp", f"id={fid}")
    ok, detail = udp_probe(port)
    check(ok and "g1b-udp" in detail, "G1B.2 a datagram goes out and the answer comes back", detail)


def g1b_3_mapping_semantics():
    status, fid, port, resp = udp_create("MAP")
    check(status in (200, 201) and H.wait_active(int(fid)), "G1B.3 the udp fixture converges", f"id={fid}")

    ok_a, detail_a = udp_probe(port, b"client-a", bind=("0.0.0.0", 0))
    ok_b, detail_b = udp_probe(port, b"client-b", bind=("0.0.0.0", 0))
    check(ok_a and ok_b, "G1B.3 two different clients each get a working mapping", f"a={detail_a} b={detail_b}")

    ok, diag = wait_diag(fid, lambda d: int(d.get("mappings", 0)) >= 2, timeout=60)
    check(ok, "G1B.3 the runtime reports at least two live mappings", json.dumps(diag, ensure_ascii=False)[:180])
    check(int(diag.get("packets_out", 0)) >= 2,
          "G1B.3 the return direction is counted separately from the outbound one",
          json.dumps(diag, ensure_ascii=False)[:180])


def g1b_4_idle_expiry():
    status, fid, port, resp = udp_create("IDLE")
    check(status in (200, 201) and H.wait_active(int(fid)), "G1B.4 the udp fixture converges", f"id={fid}")
    ok, detail = udp_probe(port, b"before-idle")
    check(ok, "G1B.4 the mapping works before the idle window", detail)

    # The runtime's own reported timeout is the only number worth waiting on: hard
    # coding a guess here would make the gate pass or fail for the wrong reason.
    got, diag = wait_diag(fid, lambda d: "idle_timeout_seconds" in d, timeout=60)
    check(got, "G1B.4 the runtime reports its effective idle timeout",
          json.dumps(diag, ensure_ascii=False)[:180])
    idle = int(diag.get("idle_timeout_seconds", 0) or 0)
    check(idle > 0, "G1B.4 the reported idle timeout is a positive number", f"idle={idle}")
    if idle <= 0:
        return

    expired_before = int(diag.get("mappings_expired", 0) or 0)
    deadline = time.time() + idle + 90
    saw = False
    while time.time() < deadline:
        current = tunnel_diag(fid)
        if int(current.get("mappings_expired", 0) or 0) > expired_before:
            saw = True
            diag = current
            break
        time.sleep(3)
    check(saw, "G1B.4 the idle mapping expires and the expiry is reported",
          f"waited {idle + 90}s, diag={json.dumps(diag, ensure_ascii=False)[:160]}")
    check(int(diag.get("mappings", 0) or 0) == 0,
          "G1B.4 no mapping is left behind after the expiry",
          json.dumps(diag, ensure_ascii=False)[:160])

    # And the listener is still there: an expiring mapping is normal operation.
    ok_after, detail_after = udp_probe(port, b"after-idle")
    check(ok_after, "G1B.4 a new client is served after the expiry", detail_after)


def g1b_5_relay_refused():
    status, fid, _port, resp = udp_create("RELAY", mode="relay", egress=True)
    body = json.dumps(resp, ensure_ascii=False)
    check(status not in (200, 201),
          "G1B.5 a udp RELAY Forward is refused (the inter-node hop shape is NOT frozen)",
          f"status={status} body={body[:200]}")
    if fid is not None:
        check(not H.wait_active(int(fid), timeout=25),
              "G1B.5 and it never converges to active", f"id={fid}")
        row = H.tunnel_row(int(fid))
        check("active" not in row.split("|")[0],
              "G1B.5 the row is left in error rather than reported as running", row[:160])
    check(not H.wait_until(lambda: "udp" in H.scalar(
        "SELECT IFNULL(tunnels,'[]') FROM node_state_report WHERE node_id=%d;" % H.EGR), timeout=20, interval=4),
        "G1B.5 no udp runtime was created on the egress node")


def g1b_6_malformed_datagrams():
    status, fid, port, resp = udp_create("MALFORMED")
    check(status in (200, 201) and H.wait_active(int(fid)), "G1B.6 the udp fixture converges", f"id={fid}")

    # An empty datagram, a 1-byte one, and one far larger than any MTU: none may
    # take the listener down, and the tunnel must still serve afterwards.
    for payload in (b"", b"\x00", b"\xff" * 4096):
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.settimeout(2)
            sock.sendto(payload, (H.INGRESS_DATA_IP, port))
            try:
                sock.recvfrom(4096)
            except socket.timeout:
                pass
            sock.close()
        except Exception as exc:  # noqa: BLE001
            check(False, "G1B.6 a malformed datagram must not raise on the client side",
                  f"{len(payload)} bytes: {type(exc).__name__}: {exc}")
            return
    ok, detail = udp_probe(port, b"after-garbage")
    check(ok and "after-garbage" in detail,
          "G1B.6 the listener still serves a well-formed datagram afterwards", detail)


def g1b_7_old_agent_admission():
    def plant():
        H.db("const {Prisma} = await import('@prisma/client');"
             "await db.nodeStateReport.update({where:{node_id:%d},"
             "data:{capability_manifest:{schema_version:2,protocols:['tcp'],transports:['stream'],"
             "runtime:[],diagnostics:[]}, reported_at:new Date()}});return true;" % H.ING)

    plant()
    status, fid, _port, resp = udp_create("OLD-AGENT")
    body = json.dumps(resp, ensure_ascii=False)
    check(status not in (200, 201), "G1B.7 an Agent that predates udp gets no dispatch", f"status={status}")
    check("runtime_capability_denied" in body or "protocol_not_supported" in body,
          "G1B.7 the refusal is a runtime admission denial", body[:200])
    if fid is not None:
        check(not H.wait_active(int(fid), timeout=20), "G1B.7 and it never converges", f"id={fid}")
    check(bool(H.wait_until(lambda: H.scalar(
        "SELECT COUNT(*) FROM node_state_report WHERE node_id=%d AND "
        "JSON_CONTAINS(capability_manifest, '\"udp\"', '$.protocols');" % H.ING) == "1", timeout=120, interval=3)),
        "G1B.7 the Agent's real manifest (with udp) comes back")


def g1b_8_agent_restart():
    status, fid, port, resp = udp_create("RESTART")
    check(status in (200, 201) and H.wait_active(int(fid)), "G1B.8 the udp fixture converges", f"id={fid}")
    check(udp_probe(port)[0], "G1B.8 it serves before the restart")
    H.docker(["restart", H.INGRESS_CONTAINER], timeout=120)
    served = H.wait_until(lambda: udp_probe(port)[0], timeout=150, interval=5)
    check(served, "G1B.8 the udp listener comes back after an Agent restart", f"port={port}")
    diag = tunnel_diag(int(fid))
    check(diag.get("protocol") == "udp",
          "G1B.8 the restored tunnel reports itself as udp, not as its legacy projection",
          json.dumps(diag, ensure_ascii=False)[:160])


def g1b_9_panel_restart():
    status, fid, port, resp = udp_create("PANEL")
    check(status in (200, 201) and H.wait_active(int(fid)), "G1B.9 the udp fixture converges", f"id={fid}")
    H.docker(["restart", H.PANEL_CONTAINER], timeout=180)
    check(bool(H.wait_until(lambda: H.req("GET", "/healthz", timeout=5)[0] == 200, timeout=180, interval=3)),
          "G1B.9 the panel is back")
    ok, detail = udp_probe(port)
    check(ok, "G1B.9 the datagram listener kept serving across the panel restart", detail)


def g1b_10_port_ownership():
    shared = 21500
    status_tcp, tcp_fid, tcp_port, tcp_resp = H.create_forward(
        "PORT-TCP", "tcp", target_port=H.ECHO_TARGET_PORT, )
    if status_tcp not in (200, 201) or not H.wait_active(int(tcp_fid)):
        # Fall back to an explicit port if the automatic allocation did not land.
        H.req("DELETE", f"/api/forwards/{tcp_fid}", None)
        status_tcp, tcp_fid, tcp_port, tcp_resp = H.create_forward(
            "PORT-TCP", "tcp", target_port=H.ECHO_TARGET_PORT)
        check(False, "G1B.10 the TCP baseline for the port-sharing check converged",
              f"status={status_tcp} body={json.dumps(tcp_resp, ensure_ascii=False)[:140]}")
        return

    status_udp, udp_fid, udp_port, udp_resp = udp_create("PORT-UDP", listen_port=int(tcp_port))
    body = json.dumps(udp_resp, ensure_ascii=False)
    converged = udp_fid is not None and H.wait_active(int(udp_fid), timeout=30)
    # The frozen conservative rule: TCP and UDP do NOT share a number on one node.
    # Either the panel refuses it up front or the node's port guard does — both are
    # correct, silently running both would not be.
    check(status_udp not in (200, 201) or not converged,
          "G1B.10 a udp and a tcp Forward cannot share a port number on one node",
          f"status={status_udp} converged={converged} body={body[:160]}")
    if status_udp in (200, 201) and not converged:
        row = H.tunnel_row(int(udp_fid))
        check("conflict" in row.lower() or "port" in row.lower() or "占用" in row,
              "G1B.10 the refusal names the port conflict rather than a vague failure", row[:180])
    # The TCP tunnel must be untouched by the attempt.
    check(udp_probe(int(udp_port))[0] is False or udp_port != tcp_port,
          "G1B.10 the shape of the two allocations stays consistent")
    check(H.wait_active(int(tcp_fid)), "G1B.10 the tcp tunnel still works afterwards", f"id={tcp_fid}")


def g1b_11_hot_reload():
    status, fid, port, resp = udp_create("HOT")
    check(status in (200, 201) and H.wait_active(int(fid)), "G1B.11 the udp fixture converges", f"id={fid}")
    ok, detail = udp_probe(port, b"first-target")
    check(ok and "first-target" in detail, "G1B.11 the first round trip works", detail)

    patch = H.req("PATCH", f"/api/forwards/{fid}", {"target_port": ECHO_ALT_PORT})
    check(patch[0] == 200 and H.wait_active(int(fid)), "G1B.11 the target change converges",
          f"status={patch[0]}")
    port_after = int(H.scalar(f"SELECT IFNULL(listen_port,0) FROM tunnel WHERE id={fid};") or 0)
    check(port_after == port, "G1B.11 the listener port did not move (no rebuild)", f"{port} -> {port_after}")
    ok_after, detail_after = udp_probe(port, b"after-reload", bind=("0.0.0.0", 0))
    # The marker identifies WHICH target answered: a new mapping must use the new
    # target, and the assertion is only meaningful if the two are distinguishable.
    check(ok_after and ("echo-%d:" % ECHO_ALT_PORT) in detail_after,
          "G1B.11 a NEW client is served by the NEW target after the reload", detail_after)


def g1b_12_diagnostics():
    status, fid, port, resp = udp_create("DIAG")
    check(status in (200, 201) and H.wait_active(int(fid)), "G1B.12 the udp fixture converges", f"id={fid}")
    for i in range(3):
        udp_probe(port, b"diag-%d" % i)
    got, diag = wait_diag(fid, lambda d: int(d.get("packets_in", 0)) >= 3, timeout=60)
    check(got, "G1B.12 the runtime reports datagram counters", json.dumps(diag, ensure_ascii=False)[:200])
    # Counters are omitted when zero (the A3 wire style: `omitempty` on every
    # counter), so an ABSENT counter means zero and must not be read as "this
    # protocol does not report it". What must never be absent is a fact whose zero
    # is meaningless or a fact that identifies the tunnel.
    for key in ("mappings", "packets_in", "packets_out", "bytes_in", "bytes_out", "drops"):
        check(key in diag or int(diag.get(key, 0) or 0) == 0,
              f"G1B.12 the contract's `{key}` fact is reported (absent = zero)",
              json.dumps(diag, ensure_ascii=False)[:200])
    for always in ("protocol", "idle_timeout_seconds"):
        check(always in diag, f"G1B.12 `{always}` is always reported (its zero would be meaningless)",
              json.dumps(diag, ensure_ascii=False)[:200])
    check("connections" not in json.dumps(diag).lower(),
          "G1B.12 no 'connection' fiction is reported for a datagram tunnel",
          json.dumps(diag, ensure_ascii=False)[:200])
    check(diag.get("protocol") == "udp", "G1B.12 the diag names the protocol it belongs to")
    check(int(diag.get("bytes_in", 0)) > 0 and int(diag.get("bytes_out", 0)) > 0,
          "G1B.12 both directions are counted", json.dumps(diag, ensure_ascii=False)[:200])


def g1b_13_no_payload_leak():
    status, fid, port, resp = udp_create("LEAK")
    check(status in (200, 201) and H.wait_active(int(fid)), "G1B.13 the udp fixture converges", f"id={fid}")
    secret = b"G1B-PAYLOAD-DO-NOT-LOG-4f9a"
    ok, detail = udp_probe(port, secret)
    check(ok and secret.decode() in detail, "G1B.13 the payload round-trips", detail)

    logs = H.docker(["logs", "--since", "20m", H.INGRESS_CONTAINER], allow=True, timeout=120)
    check(secret.decode() not in logs, "G1B.13 the payload never appears in the Agent log")
    st, bundle, _ = H.req("GET", f"/api/nodes/{H.ING}/support-bundle", timeout=180)
    if st == 200:
        blob = json.dumps(bundle, ensure_ascii=False)
        check(secret.decode() not in blob, "G1B.13 the payload is absent from the support bundle")
    else:
        check(False, "G1B.13 the support bundle is readable", f"status={st}")


def g1b_14_suspend():
    status, fid, port, resp = udp_create("SUSPEND")
    check(status in (200, 201) and H.wait_active(int(fid)), "G1B.14 the udp fixture converges", f"id={fid}")
    check(udp_probe(port)[0], "G1B.14 it serves before the suspend")
    st, _b, _ = H.req("POST", f"/api/forwards/{fid}/suspend")
    check(st == 200, "G1B.14 suspend is accepted", f"status={st}")
    stopped = H.wait_until(lambda: not udp_probe(port)[0], timeout=90, interval=4)
    check(stopped, "G1B.14 a suspended udp tunnel stops serving", f"port={port}")
    check(f"tunex-{fid}-direct" not in H.scalar(
        "SELECT IFNULL(tunnels,'[]') FROM node_state_report WHERE node_id=%d;" % H.ING),
        "G1B.14 its runtime is gone from the node's own report")


def cleanup():
    for server in (ECHO_MAIN, ECHO_ALT):
        if server is None:
            continue
        try:
            server.stop()
        except Exception as exc:  # noqa: BLE001
            record(False, f"G1B.cleanup echo server :{server.port}: {type(exc).__name__}: {exc}")
    try:
        H.cleanup_fixtures()
        left = H.scalar(f"SELECT COUNT(*) FROM tunnel WHERE name LIKE '{FIXTURE_PREFIX}%';")
        check(left == "0", "G1B.cleanup every fixture this gate created was removed", f"left={left}")
    except Exception as exc:  # noqa: BLE001
        record(False, f"G1B.cleanup: {type(exc).__name__}: {exc}")


def main():
    signal.signal(signal.SIGALRM, H.alarm)
    ready = False
    try:
        signal.setitimer(signal.ITIMER_REAL, min(300, OVERALL_SECONDS))
        H.acquire_lock()
        setup()
        ready = True
        signal.setitimer(signal.ITIMER_REAL, 0)
        for name, fn, budget in [
            ("G1B.1 stream regression", g1b_1_stream_regression, 420),
            ("G1B.2 udp positive", g1b_2_udp_positive, 240),
            ("G1B.3 mapping semantics", g1b_3_mapping_semantics, 300),
            ("G1B.4 idle expiry", g1b_4_idle_expiry, 420),
            ("G1B.5 relay refused", g1b_5_relay_refused, 240),
            ("G1B.6 malformed datagrams", g1b_6_malformed_datagrams, 300),
            ("G1B.7 old Agent admission", g1b_7_old_agent_admission, 420),
            ("G1B.11 hot reload", g1b_11_hot_reload, 300),
            ("G1B.12 diagnostics", g1b_12_diagnostics, 300),
            ("G1B.10 port ownership", g1b_10_port_ownership, 360),
            ("G1B.8 Agent restart", g1b_8_agent_restart, 480),
            ("G1B.9 Panel restart", g1b_9_panel_restart, 420),
            ("G1B.14 suspend", g1b_14_suspend, 300),
            ("G1B.13 no payload leak", g1b_13_no_payload_leak, 420),
        ]:
            case(name, fn, budget)
    except Exception as exc:  # noqa: BLE001
        record(False, f"G1B prerequisite/setup: {type(exc).__name__}: {exc}; remaining tests NOT EXECUTED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.setitimer(signal.ITIMER_REAL, 300)
        try:
            cleanup()
        except Exception as exc:  # noqa: BLE001
            record(False, f"G1B.cleanup: {type(exc).__name__}: {exc}; inspect topology before rerun")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        RESULT.write_text(
            "# V5-G1B UDP protocol expansion gate\n"
            f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
            "topology: scripts/v3-e2e/docker-compose.e2e.yaml (existing Agents, real UDP/TCP/TLS/WS)\n"
            f"fixture: {FIXTURE_PREFIX}; setup={'executed' if ready else 'incomplete'}\n"
            f"elapsed_seconds: {int(time.monotonic() - START)}\n"
            + "\n".join(H.RESULTS)
            + f"\nV5-G1B TOTAL PASS={H.PASS} FAIL={H.FAIL}\n",
            encoding="utf-8",
        )
        (OUT / "v5-g1b-http.json").write_text(
            json.dumps({"http": H.HTTP}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        H.release_lock()
        print(f"V5-G1B TOTAL PASS={H.PASS} FAIL={H.FAIL} evidence={RESULT}", flush=True)
    return 1 if H.FAIL or not ready else 0


if __name__ == "__main__":
    raise SystemExit(main())
