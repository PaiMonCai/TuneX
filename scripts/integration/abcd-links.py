#!/usr/bin/env python3
"""FXP acceptance on the existing disposable Panel/Worker/four-Agent topology.

No admin-port runtime creation or fake database. Requires abcd-core-gate.sh.
"""
from __future__ import annotations
import importlib.util
import json
import signal
import socket
import struct
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
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
        self.messages = set()
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
                self.messages.add(data)
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


class ProxyEcho(Echo):
    """Actual target accepts PROXY headers and reports only socket test facts."""
    def echo(self, client):
        def exact(length):
            data = b""
            while len(data) < length:
                chunk = client.recv(length - len(data))
                if not chunk:
                    raise OSError("incomplete PROXY target header")
                data += chunk
            return data
        try:
            client.settimeout(4)
            first = exact(6)
            if first == b"PROXY ":
                header = first
                while not header.endswith(b"\r\n"):
                    if len(header) >= 108:
                        raise OSError("oversize PROXY target header")
                    header += exact(1)
                parts = header.decode("ascii").split()
                version, source, source_port = 1, parts[2], int(parts[4])
            else:
                header = first + exact(10)
                if header[:12] != b"\r\n\r\n\x00\r\nQUIT\n" or header[12] != 0x21:
                    raise OSError("unexpected PROXY target header")
                length = struct.unpack("!H", header[14:16])[0]
                if length > 520:
                    raise OSError("oversize PROXY target payload")
                body = exact(length)
                if header[13] == 0x11:
                    source, source_port = socket.inet_ntop(socket.AF_INET, body[:4]), struct.unpack("!H", body[8:10])[0]
                elif header[13] == 0x21:
                    source, source_port = socket.inet_ntop(socket.AF_INET6, body[:16]), struct.unpack("!H", body[32:34])[0]
                else:
                    raise OSError("unsupported PROXY target family")
                version = 2
            stream = client.makefile("rb")
            with stream:
                while not self.stopped.is_set():
                    payload = stream.readline(256)
                    if not payload:
                        return
                    if not payload.endswith(b"\n"):
                        raise OSError("invalid target test payload")
                    response = {"version": version, "source_ip": source, "source_port": source_port,
                        "target": self.port, "payload": payload.decode("ascii").strip()}
                    client.sendall(json.dumps(response).encode() + b"\n")
        except (OSError, ValueError, IndexError, UnicodeError):
            pass
        finally:
            client.close()
            self.clients.discard(client)


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


def multi_target_case(base, fid, target, targets, keep_b_alive):
    """Use real target sockets, heartbeat facts and API revisions, never patched health."""
    primary, backup = targets[2:4]
    policy = {"version": 1, "targets": [{"host": target, "port": 3044}, {"host": target, "port": 3045}],
        "strategy": "fallback", "failure_seconds": 10, "recover_seconds": 10, "probe": "tcp"}

    def edit():
        detail = request("GET", base)
        row = next(f for f in detail["forwards"] if f["id"] == fid)
        request("PUT", base + f"/forwards/{fid}", {"expected_revision": row["config_revision"], "binding": {
            "name": "C target pool", "protocol": "both", "listen_port": 21080, "listen_host": "",
            "target_host": target, "target_port": 3044, "target_set": policy,
            "max_connections": 0, "max_connections_per_ip": 0}})

    def health():
        detail = request("GET", base)
        egress = next(p for p in detail["deployment"]["placements"] if p["role"] == "egress")
        return next((s for s in egress.get("observation", {}).get("target_status", [])
            if s["forward_id"] == fid), None)

    def wait_states(states):
        def predicate():
            if not keep_b_alive():
                raise RuntimeError("unchanged B lost its held TCP or UDP mapping during F2")
            fact = health()
            return fact if fact and fact["states"] == states else False
        return H.wait_until(predicate, timeout=70, interval=2)

    def choose(label):
        payload = label.encode()
        with tcp(21080) as client:
            if not tcp_payload(client, payload):
                raise RuntimeError("F2 TCP payload lost")
        return [server.port for server in (primary, backup) if payload in server.messages]

    edit()
    H.check(next(f for f in request("GET", base)["forwards"] if f["id"] == fid)["target_set"] == policy,
        "F2 complete ordered target policy round-trips through real API and immutable deployment")
    H.check(bool(wait_states(["healthy", "healthy"])), "F2 auxiliary TCP probes report both real target listeners")
    H.check(choose("F2-primary-TCP") == [3044], "F2 fallback selects the primary for a real new TCP connection")
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as mapping:
        H.check(udp_payload(mapping, 21080, b"F2-primary-UDP") and
            b"F2-primary-UDP" in primary.udp.sources, "F2 real UDP mapping starts at the primary")
        primary.stop()
        H.check(bool(wait_states(["unhealthy", "healthy"])), "F2 primary outage is confirmed after the failure window")
        H.check(choose("F2-backup-TCP") == [3045], "F2 new TCP connections fail over to the authorized backup")
        H.check(udp_payload(mapping, 21080, b"F2-backup-UDP") and
            b"F2-backup-UDP" in backup.udp.sources, "F2 same entry UDP session retargets after confirmed primary failure")
        backup_source = backup.udp.sources.get(b"F2-backup-UDP")
        primary = Echo(3044)
        primary.start()
        targets[2] = primary
        H.check(bool(wait_states(["healthy", "healthy"])), "F2 primary is eligible only after the recovery window")
        H.check(choose("F2-recovered-TCP") == [3044], "F2 new TCP uses the recovered primary")
        H.check(udp_payload(mapping, 21080, b"F2-pinned-backup-UDP") and
            backup.udp.sources.get(b"F2-pinned-backup-UDP") == backup_source,
            "F2 recovered primary does not move an established healthy backup UDP socket")
        primary.stop()
        backup.stop()
        H.check(bool(wait_states(["unhealthy", "unhealthy"])), "F2 all failed targets are visible independently of Ready")
        unavailable = False
        try:
            with tcp(21080) as client:
                unavailable = not tcp_payload(client, b"F2-all-failed")
        except (OSError, socket.timeout):
            unavailable = True
        H.check(unavailable, "F2 all failed targets cannot deliver TCP payload")
        egress = next(p for p in request("GET", base)["deployment"]["placements"] if p["role"] == "egress")
        H.check(egress.get("observation", {}).get("ready") is True,
            "F2 target failure does not falsify the carrier listener Ready fact")
        primary, backup = Echo(3044), Echo(3045)
        primary.start()
        backup.start()
        targets[2:4] = [primary, backup]
        H.check(bool(wait_states(["healthy", "healthy"])), "F2 real listeners recover from all-unavailable")
    policy["strategy"] = "round_robin"
    edit()
    picks = [choose(f"F2-round-robin-{i}") for i in range(8)]
    H.check(picks == [[3044], [3045]] * 4, "F2 round-robin deterministically distributes real new TCP connections")
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as mapping:
        first = b"F2-RR-UDP-0"
        H.check(udp_payload(mapping, 21080, first), "F2 round-robin creates a real UDP mapping")
        chosen = next(server for server in (primary, backup) if first in server.udp.sources)
        source = chosen.udp.sources[first]
        H.check(all(udp_payload(mapping, 21080, f"F2-RR-UDP-{i}".encode()) and
            chosen.udp.sources.get(f"F2-RR-UDP-{i}".encode()) == source for i in range(1, 6)),
            "F2 round-robin keeps one UDP source pinned across packets")
    policy["strategy"] = "random"
    edit()
    picks = [choose(f"F2-random-{i}") for i in range(24)]
    H.check(all(len(pick) == 1 and pick[0] in (3044, 3045) for pick in picks),
        "F2 random uses only declared targets for real TCP payloads")
    policy["strategy"] = "fallback"
    edit()
    H.check(keep_b_alive(), "F2 all target policy changes preserve B's held TCP and original UDP socket")


def client_source_case(base, target, targets, rules, keep_b_alive):
    for port in (3052, 3053):
        server = ProxyEcho(port)
        server.start()
        targets.append(server)
    policy = {"version": 1, "targets": [{"host": target, "port": 3052}, {"host": target, "port": 3053}],
        "strategy": "ip_hash", "failure_seconds": 10, "recover_seconds": 10, "probe": "none"}
    source = {"version": 1, "receive_proxy": False, "trusted_cidrs": [], "send_proxy": "v1"}
    binding = {"name": "D trusted TCP source", "protocol": "tcp", "listen_host": "", "listen_port": 21082,
        "target_host": target, "target_port": 3052, "target_set": policy, "client_source": source,
        "max_connections": 0, "max_connections_per_ip": 0}
    fid = request("POST", base + "/forwards", binding)["id"]
    rules.append(fid)

    def row():
        return next(f for f in request("GET", base)["forwards"] if f["id"] == fid)

    def edit():
        request("PUT", base + f"/forwards/{fid}", {"expected_revision": row()["config_revision"], "binding": binding})

    def exchange(client, label):
        client.sendall(label.encode() + b"\n")
        data = b""
        while not data.endswith(b"\n"):
            chunk = client.recv(1024)
            if not chunk or len(data) > 2048:
                raise OSError("source target did not return bounded facts")
            data += chunk
        return json.loads(data)

    def proxy_header(ip, port, version):
        if version == 1:
            return f"PROXY TCP4 {ip} 192.0.2.10 {port} 443\r\n".encode()
        return (b"\r\n\r\n\x00\r\nQUIT\n" + bytes([0x21, 0x11]) + struct.pack("!H", 12)
            + socket.inet_aton(ip) + socket.inet_aton("192.0.2.10") + struct.pack("!HH", port, 443))

    def connected(ip, port, version):
        client = tcp(21082)
        client.sendall(proxy_header(ip, port, version))
        return client

    with tcp(21082) as client:
        socket_source, socket_port = client.getsockname()
        fact = exchange(client, "socket-source")
        H.check(fact["version"] == 1 and fact["source_ip"] == socket_source and fact["source_port"] == socket_port,
            "F3 target receives actual ingress socket source via configured PROXY v1")
    H.check(row()["client_source"] == source, "F3 complete source policy round-trips through the real API")
    omitted = dict(binding)
    del omitted["client_source"]
    omitted["target_set"] = dict(policy, strategy="fallback")
    status, _, _ = H.req("PUT", base + f"/forwards/{fid}", {"expected_revision": row()["config_revision"], "binding": omitted})
    H.check(status == 409, "F3 old client cannot silently drop an existing source policy")
    unsupported = dict(binding, protocol="both")
    status, _, _ = H.req("PUT", base + f"/forwards/{fid}", {"expected_revision": row()["config_revision"], "binding": unsupported})
    H.check(status == 400, "F3 unsupported UDP/both source combinations are rejected before deployment")
    source.update(receive_proxy=True, trusted_cidrs=[socket_source + "/32"], send_proxy="v2")
    edit()
    chosen = {}
    for ip in ("198.51.100.2", "198.51.100.3"):
        picks = []
        for i in range(4):
            with connected(ip, 32001 + i, 1 if i % 2 else 2) as client:
                fact = exchange(client, "source-hash")
                if fact["version"] != 2 or fact["source_ip"] != ip or fact["source_port"] != 32001 + i:
                    raise RuntimeError("configured v2 PROXY target source did not match attestation")
                picks.append(fact["target"])
        H.check(len(set(picks)) == 1, "F3 trusted client IP keeps the same target across source-port changes: " + ip)
        chosen[ip] = picks[0]
    H.check(len(set(chosen.values())) == 2, "F3 two trusted client addresses use different authorized IP_HASH targets")
    binding["max_connections_per_ip"] = 1
    edit()
    a, b = connected("198.51.100.2", 32101, 1), connected("198.51.100.3", 32102, 2)
    try:
        exchange(a, "held-source-A")
        exchange(b, "held-source-B")
        H.check(True, "F3 separate client-source budgets admit two clients behind one trusted proxy")
        denied = False
        try:
            with connected("198.51.100.2", 32103, 1) as extra:
                exchange(extra, "denied-source")
        except OSError:
            denied = True
        H.check(denied, "F3 original-source connection ceiling rejects a second same-IP client")
    finally:
        a.close()
        b.close()
    source["trusted_cidrs"] = ["192.0.2.0/24"]
    edit()
    denied = False
    try:
        with connected("198.51.100.2", 32001, 1) as client:
            exchange(client, "untrusted-source")
    except OSError:
        denied = True
    H.check(denied, "F3 non-trusted socket peer cannot inject an otherwise valid PROXY header")
    source["trusted_cidrs"] = [socket_source + "/32"]
    binding["max_connections_per_ip"] = 0
    edit()
    H.check(keep_b_alive(), "F3 source-policy revisions keep unrelated B's TCP and exact UDP target socket")

    def restored_source():
        try:
            with connected("198.51.100.2", 32001, 2) as client:
                fact = exchange(client, "source-after-restart")
                return fact["version"] == 2 and fact["source_ip"] == "198.51.100.2" and fact["target"] == chosen["198.51.100.2"]
        except OSError:
            return False
    return restored_source


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


def maintenance_preview(base, link_id, held_a, held_b, udp_b, target, original_udp_source):
    """F5 preview uses real API/DB/runtime without changing any desired owner."""
    detail = request("GET", base)
    input_data = {"expected_version": detail["desired_version"], "expected_generation": detail["generation"],
                  "change": {"type": "rotate_key"}}
    # Deliberately exclude traffic counters, report timestamps and lease renewal:
    # these continue legitimately while a read-only preview is open.
    def durable_state():
        return H.db("return {link:await db.linkResource.findUnique({where:{id:%d},"
                    "select:{id:true,status:true,desired_version:true,generation:true}}),"
                    "versions:await db.linkVersion.count({where:{link_id:%d}}),"
                    "deployments:await db.linkDeployment.count({where:{link_id:%d}}),"
                    "credentials:await db.linkTransportCredential.count({where:{link_id:%d}}),"
                    "forwards:await db.tunnel.findMany({where:{link_resource_id:%d},orderBy:{id:'asc'},"
                    "select:{id:true,name:true,config_revision:true,applied_revision:true,desired_revision_id:true,desired_status:true,"
                    "ingress_node_id:true,egress_node_id:true,listen_ip:true,listen_port:true,forward_protocol:true,"
                    "remote_host:true,remote_port:true,bytes_per_second_in:true,bytes_per_second_out:true,"
                    "max_connections:true,max_connections_per_ip:true,link_target_config:true,link_source_config:true}}),"
                    "revisions:await db.forwardRevision.findMany({where:{link_resource_id:%d},orderBy:{id:'asc'},"
                    "select:{id:true,tunnel_id:true,revision:true,desired_status:true,protocol:true,listen_ip:true,listen_port:true,"
                    "ingress_node_id:true,egress_node_id:true,targets:true,link_target_config:true,link_source_config:true,"
                    "bytes_per_second_in:true,bytes_per_second_out:true,max_connections:true,max_connections_per_ip:true}}),"
                    "leases:await db.nodePortLease.findMany({where:{link_id:%d,status:'active'},"
                    "select:{id:true,node_id:true,port:true,protocol:true,bind_scope:true},orderBy:{id:'asc'}})};"
                    % (link_id, link_id, link_id, link_id, link_id, link_id, link_id))
    before = durable_state()
    status, response, headers = H.req("POST", base + "/maintenance/preview", input_data)
    if status != 200 or not isinstance(response.get("data"), dict):
        raise RuntimeError("F5 preview HTTP failed: status=%d" % status)
    rotation = response["data"]
    H.check(headers.get("cache-control") == "no-store", "F5 preview response is not cacheable")
    unauthenticated, _, _ = H.req("POST", base + "/maintenance/preview", input_data, cookie="", retry_auth=False)
    H.check(unauthenticated == 401, "F5 preview rejects unauthenticated requests")
    H.check(rotation.get("schema_version") == 1 and rotation.get("operation") == "rotate_key"
            and rotation.get("execution", {}).get("supported") is False
            and rotation.get("ports", {}).get("reserved") is False
            and rotation.get("ports", {}).get("availability") == "not_checked"
            and rotation.get("runtime", {}).get("tcp_connections", "missing") is None
            and rotation.get("runtime", {}).get("udp_mappings", "missing") is None,
            "F5 real preview does not invent live concurrency, execution or port availability")
    H.check(rotation.get("references", {}).get("total") == len(detail["forwards"])
            and {row["id"] for row in rotation["references"]["forwards"]} == {row["id"] for row in detail["forwards"]},
            "F5 real preview includes the complete referenced Forward set")
    def secret_free(value):
        if isinstance(value, dict):
            return not ({"key", "secret", "secret_enc", "runner_config", "binding_snapshot"} & set(value)) and all(
                secret_free(item) for item in value.values())
        return not isinstance(value, list) or all(secret_free(item) for item in value)
    H.check(secret_free(rotation), "F5 public preview excludes credentials and runner configurations")
    move_input = {**input_data, "change": {"type": "update_endpoints",
        "config": {**detail["config"], "carrier_port": detail["config"]["carrier_port"] + 1}}}
    moved = request("POST", base + "/maintenance/preview", move_input)
    H.check(moved["changes"]["carrier_port_changed"] is True
            and moved["snapshot"]["state_token"] != rotation["snapshot"]["state_token"]
            and moved["candidate"]["version"] == detail["desired_version"] + 1,
            "F5 endpoint preview fences the requested change without allocating a version")
    for field in ("expected_version", "expected_generation"):
        bad = {**input_data, field: input_data[field] + 1}
        status, payload, _ = H.req("POST", base + "/maintenance/preview", bad)
        expected_code = "link_version_conflict" if field == "expected_version" else "link_generation_conflict"
        H.check(status == 409 and payload.get("code") == expected_code, "F5 stale " + field + " is rejected")
    edit_status, edit_payload, _ = H.req("PUT", base + "/config", {
        "expected_version": detail["desired_version"], "config": move_input["change"]["config"]})
    rotate_status, rotate_payload, _ = H.req("POST", base + "/rotate-key")
    H.check(edit_status == 409 and edit_payload.get("code") == "link_has_references"
            and rotate_status == 409 and rotate_payload.get("code") == "link_has_references",
            "F5 preview does not unlock unsafe live endpoint edits or key rotation")
    H.check(durable_state() == before, "F5 previews leave resource, rules/revisions, versions, credentials, deployments and held leases unchanged")
    marker = b"F5-unchanged-UDP-B"
    H.check(tcp_payload(held_a, b"F5-unchanged-TCP-A") and tcp_payload(held_b, b"F5-unchanged-TCP-B")
            and udp_payload(udp_b, 21081, marker) and target.udp.sources.get(marker) == original_udp_source,
            "F5 previews preserve both held TCP sessions and the exact B UDP target socket")
    maintenance_intent(base, link_id, input_data, durable_state, held_a, held_b, udp_b, target, original_udp_source)


def maintenance_intent(base, link_id, preview_input, durable_state, held_a, held_b, udp_b, target, original_udp_source):
    """Actual Panel/MySQL/Worker intent lifecycle; no fake reports or candidate dispatch."""
    def ready_preview():
        value = request("POST", base + "/maintenance/preview", preview_input)
        return value if value["runtime"]["state"] == "ready" else None

    if not H.wait_until(ready_preview, timeout=60, interval=2):
        raise RuntimeError("F5 fresh Ready preview prerequisite failed")
    preview = ready_preview()
    if not preview or preview.get("submission", {}).get("supported") is not True:
        raise RuntimeError("F5 signed fresh Ready preview prerequisite failed")
    body = {**preview_input, "idempotency_key": str(uuid.uuid4()), "receipt": preview["snapshot"]["receipt"]}
    endpoint = base + "/maintenance/migrations"
    before = durable_state()
    count = lambda: H.db("return await db.linkMaintenanceMigration.count({where:{link_id:%d}});" % link_id)
    before_count = count()
    forged = {**body, "receipt": body["receipt"][:-1] + ("1" if body["receipt"][-1] == "0" else "0")}
    status, payload, headers = H.req("POST", endpoint, forged)
    H.check(status == 409 and payload.get("code") == "link_maintenance_preview_invalid"
            and headers.get("cache-control") == "no-store" and count() == before_count,
            "F5 forged freshness receipt fails without a durable write")
    migration_id = None
    try:
        # urllib requests use the same authenticated fixture identity, not a mock DB publisher.
        with ThreadPoolExecutor(max_workers=3) as pool:
            replies = list(pool.map(lambda _: H.req("POST", endpoint, body), range(3)))
        accepted = [reply[1].get("data", {}) for reply in replies]
        if not accepted or not isinstance(accepted[0].get("migration"), dict):
            raise RuntimeError("F5 concurrent submission failed: status=%s" % [r[0] for r in replies])
        migration_id = accepted[0]["migration"]["id"]
        row = accepted[0]["migration"]
        H.check(sorted(r[0] for r in replies) == [200, 200, 201]
                and all(r[2].get("cache-control") == "no-store" for r in replies)
                and all(v.get("migration", {}).get("id") == migration_id for v in accepted)
                and sum(v.get("replayed") is False for v in accepted) == 1,
                "F5 concurrent exact retry creates one intent and returns two canonical replays")
        private = H.db("const r=await db.linkMaintenanceMigration.findUniqueOrThrow({where:{id:%d}});"
            "const {canonicalConfigDigest}=await import('./src/integrations/forwardx/core-contract.ts');"
            "return {count:await db.linkMaintenanceMigration.count({where:{link_id:%d}}),"
            "events:await db.linkMaintenanceEvent.count({where:{migration_id:r.id}}),"
            "fence:r.active_link_id===r.link_id,digest:r.snapshot_digest,"
            "valid:canonicalConfigDigest(r.snapshot)===r.snapshot_digest,refs:r.snapshot.admission.references.length};"
            % (migration_id, link_id))
        H.check(private["count"] == before_count + 1 and private["events"] == 1 and private["fence"]
                and private["valid"] and private["refs"] == row["references"]["total"]
                and row["status"] == "awaiting_executor" and row["state_version"] == 1
                and row["execution"]["supported"] is False and row["ports"] == {"reserved": False, "availability": "not_checked"},
                "F5 MySQL records one immutable snapshot/event and a logical fence, not candidate execution or ports")
        public = request("GET", endpoint + "/%d" % migration_id)
        forbidden = {"snapshot", "receipt", "idempotency_key", "request_digest", "binding_snapshot", "runner_config",
                     "key", "secret", "secret_enc", "target_host", "target_port", "target_set", "client_source"}
        def closed_metadata(value):
            if isinstance(value, dict):
                return not forbidden.intersection(value) and all(closed_metadata(v) for v in value.values())
            return not isinstance(value, list) or all(closed_metadata(v) for v in value)
        H.check(closed_metadata(public) and len(public["events"]) == 1
                and any(r["id"] == migration_id for r in request("GET", endpoint)),
                "F5 history exposes scoped closed metadata, never private references or receipts")
        for altered, code in (({**body, "idempotency_key": str(uuid.uuid4())}, "link_maintenance_in_progress"),
                              ({**body, "receipt": forged["receipt"]}, "link_maintenance_idempotency_conflict")):
            status, payload, _ = H.req("POST", endpoint, altered)
            H.check(status == 409 and payload.get("code") == code, "F5 concurrent intent rejects " + code)
        detail = request("GET", base)
        forward = detail["forwards"][0]
        binding = {"name": forward["name"], "protocol": forward["forward_protocol"],
                   "listen_port": forward["listen_port"], "listen_host": "", "target_host": forward["remote_host"],
                   "target_port": forward["remote_port"], "max_connections": forward["max_connections"],
                   "max_connections_per_ip": forward["max_connections_per_ip"]}
        changes = [("POST", base + "/forwards", {**binding, "name": "fenced addition", "listen_port": 21089}),
                   ("PUT", base + "/forwards/%d" % forward["id"], {"expected_revision": forward["config_revision"], "binding": binding}),
                   ("PUT", base + "/config", {"expected_version": detail["desired_version"], "config": detail["config"]}),
                   ("POST", base + "/deploy", None), ("POST", base + "/rotate-key", None), ("DELETE", base, None)]
        changes += [("POST", base + "/forwards/%d/actions" % forward["id"], {"action": action})
                    for action in ("suspend", "resume", "retry", "delete")]
        fenced = [H.req(method, path, value) for method, path, value in changes]
        H.check(all(status == 409 and value.get("code") == "link_maintenance_in_progress" for status, value, _ in fenced)
                and durable_state() == before, "F5 logical fence blocks every conflicting writer before revisions or runtime ownership change")
        H.docker(["restart", "tunex-it-worker"], timeout=120)
        # Invoke the same production recovery service deterministically, rather than claiming a cron tick occurred.
        recovery = H.db("const {reconcileLinkMaintenance}=await import('./src/services/link-maintenance.ts');"
                        "try{return await reconcileLinkMaintenance();}finally{"
                        "const {redis}=await import('./src/redis.ts');redis.disconnect();"
                        "const {db:serviceDb}=await import('./src/db.ts');await serviceDb.$disconnect();}")
        recovered = request("GET", endpoint + "/%d" % migration_id)
        immutable = H.db("const r=await db.linkMaintenanceMigration.findUniqueOrThrow({where:{id:%d}});"
                         "return {digest:r.snapshot_digest,events:await db.linkMaintenanceEvent.count({where:{migration_id:r.id}})};" % migration_id)
        H.check(recovery["errors"] == 0 and recovered["status"] == "awaiting_executor"
                and immutable == {"digest": private["digest"], "events": 1} and durable_state() == before,
                "F5 Worker restart plus real recovery retains the healthy immutable intent without redeployment")
        status, payload, _ = H.req("POST", endpoint + "/%d/cancel" % migration_id, {"expected_state_version": 2})
        H.check(status == 409 and payload.get("code") == "link_maintenance_state_conflict", "F5 cancel rejects a wrong state CAS")
        cancelled = request("POST", endpoint + "/%d/cancel" % migration_id, {"expected_state_version": 1})
        repeated = request("POST", endpoint + "/%d/cancel" % migration_id, {"expected_state_version": 1})
        replay = request("POST", endpoint, body)
        terminal = H.db("const r=await db.linkMaintenanceMigration.findUniqueOrThrow({where:{id:%d}});"
                        "return {fence:r.active_link_id,events:await db.linkMaintenanceEvent.count({where:{migration_id:r.id}})};" % migration_id)
        H.check(cancelled == repeated and cancelled["status"] == "cancelled" and cancelled["state_version"] == 2
                and replay["replayed"] is True and replay["migration"] == cancelled
                and terminal == {"fence": None, "events": 2} and durable_state() == before,
                "F5 cancellation is CAS/idempotent, releases only the intent fence, and old submission never reopens it")
        marker = b"F5-intent-UDP-B"
        H.check(tcp_payload(held_a, b"F5-intent-TCP-A") and tcp_payload(held_b, b"F5-intent-TCP-B")
                and udp_payload(udp_b, 21081, marker) and target.udp.sources.get(marker) == original_udp_source,
                "F5 save/replay/recovery/cancel preserve both held TCP sessions and the exact B UDP target socket")
    finally:
        if migration_id is not None:
            status, payload, _ = H.req("GET", endpoint + "/%d" % migration_id)
            if status == 200 and payload.get("data", {}).get("status") == "awaiting_executor":
                request("POST", endpoint + "/%d/cancel" % migration_id, {"expected_state_version": payload["data"]["state_version"]})


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
                ".every(c=>f.capabilities.includes(c))&&f.capabilities.includes('forward.targets.fxp.v1')&&f.capabilities.includes('forward.client-source.fxp.v1')}));" % json.dumps(node_ids))
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
        for port in (3042, 3043, 3044, 3045):
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
        maintenance_preview(base, link_id, held_a, held_b, udp_b, targets[0], original_udp_source)
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
        def unchanged_b():
            payload = b"F2-B-unchanged"
            return (tcp_payload(held_b, payload) and udp_payload(udp_b, 21081, payload) and
                targets[0].udp.sources.get(payload) == original_udp_source)
        multi_target_case(base, c, target, targets, unchanged_b)
        restored_source = client_source_case(base, target, targets, rules, unchanged_b)
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
        with tcp(21080) as client:
            H.check(tcp_payload(client, b"F2-pool-after-agent-restart") and
                b"F2-pool-after-agent-restart" in targets[2].messages,
                "F2 Agent restart restores the full target policy and real primary payload")
        if not restored_payload:
            raise RuntimeError("restart payload prerequisite failed")
        H.check(bool(H.wait_until(restored_source, timeout=60, interval=2)),
                "F3 Agent restart restores the full source policy and real IP_HASH/PROXY payload")
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
