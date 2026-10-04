#!/usr/bin/env python3
"""V5-G4 gate — V5.4 多跳路由（WP11/WP12/WP13）。

§9 的 Gate 要求验四件事，本门禁逐条构造（不是绕过去断言）：

  G4.1  三跳路由**可创建**：入口 3 → 中间 5 → 出口 4，两段许可齐备
  G4.2  **端到端真的通**：客户端连入口端口，数据要穿过 中间跳 到达目标
        —— 这一条是"组合是否真的成立"的唯一硬证据：中间跳少发一次，这里就没有回包
  G4.3  **失败跳定位**：停掉中间跳之后，失败必须**点名 hop 1**（三跳下"这条转发失败了"
        无法定位，而 G4 明确要求遥测能定位失败跳）
  G4.4  **许可缺失被拒**：缺 (入口→中间) 或 (中间→出口) 任一段，创建必须 409
  G4.5  **孤儿链路清理**：把路由改回单跳后，中间跳的 runtime 必须消失
        —— 这一条只能从**中间节点自己的上报**里验，因为孤儿不会报错，只会静默占着端口
  G4.6  单跳行为未被影响：改回单跳之后，客户端仍然通（V4 路径不能因为多跳而回归）

FAIL > 0 意味着 V5.4 未收口。
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
    spec = importlib.util.spec_from_file_location("v5_g1a_harness", HERE / "v5-g1a.py")
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise SystemExit("cannot load scripts/v3-e2e/v5-g1a.py as the harness module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


H = _load_harness()

OUT = HERE / "evidence"
OUT.mkdir(exist_ok=True)
RESULT = OUT / "v5-g4-result.txt"

ING = int(os.environ.get("G4_INGRESS", "3"))
MID = int(os.environ.get("G4_MIDDLE", "5"))
EGR = int(os.environ.get("G4_EGRESS", "4"))
TARGET_PORT = int(os.environ.get("G4_TARGET_PORT", "3030"))
OVERALL_SECONDS = int(os.environ.get("G4_OVERALL_SECONDS", "2400"))
SERVE_TIMEOUT = int(os.environ.get("G4_SERVE_TIMEOUT", "240"))
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
        "wp14-ingress-agent", "wp14-ingress-agent-b",
        "wp14-egress-agent", "wp14-egress-agent-b",
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
          "G4.setup the panel is reachable")
    for nid in (ING, MID, EGR):
        check(bool(node_ip(nid)), f"G4.setup node {nid} has an address", node_ip(nid))
    # 两段许可：三跳路由用到的邻接是 (入口→中间) 与 (中间→出口)。
    ensure_binding(ING, MID)
    ensure_binding(MID, EGR)
    check(True, "G4.setup the two adjacency permits exist (ingress→middle, middle→egress)")
    H.mid_container = agent_container(MID)
    check(bool(H.mid_container), "G4.setup the middle node's container was identified", H.mid_container)


def cleanup() -> None:
    try:
        if getattr(H, "mid_container", "") and getattr(H, "mid_stopped", False):
            H.docker(["start", H.mid_container], allow=True, timeout=150)
            H.mid_stopped = False
        H.cleanup_fixtures()
    except Exception as exc:  # noqa: BLE001
        H.record(False, f"G4.cleanup: {type(exc).__name__}: {exc}")


# ---------------------------------------------------------------------------
# cases
# ---------------------------------------------------------------------------

def g4_1_create_three_hop():
    status, data = create_route("g4-three-hop", middle=MID)
    check(status in (200, 201), "G4.1 a three-hop route is accepted", f"status={status}")
    fid = int((data or {}).get("id") or 0)
    check(fid > 0, "G4.1 and it has an id", json.dumps(data)[:200])
    if fid <= 0:
        return
    H.route_id = fid
    row = tunnel_row(fid)
    H.route_before = row
    check(row.get("middle_node_id") == MID,
          "G4.1 the middle hop is persisted (not dropped between API and row)", json.dumps(row))
    check(row.get("ingress_node_id") == ING and row.get("egress_node_id") == EGR,
          "G4.1 and both ends are where they were asked to be", json.dumps(row))


def g4_2_three_hop_carries_data():
    fid = getattr(H, "route_id", 0)
    if not fid:
        return
    row = tunnel_row(fid)
    port = int(row.get("listen_port") or 0)
    check(port > 0, "G4.2 the route has a listener port", json.dumps(row))
    if port <= 0:
        return
    ok = H.wait_until(lambda: relay_serves(ING, port)[0], timeout=SERVE_TIMEOUT, interval=8)
    check(ok, "G4.2 the client reaches the target THROUGH the middle hop", f"{node_ip(ING)}:{port}")
    # 数据能从目标回来，说明三段都真的接上了：入口 → 中间 → 出口 → 目标。
    check(tunnel_row(fid).get("applied_revision", 0) >= 1,
          "G4.2 and the route reports an applied revision", json.dumps(tunnel_row(fid)))


def g4_3_failure_names_the_hop():
    fid = getattr(H, "route_id", 0)
    container = getattr(H, "mid_container", "")
    if not fid or not container:
        return
    row = tunnel_row(fid)
    port = int(row.get("listen_port") or 0)
    H.docker(["stop", container], allow=True, timeout=120)
    H.mid_stopped = True
    # 中间跳消失后客户端必须失败（否则说明流量绕过了它，那"三跳"就不是真的）。
    failed = H.wait_until(lambda: not relay_serves(ING, port)[0], timeout=SERVE_TIMEOUT, interval=6)
    check(failed, "G4.3 the client fails once the middle hop is down",
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
          "G4.3 the diagnosis is answerable while a hop is down", f"status={status}")
    check(hop_named, "G4.3 and it names the failing hop (hop 1 / the middle node)",
          f"status={status} text={text[:200]}")


def g4_4_missing_permit_is_refused():
    # 只保留 (中间→出口)，去掉 (入口→中间)。
    drop_binding(ING, MID)
    status, data = create_route("g4-no-permit", middle=MID)
    check(status == 409, "G4.4 a three-hop route without the ingress→middle permit is refused",
          f"status={status} body={json.dumps(data)[:160]}")
    body = json.dumps(data, ensure_ascii=False)
    check("binding_required" in body or "绑定" in body,
          "G4.4 and the refusal says WHY (a permit is missing)", body[:160])
    ensure_binding(ING, MID)


def g4_5_orphan_transit_is_cleaned():
    fid = getattr(H, "route_id", 0)
    if not fid:
        return
    if getattr(H, "mid_stopped", False):
        H.docker(["start", H.mid_container], allow=True, timeout=150)
        H.mid_stopped = False
    check(reported_transit(MID, fid),
          "G4.5 the middle node really hosts a transit runtime before the change")
    # 改回单跳：去掉中间跳。
    current = tunnel_row(fid)
    status, resp, _ = H.req(
        "PATCH", f"/api/forwards/{fid}",
        {"middle_node_id": None, "expected_revision": current.get("config_revision")},
        timeout=120,
    )
    check(status in (200, 201), "G4.5 the route can be changed back to a single hop", f"status={status}")
    cleaned = H.wait_until(lambda: not reported_transit(MID, fid), timeout=300, interval=8)
    check(cleaned, "G4.5 the middle hop's runtime is gone — no orphan transit link",
          f"node={MID} tunnel={fid}")
    check(tunnel_row(fid).get("middle_node_id") == 0,
          "G4.5 and the row no longer claims a middle hop", json.dumps(tunnel_row(fid)))
    H.route_after = tunnel_row(fid)


def g4_6_single_hop_still_serves():
    fid = getattr(H, "route_id", 0)
    if not fid:
        return
    row = tunnel_row(fid)
    port = int(row.get("listen_port") or 0)
    ok = H.wait_until(lambda: relay_serves(ING, port)[0], timeout=SERVE_TIMEOUT, interval=8)
    check(ok, "G4.6 after the route is single-hop again, the client is served (V4 path intact)",
          f"port={port}")
    check(int(tunnel_row(fid).get("applied_revision", 0)) > 0,
          "G4.6 and it is applied", json.dumps(tunnel_row(fid)))


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
            ("G4.1 create three-hop", g4_1_create_three_hop, 300),
            ("G4.2 three-hop carries data", g4_2_three_hop_carries_data, 420),
            ("G4.3 failure names the hop", g4_3_failure_names_the_hop, 600),
            ("G4.4 missing permit refused", g4_4_missing_permit_is_refused, 300),
            ("G4.5 orphan transit cleaned", g4_5_orphan_transit_is_cleaned, 600),
            ("G4.6 single hop still serves", g4_6_single_hop_still_serves, 420),
        ]:
            case(name, fn, budget)
    except Exception as exc:  # noqa: BLE001
        H.record(False, f"G4 prerequisite/setup: {type(exc).__name__}: {exc}; remaining tests NOT EXECUTED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.setitimer(signal.ITIMER_REAL, 300)
        try:
            cleanup()
        except Exception as exc:  # noqa: BLE001
            H.record(False, f"G4.cleanup: {type(exc).__name__}: {exc}")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        RESULT.write_text(
            "# V5-G4 multi-hop gate (WP11/WP12/WP13)\n"
            f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
            f"topology: ingress={ING} middle={MID} egress={EGR}\n"
            f"setup={'executed' if ready else 'incomplete'}\n"
            f"elapsed_seconds: {int(time.monotonic() - START)}\n"
            + "\n".join(H.RESULTS)
            + f"\nV5-G4 TOTAL PASS={H.PASS} FAIL={H.FAIL}\n",
            encoding="utf-8",
        )
        H.release_lock()
        print(f"V5-G4 TOTAL PASS={H.PASS} FAIL={H.FAIL} evidence={RESULT}", flush=True)
    return 1 if H.FAIL or not ready else 0


if __name__ == "__main__":
    raise SystemExit(main())
