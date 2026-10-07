#!/usr/bin/env python3
"""A00 real batch-delete acceptance on the existing 4-Agent integration stack.

Run with the isolated panel explicitly opted in:
    FORWARD_BATCH_DELETE_ENABLED=true scripts/integration/setup.sh
    python3 scripts/integration/a00-batch-delete.py

The gate proves destructive batching through the public API. It never flips the
production/default flag and never deletes leases directly to force a pass.
"""
from __future__ import annotations

import importlib.util
import json
import signal
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "evidence"
OUT.mkdir(exist_ok=True)
RESULT = OUT / "a00-batch-delete-result.txt"
TRACE = OUT / "a00-batch-delete-http.json"


def load_harness():
    spec = importlib.util.spec_from_file_location("batch_delete_harness", HERE / "protocol-suite.py")
    if spec is None or spec.loader is None:
        raise SystemExit("cannot load protocol-suite.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


H = load_harness()


def check(condition: bool, message: str, detail: str = "") -> None:
    H.check(condition, message, detail)


def runtime_residual_detail(fid: int) -> str:
    prefix = f"tunex-{fid}-"
    residuals = []
    for node_id, label in ((H.ING, "ingress"), (H.EGR, "egress")):
        row = H.scalar(
            f"SELECT CONCAT(DATE_FORMAT(reported_at,'%Y-%m-%dT%H:%i:%s'),'|',IFNULL(tunnels,'[]')) "
            f"FROM node_state_report WHERE node_id={int(node_id)};"
        )
        if not row:
            residuals.append({"node": label, "state": "no_report"})
            continue
        reported_at, raw = row.split("|", 1)
        try:
            rows = json.loads(raw or "[]")
        except json.JSONDecodeError:
            residuals.append({"node": label, "reported_at": reported_at, "state": "bad_json"})
            continue
        ids = [str(item.get("id", "")) for item in rows if isinstance(item, dict) and str(item.get("id", "")).startswith(prefix)]
        if ids:
            residuals.append({"node": label, "reported_at": reported_at, "runtime_ids": ids})
    return json.dumps(residuals, ensure_ascii=False)


def runtime_absent(fid: int) -> bool:
    return runtime_residual_detail(fid) == "[]"


def tunnel_exists(fid: int) -> bool:
    return H.scalar(f"SELECT COUNT(*) FROM tunnel WHERE id={int(fid)};") != "0"


def active_leases(fid: int) -> int:
    return int(H.scalar(
        f"SELECT COUNT(*) FROM node_port_lease WHERE tunnel_id={int(fid)} AND status='active';"
    ) or 0)


def create_tcp(name: str, mode: str, *, listen_port: int | None = None):
    body: dict = {
        "name": f"{H.FIXTURE_PREFIX}-A00-BATCH-{name}",
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
    status, resp, _ = H.req("POST", "/api/forwards", body, timeout=180)
    data = H.unwrap(resp)
    fid = int(data["id"]) if isinstance(data, dict) and data.get("id") is not None else None
    port = int(data.get("listen_port") or 0) if isinstance(data, dict) else 0
    if fid is not None and fid not in H.created_ids:
        H.created_ids.append(fid)
    return status, fid, port, resp


def assert_live(fid: int, port: int, label: str) -> None:
    check(H.wait_active(fid, timeout=150), f"{label}: converges", f"id={fid}")
    ok, detail = H.tcp_probe(port)
    check(ok, f"{label}: real TCP payload succeeds", detail)


def batch_delete(ids: list[int]):
    return H.req(
        "POST",
        "/api/forwards/batch",
        {"action": "delete", "ids": ids, "confirm_delete": True},
        timeout=240,
    )


def assert_deleted(fid: int, port: int, label: str) -> None:
    check(H.wait_until(lambda: not tunnel_exists(fid), timeout=60, interval=2),
          f"{label}: desired row is gone", f"id={fid}")
    check(H.wait_until(lambda: not H.tcp_probe(port, timeout=2)[0], timeout=90, interval=3),
          f"{label}: listener is down", f"port={port}")
    runtime_gone = H.wait_until(lambda: runtime_absent(fid), timeout=90, interval=3)
    check(runtime_gone,
          f"{label}: runtime is absent from Agent reports",
          f"id={fid} residual={runtime_residual_detail(fid)}")
    check(H.wait_until(lambda: active_leases(fid) == 0, timeout=60, interval=2),
          f"{label}: no active port lease remains", f"id={fid}")


def success_and_reuse_case() -> None:
    created = []
    for mode in ("direct", "relay"):
        status, fid, port, body = create_tcp(f"OK-{mode}", mode)
        check(status in (200, 201) and fid is not None and port > 0,
              f"A00.BATCH {mode}: fixture created",
              f"status={status} port={port} body={json.dumps(body, ensure_ascii=False)[:160]}")
        if fid is None or status not in (200, 201):
            return
        assert_live(fid, port, f"A00.BATCH {mode}")
        created.append((mode, fid, port))

    missing = 2_147_000_000
    status, body, _ = batch_delete([created[0][1], created[1][1], missing, created[0][1]])
    data = H.unwrap(body)
    check(status == 200, "A00.BATCH confirmed request returns per-item result envelope",
          f"status={status} body={json.dumps(body, ensure_ascii=False)[:220]}")
    if status != 200 or not isinstance(data, dict):
        return
    check((data.get("requested"), data.get("succeeded"), data.get("failed")) == (3, 2, 1),
          "A00.BATCH deduplicates IDs and preserves a not_found partial failure",
          json.dumps(data, ensure_ascii=False)[:260])
    rows = {int(row["id"]): row for row in data.get("results", []) if isinstance(row, dict) and row.get("id") is not None}
    check(rows.get(missing, {}).get("code") == "not_found",
          "A00.BATCH missing ID is reported, not promoted to whole-request failure")

    for mode, fid, port in created:
        assert_deleted(fid, port, f"A00.BATCH {mode} deleted")
        status2, fid2, port2, body2 = create_tcp(f"REUSE-{mode}", mode, listen_port=port)
        check(status2 in (200, 201) and fid2 is not None and port2 == port,
              f"A00.BATCH {mode}: exact ingress port is reusable",
              f"status={status2} requested={port} returned={port2} body={json.dumps(body2, ensure_ascii=False)[:160]}")
        if status2 in (200, 201) and fid2 is not None:
            assert_live(fid2, port2, f"A00.BATCH {mode} replacement")


def mixed_disconnect_case() -> None:
    rs, relay_id, relay_port, relay_body = create_tcp("MIX-RELAY", "relay")
    ds, direct_id, direct_port, direct_body = create_tcp("MIX-DIRECT", "direct")
    check(rs in (200, 201) and relay_id is not None and ds in (200, 201) and direct_id is not None,
          "A00.BATCH mixed failure fixtures are created",
          f"relay={rs}:{json.dumps(relay_body, ensure_ascii=False)[:90]} direct={ds}:{json.dumps(direct_body, ensure_ascii=False)[:90]}")
    if relay_id is None or direct_id is None:
        return
    assert_live(relay_id, relay_port, "A00.BATCH mixed relay")
    assert_live(direct_id, direct_port, "A00.BATCH mixed direct")

    H.docker(["stop", H.EGRESS_CONTAINER], timeout=120)
    check(H.docker(["inspect", "-f", "{{.State.Running}}", H.EGRESS_CONTAINER], allow=True).strip() == "false",
          "A00.BATCH egress Agent is deliberately disconnected")

    status, body, _ = batch_delete([relay_id, direct_id])
    data = H.unwrap(body)
    check(status == 200 and isinstance(data, dict),
          "A00.BATCH mixed runtime failure still returns a per-item envelope",
          f"status={status} body={json.dumps(body, ensure_ascii=False)[:240]}")
    if not isinstance(data, dict):
        return
    by_id = {int(row["id"]): row for row in data.get("results", []) if isinstance(row, dict)}
    relay_result = by_id.get(relay_id, {})
    direct_result = by_id.get(direct_id, {})
    check(relay_result.get("ok") is False,
          "A00.BATCH disconnected relay fails instead of claiming deletion",
          json.dumps(relay_result, ensure_ascii=False))
    check(direct_result.get("ok") is True,
          "A00.BATCH later independent DIRECT still succeeds after the earlier failure",
          json.dumps(direct_result, ensure_ascii=False))

    assert_deleted(direct_id, direct_port, "A00.BATCH mixed direct")

    # Failure must preserve the durable collision barrier until teardown can be confirmed.
    check(tunnel_exists(relay_id),
          "A00.BATCH failed relay keeps its durable Tunnel for reconciliation", f"id={relay_id}")
    check(active_leases(relay_id) > 0,
          "A00.BATCH failed relay keeps active leases while runtime teardown is uncertain",
          f"id={relay_id} active_leases={active_leases(relay_id)}")

    # A page refresh must still see the failed item instead of interpreting the 200 envelope
    # as "everything vanished".
    refresh_status, refresh_body, _ = H.req("GET", f"/api/forwards/{relay_id}", timeout=60)
    check(refresh_status == 200,
          "A00.BATCH refresh re-reads the surviving failed rule from durable state",
          f"status={refresh_status} body={json.dumps(refresh_body, ensure_ascii=False)[:180]}")

    H.docker(["start", H.EGRESS_CONTAINER], timeout=120)
    check(H.wait_until(lambda: H.scalar(
        f"SELECT COUNT(*) FROM node_state_report WHERE node_id={H.EGR} AND reported_at > NOW() - INTERVAL 1 MINUTE;"
    ) == "1", timeout=150, interval=3),
          "A00.BATCH disconnected egress Agent re-reports before reconciliation")

    # Retry through the ordinary single-delete lifecycle. The batch layer must not have
    # invented an alternate cleanup path.
    retry_status, retry_body, _ = H.req("DELETE", f"/api/forwards/{relay_id}", None, timeout=180)
    check(retry_status in (200, 204),
          "A00.BATCH failed relay can be reconciled by the normal single-delete lifecycle",
          f"status={retry_status} body={json.dumps(retry_body, ensure_ascii=False)[:180]}")
    if retry_status in (200, 204):
        assert_deleted(relay_id, relay_port, "A00.BATCH reconciled relay")


def cleanup() -> None:
    # Never bypass lifecycle by deleting DB rows. Bring the egress Agent back first,
    # then ask the public single-delete endpoint to remove any surviving fixtures.
    H.docker(["start", H.EGRESS_CONTAINER], allow=True, timeout=120)
    for fid in list(H.created_ids):
        if not tunnel_exists(fid):
            continue
        status, body, _ = H.req("DELETE", f"/api/forwards/{fid}", None, timeout=180)
        check(status in (200, 204, 404),
              "A00.BATCH cleanup uses the public delete lifecycle",
              f"id={fid} status={status} body={json.dumps(body, ensure_ascii=False)[:140]}")
    left = H.scalar(f"SELECT COUNT(*) FROM tunnel WHERE name LIKE '{H.FIXTURE_PREFIX}-A00-BATCH-%';")
    check(left == "0", "A00.BATCH cleanup leaves no fixture Tunnel rows", f"left={left}")


def main() -> int:
    signal.signal(signal.SIGALRM, H.alarm)
    ready = False
    H.acquire_lock()
    try:
        signal.setitimer(signal.ITIMER_REAL, 300)
        H.setup()
        ready = True
        signal.setitimer(signal.ITIMER_REAL, 0)

        status, body, _ = H.req("GET", "/api/forwards/batch/capabilities", timeout=30)
        data = H.unwrap(body)
        check(status == 200 and isinstance(data, dict) and data.get("delete_enabled") is True,
              "A00.BATCH isolated panel explicitly opted into batch delete",
              f"status={status} body={json.dumps(body, ensure_ascii=False)}")
        if not (status == 200 and isinstance(data, dict) and data.get("delete_enabled") is True):
            return 1

        signal.setitimer(signal.ITIMER_REAL, 540)
        success_and_reuse_case()
        signal.setitimer(signal.ITIMER_REAL, 0)

        signal.setitimer(signal.ITIMER_REAL, 720)
        mixed_disconnect_case()
        signal.setitimer(signal.ITIMER_REAL, 0)
    except Exception as exc:  # noqa: BLE001
        H.record(False, f"A00.BATCH prerequisite/case failure: {type(exc).__name__}: {exc}")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        try:
            cleanup()
        except Exception as exc:  # noqa: BLE001
            H.record(False, f"A00.BATCH cleanup failure: {type(exc).__name__}: {exc}")
        RESULT.write_text(
            "# A00 real batch-delete gate\n"
            f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
            "topology: scripts/integration/docker-compose.yaml (real MySQL/Redis/Panel/Worker/4 Agents)\n"
            f"setup={'executed' if ready else 'incomplete'}\n"
            + "\n".join(H.RESULTS)
            + f"\nA00 BATCH DELETE TOTAL PASS={H.PASS} FAIL={H.FAIL}\n",
            encoding="utf-8",
        )
        TRACE.write_text(json.dumps({"http": H.HTTP}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        H.release_lock()
        print(f"A00 BATCH DELETE TOTAL PASS={H.PASS} FAIL={H.FAIL} evidence={RESULT}", flush=True)
    return 1 if H.FAIL or not ready else 0


if __name__ == "__main__":
    raise SystemExit(main())
