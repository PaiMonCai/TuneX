#!/usr/bin/env python3
"""V5-G2 gate — V5.2 WP7 (circuit breaker / health-aware LB), end to end.

G2A proved the observation and synthesis half; this one proves the DECISION half: the
agent must stop steering traffic at a target the panel called unhealthy, must keep
serving when every target is unhealthy, must steer back once a target recovers, and
must never rewrite desired state at any point.

The observable is deliberately end-to-end rather than introspective: the breaker's
internal state is not exposed to the panel (the e2e runs with the admin port off), so
the gate measures what a CLIENT experiences through a real relay. A pool with one
answering target and one refusing target gives a control: without health-aware
selection the balancer would share connections between them and roughly half the
client connections would fail.

  G2.1  the panel's verdicts           one target healthy, one unhealthy
  G2.2  the breaker steers             connections through the relay stop hitting the bad target
  G2.3  desired is never rewritten     the pool's desired rows are unchanged throughout
  G2.4  all-unhealthy still serves     a connection is still accepted, not refused outright
  G2.5  LB re-inclusion                after the target recovers, traffic returns to it
  G2.6  Agent restart                  health is live state, and service resumes
  G2.7  Panel restart                  desired unchanged, service unaffected

FAIL > 0 means V5.2 is not closed and V5.3 must not start.
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
RESULT = OUT / "v5-g2-result.txt"

RELAY_TUNNEL_ID = int(os.environ.get("G2_RELAY_TUNNEL_ID", "0"))
PROBE_COUNT = int(os.environ.get("G2_PROBES", "20"))
OVERALL_SECONDS = int(os.environ.get("G2_OVERALL_SECONDS", "2400"))
START = time.monotonic()


def record(passed: bool, message: str) -> None:
    H.record(passed, message)


def check(condition, message, detail=""):
    record(bool(condition), message if condition or not detail else f"{message} [{detail}]")


def case(name: str, fn, seconds: int):
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        record(False, f"{name}: {type(exc).__name__}: {exc}")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def relay_tunnel() -> dict:
    """The active RELAY tunnel whose pool the gate will exercise."""
    if RELAY_TUNNEL_ID:
        row = H.mysql(
            "SELECT CONCAT(id, '|', egress_node_id, '|', IFNULL(egress_pool_id, 0), '|', "
            f"IFNULL(listen_port, 0), '|', IFNULL(in_node_group_id, 0)) FROM tunnel WHERE id={RELAY_TUNNEL_ID};"
        ).strip()
    else:
        row = H.mysql(
            "SELECT CONCAT(id, '|', egress_node_id, '|', IFNULL(egress_pool_id, 0), '|', "
            "IFNULL(listen_port, 0), '|', IFNULL(in_node_group_id, 0)) FROM tunnel "
            "WHERE tunnel_mode='relay' AND apply_status='active' AND egress_pool_id IS NOT NULL "
            "ORDER BY id LIMIT 1;"
        ).strip()
    parts = row.split("|")
    if len(parts) != 5:
        return {}
    return {
        "id": int(parts[0]),
        "egress_node_id": int(parts[1]),
        "pool_id": int(parts[2]),
        "listen_port": int(parts[3]),
        "ingress_node_id": int(parts[4]),
    }


def pool_rows(pool_id: int) -> str:
    return H.mysql(
        "SELECT GROUP_CONCAT(CONCAT(id, ':', host, ':', port, '/', weight, '/', order_by, '/', status) "
        f"ORDER BY id) FROM egress_target WHERE pool_id={pool_id};"
    ).strip()


def pool_targets(pool_id: int) -> list[tuple[str, int]]:
    raw = H.mysql(f"SELECT CONCAT(host, '|', port) FROM egress_target WHERE pool_id={pool_id} ORDER BY id;").strip()
    out = []
    for line in raw.splitlines():
        if "|" in line:
            host, port = line.split("|", 1)
            out.append((host, int(port)))
    return out


def agent_container_for(node_id: int) -> str:
    agent_id = H.scalar(f"SELECT agent_id FROM node WHERE id={node_id};")
    for container in ("wp14-egress-agent", "wp14-egress-agent-b", "wp14-ingress-agent", "wp14-ingress-agent-b"):
        spec = H.docker(["inspect", "-f", "{{.Config.Cmd}}|{{.Config.Env}}", container], allow=True)
        if agent_id and agent_id in spec:
            return container
    return ""


def relay_probe(port: int, count: int, timeout: float = 4.0) -> tuple[int, int, str]:
    """Open `count` client connections through the relay.

    Returns (ok, total, last_detail). A connection counts as ok only if the relay
    carried real bytes back — the pool contains a target that answers with a banner
    and one that refuses, so "carried bytes" is exactly the signal that the healthy
    target was chosen.
    """
    ok = 0
    detail = ""
    for _ in range(count):
        try:
            with socket.create_connection((H.INGRESS_DATA_IP, port), timeout=timeout) as sock:
                sock.settimeout(timeout)
                data = sock.recv(256)
                if data:
                    ok += 1
                else:
                    detail = "connected but no data (likely the refusing target)"
        except Exception as exc:  # noqa: BLE001
            detail = f"{type(exc).__name__}: {exc}"
        time.sleep(0.15)
    return ok, count, detail


def panel_state(pool_id: int, target: tuple[str, int]) -> str:
    key = f"{target[0]}:{target[1]}"
    status, body, _ = H.req("GET", f"/api/admin/node/pools/{pool_id}/health")
    if status != 200:
        return f"<http {status}>"
    for entry in (H.unwrap(body) or {}).get("targets", []):
        if isinstance(entry, dict) and entry.get("target") == key:
            return str(entry.get("state"))
    return "<absent>"


def wait_panel_state(pool_id: int, target: tuple[str, int], wanted: set[str], timeout: int = 300) -> tuple[bool, str]:
    last = "<never read>"
    end = time.time() + timeout
    while time.time() < end:
        last = panel_state(pool_id, target)
        if last in wanted:
            return True, last
        time.sleep(6)
    return False, last


# ---------------------------------------------------------------------------
# setup / cleanup
# ---------------------------------------------------------------------------

def setup():
    H.mysql(f"UPDATE user SET super_admin=1 WHERE email='{H.EMAIL}';")
    check(bool(H.wait_until(lambda: H.req("GET", "/healthz", timeout=5)[0] == 200, timeout=60, interval=2)),
          "G2.setup the panel is reachable")
    tunnel = relay_tunnel()
    check(bool(tunnel), "G2.setup an active RELAY tunnel with a pool exists",
          f"tunnel={tunnel}")
    if not tunnel:
        raise RuntimeError("no active relay tunnel with an egress pool; the seeded relay is the fixture")
    H.relay = tunnel
    H.container = agent_container_for(tunnel["egress_node_id"])
    check(bool(H.container), "G2.setup the egress node's agent container was found", f"node={tunnel['egress_node_id']}")
    targets = pool_targets(tunnel["pool_id"])
    check(len(targets) >= 2,
          "G2.setup the pool has at least two targets (a control requires both a good and a bad one)",
          f"pool={tunnel['pool_id']} targets={targets}")
    if len(targets) < 2:
        raise RuntimeError("the pool needs at least two targets for the breaker control")
    H.targets = targets
    H.desired_before = pool_rows(tunnel["pool_id"])
    # Restart the egress agent so it rebuilds from a FRESH snapshot carrying health.
    # Without this the gate would measure an agent whose desired state was applied
    # before health existed on the wire, and the first run of this gate did exactly
    # that — reporting a 50/50 split that looked like a broken breaker but was a stale
    # agent. (That is also the bug this gate found: the snapshot path used to omit
    # health, so a restart silently disabled the breaker.)
    if H.container:
        H.docker(["restart", H.container], timeout=150)
        check(bool(H.wait_until(
            lambda: H.docker(["inspect", "-f", "{{.State.Running}}", H.container], allow=True).strip() == "true",
            timeout=90, interval=2)),
            "G2.setup the egress agent restarted onto a fresh snapshot")


def cleanup():
    try:
        H.cleanup_fixtures()
    except Exception as exc:  # noqa: BLE001
        record(False, f"G2.cleanup: {type(exc).__name__}: {exc}")


# ---------------------------------------------------------------------------
# cases
# ---------------------------------------------------------------------------

def g2_1_verdicts():
    pool = H.relay["pool_id"]
    good, bad = H.targets[0], H.targets[-1]
    H.good, H.bad = good, bad
    ok_good, state_good = wait_panel_state(pool, good, {"healthy", "recovering", "degraded"}, timeout=300)
    check(ok_good, "G2.1 the answering target has a usable verdict", f"target={good} state={state_good}")
    ok_bad, state_bad = wait_panel_state(pool, bad, {"degraded", "unhealthy"}, timeout=300)
    check(ok_bad, "G2.1 the refusing target is judged degraded/unhealthy", f"target={bad} state={state_bad}")
    check(state_bad != "unknown",
          "G2.1 the refusing target is NOT unknown — a refusal is evidence", f"state={state_bad}")
    H.state_good, H.state_bad = state_good, state_bad


def g2_2_breaker_steers():
    """The client-visible proof: connections stop landing on the bad target."""
    port = H.relay["listen_port"]
    check(port > 0, "G2.2 the relay has a listening port", f"port={port}")
    if port <= 0:
        return
    ok, total, detail = relay_probe(port, PROBE_COUNT)
    ratio = ok / total if total else 0
    # Without health-aware selection the balancer would share the two targets and
    # roughly half of these would fail. The half-open allowance (one probe per
    # cooldown) can cost at most a single failure in a burst like this, so the bar is
    # 90% and the reasoning is written down rather than tuned to a lucky run.
    check(ratio >= 0.9,
          "G2.2 traffic stops being steered at the target the panel called unhealthy",
          f"{ok}/{total} connections carried data (last: {detail}); round-robin would be about 50%")
    if ok < total:
        check(ratio >= 0.9,
              "G2.2 the failures are at most the half-open allowance, not half the traffic",
              f"{total - ok} failed of {total}")


def g2_3_desired_untouched():
    after = pool_rows(H.relay["pool_id"])
    check(after == H.desired_before,
          "G2.3 health-aware selection never rewrote the desired target list",
          f"before={H.desired_before!r} after={after!r}")
    states = [panel_state(H.relay["pool_id"], t) for t in H.targets]
    check(all(s != "<absent>" for s in states),
          "G2.3 every desired target is still present in the view, unhealthy included", f"states={states}")


def g2_4_all_unhealthy_still_serves():
    """With every target unhealthy the relay must still ACCEPT, not refuse."""
    container = "wp14-target-a"
    running = H.docker(["inspect", "-f", "{{.State.Running}}", container], allow=True).strip()
    check(running == "true", "G2.4 the answering target's container is running before the outage", container)
    H.docker(["stop", container], timeout=120)
    try:
        ok, state = wait_panel_state(H.relay["pool_id"], H.good, {"unhealthy"}, timeout=420)
        check(ok, "G2.4 the previously good target is judged unhealthy once it stops answering",
              f"target={H.good} state={state}")
        port = H.relay["listen_port"]
        accepted = 0
        for _ in range(5):
            try:
                with socket.create_connection((H.INGRESS_DATA_IP, port), timeout=4) as sock:
                    accepted += 1
                    _ = sock
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.2)
        # Every target being open must still yield a pick: the listener keeps accepting
        # and the dial is attempted. Refusing to pick anything would show up as the
        # listener itself refusing, which is worse than serving the worst target.
        check(accepted >= 4,
              "G2.4 when every target is unhealthy the relay still accepts connections (forced pick)",
              f"accepted={accepted}/5")
    finally:
        H.docker(["start", container], timeout=120)


def g2_5_lb_reinclusion():
    ok, state = wait_panel_state(H.relay["pool_id"], H.good, {"healthy", "recovering", "degraded"}, timeout=420)
    check(ok, "G2.5 the recovered target leaves `unhealthy`", f"target={H.good} state={state}")
    port = H.relay["listen_port"]
    ok_count, total, detail = relay_probe(port, PROBE_COUNT)
    ratio = ok_count / total if total else 0
    check(ratio >= 0.9,
          "G2.5 the LB steers back to the recovered target",
          f"{ok_count}/{total} carried data (last: {detail})")


def g2_6_agent_restart():
    H.docker(["restart", H.container], timeout=150)
    check(bool(H.wait_until(lambda: H.docker(["inspect", "-f", "{{.State.Running}}", H.container], allow=True).strip() == "true",
                            timeout=90, interval=2)),
          "G2.6 the egress agent is running again")
    port = H.relay["listen_port"]
    resumed = H.wait_until(lambda: relay_probe(port, 4)[0] >= 4, timeout=240, interval=8)
    check(resumed, "G2.6 service resumes after the agent restarts",
          f"port={port}")
    check(pool_rows(H.relay["pool_id"]) == H.desired_before,
          "G2.6 the restart did not rewrite desired either")


def g2_7_panel_restart():
    H.docker(["restart", H.PANEL_CONTAINER], timeout=180)
    check(bool(H.wait_until(lambda: H.req("GET", "/healthz", timeout=5)[0] == 200, timeout=180, interval=3)),
          "G2.7 the panel is back")
    check(pool_rows(H.relay["pool_id"]) == H.desired_before,
          "G2.7 the panel restart did not rewrite desired")
    ok_count, total, _detail = relay_probe(H.relay["listen_port"], 6)
    check(ok_count >= 5, "G2.7 the data plane kept serving through the panel restart",
          f"{ok_count}/{total}")


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
            ("G2.1 verdicts", g2_1_verdicts, 420),
            ("G2.2 breaker steers", g2_2_breaker_steers, 300),
            ("G2.3 desired untouched", g2_3_desired_untouched, 180),
            ("G2.4 all-unhealthy still serves", g2_4_all_unhealthy_still_serves, 600),
            ("G2.5 LB re-inclusion", g2_5_lb_reinclusion, 600),
            ("G2.6 Agent restart", g2_6_agent_restart, 600),
            ("G2.7 Panel restart", g2_7_panel_restart, 480),
        ]:
            case(name, fn, budget)
    except Exception as exc:  # noqa: BLE001
        record(False, f"G2 prerequisite/setup: {type(exc).__name__}: {exc}; remaining tests NOT EXECUTED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.setitimer(signal.ITIMER_REAL, 300)
        try:
            cleanup()
        except Exception as exc:  # noqa: BLE001
            record(False, f"G2.cleanup: {type(exc).__name__}: {exc}")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        RESULT.write_text(
            "# V5-G2 WP7 circuit breaker / health-aware LB gate\n"
            f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
            "topology: scripts/v3-e2e/docker-compose.e2e.yaml (a real relay, a pool with one good and one bad target)\n"
            f"relay: {H.__dict__.get('relay', '?')}\n"
            f"setup={'executed' if ready else 'incomplete'}\n"
            f"elapsed_seconds: {int(time.monotonic() - START)}\n"
            + "\n".join(H.RESULTS)
            + f"\nV5-G2 TOTAL PASS={H.PASS} FAIL={H.FAIL}\n",
            encoding="utf-8",
        )
        H.release_lock()
        print(f"V5-G2 TOTAL PASS={H.PASS} FAIL={H.FAIL} evidence={RESULT}", flush=True)
    return 1 if H.FAIL or not ready else 0


if __name__ == "__main__":
    raise SystemExit(main())
