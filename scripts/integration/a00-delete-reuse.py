#!/usr/bin/env python3
"""A00 deletion/cleanup/port-reuse gate on the real TuneX integration topology.

Prerequisite: scripts/integration/setup.sh.

This file intentionally reuses protocol-suite.py as the real API/DB/Agent harness.
It adds lifecycle evidence that the broad protocol regressions did not pin:
- TCP DIRECT and RELAY payload before deletion;
- DELETE is not complete until listener/runtime/active leases disappear;
- the exact ingress port can then be reused by a new Forward;
- the replacement carries a real payload;
- deleting an already deleted Forward is a bounded not_found, not a second mutation.

No Agent admin API, mock DB, or direct runtime creation is used.
"""
from __future__ import annotations

import importlib.util
import json
import os
import signal
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "evidence"
OUT.mkdir(exist_ok=True)
RESULT = OUT / "a00-delete-reuse-result.txt"
TRACE = OUT / "a00-delete-reuse-http.json"
START = time.monotonic()
OVERALL_SECONDS = int(os.environ.get("A00_DELETE_REUSE_SECONDS", "1200"))


def _load_harness():
    spec = importlib.util.spec_from_file_location("a00_protocol_harness", HERE / "protocol-suite.py")
    if spec is None or spec.loader is None:
        raise SystemExit("cannot load scripts/integration/protocol-suite.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


H = _load_harness()


def check(condition, message: str, detail: str = "") -> None:
    H.check(condition, message, detail)


def runtime_absent(fid: int) -> bool:
    prefix = f"tunex-{fid}-"
    for node_id in (H.ING, H.EGR):
        raw = H.scalar(
            "SELECT IFNULL(tunnels,'[]') FROM node_state_report WHERE node_id=%d;" % node_id
        )
        try:
            rows = json.loads(raw or "[]")
        except json.JSONDecodeError:
            return False
        for row in rows:
            if isinstance(row, dict) and str(row.get("id", "")).startswith(prefix):
                return False
    return True


def active_lease_count(node_id: int, port: int) -> int:
    raw = H.scalar(
        "SELECT COUNT(*) FROM node_port_lease "
        f"WHERE node_id={int(node_id)} AND port={int(port)} AND status='active';"
    )
    return int(raw or 0)


def tunnel_exists(fid: int) -> bool:
    return H.scalar(f"SELECT COUNT(*) FROM tunnel WHERE id={int(fid)};") != "0"


def create_tcp(name: str, mode: str, *, listen_port: int | None = None):
    body: dict = {
        "name": f"{H.FIXTURE_PREFIX}-A00-{name}",
        "mode": mode,
        "protocol": "tcp",
        "ingress_node_id": H.ING,
        "target_host": "target-a",
        "target_port": H.ECHO_TARGET_PORT,
    }
    if listen_port is not None:
        body["listen_port"] = int(listen_port)
    if mode == "relay":
        body["egress_node_id"] = H.EGR
    status, resp, _ = H.req("POST", "/api/forwards", body)
    data = H.unwrap(resp)
    fid = int(data["id"]) if isinstance(data, dict) and data.get("id") is not None else None
    port = int(data.get("listen_port") or 0) if isinstance(data, dict) else 0
    if fid is not None and fid not in H.created_ids:
        H.created_ids.append(fid)
    return status, fid, port, resp


def assert_payload(fid: int, port: int, label: str) -> None:
    check(H.wait_active(fid), f"{label} converges to active", f"id={fid}")
    ok, detail = H.tcp_probe(port)
    check(ok, f"{label} carries a real TCP payload", detail)


def delete_and_reuse(mode: str) -> None:
    label = mode.upper()
    status, fid, port, resp = create_tcp(f"{label}-ORIGINAL", mode)
    check(status in (200, 201) and fid is not None and port > 0,
          f"A00.{label} original Forward is created",
          f"status={status} port={port} body={json.dumps(resp, ensure_ascii=False)[:180]}")
    if status not in (200, 201) or fid is None or port <= 0:
        return

    assert_payload(fid, port, f"A00.{label} original")

    egress_port = 0
    if mode == "relay":
        egress_port = int(H.scalar(
            f"SELECT IFNULL(egress_port,0) FROM tunnel WHERE id={fid};"
        ) or 0)
        check(egress_port > 0, "A00.RELAY owns a concrete egress port before deletion",
              f"egress_port={egress_port}")

    check(active_lease_count(H.ING, port) == 1,
          f"A00.{label} ingress port has exactly one active DB lease before deletion",
          f"node={H.ING} port={port}")
    if egress_port > 0:
        check(active_lease_count(H.EGR, egress_port) == 1,
              "A00.RELAY egress port has exactly one active DB lease before deletion",
              f"node={H.EGR} port={egress_port}")

    delete_status, delete_body, _ = H.req("DELETE", f"/api/forwards/{fid}", None, timeout=120)
    check(delete_status in (200, 204), f"A00.{label} DELETE is accepted by the real API",
          f"status={delete_status} body={json.dumps(delete_body, ensure_ascii=False)[:180]}")
    if delete_status not in (200, 204):
        return

    removed = H.wait_until(lambda: not tunnel_exists(fid), timeout=60, interval=2)
    check(removed, f"A00.{label} desired Tunnel row is removed", f"id={fid}")

    stopped = H.wait_until(lambda: not H.tcp_probe(port, timeout=2)[0], timeout=90, interval=3)
    check(stopped, f"A00.{label} deleted listener stops accepting payload", f"port={port}")

    report_clear = H.wait_until(lambda: runtime_absent(fid), timeout=90, interval=3)
    check(report_clear, f"A00.{label} runtime disappears from both Agent reports", f"id={fid}")

    ingress_lease_clear = H.wait_until(
        lambda: active_lease_count(H.ING, port) == 0, timeout=60, interval=2
    )
    check(ingress_lease_clear, f"A00.{label} ingress active lease is released",
          f"node={H.ING} port={port}")
    if egress_port > 0:
        egress_lease_clear = H.wait_until(
            lambda: active_lease_count(H.EGR, egress_port) == 0, timeout=60, interval=2
        )
        check(egress_lease_clear, "A00.RELAY egress active lease is released",
              f"node={H.EGR} port={egress_port}")

    status2, fid2, port2, resp2 = create_tcp(
        f"{label}-REUSE", mode, listen_port=port
    )
    check(status2 in (200, 201) and fid2 is not None,
          f"A00.{label} the exact deleted ingress port can be allocated again",
          f"status={status2} requested={port} returned={port2} body={json.dumps(resp2, ensure_ascii=False)[:180]}")
    if status2 in (200, 201) and fid2 is not None:
        check(port2 == port, f"A00.{label} reuse keeps the requested port",
              f"requested={port} returned={port2}")
        assert_payload(fid2, port2, f"A00.{label} replacement")

    second_status, second_body, _ = H.req("DELETE", f"/api/forwards/{fid}", None, timeout=60)
    check(second_status == 404,
          f"A00.{label} replaying DELETE for the old id is a bounded not_found",
          f"status={second_status} body={json.dumps(second_body, ensure_ascii=False)[:160]}")
    if status2 in (200, 201) and fid2 is not None:
        check(H.wait_active(fid2) and H.tcp_probe(port2)[0],
              f"A00.{label} replay of the old DELETE does not damage the replacement",
              f"replacement_id={fid2}")


def main() -> int:
    signal.signal(signal.SIGALRM, H.alarm)
    ready = False
    H.acquire_lock()
    try:
        signal.setitimer(signal.ITIMER_REAL, min(300, OVERALL_SECONDS))
        H.setup()
        ready = True
        signal.setitimer(signal.ITIMER_REAL, 0)

        check(H.ensure_echo_target(),
              "A00.setup byte-echo target is reachable before lifecycle cases",
              f"target=target-a:{H.ECHO_TARGET_PORT}")

        for mode in ("direct", "relay"):
            signal.setitimer(signal.ITIMER_REAL, 420)
            try:
                delete_and_reuse(mode)
            except Exception as exc:  # noqa: BLE001
                H.record(False, f"A00.{mode.upper()}: {type(exc).__name__}: {exc}")
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
    except Exception as exc:  # noqa: BLE001
        H.record(False, f"A00 prerequisite/setup: {type(exc).__name__}: {exc}; cases NOT EXECUTED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.setitimer(signal.ITIMER_REAL, 300)
        try:
            H.cleanup_fixtures()
            left = H.scalar(
                f"SELECT COUNT(*) FROM tunnel WHERE name LIKE '{H.FIXTURE_PREFIX}-A00-%';"
            )
            check(left == "0", "A00.cleanup every lifecycle fixture is removed", f"left={left}")
        except Exception as exc:  # noqa: BLE001
            H.record(False, f"A00.cleanup: {type(exc).__name__}: {exc}")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)

        RESULT.write_text(
            "# A00 delete / cleanup / port reuse real integration gate\n"
            f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
            "topology: scripts/integration/docker-compose.yaml (real MySQL/Redis/Panel/Worker/4 Agents)\n"
            f"setup={'executed' if ready else 'incomplete'}\n"
            f"elapsed_seconds={int(time.monotonic() - START)}\n"
            + "\n".join(H.RESULTS)
            + f"\nA00 DELETE-REUSE TOTAL PASS={H.PASS} FAIL={H.FAIL}\n",
            encoding="utf-8",
        )
        TRACE.write_text(
            json.dumps({"http": H.HTTP}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        H.release_lock()
        print(f"A00 DELETE-REUSE TOTAL PASS={H.PASS} FAIL={H.FAIL} evidence={RESULT}", flush=True)
    return 1 if H.FAIL or not ready else 0


if __name__ == "__main__":
    raise SystemExit(main())
