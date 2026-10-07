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
import urllib.error
import urllib.request
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


def traffic_rows(link_id, forward_ids):
    """Read actual committed collector samples, never construct usage fixtures."""
    ids = ",".join(str(int(fid)) for fid in forward_ids)
    fields = ["producer_id", "link_id", "workspace_id", "node_id", "forward_id",
              "generation", "config_digest", "date", "bytes_in", "bytes_out", "connections"]
    values = {"date": "DATE_FORMAT(date,'%Y-%m-%d')"}
    values.update({key: f"CAST({key} AS CHAR)" for key in ("bytes_in", "bytes_out", "connections")})
    projection = ",".join(f"'{key}',{values.get(key, key)}" for key in fields)
    rows = H.mysql(f"SELECT JSON_OBJECT({projection}) FROM link_traffic_checkpoint "
                   f"WHERE workspace_id={int(H.WS)} AND link_id={int(link_id)} "
                   f"AND forward_id IN ({ids}) ORDER BY forward_id,producer_id,date;")
    return [json.loads(row) for row in rows.splitlines() if row.strip()]


def traffic_totals(rows):
    return tuple(sum(int(row[key]) for row in rows) for key in ("bytes_in", "bytes_out"))


def wait_traffic(link_id, forward_ids, predicate=None, keepalive=None):
    rows = []
    def committed():
        nonlocal rows
        if keepalive is not None and not keepalive():
            return False
        rows = traffic_rows(link_id, forward_ids)
        return (set(forward_ids) <= {row["forward_id"] for row in rows}
                and all(row["node_id"] == H.ING for row in rows)
                and all(any(row["forward_id"] == fid and int(row["bytes_in"]) > 0
                            and int(row["bytes_out"]) > 0 for row in rows) for fid in forward_ids)
                and (predicate is None or predicate(rows)))
    if not H.wait_until(committed, timeout=60, interval=2):
        raise RuntimeError(f"traffic checkpoint deadline: link={link_id} forwards={forward_ids}")
    H.check(all(row["workspace_id"] == H.WS and row["link_id"] == link_id
                and row["node_id"] == H.ING for row in rows),
            "ABCD traffic checkpoints are scoped to this workspace/Link and ingress only")
    return rows


def replay_traffic(link_id, forward_ids, samples):
    """Replay a real checkpoint snapshot twice, byte-for-byte, via node auth.

    Freeze the only producer so unrelated late flushes cannot mask double billing.
    Pausing neither creates a runtime nor replaces any real DB/service code.
    """
    credential = json.loads((HERE / "state.json").read_text(encoding="utf-8"))["nodes"]["ingress"]["credential"]
    body = json.dumps({"samples": samples}, separators=(",", ":")).encode()
    H.docker(["pause", H.INGRESS_CONTAINER], timeout=15)
    try:
        before = traffic_rows(link_id, forward_ids)
        ids = ",".join(str(int(fid)) for fid in forward_ids)
        ledger_sql = (f"SELECT tunnel_id,date,traffic,traffic_cost FROM tunnel_traffic "
                      f"WHERE workspace_id={int(H.WS)} AND tunnel_id IN ({ids}) ORDER BY tunnel_id,date;")
        ledger = H.mysql(ledger_sql)
        if not ledger.strip():
            raise RuntimeError("committed payload is missing from the existing daily billing ledger")
        H.check(bool(ledger.strip()), "ABCD committed payload also reaches the existing daily billing ledger")
        for _ in range(2):
            req = urllib.request.Request(H.API + "/api/internal/node/link-traffic", body, method="POST",
                headers={"authorization": f"Bearer {credential}", "content-type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=15) as response:
                    accepted = json.loads(response.read())["data"]["accepted"]
            except urllib.error.HTTPError as error:
                # Never include the credential or raw service error in evidence.
                raise RuntimeError(f"traffic replay HTTP status={error.code}") from None
            if accepted != samples:
                raise RuntimeError("traffic replay did not acknowledge the exact submitted snapshot")
        H.check(traffic_rows(link_id, forward_ids) == before and H.mysql(ledger_sql) == ledger,
                "ABCD identical processed snapshot replay does not double-count checkpoints or daily billing")
    finally:
        H.docker(["unpause", H.INGRESS_CONTAINER], timeout=15)


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
        state = json.loads((HERE / "state.json").read_text(encoding="utf-8"))
        node_ids = [int(node["id"]) for node in state["nodes"].values()]
        if len(node_ids) != 4:
            raise RuntimeError("ABCD requires four provisioned Agent identities")
        def current_link_facts():
            # Read the real heartbeat version, never patch legacy Node.version.
            facts = H.db("const {checkAgentVersion}=await import('./src/integrations/forwardx/agent-version.ts');"
                "const facts=await db.nodeStateReport.findMany({where:{node_id:{in:%s},"
                "reported_at:{gt:new Date(Date.now()-60000)}},select:{node_id:true,version:true,capabilities:true}});"
                "return facts.map(f=>({id:f.node_id,version_ok:checkAgentVersion(f.version,null)===null,"
                "fxp:Array.isArray(f.capabilities)&&['forward.link.fxp.v1','apply_link','remove_link']"
                ".every(c=>f.capabilities.includes(c))}));" % json.dumps(node_ids))
            return (isinstance(facts, list) and {f["id"] for f in facts} == set(node_ids)
                    and all(f["version_ok"] and f["fxp"] for f in facts))
        fxp_ready = H.wait_until(current_link_facts, timeout=60, interval=2)
        H.check(fxp_ready, "ABCD setup all four Agents have fresh reported versions and FXP/apply/remove advertisements")
        if not fxp_ready:
            raise RuntimeError("fresh FXP advertisement prerequisite failed; Link creation not attempted")
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
        stream_ok = tcp_payload(held_a, b"encrypted-A") and tcp_payload(held_b, b"encrypted-B")
        H.check(stream_ok,
                "ABCD shared exit forwards actual encrypted TCP payloads")
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            client.settimeout(0.5)
            client.sendto(b"must-share-A-budget", (H.INGRESS_DATA_IP, 21080))
            try:
                blocked = not bool(client.recvfrom(2048)[0])
            except socket.timeout:
                blocked = True
        H.check(blocked, "ABCD TCP and UDP share one connection ceiling for A")
        datagram_ok = udp_payload(udp_b, 21081, b"encrypted-UDP-B")
        H.check(datagram_ok, "ABCD TCP and UDP use the same business port")
        if not (stream_ok and datagram_ok):
            raise RuntimeError("real TCP/UDP payload prerequisite failed; traffic assertions not run")
        original_udp_source = targets[0].udp.sources.get(b"encrypted-UDP-B")
        def keep_b_alive():
            return (tcp_payload(held_b, b"B-traffic-keepalive")
                    and udp_payload(udp_b, 21081, b"B-traffic-keepalive"))
        initial_traffic = wait_traffic(link_id, [a, b], keepalive=keep_b_alive)
        H.check(all(any(row["forward_id"] == fid and int(row["connections"]) > 0
                        for row in initial_traffic) for fid in (a, b)),
                "ABCD real TCP/UDP payload commits both byte directions and accepted connections")
        replay_traffic(link_id, [a, b], initial_traffic)
        old_a_samples = [row for row in initial_traffic if row["forward_id"] == a]
        initial_b = [row for row in initial_traffic if row["forward_id"] == b]
        before_bytes = traffic_totals(initial_b)
        days = {row["date"] for row in initial_b}
        later_payload = (tcp_payload(held_b, b"B-more-traffic-" * 256)
                         and udp_payload(udp_b, 21081, b"B-more-UDP" * 32))
        H.check(later_payload, "ABCD later real same-day traffic is delivered")
        if not later_payload:
            raise RuntimeError("later payload prerequisite failed")
        later_traffic = wait_traffic(link_id, [b], lambda rows: all(
            total > prior for total, prior in zip(traffic_totals([r for r in rows if r["date"] in days]), before_bytes)),
            keepalive=keep_b_alive)
        H.check(all(total > prior for total, prior in zip(
            traffic_totals([r for r in later_traffic if r["date"] in days]), before_bytes)),
            "ABCD later payload adds to both same-day cumulative directions, not a once-only sample")
        epoch_ids = {row["producer_id"] for row in later_traffic}
        rotated = wait_traffic(link_id, [b], lambda rows: any(
            row["producer_id"] not in epoch_ids and int(row["bytes_in"]) > 0 for row in rows),
            keepalive=keep_b_alive)
        H.check(bool(epoch_ids < {row["producer_id"] for row in rotated}),
                "F1 running FXP changes accounting epoch while retaining committed history")
        H.check(tcp_payload(held_b, b"B-after-accounting-epoch") and
                udp_payload(udp_b, 21081, b"B-udp-after-accounting-epoch") and
                targets[0].udp.sources.get(b"B-udp-after-accounting-epoch") == original_udp_source,
                "F1 accounting rotation preserves held TCP and the exact UDP target socket")
        def reclaimed_epoch():
            current = request("GET", base)
            ingress = next(p for p in current["deployment"]["placements"] if p["role"] == "ingress")
            status = ingress.get("observation", {}).get("traffic_status", {})
            return (status.get("rotation_supported") is True and status.get("producer_count") == 1
                    and status.get("last_ack_at") is not None)
        H.check(bool(H.wait_until(reclaimed_epoch, timeout=60, interval=2)),
                "F1 exact storage ACK reclaims sealed epochs and reports bounded active capacity")
        replay_traffic(link_id, [b], rotated)
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
        retained_a = traffic_rows(link_id, [a])
        retained = all(any(row["producer_id"] == old["producer_id"] and row["date"] == old["date"]
                        and all(int(row[key]) >= int(old[key]) for key in ("bytes_in", "bytes_out", "connections"))
                        for row in retained_a) for old in old_a_samples)
        H.check(retained,
                "ABCD deleting A retains its already-processed producer checkpoints")
        if not retained:
            raise RuntimeError("deleted Forward lost processed checkpoints; no replay can mask this failure")
        replay_traffic(link_id, [a], old_a_samples)
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
        before_restart = wait_traffic(link_id, [b, c])
        old_producers = {row["producer_id"] for row in before_restart if row["forward_id"] == b}
        old_b = [row for row in before_restart if row["forward_id"] == b]
        prior_bytes = traffic_totals(old_b)
        for container in (H.INGRESS_CONTAINER, H.EGRESS_CONTAINER):
            H.docker(["restart", container], timeout=120)
        def restored():
            try:
                with tcp(21081) as client:
                    return tcp_payload(client, b"B-restored")
            except OSError:
                return False
        restored_payload = bool(H.wait_until(restored, timeout=90, interval=2))
        H.check(restored_payload, "ABCD authoritative/private restoration recovers encrypted payload")
        if not restored_payload:
            raise RuntimeError("restart payload prerequisite failed")
        after_restart = wait_traffic(link_id, [b], lambda rows:
            any(row["producer_id"] not in old_producers and int(row["bytes_in"]) > 0
                and int(row["bytes_out"]) > 0 for row in rows)
            and all(total > prior for total, prior in zip(traffic_totals(rows), prior_bytes)))
        H.check(old_producers <= {row["producer_id"] for row in after_restart},
                "ABCD restart creates a new producer epoch and increases totals without resetting old usage")
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
