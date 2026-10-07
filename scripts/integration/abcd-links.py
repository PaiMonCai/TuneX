#!/usr/bin/env python3
"""FXP acceptance on the existing disposable Panel/Worker/four-Agent topology.

No admin-port runtime creation or fake database. Requires abcd-core-gate.sh.
"""
from __future__ import annotations
import importlib.util
import json
import signal
import socket
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("abcd_current_harness", HERE / "current-protocol.py")
if spec is None or spec.loader is None:
    raise SystemExit("cannot load existing network harness")
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)
H = C.H
RESULT = HERE / "evidence" / "abcd-links-result.txt"
TRACE = HERE / "evidence" / "abcd-links-http.json"


class TracedUDP(C.UDPEcho):
    def __init__(self, port):
        super().__init__(port)
        self.sources = {}

    def _serve(self):
        while not self._stop.is_set():
            try:
                data, address = self._sock.recvfrom(4096)
                self.sources[data] = address
                self._sock.sendto(data, address)
            except socket.timeout:
                continue
            except OSError:
                return


class Echo:
    def __init__(self, port):
        self.port = port
        self.udp = TracedUDP(port)
        self.tcp = socket.socket()
        self.tcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.tcp.bind(("0.0.0.0", port))
        self.tcp.listen()
        self.tcp.settimeout(0.5)
        self.clients = set()
        self.stopped = threading.Event()

    def start(self):
        self.udp.start()
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while not self.stopped.is_set():
            try:
                client, _ = self.tcp.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.clients.add(client)
            threading.Thread(target=self.echo, args=(client,), daemon=True).start()

    def echo(self, client):
        try:
            client.settimeout(0.5)
            while not self.stopped.is_set():
                try:
                    data = client.recv(65536)
                except socket.timeout:
                    continue
                if not data:
                    return
                client.sendall(data)
        except OSError:
            pass
        finally:
            client.close()
            self.clients.discard(client)

    def stop(self):
        self.stopped.set()
        self.tcp.close()
        self.udp.stop()
        for client in list(self.clients):
            client.close()


def request(method, path, body=None):
    status, response, _ = H.req(method, path, body)
    if status not in (200, 201):
        raise RuntimeError(f"{method} {path}: status={status} code={response.get('code', 'unknown')}")
    return H.unwrap(response)


def tcp(port):
    client = socket.create_connection((H.INGRESS_DATA_IP, port), timeout=4)
    client.settimeout(4)
    return client


def tcp_payload(client, payload):
    client.sendall(payload)
    got = b""
    while len(got) < len(payload):
        chunk = client.recv(len(payload) - len(got))
        if not chunk:
            break
        got += chunk
    return got == payload


def udp_payload(client, port, payload):
    client.settimeout(4)
    client.sendto(payload, (H.INGRESS_DATA_IP, port))
    return client.recvfrom(2048)[0] == payload


def main():
    signal.signal(signal.SIGALRM, H.alarm)
    signal.setitimer(signal.ITIMER_REAL, 600)
    H.acquire_lock()
    link_id = None
    rules = []
    sockets = []
    targets = []
    try:
        H.setup()
        H.mysql("UPDATE capability_policy SET tunnel_types=JSON_ARRAY('tcp','tls','ws','udp'),revision=revision+1;")
        target = C.runner_egress_ip()
        if not target:
            raise RuntimeError("no address reachable by egress for the real echo target")
        for port in (3042, 3043):
            server = Echo(port)
            server.start()
            targets.append(server)
        link = request("POST", "/api/links", {"name": f"{H.FIXTURE_PREFIX}-ABCD",
            "config": {"ingress_node_id": H.ING, "egress_node_id": H.EGR, "carrier_port": 22080}})
        link_id = link["id"]
        base = f"/api/links/{link_id}"
        request("POST", base + "/deploy")
        detail = request("GET", base)
        H.check(any(p["role"] == "ingress" and p["status"] == "passive" for p in detail["deployment"]["placements"]),
                "ABCD empty ingress remains passive while the independent carrier is deployed")
        def binding(name, port, cap):
            return {"name": name, "protocol": "both", "listen_port": port, "listen_host": "",
                "target_host": target, "target_port": 3042, "max_connections": cap,
                "max_connections_per_ip": cap}
        a = request("POST", base + "/forwards", binding("A", 21080, 1))["id"]
        rules.append(a)
        b = request("POST", base + "/forwards", binding("B", 21081, 0))["id"]
        rules.append(b)
        held_a = tcp(21080)
        held_b = tcp(21081)
        udp_b = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sockets.extend((held_a, held_b, udp_b))
        H.check(tcp_payload(held_a, b"encrypted-A") and tcp_payload(held_b, b"encrypted-B"),
                "ABCD shared exit forwards actual encrypted TCP payloads")
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            client.settimeout(0.5)
            client.sendto(b"must-share-A-budget", (H.INGRESS_DATA_IP, 21080))
            try:
                blocked = not bool(client.recvfrom(2048)[0])
            except socket.timeout:
                blocked = True
        H.check(blocked, "ABCD TCP and UDP share one connection ceiling for A")
        H.check(udp_payload(udp_b, 21081, b"encrypted-UDP-B"), "ABCD TCP and UDP use the same business port")
        original_udp_source = targets[0].udp.sources.get(b"encrypted-UDP-B")
        detail = request("GET", base)
        prior_generation = detail["generation"]
        conflict_status, _, _ = H.req("POST", base + "/forwards", binding("conflicting", 21081, 0))
        after_conflict = request("GET", base)
        H.check(conflict_status == 409 and after_conflict["generation"] == prior_generation and
            len(after_conflict["forwards"]) == 2 and tcp_payload(held_b, b"B-after-rejected-conflict"),
            "ABCD conflicting additions are rejected before persistence and do not replace B")
        held_a.close()
        detail = request("GET", base)
        row_a = next(f for f in detail["forwards"] if f["id"] == a)
        updated = binding("A edited", 21080, 1)
        updated["target_port"] = 3043
        request("PUT", base + f"/forwards/{a}", {"expected_revision": row_a["config_revision"], "binding": updated})
        H.check(tcp_payload(held_b, b"B-after-A-edit") and udp_payload(udp_b, 21081, b"B-mapping-after-A-edit"),
                "ABCD editing A preserves B's existing TCP session and UDP mapping")
        H.check(original_udp_source is not None and targets[0].udp.sources.get(b"B-mapping-after-A-edit") == original_udp_source,
                "ABCD unchanged B keeps its actual UDP target socket through A edit")
        request("POST", base + f"/forwards/{a}/actions", {"action": "delete"})
        rules.remove(a)
        H.check(tcp_payload(held_b, b"B-after-A-delete") and udp_payload(udp_b, 21081, b"B-mapping-after-A-delete"),
                "ABCD deleting A preserves B and the shared carrier")
        H.check(targets[0].udp.sources.get(b"B-mapping-after-A-delete") == original_udp_source,
                "ABCD unchanged B keeps its actual UDP target socket through A removal")
        H.check(H.scalar(f"SELECT COUNT(*) FROM node_port_lease WHERE node_id={H.ING} AND port=21080 AND status='active';") == "0",
                "ABCD removed A listener claims are released only after placement acknowledgement")
        c = request("POST", base + "/forwards", binding("C reuse", 21080, 0))["id"]
        rules.append(c)
        with tcp(21080) as replacement:
            H.check(tcp_payload(replacement, b"C-exact-reuse"), "ABCD deleted A port carries a new rule payload")
        for container in (H.INGRESS_CONTAINER, H.EGRESS_CONTAINER):
            H.docker(["restart", container], timeout=120)
        def restored():
            try:
                with tcp(21081) as client:
                    return tcp_payload(client, b"B-restored")
            except OSError:
                return False
        H.check(bool(H.wait_until(restored, timeout=90, interval=2)), "ABCD authoritative/private restoration recovers encrypted payload")
        H.check(bool(H.wait_until(lambda: all(p.get("observation", {}).get("state") in ("ready", "passive")
            for p in request("GET", base)["deployment"]["placements"]), timeout=60, interval=2)),
            "ABCD fresh generation/digest/lease runtime facts, not historical ACKs, confirm readiness")
    except Exception as error:
        H.record(False, f"ABCD case: {type(error).__name__}: {error}")
    finally:
        for client in sockets:
            client.close()
        if link_id is not None:
            for fid in rules:
                try:
                    request("POST", f"/api/links/{link_id}/forwards/{fid}/actions", {"action": "delete"})
                except Exception as error:
                    H.record(False, f"ABCD cleanup rule: {type(error).__name__}")
            try:
                request("DELETE", f"/api/links/{link_id}")
            except Exception as error:
                H.record(False, f"ABCD cleanup carrier: {type(error).__name__}")
        for server in targets:
            server.stop()
        signal.setitimer(signal.ITIMER_REAL, 0)
        RESULT.write_text("# ABCD real shared FXP acceptance\n" + "\n".join(H.RESULTS) +
            f"\nPASS={H.PASS} FAIL={H.FAIL}\n", encoding="utf-8")
        TRACE.write_text(json.dumps({"http": H.HTTP}, ensure_ascii=False, indent=2), encoding="utf-8")
        H.release_lock()
    return 1 if H.FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
