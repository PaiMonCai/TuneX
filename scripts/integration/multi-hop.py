#!/usr/bin/env python3
"""Multi-hop regression suite.

Validates creation, end-to-end forwarding, failed-hop diagnosis, adjacency
authorization, orphan transit cleanup and single-hop regression on the real topology.
"""
from __future__ import annotations

import importlib.util
import json
import os
import signal
import socket
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_harness():
    spec = importlib.util.spec_from_file_location("integration_protocol_harness", HERE / "protocol-suite.py")
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise SystemExit("cannot load scripts/integration/protocol-suite.py as the harness module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


H = _load_harness()

OUT = HERE / "evidence"
OUT.mkdir(exist_ok=True)
RESULT = OUT / "multi-hop-result.txt"

STATE = json.loads((HERE / "state.json").read_text(encoding="utf-8"))
ING = int(os.environ.get("MULTI_INGRESS", STATE["nodes"]["ingress"]["id"]))
MID = int(os.environ.get("MULTI_MIDDLE", STATE["nodes"]["ingress_secondary"]["id"]))
EGR = int(os.environ.get("MULTI_EGRESS", STATE["nodes"]["egress"]["id"]))
TARGET_PORT = int(os.environ.get("MULTI_TARGET_PORT", "3030"))
OVERALL_SECONDS = int(os.environ.get("MULTI_OVERALL_SECONDS", "2400"))
SERVE_TIMEOUT = int(os.environ.get("MULTI_SERVE_TIMEOUT", "240"))
START = time.monotonic()


def check(condition, message, detail=""):
    H.record(bool(condition), message if condition or not detail else f"{message} [{detail}]")


def case(name: str, fn, seconds: int):
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        H.record(False, f"{name}: {type(exc).__name__}: {exc}")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def node_ip(node_id: int) -> str:
    raw = H.scalar(f"SELECT IFNULL(connect_ip,'') FROM node WHERE id={node_id};").strip()
    return raw.split(",")[0].strip() if raw else ""


def agent_container(node_id: int) -> str:
    agent_id = H.scalar(f"SELECT agent_id FROM node WHERE id={node_id};")
    for container in (
        "tunex-it-ingress-agent", "tunex-it-ingress-agent-b",
        "tunex-it-egress-agent", "tunex-it-egress-agent-b",
    ):
        spec = H.docker(["inspect", "-f", "{{.Config.Cmd}}|{{.Config.Env}}", container], allow=True)
        if agent_id and agent_id in spec:
            return container
    return ""


def ensure_binding(ingress_node: int, egress_node: int) -> None:
    H.mysql(
        "INSERT INTO node_binding (ingress_node_id, egress_node_id, created_at) "
        f"VALUES ({ingress_node}, {egress_node}, NOW(3)) "
        "ON DUPLICATE KEY UPDATE created_at = created_at;"
    )


def drop_binding(ingress_node: int, egress_node: int) -> None:
    H.mysql(f"DELETE FROM node_binding WHERE ingress_node_id={ingress_node} AND egress_node_id={egress_node};")


def create_route(name: str, *, middle: int | None, egress_node: int = EGR) -> tuple[int, dict]:
    body: dict = {
        "name": f"{H.FIXTURE_PREFIX}-{name}",
        "mode": "relay",
        "protocol": "tcp",
        "ingress_node_id": ING,
        "egress_node_id": egress_node,
        "target_host": "target-a",
        "target_port": TARGET_PORT,
    }
    if middle is not None:
        body["middle_node_id"] = middle
    status, resp, _ = H.req("POST", "/api/forwards", body)
    return status, (H.unwrap(resp) or {}) if isinstance(H.unwrap(resp), dict) else {}


def tunnel_row(tunnel_id: int) -> dict:
    raw = H.mysql(
        "SELECT CONCAT(IFNULL(middle_node_id,0), '|', IFNULL(ingress_node_id,0), '|', IFNULL(egress_node_id,0), '|', "
        "IFNULL(listen_port,0), '|', IFNULL(apply_status,''), '|', IFNULL(config_revision,0), '|', "
        f"IFNULL(applied_revision,0)) FROM tunnel WHERE id={tunnel_id};"
    ).strip()
    if "|" not in raw:
        return {}
    mid, ing, eg, port, status, cfg, applied = raw.split("|")
    return {
        "middle_node_id": int(mid), "ingress_node_id": int(ing), "egress_node_id": int(eg),
        "listen_port": int(port), "apply_status": status,
        "config_revision": int(cfg), "applied_revision": int(applied),
    }


def relay_serves(ingress_node: int, port: int, timeout: float = 6.0) -> tuple[bool, str]:
    """连入口端口，读回包。三跳是否真的成立，看的就是这里有没有数据。"""
    ip = node_ip(ingress_node)
    try:
        with socket.create_connection((ip, port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            data = sock.recv(256)
            return bool(data), repr(data[:48])
    except Exception as exc:  # noqa: BLE001
        return False, type(exc).__name__


def reported_transit(node_id: int, tunnel_id: int) -> bool:
    """该节点的上报里有没有这条转发的**中转 runtime**。

    孤儿链路的唯一可靠判据：它不报错，只能从"它还在不在那个节点的运行时列表里"看出来。
    中间跳与出口跳共用同一个 runtime id 形状（按节点分命名空间），因此这里查 `-egress`。
    """
    raw = H.scalar(f"SELECT IFNULL(tunnels,'[]') FROM node_state_report WHERE node_id={node_id};")
    return f"tunex-{tunnel_id}-egress" in raw


# ---------------------------------------------------------------------------
# setup / cleanup
# ---------------------------------------------------------------------------

def setup() -> None:
    H.mysql(f"UPDATE user SET super_admin=1 WHERE email='{H.EMAIL}';")
    check(bool(H.wait_until(lambda: H.req("GET", "/healthz", timeout=5)[0] == 200, timeout=60, interval=2)),
          "MULTI.setup the panel is reachable")
    for nid in (ING, MID, EGR):
        check(bool(node_ip(nid)), f"MULTI.setup node {nid} has an address", node_ip(nid))
    # 两段许可：三跳路由用到的邻接是 (入口→中间) 与 (中间→出口)。
    ensure_binding(ING, MID)
    ensure_binding(MID, EGR)
    check(True, "MULTI.setup the two adjacency permits exist (ingress→middle, middle→egress)")
    H.mid_container = agent_container(MID)
    check(bool(H.mid_container), "MULTI.setup the middle node's container was identified", H.mid_container)


def cleanup() -> None:
    try:
        if getattr(H, "mid_container", "") and getattr(H, "mid_stopped", False):
            H.docker(["start", H.mid_container], allow=True, timeout=150)
            H.mid_stopped = False
        H.cleanup_fixtures()
    except Exception as exc:  # noqa: BLE001
        H.record(False, f"MULTI.cleanup: {type(exc).__name__}: {exc}")


# ---------------------------------------------------------------------------
# cases
# ---------------------------------------------------------------------------

def multi_1_create_three_hop():
    status, data = create_route("multi-three-hop", middle=MID)
    # 失败时把**响应体**带进 detail：502 的 body 里有 steps / failedStep / error_code，
    # 那是"哪一跳失败了"的唯一线索。只报 status=502 会让下一轮必须重新猜（实测踩到过）。
    check(status in (200, 201), "MULTI.1 a three-hop route is accepted",
          f"status={status} body={json.dumps(data, ensure_ascii=False)[:500]}")
    fid = int((data or {}).get("id") or 0)
    check(fid > 0, "MULTI.1 and it has an id", json.dumps(data)[:200])
    if fid <= 0:
        return
    H.route_id = fid
    row = tunnel_row(fid)
    H.route_before = row
    check(row.get("middle_node_id") == MID,
          "MULTI.1 the middle hop is persisted (not dropped between API and row)", json.dumps(row))
    check(row.get("ingress_node_id") == ING and row.get("egress_node_id") == EGR,
          "MULTI.1 and both ends are where they were asked to be", json.dumps(row))


def multi_2_three_hop_carries_data():
    fid = getattr(H, "route_id", 0)
    if not fid:
        return
    row = tunnel_row(fid)
    port = int(row.get("listen_port") or 0)
    check(port > 0, "MULTI.2 the route has a listener port", json.dumps(row))
    if port <= 0:
        return
    ok = H.wait_until(lambda: relay_serves(ING, port)[0], timeout=SERVE_TIMEOUT, interval=8)
    check(ok, "MULTI.2 the client reaches the target THROUGH the middle hop", f"{node_ip(ING)}:{port}")
    # 数据能从目标回来，说明三段都真的接上了：入口 → 中间 → 出口 → 目标。
    check(tunnel_row(fid).get("applied_revision", 0) >= 1,
          "MULTI.2 and the route reports an applied revision", json.dumps(tunnel_row(fid)))


def multi_3_failure_names_the_hop():
    fid = getattr(H, "route_id", 0)
    container = getattr(H, "mid_container", "")
    if not fid or not container:
        return
    row = tunnel_row(fid)
    port = int(row.get("listen_port") or 0)
    # **先断言它曾经在服务**。没有这一条，"停掉中间跳 → 客户端失败"在**路由根本没通**时也会通过，
    # 于是一条完全不可用的路由反而让这条断言变成假阳性（实测发生过）。断言的强弱决定它能否
    # 区分两种世界：这里的两种世界是"中间跳在链路上"与"中间跳根本不在链路上"。
    was_serving = H.wait_until(lambda: relay_serves(ING, port)[0], timeout=SERVE_TIMEOUT, interval=8)
    check(was_serving, "MULTI.3 the route is serving BEFORE the middle hop is taken down",
          f"port={port}（若这里就不通，说明三跳根本没建立，后面的断言没有意义）")
    H.docker(["stop", container], allow=True, timeout=120)
    H.mid_stopped = True
    # 中间跳消失后客户端必须失败（否则说明流量绕过了它，那"三跳"就不是真的）。
    failed = H.wait_until(lambda: not relay_serves(ING, port)[0], timeout=SERVE_TIMEOUT, interval=6)
    check(failed, "MULTI.3 the client fails once the middle hop is down",
          f"port={port}（若仍通，说明流量没有经过中间跳）")
    # 失败必须能定位到**哪一跳**：诊断里要出现中间跳的节点身份。
    status, resp, _ = H.req("POST", f"/api/forwards/{fid}/diagnose", {"target": "relay"}, timeout=90)
    text = json.dumps(H.unwrap(resp) or resp, ensure_ascii=False)
    hop_named = (
        f'"hop_index": 1' in text.replace(" ", "")
        or f'"hop_index":1' in text.replace(" ", "")
        or str(MID) in text
    )
    check(status in (200, 201, 202) or hop_named,
          "MULTI.3 the diagnosis is answerable while a hop is down", f"status={status}")
    check(hop_named, "MULTI.3 and it names the failing hop (hop 1 / the middle node)",
          f"status={status} text={text[:200]}")


def multi_4_missing_permit_is_refused():
    # 只保留 (中间→出口)，去掉 (入口→中间)。
    drop_binding(ING, MID)
    status, data = create_route("multi-no-permit", middle=MID)
    check(status == 409, "MULTI.4 a three-hop route without the ingress→middle permit is refused",
          f"status={status} body={json.dumps(data)[:160]}")
    body = json.dumps(data, ensure_ascii=False)
    check("binding_required" in body or "绑定" in body,
          "MULTI.4 and the refusal says WHY (a permit is missing)", body[:160])
    ensure_binding(ING, MID)


def multi_5_orphan_transit_is_cleaned():
    fid = getattr(H, "route_id", 0)
    if not fid:
        return
    if getattr(H, "mid_stopped", False):
        H.docker(["start", H.mid_container], allow=True, timeout=150)
        H.mid_stopped = False
    # 节点上报是**周期性**的（30s 一拍），创建刚返回时它的上报还可能是上一拍的快照 ——
    # 所以这里必须**等**它出现，而不是立刻断言。立刻断言会把"上报还没刷新"读成"中间跳没被下发"。
    check(bool(H.wait_until(lambda: reported_transit(MID, fid), timeout=90, interval=6)),
          "MULTI.5 the middle node really hosts a transit runtime before the change",
          f"node={MID} tunnel={fid}")
    # 改回单跳：去掉中间跳。
    current = tunnel_row(fid)
    status, resp, _ = H.req(
        "PATCH", f"/api/forwards/{fid}",
        {"middle_node_id": None, "expected_revision": current.get("config_revision")},
        timeout=120,
    )
    check(status in (200, 201), "MULTI.5 the route can be changed back to a single hop",
          f"status={status} body={json.dumps(H.unwrap(resp), ensure_ascii=False)[:500]}")
    cleaned = H.wait_until(lambda: not reported_transit(MID, fid), timeout=300, interval=8)
    check(cleaned, "MULTI.5 the middle hop's runtime is gone — no orphan transit link",
          f"node={MID} tunnel={fid}")
    check(tunnel_row(fid).get("middle_node_id") == 0,
          "MULTI.5 and the row no longer claims a middle hop", json.dumps(tunnel_row(fid)))
    H.route_after = tunnel_row(fid)


def multi_6_single_hop_still_serves():
    fid = getattr(H, "route_id", 0)
    if not fid:
        return
    row = tunnel_row(fid)
    port = int(row.get("listen_port") or 0)
    ok = H.wait_until(lambda: relay_serves(ING, port)[0], timeout=SERVE_TIMEOUT, interval=8)
    check(ok, "MULTI.6 after the route is single-hop again, the client is served (baseline path intact)",
          f"port={port}")
    check(int(tunnel_row(fid).get("applied_revision", 0)) > 0,
          "MULTI.6 and it is applied", json.dumps(tunnel_row(fid)))


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
            ("MULTI.1 create three-hop", multi_1_create_three_hop, 300),
            ("MULTI.2 three-hop carries data", multi_2_three_hop_carries_data, 420),
            ("MULTI.3 failure names the hop", multi_3_failure_names_the_hop, 600),
            ("MULTI.4 missing permit refused", multi_4_missing_permit_is_refused, 300),
            ("MULTI.5 orphan transit cleaned", multi_5_orphan_transit_is_cleaned, 600),
            ("MULTI.6 single hop still serves", multi_6_single_hop_still_serves, 420),
        ]:
            case(name, fn, budget)
    except Exception as exc:  # noqa: BLE001
        H.record(False, f"MULTI prerequisite/setup: {type(exc).__name__}: {exc}; remaining tests NOT EXECUTED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.setitimer(signal.ITIMER_REAL, 300)
        try:
            cleanup()
        except Exception as exc:  # noqa: BLE001
            H.record(False, f"MULTI.cleanup: {type(exc).__name__}: {exc}")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        RESULT.write_text(
            "# current-MULTI multi-hop regression (current contract/current contract/current contract)\n"
            f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
            f"topology: ingress={ING} middle={MID} egress={EGR}\n"
            f"setup={'executed' if ready else 'incomplete'}\n"
            f"elapsed_seconds: {int(time.monotonic() - START)}\n"
            + "\n".join(H.RESULTS)
            + f"\ncurrent-MULTI TOTAL PASS={H.PASS} FAIL={H.FAIL}\n",
            encoding="utf-8",
        )
        H.release_lock()
        print(f"current-MULTI TOTAL PASS={H.PASS} FAIL={H.FAIL} evidence={RESULT}", flush=True)
    return 1 if H.FAIL or not ready else 0


if __name__ == "__main__":
    raise SystemExit(main())
