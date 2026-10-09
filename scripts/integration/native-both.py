#!/usr/bin/env python3
"""F4 native TCP+UDP via real Panel API, worker and disposable Linux Agents.

No fake runtime facts, direct admin activation or manual port-lease release.
"""
from __future__ import annotations
import importlib.util
import json
import re
import signal
import socket
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("f4_shared_harness", HERE / "abcd-links.py")
if spec is None or spec.loader is None:
    raise SystemExit("cannot load real network harness")
A = importlib.util.module_from_spec(spec)
spec.loader.exec_module(A)
H, C = A.H, A.C
RESULT = HERE / "evidence" / "native-both-result.txt"


def agent_sh(command, allow=False):
    # The shared harness exposes docker(), not an Agent-specific shell API.
    return H.docker(["exec", H.INGRESS_CONTAINER, "sh", "-c", command], allow=allow)


def safe_code(value):
    return value if isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", value) else "unknown"


def retarget_facts(fid, target_port):
    # Only bounded boolean/numeric facts leave the disposable DB, never raw
    # reports, target addresses, command configs, error strings or credentials.
    return H.db("""const t=await db.tunnel.findUnique({where:{id:%d}});
      const s=t.desired_revision_id?await db.forwardRevision.findUnique({where:{id:t.desired_revision_id}}):null;
      const reports=await db.nodeStateReport.findMany({where:{node_id:{in:[t.ingress_node_id,t.egress_node_id].filter(Boolean)}}});
      return {config_revision:t.config_revision,applied_revision:t.applied_revision,
        snapshot_revision:s?.revision,snapshot_target_matches:s?.target_port===%d || s?.targets?.[0]?.port===%d,
        runtimes:reports.flatMap(r=>(Array.isArray(r.tunnels)?r.tunnels:r.tunnels?.tunnels??[])
          .filter(c=>['tunex-%d-direct','tunex-%d-relay','tunex-%d-egress'].includes(c.id))
          .map(c=>({mode:['DIRECT','RELAY','EGRESS'].includes(c.mode)?c.mode:'unknown',
            revision:Number.isSafeInteger(c.revision)?c.revision:null,both:c.protocol==='both',
            target_matches:c.remote_port===%d || c.targets?.[0]?.port===%d})))};
      """ % (fid, target_port, target_port, fid, fid, fid, target_port, target_port))


def request(method, path, body=None):
    status, response, _ = H.req(method, path, body)
    if status not in (200, 201):
        # Keep the actual admission/apply code, not just the HTTP wrapper. Do
        # not publish raw responses, Agent config, credentials or error text.
        def code(key):
            value = response.get(key)
            return value if isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", value) else "unknown"
        message = str(response.get("error", response.get("message", "")))
        markers = [value for value in (
            "address already in use", "unsupported_protocol", "revision_mismatch",
            "stale_revision", "ownership", "lease_expired", "port_conflict",
            "payload_invalid", "invariant_violated", "native_both", "next_hop",
        ) if value in message]
        raise RuntimeError(f"{method} {path}: status={status} code={code('code')} "
                           f"apply_error_code={code('apply_error_code')} markers={markers}")
    return H.unwrap(response)


def create(name, port, target, mode="direct", **policy):
    row = {"name": f"{H.FIXTURE_PREFIX}-F4-{name}", "protocol": "both", "mode": mode,
           "ingress_node_id": H.ING, "listen_port": port, "target_host": target,
           "target_port": 3050, **policy}
    if mode == "relay":
        row["egress_node_id"] = H.EGR
    return request("POST", "/api/forwards", row)["id"]


def payload(port, marker=b"F4-native", timeout=2):
    try:
        with socket.create_connection((H.INGRESS_DATA_IP, port), timeout=timeout) as client:
            client.settimeout(timeout)
            tcp_ok = A.tcp_payload(client, marker + b"-tcp")
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            client.settimeout(timeout)
            client.sendto(marker + b"-udp", (H.INGRESS_DATA_IP, port))
            udp_ok = client.recv(256) == marker + b"-udp"
        return tcp_ok and udp_ok
    except OSError:
        return False


def no_payload(port):
    tcp_ok = False
    try:
        with socket.create_connection((H.INGRESS_DATA_IP, port), timeout=0.5) as client:
            client.settimeout(0.5)
            tcp_ok = A.tcp_payload(client, b"F4-must-not-serve")
    except OSError:
        pass
    udp_ok = False
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            client.settimeout(0.5)
            client.sendto(b"F4-must-not-serve", (H.INGRESS_DATA_IP, port))
            udp_ok = client.recv(256) == b"F4-must-not-serve"
    except OSError:
        pass
    return not tcp_ok and not udp_ok


def native_cases():
    rules, servers = [], []
    fault_pid = "/tmp/tunex-f4-foreign-udp.pid"
    fault_running = False
    try:
        H.setup()
        H.mysql("UPDATE capability_policy SET tunnel_types=JSON_ARRAY('tcp','tls','ws','udp'),revision=revision+1;")
        H.check(request("GET", "/api/forwards/capabilities")["native_both_enabled"] is True,
                "F4 authenticated capability discovery reads the disposable default-off opt-in")
        def fresh_caps():
            facts = H.db("return await db.nodeStateReport.findMany({where:{node_id:{in:[%d,%d]},"
                "reported_at:{gt:new Date(Date.now()-60000)}},select:{node_id:true,capabilities:true,capability_manifest:true}});" % (H.ING, H.EGR))
            return len(facts) == 2 and all("forward.protocol.both.native.v1" in (f["capabilities"] or [])
                and "both" in (f["capability_manifest"] or {}).get("protocols", [])
                and "mixed" in (f["capability_manifest"] or {}).get("transports", []) for f in facts)
        H.check(bool(H.wait_until(fresh_caps, timeout=90, interval=2)),
                "F4 both endpoints advertise fresh actual native both/mixed support")
        targets = {"direct": C.runner_data_ip(), "relay": C.runner_egress_ip()}
        if not all(targets.values()):
            raise RuntimeError("no echo address on both disposable data networks")
        for port in (3050, 3051):
            server = A.Echo(port)
            server.start()
            servers.append(server)
        for mode, port in (("direct", 21086), ("relay", 21087)):
            fid = create(mode, port, targets[mode], mode)
            rules.append(fid)
            H.check(H.wait_active(fid) and bool(H.wait_until(lambda: payload(port), timeout=60, interval=2)),
                    f"F4 {mode} real TCP and UDP serve the same number after complete apply")
            detail = request("GET", f"/api/forwards/{fid}")
            H.check(detail["protocol"] == "both" and detail["transport"] == "mixed",
                    f"F4 {mode} canonical both identity is not projected as TCP or UDP")
            body = {"target_port": 3051, "expected_revision": detail["config_revision"]}
            preview = request("POST", f"/api/forwards/{fid}/preview", body)
            H.check(preview.get("impact", {}).get("listener_replacement") is True,
                    f"F4 {mode} target edit does not promise single-lane hot swap")
            request("PATCH", f"/api/forwards/{fid}", body)
            marker = f"F4-{mode}-retarget".encode()
            active = H.wait_active(fid)
            forwarded = bool(H.wait_until(lambda: payload(port, marker), timeout=60, interval=2))
            tcp_new, udp_new = marker+b"-tcp" in servers[1].messages, marker+b"-udp" in servers[1].udp.sources
            evidence = ""
            if not (active and forwarded and tcp_new and udp_new):
                facts = {"active": active, "payload": forwarded, "tcp_new": tcp_new, "udp_new": udp_new,
                         "tcp_old": marker+b"-tcp" in servers[0].messages, "udp_old": marker+b"-udp" in servers[0].udp.sources,
                         "runtime": retarget_facts(fid, 3051)}
                evidence = " facts=" + json.dumps(facts, sort_keys=True)
            H.check(active and forwarded and tcp_new and udp_new,
                    f"F4 {mode} target revision moves both actual protocols together" + evidence)
            request("POST", f"/api/forwards/{fid}/suspend")
            H.check(bool(H.wait_until(lambda: no_payload(port), timeout=90, interval=2)),
                    f"F4 {mode} suspend stops both lanes")
            request("POST", f"/api/forwards/{fid}/resume")
            H.check(H.wait_active(fid) and bool(H.wait_until(lambda: payload(port), timeout=90, interval=2)),
                    f"F4 {mode} resume restores both lanes")

        budget = create("shared-budget", 21088, targets["direct"], max_connections=2, max_connections_per_ip=2)
        rules.append(budget)
        if not H.wait_active(budget):
            raise RuntimeError("shared budget fixture did not apply")
        with A.tcp(21088) as held, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as mapping:
            H.check(A.tcp_payload(held, b"F4-held-TCP") and A.udp_payload(mapping, 21088, b"F4-held-UDP"),
                    "F4 one TCP connection and one UDP mapping consume the two mixed slots")
            refused = False
            try:
                with A.tcp(21088) as extra:
                    extra.settimeout(1)
                    refused = not A.tcp_payload(extra, b"F4-third-slot")
            except OSError:
                refused = True
            H.check(refused, "F4 mixed total/per-IP budget is not multiplied per protocol")
        diag_ok = H.wait_until(lambda: C.tunnel_diag(budget).get("protocol") == "both"
                              and C.tunnel_diag(budget).get("mappings", 0) >= 1, timeout=60, interval=2)
        H.check(bool(diag_ok), "F4 both diagnostic preserves separate real UDP mapping facts")

        # Foreign process is fault injection, NOT a manager/API activation. It
        # deliberately holds only UDP; failed native TCP preparation must close.
        H.docker(["exec", "-d", H.INGRESS_CONTAINER, "sh", "-c",
                  f"echo $$ > {fault_pid}; exec nc -u -l -p 21090"])
        fault_running = True
        H.check(bool(H.wait_until(lambda: ":21090" in agent_sh("netstat -uln"), timeout=10, interval=1)),
                "F4 OS fault injection holds only the candidate UDP socket")
        # Move an already serving rule onto the genuinely occupied port. This
        # exercises Panel compensation and the Agent's removal tombstone, not
        # only the manager's local failed-bind cleanup on a new rule.
        before = request("GET", f"/api/forwards/{rules[0]}")
        status, response, _ = H.req("PATCH", f"/api/forwards/{rules[0]}",
            {"listen_port": 21090, "expected_revision": before["config_revision"]})
        H.check(status == 502 and response.get("code") == "apply_failed",
                "F4 real foreign UDP socket rejects an existing both rule's listener move")
        restored = request("GET", f"/api/forwards/{rules[0]}")
        active = H.wait_active(rules[0])
        forwarded = bool(H.wait_until(lambda: payload(21086), timeout=60, interval=2))
        restored_ok = (restored["listen_port"] == 21086
                       and restored["config_revision"] > before["config_revision"] + 1 and active and forwarded)
        evidence = "" if restored_ok else " facts=" + json.dumps({
            "original_port": restored["listen_port"] == 21086, "before_revision": before["config_revision"],
            "restored_revision": restored["config_revision"], "active": active, "payload": forwarded,
            "apply_error_code": safe_code(restored.get("apply_error_code")),
            "request_error_code": safe_code(response.get("apply_error_code"))}, sort_keys=True)
        H.check(restored_ok, "F4 failed listener move restores both baseline lanes above the removal fence" + evidence)
        H.check(no_payload(21090), "F4 compensated candidate leaves no half-serving TCP listener")
        status, response, _ = H.req("POST", "/api/forwards", {
            "name": f"{H.FIXTURE_PREFIX}-F4-half-bind", "protocol": "both", "mode": "direct",
            "ingress_node_id": H.ING, "listen_port": 21090, "target_host": targets["direct"], "target_port": 3050})
        # Creation is synchronous: the bind refusal is a 502 with the persisted
        # rule ID, not a successful activation. Retry that ID through normal API.
        half = H.unwrap(response).get("id")
        if not isinstance(half, int):
            raise RuntimeError(f"half-bind has no persisted rule: status={status} code={safe_code(response.get('code'))}")
        rules.append(half)
        failed = H.wait_until(lambda: H.tunnel_row(half).split("|")[0] == "error", timeout=90, interval=2)
        H.check(status == 502 and response.get("code") == "apply_failed" and bool(failed) and no_payload(21090),
                "F4 failed UDP bind cannot leave TCP serving or ACK a full apply")
        H.check(payload(21086) and payload(21087), "F4 half-bind failure leaves unrelated complete rules serving")
        agent_sh(f"kill $(cat {fault_pid}); rm -f {fault_pid}")
        fault_running = False
        request("POST", f"/api/forwards/{half}/retry")
        H.check(H.wait_active(half) and bool(H.wait_until(lambda: payload(21090), timeout=90, interval=2)),
                "F4 normal retry succeeds after the real foreign socket closes")

        for container in (H.INGRESS_CONTAINER, H.EGRESS_CONTAINER):
            H.docker(["restart", container], timeout=120)
        H.check(bool(H.wait_until(lambda: payload(21086) and payload(21087), timeout=120, interval=2)),
                "F4 Agent restart restores DIRECT and RELAY both including the UDP authorized hop peer")
        for fid, port in ((rules[0], 21086), (rules[1], 21087)):
            request("DELETE", f"/api/forwards/{fid}")
            rules.remove(fid)
            H.check(bool(H.wait_until(lambda: no_payload(port), timeout=90, interval=2)),
                    f"F4 delete removes both payload lanes on {port}")
            reuse = create(f"reuse-{port}", port, targets["direct"])
            rules.append(reuse)
            H.check(H.wait_active(reuse) and payload(port),
                    f"F4 deletion releases the exact numeric TCP+UDP port {port} through normal leases")
    finally:
        if fault_running:
            agent_sh(f"test ! -f {fault_pid} || kill $(cat {fault_pid}); rm -f {fault_pid}", allow=True)
        for fid in list(rules):
            status, _, _ = H.req("DELETE", f"/api/forwards/{fid}")
            if status not in (200, 404):
                H.record(False, f"F4 cleanup API delete failed id={fid} status={status}")
        for server in servers:
            server.stop()


def main():
    signal.signal(signal.SIGALRM, H.alarm)
    signal.setitimer(signal.ITIMER_REAL, 650)
    H.acquire_lock()
    try:
        native_cases()
    except Exception as exc:
        H.record(False, f"F4 native acceptance: {type(exc).__name__}: {exc}")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        RESULT.write_text("# F4 real native both acceptance\n" + "\n".join(H.RESULTS) +
                          f"\nPASS={H.PASS} FAIL={H.FAIL}\n", encoding="utf-8")
        H.release_lock()
    return 1 if H.FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
